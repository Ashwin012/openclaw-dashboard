'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { readJSON, writeJSON } = require('./lib/json-store');

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(__dirname, 'config.json');
const POLL_INTERVAL_MS = 30_000;
const QUALITY_GATE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_SUMMARY_CHARS = 1_000;
const MAX_SUMMARY_LINES = 6;
const MAX_STDERR_SUMMARY_CHARS = 280;
const NVM_NODE_PATH = '/home/openclaw/.nvm/versions/node/v20.20.1/bin';
const NVM_SOURCE = 'source /home/openclaw/.nvm/nvm.sh';
const WORKER_PORT = 8091;
const DASHBOARD_DIR = path.join(__dirname, '.dashboard');
const WORKER_LOCKS_DIR = path.join(DASHBOARD_DIR, 'worker-locks');
const WORKER_INSTANCE_LOCK_PATH = path.join(WORKER_LOCKS_DIR, 'task-worker.lock');
const NOTIFICATIONS_PATH = path.join(DASHBOARD_DIR, 'notifications.json');
const DEFAULT_MAX_CONCURRENCY = 2;
const DEFAULT_ENGINE_MODELS = {
  claude: 'claude-sonnet-4-6',
  codex: 'gpt-5.4',
  ollama: 'qwen3:8b',
};
const SUPPORTED_CODEX_MODELS = new Set(['default', 'gpt-5.4', 'gpt-5.3-codex']);
const CLAUDE_MODEL_ALIASES = {
  sonnet: 'claude-sonnet-4-6',
  'sonnet-4-6': 'claude-sonnet-4-6',
  'claude-sonnet-4-6': 'claude-sonnet-4-6',
  opus: 'claude-opus-4-6',
  'opus-4-6': 'claude-opus-4-6',
  'claude-opus-4-6': 'claude-opus-4-6',
  haiku: 'claude-haiku-3-5',
  'haiku-3-5': 'claude-haiku-3-5',
  'claude-haiku-3-5': 'claude-haiku-3-5',
};
const CODEX_MODEL_ALIASES = {
  default: 'default',
  'gpt-5.4': 'gpt-5.4',
  'openai-codex/gpt-5.4': 'gpt-5.4',
  'gpt-5.3-codex': 'gpt-5.3-codex',
  'openai-codex/gpt-5.3-codex': 'gpt-5.3-codex',
};
const OLLAMA_MODEL_ALIASES = {
  qwen3: 'qwen3:8b',
  'qwen3:8b': 'qwen3:8b',
};

const WARNING_THRESHOLDS_MIN = [30, 60, 120];
const QUESTION_POLL_MS = 2_000;
const QUESTION_WARN_MS = 30 * 60 * 1000;

// ─── Logging ──────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function logError(msg, err) {
  console.error(`[${new Date().toISOString()}] ERROR ${msg}`, err ? (err.message || err) : '');
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

let shuttingDown = false;
let workerInstanceLock = null;

process.on('SIGTERM', () => {
  log('SIGTERM received — shutting down');
  shuttingDown = true;
  stopAllActiveRuns();
});

process.on('SIGINT', () => {
  log('SIGINT received — shutting down');
  shuttingDown = true;
  stopAllActiveRuns();
});

process.on('exit', () => {
  releaseWorkerInstanceLock();
});

// ─── Active run tracking ──────────────────────────────────────────────────────

const activeRuns = new Map();
const activeProjects = new Map();

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && err.code === 'EPERM') return true;
    return false;
  }
}

function readLockFile(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

function releaseFileLock(lockHandle) {
  if (!lockHandle || !lockHandle.path) return;
  try {
    const current = readLockFile(lockHandle.path);
    if (!current || current.instanceId !== lockHandle.instanceId) return;
    fs.unlinkSync(lockHandle.path);
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      logError(`Failed to release lock ${lockHandle.path}`, err);
    }
  }
}

