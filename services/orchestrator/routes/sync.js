'use strict';

const { Router } = require('express');
const { fullSync } = require('../lib/compat');

module.exports = function syncRouter() {
  const router = Router();

  // POST /api/v1/sync — trigger bidirectional sync (tasks.json ↔ SQLite)
  router.post('/', (req, res) => {
    try {
      const result = fullSync();
      res.json(result);
    } catch (e) {
      console.error('[sync] fullSync failed:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return router;
};
