'use strict';

const express = require('express');
const path = require('path');
const { initDb } = require('./db');
const { fullSync } = require('./lib/compat');

const app = express();
const PORT = process.env.PORT || 8092;

initDb();

// Initial bidirectional sync at startup
try {
  fullSync();
} catch (e) {
  console.error('[orchestrator] startup fullSync failed:', e.message);
}

app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'orchestrator', ts: new Date().toISOString() });
});

// Routes v1
app.use('/api/v1/projects', require('./routes/projects')());
app.use('/api/v1/tasks',    require('./routes/tasks')());
app.use('/api/v1/sync',     require('./routes/sync')());

app.listen(PORT, () => {
  console.log(`Orchestrator running on port ${PORT}`);
});

module.exports = app;
