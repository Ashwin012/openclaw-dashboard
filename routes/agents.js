module.exports = function createAgentRoutes({ config, requireAuth }) {
  const router = require('express').Router();
  const fs = require('fs');
  const path = require('path');
  const http = require('http');
  const { writeJSON } = require('../lib/json-store');

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
    if (m.startsWith('anthropic/') || m.startsWith('claude-')) return 'claude';
    return 'openrouter';
  }

  function inferWorkspacePath(agentId, cfg) {
    const project = (cfg.projects || []).find(p => p.id === agentId);
    return project?.path || '';
  }

  const NOTIFICATIONS_PATH = path.join(__dirname, '..', '.dashboard', 'notifications.json');

  function readNotifications() {
    try {
      const data = JSON.parse(fs.readFileSync(NOTIFICATIONS_PATH, 'utf8'));
      return Array.isArray(data.pending) ? data.pending : [];
    } catch {
      return [];
    }
  }

  function enrichAgent(agent, workerSnapshot, cfg, notifications) {
    const engine = agent.engine || inferEngine(agent.model);

    // Find which projects reference this agent (needed for workspace fallback)
    const linkedProjects = (cfg.projects || [])
      .filter(p => Array.isArray(p.openclawAgentIds) && p.openclawAgentIds.includes(agent.id))
      .map(p => ({ id: p.id, name: p.name }));
    const linkedProjectIds = new Set(linkedProjects.map(p => p.id));

    // Workspace: explicit > same-id project (inferred) > first linked project
    const inferredProject = !agent.workspacePath
      ? (cfg.projects || []).find(p => p.id === agent.id) || null
      : null;
    const firstLinkedProject = !agent.workspacePath && !inferredProject && linkedProjects.length > 0
      ? (cfg.projects || []).find(p => p.id === linkedProjects[0].id) || null
      : null;
    const workspacePath = agent.workspacePath || inferredProject?.path || firstLinkedProject?.path || '';
    const workspaceExists = workspacePath ? fs.existsSync(workspacePath) : false;
    const workspaceSource = agent.workspacePath ? 'explicit' : (inferredProject ? 'inferred' : firstLinkedProject ? 'linked' : 'none');
    let workspaceProjectName = inferredProject?.name || firstLinkedProject?.name || null;
    let workspaceProjectId = inferredProject?.id || firstLinkedProject?.id || null;

    // For explicit workspace paths, find a matching project by path
    if (agent.workspacePath && !workspaceProjectName) {
      const pathMatch = (cfg.projects || []).find(p => p.path === agent.workspacePath);
      if (pathMatch) {
        workspaceProjectName = pathMatch.name;
        workspaceProjectId = pathMatch.id;
      }
    }

    // Match worker task: by projectId == agent.id, or by any linked project
    const workerRun = Array.isArray(workerSnapshot?.tasks)
      ? workerSnapshot.tasks.find(t =>
          t.projectId === agent.id || linkedProjectIds.has(t.projectId)
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
    let lastActivity = null;
    if (!workerRun && notifications && notifications.length) {
      const projectNamesToSearch = new Set();
      if (inferredProject?.name) projectNamesToSearch.add(inferredProject.name);
      for (const lp of linkedProjects) {
        if (lp.name) projectNamesToSearch.add(lp.name);
      }
      if (projectNamesToSearch.size) {
        const matching = notifications.filter(n => projectNamesToSearch.has(n.projectName));
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

    return {
      ...agent,
      engine,
      workspacePath,
      workspaceExists,
      workspaceSource,
      workspaceProjectName,
      workspaceProjectId,
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
      const enriched = agents.map(a => enrichAgent(a, workerSnapshot, cfg, notifications));
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
      res.json(enrichAgent(agent, workerSnapshot, cfg, notifications));
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
      if (engine !== undefined) agents[idx].engine = String(engine).trim();
      if (model !== undefined) agents[idx].model = String(model).trim();
      if (workspacePath !== undefined) agents[idx].workspacePath = String(workspacePath).trim();

      cfg.openclawAgents = agents;
      writeJSON(CONFIG_PATH, cfg);

      // Update in-memory config
      Object.assign(config, cfg);

      const workerSnapshot = await fetchWorkerSnapshot();
      const notifications = readNotifications();
      res.json(enrichAgent(agents[idx], workerSnapshot, cfg, notifications));
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
        engine: (engine || 'claude').trim(),
        model: (model || 'claude-sonnet-4-6').trim(),
        workspacePath: (workspacePath || '').trim()
      };

      agents.push(newAgent);
      cfg.openclawAgents = agents;
      writeJSON(CONFIG_PATH, cfg);
      Object.assign(config, cfg);

      const workerSnapshot = await fetchWorkerSnapshot();
      const notifications = readNotifications();
      res.status(201).json(enrichAgent(newAgent, workerSnapshot, cfg, notifications));
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
