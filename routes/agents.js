module.exports = function createAgentRoutes({ config, requireAuth }) {
  const router = require('express').Router();
  const fs = require('fs');
  const path = require('path');
  const http = require('http');
  const { git } = require('../lib/git');

  const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

  function reloadConfig() {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  }

  function fetchWorkerSnapshot() {
    return new Promise((resolve) => {
      const req = http.get('http://127.0.0.1:8091/status', (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) return resolve(null);
          try {
            const parsed = JSON.parse(body);
            resolve(parsed && typeof parsed === 'object' ? parsed : null);
          } catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(750, () => { req.destroy(); resolve(null); });
    });
  }

  const NOTIFICATIONS_PATH = path.join(__dirname, '..', '.dashboard', 'notifications.json');
  const ACTIVITY_LOG_PATH = path.join(__dirname, '..', '.dashboard', 'activity-log.json');
  const TERMINAL_STATUSES = new Set(['review', 'done', 'approved', 'rejected', 'failed', 'validating']);
  const REVIEW_STATUSES = new Set(['review', 'validating']);

  function readNotifications() {
    let log = [];
    let logExists = false;
    try {
      const raw = JSON.parse(fs.readFileSync(ACTIVITY_LOG_PATH, 'utf8'));
      if (Array.isArray(raw)) { log = raw; logExists = true; }
    } catch {}
    let newEntries = 0;
    try {
      const data = JSON.parse(fs.readFileSync(NOTIFICATIONS_PATH, 'utf8'));
      if (Array.isArray(data.pending) && data.pending.length) {
        const logKeys = new Set(log.map(n => `${n.taskId}|${n.timestamp}`));
        for (const n of data.pending) {
          if (TERMINAL_STATUSES.has(n.toStatus) && !logKeys.has(`${n.taskId}|${n.timestamp}`)) {
            log.push(n);
            newEntries++;
          }
        }
      }
    } catch {}
    if (newEntries > 0 || !logExists) {
      const { writeJSON } = require('../lib/json-store');
      const byTaskId = {};
      const noTaskId = [];
      for (const n of log) {
        if (!n.taskId) { noTaskId.push(n); continue; }
        if (!byTaskId[n.taskId] || new Date(n.timestamp) > new Date(byTaskId[n.taskId].timestamp)) {
          byTaskId[n.taskId] = n;
        }
      }
      log = [...noTaskId, ...Object.values(byTaskId)];
      try { writeJSON(ACTIVITY_LOG_PATH, log); } catch {}
    }
    return log;
  }

  function readPendingInProgressMaps() {
    const inProgressTsMap = {};
    const inProgressNotifMap = {};
    try {
      const pendingData = JSON.parse(fs.readFileSync(NOTIFICATIONS_PATH, 'utf8'));
      for (const n of (pendingData.pending || [])) {
        if (n.toStatus === 'in_progress') {
          if (n.taskId) {
            const ts = new Date(n.timestamp).getTime();
            if (!inProgressTsMap[n.taskId] || ts > inProgressTsMap[n.taskId]) {
              inProgressTsMap[n.taskId] = ts;
            }
          }
          if (n.projectName) {
            const existing = inProgressNotifMap[n.projectName];
            if (!existing || new Date(n.timestamp) > new Date(existing.timestamp)) {
              inProgressNotifMap[n.projectName] = n;
            }
          }
        }
      }
    } catch {}
    return { inProgressTsMap, inProgressNotifMap };
  }

  // Build project status from worker snapshot, notifications, git log, and tasks.json
  function buildProjectStatus(project, workerSnapshot, notifications, inProgressTsMap, inProgressNotifMap, cfg) {
    const workerTasks = Array.isArray(workerSnapshot?.tasks) ? workerSnapshot.tasks : [];
    const activeTaskIds = new Set(workerTasks.map(t => t.id));

    // Find active worker task for this project
    const workerRun = workerTasks.find(t => t.projectId === project.id) || null;

    // Determine plan vs code status
    // Worker doesn't distinguish plan/code yet — active task goes under "code" by default
    let planStatus = 'idle';
    let codeStatus = 'idle';
    if (!workerSnapshot) {
      planStatus = 'down';
      codeStatus = 'down';
    } else if (workerRun) {
      codeStatus = 'active';
    }

    // Last activity from notifications
    let lastActivity = null;
    const projectName = project.name;
    if (notifications && notifications.length) {
      const matching = notifications.filter(n =>
        n.projectName === projectName && TERMINAL_STATUSES.has(n.toStatus) &&
        !activeTaskIds.has(n.taskId) &&
        !(inProgressTsMap && n.taskId && inProgressTsMap[n.taskId] !== undefined &&
          inProgressTsMap[n.taskId] > new Date(n.timestamp).getTime())
      );
      if (matching.length) {
        const sorted = [...matching].sort((a, b) =>
          new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
        );
        const latest = sorted[sorted.length - 1];
        lastActivity = {
          taskTitle: latest.taskTitle || null,
          taskId: latest.taskId || null,
          timestamp: latest.timestamp,
          status: latest.toStatus,
          message: latest.message || null,
        };
      }
    }

    // Fallback: last known in_progress
    let lastKnownActivity = null;
    if (!workerRun && !lastActivity) {
      const n = inProgressNotifMap[projectName];
      if (n) {
        lastKnownActivity = {
          taskTitle: n.taskTitle || null,
          taskId: n.taskId || null,
          timestamp: n.timestamp,
          status: 'in_progress',
        };
      }
    }

    // Pending review count from .claude/tasks.json
    let pendingReviewCount = 0;
    let projectLastTask = null;
    const allPaths = new Set();
    if (project.path) allPaths.add(project.path);
    for (const r of (project.repos || [])) {
      if (r.path) allPaths.add(r.path);
    }
    const TASK_DONE_STATUSES = new Set(['done', 'review', 'approved', 'rejected', 'failed', 'validating']);
    for (const p of allPaths) {
      try {
        const tasksPath = path.join(p, '.claude', 'tasks.json');
        const data = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
        const tasks = Array.isArray(data.tasks) ? data.tasks : [];
        const candidates = tasks.filter(t =>
          TASK_DONE_STATUSES.has(t.status) && (t.updatedAt || t.completedAt) && !activeTaskIds.has(t.id)
        );
        pendingReviewCount += candidates.filter(t => REVIEW_STATUSES.has(t.status)).length;
        if (candidates.length) {
          const latest = candidates.reduce((best, t) =>
            new Date(t.updatedAt || t.completedAt) > new Date(best.updatedAt || best.completedAt) ? t : best
          );
          if (!projectLastTask || new Date(latest.updatedAt || latest.completedAt) > new Date(projectLastTask.timestamp)) {
            projectLastTask = {
              taskTitle: latest.title || latest.id,
              taskId: latest.id,
              status: latest.status,
              timestamp: latest.updatedAt || latest.completedAt,
              lastCoderSummary: latest.lastCoderSummary || null,
              commitSha: latest.commitSha ? latest.commitSha.substring(0, 8) : (latest.lastCoderCommit ? latest.lastCoderCommit.substring(0, 8) : null),
            };
          }
        }
      } catch { /* ignore */ }
    }

    return {
      id: project.id,
      name: project.name,
      description: project.description || '',
      path: project.path,
      planStatus,
      codeStatus,
      lastActivity,
      lastKnownActivity,
      pendingReviewCount,
      projectLastTask,
      currentTask: workerRun ? {
        id: workerRun.id,
        title: workerRun.title,
        projectId: project.id,
        projectName: project.name,
        startedAt: workerRun.startedAt || null,
        durationMin: workerRun.durationMin || 0,
        pendingQuestion: workerRun.pendingQuestion || null,
        engine: workerRun.engine || null,
      } : null,
    };
  }

  // GET /api/agents — list Claude Code instances per project
  router.get('/api/agents', requireAuth, async (req, res) => {
    try {
      const cfg = reloadConfig();
      const projects = Array.isArray(cfg.projects) ? cfg.projects : [];
      const [workerSnapshot, notifications] = await Promise.all([
        fetchWorkerSnapshot(),
        Promise.resolve(readNotifications()),
      ]);
      const { inProgressTsMap, inProgressNotifMap } = readPendingInProgressMaps();

      const enriched = [];
      for (const p of projects) {
        try {
          enriched.push(buildProjectStatus(p, workerSnapshot, notifications, inProgressTsMap, inProgressNotifMap, cfg));
        } catch (projErr) {
          console.error(`[agents] buildProjectStatus failed for ${p.id}:`, projErr.message);
          enriched.push({
            id: p.id, name: p.name, description: p.description || '',
            path: p.path, planStatus: 'error', codeStatus: 'error',
            lastActivity: null, lastKnownActivity: null, pendingReviewCount: 0,
            projectLastTask: null, currentTask: null,
          });
        }
      }

      // Fetch git last commit per project path
      const pathsToFetch = new Set();
      for (const p of projects) {
        if (p.path) pathsToFetch.add(p.path);
        for (const r of (p.repos || [])) {
          if (r.path) pathsToFetch.add(r.path);
        }
      }
      const gitCommitMap = {};
      await Promise.allSettled(
        Array.from(pathsToFetch).map(async (p) => {
          try {
            const { stdout } = await git(
              ['log', '-1', '--pretty=format:%H\x1f%s\x1f%aI\x1f%an'], p
            );
            const parts = stdout.trim().split('\x1f');
            if (parts.length >= 3 && parts[0]) {
              gitCommitMap[p] = {
                hash: parts[0].substring(0, 8),
                message: parts[1] || '',
                timestamp: parts[2] || '',
                author: parts[3] || ''
              };
            }
          } catch { /* ignore */ }
        })
      );

      // Attach best git commit to each project
      for (const proj of enriched) {
        if (proj.currentTask) continue;
        const origProject = projects.find(p => p.id === proj.id);
        if (!origProject) continue;
        const projPaths = new Set();
        if (origProject.path) projPaths.add(origProject.path);
        for (const r of (origProject.repos || [])) {
          if (r.path) projPaths.add(r.path);
        }
        let best = null;
        for (const p of projPaths) {
          const c = gitCommitMap[p];
          if (!c) continue;
          if (!best || new Date(c.timestamp) > new Date(best.timestamp)) best = c;
        }
        if (best) proj.gitLastCommit = best;
      }

      // OpenClaw agents with linked project names
      const openclawAgents = Array.isArray(cfg.openclawAgents) ? cfg.openclawAgents.map(agent => {
        const linkedProjects = projects.filter(p =>
          Array.isArray(p.openclawAgentIds) && p.openclawAgentIds.includes(agent.id)
        );
        return {
          id: agent.id,
          name: agent.name,
          model: agent.model || null,
          thinking: agent.thinking || null,
          linkedProjects: linkedProjects.map(p => ({ id: p.id, name: p.name })),
        };
      }) : [];

      const workerStatus = workerSnapshot
        ? { running: workerSnapshot.running !== false, count: workerSnapshot.count || 0, maxConcurrency: workerSnapshot.maxConcurrency || null }
        : null;
      res.json({ projects: enriched, openclawAgents, workerStatus });
    } catch (err) {
      console.error('[agents] GET /api/agents error:', err.message, err.stack);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
