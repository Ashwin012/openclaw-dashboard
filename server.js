require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const WebSocket = require('ws');
const multer = require('multer');

const execAsync = promisify(exec);
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });
const chatSessions = new Map(); // sessionId -> { projectId, projectPath, model, process, ws, status }
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// ===== History helpers =====

function getHistoryPath(project) {
  return path.join(project.path, '.claude', 'history.json');
}

function readHistory(project) {
  const p = getHistoryPath(project);
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return []; }
}

function appendHistory(project, entry) {
  const dir = path.join(project.path, '.claude');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const entries = readHistory(project);
  entries.unshift(entry);
  fs.writeFileSync(getHistoryPath(project), JSON.stringify(entries, null, 2), 'utf8');
}

async function captureProjectState(project) {
  const { stdout: statusRaw } = await execAsync('git status --porcelain', { cwd: project.path });
  const { stdout: diffRaw } = await execAsync('git diff HEAD', { cwd: project.path });
  const { stdout: diffUntracked } = await execAsync('git ls-files --others --exclude-standard', { cwd: project.path });

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

// ===== Chat Session Persistence =====

function getChatSessionsPath(project) {
  return path.join(project.path, '.claude', 'chat-sessions.json');
}

function readChatSessions(project) {
  const p = getChatSessionsPath(project);
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; }
}

