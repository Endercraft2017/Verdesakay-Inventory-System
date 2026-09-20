/** Locations registry — warehouses / branches / stores / trucks that hold stock.
    Per-location quantities live in `inventory_stock` (see src/inventory-stock.ts). */
import { Router } from 'express';
import { db, queryOne, queryAll, run } from '../../shared/db';
import { requireAuth, requirePermission } from '../../shared/auth';
import { parseBody, createLocationSchema, updateLocationSchema } from '../../shared/validation';
import type { LocationRow } from '../../shared/types';

const router = Router();
router.use(requireAuth);

const LIST_SQL = `
  SELECT l.*,
         (SELECT COALESCE(SUM(s.quantity), 0) FROM inventory_stock s WHERE s.location_id = l.id) AS total_units,
         (SELECT COUNT(*) FROM inventory_stock s WHERE s.location_id = l.id AND s.quantity <> 0) AS item_count
  FROM locations l
`;

/** Make exactly one location the default (clears the flag on all others). */
function setSoleDefault(id: number): void {
  db.exec('BEGIN');
  try {
    run('UPDATE locations SET is_default = 0 WHERE id != ?', id);
    run("UPDATE locations SET is_default = 1, updated_at = datetime('now') WHERE id = ?", id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// GET /api/locations
router.get('/', requirePermission('inventory.view'), (req, res) => {
  const { q } = req.query;
  let sql = LIST_SQL;
  const params: unknown[] = [];
  if (typeof q === 'string' && q.trim()) {
    sql += ' WHERE (l.name LIKE ? OR l.address LIKE ? OR l.type LIKE ?)';
    const like = `%${q.trim()}%`;
    params.push(like, like, like);
  }
  sql += ' ORDER BY l.is_default DESC, l.name COLLATE NOCASE';
  res.json(queryAll<LocationRow>(sql, ...params));
});

// GET /api/locations/:id — one location + the items it currently holds
router.get('/:id', requirePermission('inventory.view'), (req, res) => {
  const loc = queryOne<LocationRow>(LIST_SQL + ' WHERE l.id = ?', Number(req.params.id));
  if (!loc) {
    res.status(404).json({ error: 'Location not found' });
    return;
  }
  const items = queryAll(
    `SELECT i.id, i.name, i.sku, i.unit, s.quantity
       FROM inventory_stock s JOIN inventory_items i ON i.id = s.item_id
      WHERE s.location_id = ? AND s.quantity <> 0
      ORDER BY s.quantity DESC, i.name COLLATE NOCASE`,
    loc.id
  );
  res.json({ ...loc, items });
});

// POST /api/locations
router.post('/', requirePermission('inventory.create'), (req, res) => {
  const input = parseBody(createLocationSchema, req.body);
  const isFirst = (queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM locations')?.n ?? 0) === 0;
  const info = run(
    'INSERT INTO locations (name, type, address, notes, is_default) VALUES (?, ?, ?, ?, ?)',
    input.name,
    input.type,
    input.address ?? null,
    input.notes ?? null,
    (isFirst || input.is_default) ? 1 : 0
  );
  const id = Number(info.lastInsertRowid);
  if (isFirst || input.is_default) setSoleDefault(id);
  res.status(201).json({ id });
});

// PUT /api/locations/:id
router.put('/:id', requirePermission('inventory.edit'), (req, res) => {
  const id = Number(req.params.id);
  const existing = queryOne<LocationRow>('SELECT * FROM locations WHERE id = ?', id);
  if (!existing) {
    res.status(404).json({ error: 'Location not found' });
    return;
  }
  const input = parseBody(updateLocationSchema, req.body);
  run(
    `UPDATE locations SET name = ?, type = ?, address = ?, notes = ?, updated_at = datetime('now') WHERE id = ?`,
    input.name ?? existing.name,
    input.type ?? existing.type,
    input.address !== undefined ? input.address : existing.address,
    input.notes !== undefined ? input.notes : existing.notes,
    id
  );
  if (input.is_default) setSoleDefault(id);
  res.json({ ok: true });
});

// POST /api/locations/:id/default — make this the default location
router.post('/:id/default', requirePermission('inventory.edit'), (req, res) => {
  const id = Number(req.params.id);
  if (!queryOne('SELECT id FROM locations WHERE id = ?', id)) {
    res.status(404).json({ error: 'Location not found' });
    return;
  }
  setSoleDefault(id);
  res.json({ ok: true });
});

// DELETE /api/locations/:id
router.delete('/:id', requirePermission('inventory.delete'), (req, res) => {
  const id = Number(req.params.id);
  const loc = queryOne<LocationRow>('SELECT * FROM locations WHERE id = ?', id);
  if (!loc) {
    res.status(404).json({ error: 'Location not found' });
    return;
  }
  const held = queryOne<{ n: number }>(
    'SELECT COUNT(*) AS n FROM inventory_stock WHERE location_id = ? AND quantity <> 0',
    id
  )?.n ?? 0;
  if (held > 0) {
    res.status(409).json({ error: `This location still holds stock for ${held} item(s). Move it out first.` });
    return;
  }
  const others = queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM locations WHERE id != ?', id)?.n ?? 0;
  if (loc.is_default && others > 0) {
    res.status(409).json({ error: 'Set another location as the default before deleting this one.' });
    return;
  }
  db.exec('BEGIN');
  try {
    run('DELETE FROM inventory_stock WHERE location_id = ?', id); // only zero-qty rows remain
    run('DELETE FROM locations WHERE id = ?', id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.json({ ok: true });
});

export default router;
