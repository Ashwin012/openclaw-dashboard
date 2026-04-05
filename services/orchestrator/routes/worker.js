'use strict';

/**
 * routes/worker.js — HTTP Control API (ORCH-013)
 *
 * Compatible with the legacy task-worker format (same response shapes).
 *
 * GET  /status               → { running, count, tasks[] }
 * POST /stop                 → body { taskId } or { project }
 * GET  /question?taskId=|project=  → pending question or null
 * POST /answer               → body { taskId, answer }
 * GET  /output?taskId=|project=    → last 2000 chars of run logs
 */

const { Router } = require('express');
const tracker  = require('../lib/run-tracker');
const lifecycle = require('../lib/lifecycle');
const locks    = require('../lib/locks');
const { getDb } = require('../db');

// ── Q&A In-Memory Store ───────────────────────────────────────────────────────

/** @type {Map<string, { question: string, ts: number }>} */
const _questions = new Map();
/** @type {Map<string, { answer: string, ts: number }>} */
const _answers   = new Map();

/**
 * Minimal Q&A store for interactive engine sessions.
 * Engine calls pendingQuestion() to post a question and pollAnswer() to wait for a reply.
 * Operator calls getQuestion() to read it and submitAnswer() to respond.
 */
const qaStore = {
  pendingQuestion(runId, question) {
    _questions.set(runId, { question, ts: Date.now() });
    _answers.delete(runId);
  },
  getQuestion(runId) {
    return _questions.get(runId) || null;
  },
  submitAnswer(runId, answer) {
    _questions.delete(runId);
    _answers.set(runId, { answer, ts: Date.now() });
  },
  /** Called by engine to consume a submitted answer (clears it). */
  pollAnswer(runId) {
    const entry = _answers.get(runId);
    if (entry) _answers.delete(runId);
    return entry ? entry.answer : null;
  },
  clearRun(runId) {
    _questions.delete(runId);
    _answers.delete(runId);
  },
};

// ── Run resolution ────────────────────────────────────────────────────────────

/**
 * Find an active run by taskId or projectId.
 * When multiple runs match a project (shouldn't happen normally), the first is returned.
 *
 * @param {string|undefined} taskId
 * @param {string|undefined} project  — projectId
 * @returns {object|null} RunState or null
 */
function resolveTargetRun(taskId, project) {
  const runs = tracker.getActiveRuns();

  if (taskId) {
    return runs.find(r => r.taskId === taskId) || null;
  }
  if (project) {
    return runs.find(r => r.projectId === project) || null;
  }
  return null;
}

// ── Router factory ────────────────────────────────────────────────────────────

function workerRouter() {
  const router = Router();

  // GET /status
  router.get('/status', (req, res) => {
    const runs = tracker.getActiveRuns();
    const now  = Date.now();

    const tasks = runs.map(r => ({
      taskId:      r.taskId,
      projectId:   r.projectId  || null,
      engine:      r.engine     || null,
      model:       r.model      || null,
      duration:    Math.floor((now - r.startedAt) / 1000),
      hasQuestion: _questions.has(r.id),
    }));

    res.json({ running: runs.length > 0, count: runs.length, tasks });
  });

  // POST /stop — body: { taskId } or { project }
  router.post('/stop', (req, res) => {
    const { taskId, project } = req.body || {};
    if (!taskId && !project) {
      return res.status(400).json({ error: 'taskId or project required' });
    }

    const run = resolveTargetRun(taskId, project);
    if (!run) {
      return res.status(404).json({ error: 'no active run found', taskId, project });
    }

    // SIGTERM child, finalise run → review
    lifecycle.killProcess(run.id, 'SIGTERM');
    lifecycle.unregisterProcess(run.id);
    lifecycle.transitionToReview(run.id, '', {
      reason:         'manual_stop',
      stoppedManually: true,
      taskId:          run.taskId,
    });

    // Remove from in-memory registry + release advisory locks
    tracker.detachRun(run.id);
    locks.release(locks.taskKey(run.taskId), run.id);
    if (run.projectId) locks.release(locks.projectKey(run.projectId), run.id);

    qaStore.clearRun(run.id);

    console.log(`[worker-route] /stop: run=${run.id} task=${run.taskId}`);
    res.json({ ok: true, runId: run.id, taskId: run.taskId });
  });

  // GET /question?taskId=X  or  ?project=X
  router.get('/question', (req, res) => {
    const { taskId, project } = req.query;
    if (!taskId && !project) {
      return res.status(400).json({ error: 'taskId or project query param required' });
    }

    const run = resolveTargetRun(taskId, project);
    if (!run) {
      return res.json({ question: null, taskId: taskId || null, project: project || null });
    }

    const entry = qaStore.getQuestion(run.id);
    res.json({
      question:  entry ? entry.question : null,
      runId:     run.id,
      taskId:    run.taskId,
      projectId: run.projectId || null,
      ts:        entry ? entry.ts : null,
    });
  });

  // POST /answer — body: { taskId, answer }
  router.post('/answer', (req, res) => {
    const { taskId, answer } = req.body || {};
    if (!taskId || answer == null) {
      return res.status(400).json({ error: 'taskId and answer required' });
    }

    const run = resolveTargetRun(taskId, null);
    if (!run) {
      return res.status(404).json({ error: 'no active run found', taskId });
    }

    qaStore.submitAnswer(run.id, String(answer));
    res.json({ ok: true, runId: run.id, taskId: run.taskId });
  });

  // GET /output?taskId=X  or  ?project=X  — last 2000 chars of stdout
  router.get('/output', (req, res) => {
    const { taskId, project } = req.query;
    if (!taskId && !project) {
      return res.status(400).json({ error: 'taskId or project query param required' });
    }

    const run = resolveTargetRun(taskId, project);
    if (!run) {
      return res.json({ output: null, taskId: taskId || null, project: project || null });
    }

    const row = getDb().prepare('SELECT logs FROM runs WHERE id = ?').get(run.id);
    const raw    = (row && row.logs) || '';
    const output = raw.length > 2000 ? raw.slice(-2000) : raw;

    res.json({
      output,
      runId:     run.id,
      taskId:    run.taskId,
      projectId: run.projectId || null,
    });
  });

  return router;
}

workerRouter.qaStore = qaStore;
module.exports = workerRouter;
