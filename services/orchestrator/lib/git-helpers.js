'use strict';

/**
 * git-helpers.js — Quality gates + git commit tracking
 *
 * resolveProjectPath(projectId): look up filesystem path from config.json
 * getGitHeadInfo(projectPath): git rev-parse HEAD + git log -1 --format=%s
 * extractCommitHash(text): parse first git SHA (7-40 hex chars) from text
 * runQualityGates(projectPath): find gitCheck-docker.sh, execute (10min timeout)
 * summarizeQualityGates(result): compact string for task summary note
 */

const { execFile, spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');

const CONFIG_PATH            = path.join(__dirname, '..', '..', '..', 'config.json');
const QUALITY_GATE_SCRIPT    = 'gitCheck-docker.sh';
const QUALITY_GATE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// ── Config ────────────────────────────────────────────────────────────────────

let _config = null;

function _loadConfig() {
  if (_config) return _config;
  try {
    _config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    console.warn('[git-helpers] cannot read config.json:', e.message);
    _config = { projects: [] };
  }
  return _config;
}

/**
 * Resolve filesystem path for a project ID from config.json.
 * @param {string} projectId
 * @returns {string|null}
 */
function resolveProjectPath(projectId) {
  if (!projectId) return null;
  const cfg  = _loadConfig();
  const proj = (cfg.projects || []).find(p => p.id === projectId);
  return (proj && proj.path) || null;
}

// ── Git helpers ───────────────────────────────────────────────────────────────

function _runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || '').trim() || err.message));
      resolve((stdout || '').trim());
    });
  });
}

/**
 * Get HEAD SHA and commit subject for a git repo.
 * @param {string|null} projectPath
 * @returns {Promise<{sha: string|null, subject: string|null}>}
 */
async function getGitHeadInfo(projectPath) {
  if (!projectPath) return { sha: null, subject: null };
  try {
    const [sha, subject] = await Promise.all([
      _runGit(['rev-parse', 'HEAD'], projectPath),
      _runGit(['log', '-1', '--format=%s'], projectPath),
    ]);
    return { sha: sha || null, subject: subject || null };
  } catch (e) {
    console.warn(`[git-helpers] getGitHeadInfo(${projectPath}):`, e.message);
    return { sha: null, subject: null };
  }
}

/**
 * Extract first git SHA (7-40 hex chars) from a text block.
 * @param {string} text
 * @returns {string|null}
 */
function extractCommitHash(text) {
  if (!text) return null;
  const m = (text || '').match(/\b([0-9a-f]{7,40})\b/);
  return m ? m[1] : null;
}

// ── Quality gates ─────────────────────────────────────────────────────────────

/**
 * Search for gitCheck-docker.sh in projectPath and up to 3 parent directories.
 * @param {string} projectPath
 * @returns {string|null} absolute path to script or null
 */
function _findQualityGateScript(projectPath) {
  if (!projectPath) return null;
  let dir = projectPath;
  for (let i = 0; i < 4; i++) {
    const candidate = path.join(dir, QUALITY_GATE_SCRIPT);
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Run quality gates (gitCheck-docker.sh) for a project path.
 *
 * @param {string|null} projectPath
 * @returns {Promise<{found: boolean, passed: boolean, output: string, durationMs: number}>}
 */
function runQualityGates(projectPath) {
  const scriptPath = _findQualityGateScript(projectPath);

  if (!scriptPath) {
    return Promise.resolve({ found: false, passed: true, output: '', durationMs: 0 });
  }

  console.log(`[git-helpers] running quality gate: ${scriptPath}`);
  const startMs = Date.now();

  return new Promise((resolve) => {
    const child = spawn('bash', [scriptPath], {
      cwd:   path.dirname(scriptPath),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout    = '';
    let stderr    = '';
    let timedOut  = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, QUALITY_GATE_TIMEOUT_MS);

    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });

    child.on('close', code => {
      clearTimeout(timer);
      const durationMs = Date.now() - startMs;
      const rawOut     = (stdout + (stderr ? `\nSTDERR:\n${stderr}` : '')).trim();

      if (timedOut) {
        console.warn(`[git-helpers] quality gate timed out (${QUALITY_GATE_TIMEOUT_MS / 1000}s)`);
        resolve({ found: true, passed: false, output: `TIMEOUT after ${QUALITY_GATE_TIMEOUT_MS / 1000}s\n${rawOut}`, durationMs });
        return;
      }

      const passed = code === 0;
      console.log(`[git-helpers] quality gate ${passed ? 'PASSED' : 'FAILED'} (exit=${code}, ${durationMs}ms)`);
      resolve({ found: true, passed, output: rawOut, durationMs });
    });

    child.on('error', err => {
      clearTimeout(timer);
      const durationMs = Date.now() - startMs;
      console.warn('[git-helpers] quality gate spawn error:', err.message);
      resolve({ found: true, passed: false, output: err.message, durationMs });
    });
  });
}

/**
 * Format quality gate result into a compact line for inclusion in task summary.
 * @param {{found: boolean, passed: boolean, output: string, durationMs: number}} result
 * @returns {string}  empty string when no gate was found
 */
function summarizeQualityGates(result) {
  if (!result || !result.found) return '';

  const icon     = result.passed ? '✅' : '❌';
  const label    = result.passed ? 'Quality gate PASSED' : 'Quality gate FAILED';
  const duration = `${(result.durationMs / 1000).toFixed(1)}s`;
  let   summary  = `${icon} ${label} (${duration})`;

  if (result.output) {
    const snippet = result.output.slice(0, 200).trim();
    summary += `\n${snippet}`;
  }

  return summary;
}

module.exports = {
  resolveProjectPath,
  getGitHeadInfo,
  extractCommitHash,
  runQualityGates,
  summarizeQualityGates,
};
