module.exports = function createRoyalHeightsRoutes({ requireAuth }) {
  const router = require('express').Router();
  const crypto = require('crypto');
  const path = require('path');
  const { readJSON, writeJSON } = require('../lib/json-store');
  const XLSX = require('xlsx');

  const DATA_DIR = path.join(__dirname, '..', 'data', 'royal-heights');
  const PROSPECTS_PATH = path.join(DATA_DIR, 'prospects.json');
  const TASKS_PATH = path.join(DATA_DIR, 'prospection-tasks.json');

  function readProspects() { return readJSON(PROSPECTS_PATH, []); }
  function writeProspects(data) { writeJSON(PROSPECTS_PATH, data); }
  function readTasks() { return readJSON(TASKS_PATH, []); }
  function writeTasks(data) { writeJSON(TASKS_PATH, data); }

  // ===== Stats =====

  router.get('/api/royal-heights/stats', requireAuth, (req, res) => {
    const prospects = readProspects();
    const total = prospects.length;
    const byStatus = {};
    const bySource = {};
    for (const p of prospects) {
      byStatus[p.status] = (byStatus[p.status] || 0) + 1;
      bySource[p.source] = (bySource[p.source] || 0) + 1;
    }
    const signed = byStatus['signed'] || 0;
    const conversionRate = total > 0 ? Math.round((signed / total) * 100) : 0;
    res.json({ total, byStatus, bySource, conversionRate });
  });

  // ===== Prospects =====

  router.get('/api/royal-heights/prospects', requireAuth, (req, res) => {
    res.json(readProspects());
  });

  router.post('/api/royal-heights/prospects', requireAuth, (req, res) => {
    const prospects = readProspects();
    const prospect = {
      id: crypto.randomUUID(),
      name: req.body.name || '',
      email: req.body.email || '',
      phone: req.body.phone || '',
      company: req.body.company || '',
      country: req.body.country || '',
      source: req.body.source || 'other',
      status: req.body.status || 'identified',
      unitsOfInterest: req.body.unitsOfInterest || [],
      budget: req.body.budget || '',
      notes: req.body.notes || '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastContactDate: req.body.lastContactDate || null,
      nextAction: req.body.nextAction || '',
      nextActionDate: req.body.nextActionDate || null,
    };
    prospects.push(prospect);
    writeProspects(prospects);
    res.json({ ok: true, prospect });
  });

  router.put('/api/royal-heights/prospects/:id', requireAuth, (req, res) => {
    const prospects = readProspects();
    const idx = prospects.findIndex(p => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    prospects[idx] = { ...prospects[idx], ...req.body, id: prospects[idx].id, updatedAt: new Date().toISOString() };
    writeProspects(prospects);
    res.json({ ok: true, prospect: prospects[idx] });
  });

  router.delete('/api/royal-heights/prospects/:id', requireAuth, (req, res) => {
    const prospects = readProspects();
    const idx = prospects.findIndex(p => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    prospects.splice(idx, 1);
    writeProspects(prospects);
    res.json({ ok: true });
  });

  router.get('/api/royal-heights/prospects/export', requireAuth, (req, res) => {
    const prospects = readProspects();
    const sourceLabels = { web: 'Web', agent: 'Agent', diaspora: 'Diaspora', salon: 'Salon', referral: 'Référence', social: 'Réseaux sociaux', other: 'Autre' };
    const statusLabels = { identified: 'Identifié', contacted: 'Contacté', interested: 'Intéressé', visit_planned: 'Visite planifiée', offer: 'Offre', signed: 'Signé', lost: 'Perdu' };

    const rows = prospects.map(p => ({
      'Nom': p.name,
      'Email': p.email,
      'Téléphone': p.phone,
      'Société': p.company,
      'Pays': p.country,
      'Source': sourceLabels[p.source] || p.source,
      'Statut': statusLabels[p.status] || p.status,
      "Unités d'intérêt": Array.isArray(p.unitsOfInterest) ? p.unitsOfInterest.join(', ') : '',
      'Budget': p.budget,
      'Notes': p.notes,
      'Dernier contact': p.lastContactDate ? p.lastContactDate.split('T')[0] : '',
      'Prochaine action': p.nextAction,
      'Date prochaine action': p.nextActionDate ? p.nextActionDate.split('T')[0] : '',
    }));

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, 'Prospects');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="royal-heights-prospects.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  });

  // ===== Tasks =====

  router.get('/api/royal-heights/tasks', requireAuth, (req, res) => {
    res.json(readTasks());
  });

  router.post('/api/royal-heights/tasks', requireAuth, (req, res) => {
    const tasks = readTasks();
    const task = {
      id: crypto.randomUUID(),
      title: req.body.title || '',
      description: req.body.description || '',
      type: req.body.type || 'other',
      status: req.body.status || 'todo',
      priority: req.body.priority || 'medium',
      assignee: req.body.assignee || 'Agent Royal Heights',
      dueDate: req.body.dueDate || null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: null,
      result: '',
    };
    tasks.push(task);
    writeTasks(tasks);
    res.json({ ok: true, task });
  });

  router.put('/api/royal-heights/tasks/:id', requireAuth, (req, res) => {
    const tasks = readTasks();
    const idx = tasks.findIndex(t => t.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    const updated = { ...tasks[idx], ...req.body, id: tasks[idx].id, updatedAt: new Date().toISOString() };
    if (req.body.status === 'done' && !tasks[idx].completedAt) {
      updated.completedAt = new Date().toISOString();
    }
    tasks[idx] = updated;
    writeTasks(tasks);
    res.json({ ok: true, task: tasks[idx] });
  });

  router.delete('/api/royal-heights/tasks/:id', requireAuth, (req, res) => {
    const tasks = readTasks();
    const idx = tasks.findIndex(t => t.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    tasks.splice(idx, 1);
    writeTasks(tasks);
    res.json({ ok: true });
  });

  return router;
};