function acquireFileLock(lockPath, metadata) {
  ensureDir(path.dirname(lockPath));
  const payload = {
    ...metadata,
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
  };
  const serialized = JSON.stringify(payload, null, 2);

  try {
    const fd = fs.openSync(lockPath, 'wx');
    try {
      fs.writeFileSync(fd, serialized, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
    return {
      path: lockPath,
      pid: payload.pid,
      instanceId: payload.instanceId || null,
      metadata: payload,
    };
  } catch (err) {
    if (!err || err.code !== 'EEXIST') throw err;
  }

  const existing = readLockFile(lockPath);
  if (existing && isProcessAlive(existing.pid)) {
    return {
      acquired: false,
      reason: 'locked',
      existing,
    };
  }

  try {
    fs.unlinkSync(lockPath);
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      return {
        acquired: false,
        reason: 'stale_lock_unlink_failed',
        existing,
        error: err,
      };
    }
  }

  try {
    const fd = fs.openSync(lockPath, 'wx');
    try {
      fs.writeFileSync(fd, serialized, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
    return {
      path: lockPath,
      pid: payload.pid,
      instanceId: payload.instanceId || null,
      metadata: payload,
      replacedStaleLock: Boolean(existing),
    };
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      return {
        acquired: false,
        reason: 'raced',
        existing: readLockFile(lockPath),
      };
    }
    throw err;
  }
}

function getProjectLockPath(projectId) {
  return path.join(WORKER_LOCKS_DIR, `project-${projectId}.lock`);
}

function acquireWorkerInstanceLock() {
  const lock = acquireFileLock(WORKER_INSTANCE_LOCK_PATH, {
    instanceId: `worker-${process.pid}-${Date.now()}`,
    scope: 'worker-instance',
    port: WORKER_PORT,
  });

  if (!lock || lock.acquired === false) {
    return lock || { acquired: false, reason: 'unknown' };
  }

  if (lock.replacedStaleLock) {
    log(`Recovered stale worker instance lock at ${WORKER_INSTANCE_LOCK_PATH}`);
  }

  workerInstanceLock = lock;
  return lock;
}

function releaseWorkerInstanceLock() {
  if (!workerInstanceLock) return;
  releaseFileLock(workerInstanceLock);
  workerInstanceLock = null;
}

function acquireProjectExecutionLock(project, task) {
  const lock = acquireFileLock(getProjectLockPath(project.id), {
    instanceId: `project-${project.id}-task-${task.id}-pid-${process.pid}`,
    scope: 'project-execution',
    projectId: project.id,
    projectName: project.name,
    taskId: task.id,
    taskTitle: task.title,
  });

  if (!lock || lock.acquired === false) {
    return lock || { acquired: false, reason: 'unknown' };
  }

  return lock;
}

function getActiveRunCount() {
  return activeRuns.size;
}

function getActiveRunsList() {
  return Array.from(activeRuns.values())
    .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
}

function hasProjectActiveRun(projectId) {
  return activeProjects.has(projectId);
}

function createReservedRun(project, task) {
  const runState = {
    taskId: task.id,
    taskTitle: task.title,
    projectId: project.id,
    projectName: project.name,
    projectPath: project.path,
    engine: task.engine || project.engine || 'claude',
    startTime: new Date(),
    warned: new Set(),
    stoppedManually: false,
    proc: null,
    pid: null,
    resultText: '',
    currentQuestion: null,
    questionStartTime: 0,
    questionWarnEmitted: false,
    pendingAnswer: null,
    answerDeliveredAt: null,
    projectLock: null,
  };

  activeRuns.set(task.id, runState);
  activeProjects.set(project.id, task.id);
  return runState;
}

function releaseRun(taskId) {
  const runState = activeRuns.get(taskId);
  if (!runState) return null;
  activeRuns.delete(taskId);
  if (activeProjects.get(runState.projectId) === taskId) {
    activeProjects.delete(runState.projectId);
  }
  return runState;
}

function stopAllActiveRuns() {
  for (const runState of activeRuns.values()) {
    runState.stoppedManually = true;
    try { runState.proc && runState.proc.kill('SIGTERM'); } catch {}
  }
}

function getRunByProject(projectId) {
  const taskId = activeProjects.get(projectId);
  return taskId ? activeRuns.get(taskId) || null : null;
}

function describeRun(runState) {
  const durationMin = Math.floor((Date.now() - runState.startTime.getTime()) / 60_000);
  return {
    id: runState.taskId,
    title: runState.taskTitle,
    project: runState.projectName,
    projectId: runState.projectId,
    startedAt: runState.startTime.toISOString(),
    durationMin,
    pid: runState.pid,
    engine: runState.engine,
    pendingQuestion: runState.currentQuestion,
  };
}

function getLegacyStatusFields(runs) {
  if (runs.length !== 1) {
    return { task: null, pendingQuestion: null };
  }
  return {
    task: describeRun(runs[0]),
    pendingQuestion: runs[0].currentQuestion,
  };
}

function resolveTargetRun(query) {
  const taskId = typeof query.taskId === 'string' && query.taskId.trim() ? query.taskId.trim() : null;
  const projectId = typeof query.project === 'string' && query.project.trim() ? query.project.trim() : null;

  if (taskId) {
    const runState = activeRuns.get(taskId);
    if (!runState) {
      return { error: `Active task not found for taskId=${taskId}`, statusCode: 404 };
    }
    if (projectId && runState.projectId !== projectId) {
      return { error: 'taskId and project do not match the same active run', statusCode: 400 };
    }
    return { runState };
  }

  if (projectId) {
    const runState = getRunByProject(projectId);
    if (!runState) {
      return { error: `No active task for project=${projectId}`, statusCode: 404 };
    }
    return { runState };
  }

  const runs = getActiveRunsList();
  if (runs.length === 0) {
    return { runState: null };
  }
  if (runs.length === 1) {
    return { runState: runs[0] };
  }

  return {
    error: 'Multiple tasks are active; specify taskId or project',
    statusCode: 400,
  };
}

// ─── Notifications ────────────────────────────────────────────────────────────

function addNotification(projectName, taskTitle, taskId, fromStatus, toStatus, message) {
  try {
    const data = readJSON(NOTIFICATIONS_PATH, { pending: [] }) || { pending: [] };
    if (!Array.isArray(data.pending)) data.pending = [];
    data.pending.push({ projectName, taskTitle, taskId, fromStatus, toStatus, message, timestamp: new Date().toISOString() });
    writeJSON(NOTIFICATIONS_PATH, data);
  } catch (err) {
    logError('Failed to write notification', err);
  }
}

// ─── tasks.json helpers ───────────────────────────────────────────────────────

function getTasksPath(projectPath) {
  return path.join(projectPath, '.claude', 'tasks.json');
}

function readTasks(projectPath) {
  const raw = readJSON(getTasksPath(projectPath), { tasks: [] }) || { tasks: [] };
  if (Array.isArray(raw)) return { tasks: raw };
  if (raw && Array.isArray(raw.tasks)) return raw;
  return { tasks: [] };
}

function writeTasks(projectPath, data) {
  const p = getTasksPath(projectPath);
  const toWrite = Array.isArray(data) ? { tasks: data } : data;
  writeJSON(p, toWrite);
}

function now() {
  return new Date().toISOString();
}

function addNote(task, author, text) {
  if (!Array.isArray(task.notes)) task.notes = [];
  task.notes.push({ author, text, timestamp: now() });
}

function isWorkerNote(note) {
  return note && typeof note.author === 'string' && note.author.trim().toLowerCase() === 'worker';
}

function removeWorkerNotes(task) {
  if (!Array.isArray(task.notes)) {
    task.notes = [];
    return;
  }
  task.notes = task.notes.filter(note => !isWorkerNote(note));
}

function setWorkerFinalNote(task, text) {
  removeWorkerNotes(task);
  const finalText = clampText(text, MAX_SUMMARY_CHARS);
  if (!finalText) return;
  addNote(task, 'Worker', finalText);
}


function isAuthorNote(note, author) {
  return note && typeof note.author === 'string' && note.author.trim().toLowerCase() === author.trim().toLowerCase();
}

function removeNotesByAuthor(task, author) {
  if (!Array.isArray(task.notes)) {
    task.notes = [];
    return;
  }
  task.notes = task.notes.filter(note => !isAuthorNote(note, author));
}

function setAuthorFinalNote(task, author, text) {
  removeNotesByAuthor(task, author);
  const finalText = clampText(text, MAX_SUMMARY_CHARS);
  if (!finalText) return;
  addNote(task, author, finalText);
}

async function getGitHeadInfo(projectPath) {
  const rev = await spawnPromise('git rev-parse HEAD', { cwd: projectPath }, 15000);
  if (rev.code !== 0 || !rev.output) return null;
  const hash = rev.output.trim().split(/\s+/)[0];
  if (!hash) return null;
  const msg = await spawnPromise(`git log -1 --pretty=%s ${hash}`, { cwd: projectPath }, 15000);
  return {
    hash,
    shortHash: hash.slice(0, 7),
    message: msg.code === 0 ? msg.output.trim() : '',
  };
}

function extractCommitHash(text) {
  if (!text || typeof text !== 'string') return null;
  const matches = text.match(/[0-9a-f]{7,40}/gi);
  if (!matches || !matches.length) return null;
  return matches[matches.length - 1];
}

function updateTask(projectPath, taskId, mutate) {
  const data = readTasks(projectPath);
  const task = data.tasks.find(t => t.id === taskId);
  if (!task) {
    logError(`Task ${taskId} not found in ${projectPath}`);
    return null;
  }
  mutate(task);
  task.updatedAt = now();
  writeTasks(projectPath, data);
  return task;
}

// ─── Quality gates ────────────────────────────────────────────────────────────

function spawnPromise(cmd, opts, timeoutMs) {
  return new Promise(resolve => {
    const proc = spawn(cmd, { ...opts, shell: '/bin/bash' });
    let stdout = '';
    let stderr = '';
    proc.stdout && proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr && proc.stderr.on('data', d => { stderr += d.toString(); });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
    }, timeoutMs);
    proc.on('close', code => {
      clearTimeout(timer);
      resolve({ code: timedOut ? -1 : code, output: [stdout, stderr].filter(Boolean).join('\n').trim(), timedOut });
    });
    proc.on('error', err => {
      clearTimeout(timer);
      resolve({ code: -1, output: err.message, timedOut: false });
    });
  });
}

