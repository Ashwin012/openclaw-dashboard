'use strict';

/**
 * worker-loop.js — Polling loop, task selection, timeout monitoring, zombie recovery
 *
 * - Polls DB every 30s for pending tasks
 * - Selects tasks by priority (critical > high > normal > low), concurrency 1/project
 * - Monitors active runs: warn at 30/60/120 min, hard-cancel at 3h
 * - Recovers zombie runs on startup (hydrate + cancel stale)
 * - Guard: skips tick if previous poll iteration is still running
 */

const { v4: uuidv4 }  = require('uuid');
const { getDb }       = require('../db');
const locks           = require('./locks');
const tracker         = require('./run-tracker');
const lifecycle       = require('./lifecycle');

const POLL_INTERVAL_MS = parseInt(process.env.WORKER_POLL_INTERVAL_MS, 10) || 30_000;
const MAX_RUN_MS       = 3 * 60 * 60 * 1000;             // 3h hard timeout
const WARNING_MS       = [30, 60, 120].map(m => m * 60_000);
const LOCK_TTL_MS      = MAX_RUN_MS + 60_000;             // lock outlives the run

// ── State ─────────────────────────────────────────────────────────────────────

let _workerId     = null;
let _timer        = null;
let _polling      = false;   // guard: prevents overlapping tick iterations
let _shuttingDown = false;

/** Per-run warning bookkeeping. Map<runId, Set<thresholdMs>> */
const _warnedMs = new Map();

// ── Task Selection ─────────────────────────────────────────────────────────────

/**
 * Query DB for pending tasks ordered by priority then age.
 * Filters out tasks belonging to projects that already have an active run.
 * Returns at most one task per project per tick.
 *
 * @returns {object[]} task rows
 */
function selectPendingTasks() {
  const rows = getDb().prepare(`
    SELECT t.*
    FROM   tasks t
    WHERE  t.status = 'pending'
    ORDER  BY
      CASE t.priority
        WHEN 'critical' THEN 0
        WHEN 'high'     THEN 1
        WHEN 'normal'   THEN 2
        WHEN 'low'      THEN 3
        ELSE                 4
      END,
      t.created_at ASC
  `).all();

  const selected   = [];
  const seenProj   = new Set();   // project IDs already taken in this batch

  for (const row of rows) {
    const proj = row.project_id;

    // One run per project: skip if project already busy (in-memory) or already
    // picked in this batch
    if (proj && (tracker.isProjectBusy(proj) || seenProj.has(proj))) continue;

    selected.push(row);
    if (proj) seenProj.add(proj);
  }

  return selected;
}

// ── Timeout / Warning Monitor ─────────────────────────────────────────────────

function monitorActiveRuns() {
  const now  = Date.now();

  for (const run of tracker.getActiveRuns()) {
    const age = now - run.startedAt;

    // Hard timeout — SIGTERM child, transition task to review
    if (age >= MAX_RUN_MS) {
      lifecycle.handleHardTimeout(run);
      locks.release(locks.taskKey(run.taskId), run.id);
      if (run.projectId) locks.release(locks.projectKey(run.projectId), run.id);
      // DB already finalised by lifecycle — only remove from in-memory registry
      tracker.detachRun(run.id);
      _warnedMs.delete(run.id);
      continue;
    }

    // Progressive warnings at 30/60/120 min (with notifications)
    const warned = _warnedMs.get(run.id) || new Set();
    for (const threshold of WARNING_MS) {
      if (age >= threshold && !warned.has(threshold)) {
        warned.add(threshold);
        lifecycle.handleDurationWarning(run, threshold / 60_000);
      }
    }
    _warnedMs.set(run.id, warned);
  }
}

// ── Zombie Recovery ───────────────────────────────────────────────────────────

/**
 * Recover zombie runs on startup via lifecycle module.
 * Delegates full logic (re-queue vs review, validating→review) to lifecycle.
 */
function recoverZombies() {
  lifecycle.recoverZombies();
}

// ── Poll Tick ─────────────────────────────────────────────────────────────────

