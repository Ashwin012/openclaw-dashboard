/**
 * Webhook routes — receives task lifecycle events from the task worker.
 * 
 * POST /api/webhook/task-review
 *   Called when a task transitions to "review" status.
 *   Appends the event to data/review-queue.json for the OpenClaw cron dispatcher.
 */
module.exports = function createWebhookRoutes({ config }) {
  const router = require('express').Router();
  const crypto = require('crypto');
  const fs = require('fs');
  const path = require('path');

  const REVIEW_QUEUE_PATH = path.join(__dirname, '..', 'data', 'review-queue.json');

  function readReviewQueue() {
    try {
      if (!fs.existsSync(REVIEW_QUEUE_PATH)) return { pending: [] };
      const data = JSON.parse(fs.readFileSync(REVIEW_QUEUE_PATH, 'utf8'));
      if (!data || !Array.isArray(data.pending)) return { pending: [] };
      return data;
    } catch {
      return { pending: [] };
    }
  }

  function writeReviewQueue(data) {
    const dir = path.dirname(REVIEW_QUEUE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${REVIEW_QUEUE_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, REVIEW_QUEUE_PATH);
  }

  /**
   * POST /api/webhook/task-review
   * 
   * Expects JSON body with fields from the task worker's sendWebhook():
   *   event, projectId, projectName, taskId, taskTitle,
   *   coderEngine, coderModel, coderSummary, commitSha, timestamp
   * 
   * No auth required — this endpoint is only reachable from localhost (127.0.0.1).
   */
  router.post('/api/webhook/task-review', (req, res) => {
    try {
      const body = req.body || {};

      // Validate required fields
      if (!body.projectId || !body.taskId) {
        return res.status(400).json({ error: 'Missing required fields: projectId, taskId' });
      }

      // Build review queue entry
      const entry = {
        id: crypto.randomUUID(),
        projectId: body.projectId,
        projectName: body.projectName || body.projectId,
        taskId: body.taskId,
        taskTitle: body.taskTitle || '',
        coderEngine: body.coderEngine || 'claude',
        coderModel: body.coderModel || '',
        coderSummary: body.coderSummary || '',
        commitSha: body.commitSha || '',
        receivedAt: new Date().toISOString(),
      };

      // Read current queue, append, write
      const queue = readReviewQueue();
      queue.pending.push(entry);
      writeReviewQueue(queue);

      console.log(`[webhook] Task review queued: ${entry.projectName}/${entry.taskId} (queue id: ${entry.id})`);

      res.json({ ok: true, id: entry.id });
    } catch (err) {
      console.error('[webhook] Error processing task-review webhook:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * GET /api/webhook/review-queue
   * Debug endpoint to view the current review queue.
   */
  router.get('/api/webhook/review-queue', (req, res) => {
    const queue = readReviewQueue();
    res.json(queue);
  });

  return router;
};