async function runQualityGates(projectPath) {
  const results = [];
  const gitCheckPath = path.join(projectPath, 'gitCheck-docker.sh');
  if (fs.existsSync(gitCheckPath)) {
    log('  Running gitCheck-docker.sh');
    const r = await spawnPromise('bash gitCheck-docker.sh', { cwd: projectPath }, QUALITY_GATE_TIMEOUT_MS);
    results.push({ gate: 'gitCheck-docker.sh', passed: r.code === 0, output: r.output.slice(0, 2000) });
    log(`  gitCheck-docker.sh: ${r.code === 0 ? 'PASSED' : 'FAILED'}`);
  }
  return results;
}

// ─── Build instruction ────────────────────────────────────────────────────────

function buildInstruction(task) {
  const parts = [task.title.trim()];

  if (task.description && task.description.trim()) {
    parts.push('', task.description.trim());
  }

  const technicalContext = [];
  if (task.technicalAgent) technicalContext.push(`Agent technique responsable: ${task.technicalAgent}`);
  if (task.coderAgent) technicalContext.push(`Agent codeur: ${task.coderAgent}`);
  if (task.priority) technicalContext.push(`Priorité: ${task.priority}`);
  if (task.engine) technicalContext.push(`Engine demandé: ${task.engine}`);
  if (task.model) technicalContext.push(`Modèle demandé: ${task.model}`);
  if (technicalContext.length) {
    parts.push('', 'Contexte workflow:', ...technicalContext);
  }

  const loopEnabled = Boolean(task.optimizationLoop || task?.metadata?.optimizationLoop || task?.metadata?.optimization_loop || task?.metadata?.requiresOptimizationLoop);
  const loopCount = Number.isInteger(task.optimizationLoopCount) ? task.optimizationLoopCount : 0;
  const maxLoops = Number.isInteger(task.optimizationMaxLoops) && task.optimizationMaxLoops > 0 ? task.optimizationMaxLoops : 2;
  if (loopEnabled) {
    const loopLines = [
      `Boucle d'optimisation active: passe ${loopCount + 1} (max ${maxLoops}).`,
      loopCount > 0
        ? 'Tu retravailles du code que tu as déjà produit. Repars de ton implémentation précédente, critique-la, simplifie-la, améliore la robustesse, les edge cases et le responsive/UX si pertinent, puis rends une version optimisée.'
        : 'Cette tâche autorise une ou plusieurs boucles d’optimisation si l’agent technique le juge nécessaire après review.',
    ];
    parts.push('', ...loopLines);
  }

  const initPrompt = typeof task.coderPrompt === 'string' ? task.coderPrompt.trim() : '';
  if (initPrompt) {
    parts.push('', "Prompt d'initialisation spécifique pour le codeur:", initPrompt);
  }

  parts.push('', 'Fin de tâche attendue: fais les changements, commit si nécessaire, puis rends un feedback final compact (1000 caractères max) contenant le commit SHA si tu en as créé un. La tâche repartira ensuite en review pour validation technique.');

  return parts.join('\n');
}

function buildCodexInstruction(projectPath, instruction) {
  const claudeMdPath = path.join(projectPath, 'CLAUDE.md');
  if (!fs.existsSync(claudeMdPath)) return instruction;

  return [
    'Before doing anything else, read `./CLAUDE.md` at the repository root. It is the single source of truth for project instructions, architecture context, and working rules.',
    'Follow `CLAUDE.md` throughout the task. If anything conflicts with later assumptions, `CLAUDE.md` wins.',
    '',
    instruction,
  ].join('\n');
}

// ─── Core task processing (claude stream-json / codex plain-text) ─────────────

function getEngineLabel(engine) {
  if (engine === 'codex') return 'Codex';
  if (engine === 'ollama') return 'Ollama local (via Codex)';
  return 'Claude Code';
}

function inferModelProvider(model) {
  if (!model || typeof model !== 'string') return null;
  const normalized = model.trim().toLowerCase();
  if (!normalized) return null;

  if (
    normalized.startsWith('claude-') ||
    ['sonnet', 'opus', 'haiku', 'sonnet-4-6', 'opus-4-6', 'haiku-3-5'].includes(normalized)
  ) {
    return 'claude';
  }

  if (
    normalized.startsWith('gpt-') ||
    normalized.includes('codex') ||
    /^o\d/.test(normalized) ||
    /^o[1-9]-/.test(normalized)
  ) {
    return 'codex';
  }

  if (
    normalized.includes(':') ||
    normalized.startsWith('qwen') ||
    normalized.startsWith('llama') ||
    normalized.startsWith('mistral') ||
    normalized.startsWith('mixtral') ||
    normalized.startsWith('gemma') ||
    normalized.startsWith('deepseek') ||
    normalized.startsWith('phi')
  ) {
    return 'ollama';
  }

  return null;
}

function isModelCompatibleWithEngine(model, engine) {
  const provider = inferModelProvider(model);
  return !provider || provider === engine;
}

function normalizeModelForEngine(model, engine) {
  if (!model || typeof model !== 'string') {
    return { model: null, source: 'default', reason: null };
  }

  const trimmed = model.trim();
  const normalized = trimmed.toLowerCase();

  if (engine === 'claude') {
    if (!isModelCompatibleWithEngine(trimmed, engine)) {
      return {
        model: DEFAULT_ENGINE_MODELS.claude,
        source: 'safe-default',
        reason: 'provider_mismatch',
      };
    }

    const canonical = CLAUDE_MODEL_ALIASES[normalized] || trimmed;
    return {
      model: canonical,
      source: canonical === trimmed ? 'configured' : 'normalized-alias',
      reason: canonical === trimmed ? null : 'alias_normalized',
    };
  }

  if (engine === 'codex') {
    if (!isModelCompatibleWithEngine(trimmed, engine)) {
      return {
        model: DEFAULT_ENGINE_MODELS.codex,
        source: 'safe-default',
        reason: 'provider_mismatch',
      };
    }

    const canonical = CODEX_MODEL_ALIASES[normalized] || null;
    if (canonical && SUPPORTED_CODEX_MODELS.has(canonical)) {
      return {
        model: canonical,
        source: canonical === trimmed ? 'configured' : 'normalized-alias',
        reason: canonical === trimmed ? null : 'alias_normalized',
      };
    }

    return {
      model: DEFAULT_ENGINE_MODELS.codex,
      source: 'safe-default',
      reason: 'unsupported_codex_model',
    };
  }

  if (engine === 'ollama') {
    if (!isModelCompatibleWithEngine(trimmed, engine)) {
      return {
        model: DEFAULT_ENGINE_MODELS.ollama,
        source: 'safe-default',
        reason: 'provider_mismatch',
      };
    }

    const canonical = OLLAMA_MODEL_ALIASES[normalized] || trimmed;
    return {
      model: canonical,
      source: canonical === trimmed ? 'configured' : 'normalized-alias',
      reason: canonical === trimmed ? null : 'alias_normalized',
    };
  }

  return { model: trimmed, source: 'configured', reason: null };
}