async function tick(onTask) {
  // Optimization guard: skip if still processing previous tick
  if (_polling) {
    console.log('[worker-loop] previous poll still running — skipping tick');
    return;
  }
  if (_shuttingDown) return;

  _polling = true;
  try {
    // 1. Reclaim expired DB locks
    locks.reclaimExpired();

    // 2. Check timeouts and emit warnings for active runs
    monitorActiveRuns();

    if (_shuttingDown) return;

    // 3. Select candidates (priority-sorted, one per project)
    const candidates = selectPendingTasks();
    if (candidates.length === 0) return;

    console.log(`[worker-loop] ${candidates.length} candidate(s) found`);

    // 4. Acquire locks, register run, dispatch
    for (const task of candidates) {
      if (_shuttingDown) break;

      const runId          = uuidv4();
      const taskLockKey    = locks.taskKey(task.id);
      const projectLockKey = task.project_id ? locks.projectKey(task.project_id) : null;

      // Task lock — prevents double-processing if two worker instances race
      if (!locks.acquire(taskLockKey, runId, LOCK_TTL_MS, { workerId: _workerId })) {
        console.log(`[worker-loop] task ${task.id} already locked — skipping`);
        continue;
      }

      // Project lock — enforces one-run-per-project concurrency
      if (projectLockKey && !locks.acquire(projectLockKey, runId, LOCK_TTL_MS)) {
        locks.release(taskLockKey, runId);
        console.log(`[worker-loop] project ${task.project_id} already locked — skipping task ${task.id}`);
        continue;
      }

      // Register run (DB + in-memory)
      const run = tracker.startRun({
        runId,
        taskId:    task.id,
        projectId: task.project_id  || null,
        engine:    task.engine      || null,
        model:     task.model       || null,
        workerId:  _workerId,
        attempt:   1,
      });

      console.log(`[worker-loop] dispatching task ${task.id} (priority=${task.priority}, engine=${task.engine || 'n/a'})`);

      // Dispatch async — handler owns the run lifecycle; errors here auto-fail
      Promise.resolve()
        .then(() => onTask(task, run))
        .catch(err => {
          console.error(`[worker-loop] onTask error for run ${run.id}:`, err.message || err);
          tracker.failRun(run.id, err.message || String(err));
          locks.release(taskLockKey, runId);
          if (projectLockKey) locks.release(projectLockKey, runId);
          _warnedMs.delete(runId);
        });
    }
  } catch (err) {
    console.error('[worker-loop] tick error:', err.message || err);
  } finally {
    _polling = false;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start the worker loop.
 *
 * @param {object}   opts
 * @param {string}   opts.workerId         — unique identifier for this worker instance
 * @param {Function} opts.onTask           — async (task, run) => void — called per dispatched task
 * @param {number}   [opts.pollIntervalMs] — poll interval override (default 30 000 ms)
 */
function start({ workerId, onTask, pollIntervalMs = POLL_INTERVAL_MS }) {
  if (_timer) throw new Error('[worker-loop] already started');

  _workerId     = workerId;
  _shuttingDown = false;

  console.log(`[worker-loop] starting (workerId=${workerId}, interval=${pollIntervalMs}ms)`);

  // Recover stale zombie runs before first tick
  recoverZombies();

  // Fire immediately, then on interval
  tick(onTask);
  _timer = setInterval(() => tick(onTask), pollIntervalMs);
}

/**
 * Stop the worker loop and gracefully cancel all active runs.
 *
 * @param {string} [reason]
 * @returns {number} number of runs cancelled
 */
function stop(reason = 'worker stopping') {
  _shuttingDown = true;

  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }

  const cancelled = tracker.cancelAll(reason);
  _warnedMs.clear();

  console.log(`[worker-loop] stopped — ${cancelled} run(s) cancelled`);
  return cancelled;
}

/** True if the loop is active. */
function isRunning() {
  return _timer !== null && !_shuttingDown;
}

module.exports = { start, stop, isRunning };
