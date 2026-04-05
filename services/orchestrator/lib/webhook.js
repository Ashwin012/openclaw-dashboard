'use strict';

/**
 * webhook.js — Webhook POST on task status transitions
 *
 * sendWebhook(payload): POST to config.webhookUrl
 * Payload: { event, projectId, taskId, coderEngine, coderModel, coderSummary, commitSha }
 * Timeout: 30s via AbortController
 * Never throws — errors are logged and swallowed.
 */

const fs   = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', '..', '..', 'config.json');

const WEBHOOK_TIMEOUT_MS = 30_000;

// ── Config loader (lazy, cached) ──────────────────────────────────────────────

let _webhookUrl = undefined;  // undefined = not yet loaded; null = no URL configured

function getWebhookUrl() {
  if (_webhookUrl !== undefined) return _webhookUrl;
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    _webhookUrl = cfg.webhookUrl || null;
  } catch (e) {
    console.warn('[webhook] cannot read config.json:', e.message);
    _webhookUrl = null;
  }
  return _webhookUrl;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * POST a webhook event to config.webhookUrl.
 * Fires on task transitions to review (and any other callers).
 * Silent on failure — never throws.
 *
 * @param {object} payload
 * @param {string} payload.event        — e.g. 'task_review'
 * @param {string} [payload.projectId]
 * @param {string} [payload.taskId]
 * @param {string} [payload.coderEngine]
 * @param {string} [payload.coderModel]
 * @param {string} [payload.coderSummary]
 * @param {string} [payload.commitSha]
 * @returns {Promise<void>}
 */
async function sendWebhook(payload) {
  const url = getWebhookUrl();
  if (!url) return;

  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

  try {
    const resp = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
      signal:  controller.signal,
    });

    if (!resp.ok) {
      console.warn(`[webhook] POST ${url} → HTTP ${resp.status}`);
    } else {
      console.log(`[webhook] POST ${url} → ${resp.status} (event=${payload.event})`);
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      console.warn(`[webhook] POST ${url} timed out after ${WEBHOOK_TIMEOUT_MS}ms`);
    } else {
      console.warn(`[webhook] POST ${url} failed:`, e.message);
    }
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { sendWebhook };
