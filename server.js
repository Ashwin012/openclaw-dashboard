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
        const { stdout: lastLog } = await execAsync('git log -1 --format="%ci"', { cwd: p.path });
        const changedFiles = status.trim().split('\n').filter(l => l.trim()).length;
        const recentActivity = readHistory(p).slice(0, 5);
        const branchName = branch.trim();
        const unpushed = await getUnpushedCommits(p, branchName);
        return {
          ...p,
          branch: branchName,
          pendingChanges: changedFiles,
          unpushedCount: unpushed.length,
          lastActivity: lastLog.trim(),
          recentActivity,
          accessible: true
        };
      } catch (err) {
        return { ...p, branch: 'unknown', pendingChanges: 0, unpushedCount: 0, lastActivity: null, recentActivity: [], accessible: false, error: err.message };
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
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const sessionId = pathname.slice('/ws/chat/'.length);
  const session = chatSessions.get(sessionId);

  if (!session) {
    ws.send(JSON.stringify({ type: 'error', error: 'Session not found or expired' }));
    ws.close(1008, 'Session not found');
    return;
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
        spawnClaudeForMessage(session, msg.text, ws);
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    session.ws = null;
    session.status = 'disconnected';
    if (session.process && !session.process.killed) {
      try { session.process.kill('SIGTERM'); } catch (e) {}
    }
    chatSessions.delete(sessionId);
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
      if (sess.process) { try { sess.process.kill(); } catch (e) {} }
      if (sess.ws) { try { sess.ws.close(); } catch (e) {} }
      chatSessions.delete(sid);
    }
  }

  const { model = 'sonnet' } = req.body;
  const modelMap = { sonnet: 'claude-sonnet-4-6', opus: 'claude-opus-4-6', haiku: 'claude-haiku-3-5' };
  const resolvedModel = modelMap[model] || model;

  const sessionId = crypto.randomUUID();
  chatSessions.set(sessionId, {
    projectId: req.params.id,
    projectPath: project.path,
    model: resolvedModel,
    claudeSessionId: null,
    process: null,
    ws: null,
    status: 'pending',
    busy: false
  });

  res.json({ sessionId, model: resolvedModel });
});

app.post('/api/projects/:id/chat/stop', requireAuth, (req, res) => {
  const project = config.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  for (const [sid, sess] of chatSessions.entries()) {
    if (sess.projectId === req.params.id) {
      if (sess.process) { try { sess.process.kill('SIGTERM'); } catch (e) {} }
      if (sess.ws) { try { sess.ws.close(); } catch (e) {} }
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

const PORT = process.env.PORT || 8090;
server.listen(PORT, () => {
  console.log(`Dev Dashboard running on http://localhost:${PORT}`);
});
