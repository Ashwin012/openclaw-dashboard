'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
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
const PENDING_QUESTIONS_PATH = path.join(DASHBOARD_DIR, 'pending-questions.json');
const PENDING_ANSWERS_PATH = path.join(DASHBOARD_DIR, 'pending-answers.json');

// Warning thresholds in minutes (each emitted only once per task)
const WARNING_THRESHOLDS_MIN = [30, 60, 120];

// Silence-based detection timings
const SILENCE_CHECK_MS = 1_000;
const QUESTION_SILENCE_MS = 3_000;     // silence before checking for question/prompt
const COMPLETION_SILENCE_MS = 10_000;  // silence before assuming completion
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

// ─── Graceful shutdown ────────────────────────────────────────────────────────

let shuttingDown = false;

process.on('SIGTERM', () => {
  log('SIGTERM received — shutting down');
  shuttingDown = true;
  if (currentProcess) {
    log('Sending kill to Claude Code PTY');
    try { currentProcess.ptyProc.kill(); } catch {}
  }
});

process.on('SIGINT', () => {
  log('SIGINT received — shutting down');
  shuttingDown = true;
  if (currentProcess) {
    log('Sending kill to Claude Code PTY');
    try { currentProcess.ptyProc.kill(); } catch {}
  }
});

// ─── Current process tracking ─────────────────────────────────────────────────
//
// currentProcess: null | {
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
// }

let currentProcess = null;

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

// ─── Pending question/answer helpers ─────────────────────────────────────────

function ensureDashboardDir() {
  if (!fs.existsSync(DASHBOARD_DIR)) fs.mkdirSync(DASHBOARD_DIR, { recursive: true });
}

