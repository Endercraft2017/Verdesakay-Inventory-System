/** Suppliers / vendors registry. Items point at a supplier via inventory_items.supplier_id. */
import { Router } from 'express';
import { queryOne, queryAll, run } from '../../shared/db';
import { requireAuth, requirePermission } from '../../shared/auth';
import { parseBody, createSupplierSchema, updateSupplierSchema, csvImportSchema } from '../../shared/validation';
import { toCsv } from '../../shared/csv';
import { resolveImport, importLoop } from '../../shared/csv-import';
import type { Supplier } from '../../shared/types';

const router = Router();
router.use(requireAuth);

const CSV_COLUMNS = ['name', 'contact_person', 'phone', 'email', 'address', 'notes'] as const;

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

// GET /api/suppliers/export — all suppliers as CSV (round-trips with import)
router.get('/export', requirePermission('inventory.view'), (_req, res) => {
  const rows = queryAll<Record<string, unknown>>(
    `SELECT name, contact_person, phone, email, address, notes FROM suppliers ORDER BY name COLLATE NOCASE`
  );
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="suppliers-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(toCsv([...CSV_COLUMNS], rows));
});

// POST /api/suppliers/import — create/update suppliers from CSV. Upsert key: name.
router.post('/import', requirePermission('inventory.create'), (req, res) => {
  const { csv, dry_run } = parseBody(csvImportSchema, req.body);
  let resolved;
  try {
    resolved = resolveImport(csv, [
      { key: 'name', aliases: ['supplier', 'supplier name', 'company'], required: true },
      { key: 'contact_person', aliases: ['contact', 'contact person'] },
      { key: 'phone', aliases: ['tel', 'telephone', 'mobile'] },
      { key: 'email' },
      { key: 'address' },
      { key: 'notes', aliases: ['remarks'] },
    ]);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'Bad CSV' });
    return;
  }

  const report = importLoop(resolved.rows, !!dry_run, (row) => {
    const name = resolved.get(row, 'name');
    const parsed = createSupplierSchema.safeParse({
      name,
      contact_person: resolved.get(row, 'contact_person') || undefined,
      phone: resolved.get(row, 'phone') || undefined,
      email: resolved.get(row, 'email') || undefined,
      address: resolved.get(row, 'address') || undefined,
      notes: resolved.get(row, 'notes') || undefined,
    });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid row', key: name };
    const d = parsed.data;
    const existing = queryOne<Supplier>('SELECT * FROM suppliers WHERE name = ? COLLATE NOCASE', name);
    if (existing) {
      run(
        `UPDATE suppliers SET contact_person = ?, phone = ?, email = ?, address = ?, notes = ?,
           updated_at = datetime('now') WHERE id = ?`,
        d.contact_person ?? existing.contact_person ?? null,
        d.phone ?? existing.phone ?? null,
        d.email ?? existing.email ?? null,
        d.address ?? existing.address ?? null,
        d.notes ?? existing.notes ?? null,
        existing.id
      );
      return 'updated';
    }
    run(
      `INSERT INTO suppliers (name, contact_person, phone, email, address, notes) VALUES (?, ?, ?, ?, ?, ?)`,
      d.name, d.contact_person ?? null, d.phone ?? null, d.email ?? null, d.address ?? null, d.notes ?? null
    );
    return 'created';
  });
  res.json(report);
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
    `INSERT INTO suppliers (name, contact_person, phone, email, address, tin, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    input.name,
    input.contact_person ?? null,
    input.phone ?? null,
    input.email ?? null,
    input.address ?? null,
    input.tin ?? null,
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
     SET name = ?, contact_person = ?, phone = ?, email = ?, address = ?, tin = ?, notes = ?,
         updated_at = datetime('now')
     WHERE id = ?`,
    input.name ?? existing.name,
    input.contact_person !== undefined ? input.contact_person : existing.contact_person,
    input.phone !== undefined ? input.phone : existing.phone,
    input.email !== undefined ? input.email : existing.email,
    input.address !== undefined ? input.address : existing.address,
    input.tin !== undefined ? input.tin : existing.tin,
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
