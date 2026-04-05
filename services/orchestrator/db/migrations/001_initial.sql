-- Migration 001: Initial schema
-- Tables: tasks, runs, events

CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT    PRIMARY KEY,
  name        TEXT    NOT NULL,
  description TEXT,
  status      TEXT    NOT NULL DEFAULT 'pending'
                      CHECK(status IN ('pending','running','done','failed','cancelled')),
  priority    TEXT    NOT NULL DEFAULT 'normal'
                      CHECK(priority IN ('critical','high','normal','low')),
  engine      TEXT,
  model       TEXT,
  input       TEXT,   -- JSON payload passed to the engine
  created_at  INTEGER NOT NULL DEFAULT (unixepoch('now','subsec') * 1000),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch('now','subsec') * 1000)
);

CREATE TABLE IF NOT EXISTS runs (
  id          TEXT    PRIMARY KEY,
  task_id     TEXT    NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  status      TEXT    NOT NULL DEFAULT 'pending'
                      CHECK(status IN ('pending','running','done','failed','cancelled')),
  output      TEXT,   -- Final text output
  error       TEXT,   -- Error message on failure
  started_at  INTEGER,
  finished_at INTEGER,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch('now','subsec') * 1000)
);

CREATE TABLE IF NOT EXISTS events (
  id      TEXT    PRIMARY KEY,
  run_id  TEXT    NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT    NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type    TEXT    NOT NULL,  -- e.g. started, progress, tool_use, completed, failed
  payload TEXT,              -- JSON blob (tool call, partial output, etc.)
  ts      INTEGER NOT NULL DEFAULT (unixepoch('now','subsec') * 1000)
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_runs_task_id    ON runs(task_id);
CREATE INDEX IF NOT EXISTS idx_runs_status     ON runs(status);
CREATE INDEX IF NOT EXISTS idx_events_run_id   ON events(run_id);
CREATE INDEX IF NOT EXISTS idx_events_task_id  ON events(task_id);
CREATE INDEX IF NOT EXISTS idx_events_ts       ON events(ts);
