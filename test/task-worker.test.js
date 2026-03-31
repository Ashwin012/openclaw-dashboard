'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  acquireFileLock,
  buildTaskSummaryNote,
  classifyRunOutcome,
  normalizeModelForEngine,
  releaseFileLock,
  resolveEngineConfig,
  setWorkerFinalNote,
  shouldAttemptEngineFallback,
  summarizeStderr,
  summarizeTextOutput,
} = require('../task-worker');

test('classifies Claude structured rate limit errors and allows Claude -> Codex fallback', () => {
  const run = {
    exitCode: 1,
    stoppedManually: false,
    resultJson: {
      type: 'result',
      subtype: 'error',
      error: {
        type: 'rate_limit_error',
        message: 'Rate limit exceeded',
      },
    },
    rateLimitEvents: [
      {
        type: 'rate_limit_event',
        message: '429 rate limit',
      },
    ],
    stderrBuf: '',
  };

  const classification = classifyRunOutcome(run);
  assert.equal(classification.status, 'failed');
  assert.equal(classification.type, 'rate_limit');
  assert.equal(shouldAttemptEngineFallback('claude', classification, false), true);
  assert.equal(shouldAttemptEngineFallback('codex', classification, false), false);
});

test('classifies auth errors and skips engine fallback', () => {
  const classification = classifyRunOutcome({
    exitCode: 1,
    stoppedManually: false,
    resultJson: {
      type: 'result',
      subtype: 'error',
      error: {
        type: 'authentication_error',
        message: 'API key invalid',
      },
    },
    rateLimitEvents: [],
    stderrBuf: '',
  });

  assert.equal(classification.status, 'failed');
  assert.equal(classification.type, 'auth_issue');
  assert.equal(shouldAttemptEngineFallback('claude', classification, false), false);
});

test('normalizes opus to supported Codex model during explicit fallback', () => {
  const resolved = resolveEngineConfig(
    { model: null, fallbackModel: null },
    { model: 'opus', fallbackModel: 'claude-opus-4-6' },
    'codex',
    { allowReroute: false }
  );

  assert.equal(resolved.engine, 'codex');
  assert.equal(resolved.model, 'gpt-5.4');
  assert.equal(resolved.modelSource, 'safe-default');
  assert.equal(resolved.fallbackModel, null);
  assert.equal(resolved.fallbackModelSource, 'omitted');
});

test('normalizes sonnet to supported Codex model during explicit fallback', () => {
  const resolved = resolveEngineConfig(
    { model: null, fallbackModel: null },
    { model: 'sonnet', fallbackModel: 'claude-sonnet-4-6' },
    'codex',
    { allowReroute: false }
  );

  assert.equal(resolved.engine, 'codex');
  assert.equal(resolved.model, 'gpt-5.4');
  assert.equal(resolved.modelSource, 'safe-default');
  assert.equal(resolved.fallbackModel, null);
});

test('reroutes OpenAI model away from Claude and keeps supported Codex model', () => {
  const resolved = resolveEngineConfig(
    { model: null, fallbackModel: null },
    { model: 'gpt-5.4', fallbackModel: 'claude-opus-4-6' },
    'claude'
  );

  assert.equal(resolved.engine, 'codex');
  assert.equal(resolved.rerouted, true);
  assert.equal(resolved.model, 'gpt-5.4');
  assert.equal(resolved.fallbackModel, null);
  assert.equal(resolved.fallbackModelSource, 'omitted');
});

test('keeps supported Codex gpt-5.3-codex alias', () => {
  const normalized = normalizeModelForEngine('openai-codex/gpt-5.3-codex', 'codex');
  assert.equal(normalized.model, 'gpt-5.3-codex');
  assert.equal(normalized.source, 'normalized-alias');
  assert.equal(normalized.reason, 'alias_normalized');
});

test('keeps supported Codex direct gpt-5.3-codex model untouched', () => {
  const normalized = normalizeModelForEngine('gpt-5.3-codex', 'codex');
  assert.equal(normalized.model, 'gpt-5.3-codex');
  assert.equal(normalized.source, 'configured');
  assert.equal(normalized.reason, null);
});

test('keeps supported Codex direct model untouched', () => {
  const normalized = normalizeModelForEngine('gpt-5.4', 'codex');
  assert.equal(normalized.model, 'gpt-5.4');
  assert.equal(normalized.source, 'configured');
});

test('flags Codex invalid model stderr as invalid_model without fallback', () => {
  const classification = classifyRunOutcome({
    exitCode: 1,
    stoppedManually: false,
    resultJson: null,
    rateLimitEvents: [],
    stderrBuf: 'HTTP 400 invalid model: claude-sonnet-4-6',
  });

  assert.equal(classification.status, 'failed');
  assert.equal(classification.type, 'invalid_model');
  assert.equal(shouldAttemptEngineFallback('claude', classification, false), false);
});

