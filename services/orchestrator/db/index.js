'use strict';

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.ORCHESTRATOR_DB_PATH
  || path.join(__dirname, '..', 'data', 'orchestrator.db');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

let db;

function getDb() {
  if (!db) throw new Error('Database not initialized — call initDb() first');
  return db;
}

function runMigrations(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      filename   TEXT    NOT NULL UNIQUE,
      applied_at INTEGER NOT NULL DEFAULT (unixepoch('now','subsec') * 1000)
    )
  `);

  const applied = new Set(
    database.prepare('SELECT filename FROM _migrations').all().map(r => r.filename)
  );

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const filename of files) {
    if (applied.has(filename)) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
    database.exec(sql);
    database.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(filename);
    console.log(`[db] migration applied: ${filename}`);
  }
}

function initDb() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  runMigrations(db);
  console.log(`[db] ready at ${DB_PATH}`);
  return db;
}

module.exports = { initDb, getDb };
