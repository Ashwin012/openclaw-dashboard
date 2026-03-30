'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyRunOutcome,
  normalizeModelForEngine,
  resolveEngineConfig,
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

test('maps unsupported Codex aliases to safe supported model', () => {
  const normalized = normalizeModelForEngine('openai-codex/gpt-5.3-codex', 'codex');
  assert.equal(normalized.model, 'gpt-5.4');
  assert.equal(normalized.source, 'safe-default');
  assert.equal(normalized.reason, 'unsupported_codex_model');
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
