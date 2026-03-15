'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const pty = require('node-pty');

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(__dirname, 'config.json');
const POLL_INTERVAL_MS = 30_000;
const QUALITY_GATE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_OUTPUT_CHARS = 5_000;
const NVM_SOURCE = 'source /home/openclaw/.nvm/nvm.sh';
const NVM_NODE_PATH = '/home/openclaw/.nvm/versions/node/v20.20.1/bin';
const WORKER_PORT = 8091;
const DASHBOARD_DIR = path.join(__dirname, '.dashboard');

// Warning thresholds in minutes (each emitted only once per task)
const WARNING_THRESHOLDS_MIN = [30, 60, 120];

// Silence-based detection timings
const SILENCE_CHECK_MS = 1_000;
const QUESTION_SILENCE_MS = 3_000;     // silence before checking for question/prompt
const COMPLETION_SILENCE_MS = 45_000;  // silence before assuming completion
const MIN_OUTPUT_FOR_COMPLETION = 200; // chars since instruction to consider "done"
const PTY_READY_TIMEOUT_MS = 60_000;   // max wait for initial prompt
const QUESTION_WARN_MS = 30 * 60 * 1000; // warn after 30 min of unanswered question

// ─── Logging ──────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function logError(msg, err) {
  console.error(`[${new Date().toISOString()}] ERROR ${msg}`, err ? (err.message || err) : '');
}

// ─── Active process tracking ──────────────────────────────────────────────────
//
// activeProcesses: Map<projectId, {
//   ptyProc:        IPty,
//   pid:            number,
//   startTime:      Date,
//   taskId:         string,
//   projectId:      string,
//   projectPath:    string,
//   projectName:    string,
//   taskTitle:      string,
//   warned:         Set<number>,
//   stoppedManually: boolean,
//   getOutput:      () => string,
//   getCurrentQuestion: () => object|null,
// }>

const activeProcesses = new Map();

// ─── Graceful shutdown ────────────────────────────────────────────────────────

let shuttingDown = false;

function killAllActive(signal) {
  log(`${signal} received — shutting down`);
  shuttingDown = true;
  if (activeProcesses.size === 0) return;
  log(`Sending kill to ${activeProcesses.size} active Claude Code PTY session(s)`);
  for (const [projectId, proc] of activeProcesses) {
    try { proc.ptyProc.kill(); } catch {}
    log(`  Killed PTY for project [${projectId}]`);
  }
}

process.on('SIGTERM', () => killAllActive('SIGTERM'));
process.on('SIGINT', () => killAllActive('SIGINT'));

// ─── ANSI / output helpers ────────────────────────────────────────────────────

function stripAnsi(str) {
  return str
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1B\].*?\x07/g, '')
    .replace(/\x1B[()][0-9A-Z]/g, '')
    .replace(/\r/g, '');
}

function getLastMeaningfulLine(str) {
  const lines = str.split('\n').map(l => l.trim()).filter(Boolean);
  return lines[lines.length - 1] || '';
}

function isPromptLine(line) {
  // Claude Code interactive prompt: ❯ or >
  return /^❯\s*$/.test(line) || /^>\s*$/.test(line) || /^❯\s/.test(line);
}

function isQuestionLine(line) {
  if (!line) return false;
  if (line.endsWith('?')) return true;
  if (/\[Y\/n\]|\[y\/N\]|\[y\/n\]/i.test(line)) return true;
  return false;
}

function truncateOutput(buf) {
  const stripped = stripAnsi(buf);
  if (stripped.length > MAX_OUTPUT_CHARS) {
    return stripped.slice(0, MAX_OUTPUT_CHARS) + `\n... [truncated, ${stripped.length} chars total]`;
  }
  return stripped;
}

function buildInstruction(task) {
  const parts = [task.title.trim()];
  if (task.description && task.description.trim()) {
    parts.push(task.description.trim());
  }
  // Flatten to a single line for PTY input (avoids premature submission on \n)
  return parts.join(' ').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
}