test('summarizes long agent output into a short bullet list', () => {
  const summary = summarizeTextOutput(`
    INFO starting worker
    Updated /tmp/project/task-worker.js to replace raw output notes with summaries.
    Added tests in test/task-worker.test.js for output summarization.
    node --test passed successfully.
    DEBUG internal timing 123ms
    Final result: task ready for review.
  `);

  assert.match(summary, /Updated .*task-worker\.js/);
  assert.match(summary, /Added tests .*task-worker\.test\.js/);
  assert.match(summary, /Final result: task ready for review\./);
  assert.doesNotMatch(summary, /^- INFO starting worker$/m);
  assert.match(summary, /autre\(s\) ligne\(s\) masquée\(s\)/);
});

test('summarizes stderr without dumping the full buffer', () => {
  const summary = summarizeStderr(`
    Error: command failed
    at runTask (/tmp/project/task-worker.js:10:2)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
  `);

  assert.match(summary, /^Error: command failed \| at runTask/);
  assert.match(summary, /1 ligne\(s\) stderr masquée\(s\)/);
});

test('acquireFileLock blocks when a live owner already holds the lock', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-worker-lock-live-'));
  const lockPath = path.join(tempDir, 'worker.lock');

  fs.writeFileSync(lockPath, JSON.stringify({
    pid: process.pid,
    instanceId: 'other-live-owner',
    acquiredAt: new Date().toISOString(),
  }), 'utf8');

  const lock = acquireFileLock(lockPath, { instanceId: 'current-process' });
  assert.equal(lock.acquired, false);
  assert.equal(lock.reason, 'locked');
  assert.equal(lock.existing.instanceId, 'other-live-owner');
});

test('acquireFileLock replaces stale lock files from dead processes', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-worker-lock-stale-'));
  const lockPath = path.join(tempDir, 'worker.lock');

  fs.writeFileSync(lockPath, JSON.stringify({
    pid: 999999,
    instanceId: 'stale-owner',
    acquiredAt: new Date().toISOString(),
  }), 'utf8');

  const lock = acquireFileLock(lockPath, { instanceId: 'fresh-owner' });
  assert.equal(lock.path, lockPath);
  assert.equal(lock.instanceId, 'fresh-owner');
  assert.equal(lock.replacedStaleLock, true);

  const stored = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  assert.equal(stored.instanceId, 'fresh-owner');

  releaseFileLock(lock);
  assert.equal(fs.existsSync(lockPath), false);
});


test('buildTaskSummaryNote hard-limits the final worker note to 1000 chars', () => {
  const summary = buildTaskSummaryNote({
    engineLabel: 'Codex',
    failed: false,
    classification: { type: 'success', structuredError: null },
    run: {
      exitCode: 0,
      resultJson: { duration_ms: 42000, num_turns: 4, total_cost_usd: 0.1234 },
      resultText: `
        INFO streaming raw logs should not dominate the note
        Updated src/task-worker.js to replace worker notes instead of stacking them.
        Added protection so only one final worker comment is stored.
        Added truncation at 1000 chars and stripped raw stderr dumps.
        Added tests for buildTaskSummaryNote and setWorkerFinalNote.
        ${'Verbose raw output line '.repeat(120)}
      `,
      stderrBuf: `Traceback line 1
Traceback line 2
Traceback line 3
${'stderr '.repeat(80)}`,
    },
    qualityResults: [
      { gate: 'gitCheck-docker.sh', passed: true, output: 'working tree clean enough for review' },
      { gate: 'npm test', passed: true, output: 'all task-worker tests passed' },
    ],
  });

  assert.ok(summary.startsWith('✅ Codex terminé'));
  assert.ok(summary.length <= 1000);
  assert.match(summary, /Added protection so only one final worker comment is stored\./);
  assert.match(summary, /Added tests for buildTaskSummaryNote and setWorkerFinalNote\./);
  assert.doesNotMatch(summary, /INFO streaming raw logs should not dominate the note/);
  assert.doesNotMatch(summary, /Verbose raw output line Verbose raw output line/);
});

test('setWorkerFinalNote replaces previous worker notes instead of stacking them', () => {
  const task = {
    notes: [
      { author: 'Worker', text: 'old worker note', timestamp: '2026-03-30T00:00:00Z' },
      { author: 'Ashwin', text: 'human note', timestamp: '2026-03-30T00:01:00Z' },
      { author: 'worker', text: 'another worker note', timestamp: '2026-03-30T00:02:00Z' },
    ],
  };

  setWorkerFinalNote(task, 'Final worker summary');

  assert.equal(task.notes.length, 2);
  assert.deepEqual(task.notes.map(note => note.author), ['Ashwin', 'Worker']);
  assert.equal(task.notes[1].text, 'Final worker summary');
});