function writeChatSessions(project, sessions) {
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

// ===== Auth =====

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

app.post('/api/login', async (req, res) => {
  try {
    const { password } = req.body;
    const hash = process.env.AUTH_PASSWORD_HASH;
    if (!hash) return res.status(500).json({ error: 'Server misconfigured' });
    const match = await bcrypt.compare(password, hash);
    if (match) {
      req.session.authenticated = true;
      res.json({ ok: true });
    } else {
      res.status(401).json({ error: 'Invalid password' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/session', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.authenticated) });
});

// ===== Projects =====

async function getUnpushedCommits(project, branch) {
  try {
    const { stdout } = await execAsync(
      `git log origin/${branch}..HEAD --format="%H|%s|%an|%ai"`,
      { cwd: project.path }
    );
    return stdout.trim().split('\n').filter(l => l.trim()).map(line => {
      const [hash, ...rest] = line.split('|');
      // rest: subject, author, date (date may contain |)
      const date = rest.pop();
      const author = rest.pop();
      const message = rest.join('|');
      return { hash, message, author, date };
    });
  } catch {
    // No remote tracking branch — return all commits
    try {
      const { stdout } = await execAsync(
        'git log --format="%H|%s|%an|%ai"',
        { cwd: project.path }
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

app.get('/api/projects', requireAuth, async (req, res) => {
  try {
    const projects = await Promise.all(config.projects.map(async (p) => {
      try {
        const { stdout: branch } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: p.path });
        const { stdout: status } = await execAsync('git status --porcelain', { cwd: p.path });
        const { stdout: lastLog } = await execAsync('git log -1 --format="%ci|||%s|||%an"', { cwd: p.path });
        const changedFiles = status.trim().split('\n').filter(l => l.trim()).length;
        const recentActivity = readHistory(p).slice(0, 5);
        const branchName = branch.trim();
        const unpushed = await getUnpushedCommits(p, branchName);
        const [lastActivity, lastCommitMessage, lastCommitAuthor] = lastLog.trim().split('|||');
        const taskCount = readTasks(p).length;
        return {
          ...p,
          branch: branchName,
          pendingChanges: changedFiles,
          unpushedCount: unpushed.length,
          lastActivity: lastActivity || null,
          lastCommitMessage: lastCommitMessage || '',
          lastCommitAuthor: lastCommitAuthor || '',
          taskCount,
          recentActivity,
          accessible: true
        };
      } catch (err) {
        return { ...p, branch: 'unknown', pendingChanges: 0, unpushedCount: 0, lastActivity: null, lastCommitMessage: '', lastCommitAuthor: '', taskCount: 0, recentActivity: [], accessible: false, error: err.message };
      }
    }));
    res.json(projects);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/projects/:id', requireAuth, async (req, res) => {
  const project = config.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  try {
    const { stdout: branch } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: project.path });
    const { stdout: statusRaw } = await execAsync('git status --porcelain', { cwd: project.path });
    const { stdout: diffRaw } = await execAsync('git diff HEAD', { cwd: project.path });
    const { stdout: diffUntracked } = await execAsync(
      'git ls-files --others --exclude-standard', { cwd: project.path }
    );

    const statusLines = statusRaw.trim().split('\n').filter(l => l.trim());
    const files = statusLines.map(line => {
      const statusCode = line.substring(0, 2).trim();
      const filePath = line.substring(3).trim();
      return { status: statusCode, path: filePath };
    });

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

    const { stdout: lastLog } = await execAsync('git log -1 --format="%ci|%s"', { cwd: project.path });
    const [lastDate, ...subjectParts] = lastLog.trim().split('|');

    res.json({
      ...project,
      branch: branch.trim(),
      files,
      diff: fullDiff,
      lastCommitDate: lastDate,
      lastCommitMessage: subjectParts.join('|'),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/projects/:id/unpushed', requireAuth, async (req, res) => {
  const project = config.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  try {
    const { stdout: branchRaw } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: project.path });
    const branch = branchRaw.trim();
    const commits = await getUnpushedCommits(project, branch);

    const commitsWithDiff = await Promise.all(commits.map(async (c) => {
      try {
        const { stdout: diff } = await execAsync(`git diff ${c.hash}~1 ${c.hash}`, { cwd: project.path });
        return { ...c, diff };
      } catch {
        // First commit has no parent
        try {
          const { stdout: diff } = await execAsync(`git show ${c.hash}`, { cwd: project.path });
          return { ...c, diff };
        } catch { return { ...c, diff: '' }; }
      }
    }));

    res.json(commitsWithDiff);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/projects/:id/push', requireAuth, async (req, res) => {
  const project = config.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  try {
    const { stdout: branchRaw } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: project.path });
    const branch = branchRaw.trim();
    const { stdout, stderr } = await execAsync(`git push origin ${branch}`, { cwd: project.path });
    res.json({ ok: true, output: stdout + stderr });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/projects/:id/history', requireAuth, (req, res) => {
  const project = config.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json(readHistory(project));
});

app.post('/api/projects/:id/approve', requireAuth, async (req, res) => {
  const project = config.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { message } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: 'Commit message required' });

  try {
    const { files, diff } = await captureProjectState(project);

    await execAsync('git add -A', { cwd: project.path });
    const safeMsg = message.replace(/"/g, '\\"');
    const { stdout, stderr } = await execAsync(`git commit -m "${safeMsg}"`, { cwd: project.path });

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

app.post('/api/projects/:id/reject', requireAuth, async (req, res) => {
  const project = config.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  try {
    const { files } = await captureProjectState(project);

    await execAsync('git restore .', { cwd: project.path });
    await execAsync('git clean -fd', { cwd: project.path });

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

app.post('/api/projects/:id/instruct', requireAuth, async (req, res) => {
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

// ===== Transcription =====

const transcribeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

app.post('/api/transcribe', requireAuth, transcribeUpload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No audio file provided' });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'OPENAI_API_KEY not configured. Voice transcription unavailable.' });

  try {
    const { OpenAI, toFile } = require('openai');
    const openai = new OpenAI({ apiKey });
    const audioFile = await toFile(req.file.buffer, 'recording.webm', { type: req.file.mimetype });
    const transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: 'whisper-1'
    });
    res.json({ text: transcription.text });
  } catch (err) {
    res.status(500).json({ error: `Transcription failed: ${err.message}` });
  }
});

// ===== File Upload =====

function makeAttachmentStorage() {
  return multer.diskStorage({
    destination: (req, file, cb) => {
      const project = config.projects.find(p => p.id === req.params.id);
      if (!project) return cb(new Error('Project not found'));
      const dir = path.join(project.path, '.claude', 'uploads');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ts = Date.now();
      const ext = path.extname(file.originalname);
      const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_.-]/g, '_');
      cb(null, `${ts}_${base}${ext}`);
    }
  });
}

const attachmentUpload = multer({
  storage: makeAttachmentStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

app.post('/api/projects/:id/upload', requireAuth, attachmentUpload.single('file'), (req, res) => {
  const project = config.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!req.file) return res.status(400).json({ error: 'No file provided' });
  res.json({
    ok: true,
    filename: req.file.filename,
    originalname: req.file.originalname,
    filePath: req.file.path,
    relativePath: path.relative(project.path, req.file.path),
    size: req.file.size,
    mimetype: req.file.mimetype
  });
});

// ===== Chat / WebSocket =====

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
    env: { ...process.env },
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

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const sessionId = url.pathname.slice('/ws/chat/'.length);
  const querySessionId = url.searchParams.get('sessionId');
  let session = chatSessions.get(sessionId);

  // If not in memory, try to restore from persistent storage (handles server restarts)
  if (!session) {
    const lookupId = sessionId || querySessionId;
    if (lookupId) {
      for (const proj of config.projects) {
        const fileSessions = readChatSessions(proj);
        const fileSession = fileSessions.find(s => s.id === lookupId);
        if (fileSession) {
          // Restore in-memory session from file
          session = {
            projectId: proj.id,
            projectPath: proj.path,
            model: fileSession.model,
            claudeSessionId: fileSession.claudeSessionId,
            process: null,
            ws: null,
            status: 'pending',
            busy: false,
            persistentId: lookupId,
            currentResponseText: '',
            cleanupTimer: null
          };
          chatSessions.set(lookupId, session);
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

app.post('/api/projects/:id/chat/start', requireAuth, (req, res) => {
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

app.post('/api/projects/:id/chat/stop', requireAuth, (req, res) => {
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

app.get('/api/projects/:id/chat/status', requireAuth, (req, res) => {
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

app.get('/api/projects/:id/chat/sessions', requireAuth, (req, res) => {
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

app.get('/api/projects/:id/chat/sessions/:sessionId', requireAuth, (req, res) => {
  const project = config.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const sessions = readChatSessions(project);
  const session = sessions.find(s => s.id === req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session);
});

app.delete('/api/projects/:id/chat/sessions/:sessionId', requireAuth, (req, res) => {
  const project = config.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const sessions = readChatSessions(project).filter(s => s.id !== req.params.sessionId);
  writeChatSessions(project, sessions);
  res.json({ ok: true });
});

app.post('/api/projects/:id/chat/sessions/:sessionId/resume', requireAuth, (req, res) => {
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

// ===== Tasks =====

function getTasksPath(project) {
  return path.join(project.path, '.claude', 'tasks.json');
}

function readTasks(project) {
  const p = getTasksPath(project);
  if (!fs.existsSync(p)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(data.tasks) ? data.tasks : [];
  } catch { return []; }
}

function writeTasks(project, tasks) {
  const dir = path.join(project.path, '.claude');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getTasksPath(project), JSON.stringify({ tasks }, null, 2), 'utf8');
}

// Auth middleware that accepts session cookie OR Bearer token (password) for agent API access
async function requireAuthOrBearer(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      const hash = process.env.AUTH_PASSWORD_HASH;
      if (hash && await bcrypt.compare(token, hash)) return next();
    } catch {}
  }
  res.status(401).json({ error: 'Unauthorized' });
}

app.get('/api/projects/:id/tasks', requireAuth, (req, res) => {
  const project = config.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  let tasks = readTasks(project);
  const { status, priority, assignee, tags } = req.query;
  if (status) tasks = tasks.filter(t => t.status === status);
  if (priority) tasks = tasks.filter(t => t.priority === priority);
  if (assignee) tasks = tasks.filter(t => t.assignee === assignee);
  if (tags) {
    const tagList = tags.split(',').map(t => t.trim()).filter(Boolean);
    tasks = tasks.filter(t => t.tags && tagList.some(tag => t.tags.includes(tag)));
  }
  res.json(tasks);
});

app.post('/api/projects/:id/tasks', requireAuthOrBearer, (req, res) => {
  const project = config.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { title, description, status, priority, assignee, tags } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'Title required' });

  const now = new Date().toISOString();
  const task = {
    id: crypto.randomUUID(),
    title: title.trim(),
    description: description || '',
    status: status || 'todo',
    priority: priority || 'medium',
    assignee: assignee || 'agent',
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    notes: [],
    tags: Array.isArray(tags) ? tags : (tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : [])
  };

  const tasks = readTasks(project);
  tasks.push(task);
  writeTasks(project, tasks);
  res.status(201).json(task);
});

app.put('/api/projects/:id/tasks/:taskId', requireAuthOrBearer, (req, res) => {
  const project = config.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const tasks = readTasks(project);
  const idx = tasks.findIndex(t => t.id === req.params.taskId);
  if (idx < 0) return res.status(404).json({ error: 'Task not found' });

  const now = new Date().toISOString();
  const task = tasks[idx];
  const updates = req.body;

  const allowed = ['title', 'description', 'status', 'priority', 'assignee', 'tags'];
  for (const field of allowed) {
    if (updates[field] !== undefined) {
      if (field === 'tags' && !Array.isArray(updates[field])) {
        task[field] = updates[field] ? updates[field].split(',').map(t => t.trim()).filter(Boolean) : [];
      } else {
        task[field] = updates[field];
      }
    }
  }

  if (updates.status === 'done' && !task.completedAt) {
    task.completedAt = now;
  } else if (updates.status && updates.status !== 'done') {
    task.completedAt = null;
  }

  task.updatedAt = now;
  tasks[idx] = task;
  writeTasks(project, tasks);
  res.json(task);
});

app.delete('/api/projects/:id/tasks/:taskId', requireAuth, (req, res) => {
  const project = config.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const tasks = readTasks(project);
  const idx = tasks.findIndex(t => t.id === req.params.taskId);
  if (idx < 0) return res.status(404).json({ error: 'Task not found' });

  tasks.splice(idx, 1);
  writeTasks(project, tasks);
  res.json({ ok: true });
});

app.post('/api/projects/:id/tasks/:taskId/notes', requireAuthOrBearer, (req, res) => {
  const project = config.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const tasks = readTasks(project);
  const task = tasks.find(t => t.id === req.params.taskId);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const { author, text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'Note text required' });

  const note = {
    author: author || 'agent',
    text: text.trim(),
    timestamp: new Date().toISOString()
  };

  if (!task.notes) task.notes = [];
  task.notes.push(note);
  task.updatedAt = new Date().toISOString();
  writeTasks(project, tasks);
  res.status(201).json(note);
});

// ===== Dashboard Personal Data =====

const DASHBOARD_DIR = path.join(__dirname, '.dashboard');
function ensureDashboardDir() {
  if (!fs.existsSync(DASHBOARD_DIR)) fs.mkdirSync(DASHBOARD_DIR, { recursive: true });
}

// --- Personal Tasks ---
function readPersonalTasks() {
  const p = path.join(DASHBOARD_DIR, 'personal-tasks.json');
  if (!fs.existsSync(p)) return [];
  try { const d = JSON.parse(fs.readFileSync(p, 'utf8')); return Array.isArray(d.tasks) ? d.tasks : []; } catch { return []; }
}
function writePersonalTasks(tasks) {
  ensureDashboardDir();
  fs.writeFileSync(path.join(DASHBOARD_DIR, 'personal-tasks.json'), JSON.stringify({ tasks }, null, 2), 'utf8');
}

app.get('/api/personal/tasks', requireAuth, (req, res) => {
  let tasks = readPersonalTasks();
  const { status, category, priority } = req.query;
  if (status) tasks = tasks.filter(t => t.status === status);
  if (category) tasks = tasks.filter(t => t.category === category);
  if (priority) tasks = tasks.filter(t => t.priority === priority);
  res.json(tasks);
});

app.post('/api/personal/tasks', requireAuth, (req, res) => {
  const { title, description, status, priority, category } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'Title required' });
  const now = new Date().toISOString();
  const task = {
    id: crypto.randomUUID(),
    title: title.trim(),
    description: description || '',
    status: status || 'todo',
    priority: priority || 'medium',
    category: category || 'action',
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    notes: []
  };
  const tasks = readPersonalTasks();
  tasks.push(task);
  writePersonalTasks(tasks);
  res.status(201).json(task);
});

app.put('/api/personal/tasks/:id', requireAuth, (req, res) => {
  const tasks = readPersonalTasks();
  const idx = tasks.findIndex(t => t.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Task not found' });
  const task = tasks[idx];
  const now = new Date().toISOString();
  ['title', 'description', 'status', 'priority', 'category'].forEach(f => {
    if (req.body[f] !== undefined) task[f] = req.body[f];
  });
  if (req.body.status === 'done' && !task.completedAt) task.completedAt = now;
  else if (req.body.status && req.body.status !== 'done') task.completedAt = null;
  task.updatedAt = now;
  tasks[idx] = task;
  writePersonalTasks(tasks);
  res.json(task);
});

app.delete('/api/personal/tasks/:id', requireAuth, (req, res) => {
  const tasks = readPersonalTasks();
  const idx = tasks.findIndex(t => t.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Task not found' });
  tasks.splice(idx, 1);
  writePersonalTasks(tasks);
  res.json({ ok: true });
});

app.post('/api/personal/tasks/:id/notes', requireAuth, (req, res) => {
  const tasks = readPersonalTasks();
  const task = tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const { author, text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'Note text required' });
  const note = { author: author || 'gollum', text: text.trim(), timestamp: new Date().toISOString() };
  if (!task.notes) task.notes = [];
  task.notes.push(note);
  task.updatedAt = new Date().toISOString();
  writePersonalTasks(tasks);
  res.status(201).json(note);
});

// --- News ---
function readNews() {
  const p = path.join(DASHBOARD_DIR, 'news.json');
  if (!fs.existsSync(p)) return [];
  try { const d = JSON.parse(fs.readFileSync(p, 'utf8')); return Array.isArray(d.articles) ? d.articles : []; } catch { return []; }
}
function writeNews(articles) {
  ensureDashboardDir();
  fs.writeFileSync(path.join(DASHBOARD_DIR, 'news.json'), JSON.stringify({ articles }, null, 2), 'utf8');
}

app.get('/api/news', requireAuth, (req, res) => {
  let articles = readNews();
  const { category, read } = req.query;
  if (category) articles = articles.filter(a => a.category === category);
  if (read !== undefined) articles = articles.filter(a => String(a.read) === read);
  res.json(articles);
});

app.post('/api/news', requireAuthOrBearer, (req, res) => {
  const { title, summary, url, source, category, publishedAt } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'Title required' });
  const now = new Date().toISOString();
  const article = {
    id: crypto.randomUUID(),
    title: title.trim(),
    summary: summary || '',
    url: url || '',
    source: source || '',
    category: category || 'ai',
    publishedAt: publishedAt || now,
    addedAt: now,
    read: false
  };
  const articles = readNews();
  articles.unshift(article);
  writeNews(articles);
  res.status(201).json(article);
});

app.put('/api/news/:id', requireAuth, (req, res) => {
  const articles = readNews();
  const idx = articles.findIndex(a => a.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Article not found' });
  ['read', 'title', 'summary', 'category'].forEach(f => {
    if (req.body[f] !== undefined) articles[idx][f] = req.body[f];
  });
  writeNews(articles);
  res.json(articles[idx]);
});

app.delete('/api/news/:id', requireAuth, (req, res) => {
  const articles = readNews();
  const idx = articles.findIndex(a => a.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Article not found' });
  articles.splice(idx, 1);
  writeNews(articles);
  res.json({ ok: true });
});

// --- Agent Activity ---
function readActivity() {
  const p = path.join(DASHBOARD_DIR, 'activity.json');
  if (!fs.existsSync(p)) return [];
  try { const d = JSON.parse(fs.readFileSync(p, 'utf8')); return Array.isArray(d.events) ? d.events : []; } catch { return []; }
}
function writeActivity(events) {
  ensureDashboardDir();
  fs.writeFileSync(path.join(DASHBOARD_DIR, 'activity.json'), JSON.stringify({ events }, null, 2), 'utf8');
}

app.get('/api/activity', requireAuth, (req, res) => {
  res.json(readActivity().slice(0, 50));
});

app.post('/api/activity', requireAuthOrBearer, (req, res) => {
  const { project, agent, action, type } = req.body;
  if (!action || !action.trim()) return res.status(400).json({ error: 'Action required' });
  const event = {
    id: crypto.randomUUID(),
    project: project || '',
    agent: agent || '',
    action: action.trim(),
    timestamp: new Date().toISOString(),
    type: type || 'task_update'
  };
  const events = readActivity();
  events.unshift(event);
  if (events.length > 200) events.splice(200);
  writeActivity(events);
  res.status(201).json(event);
});

const PORT = process.env.PORT || 8090;
server.listen(PORT, () => {
  console.log(`Dev Dashboard running on http://localhost:${PORT}`);
});
