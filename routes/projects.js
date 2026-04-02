const fs = require('fs');
const http = require('http');
const path = require('path');
const { git, validateBranchName, validateHash } = require('../lib/git');
const { readJSON, writeJSON } = require('../lib/json-store');

// ===== Helper functions =====

function resolveRepoPath(project, repoName) {
  if (!repoName || !project.repos) return project.path;
  const repo = project.repos.find(r => r.name === repoName);
  return repo ? repo.path : project.path;
}

async function getUnpushedCommits(project, branch) {
  try {
    const { stdout } = await git(
      ['log', 'origin/' + branch + '..HEAD', '--format=%H|%s|%an|%ai'],
      project.path
    );
    return stdout.trim().split('\n').filter(l => l.trim()).map(line => {
      const [hash, ...rest] = line.split('|');
      const date = rest.pop();
      const author = rest.pop();
      const message = rest.join('|');
      return { hash, message, author, date };
    });
  } catch {
    // No remote tracking branch — return all commits
    try {
      const { stdout } = await git(
        ['log', '--format=%H|%s|%an|%ai'],
        project.path
      );
      return stdout.trim().split('\n').filter(l => l.trim()).map(line => {
        const [hash, ...rest] = line.split('|');
        const date = rest.pop();
        const author = rest.pop();
        const message = rest.join('|');
        return { hash, message, author, date };
      });
    } catch { return []; }
  }
}

async function captureProjectState(project) {
  const { stdout: statusRaw } = await git(['status', '--porcelain'], project.path);
  const { stdout: diffRaw } = await git(['diff', 'HEAD'], project.path);
  const { stdout: diffUntracked } = await git(['ls-files', '--others', '--exclude-standard'], project.path);

  const statusLines = statusRaw.trim().split('\n').filter(l => l.trim());
  const files = statusLines.map(line => ({
    status: line.substring(0, 2).trim(),
    path: line.substring(3).trim()
  }));

  let fullDiff = diffRaw;
  const untrackedFiles = diffUntracked.trim().split('\n').filter(l => l.trim());
  for (const uf of untrackedFiles) {
    try {
      const content = fs.readFileSync(path.join(project.path, uf), 'utf8');
      const lines = content.split('\n');
      const diffLines = lines.map(l => `+${l}`).join('\n');
      fullDiff += `\ndiff --git a/${uf} b/${uf}\nnew file mode 100644\n--- /dev/null\n+++ b/${uf}\n@@ -0,0 +1,${lines.length} @@\n${diffLines}\n`;
    } catch (e) {
      // Binary or unreadable file, skip
    }
  }

  return { files, diff: fullDiff };
}

// ===== History helpers =====

function getHistoryPath(project) {
  return path.join(project.path, '.claude', 'history.json');
}

function readHistory(project) {
  return readJSON(getHistoryPath(project), []);
}

function appendHistory(project, entry) {
  const dir = path.join(project.path, '.claude');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const entries = readHistory(project);
  entries.unshift(entry);
  writeJSON(getHistoryPath(project), entries);
}

// ===== Task reader =====

function getTasksPath(project) {
  return path.join(project.path, '.claude', 'tasks.json');
}

function readTasks(project) {
  const data = readJSON(getTasksPath(project), null);
  if (!data) return [];
  return Array.isArray(data.tasks) ? data.tasks : [];
}

function getEngineLabel(engine) {
  if (engine === 'codex') return 'Codex';
  if (engine === 'ollama') return 'Ollama';
  return 'Claude';
}

function safeDateValue(value) {
  const time = Date.parse(value || '');
  return Number.isNaN(time) ? 0 : time;
}

function getTaskCounts(tasks) {
  const counts = {
    total: tasks.length,
    todo: 0,
    queued: 0,
    in_progress: 0,
    review: 0,
    blocked: 0,
    done: 0
  };

  for (const task of tasks) {
    const status = task && typeof task.status === 'string' ? task.status : 'todo';
    if (counts[status] !== undefined) counts[status] += 1;
  }

  return counts;
}

