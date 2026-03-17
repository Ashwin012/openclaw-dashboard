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
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const execAsync = promisify(exec);
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });
const chatSessions = new Map(); // sessionId -> { projectId, projectPath, model, process, ws, status }
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

function resolveRepoPath(project, repoName) {
  if (!repoName || !project.repos) return project.path;
  const repo = project.repos.find(r => r.name === repoName);
  return repo ? repo.path : project.path;
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.get("/login.html", (req, res) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.sendFile(path.join(__dirname, "public", "login.html"));
});
// Temporary: force service worker update by adding cache-busting headers to sw.js
app.get("/sw.js", (req, res) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Clear-Site-Data", '"cache", "storage"');
  res.sendFile(path.join(__dirname, "public", "sw.js"));
});
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

app.post('/api/profile/password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Champs manquants' });
    }
    const hash = process.env.AUTH_PASSWORD_HASH;
    if (!hash) return res.status(500).json({ error: 'Server misconfigured' });
    const match = await bcrypt.compare(currentPassword, hash);
    if (!match) return res.status(401).json({ error: 'Mot de passe actuel incorrect' });
    const newHash = await bcrypt.hash(newPassword, 10);
    // Update .env file
    const envPath = path.join(__dirname, '.env');
    let envContent = fs.readFileSync(envPath, 'utf8');
    envContent = envContent.replace(/^AUTH_PASSWORD_HASH=.*$/m, `AUTH_PASSWORD_HASH=${newHash}`);
    fs.writeFileSync(envPath, envContent, 'utf8');
    // Update in-memory env
    process.env.AUTH_PASSWORD_HASH = newHash;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== Passkeys (WebAuthn) =====

const PASSKEYS_FILE = path.join(__dirname, '.dashboard', 'passkeys.json');
const RP_ID = 'dashboard.infozen-consulting.com';
const RP_NAME = 'Dev Dashboard';
const ORIGIN = 'https://dashboard.infozen-consulting.com';
const passkeyChallenge = new Map(); // 'registration' | 'authentication' -> { challenge, timestamp }

function loadPasskeys() {
  if (!fs.existsSync(PASSKEYS_FILE)) return { credentials: [] };
  try { return JSON.parse(fs.readFileSync(PASSKEYS_FILE, 'utf8')); }
  catch { return { credentials: [] }; }
}

