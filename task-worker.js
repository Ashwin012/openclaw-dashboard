'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(__dirname, 'config.json');
const POLL_INTERVAL_MS = 30_000;
const QUALITY_GATE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const MAX_OUTPUT_CHARS = 5_000;
const NVM_SOURCE = 'source /home/openclaw/.nvm/nvm.sh';
const WORKER_PORT = 8091;

// Warning thresholds in minutes (each emitted only once per task)
const WARNING_THRESHOLDS_MIN = [30, 60, 120];

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
    log('Sending SIGTERM to Claude Code process');
    currentProcess.proc.kill('SIGTERM');
  }
});

process.on('SIGINT', () => {
  log('SIGINT received — shutting down');
  shuttingDown = true;
  if (currentProcess) {
    log('Sending SIGTERM to Claude Code process');
    currentProcess.proc.kill('SIGTERM');
  }
});

// ─── Current process tracking ─────────────────────────────────────────────────
//
// currentProcess: null | {
//   proc:        ChildProcess,
//   pid:         number,
//   startTime:   Date,
//   taskId:      string,
//   projectId:   string,
//   projectPath: string,
//   projectName: string,
//   taskTitle:   string,
//   warned:      Set<number>,      // thresholds (minutes) already emitted
//   stoppedManually: boolean,
// }

let currentProcess = null;

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

// ─── Shell quoting ────────────────────────────────────────────────────────────

function shellQuote(str) {
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

// ─── Quality gates (async, 10-min timeout each) ───────────────────────────────

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

// ─── Core task processing ─────────────────────────────────────────────────────

function processTask(project, task) {
  const { path: projectPath } = project;

  log(`Processing task [${task.id}] "${task.title}" in "${project.name}"`);

  updateTask(projectPath, task.id, t => {
    t.status = 'in_progress';
    addNote(t, 'Worker', 'Début du traitement');
  });

  const promptParts = [task.title];
  if (task.description && task.description.trim()) {
    promptParts.push('', task.description.trim());
  }
  const prompt = promptParts.join('\n');

  const claudeCmd = `${NVM_SOURCE} && claude -p ${shellQuote(prompt)} --print --permission-mode bypassPermissions`;

  log(`  Spawning claude for task [${task.id}]`);
  const proc = spawn(claudeCmd, {
    cwd: projectPath,
    shell: '/bin/bash',
    env: { ...process.env },
  });

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
  };

  let outputBuffer = '';
  proc.stdout.on('data', chunk => { outputBuffer += chunk.toString(); });
  proc.stderr.on('data', chunk => { outputBuffer += chunk.toString(); });

  proc.on('error', err => {
    logError(`Claude Code process error for task [${task.id}]`, err);
  });

  proc.on('close', async (code, signal) => {
    const cp = currentProcess;
    currentProcess = null;

    const truncated = outputBuffer.length > MAX_OUTPUT_CHARS
      ? outputBuffer.slice(0, MAX_OUTPUT_CHARS) + `\n... [truncated, ${outputBuffer.length} chars total]`
      : outputBuffer;

    log(`  Claude Code closed (code=${code}, signal=${signal}) for task [${task.id}]`);

    if (cp.stoppedManually) {
      updateTask(projectPath, task.id, t => {
        addNote(t, 'Worker', `Stoppée manuellement\n${truncated}`);
        t.status = 'review';
      });
      log(`Task [${task.id}] → review (stopped manually)`);
      if (shuttingDown) process.exit(0);
      return;
    }

    const failed = code !== 0 || (signal != null);

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
        ? `Claude Code échoué (code=${code}, signal=${signal}):\n${truncated}`
        : `Claude Code terminé (exit 0):\n${truncated}`;
      addNote(t, 'Worker', claudeNote);

      for (const qg of qualityResults) {
        addNote(t, 'Worker', `Quality gate "${qg.gate}": ${qg.passed ? 'PASSED' : 'FAILED'}\n${qg.output}`);
      }

      t.status = 'review';
      if (failed) t.error = true;
    });

    log(`Task [${task.id}] "${task.title}" → review${failed ? ' (with error)' : ''}`);

    if (shuttingDown) process.exit(0);
  });
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

    try {
      processTask(project, task);
    } catch (err) {
      logError(`Unexpected error starting task [${task.id}]`, err);
      try {
        updateTask(project.path, task.id, t => {
          addNote(t, 'Worker', `Erreur inattendue: ${err.message || err}`);
          t.status = 'review';
          t.error = true;
        });
      } catch (innerErr) {
        logError('Failed to write error state', innerErr);
      }
      currentProcess = null;
    }

    // Only start one task per poll cycle
    return;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  log('Task worker started');
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

function startHttpServer() {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'GET' && req.url === '/status') {
      if (!currentProcess) {
        res.writeHead(200);
        res.end(JSON.stringify({ running: false, task: null }));
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
      }));
      return;
    }

    if (req.method === 'POST' && req.url === '/stop') {
      if (!currentProcess) {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, message: 'No task running' }));
        return;
      }
      log(`Manual stop requested for task [${currentProcess.taskId}]`);
      currentProcess.stoppedManually = true;
      currentProcess.proc.kill('SIGTERM');
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, message: 'Stop signal sent' }));
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
