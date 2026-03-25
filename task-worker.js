'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(__dirname, 'config.json');
const POLL_INTERVAL_MS = 30_000;
const QUALITY_GATE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_OUTPUT_CHARS = 5_000;
const NVM_NODE_PATH = '/home/openclaw/.nvm/versions/node/v20.20.1/bin';
const NVM_SOURCE = 'source /home/openclaw/.nvm/nvm.sh';
const WORKER_PORT = 8091;
const DASHBOARD_DIR = path.join(__dirname, '.dashboard');
const PENDING_QUESTIONS_PATH = path.join(DASHBOARD_DIR, 'pending-questions.json');
const PENDING_ANSWERS_PATH = path.join(DASHBOARD_DIR, 'pending-answers.json');

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

process.on('SIGTERM', () => {
  log('SIGTERM received — shutting down');
  shuttingDown = true;
  if (currentProcess) {
    try { currentProcess.proc.kill('SIGTERM'); } catch {}
  }
});

process.on('SIGINT', () => {
  log('SIGINT received — shutting down');
  shuttingDown = true;
  if (currentProcess) {
    try { currentProcess.proc.kill('SIGTERM'); } catch {}
  }
});

// ─── Current process tracking ─────────────────────────────────────────────────

let currentProcess = null;

// ─── Pending question/answer helpers ──────────────────────────────────────────

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
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (Array.isArray(raw)) return { tasks: raw };
    if (raw && Array.isArray(raw.tasks)) return raw;
    return { tasks: [] };
  } catch (err) {
    logError(`Failed to parse tasks.json at ${p}`, err);
    return { tasks: [] };
  }
}

