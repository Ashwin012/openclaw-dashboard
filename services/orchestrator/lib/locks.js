'use strict';

/**
 * locks.js — Singleton guard + per-project advisory locks
 *
 * Singleton: PID-file based (process-level, crash-safe)
 * Advisory locks: SQLite `locks` table (keyed, TTL-aware)
 */

const fs   = require('fs');
const path = require('path');
const { getDb } = require('../db');

const PID_FILE = process.env.WORKER_PID_FILE
  || path.join(__dirname, '..', 'data', 'worker.pid');

// ─── Singleton (PID file) ─────────────────────────────────────────────────────

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Acquire the singleton worker lock via PID file.
 * Returns true if this process is the sole worker, false if another is running.
 */
function acquireSingleton() {
  if (fs.existsSync(PID_FILE)) {
    const raw = fs.readFileSync(PID_FILE, 'utf8').trim();
    const existing = parseInt(raw, 10);
    if (!isNaN(existing) && existing !== process.pid && isProcessAlive(existing)) {
      console.warn(`[locks] singleton blocked — worker already running (PID ${existing})`);
      return false;
    }
    console.log(`[locks] singleton: stale PID file (${existing}), reclaiming`);
  }

  const dir = path.dirname(PID_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
  return true;
}

function releaseSingleton() {
  try { fs.unlinkSync(PID_FILE); } catch {}
}

// ─── Advisory DB locks ────────────────────────────────────────────────────────

/**
 * Acquire a named advisory lock.
 * @param {string} key    — e.g. "task:<id>" or "project:<id>"
 * @param {string} owner  — worker_id or run_id
 * @param {number} ttlMs  — TTL in ms; 0 = no expiry
 * @param {object} [meta] — extra metadata stored as JSON
 * @returns {boolean} true if acquired (or renewed), false if held by another owner
 */
function acquire(key, owner, ttlMs = 0, meta = null) {
  const db  = getDb();
  const now = Date.now();
  const expiresAt = ttlMs > 0 ? now + ttlMs : 0;

  const existing = db.prepare('SELECT * FROM locks WHERE key = ?').get(key);
  if (existing) {
    const expired = existing.expires_at > 0 && existing.expires_at <= now;
    if (!expired) {
      if (existing.owner === owner) {
        // Renew our own lock
        db.prepare('UPDATE locks SET acquired_at = ?, expires_at = ? WHERE key = ?')
          .run(now, expiresAt, key);
        return true;
      }
      return false; // locked by another owner
    }
    // Expired — reclaim
    db.prepare('DELETE FROM locks WHERE key = ?').run(key);
  }

  db.prepare(
    'INSERT INTO locks (key, owner, acquired_at, expires_at, meta) VALUES (?, ?, ?, ?, ?)'
  ).run(key, owner, now, expiresAt, meta ? JSON.stringify(meta) : null);

  return true;
}

/**
 * Release a lock. Only succeeds when the caller is the owner.
 * @returns {boolean} true if released
 */
function release(key, owner) {
  const result = getDb()
    .prepare('DELETE FROM locks WHERE key = ? AND owner = ?')
    .run(key, owner);
  return result.changes > 0;
}

/**
 * Check whether a key is currently locked (non-expired).
 * Deletes the lock inline if it has expired.
 */
function isLocked(key) {
  const db   = getDb();
  const lock = db.prepare('SELECT * FROM locks WHERE key = ?').get(key);
  if (!lock) return false;
  if (lock.expires_at > 0 && lock.expires_at <= Date.now()) {
    db.prepare('DELETE FROM locks WHERE key = ?').run(key);
    return false;
  }
  return true;
}

/**
 * Delete all expired locks. Returns the number of reclaimed entries.
 */
function reclaimExpired() {
  const result = getDb()
    .prepare('DELETE FROM locks WHERE expires_at > 0 AND expires_at <= ?')
    .run(Date.now());
  if (result.changes > 0) {
    console.log(`[locks] reclaimed ${result.changes} expired lock(s)`);
  }
  return result.changes;
}

// ─── Key builders ─────────────────────────────────────────────────────────────

const taskKey    = (taskId)    => `task:${taskId}`;
const projectKey = (projectId) => `project:${projectId}`;

module.exports = {
  acquireSingleton,
  releaseSingleton,
  acquire,
  release,
  isLocked,
  reclaimExpired,
  taskKey,
  projectKey,
};
