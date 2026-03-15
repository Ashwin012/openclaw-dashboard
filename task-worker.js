'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ─── Config ──────────────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(__dirname, 'config.json');
const POLL_INTERVAL_MS = 30_000;
const CLAUDE_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes
const MAX_OUTPUT_CHARS = 5_000;
const NVM_SOURCE = 'source /home/openclaw/.nvm/nvm.sh';

// ─── Logging ─────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function logError(msg, err) {
  console.error(`[${new Date().toISOString()}] ERROR ${msg}`, err ? (err.message || err) : '');
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

let shuttingDown = false;
let currentTaskId = null;

process.on('SIGTERM', () => {
  log('SIGTERM received — will exit after current task completes');
  shuttingDown = true;
});
process.on('SIGINT', () => {
  log('SIGINT received — will exit after current task completes');
  shuttingDown = true;
});

// ─── Tasks.json helpers ───────────────────────────────────────────────────────

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

/**
 * Atomic write: write to a temp file then rename into place.
 * This avoids partial reads by the dashboard.
 */
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
    logError(`Task ${taskId} not found in ${projectPath} — cannot update`);
    return;
  }
  mutate(task);
  task.updatedAt = now();
  writeTasks(projectPath, data);
}

// ─── Quality gates ────────────────────────────────────────────────────────────

function runQualityGates(projectPath) {
  const results = [];

  const gitCheckPath = path.join(projectPath, 'gitCheck.sh');
  if (fs.existsSync(gitCheckPath)) {
    log(`  Running gitCheck.sh in ${projectPath}`);
    const result = spawnSync('bash', ['gitCheck.sh'], {
      cwd: projectPath,
      timeout: 120_000,
      encoding: 'utf8',
    });
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    const passed = result.status === 0;
    results.push({
      gate: 'gitCheck.sh',
      passed,
      output: output.slice(0, 2000),
    });
    log(`  gitCheck.sh: ${passed ? 'PASSED' : 'FAILED'} (exit ${result.status})`);
  } else {
    const pkgPath = path.join(projectPath, 'package.json');
    if (fs.existsSync(pkgPath)) {
      let pkg;
      try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch { pkg = {}; }
      if (pkg.scripts && pkg.scripts.test) {
        log(`  Running npm test in ${projectPath}`);
        const result = spawnSync(`${NVM_SOURCE} && npm test`, {
          cwd: projectPath,
          shell: '/bin/bash',
          timeout: 120_000,
          encoding: 'utf8',
          env: { ...process.env, CI: 'true' },
        });
        const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
        const passed = result.status === 0;
        results.push({
          gate: 'npm test',
          passed,
          output: output.slice(0, 2000),
        });
        log(`  npm test: ${passed ? 'PASSED' : 'FAILED'} (exit ${result.status})`);
      }
    }
  }

  return results;
}

// ─── Core task processing ─────────────────────────────────────────────────────

