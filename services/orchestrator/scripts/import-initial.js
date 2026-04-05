'use strict';

/**
 * import-initial.js — Idempotent seed of SQLite from config.json + tasks.json files.
 * Skips projects and tasks that already exist (INSERT OR IGNORE).
 * Safe to run multiple times.
 *
 * Usage:
 *   node scripts/import-initial.js
 *   ORCHESTRATOR_DB_PATH=/path/to/orchestrator.db node scripts/import-initial.js
 */

const fs   = require('fs');
const path = require('path');
const { initDb, getDb } = require('../db');

const CONFIG_PATH = path.join(__dirname, '..', '..', '..', 'config.json');

// ─── Status / priority mappings (mirror compat.js) ──────────────────────────

const JSON_TO_DB_STATUS = {
  'todo':        'pending',
  'queued':      'pending',
  'in-progress': 'running',
  'in-review':   'done',
  'done':        'done',
  'failed':      'failed',
};

const JSON_TO_DB_PRIORITY = {
  'low':      'low',
  'medium':   'normal',
  'high':     'high',
  'critical': 'critical',
};

function isoToMs(iso) {
  if (!iso) return 0;
  const ms = new Date(iso).getTime();
  return isNaN(ms) ? 0 : ms;
}

// ─── Read tasks.json for a project ──────────────────────────────────────────

function readJsonTasks(projectPath) {
  const fp = path.join(projectPath, '.claude', 'tasks.json');
  if (!fs.existsSync(fp)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
    return Array.isArray(data.tasks) ? data.tasks : [];
  } catch (e) {
    console.warn(`  [warn] cannot parse ${fp}: ${e.message}`);
    return [];
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  // Load config
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`[import] config.json not found at ${CONFIG_PATH}`);
    process.exit(1);
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    console.error(`[import] failed to parse config.json: ${e.message}`);
    process.exit(1);
  }

  const projects = Array.isArray(config.projects) ? config.projects : [];
  if (projects.length === 0) {
    console.log('[import] no projects in config.json — nothing to do');
    return;
  }

  // Init DB (runs migrations if needed)
  initDb();
  const db = getDb();

  const insertProject = db.prepare(`
    INSERT OR IGNORE INTO projects (id, name, description, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  const insertTask = db.prepare(`
    INSERT OR IGNORE INTO tasks
      (id, name, description, status, priority, engine, model, input,
       project_id, assignee, tags, created_at, updated_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const stats = { projects_inserted: 0, projects_skipped: 0, tasks_inserted: 0, tasks_skipped: 0 };

  const importAll = db.transaction(() => {
    for (const project of projects) {
      // ── Insert project ─────────────────────────────────────────────────────
      const now = Date.now();
      const pResult = insertProject.run(
        project.id,
        project.name,
        project.description || '',
        now,
        now
      );

      if (pResult.changes > 0) {
        console.log(`[import] project inserted: ${project.id}`);
        stats.projects_inserted++;
      } else {
        console.log(`[import] project already exists, skipping: ${project.id}`);
        stats.projects_skipped++;
      }

      // ── Import tasks from tasks.json ───────────────────────────────────────
      if (!project.path) continue;

      const tasks = readJsonTasks(project.path);
      if (tasks.length === 0) {
        console.log(`  [import] no tasks found for ${project.id}`);
        continue;
      }

      for (const task of tasks) {
        if (!task.id) {
          console.warn(`  [warn] task without id in ${project.id} — skipping`);
          continue;
        }

        const taskNow = Date.now();
        const extra = {
          originalStatus:       task.status,
          coderPrompt:          task.coderPrompt,
          technicalAgent:       task.technicalAgent,
          coderAgent:           task.coderAgent,
          fallbackModel:        task.fallbackModel,
          commitSha:            task.commitSha,
          deployedCommit:       task.deployedCommit,
          lastCoderCommit:      task.lastCoderCommit,
          lastCoderSummary:     task.lastCoderSummary,
          lastCoderEngine:      task.lastCoderEngine,
          lastCoderModel:       task.lastCoderModel,
          optimizationLoop:     task.optimizationLoop,
          optimizationMaxLoops: task.optimizationMaxLoops,
          optimizationLoopCount: task.optimizationLoopCount,
          humanValidation:      task.humanValidation,
          completedAt:          task.completedAt,
          reviewRequestedAt:    task.reviewRequestedAt,
          deployedAt:           task.deployedAt,
          notes:                task.notes,
          metadata:             task.metadata,
        };

        const tResult = insertTask.run(
          task.id,
          task.title || task.name || '',
          task.description || '',
          JSON_TO_DB_STATUS[task.status]   || 'pending',
          JSON_TO_DB_PRIORITY[task.priority] || 'normal',
          task.engine  || null,
          task.model   || null,
          JSON.stringify(extra),
          project.id,
          task.assignee || '',
          JSON.stringify(Array.isArray(task.tags) ? task.tags : []),
          isoToMs(task.createdAt) || taskNow,
          isoToMs(task.updatedAt) || taskNow
        );

        if (tResult.changes > 0) {
          stats.tasks_inserted++;
        } else {
          stats.tasks_skipped++;
        }
      }

      console.log(`  [import] ${project.id}: ${tasks.length} tasks processed`);
    }
  });

  importAll();

  console.log('\n[import] done.');
  console.log(`  projects: ${stats.projects_inserted} inserted, ${stats.projects_skipped} skipped`);
  console.log(`  tasks:    ${stats.tasks_inserted} inserted, ${stats.tasks_skipped} skipped`);
}

main();
