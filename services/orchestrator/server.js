'use strict';

const express    = require('express');
const { v4: uuidv4 } = require('uuid');
const { initDb } = require('./db');
const { fullSync } = require('./lib/compat');
const { acquireSingleton, releaseSingleton } = require('./lib/locks');
const workerLoop = require('./lib/worker-loop');

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

  // Start worker loop — onTask is a stub until ORCH-009 (engine executor)
  workerLoop.start({
    workerId: WORKER_ID,
    onTask: async (task, run) => {
      // Placeholder: engine execution implemented in ORCH-009
      console.log(`[orchestrator] onTask stub — task=${task.id} run=${run.id} (engine=${task.engine || 'n/a'})`);
    },
  });
});

module.exports = app;
