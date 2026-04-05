'use strict';

/**
 * engine-executor.js — Spawn Claude/Codex/Ollama, parse output, handle fallback
 *
 * Claude:  claude --input-format stream-json --output-format stream-json --verbose -p <instruction>
 *          stdout → JSON-lines; extracts text from assistant events + final result
 * Codex:   codex exec <instruction> --dangerously-bypass-approvals-and-sandbox
 * Ollama:  codex exec <instruction> --dangerously-bypass-approvals-and-sandbox --oss --local-provider ollama
 *
 * Fallback: claude rate_limit → codex (automatic, single hop)
 * CLAUDE.md injection: prepended for codex/ollama instructions
 */

const { spawn }  = require('child_process');
const tracker    = require('./run-tracker');
const resolver   = require('./engine-resolver');
const lifecycle  = require('./lifecycle');

// Patterns that indicate the API rate-limited or quota was hit
const RATE_LIMIT_RE = /rate.?limit|429|too many requests|quota exceeded|overloaded/i;

// ── Instruction builder ────────────────────────────────────────────────────────

/**
 * Extract the instruction string from a DB task row.
 * Falls back through coderPrompt → description → name.
 * Injects CLAUDE.md hint for codex/ollama engines.
 *
 * @param {object} task   — DB task row
 * @param {string} engine — resolved engine
 * @returns {string}
 */
function buildInstruction(task, engine) {
  let extra = {};
  try { extra = JSON.parse(task.input || '{}'); } catch {}

  const base = (extra.coderPrompt || task.description || task.name || '').trim();

  if (engine === 'codex' || engine === 'ollama') {
    return `Lis CLAUDE.md avant tout.\n\n${base}`;
  }
  return base;
}

// ── Rate-limit helper ─────────────────────────────────────────────────────────

function isRateLimit(text) {
  return RATE_LIMIT_RE.test(text || '');
}

// ── Claude spawner (stream-json) ───────────────────────────────────────────────

/**
 * Spawn the Claude Code CLI and parse its stream-json output.
 * Streams log chunks to run-tracker as they arrive.
 *
 * @param {string}      instruction
 * @param {string|null} model
 * @param {object}      run  — RunState (has .id)
 * @returns {Promise<{output: string, engine: string, model: string|null}>}
 */
function spawnClaude(instruction, model, run) {
  return new Promise((resolve, reject) => {
    const args = [
      '--input-format',  'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '-p', instruction,
    ];
    if (model) args.push('--model', model);

    const child = spawn('claude', args, {
      env:   { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    lifecycle.registerProcess(run.id, child);

    let outputText  = '';
    let stderrText  = '';
    let resultEvent = null;
    let buf         = '';

    child.stdout.on('data', chunk => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop(); // keep incomplete last line

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let event;
        try { event = JSON.parse(trimmed); } catch { continue; }

        if (event.type === 'assistant') {
          const content = event.message && event.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text' && block.text) {
                outputText += block.text;
                tracker.updateRun(run.id, { logsChunk: block.text });
              }
            }
          }
        } else if (event.type === 'result') {
          resultEvent = event;
        }
      }
    });

    child.stderr.on('data', chunk => {
      stderrText += chunk.toString('utf8');
    });

    child.on('error', err => {
      if (err.code === 'ENOENT') err.message = 'claude CLI not found — is it installed?';
      reject(err);
    });

    child.on('close', code => {
      lifecycle.unregisterProcess(run.id);

      // Flush remaining buffer
      if (buf.trim()) {
        try {
          const ev = JSON.parse(buf.trim());
          if (ev.type === 'result') resultEvent = ev;
        } catch {}
      }

      // Detect rate limit from stderr or result event
      const resultStr = resultEvent ? JSON.stringify(resultEvent) : '';
      if (isRateLimit(stderrText) || isRateLimit(resultStr)) {
        const err = new Error('rate_limit: Claude API rate limit exceeded');
        err.code  = 'RATE_LIMIT';
        return reject(err);
      }

      // Non-zero exit with no output → treat as error
      if (code !== 0 && !outputText) {
        return reject(new Error(
          `claude exited with code ${code}: ${(stderrText || 'no output').slice(0, 500)}`
        ));
      }

      // Prefer result.result (already summarised), fall back to accumulated text
      const final = (resultEvent && resultEvent.result) || outputText;
      resolve({ output: final || '', engine: 'claude', model: model || null });
    });
  });
}

// ── Codex / Ollama spawner ────────────────────────────────────────────────────

/**
 * Spawn Codex CLI (also used for Ollama via --oss --local-provider ollama).
 * Output is plain text; streamed to run-tracker as it arrives.
 *
 * @param {string} instruction
 * @param {string} engine       — 'codex' | 'ollama'
 * @param {object} run
 * @returns {Promise<{output: string, engine: string, model: null}>}
 */
function spawnCodex(instruction, engine, run) {
  return new Promise((resolve, reject) => {
    const args = ['exec', instruction, '--dangerously-bypass-approvals-and-sandbox'];
    if (engine === 'ollama') {
      args.push('--oss', '--local-provider', 'ollama');
    }

    const child = spawn('codex', args, {
      env:   { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    lifecycle.registerProcess(run.id, child);

    let outputText = '';
    let stderrText = '';

    child.stdout.on('data', chunk => {
      const text = chunk.toString('utf8');
      outputText += text;
      tracker.updateRun(run.id, { logsChunk: text });
    });

    child.stderr.on('data', chunk => {
      stderrText += chunk.toString('utf8');
    });

    child.on('error', err => {
      lifecycle.unregisterProcess(run.id);
      if (err.code === 'ENOENT') err.message = 'codex CLI not found — is it installed?';
      reject(err);
    });

    child.on('close', code => {
      lifecycle.unregisterProcess(run.id);
      if (code !== 0 && !outputText) {
        return reject(new Error(
          `codex exited with code ${code}: ${(stderrText || 'no output').slice(0, 500)}`
        ));
      }
      resolve({ output: outputText.trim(), engine, model: null });
    });
  });
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

function _dispatch(engine, model, instruction, run) {
  switch (engine) {
    case 'claude': return spawnClaude(instruction, model, run);
    case 'codex':  return spawnCodex(instruction, 'codex',  run);
    case 'ollama': return spawnCodex(instruction, 'ollama', run);
    default:
      return Promise.reject(new Error(`Unknown engine: ${engine}`));
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Execute a task using its resolved engine.
 * On Claude rate_limit: automatically retries with the next engine in the chain.
 *
 * @param {object} opts
 * @param {object} opts.task — DB task row
 * @param {object} opts.run  — RunState from run-tracker
 * @returns {Promise<{output: string, engine: string, model: string|null}>}
 */
async function execute({ task, run }) {
  const { engine, model } = resolver.resolve(task);
  const instruction       = buildInstruction(task, engine);

  console.log(`[engine-executor] task=${task.id} engine=${engine} model=${model || 'default'}`);

  try {
    return await _dispatch(engine, model, instruction, run);
  } catch (err) {
    if (err.code === 'RATE_LIMIT' && engine === 'claude') {
      const fallback = resolver.nextEngine(engine);
      if (fallback) {
        console.warn(`[engine-executor] rate_limit — falling back to ${fallback}`);
        const fbInstruction = buildInstruction(task, fallback);
        return await _dispatch(fallback, null, fbInstruction, run);
      }
    }
    throw err;
  }
}

module.exports = { execute, buildInstruction, isRateLimit };
