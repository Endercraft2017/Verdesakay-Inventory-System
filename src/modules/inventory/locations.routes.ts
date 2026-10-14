/** Locations registry — warehouses / branches / stores / trucks that hold stock.
    Per-location quantities live in `inventory_stock` (see src/inventory-stock.ts). */
import { Router, type Request } from 'express';
import { db, queryOne, queryAll, run } from '../../shared/db';
import { requireAuth, requirePermission, requireAnyPermission } from '../../shared/auth';
import { LOCATION_PICKER } from '../../shared/desk-access';
import { syncClass } from '../../sync';
import { parseBody, createLocationSchema, updateLocationSchema } from '../../shared/validation';
import type { LocationRow } from '../../shared/types';

const router = Router();
router.use(requireAuth);

const LIST_SQL = `
  SELECT l.*,
         (SELECT COALESCE(SUM(s.quantity), 0) FROM inventory_stock s WHERE s.location_id = l.id) AS total_units,
         (SELECT COUNT(*) FROM inventory_stock s WHERE s.location_id = l.id AND s.quantity <> 0) AS item_count,
         (SELECT c.max_units FROM location_capacities c WHERE c.location_id = l.id) AS capacity
  FROM locations l
`;

/** Names are local to each node; paths give operators an unambiguous pick target. */
function withPaths(rows: LocationRow[]): LocationRow[] {
  const byId = new Map(queryAll<LocationRow>('SELECT id, name, parent_id FROM locations').map((row) => [row.id, row]));
  return rows.map((row) => {
    const names = [row.name];
    const seen = new Set([row.id]);
    let parent = row.parent_id;
    while (parent && byId.has(parent) && !seen.has(parent)) {
      const node = byId.get(parent)!;
      names.unshift(node.name);
      seen.add(parent);
      parent = node.parent_id;
    }
    return { ...row, path: names.join(' / '), depth: names.length };
  });
}

function parentDepth(parentId: number | null | undefined, movingId?: number): number | null {
  let depth = 0;
  let current = parentId;
  const seen = new Set<number>();
  while (current != null) {
    if (current === movingId || seen.has(current)) return null;
    seen.add(current);
    const parent = queryOne<{ parent_id: number | null }>('SELECT parent_id FROM locations WHERE id = ?', current);
    if (!parent) return null;
    depth++;
    current = parent.parent_id;
  }
  return depth;
}

function subtreeHeight(id: number): number {
  const rows = queryAll<{ depth: number }>(`WITH RECURSIVE descendants(id, depth) AS (
    SELECT id, 1 FROM locations WHERE id = ?
    UNION ALL SELECT l.id, d.depth + 1 FROM locations l JOIN descendants d ON l.parent_id = d.id
  ) SELECT MAX(depth) AS depth FROM descendants`, id);
  return rows[0]?.depth ?? 1;
}

function siblingNameTaken(name: string, parentId: number | null | undefined, exceptId?: number): boolean {
  return !!queryOne('SELECT 1 FROM locations WHERE name = ? COLLATE NOCASE AND parent_id IS ? AND id != ? LIMIT 1',
    name, parentId ?? null, exceptId ?? -1);
}

/** Set (a positive number) or clear (null) a location's capacity; undefined leaves it. */
function setCapacity(id: number, capacity: number | null | undefined): void {
  if (capacity === undefined) return;
  if (capacity === null) run('DELETE FROM location_capacities WHERE location_id = ?', id);
  else run(`INSERT INTO location_capacities (location_id, max_units) VALUES (?, ?)
            ON CONFLICT(location_id) DO UPDATE SET max_units = excluded.max_units, updated_at = datetime('now')`, id, capacity);
}

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
// The list also opens to the RTS desk, which picks where ready-to-sell stock goes (shared/desk-access.ts).
router.get('/', requireAnyPermission(['inventory.view', ...LOCATION_PICKER]), (req, res) => {
  const { q } = req.query;
  let sql = LIST_SQL;
  const params: unknown[] = [];
  if (typeof q === 'string' && q.trim()) {
    sql += ' WHERE (l.name LIKE ? OR l.address LIKE ? OR l.type LIKE ?)';
    const like = `%${q.trim()}%`;
    params.push(like, like, like);
  }
  sql += ' ORDER BY l.is_default DESC, l.name COLLATE NOCASE';
  res.json(withPaths(queryAll<LocationRow>(sql, ...params)));
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
  res.json({ ...withPaths([loc])[0], items });
});