function savePasskeys(data) {
  fs.mkdirSync(path.dirname(PASSKEYS_FILE), { recursive: true });
  fs.writeFileSync(PASSKEYS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function cleanChallenges() {
  const now = Date.now();
  for (const [key, val] of passkeyChallenge) {
    if (now - val.timestamp > 5 * 60 * 1000) passkeyChallenge.delete(key);
  }
}

app.post('/api/passkeys/register-options', requireAuth, async (req, res) => {
  try {
    const data = loadPasskeys();
    const excludeCredentials = data.credentials.map(c => ({ id: c.id, type: 'public-key' }));
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userName: 'ashwin',
      userDisplayName: 'Ashwin',
      attestationType: 'none',
      excludeCredentials,
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    });
    cleanChallenges();
    passkeyChallenge.set('registration', { challenge: options.challenge, timestamp: Date.now() });
    res.json(options);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/passkeys/register-verify', requireAuth, async (req, res) => {
  try {
    const entry = passkeyChallenge.get('registration');
    if (!entry || Date.now() - entry.timestamp > 5 * 60 * 1000) {
      return res.status(400).json({ error: 'Challenge expiré' });
    }
    const verification = await verifyRegistrationResponse({
      response: req.body,
      expectedChallenge: entry.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
    });
    if (!verification.verified) return res.status(400).json({ error: 'Vérification échouée' });
    passkeyChallenge.delete('registration');
    const { registrationInfo } = verification;
    const data = loadPasskeys();
    data.credentials.push({
      id: registrationInfo.credential.id,
      publicKey: Buffer.from(registrationInfo.credential.publicKey).toString('base64'),
      counter: registrationInfo.credential.counter,
      deviceType: registrationInfo.credentialDeviceType,
      backedUp: registrationInfo.credentialBackedUp,
      addedAt: new Date().toISOString(),
    });
    savePasskeys(data);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/passkeys/auth-options', async (req, res) => {
  try {
    const data = loadPasskeys();
    const allowCredentials = data.credentials.map(c => ({ id: c.id, type: 'public-key' }));
    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      allowCredentials,
      userVerification: 'preferred',
    });
    cleanChallenges();
    passkeyChallenge.set('authentication', { challenge: options.challenge, timestamp: Date.now() });
    res.json(options);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/passkeys/auth-verify', async (req, res) => {
  try {
    const entry = passkeyChallenge.get('authentication');
    if (!entry || Date.now() - entry.timestamp > 5 * 60 * 1000) {
      return res.status(400).json({ error: 'Challenge expiré' });
    }
    const data = loadPasskeys();
    const storedCred = data.credentials.find(c => c.id === req.body.id);
    if (!storedCred) return res.status(400).json({ error: 'Clé non reconnue' });
    const verification = await verifyAuthenticationResponse({
      response: req.body,
      expectedChallenge: entry.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      credential: {
        id: storedCred.id,
        publicKey: new Uint8Array(Buffer.from(storedCred.publicKey, 'base64')),
        counter: storedCred.counter,
      },
    });
    if (!verification.verified) return res.status(401).json({ error: 'Authentification échouée' });
    passkeyChallenge.delete('authentication');
    storedCred.counter = verification.authenticationInfo.newCounter;
    savePasskeys(data);
    req.session.authenticated = true;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/passkeys', requireAuth, (req, res) => {
  try {
    const data = loadPasskeys();
    res.json({ credentials: data.credentials.map(c => ({ id: c.id, deviceType: c.deviceType, backedUp: c.backedUp, addedAt: c.addedAt })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/passkeys/:id', requireAuth, (req, res) => {
  try {
    const data = loadPasskeys();
    const before = data.credentials.length;
    data.credentials = data.credentials.filter(c => c.id !== req.params.id);
    if (data.credentials.length === before) return res.status(404).json({ error: 'Clé non trouvée' });
    savePasskeys(data);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
          const { stdout: commitLog } = await execAsync(
            'git log --format=\'{"hash":"%H","shortHash":"%h","author":"%an","date":"%aI","message":"%s"}\' -10',
            { cwd: p.path }
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
          const { stdout: cntRaw } = await execAsync('git log --since="30 days ago" --format="%H"', { cwd: p.path });
          totalCommitsLast30 = cntRaw.trim().split('\n').filter(l => l.trim()).length;
        } catch {}

        const stats = {
          totalCommits: totalCommitsLast30,
          unpushedCount: unpushed.length,
          uncommittedCount: uncommittedChanges.length,
          lastCommitDate: lastLog.trim()
        };

        const allTasks = readTasks(p);
        const taskTotal = allTasks.length;
        const taskCount = allTasks.filter(t => t.status !== 'done').length;

        return {
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
          taskCount,
          taskTotal,
          accessible: true
        };
      } catch (err) {
        return { ...p, branch: 'unknown', pendingChanges: 0, unpushedCount: 0, uncommittedCount: 0, lastActivity: null, recentCommits: [], accessible: false, taskCount: 0, taskTotal: 0, error: err.message };
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

  const MAX_FILE_DIFF = 50 * 1024;    // 50KB per file
  const MAX_TOTAL_DIFF = 512000;       // 500KB total
  const MAX_FILES = 100;
  const repoPath = resolveRepoPath(project, req.query.repo);

  try {
    const { stdout: branch } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: repoPath });
    const { stdout: statusRaw } = await execAsync('git status --porcelain', { cwd: repoPath });
    const { stdout: diffRaw } = await execAsync(
      'git diff HEAD -- ":!vendor" ":!node_modules" ":!.next" ":!storage"',
      { cwd: repoPath }
    );
    const { stdout: diffUntracked } = await execAsync(
      'git ls-files --others --exclude-standard', { cwd: repoPath }
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

    const { stdout: lastLog } = await execAsync('git log -1 --format="%ci|%s"', { cwd: repoPath });
    const [lastDate, ...subjectParts] = lastLog.trim().split('|');

    res.json({
      ...project,
      branch: branch.trim(),
      files,
      diff: fullDiff,
      lastCommitDate: lastDate,
      lastCommitMessage: subjectParts.join('|'),
      activeRepo: req.query.repo || null,
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

app.post("/api/projects/:id/pull", requireAuth, async (req, res) => {  const project = config.projects.find(p => p.id === req.params.id);  if (!project) return res.status(404).json({ error: "Project not found" });  try {    const { stdout: branchRaw } = await execAsync("git rev-parse --abbrev-ref HEAD", { cwd: project.path });    const branch = branchRaw.trim();    const { stdout, stderr } = await execAsync(`git pull origin ${branch}`, { cwd: project.path });    res.json({ ok: true, output: (stdout + stderr).trim() });  } catch (err) {    res.status(500).json({ error: err.message });  }});

app.get('/api/projects/:id/branches', requireAuth, async (req, res) => {
  const project = config.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const repoPath = resolveRepoPath(project, req.query.repo);

  try {
    const { stdout: currentRaw } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: repoPath });
    const current = currentRaw.trim();

    const { stdout: branchesRaw } = await execAsync('git branch -a', { cwd: repoPath });
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

app.post('/api/projects/:id/checkout', requireAuth, async (req, res) => {
  const project = config.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const repoPath = resolveRepoPath(project, req.query.repo);

  const { branch } = req.body;
  if (!branch) return res.status(400).json({ error: 'branch is required' });

  try {
    const { stdout: statusRaw } = await execAsync('git status --porcelain', { cwd: repoPath });
    const hasChanges = statusRaw.trim().length > 0;
    let stashPopResult = null;

    if (hasChanges) {
      await execAsync('git stash', { cwd: repoPath });
    }

    await execAsync(`git checkout ${branch}`, { cwd: repoPath });

    if (hasChanges) {
      try {
        const { stdout, stderr } = await execAsync('git stash pop', { cwd: repoPath });
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

app.get('/api/projects/:id/repos', requireAuth, async (req, res) => {
  const project = config.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const repos = project.repos || [{ name: 'main', path: project.path }];
  try {
    const result = await Promise.all(repos.map(async (repo) => {
      try {
        const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: repo.path });
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

app.get('/api/projects/:id/history', requireAuth, (req, res) => {
  const project = config.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json(readHistory(project));
});

app.get('/api/projects/:id/commits', requireAuth, async (req, res) => {
  const project = config.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  try {
    const { stdout } = await execAsync(
      'git log --format=\'{"hash":"%H","shortHash":"%h","author":"%an","email":"%ae","date":"%aI","message":"%s"}\' -50',
      { cwd: project.path }
    );

    const lines = stdout.trim().split('\n').filter(l => l.trim());
    const commits = [];
    for (const line of lines) {
      try { commits.push(JSON.parse(line)); } catch { /* skip malformed */ }
    }

    const history = readHistory(project);
    // Build lookup: approved commit message -> history entry
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

// ===== Project Config =====

app.put('/api/projects/:id/config', requireAuth, (req, res) => {
  const project = config.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const allowed = ['testUrl', 'stagingUrl', 'prodUrl', 'githubUrl', 'description'];
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
    fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== Transcription =====

const audioDashboardDir = path.join(__dirname, '.dashboard', 'audio');
if (!fs.existsSync(audioDashboardDir)) fs.mkdirSync(audioDashboardDir, { recursive: true });

// Serve saved audio files (auth-gated so they're not public)
app.use('/audio', (req, res, next) => {
  if (req.session && req.session.authenticated) return next();
  res.status(401).end();
}, express.static(audioDashboardDir));

const transcribeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

app.post('/api/transcribe', requireAuth, transcribeUpload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No audio file provided' });

  const apiKey = process.env.OPENAI_API_KEY;
  const uuid = crypto.randomUUID();
  const ext = req.file.mimetype.includes('ogg') ? 'ogg' : 'webm';
  const filename = `${uuid}.${ext}`;
  const audioFilePath = path.join(audioDashboardDir, filename);
  const audioUrl = `/audio/${filename}`;

  // Save audio file to .dashboard/audio/
  fs.writeFileSync(audioFilePath, req.file.buffer);

  // Try OpenAI Whisper API first
  if (apiKey) {
    try {
      const { OpenAI, toFile } = require('openai');
      const openai = new OpenAI({ apiKey });
      const audioFile = await toFile(req.file.buffer, `recording.${ext}`, { type: req.file.mimetype });
      const transcription = await openai.audio.transcriptions.create({
        file: audioFile,
        model: 'whisper-1'
      });
      return res.json({ text: transcription.text, audioUrl });
    } catch (err) {
      console.warn(`OpenAI transcription failed, falling back to local whisper: ${err.message}`);
    }
  }

  // Fall back to local whisper CLI
  try {
    const whisperBin = '/home/openclaw/.local/bin/whisper';
    const outDir = '/tmp/whisper-out';
    fs.mkdirSync(outDir, { recursive: true });

    await new Promise((resolve, reject) => {
      const proc = spawn(whisperBin, [
        audioFilePath,
        '--model', 'base',
        '--language', 'fr',
        '--output_format', 'txt',
        '--output_dir', outDir
      ]);

      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error('Local whisper timed out after 30s'));
      }, 30000);

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`whisper exited with code ${code}`));
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    // whisper names the output file after the input file basename
    const baseName = path.basename(audioFilePath, path.extname(audioFilePath));
    const outFile = path.join(outDir, `${baseName}.txt`);
    const text = fs.readFileSync(outFile, 'utf8').trim();
    fs.unlinkSync(outFile);

    return res.json({ text, audioUrl });
  } catch (err) {
    return res.status(500).json({ error: `Transcription failed: ${err.message}` });
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
    env: { ...process.env, PATH: '/home/openclaw/.nvm/versions/node/v20.20.1/bin:' + (process.env.PATH || '/usr/local/bin:/usr/bin:/bin'), CLAUDE_CODE_OAUTH_TOKEN: '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' },
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

app.post('/api/projects/:id/tasks/:taskId/dispatch', requireAuth, (req, res) => {
  const project = config.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const tasks = readTasks(project);
  const task = tasks.find(t => t.id === req.params.taskId);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const now = new Date().toISOString();
  task.status = 'queued';
  task.updatedAt = now;
  if (!task.notes) task.notes = [];
  task.notes.push({ author: 'system', text: 'Tâche en file d\'attente — sera traitée au prochain cycle agent', createdAt: now });
  writeTasks(project, tasks);

  res.json({ success: true });
});

// ===== /dev route (serve original projects dashboard) =====

app.get('/dev', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ===== Personal Tasks =====

const personalTasksPath = path.join(__dirname, '.dashboard', 'personal-tasks.json');

function readPersonalTasks() {
  if (!fs.existsSync(personalTasksPath)) return [];
  try { return JSON.parse(fs.readFileSync(personalTasksPath, 'utf8')).tasks || []; } catch { return []; }
}

function writePersonalTasks(tasks) {
  fs.writeFileSync(personalTasksPath, JSON.stringify({ tasks }, null, 2), 'utf8');
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
  const task = {
    id: crypto.randomUUID(),
    title: title.trim(),
    description: description || '',
    status: status || 'todo',
    priority: priority || 'medium',
    category: category || 'action',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
    notes: []
  };
  const tasks = readPersonalTasks();
  tasks.unshift(task);
  writePersonalTasks(tasks);
  res.status(201).json(task);
});

app.put('/api/personal/tasks/:id', requireAuth, (req, res) => {
  const tasks = readPersonalTasks();
  const idx = tasks.findIndex(t => t.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Task not found' });
  const old = tasks[idx];
  tasks[idx] = { ...old, ...req.body, id: old.id, updatedAt: new Date().toISOString() };
  if (req.body.status === 'done' && old.status !== 'done') {
    tasks[idx].completedAt = new Date().toISOString();
  } else if (req.body.status && req.body.status !== 'done') {
    tasks[idx].completedAt = null;
  }
  writePersonalTasks(tasks);
  res.json(tasks[idx]);
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
  const note = { author: author || 'user', text: text.trim(), timestamp: new Date().toISOString() };
  if (!task.notes) task.notes = [];
  task.notes.push(note);
  task.updatedAt = new Date().toISOString();
  writePersonalTasks(tasks);
  res.status(201).json(note);
});

// ===== News =====

const newsPath = path.join(__dirname, '.dashboard', 'news.json');

function readNews() {
  if (!fs.existsSync(newsPath)) return [];
  try { return JSON.parse(fs.readFileSync(newsPath, 'utf8')).articles || []; } catch { return []; }
}

function writeNews(articles) {
  fs.writeFileSync(newsPath, JSON.stringify({ articles }, null, 2), 'utf8');
}

app.get('/api/news', requireAuth, (req, res) => {
  let articles = readNews();
  const { category, read } = req.query;
  if (category) articles = articles.filter(a => a.category === category);
  if (read !== undefined) articles = articles.filter(a => String(a.read) === read);
  res.json(articles);
});

app.post('/api/news', requireAuth, (req, res) => {
  const { title, summary, url, source, category, publishedAt } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'Title required' });
  const article = {
    id: crypto.randomUUID(),
    title: title.trim(),
    summary: summary || '',
    url: url || '',
    source: source || '',
    category: category || 'ai',
    publishedAt: publishedAt || new Date().toISOString(),
    addedAt: new Date().toISOString(),
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
  articles[idx] = { ...articles[idx], ...req.body, id: articles[idx].id };
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

// ===== Aggregated News Feed (from fetch-news.py output) =====

const newsFeedPath = path.join(__dirname, 'data', 'news.json');

function readNewsFeed() {
  if (!fs.existsSync(newsFeedPath)) return { updatedAt: null, articles: [] };
  try { return JSON.parse(fs.readFileSync(newsFeedPath, 'utf8')); } catch { return { updatedAt: null, articles: [] }; }
}

function writeNewsFeed(data) {
  fs.writeFileSync(newsFeedPath, JSON.stringify(data, null, 2), 'utf8');
}

app.get('/api/news/feed', requireAuth, (req, res) => {
  const data = readNewsFeed();
  let articles = data.articles || [];
  const { category } = req.query;
  if (category && category !== 'all') articles = articles.filter(a => a.category === category);
  res.json({ updatedAt: data.updatedAt, articles });
});

app.post('/api/news/summarize', requireAuth, async (req, res) => {
  const { execFile } = require('child_process');
  const newsPath = path.join(__dirname, 'data', 'news.json');
  const data = readNewsFeed();
  const articles = data.articles || [];
  const needSummary = articles.filter(a => !a.summary || a.summary === a.title || a.summary.includes('Je ne'));
  const count = needSummary.length;
  if (count === 0) return res.json({ count: 0, status: 'nothing_to_do' });
  // Fire and forget: spawn summarize script
  const script = `
import json, subprocess, sys, os
path = "${newsPath.replace(/\\/g, '/')}"
d = json.load(open(path))
updated = 0
for a in d["articles"]:
    s = a.get("summary","")
    if not s or s == a["title"] or "Je ne" in s:
        try:
            prompt = f"Résume cet article en français, 3-5 lignes, style journalistique. Titre: {a['title']}. Ne dis JAMAIS 'je ne peux pas'. Si tu n'as que le titre, reformule-le en 2-3 phrases informatives.\\n"
            result = subprocess.run(["claude", "--print", "-p", prompt], capture_output=True, text=True, timeout=30, env={**os.environ, "CLAUDE_CODE_OAUTH_TOKEN": os.environ.get("CLAUDE_CODE_OAUTH_TOKEN","")})
            if result.returncode == 0 and result.stdout.strip():
                a["summary"] = result.stdout.strip()
                updated += 1
        except: pass
json.dump(d, open(path,"w"), indent=2, ensure_ascii=False)
print(f"Updated {updated} articles")
`;
  const env = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN || '' };
  const child = execFile('python3', ['-c', script], { env, timeout: 600000 }, (err) => {
    if (err) console.error('Summarize error:', err.message);
  });
  child.unref();
  res.json({ count, status: 'triggered' });
});

app.post('/api/news/:id/like', requireAuth, (req, res) => {
  const data = readNewsFeed();
  const article = (data.articles || []).find(a => a.id === req.params.id);
  if (!article) return res.status(404).json({ error: 'Article not found' });
  article.likes = (article.likes || 0) + 1;
  writeNewsFeed(data);
  res.json({ likes: article.likes, dislikes: article.dislikes });
});

app.post('/api/news/:id/dislike', requireAuth, (req, res) => {
  const data = readNewsFeed();
  const article = (data.articles || []).find(a => a.id === req.params.id);
  if (!article) return res.status(404).json({ error: 'Article not found' });
  article.dislikes = (article.dislikes || 0) + 1;
  writeNewsFeed(data);
  res.json({ likes: article.likes, dislikes: article.dislikes });
});

// ===== Worker proxy endpoints =====

const WORKER_URL = 'http://127.0.0.1:8091';

function proxyWorkerRequest(method, workerPath, res) {
  const req = http.request(`${WORKER_URL}${workerPath}`, { method }, workerRes => {
    let body = '';
    workerRes.on('data', chunk => { body += chunk; });
    workerRes.on('end', () => {
      res.status(workerRes.statusCode).set('Content-Type', 'application/json').send(body);
    });
  });
  req.on('error', err => {
    // Worker not running
    if (workerPath.startsWith('/status')) {
      res.json({ running: false, tasks: {}, count: 0 });
    } else {
      res.status(503).json({ error: 'Worker not available', detail: err.message });
    }
  });
  req.end();
}

app.get('/api/worker/status', requireAuth, (req, res) => {
  proxyWorkerRequest('GET', '/status', res);
});

app.post('/api/worker/stop', requireAuth, (req, res) => {
  const project = req.query.project;
  const workerPath = project ? `/stop?project=${encodeURIComponent(project)}` : '/stop';
  proxyWorkerRequest('POST', workerPath, res);
});

// ===== Notifications (no auth — called by cron agent) =====

const NOTIFICATIONS_PATH = path.join(__dirname, '.dashboard', 'notifications.json');

app.get('/api/notifications', (req, res) => {
  try {
    if (!fs.existsSync(NOTIFICATIONS_PATH)) {
      return res.json({ pending: [] });
    }
    let data = { pending: [] };
    try { data = JSON.parse(fs.readFileSync(NOTIFICATIONS_PATH, 'utf8')); } catch { data = { pending: [] }; }
    if (!Array.isArray(data.pending)) data.pending = [];

    const notifications = data.pending;

    // Atomically clear
    const empty = { pending: [] };
    const tmp = `${NOTIFICATIONS_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(empty, null, 2), 'utf8');
    fs.renameSync(tmp, NOTIFICATIONS_PATH);

    res.json({ pending: notifications });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== Profile / Password management =====

const ENV_PATH = path.join(__dirname, '.env');

app.post('/api/profile/password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Missing fields' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    const hash = process.env.AUTH_PASSWORD_HASH;
    if (!hash) return res.status(500).json({ error: 'Server misconfigured' });

    const match = await bcrypt.compare(currentPassword, hash);
    if (!match) return res.status(401).json({ error: 'Mot de passe actuel incorrect' });

    const newHash = await bcrypt.hash(newPassword, 12);

    // Update .env file
    let envContent = fs.readFileSync(ENV_PATH, 'utf8');
    if (/^AUTH_PASSWORD_HASH=.*/m.test(envContent)) {
      envContent = envContent.replace(/^AUTH_PASSWORD_HASH=.*/m, `AUTH_PASSWORD_HASH=${newHash}`);
    } else {
      envContent += `\nAUTH_PASSWORD_HASH=${newHash}`;
    }
    fs.writeFileSync(ENV_PATH, envContent, 'utf8');

    // Update in-memory value
    process.env.AUTH_PASSWORD_HASH = newHash;

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== Trading Bot Proxy =====

let tradingBotToken = null;
let tradingBotTokenExpiry = 0;

function parseDotEnv(content) {
  const vars = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    vars[key] = val;
  }
  return vars;
}

async function getTradingBotToken(email, password, forceRefresh = false) {
  if (!forceRefresh && tradingBotToken && Date.now() < tradingBotTokenExpiry) {
    return tradingBotToken;
  }
  const body = new URLSearchParams({ username: email, password });
  const res = await fetch('http://localhost:8000/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  if (!res.ok) throw new Error(`Trading bot auth failed: ${res.status}`);
  const data = await res.json();
  tradingBotToken = data.access_token;
  tradingBotTokenExpiry = Date.now() + 50 * 60 * 1000; // 50 min
  return tradingBotToken;
}

app.get('/api/trading-status', requireAuth, async (req, res) => {
  try {
    const envPath = '/home/openclaw/projects/trading-bot/.env';
    if (!fs.existsSync(envPath)) {
      return res.status(503).json({ error: 'Trading bot .env not found' });
    }
    const env = parseDotEnv(fs.readFileSync(envPath, 'utf8'));
    const email = env.ADMIN_EMAIL;
    const password = env.ADMIN_PASSWORD;
    if (!email || !password) {
      return res.status(503).json({ error: 'ADMIN_EMAIL or ADMIN_PASSWORD missing from trading-bot .env' });
    }

    const fetchWithAuth = async (url, token) => {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (r.status === 401) throw Object.assign(new Error('401'), { is401: true });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    };

    let token;
    try {
      token = await getTradingBotToken(email, password);
    } catch (e) {
      return res.status(503).json({ error: `Auth failed: ${e.message}` });
    }

    const runWithRetry = async (url) => {
      try {
        return await fetchWithAuth(url, token);
      } catch (e) {
        if (e.is401) {
          token = await getTradingBotToken(email, password, true);
          return fetchWithAuth(url, token);
        }
        throw e;
      }
    };

    const base = 'http://localhost:8000';
    const [kpis, positions, summary, status] = await Promise.allSettled([
      runWithRetry(`${base}/api/data/kpis`),
      runWithRetry(`${base}/api/data/positions`),
      runWithRetry(`${base}/api/data/summary`),
      runWithRetry(`${base}/api/bot/status`)
    ]);

    res.json({
      kpis: kpis.status === 'fulfilled' ? kpis.value : null,
      positions: positions.status === 'fulfilled' ? positions.value : null,
      summary: summary.status === 'fulfilled' ? summary.value : null,
      status: status.status === 'fulfilled' ? status.value : null,
      errors: {
        kpis: kpis.status === 'rejected' ? kpis.reason.message : null,
        positions: positions.status === 'rejected' ? positions.reason.message : null,
        summary: summary.status === 'rejected' ? summary.reason.message : null,
        status: status.status === 'rejected' ? status.reason.message : null
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 8090;
server.listen(PORT, () => {
  console.log(`Dev Dashboard running on http://localhost:${PORT}`);
});


// ===== Invoices API =====

const INVOICES_PATH = path.join(__dirname, 'data', 'invoices.json');

function readInvoices() {
  if (!fs.existsSync(INVOICES_PATH)) return { clients: [], invoices: [], updatedAt: null };
  try { return JSON.parse(fs.readFileSync(INVOICES_PATH, 'utf8')); }
  catch { return { clients: [], invoices: [], updatedAt: null }; }
}

function writeInvoices(data) {
  data.updatedAt = new Date().toISOString();
  const tmp = INVOICES_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, INVOICES_PATH);
}

app.get('/api/invoices', requireAuth, (req, res) => {
  const data = readInvoices();

  // Compute derived status for each invoice
  const now = new Date();
  for (const inv of data.invoices) {
    if (inv.status === 'paid') continue;
    const due = new Date(inv.dueDate);
    if (now > due) {
      inv.status = 'overdue';
      inv.daysOverdue = Math.floor((now - due) / (1000 * 60 * 60 * 24));
    } else {
      inv.status = 'pending';
      inv.daysUntilDue = Math.ceil((due - now) / (1000 * 60 * 60 * 24));
    }
  }

  res.json(data);
});

app.post('/api/invoices', requireAuth, (req, res) => {
  const data = readInvoices();
  const inv = req.body;
  inv.id = 'inv-' + crypto.randomUUID().slice(0, 8);
  inv.createdAt = new Date().toISOString();
  if (!inv.status) inv.status = 'pending';
  data.invoices.push(inv);
  writeInvoices(data);
  res.json({ ok: true, invoice: inv });
});

app.patch('/api/invoices/:id', requireAuth, (req, res) => {
  const data = readInvoices();
  const inv = data.invoices.find(i => i.id === req.params.id);
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  Object.assign(inv, req.body);
  writeInvoices(data);
  res.json({ ok: true, invoice: inv });
});

app.delete('/api/invoices/:id', requireAuth, (req, res) => {
  const data = readInvoices();
  data.invoices = data.invoices.filter(i => i.id !== req.params.id);
  writeInvoices(data);
  res.json({ ok: true });
});

app.get('/api/invoices/:id', requireAuth, (req, res) => {
  const data = readInvoices();
  const inv = data.invoices.find(i => i.id === req.params.id);
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  const now = new Date();
  if (inv.status !== 'paid') {
    const due = new Date(inv.dueDate);
    if (now > due) {
      inv.status = 'overdue';
      inv.daysOverdue = Math.floor((now - due) / (1000 * 60 * 60 * 24));
    } else {
      inv.status = 'pending';
      inv.daysUntilDue = Math.ceil((due - now) / (1000 * 60 * 60 * 24));
    }
  }
  res.json(inv);
});

app.post('/api/invoices/:id/event', requireAuth, (req, res) => {
  const data = readInvoices();
  const inv = data.invoices.find(i => i.id === req.params.id);
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  if (!inv.events) inv.events = [];
  const { type, note } = req.body;
  const now = new Date().toISOString();
  inv.events.push({ type, at: now, note: note || '' });
  if (type === 'paid') { inv.status = 'paid'; inv.paidAt = now; }
  if (type === 'sent') { inv.sentAt = now; }
  writeInvoices(data);
  res.json({ ok: true, invoice: inv });
});

app.delete('/api/invoices/:id/event-last', requireAuth, (req, res) => {
  const data = readInvoices();
  const inv = data.invoices.find(i => i.id === req.params.id);
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  if (!inv.events) inv.events = [];
  const removed = inv.events.pop();
  if (removed && removed.type === 'paid') {
    inv.status = 'pending';
    inv.paidAt = null;
  }
  writeInvoices(data);
  res.json({ ok: true, invoice: inv });
});

// Client CRUD
app.post('/api/invoices/clients', requireAuth, (req, res) => {
  const data = readInvoices();
  const client = req.body;
  client.id = client.id || client.name.toLowerCase().replace(/[^a-z0-9]/g, '-');
  data.clients.push(client);
  writeInvoices(data);
  res.json({ ok: true, client });
});

app.patch('/api/invoices/clients/:id', requireAuth, (req, res) => {
  const data = readInvoices();
  const client = data.clients.find(c => c.id === req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  Object.assign(client, req.body);
  writeInvoices(data);
  res.json({ ok: true, client });
});

// ===== EQS Listings =====
const DATA_DIR_EQS = path.join(__dirname, 'data');

app.get('/api/eqs', requireAuth, (req, res) => {
  const fp = path.join(DATA_DIR_EQS, 'eqs-listings.json');
  if (!fs.existsSync(fp)) return res.json({ listings: [], updatedAt: null });
  try { res.json(JSON.parse(fs.readFileSync(fp))); }
  catch (e) { res.json({ listings: [], updatedAt: null, error: e.message }); }
});

app.post('/api/eqs/refresh', requireAuth, (req, res) => {
  const { execSync } = require('child_process');
  try {
    execSync('python3 ' + path.join(__dirname, 'scripts', 'fetch-eqs.py'), { timeout: 60000 });
    res.json(JSON.parse(fs.readFileSync(path.join(DATA_DIR_EQS, 'eqs-listings.json'))));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== Children (Pronote) =====
app.get('/api/children', requireAuth, (req, res) => {
  const fp = path.join(DATA_DIR_EQS, 'children.json');
  if (!fs.existsSync(fp)) return res.json({ children: [], updatedAt: null });
  try { res.json(JSON.parse(fs.readFileSync(fp))); }
  catch (e) { res.json({ children: [], updatedAt: null, error: e.message }); }
});

app.post('/api/children/refresh', requireAuth, (req, res) => {
  const { execSync } = require('child_process');
  try {
    execSync('python3 ' + path.join(__dirname, 'scripts', 'fetch-pronote.py'), { timeout: 30000 });
    res.json(JSON.parse(fs.readFileSync(path.join(DATA_DIR_EQS, 'children.json'))));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
