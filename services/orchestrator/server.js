'use strict';

const express    = require('express');
const { v4: uuidv4 } = require('uuid');
const { initDb } = require('./db');
const { fullSync } = require('./lib/compat');
const locks      = require('./lib/locks');
const { acquireSingleton, releaseSingleton } = locks;
const workerLoop = require('./lib/worker-loop');
const tracker    = require('./lib/run-tracker');
const executor   = require('./lib/engine-executor');
const lifecycle  = require('./lib/lifecycle');
const notifier    = require('./lib/notifier');
const webhook     = require('./lib/webhook');
const gitHelpers  = require('./lib/git-helpers');

const app      = express();
const PORT     = process.env.PORT || 8092;
const WORKER_ID = process.env.WORKER_ID || `orch-${uuidv4().slice(0, 8)}`;
const DRY_RUN  = process.env.DRY_RUN === 'true';

initDb();

// Initial bidirectional sync at startup
try {
  fullSync();
} catch (e) {
  console.error('[orchestrator] startup fullSync failed:', e.message);
}

// Singleton guard — abort if another worker instance is running
if (!acquireSingleton()) {
  console.error('[orchestrator] another worker is running — exiting');
  process.exit(1);
}

app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({
    status:   'ok',
    service:  'orchestrator',
    workerId: WORKER_ID,
    running:  workerLoop.isRunning(),
    uptime:   process.uptime(),
    ts:       new Date().toISOString(),
  });
});

// Routes v1
app.use('/api/v1/projects', require('./routes/projects')());
app.use('/api/v1/tasks',    require('./routes/tasks')());
app.use('/api/v1/sync',     require('./routes/sync')());

// Control API — legacy compat routes (/status, /stop, /question, /answer, /output)
app.use('/', require('./routes/worker')());

// Graceful shutdown
function shutdown(signal) {
  console.log(`[orchestrator] ${signal} — shutting down`);
  lifecycle.stopAllActiveRuns(tracker, locks, `signal:${signal}`);
  workerLoop.stop(`signal:${signal}`);
  releaseSingleton();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

app.listen(PORT, () => {
  if (DRY_RUN) {
    console.log(`[orchestrator] *** DRY_RUN mode — shadow observation only, no tasks will be executed ***`);
  }
  console.log(`Orchestrator running on port ${PORT} (workerId=${WORKER_ID}, dry_run=${DRY_RUN})`);

  workerLoop.start({
    workerId: WORKER_ID,
    onTask: async (task, run) => {
      // Shadow mode: log what would be executed without actually running
      if (DRY_RUN) {
        console.log(`[orchestrator/dry-run] would execute task ${task.id} title="${task.name || ''}" engine=${task.engine || 'n/a'} priority=${task.priority || 'n/a'} project=${task.project_id || 'n/a'}`);
        tracker.detachRun(run.id);
        locks.release(locks.taskKey(task.id), run.id);
        if (task.project_id) locks.release(locks.projectKey(task.project_id), run.id);
        return;
      }
      // Check optimization loop limit before executing
      if (lifecycle.checkOptimizationLoop(task, run.id)) {
        // DB already finalised by lifecycle — just clean up in-memory registry + locks
        tracker.detachRun(run.id);
        locks.release(locks.taskKey(task.id), run.id);
        if (task.project_id) locks.release(locks.projectKey(task.project_id), run.id);
        return;
      }

      // Snapshot HEAD before execution for commit tracking
      const projectPath = gitHelpers.resolveProjectPath(task.project_id);
      const headBefore  = await gitHelpers.getGitHeadInfo(projectPath);

      // Execute via resolved engine (claude / codex / ollama) with rate_limit fallback
      const result = await executor.execute({ task, run });

      // Post-execution: git tracking + quality gates (parallel)
      const [headAfter, qgResult] = await Promise.all([
        gitHelpers.getGitHeadInfo(projectPath),
        gitHelpers.runQualityGates(projectPath),
      ]);

      // Commit SHA: prefer actual git diff, fall back to output text parsing
      const gitNewSha  = headAfter.sha && headBefore.sha !== headAfter.sha ? headAfter.sha : null;
      const commitSha  = gitNewSha || gitHelpers.extractCommitHash(result.output);

      // Transition task to review (queued→in_progress→review)
      tracker.reviewRun(run.id, result.output);

      // Build summary note and append quality gate result
      let summaryNote = executor.buildTaskSummaryNote({
        task,
        rawOutput: result.output,
        engine:    result.engine,
        model:     result.model,
      });

      const qgSummary = gitHelpers.summarizeQualityGates(qgResult);
      if (qgSummary) {
        summaryNote = (summaryNote + '\n' + qgSummary).slice(0, 1000);
      }

      lifecycle.notify({
        type:   'task_done',
        title:  `✅ Tâche en review`,
        body:   summaryNote || `${task.name || task.id} — engine=${result.engine}`,
        taskId: task.id,
        runId:  run.id,
      });

      // Dashboard-compat notification (legacy format)
      notifier.addNotification({
        projectName: task.project_id || '',
        taskTitle:   task.name       || task.id,
        taskId:      task.id,
        fromStatus:  'in_progress',
        toStatus:    'review',
        message:     `🔍 Traitement terminé — en attente de review`,
      });

      // Activity log entry
      notifier.logActivity({
        event:     'task_review',
        taskId:    task.id,
        projectId: task.project_id || null,
        engine:    result.engine,
        model:     result.model    || null,
        commitSha: commitSha       || null,
        summary:   summaryNote     || null,
        toStatus:  'review',
      });

      // Webhook POST (fire-and-forget, 30s timeout)
      webhook.sendWebhook({
        event:        'task_review',
        projectId:    task.project_id || null,
        taskId:       task.id,
        coderEngine:  result.engine,
        coderModel:   result.model    || null,
        coderSummary: summaryNote     || null,
        commitSha:    commitSha       || null,
      }).catch(() => {});   // already swallowed inside sendWebhook; belt-and-suspenders

      // Release advisory locks (error path is handled by worker-loop catch)
      locks.release(locks.taskKey(task.id), run.id);
      if (task.project_id) locks.release(locks.projectKey(task.project_id), run.id);
    },
  });
});

module.exports = app;
