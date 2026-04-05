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
const gitHelpers = require('./git-helpers');

// ── Error patterns ────────────────────────────────────────────────────────────

const RATE_LIMIT_RE    = /rate.?limit|429|too many requests|quota exceeded|overloaded/i;
const INVALID_MODEL_RE = /invalid.?model|model.?not.?found|unknown model|no such model/i;
const AUTH_ISSUE_RE    = /unauthorized|401|invalid.?api.?key|authentication.?failed|invalid.?token|not authenticated/i;

// ── Error classifier ──────────────────────────────────────────────────────────

/**
 * Classify an error string into a known category.
 * @param {string} text
 * @returns {'rate_limit'|'invalid_model'|'auth_issue'|'unknown'}
 */
function classifyError(text) {
  if (!text) return 'unknown';
  if (RATE_LIMIT_RE.test(text))    return 'rate_limit';
  if (INVALID_MODEL_RE.test(text)) return 'invalid_model';
  if (AUTH_ISSUE_RE.test(text))    return 'auth_issue';
  return 'unknown';
}

function isRateLimit(text) {
  return classifyError(text) === 'rate_limit';
}

// ── Instruction builder ────────────────────────────────────────────────────────

const END_OF_TASK_FOOTER =
  'Fin de tâche attendue: fais les changements, commit si nécessaire, puis rends un feedback final compact ' +
  '(1000 caractères max) contenant le commit SHA si tu en as créé un. ' +
  'La tâche repartira ensuite en review pour validation technique.';

/**
 * Build the full instruction string for a task.
 * Sections: title, description/coderPrompt, workflow context, optimization loop info,
 * rejection feedback, end-of-task footer.
 * Injects CLAUDE.md hint for codex/ollama engines.
 *
 * @param {object} task   — DB task row
 * @param {string} engine — resolved engine
 * @returns {string}
 */
function buildInstruction(task, engine) {
  let extra = {};
  try { extra = JSON.parse(task.input || '{}'); } catch {}

  const base  = (extra.coderPrompt || task.description || task.name || '').trim();
  const title = (task.name || '').trim();

  const parts = [];

  // Title header (only if distinct from the instruction body)
  if (title && title !== base) {
    parts.push(`# ${title}`);
  }

  // Core instruction
  if (base) parts.push(base);

  // Workflow context block
  const ctxLines = [];
  if (task.priority)  ctxLines.push(`Priorité: ${task.priority}`);
  if (extra.engine || task.engine) ctxLines.push(`Engine demandé: ${extra.engine || task.engine}`);
  if (extra.model  || task.model)  ctxLines.push(`Modèle demandé: ${extra.model  || task.model}`);
  if (ctxLines.length) {
    parts.push(`\nContexte workflow:\n${ctxLines.join('\n')}`);
  }

  // Optimization loop info
  if (extra.optimizationLoop) {
    const loopCount = extra.optimizationLoopCount || 0;
    const maxLoops  = extra.optimizationMaxLoops  || 2;
    parts.push(`\nBoucle d'optimisation: ${loopCount + 1}/${maxLoops}`);
  }

  // Rejection feedback injection
  if (extra.rejectionFeedback) {
    parts.push(`\nFeedback de rejet précédent:\n${extra.rejectionFeedback.trim()}`);
  }

  // End-of-task instructions
  parts.push(`\n${END_OF_TASK_FOOTER}`);

  const full = parts.join('\n').trim();

  if (engine === 'codex' || engine === 'ollama') {
    return `Lis CLAUDE.md avant tout.\n\n${full}`;
  }
  return full;
}

// ── Output processing ─────────────────────────────────────────────────────────

// ANSI escape code pattern (CSI sequences, standalone escapes)
const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

/** Strip ANSI escape codes from a string. */
function stripAnsi(text) {
  return (text || '').replace(ANSI_RE, '');
}

// Lines considered noise: blank, braille spinners, pure key=value log tags
const NOISE_RE = /^(\s*$|[\u2800-\u28FF\s]+$|\[[\w-]+\]\s+\w+=\S+\s*$)/;

function filterNoise(lines) {
  return lines.filter(l => !NOISE_RE.test(l));
}

/**
 * Heuristic score for how "summary-like" a line is.
 * Higher score = better candidate for the compact summary.
 * Returns -1 for blank/empty lines (unconditionally excluded).
 *
 * @param {string} line
 * @returns {number}
 */