function processTask(project, task) {
  const { path: projectPath } = project;
  currentTaskId = task.id;

  log(`Processing task [${task.id}] "${task.title}" in project "${project.name}"`);

  // Step 1: mark in_progress
  updateTask(projectPath, task.id, t => {
    t.status = 'in_progress';
    addNote(t, 'Worker', 'Début du traitement');
  });

  // Step 2: read CLAUDE.md context (optional)
  let claudeMd = '';
  const claudeMdPath = path.join(projectPath, 'CLAUDE.md');
  if (fs.existsSync(claudeMdPath)) {
    try {
      claudeMd = fs.readFileSync(claudeMdPath, 'utf8');
      log(`  Loaded CLAUDE.md (${claudeMd.length} chars)`);
    } catch (err) {
      logError('  Could not read CLAUDE.md', err);
    }
  }

  // Step 3: build Claude Code prompt
  const promptParts = [task.title];
  if (task.description && task.description.trim()) {
    promptParts.push('', task.description.trim());
  }
  const prompt = promptParts.join('\n');

  // Step 4: run Claude Code
  log(`  Running claude --print for task [${task.id}]`);
  const claudeCmd = [
    NVM_SOURCE,
    `claude -p ${shellQuote(prompt)} --print --permission-mode bypassPermissions`,
  ].join(' && ');

  let claudeOutput = '';
  let claudeError = null;
  let claudeExitCode = null;

  const claudeResult = spawnSync(claudeCmd, {
    cwd: projectPath,
    shell: '/bin/bash',
    timeout: CLAUDE_TIMEOUT_MS,
    encoding: 'utf8',
    env: {
      ...process.env,
      // Ensure the token is forwarded; it should already be in process.env
      // if the service was started from a shell that sourced .bashrc.
    },
    maxBuffer: 50 * 1024 * 1024, // 50 MB
  });

  claudeExitCode = claudeResult.status;
  claudeOutput = [claudeResult.stdout, claudeResult.stderr].filter(Boolean).join('\n').trim();

  if (claudeResult.error) {
    // spawnSync sets .error on timeout or exec failure
    claudeError = claudeResult.error;
    const isTimeout = claudeError.code === 'ETIMEDOUT';
    logError(`  Claude Code ${isTimeout ? 'timed out' : 'failed'}`, claudeError);
  } else {
    log(`  Claude Code finished (exit ${claudeExitCode})`);
  }

  const truncatedOutput = claudeOutput.length > MAX_OUTPUT_CHARS
    ? claudeOutput.slice(0, MAX_OUTPUT_CHARS) + `\n... [truncated, ${claudeOutput.length} chars total]`
    : claudeOutput;

  const failed = claudeError != null || claudeExitCode !== 0;

  // Step 5: quality gates (only if Claude Code didn't fail)
  let qualityResults = [];
  if (!failed) {
    try {
      qualityResults = runQualityGates(projectPath);
    } catch (err) {
      logError('  Quality gates threw an unexpected error', err);
    }
  }

  // Step 6: write final task state
  updateTask(projectPath, task.id, t => {
    // Claude Code output note
    const claudeNoteText = failed
      ? `Claude Code ${claudeError?.code === 'ETIMEDOUT' ? 'timed out after 20 minutes' : `failed (exit ${claudeExitCode})`}:\n${truncatedOutput}`
      : `Claude Code terminé (exit 0):\n${truncatedOutput}`;
    addNote(t, 'Worker', claudeNoteText);

    // Quality gate notes
    for (const qg of qualityResults) {
      addNote(t, 'Worker', `Quality gate "${qg.gate}": ${qg.passed ? 'PASSED' : 'FAILED'}\n${qg.output}`);
    }

    t.status = 'review';
    if (failed) {
      t.error = true;
    }
  });

  log(`Task [${task.id}] "${task.title}" → review${failed ? ' (with error)' : ''}`);
  currentTaskId = null;
}

// ─── Shell quoting ────────────────────────────────────────────────────────────

function shellQuote(str) {
  // Wrap in single quotes, escaping any existing single quotes.
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

// ─── Poll loop ────────────────────────────────────────────────────────────────

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    logError('Failed to read config.json', err);
    return { projects: [] };
  }
}

async function pollOnce() {
  const config = loadConfig();

  for (const project of config.projects) {
    if (shuttingDown) break;

    const data = readTasks(project.path);
    const queued = data.tasks.filter(t => t.status === 'queued');

    if (queued.length === 0) continue;

    log(`Project "${project.name}": ${queued.length} queued task(s) — processing first`);

    // Sort by priority then createdAt, process the first one
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    queued.sort((a, b) => {
      const pa = priorityOrder[a.priority] ?? 99;
      const pb = priorityOrder[b.priority] ?? 99;
      if (pa !== pb) return pa - pb;
      return new Date(a.createdAt) - new Date(b.createdAt);
    });

    const task = queued[0];

    try {
      processTask(project, task);
    } catch (err) {
      logError(`Unexpected error processing task [${task.id}]`, err);
      // Make sure we don't leave the task stuck in in_progress
      try {
        updateTask(project.path, task.id, t => {
          addNote(t, 'Worker', `Erreur inattendue: ${err.message || err}`);
          t.status = 'review';
          t.error = true;
        });
      } catch (innerErr) {
        logError('Failed to write error state for task', innerErr);
      }
      currentTaskId = null;
    }

    // Process only one task per poll cycle across all projects
    return;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  log('Task worker started');
  log(`Poll interval: ${POLL_INTERVAL_MS / 1000}s | Claude timeout: ${CLAUDE_TIMEOUT_MS / 60000}m`);
  log(`Projects: ${loadConfig().projects.map(p => p.name).join(', ')}`);

  while (!shuttingDown) {
    try {
      await pollOnce();
    } catch (err) {
      logError('Unexpected error in poll loop', err);
    }

    if (!shuttingDown) {
      await sleep(POLL_INTERVAL_MS);
    }
  }

  log('Task worker stopped gracefully');
  process.exit(0);
}

main();
