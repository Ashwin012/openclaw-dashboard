module.exports = function createAgentRoutes({ config, requireAuth }) {
  const router = require('express').Router();
  const fs = require('fs');
  const path = require('path');
  const http = require('http');
  const { writeJSON } = require('../lib/json-store');
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

  function inferEngine(model) {
    if (!model) return 'claude';
    const m = model.toLowerCase();
    if (m.startsWith('claude-')) return 'claude';        // Direct Anthropic API: claude-opus-4-6, etc.
    if (m.includes('/')) return 'openrouter';            // provider/model format → OpenRouter
    if (m.includes(':')) return 'ollama';                // model:tag = Ollama format (e.g. qwen:7b)
    // Bare local model family names without hyphens = Ollama (e.g. 'qwen', 'llama3', 'mistral')
    // Models with hyphens (e.g. 'qwen3.6-plus-free') are OpenRouter-hosted
    if (!m.includes('-') && (m.startsWith('qwen') || m.startsWith('llama') || m.startsWith('mistral') ||
        m.startsWith('gemma') || m.startsWith('phi') || m.startsWith('deepseek') ||
        m.startsWith('codestral') || m.startsWith('starcoder'))) return 'ollama';
    return 'openrouter';
  }

  const NOTIFICATIONS_PATH = path.join(__dirname, '..', '.dashboard', 'notifications.json');
  const ACTIVITY_LOG_PATH = path.join(__dirname, '..', '.dashboard', 'activity-log.json');
  // Must match TERMINAL_STATUSES used in enrichAgent for display filtering
  const TERMINAL_STATUSES = new Set(['review', 'done', 'approved', 'rejected', 'failed', 'validating']);

  function readNotifications() {
    // Read persistent activity log first (survives bell clears)
    let log = [];
    let logExists = false;
    try {
      const raw = JSON.parse(fs.readFileSync(ACTIVITY_LOG_PATH, 'utf8'));
      if (Array.isArray(raw)) { log = raw; logExists = true; }
    } catch {}
    // Merge any fresh pending terminal notifications not yet in log
    // Only terminal statuses go here — consistent with task-worker's addNotification()
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
    // Deduplicate: for entries with a taskId, keep only the most recent per taskId.
    // Entries without taskId are kept as-is. This prevents unbounded log growth when
    // the same task cycles through review multiple times.
    if (newEntries > 0 || !logExists) {
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

  function enrichAgent(agent, workerSnapshot, cfg, notifications, agentIds, inProgressTsMap) {
    const engine = agent.engine || inferEngine(agent.model);

    // Find which projects reference this agent (needed for workspace fallback)
    const linkedProjects = (cfg.projects || [])
      .filter(p => Array.isArray(p.openclawAgentIds) && p.openclawAgentIds.includes(agent.id))
      .map(p => ({ id: p.id, name: p.name }));
    const linkedProjectIds = new Set(linkedProjects.map(p => p.id));

    // Workspace: explicit > same-id project (inferred) > first linked project (only if unique)
    const inferredProject = !agent.workspacePath
      ? (cfg.projects || []).find(p => p.id === agent.id) || null
      : null;
    const firstLinkedProject = !agent.workspacePath && !inferredProject && linkedProjects.length >= 1
      ? (cfg.projects || []).find(p => p.id === linkedProjects[0].id) || null
      : null;
    // Extra linked projects beyond the first (for UI "+N" indicator)
    const workspaceExtraProjects = !agent.workspacePath && !inferredProject && linkedProjects.length > 1 ? linkedProjects.length - 1 : 0;
    const workspaceExtraProjectNames = workspaceExtraProjects > 0 ? linkedProjects.slice(1).map(p => p.name) : [];
    const workspacePath = agent.workspacePath || inferredProject?.path || firstLinkedProject?.path || '';
    const workspaceExists = workspacePath ? fs.existsSync(workspacePath) : false;
    const workspaceSource = agent.workspacePath ? 'explicit' : (inferredProject ? 'inferred' : firstLinkedProject ? 'linked' : 'none');
    let workspaceProjectName = inferredProject?.name || firstLinkedProject?.name || null;
    let workspaceProjectId = inferredProject?.id || firstLinkedProject?.id || null;
    // gitLookupPath: for agents with multiple linked projects and no explicit workspace,
    // use the first linked project's path for git history fallback
    const gitLookupPath = workspacePath || (
      linkedProjects.length > 0
        ? ((cfg.projects || []).find(p => p.id === linkedProjects[0].id)?.path || '')
        : ''
    );

    // For explicit workspace paths, find a matching project by path
    if (agent.workspacePath && !workspaceProjectName) {
      const pathMatch = (cfg.projects || []).find(p => p.path === agent.workspacePath);
      if (pathMatch) {
        workspaceProjectName = pathMatch.name;
        workspaceProjectId = pathMatch.id;
      }
    }

    // Match worker task: direct match by agent.id, or by linked project only if no dedicated agent exists for that project
    const workerRun = Array.isArray(workerSnapshot?.tasks)
      ? workerSnapshot.tasks.find(t =>
          t.projectId === agent.id ||
          (linkedProjectIds.has(t.projectId) && !(agentIds && agentIds.has(t.projectId)))
        ) || null
      : null;

    let statusKind = 'down';
    let statusLabel = 'Down';
    if (workerRun) {
      statusKind = 'active';
      statusLabel = 'Active';
    } else if (workerSnapshot) {
      statusKind = 'idle';
      statusLabel = 'Idle';
    }

    const thinkingDefault = cfg.agents?.defaults?.thinkingDefault || 'auto';
    const effectiveThinking = agent.thinking || thinkingDefault;
    const thinkingIsDefault = !agent.thinking;

    // Resolve project name for active task link
    const taskProjectId = workerRun?.projectId || null;
    const taskProject = taskProjectId
      ? (cfg.projects || []).find(p => p.id === taskProjectId) || null
      : null;

    // Last activity from notifications (only when not currently active)
    // Only consider terminal states — skip in_progress to avoid stale "running" display
    // TERMINAL_STATUSES is defined at module level above readNotifications()
    // Also exclude tasks currently being processed by the worker (activeTaskIds)
    const activeTaskIds = new Set((workerSnapshot?.tasks || []).map(t => t.id));
    let lastActivity = null;
    if (!workerRun && notifications && notifications.length) {
      // Collect all project names this agent is associated with
      const projectNamesToSearch = new Set();
      if (inferredProject?.name) projectNamesToSearch.add(inferredProject.name);
      for (const lp of linkedProjects) {
        if (lp.name) projectNamesToSearch.add(lp.name);
      }
      // Also search by workspace project when agent has an explicit workspacePath
      if (agent.workspacePath && workspaceProjectName) {
        projectNamesToSearch.add(workspaceProjectName);
      }

      if (projectNamesToSearch.size) {
        const matching = notifications.filter(n =>
          projectNamesToSearch.has(n.projectName) && TERMINAL_STATUSES.has(n.toStatus) &&
          !activeTaskIds.has(n.taskId) &&
          // Exclude terminal notifications superseded by a more recent in_progress for the same task
          !(inProgressTsMap && n.taskId && inProgressTsMap[n.taskId] !== undefined &&
            inProgressTsMap[n.taskId] > new Date(n.timestamp).getTime())
        );
        if (matching.length) {
          const sorted = [...matching].sort((a, b) =>
            new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
          );
          const latest = sorted[sorted.length - 1];
          const latestProject = (cfg.projects || []).find(p => p.name === latest.projectName);
          lastActivity = {
            taskTitle: latest.taskTitle || null,
            taskId: latest.taskId || null,
            timestamp: latest.timestamp,
            status: latest.toStatus,
            projectName: latest.projectName,
            projectId: latestProject?.id || null,
            message: latest.message || null,
          };
        }
      }
    }

    const engineIsInferred = !agent.engine;

    // All linked project paths — used for multi-repo git commit lookup
    // Include all repo paths, not just project.path, to catch commits in sub-repos
    const linkedPaths = agent.workspacePath
      ? [] // explicit workspace covers it; don't also look at linked project repos
      : (() => {
          const allPaths = new Set();
          // Paths from projects that reference this agent via openclawAgentIds
          for (const lp of linkedProjects) {
            const proj = (cfg.projects || []).find(p => p.id === lp.id);
            if (!proj) continue;
            if (proj.path) allPaths.add(proj.path);
            for (const r of (proj.repos || [])) {
              if (r.path) allPaths.add(r.path);
            }
          }
          // Also include inferredProject repos (agent.id === project.id) as fallback
          // in case the project doesn't list the agent in openclawAgentIds
          if (inferredProject) {
            if (inferredProject.path) allPaths.add(inferredProject.path);
            for (const r of (inferredProject.repos || [])) {
              if (r.path) allPaths.add(r.path);
            }
          }
          return [...allPaths];
        })();

    return {
      ...agent,
      engine,
      engineIsInferred,
      workspacePath,
      gitLookupPath,
      workspaceExists,
      workspaceSource,
      workspaceProjectName,
      workspaceProjectId,
      workspaceExtraProjects,
      workspaceExtraProjectNames,
      linkedPaths,
      statusKind,
      statusLabel,
      linkedProjects,
      effectiveThinking,
      thinkingIsDefault,
      lastActivity,
      currentTask: workerRun ? {
        id: workerRun.id,
        title: workerRun.title,
        projectId: taskProjectId,
        projectName: taskProject?.name || taskProjectId,
        startedAt: workerRun.startedAt || null,
        durationMin: workerRun.durationMin || 0,
        pendingQuestion: workerRun.pendingQuestion || null,
        engine: workerRun.engine || null
      } : null
    };
  }

  // GET /api/agents — list all agents with runtime status
  router.get('/api/agents', requireAuth, async (req, res) => {
    try {
      const cfg = reloadConfig();
      const agents = Array.isArray(cfg.openclawAgents) ? cfg.openclawAgents : [];
      const [workerSnapshot, notifications] = await Promise.all([
        fetchWorkerSnapshot(),
        Promise.resolve(readNotifications()),
      ]);
      // Map taskId → most-recent in_progress timestamp (ms) from pending notifications.
      // Used to suppress terminal statuses that were superseded by a re-queue.
      // Only suppresses when in_progress timestamp is NEWER than the terminal notification.
      const inProgressTsMap = {};
      try {
        const pendingData = JSON.parse(fs.readFileSync(NOTIFICATIONS_PATH, 'utf8'));
        for (const n of (pendingData.pending || [])) {
          if (n.toStatus === 'in_progress' && n.taskId) {
            const ts = new Date(n.timestamp).getTime();
            if (!inProgressTsMap[n.taskId] || ts > inProgressTsMap[n.taskId]) {
              inProgressTsMap[n.taskId] = ts;
            }
          }
        }
      } catch {}
      const agentIds = new Set(agents.map(a => a.id));
      const enriched = agents.map(a => enrichAgent(a, workerSnapshot, cfg, notifications, agentIds, inProgressTsMap));

      // Fetch git last commit for agents with no notification activity and a valid workspace.
      // Multi-linked agents (no explicit workspace) check all linked project paths and pick
      // the most recent commit across all of them.
      const pathsToFetch = new Set();
      for (const a of enriched) {
        if (a.currentTask) continue;
        // Prefer linkedPaths (covers all repos in multi-repo projects) over single workspacePath
        if (a.linkedPaths && a.linkedPaths.length) {
          for (const p of a.linkedPaths) pathsToFetch.add(p);
        } else if (a.workspacePath) {
          pathsToFetch.add(a.workspacePath);
        } else if (a.gitLookupPath) {
          pathsToFetch.add(a.gitLookupPath);
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
          } catch { /* ignore: repo may not exist */ }
        })
      );
      for (const a of enriched) {
        if (a.currentTask) continue;
        // Collect all paths relevant to this agent — prefer linkedPaths for multi-repo coverage
        const agentPaths = (a.linkedPaths && a.linkedPaths.length)
          ? a.linkedPaths
          : (a.workspacePath ? [a.workspacePath] : (a.gitLookupPath ? [a.gitLookupPath] : []));
        // Pick the most recent commit across all repos
        let best = null;
        let bestPath = null;
        for (const p of agentPaths) {
          const c = gitCommitMap[p];
          if (!c) continue;
          if (!best || new Date(c.timestamp) > new Date(best.timestamp)) {
            best = c;
            bestPath = p;
          }
        }
        if (best) {
          const gitProject = bestPath
            ? (cfg.projects || []).find(p => p.path === bestPath || (p.repos || []).some(r => r.path === bestPath))
            : null;
          a.gitLastCommit = { ...best, projectName: gitProject?.name || null, projectId: gitProject?.id || null };
        }
      }

      // Read project .claude/tasks.json for recent task activity (richer than git commits alone)
      const TASK_DONE_STATUSES = new Set(['done', 'review', 'approved', 'rejected', 'failed', 'validating']);
      const workerActiveTaskIds = new Set((workerSnapshot?.tasks || []).map(t => t.id));
      const taskPathsToFetch = new Set();
      for (const a of enriched) {
        if (a.currentTask) continue;
        const agentPaths = (a.linkedPaths && a.linkedPaths.length)
          ? a.linkedPaths
          : (a.workspacePath ? [a.workspacePath] : (a.gitLookupPath ? [a.gitLookupPath] : []));
        for (const p of agentPaths) taskPathsToFetch.add(p);
      }
      const REVIEW_STATUSES = new Set(['review', 'validating']);
      const projectTaskMap = {};       // path → most-recent task entry
      const projectReviewCountMap = {}; // path → count of review/validating tasks
      await Promise.allSettled(
        Array.from(taskPathsToFetch).map(async (p) => {
          try {
            const tasksPath = path.join(p, '.claude', 'tasks.json');
            const data = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
            const tasks = Array.isArray(data.tasks) ? data.tasks : [];
            const candidates = tasks.filter(t =>
              TASK_DONE_STATUSES.has(t.status) && (t.updatedAt || t.completedAt) && !workerActiveTaskIds.has(t.id)
            );
            if (!candidates.length) return;
            const latest = candidates.reduce((best, t) =>
              new Date(t.updatedAt || t.completedAt) > new Date(best.updatedAt || best.completedAt) ? t : best
            );
            projectTaskMap[p] = {
              taskTitle: latest.title || latest.id,
              taskId: latest.id,
              status: latest.status,
              timestamp: latest.updatedAt || latest.completedAt,
            };
            projectReviewCountMap[p] = candidates.filter(t => REVIEW_STATUSES.has(t.status)).length;
          } catch { /* ignore: file may not exist */ }
        })
      );
      for (const a of enriched) {
        if (a.currentTask) continue;
        const agentPaths = (a.linkedPaths && a.linkedPaths.length)
          ? a.linkedPaths
          : (a.workspacePath ? [a.workspacePath] : (a.gitLookupPath ? [a.gitLookupPath] : []));
        let bestTask = null;
        let bestTaskPath = null;
        let totalReviewCount = 0;
        for (const p of agentPaths) {
          const t = projectTaskMap[p];
          if (!t) continue;
          totalReviewCount += projectReviewCountMap[p] || 0;
          if (!bestTask || new Date(t.timestamp) > new Date(bestTask.timestamp)) {
            bestTask = t;
            bestTaskPath = p;
          }
        }
        if (bestTask) {
          const taskProject = bestTaskPath
            ? (cfg.projects || []).find(proj =>
                proj.path === bestTaskPath || (proj.repos || []).some(r => r.path === bestTaskPath)
              )
            : null;
          a.projectLastTask = {
            ...bestTask,
            projectName: taskProject?.name || null,
            projectId: taskProject?.id || null,
            reviewPendingCount: totalReviewCount,
          };
        }
      }

      const thinkingDefault = cfg.agents?.defaults?.thinkingDefault || 'auto';
      const workerStatus = workerSnapshot
        ? { running: workerSnapshot.running !== false, count: workerSnapshot.count || 0, maxConcurrency: workerSnapshot.maxConcurrency || null }
        : null;
      res.json({ agents: enriched, defaults: { thinkingDefault }, workerStatus });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/agents/:id — single agent detail
  router.get('/api/agents/:id', requireAuth, async (req, res) => {
    try {
      const cfg = reloadConfig();
      const agents = Array.isArray(cfg.openclawAgents) ? cfg.openclawAgents : [];
      const agent = agents.find(a => a.id === req.params.id);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
      const workerSnapshot = await fetchWorkerSnapshot();
      const notifications = readNotifications();
      const agentIds = new Set(agents.map(a => a.id));
      const inProgressTsMap = {};
      try {
        const pendingData = JSON.parse(fs.readFileSync(NOTIFICATIONS_PATH, 'utf8'));
        for (const n of (pendingData.pending || [])) {
          if (n.toStatus === 'in_progress' && n.taskId) {
            const ts = new Date(n.timestamp).getTime();
            if (!inProgressTsMap[n.taskId] || ts > inProgressTsMap[n.taskId]) inProgressTsMap[n.taskId] = ts;
          }
        }
      } catch {}
      res.json(enrichAgent(agent, workerSnapshot, cfg, notifications, agentIds, inProgressTsMap));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /api/agents/:id — update agent
  router.put('/api/agents/:id', requireAuth, async (req, res) => {
    try {
      const cfg = reloadConfig();
      const agents = Array.isArray(cfg.openclawAgents) ? cfg.openclawAgents : [];
      const idx = agents.findIndex(a => a.id === req.params.id);
      if (idx === -1) return res.status(404).json({ error: 'Agent not found' });

      const { name, engine, model, workspacePath, thinking } = req.body;
      if (name !== undefined) agents[idx].name = String(name).trim();
      if (engine !== undefined) {
        const engineVal = String(engine).trim();
        if (engineVal) agents[idx].engine = engineVal;
        else delete agents[idx].engine;
      }
      if (model !== undefined) agents[idx].model = String(model).trim();
      if (workspacePath !== undefined) agents[idx].workspacePath = String(workspacePath).trim();
      if (thinking !== undefined) {
        const thinkingVal = String(thinking).trim();
        const validThinking = ['auto', 'low', 'medium', 'high'];
        if (thinkingVal && validThinking.includes(thinkingVal)) agents[idx].thinking = thinkingVal;
        else delete agents[idx].thinking;
      }

      cfg.openclawAgents = agents;
      writeJSON(CONFIG_PATH, cfg);

      // Update in-memory config
      Object.assign(config, cfg);

      const workerSnapshot = await fetchWorkerSnapshot();
      const notifications = readNotifications();
      const agentIds = new Set(agents.map(a => a.id));
      res.json(enrichAgent(agents[idx], workerSnapshot, cfg, notifications, agentIds));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/agents — create new agent
  router.post('/api/agents', requireAuth, async (req, res) => {
    try {
      const cfg = reloadConfig();
      const agents = Array.isArray(cfg.openclawAgents) ? cfg.openclawAgents : [];
      const { id, name, engine, model, workspacePath, thinking } = req.body;

      if (!id || !String(id).trim()) return res.status(400).json({ error: 'id is required' });
      const agentId = String(id).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
      if (agents.find(a => a.id === agentId)) return res.status(409).json({ error: 'Agent with this id already exists' });

      const newAgent = {
        id: agentId,
        name: (name || agentId).trim(),
        model: (model || 'claude-sonnet-4-6').trim(),
        workspacePath: (workspacePath || '').trim()
      };
      const engineVal = (engine || '').trim();
      if (engineVal) newAgent.engine = engineVal;
      const thinkingVal = (thinking || '').trim();
      const validThinking = ['auto', 'low', 'medium', 'high'];
      if (thinkingVal && validThinking.includes(thinkingVal)) newAgent.thinking = thinkingVal;

      agents.push(newAgent);
      cfg.openclawAgents = agents;
      writeJSON(CONFIG_PATH, cfg);
      Object.assign(config, cfg);

      const workerSnapshot = await fetchWorkerSnapshot();
      const notifications = readNotifications();
      const agentIds = new Set(agents.map(a => a.id));
      res.status(201).json(enrichAgent(newAgent, workerSnapshot, cfg, notifications, agentIds));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/agents/:id — delete agent
  router.delete('/api/agents/:id', requireAuth, async (req, res) => {
    try {
      const cfg = reloadConfig();
      const agents = Array.isArray(cfg.openclawAgents) ? cfg.openclawAgents : [];
      const idx = agents.findIndex(a => a.id === req.params.id);
      if (idx === -1) return res.status(404).json({ error: 'Agent not found' });

      // Also remove from any project references
      for (const project of cfg.projects || []) {
        if (Array.isArray(project.openclawAgentIds)) {
          project.openclawAgentIds = project.openclawAgentIds.filter(aid => aid !== req.params.id);
        }
      }

      agents.splice(idx, 1);
      cfg.openclawAgents = agents;
      writeJSON(CONFIG_PATH, cfg);
      Object.assign(config, cfg);

      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