function scoreSummaryLine(line) {
  const t = line.trim();
  if (!t) return -1;

  let score = 0;

  // Length sweet-spot: informative but not a dump
  if (t.length >= 40 && t.length <= 160) score += 2;
  else if (t.length >= 20 && t.length <= 250) score += 1;

  // Action words commonly found in commit / completion messages
  if (/\b(commit|SHA|added|updated|created|fixed|implemented|done|completed|changed|modified|refactored)\b/i.test(t)) score += 3;

  // Starts with a git SHA (very high signal)
  if (/^[0-9a-f]{7,40}\b/.test(t)) score += 5;

  // SHA appears anywhere in the line
  if (/\b[0-9a-f]{7,40}\b/.test(t)) score += 2;

  // Internal log-tag lines are less useful
  if (/^\[[\w-]+\]/.test(t)) score -= 1;

  return score;
}

/**
 * Process raw engine output into a compact summary.
 * Pipeline: stripAnsi → split lines → filterNoise → score → top-N → truncate.
 *
 * @param {string} rawOutput
 * @param {object} [opts]
 * @param {number} [opts.maxChars=650]
 * @param {number} [opts.maxLines=6]
 * @returns {string}
 */
function processOutput(rawOutput, { maxChars = 650, maxLines = 6 } = {}) {
  if (!rawOutput) return '';

  const clean       = stripAnsi(rawOutput);
  const lines       = clean.split('\n').map(l => l.trimEnd());
  const meaningful  = filterNoise(lines);

  if (!meaningful.length) return clean.slice(0, maxChars);

  // Slightly boost last few lines (end-of-run summaries tend to appear there)
  const scored = meaningful.map((line, i) => ({
    line,
    score: scoreSummaryLine(line) + (i >= meaningful.length - 5 ? 1 : 0),
  }));

  const top = scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxLines)
    .map(s => s.line);

  // Fallback: last N meaningful lines when nothing scores well
  const selected = top.length ? top : meaningful.slice(-maxLines);

  let result = selected.join('\n');
  if (result.length > maxChars) result = result.slice(0, maxChars - 1) + '…';
  return result;
}

// ── Task summary note assembler ───────────────────────────────────────────────

/**
 * Build the final compact summary note for a completed task run.
 * Used for notifications and review annotations.
 *
 * @param {object}      opts
 * @param {object}      opts.task        — DB task row
 * @param {string}      opts.rawOutput   — raw engine output
 * @param {string}      opts.engine      — engine used
 * @param {string|null} opts.model       — model used (or null)
 * @returns {string}   ≤ 1000 chars
 */
function buildTaskSummaryNote({ task, rawOutput, engine, model }) {
  const summary = processOutput(rawOutput);

  const parts = [];
  parts.push(`Engine: ${engine}${model ? ` (${model})` : ''}`);

  // Extract a commit SHA from the raw output (first match)
  const shaMatch = (rawOutput || '').match(/\b([0-9a-f]{7,40})\b/);
  if (shaMatch) parts.push(`Commit: ${shaMatch[1]}`);

  if (summary) parts.push(summary);

  return parts.join('\n').slice(0, 1000);
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
function spawnClaude(instruction, model, run, cwd) {
  return new Promise((resolve, reject) => {
    const args = [
      '--input-format',  'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '-p', instruction,
    ];
    if (model) args.push('--model', model);

    const child = spawn('claude', args, {
      cwd:   cwd || process.cwd(),
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
function spawnCodex(instruction, engine, run, cwd) {
  return new Promise((resolve, reject) => {
    const args = ['exec', instruction, '--dangerously-bypass-approvals-and-sandbox'];
    if (engine === 'ollama') {
      args.push('--oss', '--local-provider', 'ollama');
    }

    const child = spawn('codex', args, {
      cwd:   cwd || process.cwd(),
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

function _dispatch(engine, model, instruction, run, cwd) {
  switch (engine) {
    case 'claude': return spawnClaude(instruction, model, run, cwd);
    case 'codex':  return spawnCodex(instruction, 'codex',  run, cwd);
    case 'ollama': return spawnCodex(instruction, 'ollama', run, cwd);
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
  const cwd               = gitHelpers.resolveProjectPath(task.project_id);

  console.log(`[engine-executor] task=${task.id} engine=${engine} model=${model || 'default'} cwd=${cwd || 'inherited'}`);

  try {
    return await _dispatch(engine, model, instruction, run, cwd);
  } catch (err) {
    if (err.code === 'RATE_LIMIT' && engine === 'claude') {
      const fallback = resolver.nextEngine(engine);
      if (fallback) {
        console.warn(`[engine-executor] rate_limit — falling back to ${fallback}`);
        const fbInstruction = buildInstruction(task, fallback);
        return await _dispatch(fallback, null, fbInstruction, run, cwd);
      }
    }
    throw err;
  }
}

module.exports = {
  execute,
  buildInstruction,
  isRateLimit,
  classifyError,
  stripAnsi,
  scoreSummaryLine,
  processOutput,
  buildTaskSummaryNote,
};
