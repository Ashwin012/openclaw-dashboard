'use strict';

/**
 * run-tracker.js — In-memory active run registry with SQLite persistence
 *
 * One run per project at a time. Supports lifecycle transitions:
 *   startRun → updateRun → finishRun | failRun | cancelRun
 *
 * hydrate() reloads zombie runs from DB on startup.
 * cancelAll() is used during graceful shutdown.
 */

const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db');

/** @type {Map<string, RunState>} */
const activeRuns = new Map();

// ─── Lifecycle ────────────────────────────────────────────────────────────────

/**
 * Register and start a new run. Inserts a row in `runs`, sets task status to
 * 'running', and adds the run to the in-memory registry.
 *
 * @param {object} opts
 * @param {string} [opts.runId]     — explicit ID (generated if omitted)
 * @param {string}  opts.taskId
 * @param {string}  opts.projectId
 * @param {string}  [opts.engine]   — claude | codex | ollama
 * @param {string}  [opts.model]
 * @param {string}  [opts.workerId]
 * @param {number}  [opts.attempt]  — defaults to 1
 * @returns {RunState}
 */
function startRun({ runId, taskId, projectId, engine, model, workerId, attempt = 1 }) {
  const id  = runId || uuidv4();
  const now = Date.now();
  const db  = getDb();

  db.prepare(`
    INSERT INTO runs
      (id, task_id, status, started_at, attempt, engine, model, worker_id, progress, created_at)
    VALUES (?, ?, 'running', ?, ?, ?, ?, ?, 0, ?)
  `).run(id, taskId, now, attempt, engine || null, model || null, workerId || null, now);

  db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?')
    .run('running', now, taskId);

  /** @type {RunState} */
  const state = { id, taskId, projectId, engine, model, workerId, attempt, startedAt: now, status: 'running', progress: 0 };
  activeRuns.set(id, state);

  console.log(`[run-tracker] started run ${id} (task=${taskId}, engine=${engine || 'n/a'})`);
  return state;
}

/**
 * Update progress (0-100) and/or append a log chunk to an active run.
 * @returns {boolean} false if run not found in registry
 */
function updateRun(runId, { progress, logsChunk } = {}) {
  const state = activeRuns.get(runId);
  if (!state) return false;

  const db      = getDb();
  const sets    = [];
  const params  = [];

  if (progress !== undefined) {
    state.progress = Math.min(100, Math.max(0, progress));
    sets.push('progress = ?');
    params.push(state.progress);
  }

  if (logsChunk) {
    sets.push("logs = COALESCE(logs, '') || ?");
    params.push(logsChunk);
  }

  if (sets.length > 0) {
    params.push(runId);
    db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  return true;
}

function _terminate(runId, dbStatus, taskStatus, outputOrError, isError) {
  const state = activeRuns.get(runId);
  if (!state) return false;

  const now = Date.now();
  const db  = getDb();
  const col = isError ? 'error' : 'output';

  db.prepare(`UPDATE runs SET status = ?, finished_at = ?, progress = 100, ${col} = ? WHERE id = ?`)
    .run(dbStatus, now, outputOrError || '', runId);

  db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?')
    .run(taskStatus, now, state.taskId);

  state.status   = dbStatus;
  state.progress = 100;
  activeRuns.delete(runId);

  console.log(`[run-tracker] ${dbStatus} run ${runId} (task=${state.taskId})`);
  return true;
}

/**
 * Mark run as done. Task status → 'done'.
 * @param {string} runId
 * @param {string} [output]
 */
function finishRun(runId, output = '') {
  return _terminate(runId, 'done', 'done', output, false);
}

/**
 * Mark run as failed. Task status → 'failed'.
 * @param {string} runId
 * @param {string} [error]
 */
function failRun(runId, error = '') {
  return _terminate(runId, 'failed', 'failed', error, true);
}

/**
 * Cancel a run (e.g. on shutdown or operator request). Task status → 'pending'.
 * @param {string} runId
 * @param {string} [reason]
 */
function cancelRun(runId, reason = 'cancelled') {
  const state = activeRuns.get(runId);
  if (!state) return false;

  const now = Date.now();
  const db  = getDb();

  db.prepare("UPDATE runs SET status = 'cancelled', finished_at = ?, error = ? WHERE id = ?")
    .run(now, reason, runId);

  // Re-queue the task so the next worker loop picks it up
  db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?')
    .run('pending', now, state.taskId);

  state.status = 'cancelled';
  activeRuns.delete(runId);

  console.log(`[run-tracker] cancelled run ${runId} (task=${state.taskId}): ${reason}`);
  return true;
}

/**
 * Cancel all active runs. Used during graceful shutdown.
 * @returns {number} count of cancelled runs
 */
function cancelAll(reason = 'worker shutdown') {
  const ids = Array.from(activeRuns.keys());
  for (const id of ids) cancelRun(id, reason);
  return ids.length;
}

// ─── Queries ─────────────────────────────────────────────────────────────────

/** Return all active runs as a serializable array. */
function getActiveRuns() {
  return Array.from(activeRuns.values());
}

/** Return the run state for a given ID, or null. */
function getRunById(runId) {
  return activeRuns.get(runId) || null;
}

/** True if the project already has an active (running) run. */
function isProjectBusy(projectId) {
  for (const run of activeRuns.values()) {
    if (run.projectId === projectId) return true;
  }
  return false;
}

/** Return the active run for a project, or null. */
function getProjectRun(projectId) {
  for (const run of activeRuns.values()) {
    if (run.projectId === projectId) return run;
  }
  return null;
}

// ─── Startup hydration ────────────────────────────────────────────────────────

/**
 * Reload 'running' rows from DB into memory on startup (zombie detection).
 * The worker loop should decide whether to reclaim or cancel these runs.
 *
 * @param {string} [workerId] — if provided, only loads runs for this worker
 * @returns {RunState[]} list of zombie run states now in memory
 */
function hydrate(workerId) {
  const db = getDb();

  const sql = workerId
    ? 'SELECT r.*, t.project_id FROM runs r LEFT JOIN tasks t ON t.id = r.task_id WHERE r.status = ? AND r.worker_id = ?'
    : 'SELECT r.*, t.project_id FROM runs r LEFT JOIN tasks t ON t.id = r.task_id WHERE r.status = ?';

  const rows = workerId
    ? db.prepare(sql).all('running', workerId)
    : db.prepare(sql).all('running');

  const zombies = [];
  for (const row of rows) {
    const state = {
      id:        row.id,
      taskId:    row.task_id,
      projectId: row.project_id,
      engine:    row.engine,
      model:     row.model,
      workerId:  row.worker_id,
      attempt:   row.attempt,
      startedAt: row.started_at,
      status:    'running',
      progress:  row.progress || 0,
    };
    activeRuns.set(row.id, state);
    zombies.push(state);
  }

  if (zombies.length > 0) {
    console.warn(`[run-tracker] hydrated ${zombies.length} zombie run(s)`);
  }

  return zombies;
}

module.exports = {
  startRun,
  updateRun,
  finishRun,
  failRun,
  cancelRun,
  cancelAll,
  getActiveRuns,
  getRunById,
  isProjectBusy,
  getProjectRun,
  hydrate,
};
