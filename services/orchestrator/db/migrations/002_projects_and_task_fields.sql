-- Migration 002: Projects table + task fields (project_id, assignee, tags)

CREATE TABLE IF NOT EXISTS projects (
  id          TEXT    PRIMARY KEY,
  name        TEXT    NOT NULL,
  description TEXT    NOT NULL DEFAULT '',
  status      TEXT    NOT NULL DEFAULT 'active'
                      CHECK(status IN ('active','archived','paused')),
  created_at  INTEGER NOT NULL DEFAULT (unixepoch('now','subsec') * 1000),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch('now','subsec') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);

-- Extend tasks with relational + filter fields
ALTER TABLE tasks ADD COLUMN project_id TEXT DEFAULT NULL;
ALTER TABLE tasks ADD COLUMN assignee   TEXT NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN tags       TEXT NOT NULL DEFAULT '[]';

CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status     ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_priority   ON tasks(priority);
CREATE INDEX IF NOT EXISTS idx_tasks_engine     ON tasks(engine);
