require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');
const http = require('http');

// ===== App & Server Setup =====

const app = express();
const server = http.createServer(app);
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Cache-busting headers for login and service worker
app.get('/login.html', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.get('/sw.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

app.use(express.static(path.join(__dirname, 'public')));

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

// ===== Mount Routes =====

const authRouter = require('./routes/auth')({ requireAuth });
app.use(authRouter);

const projectRouter = require('./routes/projects')({ config, requireAuth, requireAuthOrBearer });
app.use(projectRouter);

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
