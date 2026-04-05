module.exports = function createIntegrationRoutes({ requireAuth }) {
  const router = require('express').Router();
  const fs = require('fs');
  const path = require('path');
  const http = require('http');
  const { execFile } = require('child_process');
  const execFileAsync = require('util').promisify(execFile);
  const { readJSON, writeJSON } = require('../lib/json-store');

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
    const res = await fetch('http://45.77.131.11:8000/api/auth/login', {
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

  router.get('/api/trading-status', requireAuth, async (req, res) => {
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

      const base = 'http://45.77.131.11:8000';
      const [kpis, positions, summary, status, balance, trades] = await Promise.allSettled([
        runWithRetry(`${base}/api/kpis`),
        runWithRetry(`${base}/api/positions`),
        runWithRetry(`${base}/api/summary`),
        runWithRetry(`${base}/api/bot/status`),
        runWithRetry(`${base}/api/balance`),
        runWithRetry(`${base}/api/user_trades?symbol=ETHUSDC`)
      ]);

      // bot/status returns nested dict: { default: { bot_name: { strategy: { status: "running" } } } }
      const statusData = status.status === 'fulfilled' ? status.value : null;
      let isRunning = false;
      if (statusData && typeof statusData === 'object' && !Array.isArray(statusData)) {
        const walk = (obj) => {
          if (!obj || typeof obj !== 'object') return;
          if (obj.status === 'running') { isRunning = true; return; }
          for (const v of Object.values(obj)) walk(v);
        };
        walk(statusData);
      }

      // Filter active positions (non-zero positionAmt)
      const posData = positions.status === 'fulfilled' ? positions.value : null;
      const activePositions = Array.isArray(posData) ? posData.filter(p => parseFloat(p.positionAmt || 0) !== 0) : [];

      // Use summary for accurate wallet/pnl data, fall back to raw balance
      const sumData = summary.status === 'fulfilled' ? summary.value : null;
      const balData = balance.status === 'fulfilled' ? balance.value : null;
      const walletBalance = sumData ? parseFloat(sumData.wallet_usdc || 0) : (balData ? parseFloat(balData.totalWalletBalance || 0) : 0);
      const unrealizedPnl = balData ? parseFloat(balData.totalUnrealizedProfit || 0) : 0;
      const feesUsdc = sumData ? parseFloat(sumData.fees_usdc || 0) : null;
      const netPnl = sumData ? parseFloat(sumData.net_pnl || 0) : null;
      const markPrice = sumData ? parseFloat(sumData.mark_price || 0) : null;

      res.json({
        kpis: kpis.status === 'fulfilled' ? kpis.value : null,
        positions: activePositions,
        summary: sumData,
        status: { is_running: isRunning },
        balance: { wallet: walletBalance, unrealizedPnl, fees: feesUsdc, net_pnl: netPnl, mark_price: markPrice },
        trades: trades.status === 'fulfilled' ? (Array.isArray(trades.value) ? trades.value.slice().reverse() : []) : [],
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

  // ===== Polymarket Portfolio =====

  const polymarketCache = new Map(); // conditionId -> { data, expiry }

  router.get('/api/polymarket', requireAuth, async (req, res) => {
    try {
      const wallet = process.env.POLYMARKET_WALLET_ADDRESS;
      if (!wallet) {
        return res.status(503).json({ error: 'POLYMARKET_WALLET_ADDRESS not configured' });
      }

      const dataApi = 'https://data-api.polymarket.com';
      const gammaApi = 'https://gamma-api.polymarket.com';

      const [positionsRes, activityRes] = await Promise.allSettled([
        fetch(`${dataApi}/positions?user=${encodeURIComponent(wallet)}`).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }),
        fetch(`${dataApi}/activity?user=${encodeURIComponent(wallet)}&limit=20`).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      ]);

      const rawPositions = positionsRes.status === 'fulfilled' ? positionsRes.value : [];
      const rawActivity = activityRes.status === 'fulfilled' ? activityRes.value : [];

      // Enrich positions with market titles from Gamma API (cached 5min)
      const positions = Array.isArray(rawPositions) ? rawPositions : [];
      const conditionIds = [...new Set(positions.map(p => p.conditionId).filter(Boolean))];

      const marketData = {};
      const now = Date.now();
      const toFetch = conditionIds.filter(id => {
        const cached = polymarketCache.get(id);
        if (cached && cached.expiry > now) { marketData[id] = cached.data; return false; }
        return true;
      });

      if (toFetch.length > 0) {
        const marketResults = await Promise.allSettled(
          toFetch.map(id =>
            fetch(`${gammaApi}/markets?condition_id=${encodeURIComponent(id)}`).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
          )
        );
        toFetch.forEach((id, i) => {
          if (marketResults[i].status === 'fulfilled') {
            const markets = marketResults[i].value;
            const m = Array.isArray(markets) ? markets[0] : markets;
            if (m) {
              marketData[id] = { title: m.question || m.title || id, icon: m.icon || null };
              polymarketCache.set(id, { data: marketData[id], expiry: now + 5 * 60 * 1000 });
            }
          }
        });
      }

      // Build enriched positions
      const enrichedPositions = positions
        .filter(p => parseFloat(p.size || 0) !== 0)
        .map(p => {
          const market = marketData[p.conditionId] || {};
          const size = parseFloat(p.size || 0);
          const avgPrice = parseFloat(p.avgPrice || p.averagePrice || 0);
          const curPrice = parseFloat(p.currentPrice || p.price || 0);
          const pnl = size * (curPrice - avgPrice);
          const pnlPercent = avgPrice > 0 ? ((curPrice - avgPrice) / avgPrice) * 100 : 0;
          return {
            conditionId: p.conditionId,
            title: market.title || p.conditionId || '–',
            outcome: p.outcome || p.asset || '–',
            size,
            avgPrice,
            currentPrice: curPrice,
            pnl,
            pnlPercent
          };
        });

      const portfolioValue = enrichedPositions.reduce((s, p) => s + p.size * p.currentPrice, 0);

      // Build recent trades
      const activity = Array.isArray(rawActivity) ? rawActivity : [];
      const recentTrades = activity.map(t => {
        const market = marketData[t.conditionId] || {};
        return {
          title: market.title || t.conditionId || '–',
          side: t.side || t.type || '–',
          outcome: t.outcome || t.asset || '–',
          price: parseFloat(t.price || 0),
          size: parseFloat(t.size || t.amount || 0),
          timestamp: t.timestamp || t.createdAt || null
        };
      });

      res.json({
        wallet,
        portfolioValue,
        positions: enrichedPositions,
        recentTrades,
        errors: {
          positions: positionsRes.status === 'rejected' ? positionsRes.reason.message : null,
          activity: activityRes.status === 'rejected' ? activityRes.reason.message : null
        }
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ===== EQS Listings (DISABLED) =====

  const DATA_DIR = path.join(__dirname, '..', 'data');

  /* DISABLED - EQS removed
  router.get('/api/eqs', requireAuth, (req, res) => {
    const fp = path.join(DATA_DIR, 'eqs-listings.json');
    if (!fs.existsSync(fp)) return res.json({ listings: [], updatedAt: null });
    try { res.json(JSON.parse(fs.readFileSync(fp))); }
    catch (e) { res.json({ listings: [], updatedAt: null, error: e.message }); }
  });

  router.post('/api/eqs/refresh', requireAuth, async (req, res) => {
    try {
      await execFileAsync('python3', [path.join(__dirname, '..', 'scripts', 'fetch-eqs.py')], { timeout: 120000 });
      res.json(JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'eqs-listings.json'))));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  */

  // ===== Children (Pronote) =====

  router.get('/api/children', requireAuth, (req, res) => {
    const fp = path.join(DATA_DIR, 'children.json');
    if (!fs.existsSync(fp)) return res.json({ children: [], updatedAt: null });
    try { res.json(JSON.parse(fs.readFileSync(fp))); }
    catch (e) { res.json({ children: [], updatedAt: null, error: e.message }); }
  });

  router.post('/api/children/refresh', requireAuth, async (req, res) => {
    try {
      await execFileAsync('python3', [path.join(__dirname, '..', 'scripts', 'fetch-pronote.py')], { timeout: 30000 });
      res.json(JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'children.json'))));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ===== Worker proxy endpoints =====

  const WORKER_URL = 'http://127.0.0.1:8092';

  function proxyWorkerRequest(req, res, workerPath) {
    const workerReq = http.request(`${WORKER_URL}${workerPath}`, {
      method: req.method,
      headers: req.method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
    }, workerRes => {
      let body = '';
      workerRes.on('data', chunk => { body += chunk; });
      workerRes.on('end', () => {
        res.status(workerRes.statusCode).set('Content-Type', 'application/json').send(body);
      });
    });
    workerReq.on('error', err => {
      // Worker not running
      if (workerPath.startsWith('/status')) {
        res.json({ running: false, tasks: [], count: 0, maxConcurrency: null, task: null, pendingQuestion: null });
      } else {
        res.status(503).json({ error: 'Worker not available', detail: err.message });
      }
    });
    if (req.method === 'POST') {
      const body = req.body && Object.keys(req.body).length ? JSON.stringify(req.body) : '';
      if (body) workerReq.write(body);
      workerReq.end();
      return;
    }
    workerReq.end();
  }

  router.get('/api/worker/status', requireAuth, (req, res) => {
    proxyWorkerRequest(req, res, '/status');
  });

  router.post('/api/worker/stop', requireAuth, (req, res) => {
    const params = new URLSearchParams();
    if (req.query.project) params.set('project', req.query.project);
    if (req.query.taskId) params.set('taskId', req.query.taskId);
    const workerPath = params.toString() ? `/stop?${params.toString()}` : '/stop';
    proxyWorkerRequest(req, res, workerPath);
  });

  router.get('/api/worker/question', requireAuth, (req, res) => {
    const params = new URLSearchParams();
    if (req.query.project) params.set('project', req.query.project);
    if (req.query.taskId) params.set('taskId', req.query.taskId);
    const workerPath = params.toString() ? `/question?${params.toString()}` : '/question';
    proxyWorkerRequest(req, res, workerPath);
  });

  router.post('/api/worker/answer', requireAuth, (req, res) => {
    const params = new URLSearchParams();
    if (req.query.project) params.set('project', req.query.project);
    if (req.query.taskId) params.set('taskId', req.query.taskId);
    const workerPath = params.toString() ? `/answer?${params.toString()}` : '/answer';
    proxyWorkerRequest(req, res, workerPath);
  });

  router.get('/api/worker/output', requireAuth, (req, res) => {
    const params = new URLSearchParams();
    if (req.query.project) params.set('project', req.query.project);
    if (req.query.taskId) params.set('taskId', req.query.taskId);
    const workerPath = params.toString() ? `/output?${params.toString()}` : '/output';
    proxyWorkerRequest(req, res, workerPath);
  });

  // ===== Notifications (no auth — called by cron agent) =====

  const NOTIFICATIONS_PATH = path.join(__dirname, '..', '.dashboard', 'notifications.json');

  router.get('/api/notifications', (req, res) => {
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

  return router;
};
