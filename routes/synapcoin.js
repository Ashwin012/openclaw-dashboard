module.exports = function createSynapCoinRoutes({ requireAuth }) {
  const router = require('express').Router();
  const crypto = require('crypto');
  const path = require('path');
  const fs = require('fs');
  const { readJSON, writeJSON } = require('../lib/json-store');

  const DATA_DIR = path.join(__dirname, '..', 'data', 'synapcoin');
  const ACTIVITIES_PATH = path.join(DATA_DIR, 'activities.json');
  const COMMUNITY_PATH = path.join(DATA_DIR, 'community.json');

  // Ensure data dir exists
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const DEFAULT_COMMUNITY = [
    { platform: 'twitter',  label: 'Twitter / X', followers: 0, icon: '🐦', url: '', updatedAt: new Date().toISOString() },
    { platform: 'discord',  label: 'Discord',      followers: 0, icon: '💬', url: '', updatedAt: new Date().toISOString() },
    { platform: 'telegram', label: 'Telegram',     followers: 0, icon: '📱', url: '', updatedAt: new Date().toISOString() },
    { platform: 'reddit',   label: 'Reddit',       followers: 0, icon: '🔗', url: '', updatedAt: new Date().toISOString() },
    { platform: 'github',   label: 'GitHub',       followers: 0, icon: '⭐', url: 'https://github.com/Ashwin012/synapcoin', updatedAt: new Date().toISOString() },
    { platform: 'linkedin', label: 'LinkedIn',     followers: 0, icon: '💼', url: '', updatedAt: new Date().toISOString() },
  ];

  function readActivities() { return readJSON(ACTIVITIES_PATH, []); }
  function writeActivities(data) { writeJSON(ACTIVITIES_PATH, data); }
  function readCommunity() { return readJSON(COMMUNITY_PATH, DEFAULT_COMMUNITY); }
  function writeCommunity(data) { writeJSON(COMMUNITY_PATH, data); }

  // ===== Stats =====

  router.get('/api/synapcoin/stats', requireAuth, (req, res) => {
    const activities = readActivities();
    const community = readCommunity();
    const totalDone = activities.filter(a => a.status === 'done').length;
    const totalPlanned = activities.filter(a => a.status === 'planned').length;
    const totalEngagement = activities.reduce((sum, a) => {
      const e = a.engagement || {};
      return sum + (e.likes || 0) + (e.reposts || 0) + (e.comments || 0) + (e.clicks || 0);
    }, 0);
    const totalCommunitySize = community.reduce((sum, c) => sum + (c.followers || 0), 0);
    const byPlatform = {};
    const byStatus = { done: 0, planned: 0, cancelled: 0 };
    for (const a of activities) {
      byPlatform[a.platform] = (byPlatform[a.platform] || 0) + 1;
      byStatus[a.status] = (byStatus[a.status] || 0) + 1;
    }
    res.json({ totalDone, totalPlanned, totalEngagement, totalCommunitySize, byPlatform, byStatus, activityCount: activities.length });
  });

  // ===== Activities =====

  router.get('/api/synapcoin/activities', requireAuth, (req, res) => {
    res.json(readActivities());
  });

  router.post('/api/synapcoin/activities', requireAuth, (req, res) => {
    const activities = readActivities();
    const activity = {
      id: crypto.randomUUID(),
      type: req.body.type || 'post',
      platform: req.body.platform || 'other',
      title: req.body.title || '',
      content: req.body.content || '',
      url: req.body.url || '',
      status: req.body.status || 'planned',
      engagement: req.body.engagement || { likes: 0, reposts: 0, comments: 0, clicks: 0 },
      tags: req.body.tags || [],
      notes: req.body.notes || '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      publishedAt: req.body.publishedAt || null,
    };
    activities.push(activity);
    writeActivities(activities);
    res.json({ ok: true, activity });
  });

  router.put('/api/synapcoin/activities/:id', requireAuth, (req, res) => {
    const activities = readActivities();
    const idx = activities.findIndex(a => a.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    const updated = { ...activities[idx], ...req.body, id: activities[idx].id, updatedAt: new Date().toISOString() };
    if (req.body.status === 'done' && !activities[idx].publishedAt) {
      updated.publishedAt = new Date().toISOString();
    }
    activities[idx] = updated;
    writeActivities(activities);
    res.json({ ok: true, activity: activities[idx] });
  });

  router.delete('/api/synapcoin/activities/:id', requireAuth, (req, res) => {
    const activities = readActivities();
    const idx = activities.findIndex(a => a.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    activities.splice(idx, 1);
    writeActivities(activities);
    res.json({ ok: true });
  });

  // ===== Documents =====

  const DOCS_PATH = process.env.SYNAPCOIN_DOCS_PATH || '/home/node/.openclaw/workspaces/synapcoin-docs';

  router.get('/api/synapcoin/docs', requireAuth, (req, res) => {
    try {
      if (!fs.existsSync(DOCS_PATH)) {
        return res.json({ files: [], error: `Directory not found: ${DOCS_PATH}` });
      }
      const entries = fs.readdirSync(DOCS_PATH, { withFileTypes: true });
      const files = entries
        .filter(e => e.isFile())
        .map(e => {
          const stat = fs.statSync(path.join(DOCS_PATH, e.name));
          return { name: e.name, size: stat.size, mtime: stat.mtime.toISOString() };
        })
        .sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
      res.json({ files });
    } catch (err) {
      res.json({ files: [], error: err.message });
    }
  });

  router.get('/api/synapcoin/docs/:filename', requireAuth, (req, res) => {
    const filename = req.params.filename;
    if (!filename || /[/\\]/.test(filename) || filename.startsWith('.')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    const filePath = path.join(DOCS_PATH, filename);
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(DOCS_PATH) + path.sep)) {
      return res.status(400).json({ error: 'Invalid path' });
    }
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }
    res.download(filePath);
  });

  // ===== Community =====

  router.get('/api/synapcoin/community', requireAuth, (req, res) => {
    res.json(readCommunity());
  });

  router.put('/api/synapcoin/community/:platform', requireAuth, (req, res) => {
    const community = readCommunity();
    const idx = community.findIndex(c => c.platform === req.params.platform);
    if (idx === -1) return res.status(404).json({ error: 'Platform not found' });
    community[idx] = { ...community[idx], ...req.body, platform: community[idx].platform, updatedAt: new Date().toISOString() };
    writeCommunity(community);
    res.json({ ok: true, platform: community[idx] });
  });

  // ===== Twitter Marketing =====
  const MARKETING_DIR = path.join(__dirname, '..', 'data', 'synapcoin-marketing');
  const TWITTER_PATH = path.join(MARKETING_DIR, 'twitter.json');
  const TELEGRAM_PATH = path.join(MARKETING_DIR, 'telegram.json');

  fs.mkdirSync(MARKETING_DIR, { recursive: true });

  const DEFAULT_TWITTER = { stats: { followers: 0, engagementRate: 0 }, tweets: [] };
  const DEFAULT_TELEGRAM = { stats: { members: 0 }, messages: [] };

  function readTwitter() { return readJSON(TWITTER_PATH, JSON.parse(JSON.stringify(DEFAULT_TWITTER))); }
  function writeTwitter(data) { writeJSON(TWITTER_PATH, data); }
  function readTelegram() { return readJSON(TELEGRAM_PATH, JSON.parse(JSON.stringify(DEFAULT_TELEGRAM))); }
  function writeTelegram(data) { writeJSON(TELEGRAM_PATH, data); }

  // Twitter stats (must be before /:id to avoid conflict)
  router.get('/api/synapcoin/twitter/stats', requireAuth, (req, res) => {
    const data = readTwitter();
    res.json(data.stats);
  });

  router.put('/api/synapcoin/twitter/stats', requireAuth, (req, res) => {
    const data = readTwitter();
    if (req.body.followers !== undefined) data.stats.followers = parseInt(req.body.followers) || 0;
    if (req.body.engagementRate !== undefined) data.stats.engagementRate = parseFloat(req.body.engagementRate) || 0;
    data.stats.updatedAt = new Date().toISOString();
    writeTwitter(data);
    res.json({ ok: true, stats: data.stats });
  });

  // Twitter tweets CRUD
  router.get('/api/synapcoin/twitter', requireAuth, (req, res) => {
    res.json(readTwitter());
  });

  router.post('/api/synapcoin/twitter', requireAuth, (req, res) => {
    const data = readTwitter();
    const tweet = {
      id: crypto.randomUUID(),
      content: req.body.content || '',
      date: req.body.date || new Date().toISOString(),
      likes: parseInt(req.body.likes) || 0,
      retweets: parseInt(req.body.retweets) || 0,
      impressions: parseInt(req.body.impressions) || 0,
      url: req.body.url || '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    data.tweets.push(tweet);
    writeTwitter(data);
    res.json({ ok: true, tweet });
  });

  router.put('/api/synapcoin/twitter/:id', requireAuth, (req, res) => {
    const data = readTwitter();
    const idx = data.tweets.findIndex(t => t.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Tweet not found' });
    const t = data.tweets[idx];
    if (req.body.content !== undefined) t.content = req.body.content;
    if (req.body.date !== undefined) t.date = req.body.date;
    if (req.body.likes !== undefined) t.likes = parseInt(req.body.likes) || 0;
    if (req.body.retweets !== undefined) t.retweets = parseInt(req.body.retweets) || 0;
    if (req.body.impressions !== undefined) t.impressions = parseInt(req.body.impressions) || 0;
    if (req.body.url !== undefined) t.url = req.body.url;
    t.updatedAt = new Date().toISOString();
    data.tweets[idx] = t;
    writeTwitter(data);
    res.json({ ok: true, tweet: t });
  });

  router.delete('/api/synapcoin/twitter/:id', requireAuth, (req, res) => {
    const data = readTwitter();
    const idx = data.tweets.findIndex(t => t.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Tweet not found' });
    data.tweets.splice(idx, 1);
    writeTwitter(data);
    res.json({ ok: true });
  });

  // ===== Telegram Marketing =====

  // Telegram stats (must be before /:id)
  router.get('/api/synapcoin/telegram/stats', requireAuth, (req, res) => {
    const data = readTelegram();
    res.json(data.stats);
  });

  router.put('/api/synapcoin/telegram/stats', requireAuth, (req, res) => {
    const data = readTelegram();
    if (req.body.members !== undefined) data.stats.members = parseInt(req.body.members) || 0;
    data.stats.updatedAt = new Date().toISOString();
    writeTelegram(data);
    res.json({ ok: true, stats: data.stats });
  });

  // Telegram messages CRUD
  router.get('/api/synapcoin/telegram', requireAuth, (req, res) => {
    res.json(readTelegram());
  });

  router.post('/api/synapcoin/telegram', requireAuth, (req, res) => {
    const data = readTelegram();
    const msg = {
      id: crypto.randomUUID(),
      content: req.body.content || '',
      date: req.body.date || new Date().toISOString(),
      views: parseInt(req.body.views) || 0,
      url: req.body.url || '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    data.messages.push(msg);
    writeTelegram(data);
    res.json({ ok: true, message: msg });
  });

  router.put('/api/synapcoin/telegram/:id', requireAuth, (req, res) => {
    const data = readTelegram();
    const idx = data.messages.findIndex(m => m.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Message not found' });
    const m = data.messages[idx];
    if (req.body.content !== undefined) m.content = req.body.content;
    if (req.body.date !== undefined) m.date = req.body.date;
    if (req.body.views !== undefined) m.views = parseInt(req.body.views) || 0;
    if (req.body.url !== undefined) m.url = req.body.url;
    m.updatedAt = new Date().toISOString();
    data.messages[idx] = m;
    writeTelegram(data);
    res.json({ ok: true, message: m });
  });

  router.delete('/api/synapcoin/telegram/:id', requireAuth, (req, res) => {
    const data = readTelegram();
    const idx = data.messages.findIndex(m => m.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Message not found' });
    data.messages.splice(idx, 1);
    writeTelegram(data);
    res.json({ ok: true });
  });


  return router;
};
