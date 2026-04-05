/**
 * Polymarket Deals Finder — API routes
 * Serves deals data, supports dismiss/star actions, and can trigger refresh.
 */

const express = require('express');
const path = require('path');
const { readJSON, writeJSON } = require('../lib/json-store');
const { execFile } = require('child_process');

const DATA_PATH = path.join(__dirname, '..', 'data', 'polymarket-deals.json');
const DEFAULT_DATA = { updatedAt: '', deals: [], stats: {} };

module.exports = function ({ requireAuth }) {
  const router = express.Router();

  // GET /api/polymarket-deals — List all deals
  router.get('/api/polymarket-deals', requireAuth, (req, res) => {
    const data = readJSON(DATA_PATH, DEFAULT_DATA);
    const showDismissed = req.query.dismissed === 'true';
    const minScore = parseInt(req.query.minScore) || 0;
    const starredOnly = req.query.starred === 'true';

    let deals = data.deals || [];

    if (!showDismissed) {
      deals = deals.filter(d => !d.dismissed);
    }
    if (minScore > 0) {
      deals = deals.filter(d => d.score >= minScore);
    }
    if (starredOnly) {
      deals = deals.filter(d => d.starred);
    }

    res.json({
      updatedAt: data.updatedAt,
      deals,
      stats: data.stats || {},
    });
  });

  // POST /api/polymarket-deals/:id/dismiss — Dismiss a deal
  router.post('/api/polymarket-deals/:id/dismiss', requireAuth, (req, res) => {
    const data = readJSON(DATA_PATH, DEFAULT_DATA);
    const deal = (data.deals || []).find(d => d.id === req.params.id);
    if (!deal) return res.status(404).json({ error: 'Deal not found' });

    deal.dismissed = true;
    writeJSON(DATA_PATH, data);
    res.json({ ok: true });
  });

  // POST /api/polymarket-deals/:id/star — Toggle star on a deal
  router.post('/api/polymarket-deals/:id/star', requireAuth, (req, res) => {
    const data = readJSON(DATA_PATH, DEFAULT_DATA);
    const deal = (data.deals || []).find(d => d.id === req.params.id);
    if (!deal) return res.status(404).json({ error: 'Deal not found' });

    deal.starred = !deal.starred;
    writeJSON(DATA_PATH, data);
    res.json({ ok: true, starred: deal.starred });
  });

  // POST /api/polymarket-deals/refresh — Trigger manual refresh
  router.post('/api/polymarket-deals/refresh', requireAuth, (req, res) => {
    const script = path.join(__dirname, '..', 'fetch-polymarket-deals.py');
    execFile('python3', [script], { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) {
        console.error('[polymarket-deals] refresh error:', stderr || err.message);
        return res.status(500).json({ error: 'Refresh failed', details: (stderr || err.message).slice(0, 500) });
      }
      const data = readJSON(DATA_PATH, DEFAULT_DATA);
      res.json({
        ok: true,
        updatedAt: data.updatedAt,
        stats: data.stats || {},
      });
    });
  });

  return router;
};
