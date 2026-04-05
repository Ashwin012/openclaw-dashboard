'use strict';

/**
 * Compat layer — bidirectional sync between tasks.json (dashboard) and SQLite (orchestrator).
 * Conflict resolution: most recent updated_at wins.
 * Conflicts are logged in the task_events table.
 */

const fs   = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db');

const CONFIG_PATH = path.join(__dirname, '..', '..', '..', 'config.json');

// ─── Status / priority mappings ─────────────────────────────────────────────

const JSON_TO_DB_STATUS = {
  'todo':        'pending',
  'queued':      'pending',
  'in-progress': 'running',
  'in_progress': 'running',   // underscore variant used by orchestrator
  'in-review':   'done',
  'in_review':   'done',      // underscore variant
  'review':      'done',      // simplified form
  'validating':  'running',   // validating = still running (agent review step)
  'done':        'done',
  'failed':      'failed',
  'cancelled':   'cancelled',
};

const DB_TO_JSON_STATUS = {
  'pending':   'queued',
  'running':   'in_progress',
  'done':      'done',
  'failed':    'failed',
  'cancelled': 'queued',    // re-queued on cancel
};

const JSON_TO_DB_PRIORITY = {
  'low':      'low',
  'medium':   'normal',
  'high':     'high',
  'critical': 'critical',
};

const DB_TO_JSON_PRIORITY = {
  'low':      'low',
  'normal':   'medium',
  'high':     'high',
  'critical': 'high',
};

// ─── Timestamp helpers ───────────────────────────────────────────────────────

function isoToMs(iso) {
  if (!iso) return 0;
  const ms = new Date(iso).getTime();
  return isNaN(ms) ? 0 : ms;
}

function msToIso(ms) {
  if (!ms) return null;
  return new Date(ms).toISOString();
}

// ─── JSON file helpers ───────────────────────────────────────────────────────

function tasksFilePath(project) {
  return path.join(project.path, '.claude', 'tasks.json');
}

function readJsonTasks(project) {
  const fp = tasksFilePath(project);
  if (!fs.existsSync(fp)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
    return Array.isArray(data.tasks) ? data.tasks : [];
  } catch {
    return [];
  }
}

function writeJsonTasks(project, tasks) {
  const fp  = tasksFilePath(project);
  const dir = path.dirname(fp);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${fp}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ tasks }, null, 2), 'utf8');
  fs.renameSync(tmp, fp);
}

// ─── Schema conversion ───────────────────────────────────────────────────────

function jsonTaskToDbRow(task, projectId) {
  const now = Date.now();
  // Pack dashboard-specific fields into input JSON (round-trip safe)
  const extra = {
    originalStatus:      task.status,
    coderPrompt:         task.coderPrompt,
    technicalAgent:      task.technicalAgent,
    coderAgent:          task.coderAgent,
    fallbackModel:       task.fallbackModel,
    commitSha:           task.commitSha,
    deployedCommit:      task.deployedCommit,
    lastCoderCommit:     task.lastCoderCommit,
    lastCoderSummary:    task.lastCoderSummary,
    lastCoderEngine:     task.lastCoderEngine,
    lastCoderModel:      task.lastCoderModel,
    optimizationLoop:    task.optimizationLoop,
    optimizationMaxLoops: task.optimizationMaxLoops,
    optimizationLoopCount: task.optimizationLoopCount,
    humanValidation:     task.humanValidation,
    completedAt:         task.completedAt,
    reviewRequestedAt:   task.reviewRequestedAt,
    deployedAt:          task.deployedAt,
    notes:               task.notes,
    metadata:            task.metadata,
  };

  return {
    id:          task.id,
    name:        task.title,
    description: task.description || '',
    status:      JSON_TO_DB_STATUS[task.status]   || 'pending',
    priority:    JSON_TO_DB_PRIORITY[task.priority] || 'normal',
    engine:      task.engine  || null,
    model:       task.model   || null,
    input:       JSON.stringify(extra),
    project_id:  projectId,
    assignee:    task.assignee || '',
    tags:        JSON.stringify(Array.isArray(task.tags) ? task.tags : []),
    created_at:  isoToMs(task.createdAt) || now,
    updated_at:  isoToMs(task.updatedAt) || now,
  };
}

function dbRowToJsonTask(row) {
  let extra = {};
  try { extra = JSON.parse(row.input || '{}'); } catch {}

  let tags = [];
  try { tags = JSON.parse(row.tags || '[]'); } catch {}

  return {
    id:                   row.id,
    title:                row.name,
    description:          row.description || '',
    status:               extra.originalStatus || DB_TO_JSON_STATUS[row.status] || 'todo',
    priority:             DB_TO_JSON_PRIORITY[row.priority] || 'medium',
    assignee:             row.assignee || 'agent',
    engine:               row.engine   || '',
    model:                row.model    || '',
    fallbackModel:        extra.fallbackModel   || '',
    technicalAgent:       extra.technicalAgent  || '',
    coderAgent:           extra.coderAgent      || '',
    coderPrompt:          extra.coderPrompt     || '',
    commitSha:            extra.commitSha       || '',
    deployedCommit:       extra.deployedCommit  || '',
    lastCoderCommit:      extra.lastCoderCommit || '',
    lastCoderSummary:     extra.lastCoderSummary || '',
    lastCoderEngine:      extra.lastCoderEngine  || '',
    lastCoderModel:       extra.lastCoderModel   || '',
    optimizationLoop:     extra.optimizationLoop     || false,
    optimizationMaxLoops: extra.optimizationMaxLoops || 2,
    optimizationLoopCount: extra.optimizationLoopCount || 0,
    humanValidation:      extra.humanValidation      || false,
    completedAt:          extra.completedAt          || null,
    reviewRequestedAt:    extra.reviewRequestedAt    || null,
    deployedAt:           extra.deployedAt           || null,
    notes:    Array.isArray(extra.notes)    ? extra.notes    : [],
    metadata: extra.metadata && typeof extra.metadata === 'object' ? extra.metadata : {},
    tags,
    createdAt: msToIso(row.created_at),
    updatedAt: msToIso(row.updated_at),
  };
}

