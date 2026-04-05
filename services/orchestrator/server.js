'use strict';

const express = require('express');
const path = require('path');
const { initDb } = require('./db');

const app = express();
const PORT = process.env.PORT || 8092;

initDb();

app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'orchestrator', ts: new Date().toISOString() });
});

// Routes (to be mounted)
// app.use('/api/...', require('./routes/...'));

app.listen(PORT, () => {
  console.log(`Orchestrator running on port ${PORT}`);
});

module.exports = app;