// ─── Pending question/answer helpers (per-project files) ─────────────────────

function ensureDashboardDir() {
  if (!fs.existsSync(DASHBOARD_DIR)) fs.mkdirSync(DASHBOARD_DIR, { recursive: true });
}

function pendingQuestionPath(projectId) {
  return path.join(DASHBOARD_DIR, `pending-question-${projectId}.json`);
}

function pendingAnswerPath(projectId) {
  return path.join(DASHBOARD_DIR, `pending-answer-${projectId}.json`);
}

function writePendingQuestion(projectId, data) {
  ensureDashboardDir();
  const filePath = pendingQuestionPath(projectId);
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function clearPendingQuestion(projectId) {
  try {
    const p = pendingQuestionPath(projectId);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {}
}

function readPendingAnswer(projectId, taskId) {
  const p = pendingAnswerPath(projectId);
  if (!fs.existsSync(p)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (data.taskId === taskId && data.answer) return data.answer;
  } catch {}
  return null;
}

function clearPendingAnswer(projectId) {
  try {
    const p = pendingAnswerPath(projectId);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {}
}

// ─── Notifications ────────────────────────────────────────────────────────────

const NOTIFICATIONS_PATH = path.join(DASHBOARD_DIR, 'notifications.json');

function addNotification(projectName, taskTitle, taskId, fromStatus, toStatus, message) {
  try {
    ensureDashboardDir();
    let data = { pending: [] };
    if (fs.existsSync(NOTIFICATIONS_PATH)) {
      try { data = JSON.parse(fs.readFileSync(NOTIFICATIONS_PATH, 'utf8')); } catch { data = { pending: [] }; }
    }
    if (!Array.isArray(data.pending)) data.pending = [];
    data.pending.push({ projectName, taskTitle, taskId, fromStatus, toStatus, message, timestamp: new Date().toISOString() });
    const tmp = `${NOTIFICATIONS_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, NOTIFICATIONS_PATH);
  } catch (err) {
    logError('Failed to write notification', err);
  }
}

// ─── Push webhook notifications ───────────────────────────────────────────────

function pushNotification(event, projectName, taskId, taskTitle, message) {
  const config = loadConfig();
  const webhookUrl = config.webhookUrl;
  if (!webhookUrl) return;

  const payload = JSON.stringify({
    event,
    projectName,
    taskId,
    taskTitle,
    message,
    timestamp: new Date().toISOString(),
  });

  function doPost(attempt) {
    try {
      const url = new URL(webhookUrl);
      const mod = url.protocol === 'https:' ? https : http;
      const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      };
      const req = mod.request(options, res => {
        res.resume(); // drain response body
        if (res.statusCode >= 200 && res.statusCode < 300) {
          log(`  Webhook OK: ${event} → ${projectName} (HTTP ${res.statusCode})`);
        } else if (attempt === 1) {
          log(`  Webhook failed (HTTP ${res.statusCode}) for event "${event}", retrying in 5s`);
          setTimeout(() => doPost(2), 5000);
        } else {
          log(`  Webhook retry failed (HTTP ${res.statusCode}) for event "${event}" — abandoning`);
        }
      });
      req.on('error', err => {
        if (attempt === 1) {
          log(`  Webhook error (${err.message}) for event "${event}", retrying in 5s`);
          setTimeout(() => doPost(2), 5000);
        } else {
          log(`  Webhook retry failed (${err.message}) for event "${event}" — abandoning`);
        }
      });
      req.write(payload);
      req.end();
    } catch (err) {
      logError(`pushNotification failed for event "${event}"`, err);
    }
  }

  doPost(1);
}

// ─── tasks.json helpers ───────────────────────────────────────────────────────

function getTasksPath(projectPath) {
  return path.join(projectPath, '.claude', 'tasks.json');
}

function readTasks(projectPath) {
  const p = getTasksPath(projectPath);
  if (!fs.existsSync(p)) return { tasks: [] };
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    logError(`Failed to parse tasks.json at ${p}`, err);
    return { tasks: [] };
  }
}

/** Atomic write: write to a tmp file then rename into place. */
function writeTasks(projectPath, data) {
  const p = getTasksPath(projectPath);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

function now() {
  return new Date().toISOString();
}

function addNote(task, author, text) {
  if (!Array.isArray(task.notes)) task.notes = [];
  task.notes.push({ author, text, timestamp: now() });
}

function updateTask(projectPath, taskId, mutate) {
  const data = readTasks(projectPath);
  const task = data.tasks.find(t => t.id === taskId);
  if (!task) {
    logError(`Task ${taskId} not found in ${projectPath}`);
    return;
  }
  mutate(task);
  task.updatedAt = now();
  writeTasks(projectPath, data);
}

// ─── Quality gates (one-shot --print, 10-min timeout) ─────────────────────────

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
      const output = [stdout, stderr].filter(Boolean).join('\n').trim();
      resolve({ code: timedOut ? -1 : code, output, timedOut });
    });

    proc.on('error', err => {
      clearTimeout(timer);
      resolve({ code: -1, output: err.message, timedOut: false });
    });
  });
}

async function runQualityGates(projectPath) {
  const results = [];

  const gitCheckPath = path.join(projectPath, 'gitCheck.sh');
  if (fs.existsSync(gitCheckPath)) {
    log('  Running gitCheck.sh');
    const r = await spawnPromise('bash gitCheck.sh', { cwd: projectPath }, QUALITY_GATE_TIMEOUT_MS);
    const passed = r.code === 0;
    results.push({ gate: 'gitCheck.sh', passed, output: r.output.slice(0, 2000) });
    log(`  gitCheck.sh: ${passed ? 'PASSED' : 'FAILED'} (exit ${r.code}${r.timedOut ? ', timed out' : ''})`);
  } else {
    const pkgPath = path.join(projectPath, 'package.json');
    if (fs.existsSync(pkgPath)) {
      let pkg = {};
      try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch { /* ignore */ }
      if (pkg.scripts && pkg.scripts.test) {
        log('  Running npm test');
        const r = await spawnPromise(
          `${NVM_SOURCE} && npm test`,
          { cwd: projectPath, env: { ...process.env, CI: 'true' } },
          QUALITY_GATE_TIMEOUT_MS,
        );
        const passed = r.code === 0;
        results.push({ gate: 'npm test', passed, output: r.output.slice(0, 2000) });
        log(`  npm test: ${passed ? 'PASSED' : 'FAILED'} (exit ${r.code}${r.timedOut ? ', timed out' : ''})`);
      }
    }
  }

  return results;
}

// ─── Warning check (per-process, called every silence tick) ──────────────────

function checkRunningWarnings(proc) {
  if (!proc) return;

  const elapsedMin = Math.floor((Date.now() - proc.startTime.getTime()) / 60_000);

  for (const threshold of WARNING_THRESHOLDS_MIN) {
    if (elapsedMin >= threshold && !proc.warned.has(threshold)) {
      proc.warned.add(threshold);
      const msg = `⚠️ Tâche en cours depuis ${elapsedMin} minutes`;
      log(`  ${msg} (task [${proc.taskId}])`);
      try {
        updateTask(proc.projectPath, proc.taskId, t => {
          addNote(t, 'Worker', msg);
        });
      } catch (err) {
        logError('Failed to write warning note', err);
      }
    }
  }
}

// ─── Core task processing (PTY interactive session) ───────────────────────────

async function processTask(project, task) {
  const projectId = project.id;
  const projectPath = project.path;

  log(`Processing task [${task.id}] "${task.title}" in "${project.name}"`);

  updateTask(projectPath, task.id, t => {
    t.status = 'in_progress';
    addNote(t, 'Worker', 'Début du traitement');
  });
  addNotification(project.name, task.title, task.id, 'queued', 'in_progress', '🔄 Début du traitement par le worker');
  pushNotification('task_started', project.name, task.id, task.title, '🔄 Début du traitement par le worker');

  const instruction = buildInstruction(task);

  const env = {
    ...process.env,
    PATH: `${NVM_NODE_PATH}:${process.env.PATH}`,
    HOME: '/home/openclaw',
    TERM: 'xterm-256color',
  };
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    env.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  }

  log(`  Spawning Claude Code PTY for task [${task.id}]`);

  let ptyProc;
  try {
    ptyProc = pty.spawn('claude', ['--permission-mode', 'bypassPermissions'], {
      name: 'xterm-256color',
      cols: 220,
      rows: 50,
      cwd: projectPath,
      env,
    });
  } catch (err) {
    logError(`Failed to spawn PTY for task [${task.id}]`, err);
    updateTask(projectPath, task.id, t => {
      addNote(t, 'Worker', `Erreur PTY spawn: ${err.message}`);
      t.status = 'review';
      t.error = true;
    });
    activeProcesses.delete(projectId);
    return;
  }

  // ── Session state ──
  let rawOutput = '';
  let lastOutputTime = Date.now();
  let stage = 'initializing'; // initializing | running | waiting_question | done
  let outputLengthAtInstructionSent = 0;
  let currentQuestion = null;
  let questionStartTime = 0;
  let questionWarnEmitted = false;
  let exitReason = 'unknown'; // 'complete' | 'manual' | 'error'
  let exitCode = null;

  let resolveCompletion;
  const completionPromise = new Promise(res => { resolveCompletion = res; });

  // Set activeProcesses entry synchronously (before first await) so poll loop sees it
  const procInfo = {
    ptyProc,
    pid: ptyProc.pid,
    startTime: new Date(),
    taskId: task.id,
    projectId,
    projectPath,
    projectName: project.name,
    taskTitle: task.title,
    warned: new Set(),
    stoppedManually: false,
    getOutput: () => rawOutput,
    getCurrentQuestion: () => currentQuestion,
  };
  activeProcesses.set(projectId, procInfo);

  // ── PTY data ──
  ptyProc.onData(chunk => {
    rawOutput += chunk;
    lastOutputTime = Date.now();
  });

  // ── PTY exit ──
  ptyProc.onExit(({ exitCode: code }) => {
    exitCode = code;
    log(`  PTY exited (code=${code}) for task [${task.id}]`);
    resolveCompletion();
  });

  // ── Silence monitor (state machine) ──
  const silenceInterval = setInterval(() => {
    if (stage === 'done') { clearInterval(silenceInterval); return; }

    const silence = Date.now() - lastOutputTime;
    const stripped = stripAnsi(rawOutput);
    const lastLine = getLastMeaningfulLine(stripped);

    // Per-tick warning check
    checkRunningWarnings(procInfo);

    switch (stage) {

      case 'initializing': {
        const elapsed = Date.now() - procInfo.startTime.getTime();
        const readyByPrompt = silence >= QUESTION_SILENCE_MS && isPromptLine(lastLine);
        const readyByTimeout = elapsed >= PTY_READY_TIMEOUT_MS;

        if (readyByPrompt || readyByTimeout) {
          if (readyByTimeout && !readyByPrompt) {
            log(`  PTY init timeout for task [${task.id}], sending instruction anyway`);
          } else {
            log(`  Claude Code ready (task [${task.id}]), sending instruction`);
          }
          stage = 'running';
          outputLengthAtInstructionSent = stripped.length;
          lastOutputTime = Date.now();
          try { ptyProc.write(instruction + '\r'); } catch {}
        }
        break;
      }

      case 'running': {
        if (silence < QUESTION_SILENCE_MS) break;

        const outputSince = stripped.length - outputLengthAtInstructionSent;

        if (isQuestionLine(lastLine) && outputSince > 20) {
          // Transition to waiting_question
          stage = 'waiting_question';
          questionStartTime = Date.now();
          questionWarnEmitted = false;
          currentQuestion = {
            taskId: task.id,
            projectId,
            question: lastLine,
            context: stripped.slice(-500),
            timestamp: new Date().toISOString(),
            answered: false,
          };
          log(`  Question detected for task [${task.id}]: "${lastLine}"`);
          writePendingQuestion(projectId, currentQuestion);
          updateTask(projectPath, task.id, t => {
            addNote(t, 'Worker', `🤔 Claude Code pose une question: ${lastLine}`);
          });
          addNotification(project.name, task.title, task.id, 'in_progress', 'in_progress',
            `❓ Question: ${lastLine}`);
          pushNotification('question_detected', project.name, task.id, task.title,
            `❓ Question: ${lastLine}`);
          break;
        }

        if (silence >= COMPLETION_SILENCE_MS && isPromptLine(lastLine) && outputSince >= MIN_OUTPUT_FOR_COMPLETION) {
          log(`  Completion detected for task [${task.id}] (${outputSince} chars of output)`);
          stage = 'done';
          exitReason = 'complete';
          clearInterval(silenceInterval);
          try { ptyProc.write('/exit\r'); } catch {}
          // Fallback kill after 15s in case /exit doesn't close the PTY
          setTimeout(() => {
            log(`  Fallback kill triggered (15s after /exit) for task [${task.id}]`);
            try { ptyProc.kill(); } catch {}
          }, 15000);
        }
        break;
      }

      case 'waiting_question': {
        // Emit 30-min warning once
        if (!questionWarnEmitted && Date.now() - questionStartTime >= QUESTION_WARN_MS) {
          questionWarnEmitted = true;
          log(`  Question unanswered for 30min (task [${task.id}])`);
          updateTask(projectPath, task.id, t => {
            addNote(t, 'Worker', '⏰ Question sans réponse depuis 30min');
          });
          pushNotification('question_timeout', project.name, task.id, task.title,
            `⏰ Question sans réponse depuis 30min: ${currentQuestion ? currentQuestion.question : ''}`);
        }

        // Poll for answer file
        const answer = readPendingAnswer(projectId, task.id);
        if (answer) {
          log(`  Answer received for task [${task.id}]: "${answer}"`);
          clearPendingAnswer(projectId);
          clearPendingQuestion(projectId);
          currentQuestion = null;
          stage = 'running';
          lastOutputTime = Date.now();
          try { ptyProc.write(answer + '\r'); } catch {}
        }
        break;
      }
    }
  }, SILENCE_CHECK_MS);

  // ── Await PTY exit ──
  await completionPromise;

  clearInterval(silenceInterval);
  clearPendingQuestion(projectId);
  clearPendingAnswer(projectId);

  activeProcesses.delete(projectId);

  if (shuttingDown) {
    process.exit(0);
    return;
  }

  const truncated = truncateOutput(rawOutput);
  log(`  PTY finished for task [${task.id}] (exitCode=${exitCode}, reason=${exitReason})`);

  if (procInfo.stoppedManually) {
    updateTask(projectPath, task.id, t => {
      addNote(t, 'Worker', `Stoppée manuellement\n${truncated}`);
      t.status = 'review';
    });
    addNotification(procInfo.projectName, procInfo.taskTitle, task.id, 'in_progress', 'review', '⏹ Tâche stoppée manuellement');
    pushNotification('task_failed', procInfo.projectName, task.id, procInfo.taskTitle, '⏹ Tâche stoppée manuellement');
    log(`Task [${task.id}] → review (stopped manually)`);
    return;
  }

  // exitCode === 0 or we detected completion normally
  const failed = exitReason !== 'complete' && exitCode !== 0;

  let qualityResults = [];
  if (!failed) {
    try {
      qualityResults = await runQualityGates(projectPath);
    } catch (err) {
      logError('Quality gates error', err);
    }
  }

  updateTask(projectPath, task.id, t => {
    const claudeNote = failed
      ? `Claude Code échoué (exit=${exitCode}):\n${truncated}`
      : `Claude Code terminé:\n${truncated}`;
    addNote(t, 'Worker', claudeNote);

    for (const qg of qualityResults) {
      addNote(t, 'Worker', `Quality gate "${qg.gate}": ${qg.passed ? 'PASSED' : 'FAILED'}\n${qg.output}`);
    }

    t.status = 'review';
    if (failed) t.error = true;
  });

  for (const qg of qualityResults) {
    const qgMsg = `Quality gate "${qg.gate}": ${qg.passed ? '✅ PASSED' : '❌ FAILED'}`;
    pushNotification('quality_gate_result', procInfo.projectName, task.id, procInfo.taskTitle, qgMsg);
  }

  const notifMsg = failed
    ? '❌ Erreur pendant le traitement — en review'
    : '🔍 Traitement terminé — en attente de review';
  addNotification(procInfo.projectName, procInfo.taskTitle, task.id, 'in_progress', 'review', notifMsg);
  pushNotification(
    failed ? 'task_failed' : 'task_completed',
    procInfo.projectName, task.id, procInfo.taskTitle, notifMsg,
  );
  log(`Task [${task.id}] "${task.title}" → review${failed ? ' (with error)' : ''}`);
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

// ─── Poll loop ────────────────────────────────────────────────────────────────

const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };

async function pollOnce() {
  const config = loadConfig();

  for (const project of config.projects) {
    if (shuttingDown) break;

    const projectId = project.id;

    // If already running for this project, just check warnings and skip
    if (activeProcesses.has(projectId)) {
      checkRunningWarnings(activeProcesses.get(projectId));
      continue;
    }

    const data = readTasks(project.path);
    const queued = data.tasks.filter(t => t.status === 'queued');
    if (queued.length === 0) continue;

    log(`Project "${project.name}": ${queued.length} queued task(s)`);

    queued.sort((a, b) => {
      const pa = PRIORITY_ORDER[a.priority] ?? 99;
      const pb = PRIORITY_ORDER[b.priority] ?? 99;
      if (pa !== pb) return pa - pb;
      return new Date(a.createdAt) - new Date(b.createdAt);
    });

    const task = queued[0];

    // Fire and forget — processTask manages its own lifecycle via activeProcesses
    processTask(project, task).catch(err => {
      logError(`Unexpected error in processTask [${task.id}]`, err);
      const proc = activeProcesses.get(projectId);
      if (proc && proc.taskId === task.id) {
        try {
          updateTask(project.path, task.id, t => {
            addNote(t, 'Worker', `Erreur inattendue: ${err.message || err}`);
            t.status = 'review';
            t.error = true;
          });
        } catch {}
        activeProcesses.delete(projectId);
      }
    });
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  log('Task worker started (PTY interactive mode, parallel per-project)');
  log(`Poll interval: ${POLL_INTERVAL_MS / 1000}s | Quality gate timeout: ${QUALITY_GATE_TIMEOUT_MS / 60000}m`);
  log(`Projects: ${loadConfig().projects.map(p => p.name).join(', ')}`);
  log(`HTTP server on port ${WORKER_PORT}`);

  startHttpServer();

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
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function startHttpServer() {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');

    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    const projectParam = url.searchParams.get('project'); // optional project filter

    // ── GET /health ──
    if (req.method === 'GET' && pathname === '/health') {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ── GET /status ──
    if (req.method === 'GET' && pathname === '/status') {
      if (activeProcesses.size === 0) {
        res.writeHead(200);
        res.end(JSON.stringify({ running: false, tasks: {}, count: 0 }));
        return;
      }
      const tasks = {};
      for (const [pid, proc] of activeProcesses) {
        const durationMin = Math.floor((Date.now() - proc.startTime.getTime()) / 60_000);
        tasks[pid] = {
          id: proc.taskId,
          title: proc.taskTitle,
          project: proc.projectName,
          projectId: proc.projectId,
          startedAt: proc.startTime.toISOString(),
          durationMin,
          pid: proc.pid,
          pendingQuestion: proc.getCurrentQuestion(),
        };
      }
      res.writeHead(200);
      res.end(JSON.stringify({ running: true, tasks, count: activeProcesses.size }));
      return;
    }

    // ── POST /stop ──
    if (req.method === 'POST' && pathname === '/stop') {
      if (activeProcesses.size === 0) {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, message: 'No task running' }));
        return;
      }

      if (projectParam) {
        // Stop specific project
        const proc = activeProcesses.get(projectParam);
        if (!proc) {
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true, message: `No task running for project "${projectParam}"` }));
          return;
        }
        log(`Manual stop requested for task [${proc.taskId}] (project: ${projectParam})`);
        proc.stoppedManually = true;
        try { proc.ptyProc.kill(); } catch {}
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, message: `Stop signal sent to "${projectParam}"` }));
      } else {
        // Stop all
        const stopped = [];
        for (const [pid, proc] of activeProcesses) {
          log(`Manual stop requested for task [${proc.taskId}] (project: ${pid})`);
          proc.stoppedManually = true;
          try { proc.ptyProc.kill(); } catch {}
          stopped.push(pid);
        }
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, message: `Stop signal sent to: ${stopped.join(', ')}` }));
      }
      return;
    }

    // ── GET /question ──
    if (req.method === 'GET' && pathname === '/question') {
      if (projectParam) {
        const proc = activeProcesses.get(projectParam);
        const question = proc ? proc.getCurrentQuestion() : null;
        res.writeHead(200);
        res.end(JSON.stringify({ question }));
      } else {
        // Return first question found across all projects
        let question = null;
        for (const proc of activeProcesses.values()) {
          const q = proc.getCurrentQuestion();
          if (q) { question = q; break; }
        }
        res.writeHead(200);
        res.end(JSON.stringify({ question }));
      }
      return;
    }

    // ── POST /answer ──
    if (req.method === 'POST' && pathname === '/answer') {
      let body;
      try { body = await readBody(req); } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid body' }));
        return;
      }

      if (!body.answer || typeof body.answer !== 'string') {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing answer field' }));
        return;
      }

      if (!body.projectId || typeof body.projectId !== 'string') {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing projectId field' }));
        return;
      }

      const proc = activeProcesses.get(body.projectId);
      if (!proc) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: `No active task for project "${body.projectId}"` }));
        return;
      }

      const answerData = {
        taskId: proc.taskId,
        answer: body.answer,
        timestamp: new Date().toISOString(),
      };
      try {
        ensureDashboardDir();
        const p = pendingAnswerPath(body.projectId);
        const tmp = `${p}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(answerData, null, 2), 'utf8');
        fs.renameSync(tmp, p);
        log(`Answer written for task [${proc.taskId}] (project: ${body.projectId}): "${body.answer}"`);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        logError('Failed to write answer file', err);
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Failed to write answer' }));
      }
      return;
    }

    // ── GET /output ──
    if (req.method === 'GET' && pathname === '/output') {
      if (projectParam) {
        const proc = activeProcesses.get(projectParam);
        const raw = proc ? proc.getOutput() : '';
        const stripped = stripAnsi(raw);
        const last2000 = stripped.slice(-2000);
        res.writeHead(200);
        res.end(JSON.stringify({ output: last2000, totalChars: stripped.length }));
      } else {
        // Return output for first active process
        const proc = activeProcesses.values().next().value;
        const raw = proc ? proc.getOutput() : '';
        const stripped = stripAnsi(raw);
        const last2000 = stripped.slice(-2000);
        res.writeHead(200);
        res.end(JSON.stringify({ output: last2000, totalChars: stripped.length }));
      }
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(WORKER_PORT, '127.0.0.1', () => {
    log(`Worker HTTP server listening on 127.0.0.1:${WORKER_PORT}`);
  });

  server.on('error', err => {
    logError('Worker HTTP server error', err);
  });
}

main();
