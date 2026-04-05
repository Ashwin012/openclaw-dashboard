'use strict';

const express    = require('express');
const { v4: uuidv4 } = require('uuid');
const { initDb } = require('./db');
const { fullSync } = require('./lib/compat');
const { acquireSingleton, releaseSingleton, release, taskKey, projectKey } = require('./lib/locks');
const workerLoop = require('./lib/worker-loop');
const tracker    = require('./lib/run-tracker');
const executor   = require('./lib/engine-executor');

const app    = express();
const PORT   = process.env.PORT || 8092;
const WORKER_ID = process.env.WORKER_ID || `orch-${uuidv4().slice(0, 8)}`;

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
    ts:       new Date().toISOString(),
  });
});

// Routes v1
app.use('/api/v1/projects', require('./routes/projects')());
app.use('/api/v1/tasks',    require('./routes/tasks')());
app.use('/api/v1/sync',     require('./routes/sync')());

// Graceful shutdown
function shutdown(signal) {
  console.log(`[orchestrator] ${signal} — shutting down`);
  workerLoop.stop(`signal:${signal}`);
  releaseSingleton();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

app.listen(PORT, () => {
  console.log(`Orchestrator running on port ${PORT} (workerId=${WORKER_ID})`);

  workerLoop.start({
    workerId: WORKER_ID,
    onTask: async (task, run) => {
      // Execute via resolved engine (claude / codex / ollama) with rate_limit fallback
      const result = await executor.execute({ task, run });
      tracker.finishRun(run.id, result.output);
      // Release advisory locks (error path is handled by worker-loop catch)
      release(taskKey(task.id), run.id);
      if (task.project_id) release(projectKey(task.project_id), run.id);
    },
  });
});

module.exports = app;
