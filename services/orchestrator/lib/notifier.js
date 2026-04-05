'use strict';

/**
 * notifier.js — Dashboard notifications + activity log
 *
 * addNotification(entry): append to .dashboard/notifications.json (pending array)
 * logActivity(entry):     append to .dashboard/activity-log.json (200-entry sliding window)
 *
 * Terminal statuses logged: review, done, approved, rejected, failed, validating, queued
 * Both writes are atomic (write-to-tmp + rename). Never throw.
 */

const fs   = require('fs');
const path = require('path');

const NOTIFICATIONS_PATH = process.env.DASHBOARD_NOTIFICATIONS_PATH
  || path.join(__dirname, '..', '..', '..', '.dashboard', 'notifications.json');

const ACTIVITY_LOG_PATH = process.env.DASHBOARD_ACTIVITY_LOG_PATH
  || path.join(__dirname, '..', '..', '..', '.dashboard', 'activity-log.json');

const ACTIVITY_LOG_MAX = 200;

// Statuses that should be logged in the activity log
const TERMINAL_STATUSES = new Set(['review', 'done', 'approved', 'rejected', 'failed', 'validating', 'queued']);

// ── Atomic JSON write helper ───────────────────────────────────────────────────

function atomicWrite(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Append a notification to .dashboard/notifications.json pending array.
 * Format matches the legacy task-worker format for dashboard compat.
 *
 * @param {object} entry
 * @param {string} [entry.projectName]
 * @param {string} [entry.taskTitle]
 * @param {string} [entry.taskId]
 * @param {string} [entry.fromStatus]
 * @param {string} [entry.toStatus]
 * @param {string} [entry.message]
 */
function addNotification(entry) {
  try {
    const data = readJson(NOTIFICATIONS_PATH, { pending: [] });
    if (!Array.isArray(data.pending)) data.pending = [];

    data.pending.push({
      projectName: entry.projectName || '',
      taskTitle:   entry.taskTitle   || '',
      taskId:      entry.taskId      || '',
      fromStatus:  entry.fromStatus  || '',
      toStatus:    entry.toStatus    || '',
      message:     entry.message     || '',
      timestamp:   new Date().toISOString(),
    });

    atomicWrite(NOTIFICATIONS_PATH, data);
  } catch (e) {
    console.warn('[notifier] addNotification failed:', e.message);
  }
}

/**
 * Append an entry to .dashboard/activity-log.json.
 * Enforces a 200-entry sliding window (drops oldest when over limit).
 * Only logs if the `toStatus` field is a terminal status (or no status provided).
 *
 * @param {object} entry — arbitrary fields; `ts` is added automatically if absent
 */
function logActivity(entry) {
  try {
    // Skip non-terminal transitions if toStatus is provided
    if (entry.toStatus && !TERMINAL_STATUSES.has(entry.toStatus)) return;

    const data = readJson(ACTIVITY_LOG_PATH, { log: [] });
    if (!Array.isArray(data.log)) data.log = [];

    data.log.push({ ts: new Date().toISOString(), ...entry });

    // Sliding window: keep only the last ACTIVITY_LOG_MAX entries
    if (data.log.length > ACTIVITY_LOG_MAX) {
      data.log = data.log.slice(data.log.length - ACTIVITY_LOG_MAX);
    }

    atomicWrite(ACTIVITY_LOG_PATH, data);
  } catch (e) {
    console.warn('[notifier] logActivity failed:', e.message);
  }
}

module.exports = { addNotification, logActivity, TERMINAL_STATUSES };