function pickPrimaryTask(tasks, workerRun) {
  if (workerRun) {
    const activeTask = tasks.find(task => task.id === workerRun.id);
    if (activeTask) return activeTask;
  }

  const priority = { in_progress: 0, review: 1, queued: 2, blocked: 3, todo: 4, done: 5 };
  return [...tasks]
    .sort((a, b) => {
      const statusDelta = (priority[a.status] ?? 99) - (priority[b.status] ?? 99);
      if (statusDelta !== 0) return statusDelta;
      return safeDateValue(b.updatedAt || b.createdAt) - safeDateValue(a.updatedAt || a.createdAt);
    })[0] || null;
}

function buildAgents(project, tasks, workerRun) {
  const activeTasks = tasks.filter(task => task.status !== 'done');
  const agents = new Map();

  function upsertAgent({ name, role, source, engine, model, task }) {
    const normalizedName = typeof name === 'string' ? name.trim() : '';
    if (!normalizedName) return;

    const normalizedEngine = (engine || project.engine || '').trim();
    const normalizedModel = typeof model === 'string' ? model.trim() : '';
    const key = [role, normalizedName.toLowerCase(), normalizedEngine, normalizedModel].join('|');
    const active = Boolean(workerRun && task && workerRun.id === task.id);

    if (!agents.has(key)) {
      agents.set(key, {
        key,
        name: normalizedName,
        role,
        roleLabel: role === 'technical' ? 'Technical' : role === 'coder' ? 'Coder' : 'Assignee',
        source,
        engine: normalizedEngine || null,
        engineLabel: normalizedEngine ? getEngineLabel(normalizedEngine) : null,
        model: normalizedModel || null,
        taskCount: 0,
        active,
        taskIds: [],
        statuses: [],
        updatedAt: task?.updatedAt || task?.createdAt || null
      });
    }

    const entry = agents.get(key);
    entry.taskCount += task ? 1 : 0;
    entry.active = entry.active || active;
    if (task?.id && !entry.taskIds.includes(task.id)) entry.taskIds.push(task.id);
    if (task?.status && !entry.statuses.includes(task.status)) entry.statuses.push(task.status);
    if (safeDateValue(task?.updatedAt || task?.createdAt) > safeDateValue(entry.updatedAt)) {
      entry.updatedAt = task.updatedAt || task.createdAt || entry.updatedAt;
    }
  }

  for (const task of activeTasks) {
    const taskEngine = task.engine || project.engine || '';
    upsertAgent({
      name: task.assignee || 'agent',
      role: 'assignee',
      source: 'task',
      engine: taskEngine,
      model: task.model || '',
      task
    });

    upsertAgent({
      name: task.technicalAgent,
      role: 'technical',
      source: 'task',
      engine: taskEngine,
      model: task.model || '',
      task
    });

    upsertAgent({
      name: task.coderAgent,
      role: 'coder',
      source: 'task',
      engine: taskEngine,
      model: task.model || '',
      task
    });
  }

  return Array.from(agents.values()).sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    if (b.taskCount !== a.taskCount) return b.taskCount - a.taskCount;
    return safeDateValue(b.updatedAt) - safeDateValue(a.updatedAt);
  });
}

