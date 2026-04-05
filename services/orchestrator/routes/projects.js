'use strict';

const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db');

const VALID_STATUS = ['active', 'archived', 'paused'];

module.exports = function projectsRouter() {
  const router = Router();

  // GET /api/v1/projects[?status=active]
  router.get('/', (req, res) => {
    const db = getDb();
    const { status } = req.query;

    const conditions = [];
    const params = [];

    if (status) {
      if (!VALID_STATUS.includes(status)) {
        return res.status(400).json({ error: `status must be one of: ${VALID_STATUS.join(', ')}` });
      }
      conditions.push('status = ?');
      params.push(status);
    }

    let sql = 'SELECT * FROM projects';
    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY created_at DESC';

    res.json(db.prepare(sql).all(params));
  });

  // POST /api/v1/projects
  router.post('/', (req, res) => {
    const db = getDb();
    const { name, description = '', status = 'active' } = req.body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    if (!VALID_STATUS.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${VALID_STATUS.join(', ')}` });
    }

    const id = uuidv4();
    const now = Date.now();

    db.prepare(
      'INSERT INTO projects (id, name, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, name.trim(), description, status, now, now);

    res.status(201).json(db.prepare('SELECT * FROM projects WHERE id = ?').get(id));
  });

  // GET /api/v1/projects/:id
  router.get('/:id', (req, res) => {
    const project = getDb().prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json(project);
  });

  // PUT /api/v1/projects/:id
  router.put('/:id', (req, res) => {
    const db = getDb();
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { name, description, status } = req.body;

    if (status !== undefined && !VALID_STATUS.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${VALID_STATUS.join(', ')}` });
    }

    db.prepare(
      'UPDATE projects SET name = ?, description = ?, status = ?, updated_at = ? WHERE id = ?'
    ).run(
      name !== undefined ? name : project.name,
      description !== undefined ? description : project.description,
      status !== undefined ? status : project.status,
      Date.now(),
      req.params.id
    );

    res.json(db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id));
  });

  // DELETE /api/v1/projects/:id
  router.delete('/:id', (req, res) => {
    const db = getDb();
    if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id)) {
      return res.status(404).json({ error: 'Project not found' });
    }
    db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
    res.status(204).end();
  });

  return router;
};
