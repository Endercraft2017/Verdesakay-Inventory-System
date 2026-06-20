'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();
router.use(requireAuth);

const ITEM_SELECT = `
  SELECT i.*, d.name AS department_name,
         (i.quantity <= i.min_quantity) AS low_stock
  FROM inventory_items i
  LEFT JOIN departments d ON d.id = i.department_id
`;

// GET /api/inventory  — list with optional search / filters
router.get('/', (req, res) => {
  const { q, department_id, low } = req.query;
  const where = [];
  const params = [];

  if (q) {
    where.push('(i.name LIKE ? OR i.sku LIKE ? OR i.category LIKE ? OR i.location LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  if (department_id) {
    where.push('i.department_id = ?');
    params.push(Number(department_id));
  }
  if (low === '1' || low === 'true') {
    where.push('i.quantity <= i.min_quantity');
  }

  const sql = ITEM_SELECT + (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY i.name COLLATE NOCASE';
  res.json(db.prepare(sql).all(...params));
});

// GET /api/inventory/stats  — dashboard summary
router.get('/stats', (req, res) => {
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS items,
              COALESCE(SUM(quantity), 0) AS total_units,
              SUM(CASE WHEN quantity <= min_quantity THEN 1 ELSE 0 END) AS low_stock,
              SUM(CASE WHEN quantity = 0 THEN 1 ELSE 0 END) AS out_of_stock
       FROM inventory_items`
    )
    .get();
  res.json(totals);
});

// GET /api/inventory/:id  — single item with recent transactions
router.get('/:id', (req, res) => {
  const item = db.prepare(ITEM_SELECT + ' WHERE i.id = ?').get(Number(req.params.id));
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const history = db
    .prepare(
      `SELECT t.*, u.full_name AS user_name
       FROM inventory_transactions t
       LEFT JOIN users u ON u.id = t.user_id
       WHERE t.item_id = ?
       ORDER BY t.id DESC LIMIT 50`
    )
    .all(item.id);
  res.json({ ...item, history });
});

// POST /api/inventory  — create item
router.post('/', (req, res) => {
  let { name, sku, category, department_id, quantity, unit, min_quantity, location, notes } =
    req.body || {};
  name = String(name || '').trim();
  if (!name) return res.status(400).json({ error: 'Item name is required' });

  sku = sku ? String(sku).trim() : null;
  if (sku) {
    const dupe = db.prepare('SELECT id FROM inventory_items WHERE sku = ?').get(sku);
    if (dupe) return res.status(409).json({ error: 'An item with that SKU already exists' });
  }

  const qty = Number.isFinite(Number(quantity)) ? Math.trunc(Number(quantity)) : 0;
  const minQty = Number.isFinite(Number(min_quantity)) ? Math.trunc(Number(min_quantity)) : 0;

  const info = db
    .prepare(
      `INSERT INTO inventory_items
        (name, sku, category, department_id, quantity, unit, min_quantity, location, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      name,
      sku,
      category ? String(category).trim() : null,
      department_id ? Number(department_id) : null,
      qty,
      unit ? String(unit).trim() : 'pcs',
      minQty,
      location ? String(location).trim() : null,
      notes ? String(notes).trim() : null
    );

  if (qty !== 0) {
    db.prepare(
      `INSERT INTO inventory_transactions (item_id, user_id, change, balance_after, reason)
       VALUES (?, ?, ?, ?, 'Initial stock')`
    ).run(info.lastInsertRowid, req.user.id, qty, qty);
  }
  res.status(201).json({ id: info.lastInsertRowid });
});

// PUT /api/inventory/:id  — update item details (not quantity; use /adjust for that)
router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const item = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(id);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  let { name, sku, category, department_id, unit, min_quantity, location, notes } = req.body || {};
  name = name != null ? String(name).trim() : item.name;
  if (!name) return res.status(400).json({ error: 'Item name is required' });

  sku = sku !== undefined ? (sku ? String(sku).trim() : null) : item.sku;
  if (sku) {
    const dupe = db.prepare('SELECT id FROM inventory_items WHERE sku = ? AND id != ?').get(sku, id);
    if (dupe) return res.status(409).json({ error: 'Another item already uses that SKU' });
  }

  db.prepare(
    `UPDATE inventory_items
     SET name = ?, sku = ?, category = ?, department_id = ?, unit = ?, min_quantity = ?,
         location = ?, notes = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    name,
    sku,
    category !== undefined ? (category ? String(category).trim() : null) : item.category,
    department_id !== undefined ? (department_id ? Number(department_id) : null) : item.department_id,
    unit !== undefined ? (unit ? String(unit).trim() : 'pcs') : item.unit,
    min_quantity !== undefined ? Math.trunc(Number(min_quantity) || 0) : item.min_quantity,
    location !== undefined ? (location ? String(location).trim() : null) : item.location,
    notes !== undefined ? (notes ? String(notes).trim() : null) : item.notes,
    id
  );
  res.json({ ok: true });
});

// POST /api/inventory/:id/adjust  — stock in / out, recorded as a transaction
router.post('/:id/adjust', (req, res) => {
  const id = Number(req.params.id);
  const item = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(id);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  const change = Math.trunc(Number((req.body || {}).change));
  const reason = (req.body || {}).reason ? String(req.body.reason).trim() : null;
  if (!Number.isFinite(change) || change === 0) {
    return res.status(400).json({ error: 'Change must be a non-zero whole number' });
  }
  const balance = item.quantity + change;
  if (balance < 0) {
    return res.status(400).json({ error: `Not enough stock. Only ${item.quantity} available.` });
  }

  db.exec('BEGIN');
  try {
    db.prepare("UPDATE inventory_items SET quantity = ?, updated_at = datetime('now') WHERE id = ?")
      .run(balance, id);
    db.prepare(
      `INSERT INTO inventory_transactions (item_id, user_id, change, balance_after, reason)
       VALUES (?, ?, ?, ?, ?)`
    ).run(id, req.user.id, change, balance, reason);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.json({ ok: true, quantity: balance });
});

// DELETE /api/inventory/:id
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const info = db.prepare('DELETE FROM inventory_items WHERE id = ?').run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'Item not found' });
  res.json({ ok: true });
});

module.exports = router;