function writeTasks(projectPath, data) {
  const p = getTasksPath(projectPath);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const toWrite = Array.isArray(data) ? { tasks: data } : data;
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(toWrite, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

function now() { return new Date().toISOString(); }

function addNote(task, author, text) {
  if (!Array.isArray(task.notes)) task.notes = [];
  task.notes.push({ author, text, timestamp: now() });
}

function updateTask(projectPath, taskId, mutate) {
  const data = readTasks(projectPath);
  const task = data.tasks.find(t => t.id === taskId);
  if (!task) { logError(`Task ${taskId} not found in ${projectPath}`); return; }
  mutate(task);
  task.updatedAt = now();
  writeTasks(projectPath, data);
}

// ─── Quality gates ────────────────────────────────────────────────────────────

function spawnPromise(cmd, opts, timeoutMs) {
  return new Promise(resolve => {
    const proc = spawn(cmd, { ...opts, shell: '/bin/bash' });
    let stdout = '', stderr = '';
    proc.stdout && proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr && proc.stderr.on('data', d => { stderr += d.toString(); });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; proc.kill('SIGTERM'); }, timeoutMs);
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
  return engine === 'codex' ? 'Codex' : 'Claude Code';
}

async function runEngine(project, task, engine, env, instruction) {
  const projectPath = project.path;

  log(`  Spawning ${engine === 'codex' ? 'Codex CLI' : 'Claude Code'} for task [${task.id}]`);

  let proc;
  if (engine === 'codex') {
    const codexInstruction = buildCodexInstruction(projectPath, instruction);
    proc = spawn('codex', [
      'exec',
      codexInstruction,
      '--dangerously-bypass-approvals-and-sandbox',
    ], {
      cwd: projectPath,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } else {
    proc = spawn('claude', [
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'bypassPermissions',
    ], {
      cwd: projectPath,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  // ── State ──
  let resultText = '';
  let resultJson = null;
  let currentQuestion = null;
  let questionStartTime = 0;
  let questionWarnEmitted = false;
  let exitCode = null;
  let stderrBuf = '';
  let allEvents = []; // keep all events for debugging

  let resolveCompletion;
  const completionPromise = new Promise(res => { resolveCompletion = res; });

  currentProcess = {
    proc,
    pid: proc.pid,
    startTime: new Date(),
    taskId: task.id,
    projectId: project.id,
    projectPath,
    projectName: project.name,
    taskTitle: task.title,
    warned: new Set(),
    stoppedManually: false,
    engine,
    getOutput: () => resultText,
    getCurrentQuestion: () => currentQuestion,
  };

  if (engine === 'codex') {
    // ── Codex: plain text stdout ──
    proc.stdout.on('data', chunk => {
      resultText += chunk.toString();
    });

    proc.stderr.on('data', chunk => { stderrBuf += chunk.toString(); });

    proc.on('close', (code) => {
      exitCode = code;
      log(`  Codex process exited (code=${code}) for task [${task.id}]`);
      resolveCompletion();
    });

    proc.on('error', err => {
      logError(`Codex process error for task [${task.id}]`, err);
      resolveCompletion();
    });
  } else {
    // ── Claude Code: send instruction as first message ──
    const userMsg = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: instruction },
    });
    log(`  Sending instruction (${instruction.length} chars)`);
    proc.stdin.write(userMsg + '\n');

    // ── Parse NDJSON from stdout ──
    let stdoutBuf = '';

    proc.stdout.on('data', chunk => {
      stdoutBuf += chunk.toString();
      // Process complete lines
      let newlineIdx;
      while ((newlineIdx = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, newlineIdx).trim();
        stdoutBuf = stdoutBuf.slice(newlineIdx + 1);
        if (!line) continue;

        let event;
        try { event = JSON.parse(line); } catch { continue; }
        allEvents.push(event);

        switch (event.type) {
          case 'system':
            log(`  [stream] system init (session=${event.session_id}, model=${event.model})`);
            break;

          case 'assistant': {
            // Claude's response — extract text content
            const msg = event.message;
            if (msg && msg.content) {
              for (const block of msg.content) {
                if (block.type === 'text') {
                  resultText += (resultText ? '\n' : '') + block.text;
                }
                // Detect if Claude is asking a question via tool use
                if (block.type === 'tool_use' && block.name === 'AskUserQuestion') {
                  const question = block.input?.question || block.input?.text || JSON.stringify(block.input);
                  log(`  [stream] Question detected: "${question}"`);
                  currentQuestion = {
                    taskId: task.id,
                    projectId: project.id,
                    question,
                    timestamp: new Date().toISOString(),
                    answered: false,
                    toolUseId: block.id,
                  };
                  questionStartTime = Date.now();
                  questionWarnEmitted = false;
                  writePendingQuestion(currentQuestion);
                  updateTask(projectPath, task.id, t => {
                    addNote(t, 'Worker', `🤔 Claude Code pose une question: ${question}`);
                  });
                  addNotification(project.name, task.title, task.id, 'in_progress', 'in_progress', `❓ Question: ${question}`);

                  // Start polling for answer
                  pollForAnswer(task.id, proc, currentQuestion.toolUseId);
                }
              }
            }
            break;
          }

          case 'result':
            // Final result — task complete
            resultJson = event;
            if (event.result) {
              resultText = event.result; // Use the clean result text
            }
            log(`  [stream] Result received (${event.subtype}, ${event.duration_ms}ms, $${event.total_cost_usd?.toFixed(4) || '?'}) — closing stdin`);
            // Close stdin so Claude Code process exits cleanly
            try { proc.stdin.end(); } catch(e) {}
            // Safety: force kill after 5s if process hasn't exited
            setTimeout(() => { try { proc.kill('SIGTERM'); } catch {} }, 5000);
            break;

          case 'rate_limit_event':
            // Ignore
            break;

          default:
            log(`  [stream] Event: ${event.type}${event.subtype ? '/' + event.subtype : ''}`);
        }
      }
    });

    proc.stderr.on('data', chunk => { stderrBuf += chunk.toString(); });

    proc.on('close', (code) => {
      exitCode = code;
      log(`  Process exited (code=${code}) for task [${task.id}]`);
      resolveCompletion();
    });

    proc.on('error', err => {
      logError(`Process error for task [${task.id}]`, err);
      resolveCompletion();
    });
  }

  // ── Wait for completion ──
  await completionPromise;

  clearPendingQuestion();
  clearPendingAnswer();

  const cp = currentProcess;
  currentProcess = null;

  if (shuttingDown) { process.exit(0); return; }

  log(`  Task finished (exitCode=${exitCode})`);

  return {
    exitCode,
    resultText,
    resultJson,
    stderrBuf,
    stoppedManually: Boolean(cp && cp.stoppedManually),
  };
}

async function processTask(project, task) {
  const projectPath = project.path;

  log(`Processing task [${task.id}] "${task.title}" in "${project.name}"`);

  updateTask(projectPath, task.id, t => {
    t.status = 'in_progress';
    addNote(t, 'Worker', 'Début du traitement');
  });
  addNotification(project.name, task.title, task.id, task.status, 'in_progress', '🔄 Début du traitement par le worker');

  const instruction = buildInstruction(task);

  const env = {
    ...process.env,
    PATH: `${NVM_NODE_PATH}:${process.env.PATH}`,
    HOME: '/home/openclaw',
  };

  const engine = task.engine || project.engine || 'claude';
  let run = await runEngine(project, task, engine, env, instruction);
  let finalEngine = engine;

  if (run.exitCode !== 0 && !run.stoppedManually) {
    const altEngine = engine === 'codex' ? 'claude' : 'codex';
    const engineLabel = getEngineLabel(engine);
    const altEngineLabel = getEngineLabel(altEngine);

    updateTask(projectPath, task.id, t => {
      addNote(t, 'Worker', `⚠️ ${engineLabel} échoué (exit=${run.exitCode}), fallback sur ${altEngineLabel}`);
    });

    run = await runEngine(project, task, altEngine, env, instruction);
    finalEngine = altEngine;
  }

  const { exitCode, resultText, resultJson, stderrBuf, stoppedManually } = run;

  if (stoppedManually) {
    updateTask(projectPath, task.id, t => {
      addNote(t, 'Worker', `Stoppée manuellement`);
      t.status = 'review';
    });
    addNotification(project.name, task.title, task.id, 'in_progress', 'review', '⏹ Tâche stoppée manuellement');
    return;
  }

  // Truncate result if needed
  let output = resultText || '(No output)';
  if (output.length > MAX_OUTPUT_CHARS) {
    output = `[${output.length} chars total, showing last ${MAX_OUTPUT_CHARS}]\n...` + output.slice(-MAX_OUTPUT_CHARS);
  }

  const failed = exitCode !== 0 && !resultJson;

  // Quality gates
  let qualityResults = [];
  if (!failed) {
    try { qualityResults = await runQualityGates(projectPath); } catch (err) { logError('Quality gates error', err); }
  }

  // Build summary note
  const engineLabel = getEngineLabel(finalEngine);
  let summaryNote = '';
  if (resultJson) {
    const r = resultJson;
    summaryNote += `✅ ${engineLabel} terminé (${Math.round((r.duration_ms || 0) / 1000)}s, ${r.num_turns || 1} tour(s), $${r.total_cost_usd?.toFixed(4) || '?'})\n\n`;
  } else if (failed) {
    summaryNote += `❌ ${engineLabel} échoué (exit=${exitCode})\n\n`;
  } else {
    summaryNote += `${engineLabel} terminé:\n\n`;
  }
  summaryNote += output;
  if (stderrBuf.trim()) {
    summaryNote += `\n\nStderr: ${stderrBuf.trim().slice(0, 500)}`;
  }

  updateTask(projectPath, task.id, t => {
    addNote(t, 'Worker', summaryNote);
    for (const qg of qualityResults) {
      addNote(t, 'Worker', `Quality gate "${qg.gate}": ${qg.passed ? 'PASSED' : 'FAILED'}\n${qg.output}`);
    }
    t.status = 'review';
    if (failed) t.error = true;
  });

  const notifMsg = failed
    ? '❌ Erreur pendant le traitement — en review'
    : '🔍 Traitement terminé — en attente de review';
  addNotification(project.name, task.title, task.id, 'in_progress', 'review', notifMsg);
  log(`Task [${task.id}] → review${failed ? ' (with error)' : ''}`);

  if (shuttingDown) process.exit(0);
}

// ─── Poll for answer to a question ────────────────────────────────────────────

function pollForAnswer(taskId, proc, toolUseId) {
  const interval = setInterval(() => {
    // Check if process is still running
    if (!currentProcess || currentProcess.taskId !== taskId) {
      clearInterval(interval);
      return;
    }

    // 30-min warning
    if (!currentProcess.questionWarnEmitted && Date.now() - currentProcess.questionStartTime >= QUESTION_WARN_MS) {
      currentProcess.questionWarnEmitted = true;
      updateTask(currentProcess.projectPath, taskId, t => {
        addNote(t, 'Worker', '⏰ Question sans réponse depuis 30min');
      });
    }

    // Check for answer
    const answer = readPendingAnswer(taskId);
    if (answer) {
      log(`  Answer received for task [${taskId}]: "${answer}"`);
      clearPendingAnswer();
      clearPendingQuestion();

      // Send answer back to Claude Code via stdin as a tool_result
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
        log(`  Answer sent to Claude Code`);
      } catch (err) {
        logError('Failed to write answer to stdin', err);
      }

      currentProcess.getCurrentQuestion = () => null;
      clearInterval(interval);
    }
  }, QUESTION_POLL_MS);
}

// ─── Warning check ────────────────────────────────────────────────────────────

function checkRunningWarnings() {
  if (!currentProcess) return;
  const elapsedMin = Math.floor((Date.now() - currentProcess.startTime.getTime()) / 60_000);
  for (const threshold of WARNING_THRESHOLDS_MIN) {
    if (elapsedMin >= threshold && !currentProcess.warned.has(threshold)) {
      currentProcess.warned.add(threshold);
      const msg = `⚠️ Tâche en cours depuis ${elapsedMin} minutes`;
      log(`  ${msg} (task [${currentProcess.taskId}])`);
      try {
        updateTask(currentProcess.projectPath, currentProcess.taskId, t => { addNote(t, 'Worker', msg); });
      } catch (err) { logError('Failed to write warning note', err); }
    }
  }
}

// ─── Config loader ────────────────────────────────────────────────────────────

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch (err) { logError('Failed to read config.json', err); return { projects: [] }; }
}

// ─── Poll loop ────────────────────────────────────────────────────────────────

const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };

async function pollOnce() {
  if (currentProcess) { checkRunningWarnings(); return; }

  const config = loadConfig();

  for (const project of config.projects) {
    if (shuttingDown) break;

    const data = readTasks(project.path);
    const queued = data.tasks.filter(t => t.status === 'queued' || t.status === 'pending');
    if (queued.length === 0) continue;

    log(`Project "${project.name}": ${queued.length} queued task(s)`);

    queued.sort((a, b) => {
      const pa = PRIORITY_ORDER[a.priority] ?? 99;
      const pb = PRIORITY_ORDER[b.priority] ?? 99;
      if (pa !== pb) return pa - pb;
      return new Date(a.createdAt) - new Date(b.createdAt);
    });

    const task = queued[0];

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

    return;
  }
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function main() {
  log('Task worker started (multi-engine: claude stream-json / codex plain-text)');
  log(`Poll interval: ${POLL_INTERVAL_MS / 1000}s | Quality gate timeout: ${QUALITY_GATE_TIMEOUT_MS / 60000}m`);
  log(`Projects: ${loadConfig().projects.map(p => p.name).join(', ')}`);
  log(`HTTP server on port ${WORKER_PORT}`);

  startHttpServer();

  while (!shuttingDown) {
    try { await pollOnce(); } catch (err) { logError('Unexpected error in poll loop', err); }
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
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

function startHttpServer() {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true }));
    }

    if (req.method === 'GET' && req.url === '/status') {
      if (!currentProcess) {
        res.writeHead(200);
        return res.end(JSON.stringify({ running: false, task: null, pendingQuestion: null }));
      }
      const durationMin = Math.floor((Date.now() - currentProcess.startTime.getTime()) / 60_000);
      res.writeHead(200);
      return res.end(JSON.stringify({
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
    }

    if (req.method === 'POST' && req.url === '/stop') {
      if (!currentProcess) {
        res.writeHead(200);
        return res.end(JSON.stringify({ ok: true, message: 'No task running' }));
      }
      log(`Manual stop requested for task [${currentProcess.taskId}]`);
      currentProcess.stoppedManually = true;
      try { currentProcess.proc.kill('SIGTERM'); } catch {}
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, message: 'Stop signal sent' }));
    }

    if (req.method === 'GET' && req.url === '/question') {
      const question = currentProcess ? currentProcess.getCurrentQuestion() : null;
      res.writeHead(200);
      return res.end(JSON.stringify({ question }));
    }

    if (req.method === 'POST' && req.url === '/answer') {
      const body = await readBody(req);
      if (!body.answer || typeof body.answer !== 'string') {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: 'Missing answer field' }));
      }
      if (!currentProcess) {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: 'No active task' }));
      }
      const answerData = { taskId: currentProcess.taskId, answer: body.answer, timestamp: new Date().toISOString() };
      try {
        ensureDashboardDir();
        const tmp = `${PENDING_ANSWERS_PATH}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(answerData, null, 2), 'utf8');
        fs.renameSync(tmp, PENDING_ANSWERS_PATH);
        log(`Answer written for task [${currentProcess.taskId}]`);
        res.writeHead(200);
        return res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        logError('Failed to write answer', err);
        res.writeHead(500);
        return res.end(JSON.stringify({ error: 'Failed to write answer' }));
      }
    }

    if (req.method === 'GET' && req.url === '/output') {
      const output = currentProcess ? currentProcess.getOutput() : '';
      res.writeHead(200);
      return res.end(JSON.stringify({ output: output.slice(-2000), totalChars: output.length }));
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(WORKER_PORT, '127.0.0.1', () => {
    log(`Worker HTTP server listening on 127.0.0.1:${WORKER_PORT}`);
  });

  server.on('error', err => { logError('Worker HTTP server error', err); });
}

main();
