require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');
const http = require('http');
const basicAuth = require('express-basic-auth');
const { readJSON } = require('./lib/json-store');

// ===== App & Server Setup =====

const app = express();
const server = http.createServer(app);
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== Public Sales Routes (Read-Only) — BEFORE session middleware =====
// These routes use basic auth only and must NOT set any session cookies.

const salesAuth = basicAuth({
  users: { 'sales': 'RoyalHeights2026*' },
  challenge: true,
  realm: 'Royal Heights Prospection'
});

const DATA_DIR_RH = path.join(__dirname, 'data', 'royal-heights');
const PROSPECTS_PATH_RH = path.join(DATA_DIR_RH, 'prospects.json');
const TASKS_PATH_RH = path.join(DATA_DIR_RH, 'prospection-tasks.json');

app.get('/sales/royal-heights', salesAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'royal-heights-sales-view.html'));
});

app.get('/sales/royal-heights/prospection', salesAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'royal-heights-sales-prospection.html'));
});

app.get('/sales/royal-heights/prospection-ia', salesAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'royal-heights-sales-prospection-ia.html'));
});

app.get('/sales/royal-heights/russia', salesAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'royal-heights-sales-russia.html'));
});

app.get('/sales/api/royal-heights/prospects', (req, res) => {
  res.json(readJSON(PROSPECTS_PATH_RH, []));
});

app.get('/sales/api/royal-heights/tasks', (req, res) => {
  res.json(readJSON(TASKS_PATH_RH, []));
});

app.get('/sales/api/royal-heights/stats', (req, res) => {
  const prospects = readJSON(PROSPECTS_PATH_RH, []);
  const total = prospects.length;
  const byStatus = {};
  prospects.forEach(p => { byStatus[p.status] = (byStatus[p.status] || 0) + 1; });
  const signed = byStatus['signed'] || 0;
  const conversionRate = total > 0 ? Math.round((signed / total) * 100) : 0;
  const bySource = {};
  prospects.forEach(p => { bySource[p.source] = (bySource[p.source] || 0) + 1; });
  res.json({ total, byStatus, bySource, conversionRate });
});

// ===== Public static assets (no auth needed) =====

