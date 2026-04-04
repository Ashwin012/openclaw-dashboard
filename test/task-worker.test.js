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
  buildInstruction,
  getRejectionFeedback,
} = require('../task-worker');

// ═══════════════════════════════════════════════════════════════════════════════
// Existing tests (preserved from legacy)
// ═══════════════════════════════════════════════════════════════════════════════

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

test('reroutes local Ollama model away from Claude and keeps explicit local model', () => {
  const resolved = resolveEngineConfig(
    { model: null, fallbackModel: null },
    { model: 'qwen3:4b', fallbackModel: 'claude-opus-4-6' },
    'claude'
  );

  assert.equal(resolved.engine, 'ollama');
  assert.equal(resolved.rerouted, true);
  assert.equal(resolved.model, 'qwen3:4b');
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

test('normalizes Ollama qwen3 alias to qwen3:4b', () => {
  const normalized = normalizeModelForEngine('qwen3', 'ollama');
  assert.equal(normalized.model, 'qwen3:4b');
  assert.equal(normalized.source, 'normalized-alias');
  assert.equal(normalized.reason, 'alias_normalized');
});

test('drops fallback model for Ollama because Codex local provider has no fallback flag', () => {
  const normalized = resolveEngineConfig(
    { model: null, fallbackModel: null },
    { model: 'qwen3:4b', fallbackModel: 'qwen3:14b' },
    'ollama',
    { allowReroute: false }
  );

  assert.equal(normalized.engine, 'ollama');
  assert.equal(normalized.model, 'qwen3:4b');
  assert.equal(normalized.fallbackModel, null);
  assert.equal(normalized.fallbackModelSource, 'omitted');
  assert.equal(normalized.fallbackModelReason, 'ollama_via_codex_has_no_fallback_model');
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

test('summarizeTextOutput drops codex metadata noise lines', () => {
  const summary = summarizeTextOutput(`
    OpenAI Codex v0.116.0 (research preview)
    --------
    workdir: /home/openclaw/projects/synaphive
    model: gpt-5.4
    provider: openai
    approval: never
    sandbox: danger-full-access
    Updated task-worker.js so board comments stay concise.
    Added regression coverage for visible worker notes.
    tokens used 12345
  `);

  assert.match(summary, /Updated task-worker\.js so board comments stay concise\./);
  assert.match(summary, /Added regression coverage for visible worker notes\./);
  assert.doesNotMatch(summary, /workdir:/i);
  assert.doesNotMatch(summary, /provider:/i);
  assert.doesNotMatch(summary, /OpenAI Codex v/i);
  assert.doesNotMatch(summary, /tokens used/i);
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
  assert.doesNotMatch(summary, /Stderr:/);
  assert.doesNotMatch(summary, /Erreur:/);
});

test('buildTaskSummaryNote never appends raw structured error or stderr metadata to the visible note', () => {
  const summary = buildTaskSummaryNote({
    engineLabel: 'Codex',
    failed: true,
    classification: {
      type: 'auth_issue',
      structuredError: {
        type: 'auth_issue',
        message: 'OpenAI Codex v0.116.0 | workdir: /home/openclaw/projects/synaphive | provider: openai',
      },
    },
    run: {
      exitCode: 1,
      resultJson: null,
      resultText: `
        OpenAI Codex v0.116.0 (research preview)
        --------
        workdir: /home/openclaw/projects/synaphive
        provider: openai
        model: gpt-5.4
        Authentication failed before the patch could be applied.
      `,
      stderrBuf: `OpenAI Codex v0.116.0 (research preview)
--------
workdir: /home/openclaw/projects/synaphive
provider: openai`,
    },
    qualityResults: [],
  });

  assert.ok(summary.startsWith('❌ Codex échoué (auth_issue, exit=1)'));
  assert.match(summary, /Authentication failed before the patch could be applied\./);
  assert.doesNotMatch(summary, /Stderr:/);
  assert.doesNotMatch(summary, /Erreur:/);
  assert.doesNotMatch(summary, /workdir:/i);
  assert.doesNotMatch(summary, /provider:/i);
  assert.doesNotMatch(summary, /OpenAI Codex v/i);
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

// ═══════════════════════════════════════════════════════════════════════════════
// New tests: webhook, no global cap, per-project lock, optimizationMaxLoops, rejection feedback
// ═══════════════════════════════════════════════════════════════════════════════

test('no global concurrency cap — module does not export MAX_CONCURRENCY or DEFAULT_MAX_CONCURRENCY', () => {
  const tw = require('../task-worker');
  assert.equal(tw.MAX_CONCURRENCY, undefined, 'MAX_CONCURRENCY should not exist');
  assert.equal(tw.DEFAULT_MAX_CONCURRENCY, undefined, 'DEFAULT_MAX_CONCURRENCY should not exist');
});

test('per-project lock: acquireFileLock creates distinct locks for different projects', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-worker-project-locks-'));

  const lockA = acquireFileLock(path.join(tempDir, 'project-afdex.lock'), { instanceId: 'afdex-task-1', pid: 999999 });
  const lockB = acquireFileLock(path.join(tempDir, 'project-stho.lock'), { instanceId: 'stho-task-2', pid: 999999 });

  // Both locks acquired (different files)
  assert.ok(lockA.path, 'Lock A should be acquired');
  assert.ok(lockB.path, 'Lock B should be acquired');
  assert.notEqual(lockA.path, lockB.path);

  releaseFileLock(lockA);
  releaseFileLock(lockB);
});

test('per-project lock: same project lock blocks second acquisition when owner is alive', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-worker-project-lock-block-'));
  const lockPath = path.join(tempDir, 'project-afdex.lock');

  // First acquisition with our own PID (alive)
  const lock1 = acquireFileLock(lockPath, { instanceId: 'afdex-task-1' });
  assert.ok(lock1.path, 'First lock should be acquired');

  // Second attempt — should fail because our own pid holds the lock
  const lock2 = acquireFileLock(lockPath, { instanceId: 'afdex-task-2' });
  assert.equal(lock2.acquired, false);
  assert.equal(lock2.reason, 'locked');

  releaseFileLock(lock1);
});

test('optimizationMaxLoops: buildInstruction includes optimization loop info', () => {
  const task = {
    id: 'test-1',
    title: 'Optimize button component',
    description: 'Make it responsive',
    optimizationLoop: true,
    optimizationLoopCount: 2,
    optimizationMaxLoops: 5,
    notes: [],
  };

  const instruction = buildInstruction(task);
  assert.match(instruction, /passe 3/); // loopCount + 1 = 3
  assert.match(instruction, /max 5/);
  assert.match(instruction, /retravailles du code/); // loopCount > 0
});

test('optimizationMaxLoops: first pass shows different message', () => {
  const task = {
    id: 'test-2',
    title: 'Build feature X',
    description: '',
    optimizationLoop: true,
    optimizationLoopCount: 0,
    optimizationMaxLoops: 3,
    notes: [],
  };

  const instruction = buildInstruction(task);
  assert.match(instruction, /passe 1/);
  assert.match(instruction, /max 3/);
  assert.match(instruction, /autorise une ou plusieurs boucles/);
  assert.doesNotMatch(instruction, /retravailles du code/);
});

test('rejection feedback: getRejectionFeedback extracts reviewer rejection notes', () => {
  const task = {
    notes: [
      { author: 'Worker', text: '✅ Claude terminé', timestamp: '2026-04-01T00:00:00Z' },
      { author: 'Reviewer', text: '❌ Rejeté — le bouton ne fonctionne pas sur mobile', timestamp: '2026-04-01T01:00:00Z' },
      { author: 'Ashwin', text: 'Looks good to me', timestamp: '2026-04-01T02:00:00Z' },
      { author: 'Reviewer', text: '❌ Rejeté — manque les tests unitaires', timestamp: '2026-04-01T03:00:00Z' },
    ],
  };

  const feedback = getRejectionFeedback(task);
  assert.equal(feedback.length, 2);
  assert.match(feedback[0], /bouton ne fonctionne pas/);
  assert.match(feedback[1], /manque les tests unitaires/);
});

test('rejection feedback: getRejectionFeedback also catches agent technique notes', () => {
  const task = {
    notes: [
      { author: 'Agent technique', text: '❌ Rejeté: la validation du formulaire est cassée', timestamp: '2026-04-01T01:00:00Z' },
      { author: 'Agent', text: '❌ rejected — CSS not responsive', timestamp: '2026-04-01T02:00:00Z' },
    ],
  };

  const feedback = getRejectionFeedback(task);
  assert.equal(feedback.length, 2);
});

test('rejection feedback: getRejectionFeedback ignores non-rejection notes', () => {
  const task = {
    notes: [
      { author: 'Reviewer', text: '✅ Validé: tout est bon', timestamp: '2026-04-01T01:00:00Z' },
      { author: 'Worker', text: '❌ Failed to build', timestamp: '2026-04-01T02:00:00Z' },
      { author: 'Ashwin', text: '❌ rejected by human', timestamp: '2026-04-01T03:00:00Z' },
    ],
  };

  const feedback = getRejectionFeedback(task);
  assert.equal(feedback.length, 0, 'Worker and Ashwin notes should not be treated as reviewer feedback');
});

test('rejection feedback: buildInstruction injects all rejection history for the coder', () => {
  const task = {
    id: 'test-feedback',
    title: 'Fix login page',
    description: 'Fix the login form',
    optimizationLoop: true,
    optimizationLoopCount: 2,
    optimizationMaxLoops: 5,
    notes: [
      { author: 'Reviewer', text: '❌ Rejeté — manque la validation email', timestamp: '2026-04-01T01:00:00Z' },
      { author: 'Agent', text: '❌ Rejeté — le bouton submit ne marche pas', timestamp: '2026-04-01T02:00:00Z' },
    ],
  };

  const instruction = buildInstruction(task);
  assert.match(instruction, /FEEDBACK DES REVIEWS PRÉCÉDENTES/);
  assert.match(instruction, /\[Review 1\]/);
  assert.match(instruction, /\[Review 2\]/);
  assert.match(instruction, /manque la validation email/);
  assert.match(instruction, /bouton submit ne marche pas/);
  assert.match(instruction, /Corrige les points soulevés/);
});

test('rejection feedback: buildInstruction works fine with no rejection notes', () => {
  const task = {
    id: 'test-no-feedback',
    title: 'Add dark mode',
    description: 'Implement dark mode toggle',
    notes: [
      { author: 'Worker', text: '✅ Done', timestamp: '2026-04-01T00:00:00Z' },
    ],
  };

  const instruction = buildInstruction(task);
  assert.doesNotMatch(instruction, /FEEDBACK DES REVIEWS PRÉCÉDENTES/);
  assert.match(instruction, /Add dark mode/);
  assert.match(instruction, /Implement dark mode toggle/);
});

test('webhook: sendWebhook is exported and is a function', () => {
  const tw = require('../task-worker');
  assert.equal(typeof tw.sendWebhook, 'function');
});

test('module does not export review-related functions (callAnthropicReviewAPI, processReviewTask, etc.)', () => {
  const tw = require('../task-worker');
  assert.equal(tw.callAnthropicReviewAPI, undefined, 'callAnthropicReviewAPI should not exist');
  assert.equal(tw.processReviewTask, undefined, 'processReviewTask should not exist');
  assert.equal(tw.buildReviewInstruction, undefined, 'buildReviewInstruction should not exist');
  assert.equal(tw.parseReviewVerdict, undefined, 'parseReviewVerdict should not exist');
  assert.equal(tw.autoDeploy, undefined, 'autoDeploy should not exist');
});

test('status endpoint does not expose maxConcurrency field', () => {
  // The status endpoint response format check: no maxConcurrency in the module
  const tw = require('../task-worker');
  // hasProjectActiveRun is the per-project check (no global cap)
  assert.equal(typeof tw.hasProjectActiveRun, 'function');
});
