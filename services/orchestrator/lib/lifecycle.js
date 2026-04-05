'use strict';

/**
 * lifecycle.js — Status machine transitions, zombie recovery, graceful shutdown
 *
 * Status machine: queued → in_progress (worker pick) → review (done/timeout/stop)
 * Hard timeout: 3h → SIGTERM child process → task to review
 * Zombie recovery: running → queued (re-queue), validating → review
 * Duration warnings: 30/60/120min → notification
 * Graceful shutdown: stopAllActiveRuns → release locks → exit
 * Optimization loop: loopCount >= maxLoops → review + humanValidation
 */

const fs   = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db');

// ── Dashboard notifications.json compat ────────────────────────────────────────

const DASHBOARD_NOTIFICATIONS_PATH = process.env.DASHBOARD_NOTIFICATIONS_PATH
  || path.join(__dirname, '..', '..', '..', '.dashboard', 'notifications.json');

/**
 * Append a notification to .dashboard/notifications.json (fan-out to dashboard UI).
 * Also inserts into the SQLite notifications table.
 * Never throws — errors are logged and swallowed.
 */
function notify({ type, title, body = '', taskId = null, runId = null }) {
  const id  = uuidv4();
  const ts  = Date.now();

  // ── SQLite notification ──────────────────────────────────────────────────────
  try {
    getDb().prepare(`
      INSERT INTO notifications (id, type, title, body, task_id, run_id, read, ts)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?)
    `).run(id, type, title, body, taskId, runId, ts);
  } catch (e) {
    console.warn('[lifecycle] sqlite notify failed:', e.message);
  }

  // ── .dashboard/notifications.json fan-out ────────────────────────────────────
  try {
    const dir = path.dirname(DASHBOARD_NOTIFICATIONS_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    let data = { pending: [] };
    if (fs.existsSync(DASHBOARD_NOTIFICATIONS_PATH)) {
      try { data = JSON.parse(fs.readFileSync(DASHBOARD_NOTIFICATIONS_PATH, 'utf8')); } catch {}
    }
    if (!Array.isArray(data.pending)) data.pending = [];

    data.pending.push({ id, type, title, body, taskId, runId, ts, read: false });

    const tmp = `${DASHBOARD_NOTIFICATIONS_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, DASHBOARD_NOTIFICATIONS_PATH);
  } catch (e) {
    console.warn('[lifecycle] dashboard notify failed:', e.message);
  }
}

// ── Child process registry ─────────────────────────────────────────────────────

/** @type {Map<string, import('child_process').ChildProcess>} */
const _childRefs = new Map();

/** Register a spawned child process for a run (used by engine-executor). */
function registerProcess(runId, child) {
  _childRefs.set(runId, child);
}

/** Remove child reference once a run exits cleanly. */
function unregisterProcess(runId) {
  _childRefs.delete(runId);
}

/**
 * Send a signal to the child process for a run.
 * @param {string} runId
 * @param {string} [signal='SIGTERM']
 * @returns {boolean} true if signal was sent
 */
function killProcess(runId, signal = 'SIGTERM') {
  const child = _childRefs.get(runId);
  if (!child || child.exitCode !== null || child.killed) return false;
  try {
    child.kill(signal);
    console.log(`[lifecycle] sent ${signal} to child of run ${runId} (pid=${child.pid})`);
    return true;
  } catch (e) {
    console.warn(`[lifecycle] kill failed for run ${runId}:`, e.message);
    return false;
  }
}

// ── Task input JSON helpers ───────────────────────────────────────────────────

/**
 * Read the `input` JSON field for a task, parse it, update fields, then write back.
 * @param {object} db
 * @param {string} taskId
 * @param {object} patch    — fields to merge into the input JSON object
 * @param {number} [updatedAt]
 */
function patchTaskInput(db, taskId, patch, updatedAt = Date.now()) {
  const row = db.prepare('SELECT input, updated_at FROM tasks WHERE id = ?').get(taskId);
  if (!row) return;

  let extra = {};
  try { extra = JSON.parse(row.input || '{}'); } catch {}

  Object.assign(extra, patch);

  db.prepare('UPDATE tasks SET input = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(extra), updatedAt, taskId);
}

// ── Status transitions ────────────────────────────────────────────────────────

/**
 * Transition a task to 'review' status after engine completion.
 * DB status stays 'done'; originalStatus in input JSON → 'review'.
 * Fires a notification.
 *
 * @param {string} runId
 * @param {string} output
 * @param {object} [opts]
 * @param {string} [opts.reason]              — e.g. 'completed', 'timeout:3h', 'manual_stop'
 * @param {boolean} [opts.stoppedManually]    — set stoppedManually=true in input JSON
 * @param {boolean} [opts.setHumanValidation] — force humanValidation=true in input JSON
 * @param {string} [opts.taskId]              — override (if run not in tracker)
 */
function transitionToReview(runId, output, {
  reason            = 'completed',
  stoppedManually   = false,
  setHumanValidation = false,
  taskId            = null,
} = {}) {
  const db  = getDb();
  const now = Date.now();

  // Resolve taskId from run if not provided
  if (!taskId) {
    const run = db.prepare('SELECT task_id FROM runs WHERE id = ?').get(runId);
    if (!run) {
      console.warn(`[lifecycle] transitionToReview: run ${runId} not found`);
      return false;
    }
    taskId = run.task_id;
  }

  // Finalise the run in DB
  db.prepare(`
    UPDATE runs SET status = 'done', finished_at = ?, progress = 100, output = ?
    WHERE id = ?
  `).run(now, output || '', runId);

  // Update task: DB status = 'done', originalStatus in input JSON = 'review'
  const inputPatch = { originalStatus: 'review' };
  if (stoppedManually)   inputPatch.stoppedManually   = true;
  if (setHumanValidation) inputPatch.humanValidation  = true;

  db.prepare("UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?")
    .run(now, taskId);
  patchTaskInput(db, taskId, inputPatch, now);

  notify({
    type:   'task_done',
    title:  `Tâche prête pour review`,
    body:   `Run ${runId} — ${reason}`,
    taskId,
    runId,
  });

  console.log(`[lifecycle] task ${taskId} → review (run=${runId}, reason=${reason})`);
  return true;
}

// ── Duration warnings ─────────────────────────────────────────────────────────

/**
 * Emit a duration warning for a run.
 * @param {object} run      — RunState { id, taskId, startedAt }
 * @param {number} thresholdMin
 */
function handleDurationWarning(run, thresholdMin) {
  const msg = `Run ${run.id} en cours depuis ${thresholdMin}min (task=${run.taskId})`;
  console.warn(`[lifecycle] ${msg}`);

  notify({
    type:   'system',
    title:  `⏱ Run long (${thresholdMin}min)`,
    body:   msg,
    taskId: run.taskId,
    runId:  run.id,
  });
}

// ── Hard timeout ──────────────────────────────────────────────────────────────

/**
 * Handle a 3h hard timeout: SIGTERM child, transition task to review.
 * The caller (worker-loop) is responsible for removing the run from active registry
 * and releasing locks.
 *
 * @param {object} run — RunState
 */
function handleHardTimeout(run) {
  console.warn(`[lifecycle] hard timeout 3h for run ${run.id} (task=${run.taskId}) — SIGTERM`);

  killProcess(run.id, 'SIGTERM');
  unregisterProcess(run.id);

  transitionToReview(run.id, '', {
    reason:          'timeout:3h',
    stoppedManually: true,
    taskId:          run.taskId,
  });

  notify({
    type:   'run_failed',
    title:  '⏰ Timeout 3h — tâche envoyée en review',
    body:   `Run ${run.id} interrompu après 3h (task=${run.taskId})`,
    taskId: run.taskId,
    runId:  run.id,
  });
}

// ── Optimization loop guard ───────────────────────────────────────────────────

/**
 * Check if a task has exceeded its optimization loop limit.
 * If so, transition to review with humanValidation=true.
 *
 * @param {object} task  — DB task row (with input JSON)
 * @param {string} runId
 * @returns {boolean} true if loop limit exceeded (task sent to review)
 */
function checkOptimizationLoop(task, runId) {
  let extra = {};
  try { extra = JSON.parse(task.input || '{}'); } catch {}

  if (!extra.optimizationLoop) return false;

  const maxLoops  = extra.optimizationMaxLoops  || 2;
  const loopCount = (extra.optimizationLoopCount || 0) + 1;

  // Always increment
  const db  = getDb();
  const now = Date.now();
  patchTaskInput(db, task.id, { optimizationLoopCount: loopCount }, now);

  if (loopCount >= maxLoops) {
    console.warn(`[lifecycle] task ${task.id} reached maxLoops (${loopCount}/${maxLoops}) → review + humanValidation`);

    transitionToReview(runId, '', {
      reason:             `optimization_loop:${loopCount}/${maxLoops}`,
      setHumanValidation: true,
      taskId:             task.id,
    });

    notify({
      type:   'system',
      title:  '🔁 Optimization loop max atteint',
      body:   `Task ${task.id}: ${loopCount}/${maxLoops} loops — validation humaine requise`,
      taskId: task.id,
      runId,
    });

    return true;
  }

  return false;
}

// ── Zombie recovery ───────────────────────────────────────────────────────────

/**
 * Recover zombie runs at startup.
 *
 * Strategy:
 * - Runs with status 'running' in DB → in_progress in JSON:
 *   - Age ≥ 3h → move task to 'review' (stoppedManually) + cancel run
 *   - Age < 3h → re-queue task (pending) + cancel run
 * - Tasks with originalStatus 'validating' → move to 'review'
 *
 * @returns {{ requeued: number, reviewed: number, total: number }}
 */
function recoverZombies() {
  const db  = getDb();
  const now = Date.now();
  const MAX_RUN_MS = 3 * 60 * 60 * 1000;

  // Runs still in 'running' state (zombies from previous worker crash)
  const zombieRuns = db.prepare(`
    SELECT r.id, r.task_id, r.started_at, t.input
    FROM   runs r
    JOIN   tasks t ON t.id = r.task_id
    WHERE  r.status = 'running'
  `).all();

  let requeued = 0;
  let reviewed = 0;

  for (const row of zombieRuns) {
    const age = now - (row.started_at || 0);

    if (age >= MAX_RUN_MS) {
      // Too old → review
      db.prepare("UPDATE runs SET status = 'cancelled', finished_at = ?, error = ? WHERE id = ?")
        .run(now, 'zombie:expired', row.id);

      db.prepare("UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?")
        .run(now, row.task_id);
      patchTaskInput(db, row.task_id, {
        originalStatus: 'review',
        stoppedManually: true,
      }, now);

      console.warn(`[lifecycle] zombie run ${row.id} (age=${Math.round(age/3600000)}h) → task ${row.task_id} to review`);
      reviewed++;
    } else {
      // Young enough → re-queue
      db.prepare("UPDATE runs SET status = 'cancelled', finished_at = ?, error = ? WHERE id = ?")
        .run(now, 'zombie:requeued', row.id);

      db.prepare("UPDATE tasks SET status = 'pending', updated_at = ? WHERE id = ?")
        .run(now, row.task_id);
      patchTaskInput(db, row.task_id, { originalStatus: 'queued' }, now);

      const mins = Math.round(age / 60_000);
      console.log(`[lifecycle] zombie run ${row.id} (age=${mins}min) → task ${row.task_id} re-queued`);
      requeued++;
    }
  }

  // Tasks with originalStatus 'validating' → review
  const validatingRows = db.prepare(`
    SELECT id, input FROM tasks WHERE status IN ('pending','running')
  `).all();

  for (const row of validatingRows) {
    let extra = {};
    try { extra = JSON.parse(row.input || '{}'); } catch {}
    if (extra.originalStatus === 'validating') {
      db.prepare("UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?")
        .run(now, row.id);
      patchTaskInput(db, row.id, { originalStatus: 'review' }, now);
      console.log(`[lifecycle] validating task ${row.id} → review (zombie recovery)`);
      reviewed++;
    }
  }

  if (zombieRuns.length > 0 || reviewed > 0) {
    console.log(`[lifecycle] zombie recovery: ${zombieRuns.length} zombie runs — ${requeued} re-queued, ${reviewed} → review`);
  }

  return { requeued, reviewed, total: zombieRuns.length };
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

/**
 * Stop all active runs gracefully:
 * 1. SIGTERM all known child processes
 * 2. Cancel all in-memory runs via tracker
 *
 * @param {object} tracker — run-tracker module
 * @param {object} locks   — locks module
 * @param {string} [reason]
 * @returns {number} number of runs stopped
 */
function stopAllActiveRuns(tracker, locks, reason = 'worker_shutdown') {
  const runs = tracker.getActiveRuns();

  for (const run of runs) {
    killProcess(run.id, 'SIGTERM');
    unregisterProcess(run.id);
    locks.release(locks.taskKey(run.taskId), run.id);
    if (run.projectId) locks.release(locks.projectKey(run.projectId), run.id);
  }

  const cancelled = tracker.cancelAll(reason);
  _childRefs.clear();

  console.log(`[lifecycle] stopAllActiveRuns: ${cancelled} run(s) stopped (reason=${reason})`);
  return cancelled;
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  notify,
  registerProcess,
  unregisterProcess,
  killProcess,
  transitionToReview,
  handleDurationWarning,
  handleHardTimeout,
  checkOptimizationLoop,
  recoverZombies,
  stopAllActiveRuns,
};
