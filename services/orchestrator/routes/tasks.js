'use strict';

const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db');

const VALID_STATUS   = ['pending', 'running', 'done', 'failed', 'cancelled'];
const VALID_PRIORITY = ['critical', 'high', 'normal', 'low'];

function serializeTask(row) {
  return { ...row, tags: JSON.parse(row.tags || '[]') };
}

module.exports = function tasksRouter() {
  const router = Router();

  // GET /api/v1/tasks[?status=&priority=&project_id=&assignee=&tags=tag1,tag2&engine=]
  router.get('/', (req, res) => {
    const db = getDb();
    const { status, priority, project_id, assignee, tags, engine } = req.query;

    if (status    && !VALID_STATUS.includes(status))     return res.status(400).json({ error: 'invalid status' });
    if (priority  && !VALID_PRIORITY.includes(priority)) return res.status(400).json({ error: 'invalid priority' });

    const conditions = [];
    const params = [];

    if (status)     { conditions.push('status = ?');     params.push(status); }
    if (priority)   { conditions.push('priority = ?');   params.push(priority); }
    if (project_id) { conditions.push('project_id = ?'); params.push(project_id); }
    if (assignee)   { conditions.push('assignee = ?');   params.push(assignee); }
    if (engine)     { conditions.push('engine = ?');     params.push(engine); }

    // tags = comma-separated; task must match ALL supplied tags (AND logic)
    if (tags) {
      const tagList = tags.split(',').map(t => t.trim()).filter(Boolean);
      for (const tag of tagList) {
        conditions.push('tags LIKE ?');
        params.push(`%"${tag}"%`);
      }
    }

    let sql = 'SELECT * FROM tasks';
    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY created_at DESC';

    res.json(db.prepare(sql).all(params).map(serializeTask));
  });

  // POST /api/v1/tasks
  router.post('/', (req, res) => {
    const db = getDb();
    const {
      name,
      description = '',
      status     = 'pending',
      priority   = 'normal',
      engine,
      model,
      input,
      project_id,
      assignee   = '',
      tags       = [],
    } = req.body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    if (!VALID_STATUS.includes(status))     return res.status(400).json({ error: 'invalid status' });
    if (!VALID_PRIORITY.includes(priority)) return res.status(400).json({ error: 'invalid priority' });

    const id       = uuidv4();
    const now      = Date.now();
    const tagsJson = JSON.stringify(Array.isArray(tags) ? tags : []);
    const inputVal = input == null ? null : (typeof input === 'string' ? input : JSON.stringify(input));

    db.prepare(`
      INSERT INTO tasks
        (id, name, description, status, priority, engine, model, input, project_id, assignee, tags, created_at, updated_at)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, name.trim(), description, status, priority,
      engine || null, model || null, inputVal,
      project_id || null, assignee, tagsJson,
      now, now
    );

    res.status(201).json(serializeTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)));
  });

  // GET /api/v1/tasks/:id
  router.get('/:id', (req, res) => {
    const task = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(serializeTask(task));
  });

  // PUT /api/v1/tasks/:id
  router.put('/:id', (req, res) => {
    const db = getDb();
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const { name, description, status, priority, engine, model, input, project_id, assignee, tags } = req.body;

    if (status   !== undefined && !VALID_STATUS.includes(status))     return res.status(400).json({ error: 'invalid status' });
    if (priority !== undefined && !VALID_PRIORITY.includes(priority)) return res.status(400).json({ error: 'invalid priority' });

    const inputVal = input !== undefined
      ? (input == null ? null : (typeof input === 'string' ? input : JSON.stringify(input)))
      : task.input;

    db.prepare(`
      UPDATE tasks
      SET name=?, description=?, status=?, priority=?, engine=?, model=?, input=?,
          project_id=?, assignee=?, tags=?, updated_at=?
      WHERE id=?
    `).run(
      name        !== undefined ? name        : task.name,
      description !== undefined ? description : task.description,
      status      !== undefined ? status      : task.status,
      priority    !== undefined ? priority    : task.priority,
      engine      !== undefined ? engine      : task.engine,
      model       !== undefined ? model       : task.model,
      inputVal,
      project_id  !== undefined ? project_id  : task.project_id,
      assignee    !== undefined ? assignee    : task.assignee,
      tags        !== undefined ? JSON.stringify(Array.isArray(tags) ? tags : []) : task.tags,
      Date.now(),
      req.params.id
    );

    res.json(serializeTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id)));
  });

  // DELETE /api/v1/tasks/:id
  router.delete('/:id', (req, res) => {
    const db = getDb();
    if (!db.prepare('SELECT id FROM tasks WHERE id = ?').get(req.params.id)) {
      return res.status(404).json({ error: 'Task not found' });
    }
    db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
    res.status(204).end();
  });

  return router;
};