// POST /api/locations
router.post('/', requirePermission('inventory.create'), syncClass('merge'), (req, res) => {
  const input = parseBody(createLocationSchema, req.body);
  const depth = parentDepth(input.parent_id);
  if (depth === null) { res.status(400).json({ error: 'Parent location not found' }); return; }
  if (depth >= 5) { res.status(400).json({ error: 'A location can have at most five levels' }); return; }
  if (siblingNameTaken(input.name, input.parent_id)) { res.status(409).json({ error: 'That location name already exists under this parent.' }); return; }
  const isFirst = (queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM locations')?.n ?? 0) === 0;
  const info = run(
    'INSERT INTO locations (name, parent_id, type, address, notes, is_default) VALUES (?, ?, ?, ?, ?, ?)',
    input.name,
    input.parent_id ?? null,
    input.type,
    input.address ?? null,
    input.notes ?? null,
    (isFirst || input.is_default) ? 1 : 0
  );
  const id = Number(info.lastInsertRowid);
  setCapacity(id, input.capacity);
  if (isFirst || input.is_default) setSoleDefault(id);
  res.status(201).json({ id });
});

// PUT /api/locations/:id
// A location's own records are decided by its home site offline (docs/OFFLINE-FIRST.md §16).
const ownSite = { home: (req: Request) => ({ location: Number(req.params.id) }) };

router.put('/:id', requirePermission('inventory.edit'), syncClass('claim', ownSite), (req, res) => {
  const id = Number(req.params.id);
  const existing = queryOne<LocationRow>('SELECT * FROM locations WHERE id = ?', id);
  if (!existing) {
    res.status(404).json({ error: 'Location not found' });
    return;
  }
  const input = parseBody(updateLocationSchema, req.body);
  const parentId = input.parent_id === undefined ? existing.parent_id : input.parent_id;
  const depth = parentDepth(parentId, id);
  if (depth === null) { res.status(400).json({ error: 'Parent location not found or would create a cycle' }); return; }
  if (depth + subtreeHeight(id) > 5) { res.status(400).json({ error: 'A location can have at most five levels' }); return; }
  if (siblingNameTaken(input.name ?? existing.name, parentId, id)) { res.status(409).json({ error: 'That location name already exists under this parent.' }); return; }
  run(
    `UPDATE locations SET name = ?, parent_id = ?, type = ?, address = ?, notes = ?, updated_at = datetime('now') WHERE id = ?`,
    input.name ?? existing.name,
    parentId ?? null,
    input.type ?? existing.type,
    input.address !== undefined ? input.address : existing.address,
    input.notes !== undefined ? input.notes : existing.notes,
    id
  );
  setCapacity(id, input.capacity);
  if (input.is_default) setSoleDefault(id);
  res.json({ ok: true });
});

// POST /api/locations/:id/default — make this the default location
router.post('/:id/default', requirePermission('inventory.edit'), syncClass('claim'), (req, res) => {
  const id = Number(req.params.id);
  if (!queryOne('SELECT id FROM locations WHERE id = ?', id)) {
    res.status(404).json({ error: 'Location not found' });
    return;
  }
  setSoleDefault(id);
  res.json({ ok: true });
});

// DELETE /api/locations/:id
router.delete('/:id', requirePermission('inventory.delete'), syncClass('claim', ownSite), (req, res) => {
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
  if (queryOne('SELECT 1 FROM locations WHERE parent_id = ? LIMIT 1', id)) {
    res.status(409).json({ error: 'Move or delete sublocations before deleting this location.' });
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
