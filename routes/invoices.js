module.exports = function createInvoiceRoutes({ requireAuth }) {
  const router = require('express').Router();
  const crypto = require('crypto');
  const fs = require('fs');
  const path = require('path');
  const { readJSON, writeJSON } = require('../lib/json-store');

  const INVOICES_PATH = path.join(__dirname, '..', 'data', 'invoices.json');

  function readInvoices() {
    return readJSON(INVOICES_PATH, { clients: [], invoices: [], updatedAt: null });
  }

  function writeInvoices(data) {
    data.updatedAt = new Date().toISOString();
    writeJSON(INVOICES_PATH, data);
  }

  router.get('/api/invoices', requireAuth, (req, res) => {
    const data = readInvoices();

    // Compute derived status for each invoice
    const now = new Date();
    for (const inv of data.invoices) {
      if (inv.status === 'paid') continue;
      const due = new Date(inv.dueDate);
      if (now > due) {
        inv.status = 'overdue';
        inv.daysOverdue = Math.floor((now - due) / (1000 * 60 * 60 * 24));
      } else {
        inv.status = 'pending';
        inv.daysUntilDue = Math.ceil((due - now) / (1000 * 60 * 60 * 24));
      }
    }

    res.json(data);
  });

  router.post('/api/invoices', requireAuth, (req, res) => {
    const data = readInvoices();
    const inv = req.body;
    inv.id = 'inv-' + crypto.randomUUID().slice(0, 8);
    inv.createdAt = new Date().toISOString();
    if (!inv.status) inv.status = 'pending';
    data.invoices.push(inv);
    writeInvoices(data);
    res.json({ ok: true, invoice: inv });
  });

  router.patch('/api/invoices/:id', requireAuth, (req, res) => {
    const data = readInvoices();
    const inv = data.invoices.find(i => i.id === req.params.id);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    Object.assign(inv, req.body);
    writeInvoices(data);
    res.json({ ok: true, invoice: inv });
  });

  router.delete('/api/invoices/:id', requireAuth, (req, res) => {
    const data = readInvoices();
    data.invoices = data.invoices.filter(i => i.id !== req.params.id);
    writeInvoices(data);
    res.json({ ok: true });
  });

  router.get('/api/invoices/:id', requireAuth, (req, res) => {
    const data = readInvoices();
    const inv = data.invoices.find(i => i.id === req.params.id);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    const now = new Date();
    if (inv.status !== 'paid') {
      const due = new Date(inv.dueDate);
      if (now > due) {
        inv.status = 'overdue';
        inv.daysOverdue = Math.floor((now - due) / (1000 * 60 * 60 * 24));
      } else {
        inv.status = 'pending';
        inv.daysUntilDue = Math.ceil((due - now) / (1000 * 60 * 60 * 24));
      }
    }
    res.json(inv);
  });

  router.post('/api/invoices/:id/event', requireAuth, (req, res) => {
    const data = readInvoices();
    const inv = data.invoices.find(i => i.id === req.params.id);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    if (!inv.events) inv.events = [];
    const { type, note } = req.body;
    const now = new Date().toISOString();
    inv.events.push({ type, at: now, note: note || '' });
    if (type === 'paid') { inv.status = 'paid'; inv.paidAt = now; }
    if (type === 'sent') { inv.sentAt = now; }
    writeInvoices(data);
    res.json({ ok: true, invoice: inv });
  });

  router.delete('/api/invoices/:id/event-last', requireAuth, (req, res) => {
    const data = readInvoices();
    const inv = data.invoices.find(i => i.id === req.params.id);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    if (!inv.events) inv.events = [];
    const removed = inv.events.pop();
    if (removed && removed.type === 'paid') {
      inv.status = 'pending';
      inv.paidAt = null;
    }
    writeInvoices(data);
    res.json({ ok: true, invoice: inv });
  });

  // Client CRUD
  router.post('/api/invoices/clients', requireAuth, (req, res) => {
    const data = readInvoices();
    const client = req.body;
    client.id = client.id || client.name.toLowerCase().replace(/[^a-z0-9]/g, '-');
    data.clients.push(client);
    writeInvoices(data);
    res.json({ ok: true, client });
  });

  router.patch('/api/invoices/clients/:id', requireAuth, (req, res) => {
    const data = readInvoices();
    const client = data.clients.find(c => c.id === req.params.id);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    Object.assign(client, req.body);
    writeInvoices(data);
    res.json({ ok: true, client });
  });

  return router;
};