function normalizeFallbackModelForEngine(model, engine) {
  if (!model || typeof model !== 'string') {
    return { model: null, source: 'default', reason: null };
  }

  if (engine === 'codex' || engine === 'ollama') {
    return {
      model: null,
      source: 'omitted',
      reason: engine === 'codex' ? 'codex_cli_has_no_fallback_model' : 'ollama_via_codex_has_no_fallback_model',
    };
  }

  return normalizeModelForEngine(model, engine);
}

function resolveEngineConfig(project, task, requestedEngine, options = {}) {
  const allowReroute = options.allowReroute !== false;
  const rawModel = task.model || project.model || null;
  const rawFallbackModel = task.fallbackModel || project.fallbackModel || null;
  const modelProvider = inferModelProvider(rawModel);

  let engine = requestedEngine;
  let rerouted = false;
  let rerouteReason = null;

  if (allowReroute && modelProvider && modelProvider !== requestedEngine) {
    engine = modelProvider;
    rerouted = true;
    rerouteReason = `task model "${rawModel}" belongs to ${getEngineLabel(modelProvider)}`;
  }

  const normalizedModel = normalizeModelForEngine(rawModel, engine);
  const normalizedFallbackModel = normalizeFallbackModelForEngine(rawFallbackModel, engine);

  return {
    requestedEngine,
    allowReroute,
    engine,
    rerouted,
    rerouteReason,
    rawModel,
    rawFallbackModel,
    model: normalizedModel.model,
    modelSource: normalizedModel.source,
    modelReason: normalizedModel.reason,
    fallbackModel: normalizedFallbackModel.model,
    fallbackModelSource: normalizedFallbackModel.source,
    fallbackModelReason: normalizedFallbackModel.reason,
  };
}

function detectErrorTypeFromText(text) {
  const value = String(text || '').toLowerCase();
  if (!value) return null;

  if (value.includes('rate limit') || value.includes('rate_limit') || value.includes('429')) return 'rate_limit';

  if (
    value.includes('invalid model') ||
    value.includes('unsupported model') ||
    value.includes('model_not_found') ||
    value.includes('unknown model')
  ) {
    return 'invalid_model';
  }

  if (
    value.includes('auth') ||
    value.includes('authentication') ||
    value.includes('unauthorized') ||
    value.includes('forbidden') ||
    value.includes('api key') ||
    value.includes('permission denied') ||
    value.includes('access denied') ||
    value.includes('401') ||
    value.includes('403')
  ) {
    return 'auth_issue';
  }

  return null;
}

function extractStructuredError(run) {
  const rateLimitEvent = Array.isArray(run.rateLimitEvents) && run.rateLimitEvents.length > 0
    ? run.rateLimitEvents[run.rateLimitEvents.length - 1]
    : null;
  const resultJson = run.resultJson || null;
  const payloads = [rateLimitEvent, resultJson];

  for (const payload of payloads) {
    if (!payload || typeof payload !== 'object') continue;

    const directType = detectErrorTypeFromText([
      payload.type,
      payload.subtype,
      payload.error?.type,
      payload.error?.message,
      payload.message,
      payload.result,
    ].filter(Boolean).join(' | '));

    if (directType) {
      return {
        type: directType,
        message: payload.error?.message || payload.message || payload.result || null,
        raw: payload,
      };
    }
  }

  const stderrType = detectErrorTypeFromText(run.stderrBuf);
  if (stderrType) {
    return {
      type: stderrType,
      message: run.stderrBuf.trim() || null,
      raw: { stderr: run.stderrBuf.trim() },
    };
  }

  if (resultJson && typeof resultJson === 'object' && (resultJson.subtype === 'error' || resultJson.error || run.exitCode !== 0)) {
    return {
      type: 'engine_error',
      message: resultJson.error?.message || resultJson.message || resultJson.result || null,
      raw: resultJson,
    };
  }

  return null;
}

function classifyRunOutcome(run) {
  if (run.stoppedManually) {
    return { status: 'manual_stop', type: 'manual_stop', structuredError: null };
  }

  const structuredError = extractStructuredError(run);
  const resultSubtype = run.resultJson?.subtype || null;
  const resultHasError = Boolean(run.resultJson?.error) || resultSubtype === 'error';

  if (run.exitCode === 0 && !resultHasError) {
    return { status: 'success', type: 'success', structuredError };
  }

  if (structuredError) {
    return { status: 'failed', type: structuredError.type, structuredError };
  }

  if (run.resultJson && !resultHasError) {
    return { status: 'success', type: 'success', structuredError: null };
  }

  return { status: 'failed', type: 'infra_error', structuredError: null };
}

function shouldAttemptEngineFallback(engine, classification, hasAlreadyRerouted) {
  if (!classification || classification.status !== 'failed') return false;
  if (hasAlreadyRerouted) return false;
  return engine === 'claude' && classification.type === 'rate_limit';
}

function clampText(text, maxChars = MAX_SUMMARY_CHARS) {
  const normalized = String(text || '').replace(/\r/g, '').trim();
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(0, Math.max(maxChars - 1, 0)).trimEnd() + '…';
}

function formatStructuredError(structuredError, options = {}) {
  if (!structuredError) return '';
  const label = structuredError.type.replace(/_/g, ' ');
  const message = structuredError.message ? clampText(structuredError.message, 160) : '';
  const base = message ? `${label}: ${message}` : label;
  return clampText(base, options.maxChars || 220);
}

function stripAnsi(text) {
  return String(text || '').replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
}