// ─── Event logging ───────────────────────────────────────────────────────────

function logEvent(db, taskId, type, payload) {
  try {
    db.prepare(
      'INSERT INTO task_events (id, task_id, type, payload, ts) VALUES (?, ?, ?, ?, ?)'
    ).run(uuidv4(), taskId, type, JSON.stringify(payload), Date.now());
  } catch (e) {
    console.warn(`[compat] logEvent failed (${taskId}):`, e.message);
  }
}

// ─── DB upsert helpers ───────────────────────────────────────────────────────

const INSERT_SQL = `
  INSERT OR IGNORE INTO tasks
    (id, name, description, status, priority, engine, model, input, project_id, assignee, tags, created_at, updated_at)
  VALUES
    (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const UPDATE_SQL = `
  UPDATE tasks
  SET name=?, description=?, status=?, priority=?, engine=?, model=?,
      input=?, project_id=?, assignee=?, tags=?, updated_at=?
  WHERE id=?
`;

function dbInsert(db, row) {
  db.prepare(INSERT_SQL).run(
    row.id, row.name, row.description, row.status, row.priority,
    row.engine, row.model, row.input, row.project_id, row.assignee,
    row.tags, row.created_at, row.updated_at
  );
}

function dbUpdate(db, row) {
  db.prepare(UPDATE_SQL).run(
    row.name, row.description, row.status, row.priority, row.engine, row.model,
    row.input, row.project_id, row.assignee, row.tags, row.updated_at,
    row.id
  );
}

// ─── Full sync ───────────────────────────────────────────────────────────────

function fullSync() {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    console.error('[compat] cannot read config.json:', e.message);
    return { ok: false, error: e.message };
  }

  const db = getDb();
  const stats = {
    inserted_db:   0,
    updated_db:    0,
    inserted_json: 0,
    updated_json:  0,
    conflicts:     0,
    errors:        [],
  };

  for (const project of (config.projects || [])) {
    try {
      const jsonTasks  = readJsonTasks(project);
      const jsonById   = new Map(jsonTasks.map(t => [t.id, t]));

      const dbRows     = db.prepare('SELECT * FROM tasks WHERE project_id = ?').all(project.id);
      const dbById     = new Map(dbRows.map(r => [r.id, r]));

      let jsonDirty = false;

      // ── JSON → DB ──────────────────────────────────────────────────────────
      for (const jTask of jsonTasks) {
        const dbRow = dbById.get(jTask.id);

        if (!dbRow) {
          const row = jsonTaskToDbRow(jTask, project.id);
          dbInsert(db, row);
          logEvent(db, jTask.id, 'sync_insert_db', { source: 'json', project: project.id, title: jTask.title });
          stats.inserted_db++;
          continue;
        }

        const jsonTs = isoToMs(jTask.updatedAt);
        const dbTs   = dbRow.updated_at;

        if (jsonTs > dbTs) {
          // JSON is newer — push to DB
          const row = jsonTaskToDbRow(jTask, project.id);
          dbUpdate(db, row);
          logEvent(db, jTask.id, 'sync_update_db', {
            source: 'json', project: project.id, json_ts: jsonTs, db_ts: dbTs,
          });
          stats.updated_db++;
        } else if (dbTs > jsonTs) {
          // DB is newer — pull to JSON
          const idx = jsonTasks.findIndex(t => t.id === jTask.id);
          if (idx >= 0) jsonTasks[idx] = dbRowToJsonTask(dbRow);
          logEvent(db, jTask.id, 'sync_update_json', {
            source: 'db', project: project.id, json_ts: jsonTs, db_ts: dbTs,
          });
          stats.updated_json++;
          jsonDirty = true;
        }
        // Equal timestamps → no-op
      }

      // ── DB → JSON (tasks present in DB but missing from JSON) ─────────────
      for (const dbRow of dbRows) {
        if (!jsonById.has(dbRow.id)) {
          jsonTasks.push(dbRowToJsonTask(dbRow));
          logEvent(db, dbRow.id, 'sync_insert_json', {
            source: 'db', project: project.id, name: dbRow.name,
          });
          stats.inserted_json++;
          jsonDirty = true;
        }
      }

      if (jsonDirty) {
        writeJsonTasks(project, jsonTasks);
      }

    } catch (e) {
      console.error(`[compat] sync error — project ${project.id}:`, e.message);
      stats.errors.push(`${project.id}: ${e.message}`);
    }
  }

  console.log('[compat] fullSync complete:', JSON.stringify(stats));
  return { ok: true, stats };
}

module.exports = { fullSync };