function buildCurrentStatus({ accessible, branch, lastActivity, uncommittedCount, unpushedCount, tasks, workerRun }) {
  const counts = getTaskCounts(tasks);
  const primaryTask = pickPrimaryTask(tasks.filter(task => task.status !== 'done'), workerRun);

  const worker = workerRun ? {
    active: true,
    taskId: workerRun.id,
    title: workerRun.title,
    startedAt: workerRun.startedAt || null,
    durationMin: workerRun.durationMin ?? null,
    engine: workerRun.engine || null,
    pendingQuestion: workerRun.pendingQuestion || null
  } : {
    active: false,
    taskId: null,
    title: null,
    startedAt: null,
    durationMin: null,
    engine: null,
    pendingQuestion: null
  };

  let kind = 'clean';
  let label = 'Clean';
  let summary = 'Aucune action immédiate';

  if (!accessible) {
    kind = 'unavailable';
    label = 'Unavailable';
    summary = 'Repository inaccessible';
  } else if (worker.active && worker.pendingQuestion) {
    kind = 'waiting_input';
    label = 'Question';
    summary = `Réponse attendue sur "${worker.title}"`;
  } else if (worker.active) {
    kind = 'in_progress';
    label = 'In Progress';
    summary = `Worker actif sur "${worker.title}"`;
  } else if (counts.blocked > 0) {
    kind = 'blocked';
    label = 'Blocked';
    summary = `${counts.blocked} tâche${counts.blocked > 1 ? 's' : ''} bloquée${counts.blocked > 1 ? 's' : ''}`;
  } else if (counts.review > 0) {
    kind = 'review';
    label = 'Review';
    summary = `${counts.review} tâche${counts.review > 1 ? 's' : ''} en review`;
  } else if (counts.in_progress > 0) {
    kind = 'in_progress';
    label = 'In Progress';
    summary = `${counts.in_progress} tâche${counts.in_progress > 1 ? 's' : ''} en cours`;
  } else if (counts.queued > 0) {
    kind = 'queued';
    label = 'Queued';
    summary = `${counts.queued} tâche${counts.queued > 1 ? 's' : ''} en file`;
  } else if (uncommittedCount > 0) {
    kind = 'changes';
    label = 'Changes';
    summary = `${uncommittedCount} changement${uncommittedCount > 1 ? 's' : ''} non commités`;
  } else if (unpushedCount > 0) {
    kind = 'unpushed';
    label = 'Unpushed';
    summary = `${unpushedCount} commit${unpushedCount > 1 ? 's' : ''} à pousser`;
  } else if (counts.todo > 0) {
    kind = 'todo';
    label = 'Todo';
    summary = `${counts.todo} tâche${counts.todo > 1 ? 's' : ''} à lancer`;
  }

  return {
    kind,
    label,
    summary,
    accessible,
    counts,
    git: {
      branch: branch || null,
      lastActivity: lastActivity || null,
      uncommittedCount,
      unpushedCount
    },
    worker,
    primaryTask: primaryTask ? {
      id: primaryTask.id,
      title: primaryTask.title,
      status: primaryTask.status || 'todo',
      assignee: primaryTask.assignee || 'agent',
      engine: primaryTask.engine || null,
      model: primaryTask.model || null,
      updatedAt: primaryTask.updatedAt || primaryTask.createdAt || null
    } : null
  };
}

function enrichProject(project, projectState, workerSnapshot) {
  const tasks = readTasks(project);
  const workerRun = Array.isArray(workerSnapshot?.tasks)
    ? workerSnapshot.tasks.find(run => run.projectId === project.id) || null
    : null;
  const agents = buildAgents(project, tasks, workerRun);
  const currentStatus = buildCurrentStatus({
    accessible: projectState.accessible !== false,
    branch: projectState.branch,
    lastActivity: projectState.lastActivity || projectState.lastCommitDate || null,
    uncommittedCount: projectState.uncommittedCount || 0,
    unpushedCount: projectState.unpushedCount || 0,
    tasks,
    workerRun
  });

  return {
    ...projectState,
    taskCount: tasks.filter(task => task.status !== 'done').length,
    taskTotal: tasks.length,
    agents,
    currentStatus
  };
}

function fetchWorkerSnapshot() {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:8091/status', (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          resolve(null);
          return;
        }

        try {
          const parsed = JSON.parse(body);
          resolve(parsed && typeof parsed === 'object' ? parsed : null);
        } catch {
          resolve(null);
        }
      });
    });

    req.on('error', () => resolve(null));
    req.setTimeout(750, () => {
      req.destroy();
      resolve(null);
    });
  });
}

