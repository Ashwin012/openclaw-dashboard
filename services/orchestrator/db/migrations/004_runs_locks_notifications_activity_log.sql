-- Migration 004: Extended runs, locks, notifications, activity_log
-- Supports full worker lifecycle: retry tracking, distributed locks,
-- notification fan-out, and append-only audit trail.

-- ── runs: extend with worker / retry / progress fields ───────────────────────
ALTER TABLE runs ADD COLUMN attempt    INTEGER NOT NULL DEFAULT 1;
ALTER TABLE runs ADD COLUMN engine     TEXT;          -- claude | codex | ollama
ALTER TABLE runs ADD COLUMN model      TEXT;          -- e.g. claude-sonnet-4-6
ALTER TABLE runs ADD COLUMN worker_id  TEXT;          -- worker instance identifier
ALTER TABLE runs ADD COLUMN progress   INTEGER NOT NULL DEFAULT 0
                                        CHECK(progress BETWEEN 0 AND 100);
ALTER TABLE runs ADD COLUMN logs       TEXT;          -- accumulated run log (appended)
ALTER TABLE runs ADD COLUMN meta       TEXT;          -- JSON extra metadata

CREATE INDEX IF NOT EXISTS idx_runs_worker_id ON runs(worker_id);
CREATE INDEX IF NOT EXISTS idx_runs_attempt   ON runs(attempt);

-- ── locks: distributed advisory locks with TTL ────────────────────────────────
-- A worker acquires a lock before starting a run; expired locks are reclaimed.
CREATE TABLE IF NOT EXISTS locks (
  key         TEXT    PRIMARY KEY,             -- e.g. "task:<task_id>"
  owner       TEXT    NOT NULL,                -- worker_id or run_id
  acquired_at INTEGER NOT NULL DEFAULT (unixepoch('now','subsec') * 1000),
  expires_at  INTEGER NOT NULL,                -- epoch-ms; 0 = no expiry
  meta        TEXT                             -- JSON (reason, context…)
);

CREATE INDEX IF NOT EXISTS idx_locks_expires_at ON locks(expires_at);
CREATE INDEX IF NOT EXISTS idx_locks_owner      ON locks(owner);

-- ── notifications: fan-out to dashboard UI ───────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id        TEXT    PRIMARY KEY,
  type      TEXT    NOT NULL,   -- task_done | task_failed | run_started | run_failed | system
  title     TEXT    NOT NULL,
  body      TEXT    NOT NULL DEFAULT '',
  task_id   TEXT    REFERENCES tasks(id) ON DELETE SET NULL,
  run_id    TEXT    REFERENCES runs(id)  ON DELETE SET NULL,
  read      INTEGER NOT NULL DEFAULT 0 CHECK(read IN (0, 1)),
  ts        INTEGER NOT NULL DEFAULT (unixepoch('now','subsec') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_notifications_read    ON notifications(read);
CREATE INDEX IF NOT EXISTS idx_notifications_ts      ON notifications(ts);
CREATE INDEX IF NOT EXISTS idx_notifications_task_id ON notifications(task_id);
CREATE INDEX IF NOT EXISTS idx_notifications_type    ON notifications(type);

-- ── activity_log: append-only audit trail ────────────────────────────────────
CREATE TABLE IF NOT EXISTS activity_log (
  id          TEXT    PRIMARY KEY,
  actor       TEXT    NOT NULL,   -- worker | agent | system | user
  action      TEXT    NOT NULL,   -- e.g. task.created, run.started, lock.acquired
  entity_type TEXT    NOT NULL,   -- task | run | project | lock | notification
  entity_id   TEXT    NOT NULL,
  payload     TEXT,               -- JSON extra context
  ts          INTEGER NOT NULL DEFAULT (unixepoch('now','subsec') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_activity_log_entity    ON activity_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_activity_log_actor     ON activity_log(actor);
CREATE INDEX IF NOT EXISTS idx_activity_log_action    ON activity_log(action);
CREATE INDEX IF NOT EXISTS idx_activity_log_ts        ON activity_log(ts);