function writePendingQuestion(data) {
  ensureDashboardDir();
  const tmp = `${PENDING_QUESTIONS_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, PENDING_QUESTIONS_PATH);
}

function clearPendingQuestion() {
  try { if (fs.existsSync(PENDING_QUESTIONS_PATH)) fs.unlinkSync(PENDING_QUESTIONS_PATH); } catch {}
}

function readPendingAnswer(taskId) {
  if (!fs.existsSync(PENDING_ANSWERS_PATH)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(PENDING_ANSWERS_PATH, 'utf8'));
    if (data.taskId === taskId && data.answer) return data.answer;
  } catch {}
  return null;
}

function clearPendingAnswer() {
  try { if (fs.existsSync(PENDING_ANSWERS_PATH)) fs.unlinkSync(PENDING_ANSWERS_PATH); } catch {}
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

// ─── Core task processing (PTY interactive session) ───────────────────────────

async function processTask(project, task) {
  const projectPath = project.path;

  log(`Processing task [${task.id}] "${task.title}" in "${project.name}"`);

  updateTask(projectPath, task.id, t => {
    t.status = 'in_progress';
    addNote(t, 'Worker', 'Début du traitement');
  });
  addNotification(project.name, task.title, task.id, 'queued', 'in_progress', '🔄 Début du traitement par le worker');

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
    currentProcess = null;
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

  // Set currentProcess synchronously (before first await) so poll loop sees it
  currentProcess = {
    ptyProc,
    pid: ptyProc.pid,
    startTime: new Date(),
    taskId: task.id,
    projectId: project.id,
    projectPath,
    projectName: project.name,
    taskTitle: task.title,
    warned: new Set(),
    stoppedManually: false,
    getOutput: () => rawOutput,
    getCurrentQuestion: () => currentQuestion,
  };

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
    const cp = currentProcess;

    // Per-tick warning check
    if (cp) checkRunningWarnings();

    switch (stage) {

      case 'initializing': {
        const elapsed = Date.now() - (cp ? cp.startTime.getTime() : Date.now());
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
            projectId: project.id,
            question: lastLine,
            context: stripped.slice(-500),
            timestamp: new Date().toISOString(),
            answered: false,
          };
          log(`  Question detected for task [${task.id}]: "${lastLine}"`);
          writePendingQuestion(currentQuestion);
          updateTask(projectPath, task.id, t => {
            addNote(t, 'Worker', `🤔 Claude Code pose une question: ${lastLine}`);
          });
          addNotification(project.name, task.title, task.id, 'in_progress', 'in_progress',
            `❓ Question: ${lastLine}`);
          break;
        }

        if (silence >= COMPLETION_SILENCE_MS && isPromptLine(lastLine) && outputSince >= MIN_OUTPUT_FOR_COMPLETION) {
          log(`  Completion detected for task [${task.id}] (${outputSince} chars of output)`);
          stage = 'done';
          exitReason = 'complete';
          clearInterval(silenceInterval);
          try { ptyProc.write('/exit\r'); } catch {}
          // Fallback kill after 5s in case /exit doesn't close it
          setTimeout(() => { try { ptyProc.kill(); } catch {} }, 5000);
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
        }

        // Poll for answer file
        const answer = readPendingAnswer(task.id);
        if (answer) {
          log(`  Answer received for task [${task.id}]: "${answer}"`);
          clearPendingAnswer();
          clearPendingQuestion();
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
  clearPendingQuestion();
  clearPendingAnswer();

  const cp = currentProcess;
  currentProcess = null;

  if (shuttingDown) {
    process.exit(0);
    return;
  }

  const truncated = truncateOutput(rawOutput);
  log(`  PTY finished for task [${task.id}] (exitCode=${exitCode}, reason=${exitReason})`);

  if (cp && cp.stoppedManually) {
    updateTask(projectPath, task.id, t => {
      addNote(t, 'Worker', `Stoppée manuellement\n${truncated}`);
      t.status = 'review';
    });
    addNotification(cp.projectName, cp.taskTitle, task.id, 'in_progress', 'review', '⏹ Tâche stoppée manuellement');
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

  const notifMsg = failed
    ? '❌ Erreur pendant le traitement — en review'
    : '🔍 Traitement terminé — en attente de review';
  addNotification(
    cp ? cp.projectName : project.name,
    cp ? cp.taskTitle : task.title,
    task.id, 'in_progress', 'review', notifMsg,
  );
  log(`Task [${task.id}] "${task.title}" → review${failed ? ' (with error)' : ''}`);
}

// ─── Warning check (called every poll tick while Claude is running) ───────────

function checkRunningWarnings() {
  if (!currentProcess) return;

  const elapsedMin = Math.floor((Date.now() - currentProcess.startTime.getTime()) / 60_000);

  for (const threshold of WARNING_THRESHOLDS_MIN) {
    if (elapsedMin >= threshold && !currentProcess.warned.has(threshold)) {
      currentProcess.warned.add(threshold);
      const msg = `⚠️ Tâche en cours depuis ${elapsedMin} minutes`;
      log(`  ${msg} (task [${currentProcess.taskId}])`);
      try {
        updateTask(currentProcess.projectPath, currentProcess.taskId, t => {
          addNote(t, 'Worker', msg);
        });
      } catch (err) {
        logError('Failed to write warning note', err);
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

// ─── Poll loop ────────────────────────────────────────────────────────────────

const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };

async function pollOnce() {
  if (currentProcess) {
    checkRunningWarnings();
    return;
  }

  const config = loadConfig();

  for (const project of config.projects) {
    if (shuttingDown) break;

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

    // Fire and forget — processTask manages its own lifecycle via currentProcess
    processTask(project, task).catch(err => {
      logError(`Unexpected error in processTask [${task.id}]`, err);
      if (currentProcess && currentProcess.taskId === task.id) {
        try {
          updateTask(project.path, task.id, t => {
            addNote(t, 'Worker', `Erreur inattendue: ${err.message || err}`);
            t.status = 'review';
            t.error = true;
          });
        } catch {}
        currentProcess = null;
      }
    });

    // Only start one task per poll cycle
    return;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  log('Task worker started (PTY interactive mode)');
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

    // ── GET /health ──
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ── GET /status ──
    if (req.method === 'GET' && req.url === '/status') {
      if (!currentProcess) {
        res.writeHead(200);
        res.end(JSON.stringify({ running: false, task: null, pendingQuestion: null }));
        return;
      }
      const durationMin = Math.floor((Date.now() - currentProcess.startTime.getTime()) / 60_000);
      res.writeHead(200);
      res.end(JSON.stringify({
        running: true,
        task: {
          id: currentProcess.taskId,
          title: currentProcess.taskTitle,
          project: currentProcess.projectName,
          projectId: currentProcess.projectId,
          startedAt: currentProcess.startTime.toISOString(),
          durationMin,
          pid: currentProcess.pid,
        },
        pendingQuestion: currentProcess.getCurrentQuestion(),
      }));
      return;
    }

    // ── POST /stop ──
    if (req.method === 'POST' && req.url === '/stop') {
      if (!currentProcess) {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, message: 'No task running' }));
        return;
      }
      log(`Manual stop requested for task [${currentProcess.taskId}]`);
      currentProcess.stoppedManually = true;
      try { currentProcess.ptyProc.kill(); } catch {}
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, message: 'Stop signal sent' }));
      return;
    }

    // ── GET /question ──
    if (req.method === 'GET' && req.url === '/question') {
      const question = currentProcess ? currentProcess.getCurrentQuestion() : null;
      res.writeHead(200);
      res.end(JSON.stringify({ question }));
      return;
    }

    // ── POST /answer ──
    if (req.method === 'POST' && req.url === '/answer') {
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

      if (!currentProcess) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'No active task' }));
        return;
      }

      const answerData = {
        taskId: currentProcess.taskId,
        answer: body.answer,
        timestamp: new Date().toISOString(),
      };
      try {
        ensureDashboardDir();
        const tmp = `${PENDING_ANSWERS_PATH}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(answerData, null, 2), 'utf8');
        fs.renameSync(tmp, PENDING_ANSWERS_PATH);
        log(`Answer written for task [${currentProcess.taskId}]: "${body.answer}"`);
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
    if (req.method === 'GET' && req.url === '/output') {
      const raw = currentProcess ? currentProcess.getOutput() : '';
      const stripped = stripAnsi(raw);
      const last2000 = stripped.slice(-2000);
      res.writeHead(200);
      res.end(JSON.stringify({ output: last2000, totalChars: stripped.length }));
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