// ===== Route factory =====

module.exports = function createProjectRoutes({ config, requireAuth, requireAuthOrBearer }) {
  const router = require('express').Router();

  // GET /api/projects — list all with git status
  router.get('/api/projects', requireAuth, async (req, res) => {
    try {
      const workerSnapshot = await fetchWorkerSnapshot();
      const projects = await Promise.all(config.projects.map(async (p) => {
        try {
          const { stdout: branch } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], p.path);
          const { stdout: status } = await git(['status', '--porcelain'], p.path);
          const { stdout: lastLog } = await git(['log', '-1', '--format=%ci'], p.path);
          const changedFiles = status.trim().split('\n').filter(l => l.trim()).length;
          const branchName = branch.trim();
          const unpushed = await getUnpushedCommits(p, branchName);
          const unpushedHashes = new Set(unpushed.map(c => c.hash));

          // Parse uncommitted changes from git status --porcelain
          const uncommittedChanges = status.trim().split('\n').filter(l => l.trim()).map(line => {
            const xy = line.substring(0, 2);
            const file = line.substring(3).trim();
            let statusCode;
            if (xy === '??') statusCode = '?';
            else if (xy[0] !== ' ' && xy[0] !== '?') statusCode = xy[0];
            else statusCode = xy[1];
            return { file, status: statusCode };
          });

          // Get last 10 commits with source + push status
          let recentCommits = [];
          try {
            const { stdout: commitLog } = await git(
              ['log', '--format={"hash":"%H","shortHash":"%h","author":"%an","date":"%aI","message":"%s"}', '-10'],
              p.path
            );
            const history = readHistory(p);
            const approvedByMsg = {};
            for (const entry of history) {
              if (entry.action === 'approved' && entry.message) {
                approvedByMsg[entry.message] = entry;
              }
            }
            for (const line of commitLog.trim().split('\n').filter(l => l.trim())) {
              try {
                const commit = JSON.parse(line);
                recentCommits.push({
                  ...commit,
                  source: approvedByMsg[commit.message] ? 'agent' : 'external',
                  pushed: !unpushedHashes.has(commit.hash),
                  projectId: p.id,
                  projectName: p.name
                });
              } catch { /* skip malformed */ }
            }
          } catch { /* ignore */ }

          // Stats: commits in last 30 days
          let totalCommitsLast30 = 0;
          try {
            const { stdout: cntRaw } = await git(['log', '--since=30 days ago', '--format=%H'], p.path);
            totalCommitsLast30 = cntRaw.trim().split('\n').filter(l => l.trim()).length;
          } catch {}

          const stats = {
            totalCommits: totalCommitsLast30,
            unpushedCount: unpushed.length,
            uncommittedCount: uncommittedChanges.length,
            lastCommitDate: lastLog.trim()
          };

          return enrichProject(p, {
            ...p,
            branch: branchName,
            pendingChanges: changedFiles,
            unpushedCount: unpushed.length,
            uncommittedCount: uncommittedChanges.length,
            unpushedCommits: unpushed,
            uncommittedChanges,
            lastActivity: lastLog.trim(),
            recentCommits,
            stats,
            accessible: true
          }, workerSnapshot);
        } catch (err) {
          return enrichProject(p, {
            ...p,
            branch: 'unknown',
            pendingChanges: 0,
            unpushedCount: 0,
            uncommittedCount: 0,
            lastActivity: null,
            recentCommits: [],
            accessible: false,
            error: err.message
          }, workerSnapshot);
        }
      }));
      res.json(projects);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/projects/:id — detail with diff
  router.get('/api/projects/:id', requireAuth, async (req, res) => {
    const project = config.projects.find(p => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const MAX_FILE_DIFF = 50 * 1024;    // 50KB per file
    const MAX_TOTAL_DIFF = 512000;       // 500KB total
    const MAX_FILES = 100;
    const repoPath = resolveRepoPath(project, req.query.repo);

    try {
      const workerSnapshot = await fetchWorkerSnapshot();
      const { stdout: branch } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath);
      const branchName = branch.trim();
      const { stdout: statusRaw } = await git(['status', '--porcelain'], repoPath);
      const { stdout: diffRaw } = await git(
        ['diff', 'HEAD', '--', ':!vendor', ':!node_modules', ':!.next', ':!storage'],
        repoPath
      );
      const { stdout: diffUntracked } = await git(
        ['ls-files', '--others', '--exclude-standard'],
        repoPath
      );

      const statusLines = statusRaw.trim().split('\n').filter(l => l.trim());
      const allFiles = statusLines.map(line => {
        const statusCode = line.substring(0, 2).trim();
        const filePath = line.substring(3).trim();
        return { status: statusCode, path: filePath };
      });

      // Limit files to 100, add summary entry if truncated
      const files = allFiles.length > MAX_FILES
        ? [...allFiles.slice(0, MAX_FILES), { status: '...', path: `(${allFiles.length - MAX_FILES} more files not shown)` }]
        : allFiles;

      // Apply per-file 50KB limit to tracked file diffs
      const fileDiffParts = diffRaw.split(/(?=^diff --git )/m).filter(p => p);
      const processedParts = fileDiffParts.map(part => {
        if (Buffer.byteLength(part, 'utf8') > MAX_FILE_DIFF) {
          const headerLines = [];
          for (const line of part.split('\n')) {
            if (line.startsWith('@@')) break;
            headerLines.push(line);
          }
          return headerLines.join('\n') + '\n(file diff too large to display)\n';
        }
        return part;
      });
      let fullDiff = processedParts.join('');

      // Append untracked file diffs, respecting per-file limit
      const untrackedFiles = diffUntracked.trim().split('\n').filter(l => l.trim());
      for (const uf of untrackedFiles) {
        try {
          const content = fs.readFileSync(path.join(repoPath, uf), 'utf8');
          const lines = content.split('\n');
          const header = `\ndiff --git a/${uf} b/${uf}\nnew file mode 100644\n--- /dev/null\n+++ b/${uf}\n@@ -0,0 +1,${lines.length} @@\n`;
          const body = lines.map(l => `+${l}`).join('\n') + '\n';
          if (Buffer.byteLength(header + body, 'utf8') > MAX_FILE_DIFF) {
            fullDiff += header + '(file diff too large to display)\n';
          } else {
            fullDiff += header + body;
          }
        } catch (e) {
          // Binary or unreadable file, skip
        }
      }

      // Apply 500KB total diff limit
      if (Buffer.byteLength(fullDiff, 'utf8') > MAX_TOTAL_DIFF) {
        fullDiff = fullDiff.slice(0, MAX_TOTAL_DIFF) + '\n(diff truncated — too large)\n';
      }

      const { stdout: lastLog } = await git(['log', '-1', '--format=%ci|%s'], repoPath);
      const [lastDate, ...subjectParts] = lastLog.trim().split('|');
      const unpushed = await getUnpushedCommits({ ...project, path: repoPath }, branchName);

      res.json(enrichProject(project, {
        ...project,
        branch: branchName,
        files,
        diff: fullDiff,
        lastCommitDate: lastDate,
        lastCommitMessage: subjectParts.join('|'),
        activeRepo: req.query.repo || null,
        uncommittedCount: allFiles.length,
        pendingChanges: allFiles.length,
        unpushedCount: unpushed.length,
        lastActivity: lastDate || null,
        accessible: true
      }, workerSnapshot));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/projects/:id/unpushed
  router.get('/api/projects/:id/unpushed', requireAuth, async (req, res) => {
    const project = config.projects.find(p => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    try {
      const { stdout: branchRaw } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], project.path);
      const branch = branchRaw.trim();
      const commits = await getUnpushedCommits(project, branch);

      const commitsWithDiff = await Promise.all(commits.map(async (c) => {
        if (!validateHash(c.hash)) return { ...c, diff: '' };
        try {
          const { stdout: diff } = await git(['diff', c.hash + '~1', c.hash], project.path);
          return { ...c, diff };
        } catch {
          // First commit has no parent
          try {
            const { stdout: diff } = await git(['show', c.hash], project.path);
            return { ...c, diff };
          } catch { return { ...c, diff: '' }; }
        }
      }));

      res.json(commitsWithDiff);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/projects/:id/push
  router.post('/api/projects/:id/push', requireAuth, async (req, res) => {
    const project = config.projects.find(p => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    try {
      const { stdout: branchRaw } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], project.path);
      const branch = branchRaw.trim();
      if (!validateBranchName(branch)) {
        return res.status(400).json({ error: 'Invalid branch name' });
      }
      const { stdout, stderr } = await git(['push', 'origin', branch], project.path);
      res.json({ ok: true, output: stdout + stderr });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/projects/:id/pull
  router.post('/api/projects/:id/pull', requireAuth, async (req, res) => {
    const project = config.projects.find(p => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    try {
      const { stdout: branchRaw } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], project.path);
      const branch = branchRaw.trim();
      if (!validateBranchName(branch)) {
        return res.status(400).json({ error: 'Invalid branch name' });
      }
      const { stdout, stderr } = await git(['pull', 'origin', branch], project.path);
      res.json({ ok: true, output: (stdout + stderr).trim() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/projects/:id/branches
  router.get('/api/projects/:id/branches', requireAuth, async (req, res) => {
    const project = config.projects.find(p => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const repoPath = resolveRepoPath(project, req.query.repo);

    try {
      const { stdout: currentRaw } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath);
      const current = currentRaw.trim();

      const { stdout: branchesRaw } = await git(['branch', '-a'], repoPath);
      const seen = new Set();
      const branches = branchesRaw.split('\n')
        .map(b => b.replace(/^\*?\s+/, '').replace(/^remotes\/origin\//, '').trim())
        .filter(b => b && b !== 'HEAD' && !b.includes('->'))
        .filter(b => { if (seen.has(b)) return false; seen.add(b); return true; });

      res.json({ current, branches });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/projects/:id/checkout
  router.post('/api/projects/:id/checkout', requireAuth, async (req, res) => {
    const project = config.projects.find(p => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const repoPath = resolveRepoPath(project, req.query.repo);

    const { branch } = req.body;
    if (!branch) return res.status(400).json({ error: 'branch is required' });
    if (!validateBranchName(branch)) {
      return res.status(400).json({ error: 'Invalid branch name' });
    }

    try {
      const { stdout: statusRaw } = await git(['status', '--porcelain'], repoPath);
      const hasChanges = statusRaw.trim().length > 0;
      let stashPopResult = null;

      if (hasChanges) {
        await git(['stash'], repoPath);
      }

      await git(['checkout', branch], repoPath);

      if (hasChanges) {
        try {
          const { stdout, stderr } = await git(['stash', 'pop'], repoPath);
          stashPopResult = (stdout + stderr).trim();
        } catch (popErr) {
          stashPopResult = popErr.message;
        }
      }

      res.json({ ok: true, branch, stashed: hasChanges, stashPopResult });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/projects/:id/repos
  router.get('/api/projects/:id/repos', requireAuth, async (req, res) => {
    const project = config.projects.find(p => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const repos = project.repos || [{ name: 'main', path: project.path }];
    try {
      const result = await Promise.all(repos.map(async (repo) => {
        try {
          const { stdout } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], repo.path);
          return { ...repo, branch: stdout.trim() };
        } catch {
          return { ...repo, branch: 'unknown' };
        }
      }));
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/projects/:id/history
  router.get('/api/projects/:id/history', requireAuth, (req, res) => {
    const project = config.projects.find(p => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json(readHistory(project));
  });

  // GET /api/projects/:id/commits
  router.get('/api/projects/:id/commits', requireAuth, async (req, res) => {
    const project = config.projects.find(p => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    try {
      const { stdout } = await git(
        ['log', '--format={"hash":"%H","shortHash":"%h","author":"%an","email":"%ae","date":"%aI","message":"%s"}', '-50'],
        project.path
      );

      const lines = stdout.trim().split('\n').filter(l => l.trim());
      const commits = [];
      for (const line of lines) {
        try { commits.push(JSON.parse(line)); } catch { /* skip malformed */ }
      }

      const history = readHistory(project);
      const approvedByMsg = {};
      for (const entry of history) {
        if (entry.action === 'approved' && entry.message) {
          approvedByMsg[entry.message] = entry;
        }
      }

      const result = commits.map(commit => {
        const histEntry = approvedByMsg[commit.message];
        return {
          ...commit,
          source: histEntry ? 'agent' : 'external',
          instruction: histEntry ? (histEntry.instruction || null) : null
        };
      });

      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/projects/:id/approve
  router.post('/api/projects/:id/approve', requireAuth, async (req, res) => {
    const project = config.projects.find(p => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { message } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ error: 'Commit message required' });

    try {
      const { files, diff } = await captureProjectState(project);

      await git(['add', '-A'], project.path);
      const { stdout, stderr } = await git(['commit', '-m', message.trim()], project.path);

      appendHistory(project, {
        id: Date.now().toString(),
        timestamp: new Date().toISOString(),
        action: 'approved',
        message: message.trim(),
        files,
        diff,
        user: 'admin'
      });

      res.json({ ok: true, output: stdout + stderr });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/projects/:id/reject
  router.post('/api/projects/:id/reject', requireAuth, async (req, res) => {
    const project = config.projects.find(p => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    try {
      const { files } = await captureProjectState(project);

      await git(['restore', '.'], project.path);
      await git(['clean', '-fd'], project.path);

      appendHistory(project, {
        id: Date.now().toString(),
        timestamp: new Date().toISOString(),
        action: 'rejected',
        message: null,
        files,
        diff: null,
        user: 'admin'
      });

      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/projects/:id/instruct
  router.post('/api/projects/:id/instruct', requireAuth, async (req, res) => {
    const project = config.projects.find(p => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { instruction } = req.body;
    if (!instruction || !instruction.trim()) return res.status(400).json({ error: 'Instruction required' });

    try {
      const instructDir = path.join(project.path, '.claude');
      if (!fs.existsSync(instructDir)) fs.mkdirSync(instructDir, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = path.join(instructDir, `instruction-${timestamp}.md`);
      fs.writeFileSync(filename, `# Instruction\n\n${instruction}\n\n_Created: ${new Date().toISOString()}_\n`);

      appendHistory(project, {
        id: Date.now().toString(),
        timestamp: new Date().toISOString(),
        action: 'instructed',
        message: instruction.trim(),
        files: [],
        diff: null,
        user: 'admin'
      });

      res.json({ ok: true, file: filename });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /api/projects/:id/config
  router.put('/api/projects/:id/config', requireAuth, (req, res) => {
    const project = config.projects.find(p => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const allowed = ['testUrl', 'apiUrl', 'stagingUrl', 'prodUrl', 'prodApiUrl', 'githubUrl', 'description'];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        if (req.body[key] === '') {
          delete project[key];
        } else {
          project[key] = req.body[key];
        }
      }
    }

    try {
      writeJSON(path.join(__dirname, '..', 'config.json'), config);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });


  // PUT /api/projects/:id/engine
  router.put("/api/projects/:id/engine", requireAuth, (req, res) => {
    const { engine } = req.body;
    if (!["claude", "codex", "ollama"].includes(engine)) return res.status(400).json({ error: "Invalid engine" });
    const project = config.projects.find(p => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: "Project not found" });
    project.engine = engine;
    try {
      writeJSON(require("path").join(__dirname, "..", "config.json"), config);
      res.json({ ok: true, engine });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
