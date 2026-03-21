module.exports = function createChatRoutes({ config, requireAuth, server }) {
  const router = require('express').Router();
  const WebSocket = require('ws');
  const crypto = require('crypto');
  const { spawn } = require('child_process');
  const path = require('path');

  const wss = new WebSocket.Server({ noServer: true });
  const chatSessions = new Map(); // sessionId -> { projectId, projectPath, model, process, ws, status }

  // ===== Chat Session Persistence =====

  function getChatSessionsPath(project) {
    return path.join(project.path, '.claude', 'chat-sessions.json');
  }

  function readChatSessions(project) {
    const fs = require('fs');
    const p = getChatSessionsPath(project);
    if (!fs.existsSync(p)) return [];
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; }
  }

  function writeChatSessions(project, sessions) {
    const fs = require('fs');
    const dir = path.join(project.path, '.claude');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(getChatSessionsPath(project), JSON.stringify(sessions, null, 2), 'utf8');
  }

  function upsertChatSession(project, sessionData) {
    const sessions = readChatSessions(project);
    const idx = sessions.findIndex(s => s.id === sessionData.id);
    if (idx >= 0) { sessions[idx] = sessionData; } else { sessions.unshift(sessionData); }
    writeChatSessions(project, sessions);
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

    if (session.claudeSessionId) {
      args.push('--resume', session.claudeSessionId);
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
            // Save assistant response and update claudeSessionId
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
            session = {
              projectId: proj.id,
              projectPath: proj.path,
              model: fileSession.model,
              claudeSessionId: fileSession.claudeSessionId,
              process: null,
              ws: null,
              status: 'pending',
              busy: false,
              persistentId: sessionId,
              currentResponseText: '',
              cleanupTimer: null
            };
            chatSessions.set(sessionId, session);
          }
        }
      } else {
        // Fallback: scan all projects (legacy clients without projectId param)
        for (const proj of config.projects) {
          const fileSessions = readChatSessions(proj);
          const fileSession = fileSessions.find(s => s.id === sessionId);
          if (fileSession) {
            session = {
              projectId: proj.id,
              projectPath: proj.path,
              model: fileSession.model,
              claudeSessionId: fileSession.claudeSessionId,
              process: null,
              ws: null,
              status: 'pending',
              busy: false,
              persistentId: sessionId,
              currentResponseText: '',
              cleanupTimer: null
            };
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
        if (msg.type === 'user_message') {
          // Save user message to persistent session
          const project = config.projects.find(p => p.id === session.projectId);
          if (project && session.persistentId) {
            addChatMessage(project, session.persistentId, {
              role: 'user',
              content: msg.text,
              timestamp: new Date().toISOString()
            });
          }
          spawnClaudeForMessage(session, msg.text, ws);
        } else if (msg.type === 'voice_message') {
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
          spawnClaudeForMessage(session, msg.text, ws);
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

    // Clean up any existing session for this project
    for (const [sid, sess] of chatSessions.entries()) {
      if (sess.projectId === req.params.id) {
        if (sess.cleanupTimer) clearTimeout(sess.cleanupTimer);
        if (sess.process) { try { sess.process.kill(); } catch (e) {} }
        if (sess.ws) { try { sess.ws.close(); } catch (e) {} }
        chatSessions.delete(sid);
      }
    }

    const { model = 'sonnet' } = req.body;
    const modelMap = { sonnet: 'claude-sonnet-4-6', opus: 'claude-opus-4-6', haiku: 'claude-haiku-3-5' };
    const resolvedModel = modelMap[model] || model;

    const sessionId = crypto.randomUUID();
    const now = new Date().toISOString();

    const persistentSession = {
      id: sessionId,
      claudeSessionId: null,
      model: resolvedModel,
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
      claudeSessionId: null,
      process: null,
      ws: null,
      status: 'pending',
      busy: false,
      persistentId: sessionId,
      currentResponseText: '',
      cleanupTimer: null
    });

    res.json({ sessionId, model: resolvedModel });
  });

  router.post('/api/projects/:id/chat/stop', requireAuth, (req, res) => {
    const project = config.projects.find(p => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    for (const [sid, sess] of chatSessions.entries()) {
      if (sess.projectId === req.params.id) {
        if (sess.cleanupTimer) clearTimeout(sess.cleanupTimer);
        if (sess.process) { try { sess.process.kill('SIGTERM'); } catch (e) {} }
        if (sess.ws) { try { sess.ws.close(); } catch (e) {} }
        if (project && sess.persistentId) {
          updateChatSessionMeta(project, sess.persistentId, { status: 'closed', lastActivityAt: new Date().toISOString() });
        }
        chatSessions.delete(sid);
      }
    }

    res.json({ ok: true });
  });

  router.get('/api/projects/:id/chat/status', requireAuth, (req, res) => {
    const project = config.projects.find(p => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    let activeSession = null;
    for (const [sessionId, sess] of chatSessions.entries()) {
      if (sess.projectId === req.params.id) {
        activeSession = { sessionId, model: sess.model, status: sess.status };
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
    res.json(session);
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
      if (existing.cleanupTimer) {
        clearTimeout(existing.cleanupTimer);
        existing.cleanupTimer = null;
      }
      existing.status = 'pending';
      return res.json({ sessionId, model: existing.model });
    }

    // Load from persistent storage
    const sessions = readChatSessions(project);
    const persistent = sessions.find(s => s.id === sessionId);
    if (!persistent) return res.status(404).json({ error: 'Session not found' });

    // Clean up any active sessions for this project
    for (const [sid, sess] of chatSessions.entries()) {
      if (sess.projectId === req.params.id) {
        if (sess.cleanupTimer) clearTimeout(sess.cleanupTimer);
        if (sess.process) { try { sess.process.kill(); } catch (e) {} }
        if (sess.ws) { try { sess.ws.close(); } catch (e) {} }
        chatSessions.delete(sid);
      }
    }

    chatSessions.set(sessionId, {
      projectId: req.params.id,
      projectPath: project.path,
      model: persistent.model,
      claudeSessionId: persistent.claudeSessionId,
      process: null,
      ws: null,
      status: 'pending',
      busy: false,
      persistentId: sessionId,
      currentResponseText: '',
      cleanupTimer: null
    });

    updateChatSessionMeta(project, sessionId, { status: 'active', lastActivityAt: new Date().toISOString() });
    res.json({ sessionId, model: persistent.model });
  });

  return { router, setupWebSocket };
};
