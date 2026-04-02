module.exports = function createChatRoutes({ config, requireAuth, server }) {
  const router = require('express').Router();
  const WebSocket = require('ws');
  const crypto = require('crypto');
  const { spawn } = require('child_process');
  const path = require('path');
  const { readJSON, writeJSON } = require('../lib/json-store');

  const wss = new WebSocket.Server({ noServer: true });
  const chatSessions = new Map(); // sessionId -> { projectId, projectPath, model, process, ws, status }
  const VALID_ENGINES = new Set(['claude', 'codex', 'ollama']);
  const VALID_CLAUDE_MODELS = new Set(['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-3-5']);
  const VALID_CODEX_MODELS = new Set(['gpt-5.4', 'gpt-5.3-codex']);

  // ===== Chat Session Persistence =====

  function normalizeSessionRecord(session) {
    if (!session || typeof session !== 'object') return session;
    const engine = session.engine || 'claude';
    return {
      ...session,
      engine,
      engineSessionId: session.engineSessionId || session.claudeSessionId || null
    };
  }

  function getChatSessionsPath(project) {
    return path.join(project.path, '.claude', 'chat-sessions.json');
  }

  function readChatSessions(project) {
    return readJSON(getChatSessionsPath(project), []).map(normalizeSessionRecord);
  }

  function writeChatSessions(project, sessions) {
    writeJSON(getChatSessionsPath(project), sessions);
  }

  function getRequestEngine(req, fallback = 'claude') {
    const engine = req.body?.engine || req.query.engine || fallback;
    return VALID_ENGINES.has(engine) ? engine : fallback;
  }

  function getEngineLabel(engine) {
    if (engine === 'codex') return 'Codex';
    if (engine === 'ollama') return 'Ollama local (via Codex)';
    return 'Claude Code';
  }

  function resolveChatModel(engine, model) {
    const raw = typeof model === 'string' ? model.trim() : '';
    if (engine === 'claude') {
      const modelMap = { sonnet: 'claude-sonnet-4-6', opus: 'claude-opus-4-6', haiku: 'claude-haiku-3-5' };
      const resolved = modelMap[raw] || raw || 'claude-sonnet-4-6';
      return VALID_CLAUDE_MODELS.has(resolved) ? resolved : 'claude-sonnet-4-6';
    }

    if (engine === 'codex') {
      return VALID_CODEX_MODELS.has(raw) ? raw : 'gpt-5.4';
    }

    return raw || 'qwen3:8b';
  }

  function isMatchingProjectEngineSession(sess, projectId, engine) {
    return sess.projectId === projectId && (sess.engine || 'claude') === engine;
  }

  function cleanupInMemorySessions(projectId, engine, project) {
    const now = new Date().toISOString();
    for (const [sid, sess] of chatSessions.entries()) {
      if (!isMatchingProjectEngineSession(sess, projectId, engine)) continue;
      if (sess.cleanupTimer) clearTimeout(sess.cleanupTimer);
      if (sess.process) { try { sess.process.kill('SIGTERM'); } catch (e) {} }
      if (sess.ws) { try { sess.ws.close(); } catch (e) {} }
      if (project && sess.persistentId) {
        updateChatSessionMeta(project, sess.persistentId, { status: 'closed', lastActivityAt: now });
      }
      chatSessions.delete(sid);
    }
  }

  function upsertChatSession(project, sessionData) {
    const sessions = readChatSessions(project);
    const normalized = normalizeSessionRecord(sessionData);
    const idx = sessions.findIndex(s => s.id === normalized.id);
    if (idx >= 0) { sessions[idx] = normalized; } else { sessions.unshift(normalized); }
    writeChatSessions(project, sessions);
  }

  function getLatestProjectEngineSession(project, engine) {
    return readChatSessions(project)
      .filter(s => (s.engine || 'claude') === engine)
      .sort((a, b) => new Date(b.lastActivityAt || b.createdAt || 0) - new Date(a.lastActivityAt || a.createdAt || 0))[0] || null;
  }

  function buildRuntimeSession(project, persistentSession, sessionId = persistentSession.id) {
    return {
      projectId: project.id,
      projectPath: project.path,
      model: persistentSession.model,
      engine: persistentSession.engine || 'claude',
      engineSessionId: persistentSession.engineSessionId || persistentSession.claudeSessionId || null,
      claudeSessionId: persistentSession.claudeSessionId || null,
      process: null,
      ws: null,
      status: 'pending',
      busy: false,
      persistentId: sessionId,
      currentResponseText: '',
      cleanupTimer: null,
      _config: config
    };
  }

  function addChatMessage(project, sessionId, message) {
    const sessions = readChatSessions(project);
    const sess = sessions.find(s => s.id === sessionId);
    if (!sess) return;
    if (!sess.messages) sess.messages = [];
    sess.messages.push(message);
    sess.lastActivityAt = new Date().toISOString();
    if (!sess.firstMessage && message.role === 'user') {
      sess.firstMessage = message.content.substring(0, 120);
    }
    writeChatSessions(project, sessions);
  }

  function updateChatSessionMeta(project, sessionId, updates) {
    const sessions = readChatSessions(project);
    const sess = sessions.find(s => s.id === sessionId);
    if (!sess) return;
    Object.assign(sess, updates);
    writeChatSessions(project, sessions);
  }

  // ===== Claude Process Spawning =====

  function spawnClaudeForMessage(session, text, ws) {
    if (session.busy) {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: 'error', error: 'Already processing a message, please wait.' })); } catch (e) {}
      }
      return;
    }
    session.busy = true;
    session.currentResponseText = '';

    const args = [
      '--print',
      '--verbose',
      '--permission-mode', 'bypassPermissions',
      '--output-format', 'stream-json',
      '--model', session.model
    ];

    // Add effort/thinking level if specified
    const effort = session.nextEffort || 'medium';
    session.nextEffort = null; // consume once
    if (effort && effort !== 'medium') {
      args.push('--effort', effort);
    }

    const resumeSessionId = session.engineSessionId || session.claudeSessionId;
    if (resumeSessionId) {
      args.push('--resume', resumeSessionId);
    }

    args.push(text);

    const claudeProc = spawn('claude', args, {
      cwd: session.projectPath,
      env: { ...process.env, PATH: '/home/openclaw/.nvm/versions/node/v20.20.1/bin:' + (process.env.PATH || '/usr/local/bin:/usr/bin:/bin'), CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN || '' },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    session.process = claudeProc;

    let stdoutBuf = '';

    claudeProc.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === 'result' && parsed.session_id) {
            session.claudeSessionId = parsed.session_id;
            session.engineSessionId = parsed.session_id;
            // Save assistant response and update persisted session ids
            const project = config.projects.find(p => p.id === session.projectId);
            if (project && session.persistentId) {
              if (session.currentResponseText) {
                addChatMessage(project, session.persistentId, {
                  role: 'assistant',
                  content: session.currentResponseText,
                  timestamp: new Date().toISOString()
                });
                session.currentResponseText = '';
              }
              updateChatSessionMeta(project, session.persistentId, {
                engineSessionId: parsed.session_id,
                claudeSessionId: parsed.session_id,
                status: 'active'
              });
            }
          } else if (parsed.type === 'content_block_delta' && parsed.delta && parsed.delta.type === 'text_delta') {
            session.currentResponseText += parsed.delta.text || '';
          } else if (parsed.type === 'assistant' && parsed.message && parsed.message.content) {
            // Complete assistant message event
            const text = parsed.message.content.filter(b => b.type === 'text').map(b => b.text || '').join('');
            if (text) session.currentResponseText += text;
          }
        } catch (e) {}
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.send(line); } catch (e) {}
        }
      }
    });

    claudeProc.stderr.on('data', (chunk) => {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: 'stderr', data: chunk.toString() })); } catch (e) {}
      }
    });

    claudeProc.on('close', (code) => {
      session.busy = false;
      session.process = null;
      if (code !== 0 && code !== null && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: 'error', error: `Claude process exited with code ${code}` })); } catch (e) {}
      }
    });

    claudeProc.on('error', (err) => {
      session.busy = false;
      session.process = null;
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: 'error', error: `Failed to run claude: ${err.message}` })); } catch (e) {}
      }
    });
  }

  // ===== Codex Process Spawning =====

  function spawnCodexForMessage(session, text, ws) {
    if (session.busy) {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: 'error', error: 'Already processing a message, please wait.' })); } catch (e) {}
      }
      return;
    }
    session.busy = true;
    session.currentResponseText = '';

    const resolvedModel = session.model || (session.engine === 'ollama' ? 'qwen3:8b' : 'gpt-5.4');
    const args = session.engineSessionId
      ? ['exec', 'resume', '--json', '--model', resolvedModel]
      : ['exec', '--json', '--model', resolvedModel];
    if (session.engine === 'ollama') {
      args.push('--oss', '--local-provider', 'ollama');
    }
    if (session.engineSessionId) {
      args.push(session.engineSessionId, text);
    } else {
      args.push(text);
    }

    const codexProc = require('child_process').spawn('codex', args, {
      cwd: session.projectPath,
      env: { ...process.env, PATH: '/home/openclaw/.nvm/versions/node/v20.20.1/bin:' + (process.env.PATH || '/usr/local/bin:/usr/bin:/bin') },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    session.process = codexProc;

    let stdoutBuf = '';

    codexProc.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed = null;
        try {
          parsed = JSON.parse(trimmed);
        } catch (e) {}

        if (parsed && parsed.type === 'thread.started' && parsed.thread_id) {
          session.engineSessionId = parsed.thread_id;
          const project = config.projects.find(p => p.id === session.projectId);
          if (project && session.persistentId) {
            updateChatSessionMeta(project, session.persistentId, {
              engineSessionId: parsed.thread_id,
              status: 'active'
            });
          }
          continue;
        }

        if (parsed && parsed.type === 'item.completed' && parsed.item && parsed.item.type === 'agent_message') {
          const textDelta = parsed.item.text || '';
          if (textDelta) {
            session.currentResponseText += textDelta;
            if (ws.readyState === WebSocket.OPEN) {
              try { ws.send(JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: textDelta } })); } catch (e) {}
            }
          }
          continue;
        }

        if (parsed && parsed.type === 'turn.completed') {
          if (ws.readyState === WebSocket.OPEN) {
            try {
              ws.send(JSON.stringify({
                type: 'result',
                total_cost_usd: 0,
                duration_ms: 0
              }));
            } catch (e) {}
          }
          continue;
        }

        if (!parsed && ws.readyState === WebSocket.OPEN) {
          session.currentResponseText += trimmed;
          try { ws.send(JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: trimmed } })); } catch (e) {}
        }
      }
    });

    codexProc.stderr.on('data', (chunk) => {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: 'stderr', data: chunk.toString() })); } catch (e) {}
      }
    });

    codexProc.on('close', (code) => {
      session.busy = false;
      session.process = null;
      // Save assistant response
      const configRef = session._config;
      if (configRef) {
        const proj = configRef.projects.find(p => p.id === session.projectId);
        if (proj && session.persistentId && session.currentResponseText) {
          addChatMessage(proj, session.persistentId, {
            role: 'assistant',
            content: session.currentResponseText,
            timestamp: new Date().toISOString()
          });
          session.currentResponseText = '';
        }
      }
    });

    codexProc.on('error', (err) => {
      session.busy = false;
      session.process = null;
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: 'error', error: `Failed to run ${session.engine === 'ollama' ? 'codex/ollama' : 'codex'}: ${err.message}` })); } catch (e) {}
      }
    });
  }

  // ===== WebSocket Setup =====

  function setupWebSocket() {
    server.on('upgrade', (request, socket, head) => {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (pathname.startsWith('/ws/chat/')) {
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request);
        });
      } else {
        socket.destroy();
      }
    });
  }

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const sessionId = url.pathname.slice('/ws/chat/'.length);
    const queryProjectId = url.searchParams.get('projectId');
    let session = chatSessions.get(sessionId);

    // Validate project match if session is in memory and projectId was provided
    if (session && queryProjectId && session.projectId !== queryProjectId) {
      try { ws.send(JSON.stringify({ type: 'error', error: 'Session does not belong to this project' })); } catch (e) {}
      ws.close(1008, 'Project mismatch');
      return;
    }

    // If not in memory, try to restore from persistent storage (handles server restarts)
    // Only restore from the specific project if projectId is provided
    if (!session && sessionId) {
      if (queryProjectId) {
        // Scoped restore: only look in the specified project
        const proj = config.projects.find(p => p.id === queryProjectId);
        if (proj) {
          const fileSessions = readChatSessions(proj);
          const fileSession = fileSessions.find(s => s.id === sessionId);
          if (fileSession) {
            session = buildRuntimeSession(proj, fileSession, sessionId);
            chatSessions.set(sessionId, session);
          }
        }
      } else {
        // Fallback: scan all projects (legacy clients without projectId param)
        for (const proj of config.projects) {
          const fileSessions = readChatSessions(proj);
          const fileSession = fileSessions.find(s => s.id === sessionId);
          if (fileSession) {
            session = buildRuntimeSession(proj, fileSession, sessionId);
            chatSessions.set(sessionId, session);
            break;
          }
        }
      }
    }

    if (!session) {
      try { ws.send(JSON.stringify({ type: 'error', error: 'Session not found or expired' })); } catch (e) {}
      ws.close(1008, 'Session not found');
      return;
    }

    // Cancel any pending cleanup timer (reconnect case)
    if (session.cleanupTimer) {
      clearTimeout(session.cleanupTimer);
      session.cleanupTimer = null;
    }

    // Close any previous WS connection for this session
    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
      try { session.ws.close(1000, 'Replaced by new connection'); } catch (e) {}
    }

    session.ws = ws;
    session.status = 'active';

    try { ws.send(JSON.stringify({ type: 'session_ready', sessionId, model: session.model })); } catch (e) {}

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'change_model') {
          const nextModel = resolveChatModel(session.engine, msg.model);
          if (nextModel) {
            session.model = nextModel;
            const project = config.projects.find(p => p.id === session.projectId);
            if (project && session.persistentId) {
              updateChatSessionMeta(project, session.persistentId, { model: nextModel });
            }
            if (ws.readyState === WebSocket.OPEN) {
              try { ws.send(JSON.stringify({ type: 'model_changed', model: nextModel })); } catch (e) {}
            }
          }
        } else if (msg.type === 'user_message') {
          // Set effort for this message
          if (msg.effort) session.nextEffort = msg.effort;
          // Save user message to persistent session
          const project = config.projects.find(p => p.id === session.projectId);
          if (project && session.persistentId) {
            addChatMessage(project, session.persistentId, {
              role: 'user',
              content: msg.text,
              timestamp: new Date().toISOString()
            });
          }
          if (session.engine === 'codex' || session.engine === 'ollama') {
            spawnCodexForMessage(session, msg.text, ws);
          } else {
            spawnClaudeForMessage(session, msg.text, ws);
          }
        } else if (msg.type === 'voice_message') {
          // Set effort for this message
          if (msg.effort) session.nextEffort = msg.effort;
          // Save voice message (with audioUrl) then send text to Claude
          const project = config.projects.find(p => p.id === session.projectId);
          if (project && session.persistentId) {
            addChatMessage(project, session.persistentId, {
              role: 'user',
              type: 'voice',
              content: msg.text,
              audioUrl: msg.audioUrl,
              timestamp: new Date().toISOString()
            });
          }
          if (session.engine === 'codex' || session.engine === 'ollama') {
            spawnCodexForMessage(session, msg.text, ws);
          } else {
            spawnClaudeForMessage(session, msg.text, ws);
          }
        }
      } catch (e) {}
    });

    ws.on('close', () => {
      session.ws = null;
      session.status = 'disconnected';
      const project = config.projects.find(p => p.id === session.projectId);
      if (project && session.persistentId) {
        updateChatSessionMeta(project, session.persistentId, {
          status: 'disconnected',
          lastActivityAt: new Date().toISOString()
        });
      }
      // Grace period: keep in-memory session for 45s to allow reconnect
      session.cleanupTimer = setTimeout(() => {
        if (session.process && !session.process.killed) {
          try { session.process.kill('SIGTERM'); } catch (e) {}
        }
        chatSessions.delete(sessionId);
      }, 45000);
    });

    ws.on('error', (err) => {
      console.error('WebSocket error:', err.message);
    });
  });

  // ===== HTTP Routes =====

  router.post('/api/projects/:id/chat/start', requireAuth, (req, res) => {
    const project = config.projects.find(p => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const requestedEngine = req.body?.engine || 'claude';
    if (!VALID_ENGINES.has(requestedEngine)) return res.status(400).json({ error: 'Invalid engine' });
    const { model = 'sonnet', forceNew = false } = req.body;
    const engine = requestedEngine;
    const resolvedModel = resolveChatModel(engine, model);
    const now = new Date().toISOString();

    if (!forceNew) {
      const inMemoryEntry = [...chatSessions.entries()].find(([, sess]) => isMatchingProjectEngineSession(sess, req.params.id, engine));
      if (inMemoryEntry) {
        const [existingSessionId, existingSession] = inMemoryEntry;
        if (existingSession.cleanupTimer) {
          clearTimeout(existingSession.cleanupTimer);
          existingSession.cleanupTimer = null;
        }
        existingSession.model = resolvedModel;
        existingSession.status = 'pending';
        if (project && existingSession.persistentId) {
          updateChatSessionMeta(project, existingSession.persistentId, {
            model: resolvedModel,
            status: 'active',
            lastActivityAt: now
          });
        }
        return res.json({ sessionId: existingSessionId, model: resolvedModel, engine, reused: true });
      }

      const latestPersistentSession = getLatestProjectEngineSession(project, engine);
      if (latestPersistentSession) {
        updateChatSessionMeta(project, latestPersistentSession.id, {
          model: resolvedModel,
          status: 'active',
          lastActivityAt: now
        });
        const refreshed = normalizeSessionRecord({
          ...latestPersistentSession,
          model: resolvedModel,
          status: 'active',
          lastActivityAt: now
        });
        chatSessions.set(latestPersistentSession.id, buildRuntimeSession(project, refreshed, latestPersistentSession.id));
        return res.json({ sessionId: latestPersistentSession.id, model: resolvedModel, engine, reused: true });
      }
    }

    cleanupInMemorySessions(req.params.id, engine, project);

    const sessionId = crypto.randomUUID();

    const persistentSession = {
      id: sessionId,
      engineSessionId: null,
      claudeSessionId: null,
      model: resolvedModel,
      engine: engine,
      messages: [],
      createdAt: now,
      lastActivityAt: now,
      status: 'active',
      firstMessage: null
    };
    upsertChatSession(project, persistentSession);

    chatSessions.set(sessionId, {
      projectId: req.params.id,
      projectPath: project.path,
      model: resolvedModel,
      engine: engine,
      engineSessionId: null,
      claudeSessionId: null,
      process: null,
      ws: null,
      status: 'pending',
      busy: false,
      persistentId: sessionId,
      currentResponseText: '',
      cleanupTimer: null,
      _config: config
    });

    res.json({ sessionId, model: resolvedModel, engine, reused: false });
  });

  router.post('/api/projects/:id/chat/stop', requireAuth, (req, res) => {
    const project = config.projects.find(p => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const engine = getRequestEngine(req, project.engine || 'claude');

    cleanupInMemorySessions(req.params.id, engine, project);

    res.json({ ok: true });
  });

  router.get('/api/projects/:id/chat/status', requireAuth, (req, res) => {
    const project = config.projects.find(p => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const engine = getRequestEngine(req, project.engine || 'claude');

    let activeSession = null;
    for (const [sessionId, sess] of chatSessions.entries()) {
      if (isMatchingProjectEngineSession(sess, req.params.id, engine)) {
        activeSession = { sessionId, model: sess.model, engine: sess.engine || 'claude', status: sess.status };
        break;
      }
    }

    res.json({ active: !!activeSession, session: activeSession });
  });

  // ===== Chat Session API =====

  router.get('/api/projects/:id/chat/sessions', requireAuth, (req, res) => {
    const project = config.projects.find(p => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const sessions = readChatSessions(project).slice(0, 20).map(s => ({
      id: s.id,
      model: s.model,
      engine: s.engine || 'claude',
      createdAt: s.createdAt,
      lastActivityAt: s.lastActivityAt,
      status: s.status,
      firstMessage: s.firstMessage,
      messageCount: (s.messages || []).length
    }));
    res.json(sessions);
  });

  router.get('/api/projects/:id/chat/sessions/:sessionId', requireAuth, (req, res) => {
    const project = config.projects.find(p => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const sessions = readChatSessions(project);
    const session = sessions.find(s => s.id === req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json(normalizeSessionRecord(session));
  });

  router.delete('/api/projects/:id/chat/sessions/:sessionId', requireAuth, (req, res) => {
    const project = config.projects.find(p => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const sessions = readChatSessions(project).filter(s => s.id !== req.params.sessionId);
    writeChatSessions(project, sessions);
    res.json({ ok: true });
  });

  router.post('/api/projects/:id/chat/sessions/:sessionId/resume', requireAuth, (req, res) => {
    const project = config.projects.find(p => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { sessionId } = req.params;

    // If session is still in memory (short disconnect), just clear timer and reuse
    const existing = chatSessions.get(sessionId);
    if (existing) {
      if (existing.projectId !== req.params.id) {
        return res.status(404).json({ error: 'Session not found' });
      }
      if (existing.cleanupTimer) {
        clearTimeout(existing.cleanupTimer);
        existing.cleanupTimer = null;
      }
      existing.status = 'pending';
      return res.json({ sessionId, model: existing.model, engine: existing.engine || 'claude' });
    }

    // Load from persistent storage
    const sessions = readChatSessions(project);
    const persistent = sessions.find(s => s.id === sessionId);
    if (!persistent) return res.status(404).json({ error: 'Session not found' });

    cleanupInMemorySessions(req.params.id, persistent.engine || 'claude', project);

    chatSessions.set(sessionId, buildRuntimeSession(project, persistent, sessionId));

    updateChatSessionMeta(project, sessionId, { status: 'active', lastActivityAt: new Date().toISOString() });
    res.json({ sessionId, model: persistent.model, engine: persistent.engine || 'claude' });
  });

  return { router, setupWebSocket };
};
