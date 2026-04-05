-- Migration 003: task_events table for compat layer conflict/sync logging

CREATE TABLE IF NOT EXISTS task_events (
  id      TEXT    PRIMARY KEY,
  task_id TEXT    NOT NULL,
  type    TEXT    NOT NULL,  -- sync_insert_db, sync_update_db, sync_insert_json, sync_update_json, sync_conflict
  payload TEXT,              -- JSON: { source, project, ts_json, ts_db, ... }
  ts      INTEGER NOT NULL DEFAULT (unixepoch('now','subsec') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_task_events_task_id ON task_events(task_id);
CREATE INDEX IF NOT EXISTS idx_task_events_ts      ON task_events(ts);
CREATE INDEX IF NOT EXISTS idx_task_events_type    ON task_events(type);
