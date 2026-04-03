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
    if (m.startsWith('claude-')) return 'claude';      // Direct Anthropic API: claude-opus-4-6, etc.
    if (m.startsWith('anthropic/')) return 'openrouter'; // OpenRouter format: anthropic/claude-*
    return 'openrouter';
  }

  function inferWorkspacePath(agentId, cfg) {
    const project = (cfg.projects || []).find(p => p.id === agentId);
    return project?.path || '';
  }

  const NOTIFICATIONS_PATH = path.join(__dirname, '..', '.dashboard', 'notifications.json');
  const ACTIVITY_LOG_PATH = path.join(__dirname, '..', '.dashboard', 'activity-log.json');

  function readNotifications() {
    // Read persistent activity log first (survives bell clears)
    let log = [];
    try {
      const raw = JSON.parse(fs.readFileSync(ACTIVITY_LOG_PATH, 'utf8'));
      if (Array.isArray(raw)) log = raw;
    } catch {}
    // Merge any fresh pending notifications not yet in log
    let newEntries = 0;
    try {
      const data = JSON.parse(fs.readFileSync(NOTIFICATIONS_PATH, 'utf8'));
      if (Array.isArray(data.pending) && data.pending.length) {
        const logKeys = new Set(log.map(n => `${n.taskId}|${n.timestamp}`));
        for (const n of data.pending) {
          if (!logKeys.has(`${n.taskId}|${n.timestamp}`)) { log.push(n); newEntries++; }
        }
      }
    } catch {}
    // Persist so activity survives notifications.json clears (bell)
    if (newEntries > 0) {
      try { writeJSON(ACTIVITY_LOG_PATH, log); } catch {}
    }
    return log;
  }

  function enrichAgent(agent, workerSnapshot, cfg, notifications, agentIds) {
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
    const TERMINAL_STATUSES = new Set(['review', 'done', 'approved', 'rejected', 'failed', 'validating']);
    let lastActivity = null;
    if (!workerRun && notifications && notifications.length) {
      const projectNamesToSearch = new Set();
      // The inferred (same-id) project is always "owned" by this agent
      if (inferredProject?.name) projectNamesToSearch.add(inferredProject.name);
      // For linked projects, only include activity if there's no dedicated agent for that project
      // (same logic as workerRun matching — avoids showing duplicate activity on secondary agents like "main")
      for (const lp of linkedProjects) {
        const hasDedicatedAgent = agentIds && agentIds.has(lp.id) && lp.id !== agent.id;
        if (lp.name && !hasDedicatedAgent) projectNamesToSearch.add(lp.name);
      }
      // Fallback only for agents that span multiple projects (e.g. synap-communication, synap-qa).
      // Single-linked secondary agents fall through to git activity to avoid duplicating
      // notifications already shown by the dedicated agent for that project.
      if (!projectNamesToSearch.size && linkedProjects.length > 1) {
        for (const lp of linkedProjects) {
          if (lp.name) projectNamesToSearch.add(lp.name);
        }
      }

      if (projectNamesToSearch.size) {
        const matching = notifications.filter(n =>
          projectNamesToSearch.has(n.projectName) && TERMINAL_STATUSES.has(n.toStatus)
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
      const agentIds = new Set(agents.map(a => a.id));
      const enriched = agents.map(a => enrichAgent(a, workerSnapshot, cfg, notifications, agentIds));

      // Fetch git last commit for agents with no notification activity and a valid workspace
      // Uses gitLookupPath which covers multi-linked agents that have no explicit workspace
      const pathsToFetch = new Set(
        enriched
          .filter(a => !a.lastActivity && !a.currentTask && (a.workspacePath || a.gitLookupPath))
          .map(a => a.workspacePath || a.gitLookupPath)
          .filter(Boolean)
      );
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
        const lookupPath = a.workspacePath || a.gitLookupPath;
        if (!a.lastActivity && !a.currentTask && lookupPath && gitCommitMap[lookupPath]) {
          a.gitLastCommit = gitCommitMap[lookupPath];
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
      res.json(enrichAgent(agent, workerSnapshot, cfg, notifications, agentIds));
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

      const { name, engine, model, workspacePath } = req.body;
      if (name !== undefined) agents[idx].name = String(name).trim();
      if (engine !== undefined) {
        const engineVal = String(engine).trim();
        if (engineVal) agents[idx].engine = engineVal;
        else delete agents[idx].engine;
      }
      if (model !== undefined) agents[idx].model = String(model).trim();
      if (workspacePath !== undefined) agents[idx].workspacePath = String(workspacePath).trim();

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
      const { id, name, engine, model, workspacePath } = req.body;

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
