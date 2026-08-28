/** Suppliers / vendors registry. Items point at a supplier via inventory_items.supplier_id. */
import { Router } from 'express';
import { queryOne, queryAll, run } from '../db';
import { requireAuth, requirePermission } from '../auth';
import { parseBody, createSupplierSchema, updateSupplierSchema } from '../validation';
import type { Supplier } from '../types';

const router = Router();
router.use(requireAuth);

const LIST_SQL = `
  SELECT s.*, (SELECT COUNT(*) FROM inventory_items i WHERE i.supplier_id = s.id) AS item_count
  FROM suppliers s
`;

// GET /api/suppliers — all suppliers (+ how many items use each), optional ?q=
router.get('/', requirePermission('inventory.view'), (req, res) => {
  const { q } = req.query;
  let sql = LIST_SQL;
  const params: unknown[] = [];
  if (typeof q === 'string' && q.trim()) {
    sql += ' WHERE (s.name LIKE ? OR s.contact_person LIKE ? OR s.email LIKE ? OR s.phone LIKE ?)';
    const like = `%${q.trim()}%`;
    params.push(like, like, like, like);
  }
  sql += ' ORDER BY s.name COLLATE NOCASE';
  res.json(queryAll<Supplier>(sql, ...params));
});

// GET /api/suppliers/:id — one supplier + the items it supplies
router.get('/:id', requirePermission('inventory.view'), (req, res) => {
  const supplier = queryOne<Supplier>(LIST_SQL + ' WHERE s.id = ?', Number(req.params.id));
  if (!supplier) {
    res.status(404).json({ error: 'Supplier not found' });
    return;
  }
  const items = queryAll(
    `SELECT id, name, sku, quantity, unit FROM inventory_items WHERE supplier_id = ? ORDER BY name COLLATE NOCASE`,
    supplier.id
  );
  res.json({ ...supplier, items });
});

// POST /api/suppliers
router.post('/', requirePermission('inventory.create'), (req, res) => {
  const input = parseBody(createSupplierSchema, req.body);
  const info = run(
    `INSERT INTO suppliers (name, contact_person, phone, email, address, notes)
     VALUES (?, ?, ?, ?, ?, ?)`,
    input.name,
    input.contact_person ?? null,
    input.phone ?? null,
    input.email ?? null,
    input.address ?? null,
    input.notes ?? null
  );
  res.status(201).json({ id: info.lastInsertRowid });
});

// PUT /api/suppliers/:id
router.put('/:id', requirePermission('inventory.edit'), (req, res) => {
  const id = Number(req.params.id);
  const existing = queryOne<Supplier>('SELECT * FROM suppliers WHERE id = ?', id);
  if (!existing) {
    res.status(404).json({ error: 'Supplier not found' });
    return;
  }
  const input = parseBody(updateSupplierSchema, req.body);
  run(
    `UPDATE suppliers
     SET name = ?, contact_person = ?, phone = ?, email = ?, address = ?, notes = ?,
         updated_at = datetime('now')
     WHERE id = ?`,
    input.name ?? existing.name,
    input.contact_person !== undefined ? input.contact_person : existing.contact_person,
    input.phone !== undefined ? input.phone : existing.phone,
    input.email !== undefined ? input.email : existing.email,
    input.address !== undefined ? input.address : existing.address,
    input.notes !== undefined ? input.notes : existing.notes,
    id
  );
  res.json({ ok: true });
});

// DELETE /api/suppliers/:id — items keep their history; their supplier_id goes NULL (FK).
router.delete('/:id', requirePermission('inventory.delete'), (req, res) => {
  const info = run('DELETE FROM suppliers WHERE id = ?', Number(req.params.id));
  if (info.changes === 0) {
    res.status(404).json({ error: 'Supplier not found' });
    return;
  }
  res.json({ ok: true });
});

export default router;