function normalizeOutputLines(text) {
  return stripAnsi(text)
    .split(/\r?\n/)
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function isLikelyNoiseLine(line) {
  return /^(\[[^\]]+\]\s*)?(INFO|DEBUG|TRACE|stdout|stderr)\b/i.test(line)
    || /^(thinking|commentary|analysis)\b[: ]/i.test(line)
    || /^```/.test(line)
    || /^(OpenAI Codex v|Claude Code v|Anthropic Claude|--------)/i.test(line)
    || /^(workdir|provider|model|approval|sandbox|cwd|directory|command|exit code|exit status|duration_ms|num_turns|total_cost_usd)\s*:/i.test(line)
    || /^(exec|apply_patch|file update|tokens used)\b/i.test(line)
    || /^(diff --git|index [0-9a-f]+\.\.[0-9a-f]+|@@ )/i.test(line)
    || /^[-+]{3}\s/.test(line);
}

function scoreSummaryLine(line) {
  let score = 0;
  if (line.length <= 220) score += 2;
  if (/[.!?]$/.test(line)) score += 1;
  if (/\b(created?|updated?|fixed?|implemented?|added?|removed?|renamed?|refactored?|tested?|passed?|failed?|error|warning|summary|résumé)\b/i.test(line)) score += 4;
  if (/^[-*•]\s+/.test(line)) score += 2;
  if (/[/\\][\w.-]+/.test(line)) score += 1;
  if (/[{}[\];]/.test(line)) score -= 2;
  if (line.length > 280) score -= 3;
  if (isLikelyNoiseLine(line)) score -= 4;
  return score;
}

function summarizeTextOutput(text, options = {}) {
  const fallback = options.fallback || '(No output)';
  const maxChars = options.maxChars || 650;
  const maxLines = options.maxLines || MAX_SUMMARY_LINES;
  const lines = normalizeOutputLines(text);
  if (!lines.length) return clampText(fallback, maxChars);

  const uniqueLines = [];
  const seen = new Set();
  for (const line of lines) {
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueLines.push(line);
  }

  const ranked = uniqueLines
    .map((line, index) => ({ line, index, score: scoreSummaryLine(line) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.index - b.index;
    });

  const preferred = ranked.filter(item => item.score > 0);
  const pool = preferred.length ? preferred : ranked;

  const selectedIndexes = pool
    .slice(0, maxLines)
    .map(item => item.index)
    .sort((a, b) => a - b);

  const selected = selectedIndexes.length
    ? selectedIndexes.map(index => uniqueLines[index])
    : uniqueLines.slice(-Math.min(maxLines, uniqueLines.length));

  let summary = selected.map(line => `- ${line}`).join('\n');
  const hiddenCount = Math.max(uniqueLines.length - selected.length, 0);
  if (hiddenCount > 0) {
    summary += `\n- ${hiddenCount} autre(s) ligne(s) masquée(s)`;
  }

  return clampText(summary, maxChars);
}

function summarizeStderr(text, options = {}) {
  const lines = normalizeOutputLines(text);
  if (!lines.length) return '';
  let summary = lines.slice(0, 2).join(' | ');
  if (summary.length > MAX_STDERR_SUMMARY_CHARS) {
    summary = summary.slice(0, MAX_STDERR_SUMMARY_CHARS - 1).trimEnd() + '…';
  }
  if (lines.length > 2) {
    summary += ` | ${lines.length - 2} ligne(s) stderr masquée(s)`;
  }
  return clampText(summary, options.maxChars || MAX_STDERR_SUMMARY_CHARS);
}

function summarizeQualityGates(qualityResults) {
  if (!Array.isArray(qualityResults) || qualityResults.length === 0) return '';
  const items = qualityResults.map(result => {
    const status = result.passed ? 'PASS' : 'FAIL';
    if (!result.output) return `${result.gate} ${status}`;
    const compact = summarizeTextOutput(result.output, { fallback: '', maxChars: 110, maxLines: 2 })
      .replace(/^-\s*/gm, '')
      .replace(/\n+/g, ' | ')
      .trim();
    return compact ? `${result.gate} ${status}: ${compact}` : `${result.gate} ${status}`;
  });
  return clampText(`Checks: ${items.join(' ; ')}`, 220);
}

function buildTaskSummaryNote({ engineLabel, failed, classification, run, qualityResults }) {
  const parts = [];
  if (run.resultJson && !failed) {
    const r = run.resultJson;
    parts.push(`✅ ${engineLabel} terminé (${Math.round((r.duration_ms || 0) / 1000)}s, ${r.num_turns || 1} tour(s), $${r.total_cost_usd?.toFixed(4) || '?'})`);
  } else if (failed) {
    parts.push(`❌ ${engineLabel} échoué (${classification.type}, exit=${run.exitCode})`);
  } else {
    parts.push(`✅ ${engineLabel} terminé`);
  }

  parts.push(summarizeTextOutput(run.resultText, {
    fallback: failed ? 'Aucun résumé exploitable généré.' : 'Aucun résumé généré.',
    maxChars: failed ? 700 : 620,
  }));

  const qualitySummary = summarizeQualityGates(qualityResults);
  if (qualitySummary) {
    parts.push(qualitySummary);
  }

  return clampText(parts.filter(Boolean).join('\n\n'), MAX_SUMMARY_CHARS);
}

async function runEngine(project, task, engine, env, instruction, runState, options = {}) {
  const projectPath = project.path;
  const resolved = resolveEngineConfig(project, task, engine, options);
  const effectiveEngine = resolved.engine;
  const model = resolved.model;
  const fallbackModel = resolved.fallbackModel;

  if (resolved.rerouted) {
    log(`  Rerouting ${getEngineLabel(engine)} -> ${getEngineLabel(effectiveEngine)} because ${resolved.rerouteReason}`);
  }
  if (resolved.rawModel && resolved.modelSource !== 'configured') {
    const modelAction = `normalize_${effectiveEngine}_model_${resolved.modelReason || 'adjusted'}`;
    log(`  ${modelAction}: "${resolved.rawModel}" -> ${model || 'CLI default'}`);
  } else if (model) {
    log(`  Using model: ${model}`);
  }
  if (resolved.rawFallbackModel && resolved.fallbackModelSource !== 'configured') {
    const fallbackAction = `${fallbackModel ? 'normalize' : 'drop'}_${effectiveEngine}_fallback_model_${resolved.fallbackModelReason || 'adjusted'}`;
    log(`  ${fallbackAction}: "${resolved.rawFallbackModel}" -> ${fallbackModel || 'none'}`);
  } else if (fallbackModel) {
    log(`  Using fallback-model: ${fallbackModel}`);
  }

  log(`  Spawning ${effectiveEngine === 'codex' ? 'Codex CLI' : effectiveEngine === 'ollama' ? 'Codex CLI (Ollama local provider)' : 'Claude Code'} for task [${task.id}]`);

  let proc;
  if (effectiveEngine === 'codex' || effectiveEngine === 'ollama') {
    const codexInstruction = buildCodexInstruction(projectPath, instruction);
    const codexArgs = [
      'exec',
      codexInstruction,
      '--dangerously-bypass-approvals-and-sandbox',
    ];
    if (effectiveEngine === 'ollama') {
      codexArgs.push('--oss', '--local-provider', 'ollama');
    }
    if (model) codexArgs.push('--model', model);
    proc = spawn('codex', codexArgs, {
      cwd: projectPath,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } else {
    const claudeArgs = [
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'bypassPermissions',
    ];
    if (model) claudeArgs.push('--model', model);
    if (fallbackModel) claudeArgs.push('--fallback-model', fallbackModel);
    proc = spawn('claude', claudeArgs, {
      cwd: projectPath,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  let resultText = '';
  let resultJson = null;
  let exitCode = null;
  let stderrBuf = '';
  const rateLimitEvents = [];

  runState.proc = proc;
  runState.pid = proc.pid;
  runState.engine = effectiveEngine;
  runState.resultText = '';
  runState.currentQuestion = null;
  runState.questionStartTime = 0;
  runState.questionWarnEmitted = false;
  runState.pendingAnswer = null;
  runState.answerDeliveredAt = null;

  let resolveCompletion;
  const completionPromise = new Promise(res => { resolveCompletion = res; });

  if (effectiveEngine === 'codex' || effectiveEngine === 'ollama') {
    proc.stdout.on('data', chunk => {
      resultText += chunk.toString();
      runState.resultText = resultText;
    });

    proc.stderr.on('data', chunk => { stderrBuf += chunk.toString(); });

    proc.on('close', code => {
      exitCode = code;
      log(`  ${effectiveEngine === 'ollama' ? 'Codex/Ollama' : 'Codex'} process exited (code=${code}) for task [${task.id}]`);
      resolveCompletion();
    });

    proc.on('error', err => {
      logError(`${effectiveEngine === 'ollama' ? 'Codex/Ollama' : 'Codex'} process error for task [${task.id}]`, err);
      resolveCompletion();
    });
  } else {
    const userMsg = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: instruction },
    });
    log(`  Sending instruction (${instruction.length} chars)`);
    proc.stdin.write(userMsg + '\n');

    let stdoutBuf = '';

    proc.stdout.on('data', chunk => {
      stdoutBuf += chunk.toString();
      let newlineIdx;
      while ((newlineIdx = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, newlineIdx).trim();
        stdoutBuf = stdoutBuf.slice(newlineIdx + 1);
        if (!line) continue;

        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }

        switch (event.type) {
          case 'system':
            log(`  [stream] system init (session=${event.session_id}, model=${event.model})`);
            break;

          case 'assistant': {
            const msg = event.message;
            if (msg && msg.content) {
              for (const block of msg.content) {
                if (block.type === 'text') {
                  resultText += (resultText ? '\n' : '') + block.text;
                  runState.resultText = resultText;
                }
                if (block.type === 'tool_use' && block.name === 'AskUserQuestion') {
                  const question = block.input?.question || block.input?.text || JSON.stringify(block.input);
                  log(`  [stream] Question detected: "${question}"`);
                  runState.currentQuestion = {
                    taskId: task.id,
                    projectId: project.id,
                    question,
                    timestamp: new Date().toISOString(),
                    answered: false,
                    toolUseId: block.id,
                  };
                  runState.questionStartTime = Date.now();
                  runState.questionWarnEmitted = false;
                  addNotification(project.name, task.title, task.id, 'in_progress', 'in_progress', `❓ Question: ${question}`);
                  pollForAnswer(runState, proc, block.id);
                }
              }
            }
            break;
          }

          case 'result':
            resultJson = event;
            if (event.result) {
              resultText = event.result;
              runState.resultText = resultText;
            }
            log(`  [stream] Result received (${event.subtype}, ${event.duration_ms}ms, $${event.total_cost_usd?.toFixed(4) || '?'}) — closing stdin`);
            try { proc.stdin.end(); } catch {}
            setTimeout(() => { try { proc.kill('SIGTERM'); } catch {} }, 5000);
            break;

          case 'rate_limit_event':
            rateLimitEvents.push(event);
            break;

          default:
            log(`  [stream] Event: ${event.type}${event.subtype ? '/' + event.subtype : ''}`);
        }
      }
    });

    proc.stderr.on('data', chunk => { stderrBuf += chunk.toString(); });

    proc.on('close', code => {
      exitCode = code;
      log(`  Process exited (code=${code}) for task [${task.id}]`);
      resolveCompletion();
    });

    proc.on('error', err => {
      logError(`Process error for task [${task.id}]`, err);
      resolveCompletion();
    });
  }

  await completionPromise;

  const stoppedManually = Boolean(runState.stoppedManually);
  runState.currentQuestion = null;
  runState.pendingAnswer = null;
  runState.answerDeliveredAt = null;

  if (shuttingDown) {
    releaseRun(task.id);
    process.exit(0);
    return null;
  }

  log(`  Task finished (exitCode=${exitCode})`);

  return {
    requestedEngine: engine,
    engine: effectiveEngine,
    rerouted: resolved.rerouted,
    rerouteReason: resolved.rerouteReason,
    modelUsed: model,
    fallbackModelUsed: fallbackModel,
    exitCode,
    resultText,
    resultJson,
    stderrBuf,
    rateLimitEvents,
    stoppedManually,
  };
}

async function processTask(project, task, runState) {
  const projectPath = project.path;

  log(`Processing task [${task.id}] "${task.title}" in "${project.name}"`);

  updateTask(projectPath, task.id, t => {
    t.status = 'in_progress';
    t.error = false;
    t.startedAt = now();
    t.lastWorkerRunAt = now();
    removeWorkerNotes(t);
  });
  addNotification(project.name, task.title, task.id, task.status, 'in_progress', '🔄 Début du traitement par le worker');

  const startHead = await getGitHeadInfo(projectPath);
  const instruction = buildInstruction(task);

  const env = {
    ...process.env,
    PATH: `${NVM_NODE_PATH}:${process.env.PATH}`,
    HOME: '/home/openclaw',
  };

  const engine = task.engine || project.engine || 'claude';
  let finalEngine = engine;

  try {
    let run = await runEngine(project, task, engine, env, instruction, runState);
    if (!run) return;
    finalEngine = run.engine;
    let classification = classifyRunOutcome(run);

    if (shouldAttemptEngineFallback(run.engine, classification, run.rerouted)) {
      const altEngine = run.engine === 'codex' ? 'claude' : 'codex';
      const engineLabel = getEngineLabel(run.engine);
      const altEngineLabel = getEngineLabel(altEngine);
      const reasonLabel = classification.type.replace(/_/g, ' ');
      const fallbackAction = `fallback_to_${altEngine}_due_to_${run.engine}_${classification.type}`;

      log(`  ${fallbackAction}`);
      addNotification(project.name, task.title, task.id, 'in_progress', 'in_progress', `⚠️ ${engineLabel} échoué (${reasonLabel}) — fallback sur ${altEngineLabel}`);

      run = await runEngine(project, task, altEngine, env, instruction, runState, { allowReroute: false });
      if (!run) return;
      finalEngine = run.engine;
      classification = classifyRunOutcome(run);
    } else if (classification.status === 'failed') {
      const skippedTarget = run.engine === 'codex' ? 'claude' : 'codex';
      const skipReason = run.rerouted ? 'already_rerouted' : classification.type;
      log(`  skip_${skippedTarget}_fallback_${skipReason}`);
    }

    const { exitCode, resultText, resultJson, stderrBuf, stoppedManually } = run;

    if (stoppedManually) {
      updateTask(projectPath, task.id, t => {
        setWorkerFinalNote(t, '⏹ Tâche stoppée manuellement.');
        t.status = 'review';
      });
      addNotification(project.name, task.title, task.id, 'in_progress', 'review', '⏹ Tâche stoppée manuellement');
      return;
    }

    const failed = classification.status === 'failed';

    let qualityResults = [];
    if (!failed) {
      try {
        qualityResults = await runQualityGates(projectPath);
      } catch (err) {
        logError('Quality gates error', err);
      }
    }

    const engineLabel = getEngineLabel(finalEngine);
    let summaryNote = buildTaskSummaryNote({
      engineLabel,
      failed,
      classification,
      run: { exitCode, resultText, resultJson, stderrBuf },
      qualityResults,
    });

    const endHead = await getGitHeadInfo(projectPath);
    const commitChanged = Boolean(endHead && (!startHead || startHead.hash !== endHead.hash));
    const commitHash = commitChanged ? endHead.hash : (extractCommitHash(resultText) || '');
    const commitMessage = endHead && commitHash && endHead.hash.startsWith(commitHash.slice(0, 7)) ? endHead.message : '';
    if (commitHash) {
      const commitLine = `Commit: ${commitHash.slice(0, 7)}${commitMessage ? ` — ${commitMessage}` : ''}`;
      summaryNote = clampText([summaryNote, commitLine].filter(Boolean).join('\n\n'), MAX_SUMMARY_CHARS);
    }

    updateTask(projectPath, task.id, t => {
      setWorkerFinalNote(t, summaryNote);
      setAuthorFinalNote(t, 'Coder', summaryNote);
      t.status = 'review';
      t.reviewRequestedAt = now();
      t.lastCoderSummary = summaryNote;
      t.lastCoderEngine = finalEngine;
      t.lastCoderModel = run.modelUsed || '';
      t.lastCoderCommit = commitHash || '';
      if (commitHash) t.commitSha = commitHash;
      if (t.optimizationLoop) {
        const currentCount = Number.isInteger(t.optimizationLoopCount) ? t.optimizationLoopCount : 0;
        t.optimizationLoopCount = currentCount + 1;
      }
      if (failed) t.error = true;
    });

    const notifMsg = failed
      ? '❌ Erreur pendant le traitement — en review'
      : '🔍 Traitement terminé — en attente de review';
    addNotification(project.name, task.title, task.id, 'in_progress', 'review', notifMsg);
    log(`Task [${task.id}] → review${failed ? ' (with error)' : ''}`);
  } finally {
    if (runState.projectLock) {
      releaseFileLock(runState.projectLock);
      runState.projectLock = null;
    }
    releaseRun(task.id);
    if (shuttingDown && getActiveRunCount() === 0) {
      process.exit(0);
    }
  }
}

// ─── Poll for answer to a question ────────────────────────────────────────────

function pollForAnswer(runState, proc, toolUseId) {
  const interval = setInterval(() => {
    const currentRun = activeRuns.get(runState.taskId);
    if (!currentRun || currentRun.proc !== proc) {
      clearInterval(interval);
      return;
    }

    if (!currentRun.questionWarnEmitted && currentRun.questionStartTime && Date.now() - currentRun.questionStartTime >= QUESTION_WARN_MS) {
      currentRun.questionWarnEmitted = true;
      addNotification(currentRun.projectName, currentRun.taskTitle, currentRun.taskId, 'in_progress', 'in_progress', '⏰ Question sans réponse depuis 30min');
    }

    if (!currentRun.pendingAnswer) return;

    const answer = currentRun.pendingAnswer;
    log(`  Answer received for task [${currentRun.taskId}]: "${answer}"`);

    const response = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: answer,
          },
        ],
      },
    });

    try {
      proc.stdin.write(response + '\n');
      log('  Answer sent to Claude Code');
      currentRun.answerDeliveredAt = Date.now();
      currentRun.pendingAnswer = null;
      if (currentRun.currentQuestion) {
        currentRun.currentQuestion = { ...currentRun.currentQuestion, answered: true };
      }
      currentRun.currentQuestion = null;
    } catch (err) {
      logError('Failed to write answer to stdin', err);
    }

    clearInterval(interval);
  }, QUESTION_POLL_MS);
}

// ─── Warning check ────────────────────────────────────────────────────────────

function checkRunningWarnings() {
  for (const runState of activeRuns.values()) {
    const elapsedMin = Math.floor((Date.now() - runState.startTime.getTime()) / 60_000);
    for (const threshold of WARNING_THRESHOLDS_MIN) {
      if (elapsedMin >= threshold && !runState.warned.has(threshold)) {
        runState.warned.add(threshold);
        const msg = `⚠️ Tâche en cours depuis ${elapsedMin} minutes`;
        log(`  ${msg} (task [${runState.taskId}])`);
        addNotification(runState.projectName, runState.taskTitle, runState.taskId, 'in_progress', 'in_progress', msg);
      }
    }
  }
}

// ─── Config loader ────────────────────────────────────────────────────────────

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    logError('Failed to read config.json', err);
    return { projects: [] };
  }
}

function getMaxConcurrency(config) {
  const envValue = Number.parseInt(process.env.TASK_WORKER_MAX_CONCURRENCY || '', 10);
  if (Number.isInteger(envValue) && envValue > 0) return envValue;

  const configValue = Number.parseInt(String(config?.worker?.maxConcurrency ?? ''), 10);
  if (Number.isInteger(configValue) && configValue > 0) return configValue;

  return DEFAULT_MAX_CONCURRENCY;
}

// ─── Poll loop ────────────────────────────────────────────────────────────────

const PRIORITY_ORDER = {
  critical: -1,
  high: 0,
  medium: 1,
  low: 2,
};

function getTaskPriorityRank(task) {
  return PRIORITY_ORDER[task.priority] ?? 99;
}

function getTaskCreatedTime(task) {
  const raw = task.createdAt || task.created;
  const ts = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(ts) ? ts : Number.MAX_SAFE_INTEGER;
}

function compareTaskOrder(a, b) {
  const pa = getTaskPriorityRank(a);
  const pb = getTaskPriorityRank(b);
  if (pa !== pb) return pa - pb;

  const ta = getTaskCreatedTime(a);
  const tb = getTaskCreatedTime(b);
  if (ta !== tb) return ta - tb;

  return String(a.id).localeCompare(String(b.id));
}

function getNextQueuedTask(project) {
  if (hasProjectActiveRun(project.id)) return null;

  const data = readTasks(project.path);
  const queued = data.tasks.filter(t => {
    if (t.status !== 'queued' && t.status !== 'pending') return false;
    return !activeRuns.has(t.id);
  });
  if (queued.length === 0) return null;

  queued.sort(compareTaskOrder);
  return queued[0];
}

async function pollOnce() {
  checkRunningWarnings();

  const config = loadConfig();
  const maxConcurrency = getMaxConcurrency(config);
  const availableSlots = Math.max(0, maxConcurrency - getActiveRunCount());
  if (availableSlots === 0) return;

  const scheduled = [];

  for (const project of config.projects) {
    if (shuttingDown || scheduled.length >= availableSlots) break;

    const task = getNextQueuedTask(project);
    if (!task) continue;

    const projectLock = acquireProjectExecutionLock(project, task);
    if (!projectLock || projectLock.acquired === false) {
      const holder = projectLock && projectLock.existing
        ? `held by pid=${projectLock.existing.pid} task=${projectLock.existing.taskId || '?'}`
        : `reason=${projectLock?.reason || 'unknown'}`;
      log(`Project "${project.name}": skipping task [${task.id}] because project execution lock is ${holder}`);
      continue;
    }

    log(`Project "${project.name}": scheduling task [${task.id}] "${task.title}"`);
    const runState = createReservedRun(project, task);
    runState.projectLock = projectLock;

    processTask(project, task, runState).catch(err => {
      logError(`Unexpected error in processTask [${task.id}]`, err);
      try {
        updateTask(project.path, task.id, t => {
          setWorkerFinalNote(t, `❌ Worker error inattendue: ${err.message || err}`);
          t.status = 'review';
          t.error = true;
        });
      } catch {}
      if (runState.projectLock) {
        releaseFileLock(runState.projectLock);
        runState.projectLock = null;
      }
      releaseRun(task.id);
    });

    scheduled.push(task.id);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const config = loadConfig();
  const instanceLock = acquireWorkerInstanceLock();
  if (!instanceLock || instanceLock.acquired === false) {
    const owner = instanceLock && instanceLock.existing
      ? `pid=${instanceLock.existing.pid}, acquiredAt=${instanceLock.existing.acquiredAt || 'unknown'}`
      : `reason=${instanceLock?.reason || 'unknown'}`;
    log(`Another task worker instance already owns the execution lock (${owner}) — exiting without polling`);
    process.exit(1);
    return;
  }

  log('Task worker started (multi-engine: claude stream-json / codex plain-text / ollama via codex)');
  log(`Poll interval: ${POLL_INTERVAL_MS / 1000}s | Quality gate timeout: ${QUALITY_GATE_TIMEOUT_MS / 60000}m`);
  log(`Max concurrency: ${getMaxConcurrency(config)}`);
  log(`Projects: ${config.projects.map(p => p.name).join(', ')}`);
  log(`HTTP server on port ${WORKER_PORT}`);

  try {
    await startHttpServer();
  } catch (err) {
    logError('Failed to start worker HTTP server; aborting worker startup', err);
    releaseWorkerInstanceLock();
    process.exit(1);
    return;
  }
  await pollOnce();

  while (!shuttingDown) {
    try {
      await pollOnce();
    } catch (err) {
      logError('Unexpected error in poll loop', err);
    }
    if (!shuttingDown) await sleep(POLL_INTERVAL_MS);
  }

  log('Task worker stopped gracefully');
  process.exit(0);
}

// ─── HTTP server (port 8091) ──────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode);
  res.end(JSON.stringify(payload));
}

function startHttpServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      res.setHeader('Content-Type', 'application/json');

      const requestUrl = new URL(req.url, `http://127.0.0.1:${WORKER_PORT}`);

      if (req.method === 'GET' && requestUrl.pathname === '/health') {
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'GET' && requestUrl.pathname === '/status') {
        const runs = getActiveRunsList();
        const legacy = getLegacyStatusFields(runs);
        return sendJson(res, 200, {
          running: runs.length > 0,
          count: runs.length,
          maxConcurrency: getMaxConcurrency(loadConfig()),
          tasks: runs.map(describeRun),
          ...legacy,
        });
      }

      if (req.method === 'POST' && requestUrl.pathname === '/stop') {
        const resolved = resolveTargetRun(Object.fromEntries(requestUrl.searchParams.entries()));
        if (resolved.error) {
          if (resolved.statusCode === 404 && getActiveRunCount() === 0) {
            return sendJson(res, 200, { ok: true, message: 'No task running' });
          }
          return sendJson(res, resolved.statusCode, { error: resolved.error });
        }
        if (!resolved.runState) {
          return sendJson(res, 200, { ok: true, message: 'No task running' });
        }
        log(`Manual stop requested for task [${resolved.runState.taskId}]`);
        resolved.runState.stoppedManually = true;
        try { resolved.runState.proc && resolved.runState.proc.kill('SIGTERM'); } catch {}
        return sendJson(res, 200, { ok: true, message: 'Stop signal sent', taskId: resolved.runState.taskId, projectId: resolved.runState.projectId });
      }

      if (req.method === 'GET' && requestUrl.pathname === '/question') {
        const resolved = resolveTargetRun(Object.fromEntries(requestUrl.searchParams.entries()));
        if (resolved.error) {
          return sendJson(res, resolved.statusCode, { error: resolved.error });
        }
        return sendJson(res, 200, { question: resolved.runState ? resolved.runState.currentQuestion : null });
      }

      if (req.method === 'POST' && requestUrl.pathname === '/answer') {
        const body = await readBody(req);
        if (!body.answer || typeof body.answer !== 'string') {
          return sendJson(res, 400, { error: 'Missing answer field' });
        }

        const targetQuery = {
          taskId: body.taskId || requestUrl.searchParams.get('taskId') || '',
          project: body.project || requestUrl.searchParams.get('project') || '',
        };
        const resolved = resolveTargetRun(targetQuery);
        if (resolved.error) {
          return sendJson(res, resolved.statusCode, { error: resolved.error });
        }
        if (!resolved.runState) {
          return sendJson(res, 400, { error: 'No active task' });
        }
        if (!resolved.runState.currentQuestion) {
          return sendJson(res, 400, { error: 'Active task is not waiting for a question response' });
        }

        resolved.runState.pendingAnswer = body.answer;
        return sendJson(res, 200, { ok: true, taskId: resolved.runState.taskId, projectId: resolved.runState.projectId });
      }

      if (req.method === 'GET' && requestUrl.pathname === '/output') {
        const resolved = resolveTargetRun(Object.fromEntries(requestUrl.searchParams.entries()));
        if (resolved.error) {
          return sendJson(res, resolved.statusCode, { error: resolved.error });
        }
        const output = resolved.runState ? resolved.runState.resultText || '' : '';
        return sendJson(res, 200, { output: output.slice(-2000), totalChars: output.length });
      }

      return sendJson(res, 404, { error: 'Not found' });
    });

    let settled = false;
    const handleStartupError = err => {
      if (settled) {
        logError('Worker HTTP server error', err);
        return;
      }
      settled = true;
      reject(err);
    };

    server.once('error', handleStartupError);
    server.listen(WORKER_PORT, '127.0.0.1', () => {
      settled = true;
      server.off('error', handleStartupError);
      server.on('error', err => { logError('Worker HTTP server error', err); });
      log(`Worker HTTP server listening on 127.0.0.1:${WORKER_PORT}`);
      resolve(server);
    });
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_ENGINE_MODELS,
  SUPPORTED_CODEX_MODELS,
  acquireFileLock,
  releaseFileLock,
  inferModelProvider,
  isModelCompatibleWithEngine,
  normalizeModelForEngine,
  normalizeFallbackModelForEngine,
  resolveEngineConfig,
  extractStructuredError,
  classifyRunOutcome,
  shouldAttemptEngineFallback,
  formatStructuredError,
  summarizeTextOutput,
  summarizeStderr,
  buildTaskSummaryNote,
  setWorkerFinalNote,
};