// Cache-busting headers for login and service worker
app.get('/login.html', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.get('/sw.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

// Only serve truly public assets without auth: css, js, icons, manifest, index.html
app.use('/css', express.static(path.join(__dirname, 'public', 'css')));
app.use('/js', express.static(path.join(__dirname, 'public', 'js')));
app.get('/manifest.json', (req, res) => res.sendFile(path.join(__dirname, 'public', 'manifest.json')));
app.get('/index.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
// Icons
app.use('/icon-192.png', express.static(path.join(__dirname, 'public', 'icon-192.png')));
app.use('/icon-192.svg', express.static(path.join(__dirname, 'public', 'icon-192.svg')));
app.use('/icon-512.png', express.static(path.join(__dirname, 'public', 'icon-512.png')));
app.use('/icon-512.svg', express.static(path.join(__dirname, 'public', 'icon-512.svg')));
// Russian landing page — public (no auth)
app.get('/royal-heights-russia.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'royal-heights-russia.html')));
app.get('/spotify-auth.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'spotify-auth.html')));
// Royal Heights prospection data (JSON)
app.use("/data/rh", express.static(path.join(__dirname, "public", "data", "rh")));

// ===== Session middleware =====

app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// ===== Auth Middleware =====

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

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

// ===== Protected HTML pages — require session auth =====

const protectedPages = [
  'dashboard.html', 'home.html', 'chat.html', 'profile.html',
  'project.html', 'agents.html', 'royal-heights.html', 'royal-heights-prospection.html',
  'pms-compare.html', 'prospection-rh.html', 'synapcoin-marketing.html', 'synaphive-marketing.html', 'synapcoin-docs.html'
];

protectedPages.forEach(page => {
  app.get('/' + page, (req, res) => {
    if (!req.session || !req.session.authenticated) {
      return res.redirect('/login.html');
    }
    res.sendFile(path.join(__dirname, 'public', page));
  });
});

// ===== Mount Routes =====

const authRouter = require('./routes/auth')({ requireAuth });
app.use(authRouter);

const projectRouter = require('./routes/projects')({ config, requireAuth, requireAuthOrBearer });
app.use(projectRouter);

const agentRouter = require('./routes/agents')({ config, requireAuth });
app.use(agentRouter);

const { router: chatRouter, setupWebSocket } = require('./routes/chat')({ config, requireAuth, server });
app.use(chatRouter);
setupWebSocket();

const taskRouter = require('./routes/tasks')({ config, requireAuth, requireAuthOrBearer });
app.use(taskRouter);

const newsRouter = require('./routes/news')({ requireAuth });
app.use(newsRouter);

const integrationRouter = require('./routes/integrations')({ requireAuth });
app.use(integrationRouter);

const invoiceRouter = require('./routes/invoices')({ requireAuth });
app.use(invoiceRouter);

const royalHeightsRouter = require('./routes/royal-heights')({ requireAuth });
app.use(royalHeightsRouter);

const synapCoinRouter = require('./routes/synapcoin')({ requireAuth });
app.use(synapCoinRouter);

const synapHiveRouter = require('./routes/synaphive')({ requireAuth });
app.use(synapHiveRouter);

// ===== SynapCoin Docs API =====
const SYNAPCOIN_DOCS_BLACKLIST = new Set([
  "AGENTS.md", "BOOTSTRAP.md", "HEARTBEAT.md", "IDENTITY.md",
  "SOUL.md", "TOOLS.md", "USER.md", "workspace-state.json"
]);
app.get("/api/synapcoin-docs", requireAuth, (req, res) => {
  const docsDir = path.join(__dirname, "data", "synapcoin-docs");
  try {
    const files = fs.readdirSync(docsDir)
      .filter(f => !f.startsWith(".") && !SYNAPCOIN_DOCS_BLACKLIST.has(f));
    res.json(files.map(f => ({
      name: f,
      size: fs.statSync(path.join(docsDir, f)).size,
      url: "/api/synapcoin-docs/" + encodeURIComponent(f)
    })));
  } catch (e) { res.json([]); }
});
app.get("/api/synapcoin-docs/:filename", requireAuth, (req, res) => {
  const safeName = path.basename(req.params.filename);
  const filePath = path.join(__dirname, "data", "synapcoin-docs", safeName);
  if (!fs.existsSync(filePath) || SYNAPCOIN_DOCS_BLACKLIST.has(safeName)) return res.status(404).json({ error: "Not found" });
  // Let Express detect content-type from extension
  
  res.sendFile(filePath);
});

const uploadRouter = require('./routes/uploads')({ config, requireAuth });
app.use(uploadRouter);

// Serve audio files (auth-gated)
app.use('/audio', (req, res, next) => {
  if (req.session && req.session.authenticated) return next();
  res.status(401).end();
}, express.static(uploadRouter.audioDashboardDir));

// Dev projects dashboard route
app.get('/dev', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ===== Start Server =====

const PORT = process.env.PORT || 8090;
server.listen(PORT, () => {
  console.log(`Dev Dashboard running on http://localhost:${PORT}`);
});

// ===== Spotify OAuth Callback =====
app.get('/callback/spotify', (req, res) => {
  const code = req.query.code;
  const error = req.query.error;
  if (error) {
    return res.send('<h2>Spotify Authorization Failed</h2><p>' + error + '</p>');
  }
  if (code) {
    // Save code to file for Gollum to pick up
    const fs = require('fs');
    fs.writeFileSync('/tmp/spotify-auth-code.txt', code);
    return res.send('<h2>✅ Spotify Connected!</h2><p>Code received. You can close this tab.</p><p style="font-family:monospace;font-size:11px;color:#888">' + code + '</p>');
  }
  res.send('<h2>No code received</h2>');
});
