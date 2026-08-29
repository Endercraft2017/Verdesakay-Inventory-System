/** Inventory: items, search/filter, stock adjustments with history, dashboard stats. */
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { db, queryOne, queryAll, run, getSetting, setSetting, uploadDir } from '../db';
import { requireAuth, requirePermission } from '../auth';
import {
  parseBody,
  createItemSchema,
  updateItemSchema,
  adjustStockSchema,
  damageStockSchema,
  transferStockSchema,
  formConfigSchema,
  importInventorySchema,
} from '../validation';
import {
  applyStockChange,
  transferStock,
  stockAt,
  stockBreakdown,
  getDefaultLocationId,
} from '../inventory-stock';
import { notifyLowStockCrossed } from '../push';
import { enforceQuota } from '../quota';
import { parseCsvTable, toCsv } from '../csv';
import { whereUsed } from '../bom-explode';
import { dbBomResolvers } from '../bom-resolvers';
import type { InventoryItem, InventoryTransaction } from '../types';

const router = Router();
router.use(requireAuth);

// ---- Item image upload (JPG/PNG/GIF/WebP, 5 MB) — stored under UPLOAD_DIR ----
const IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const imageUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir()),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).slice(0, 12) || '.img';
      cb(null, `item-${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, IMAGE_MIME.has(file.mimetype)),
});

/** Delete a stored image file, ignoring "already gone". */
function unlinkImage(name: string | null | undefined): void {
  if (name) fs.promises.unlink(path.join(uploadDir(), name)).catch(() => {});
}

const ITEM_SELECT = `
  SELECT i.*, d.name AS department_name, s.name AS supplier_name,
         (i.quantity <= i.min_quantity) AS low_stock
  FROM inventory_items i
  LEFT JOIN departments d ON d.id = i.department_id
  LEFT JOIN suppliers s ON s.id = i.supplier_id
`;

const FORM_CONFIG_KEY = 'item_form_config';

/** Items with this category are "damage twins" — copies auto-created when stock is
    reported damaged (see POST /:id/damage). Hidden from the normal list/stats unless
    explicitly requested, so day-to-day inventory isn't cluttered by damage records. */
const DAMAGE_CATEGORY = 'Damage';

/** Parse the stored `attributes` JSON string into an object for API responses. */
function withParsedAttributes<T extends { attributes: unknown }>(item: T): T {
  let attributes: Record<string, unknown> = {};
  if (typeof item.attributes === 'string' && item.attributes) {
    try {
      attributes = JSON.parse(item.attributes) as Record<string, unknown>;
    } catch {
      attributes = {};
    }
  }
  return { ...item, attributes };
}

// GET /api/inventory — list with optional search / filters
router.get('/', (req, res) => {
  const { q, department_id, supplier_id, category, low } = req.query;
  const where: string[] = [];
  const params: unknown[] = [];

  if (typeof q === 'string' && q.trim()) {
    // `spec` lives in the attributes JSON, not a column — reach it with json_extract.
    where.push(
      "(i.name LIKE ? OR i.sku LIKE ? OR i.category LIKE ? OR i.location LIKE ?" +
        " OR json_extract(i.attributes, '$.spec') LIKE ?)"
    );
    const like = `%${q.trim()}%`;
    params.push(like, like, like, like, like);
  }
  if (department_id) {
    where.push('i.department_id = ?');
    params.push(Number(department_id));
  }
  if (supplier_id) {
    where.push('i.supplier_id = ?');
    params.push(Number(supplier_id));
  }
  if (req.query.location_id) {
    where.push('EXISTS (SELECT 1 FROM inventory_stock s WHERE s.item_id = i.id AND s.location_id = ? AND s.quantity <> 0)');
    params.push(Number(req.query.location_id));
  }
  if (typeof category === 'string' && category.trim()) {
    where.push('i.category = ?');
    params.push(category.trim());
  }
  if (low === '1' || low === 'true') {
    where.push('i.quantity <= i.min_quantity');
  }
  // Damage twins are excluded by default; `?damaged=only` isolates them,
  // `?include_damaged=1` returns everything.
  const damaged = req.query.damaged;
  const includeDamaged = req.query.include_damaged === '1' || req.query.include_damaged === 'true';
  if (damaged === 'only') {
    where.push('i.category = ?');
    params.push(DAMAGE_CATEGORY);
  } else if (!includeDamaged) {
    where.push('(i.category IS NULL OR i.category <> ?)');
    params.push(DAMAGE_CATEGORY);
  }

  const sql =
    ITEM_SELECT +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY i.name COLLATE NOCASE';
  res.json(queryAll<InventoryItem>(sql, ...params).map(withParsedAttributes));
});

// GET /api/inventory/form-config — the saved Item-form customization (or null).
router.get('/form-config', (_req, res) => {
  res.json(getSetting(FORM_CONFIG_KEY) ?? null);
});

// PUT /api/inventory/form-config — save the customization (admin only).
router.put('/form-config', requirePermission('inventory.configure'), (req, res) => {
  const config = parseBody(formConfigSchema, req.body);
  setSetting(FORM_CONFIG_KEY, config);
  res.json({ ok: true });
});

// GET /api/inventory/stats — dashboard summary
router.get('/stats', (_req, res) => {
  const totals = queryOne(
    `SELECT COUNT(*) AS items,
            COALESCE(SUM(quantity), 0) AS total_units,
            COALESCE(SUM(CASE WHEN quantity <= min_quantity THEN 1 ELSE 0 END), 0) AS low_stock,
            COALESCE(SUM(CASE WHEN quantity = 0 THEN 1 ELSE 0 END), 0) AS out_of_stock
     FROM inventory_items
     WHERE category IS NULL OR category <> ?`,
    DAMAGE_CATEGORY
  );
  res.json(totals);
});

// GET /api/inventory/categories — distinct non-empty categories (for filters)
router.get('/categories', (_req, res) => {
  const rows = queryAll<{ category: string }>(
    `SELECT DISTINCT category FROM inventory_items
     WHERE category IS NOT NULL AND TRIM(category) != '' AND category <> ?
     ORDER BY category COLLATE NOCASE`,
    DAMAGE_CATEGORY
  );
  res.json(rows.map((r) => r.category));
});

// GET /api/inventory/movements — the cross-item stock movement feed (all items)
router.get('/movements', requirePermission('inventory.view'), (req, res) => {
  const { item_id, user_id, dir, from, to, q } = req.query;
  const where: string[] = [];
  const params: unknown[] = [];

  if (item_id) { where.push('t.item_id = ?'); params.push(Number(item_id)); }
  if (user_id) { where.push('t.user_id = ?'); params.push(Number(user_id)); }
  if (req.query.location_id) { where.push('t.location_id = ?'); params.push(Number(req.query.location_id)); }
  if (dir === 'in') where.push('t.change > 0');
  else if (dir === 'out') where.push('t.change < 0');
  if (typeof from === 'string' && from.trim()) { where.push('t.created_at >= ?'); params.push(from.trim()); }
  if (typeof to === 'string' && to.trim()) { where.push('t.created_at <= ?'); params.push(to.trim()); }
  if (typeof q === 'string' && q.trim()) {
    where.push('(i.name LIKE ? OR i.sku LIKE ? OR t.reason LIKE ?)');
    const like = `%${q.trim()}%`;
    params.push(like, like, like);
  }
  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const offset = Math.max(0, Number(req.query.offset) || 0);

  const total =
    queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM inventory_transactions t JOIN inventory_items i ON i.id = t.item_id${whereSql}`,
      ...params
    )?.n ?? 0;
  const rows = queryAll<InventoryTransaction>(
    `SELECT t.*, i.name AS item_name, i.sku AS item_sku, u.full_name AS user_name, l.name AS location_name
     FROM inventory_transactions t
     JOIN inventory_items i ON i.id = t.item_id
     LEFT JOIN users u ON u.id = t.user_id
     LEFT JOIN locations l ON l.id = t.location_id
     ${whereSql}
     ORDER BY t.id DESC
     LIMIT ? OFFSET ?`,
    ...params,
    limit,
    offset
  );
  res.json({ rows, total, limit, offset });
});

// GET /api/inventory/lookup?code=... — resolve a scanned/typed code (SKU or the
// `barcode` attribute) to exactly one item. Used by the mobile scanner.
// Declared before `/:id` so "lookup" isn't captured as an id.
router.get('/lookup', requirePermission('inventory.view'), (req, res) => {
  const code = typeof req.query.code === 'string' ? req.query.code.trim() : '';
  if (!code) {
    res.status(400).json({ error: 'A code is required' });
    return;
  }
  const item = queryOne<InventoryItem>(
    ITEM_SELECT + " WHERE i.sku = ? OR json_extract(i.attributes, '$.barcode') = ? LIMIT 1",
    code,
    code
  );
  if (item) {
    res.json(withParsedAttributes(item));
    return;
  }

  // Not a SKU / barcode — try a serialized finished-product unit's identifier
  // (the codes printed on QR labels for units that passed QA/QC).
  const unit = queryOne<{ id: number; identifier: string; status: string; product_item_id: number; job_order_number: string | null }>(
    `SELECT u.id, u.identifier, u.status, u.product_item_id, jo.number AS job_order_number
     FROM job_order_units u LEFT JOIN job_orders jo ON jo.id = u.job_order_id
     WHERE u.identifier = ? AND u.product_item_id IS NOT NULL
     ORDER BY u.id DESC LIMIT 1`,
    code
  );
  if (unit) {
    const prod = queryOne<InventoryItem>(ITEM_SELECT + ' WHERE i.id = ? LIMIT 1', unit.product_item_id);
    if (prod) {
      res.json({
        ...withParsedAttributes(prod),
        unit: { id: unit.id, identifier: unit.identifier, status: unit.status, job_order_number: unit.job_order_number },
      });
      return;
    }
  }

  res.status(404).json({ error: 'No item matches that code' });
});

// ---- CSV import / export ----------------------------------------------------
// Column set shared by both directions. `department` / `supplier` are matched/emitted
// by name; `quantity` is only honoured on import when creating a new item (initial
// stock) — existing items' quantity is never changed by an import (use /adjust).
const CSV_COLUMNS = [
  'name', 'sku', 'category', 'department', 'supplier',
  'unit', 'min_quantity', 'quantity', 'location', 'notes',
] as const;

// Accept a few friendly header spellings for the two numeric columns.
const HEADER_ALIASES: Record<string, string> = {
  min: 'min_quantity', minimum: 'min_quantity', 'reorder level': 'min_quantity', reorder: 'min_quantity',
  qty: 'quantity', stock: 'quantity', 'on hand': 'quantity',
};

// GET /api/inventory/export — every non-damage item as a CSV (round-trips with import)
router.get('/export', requirePermission('inventory.view'), (_req, res) => {
  const rows = queryAll<Record<string, unknown>>(
    `SELECT i.name, i.sku, i.category, d.name AS department, s.name AS supplier,
            i.unit, i.min_quantity, i.quantity, i.location, i.notes
     FROM inventory_items i
     LEFT JOIN departments d ON d.id = i.department_id
     LEFT JOIN suppliers s ON s.id = i.supplier_id
     WHERE IFNULL(i.category, '') <> ?
     ORDER BY i.name COLLATE NOCASE`,
    DAMAGE_CATEGORY
  );
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="inventory-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(toCsv([...CSV_COLUMNS], rows));
});

// POST /api/inventory/import — create/update items from CSV text.
// Body: { csv: string, dry_run?: boolean }. Upsert key is `sku`; rows without a SKU
// (or with an unknown SKU) are created. Returns a per-row report; a bad row is
// skipped with an error, it doesn't abort the batch. `dry_run` validates + rolls back.
router.post('/import', requirePermission('inventory.create'), (req, res) => {
  const { csv, dry_run } = parseBody(importInventorySchema, req.body);
  const table = parseCsvTable(csv);
  if (table.headers.length === 0) {
    res.status(400).json({ error: 'The CSV is empty.' });
    return;
  }
  const norm = (h: string) => HEADER_ALIASES[h.toLowerCase()] ?? h.toLowerCase();
  const present = new Set(table.headers.map(norm));
  if (!present.has('name')) {
    res.status(400).json({ error: 'The CSV must have a "name" column.' });
    return;
  }
  const get = (row: Record<string, string>, col: string): string => {
    for (const [k, v] of Object.entries(row)) if (norm(k) === col) return v;
    return '';
  };

  const errors: { row: number; sku: string; message: string }[] = [];
  let created = 0;
  let updated = 0;

  db.exec('BEGIN');
  try {
    table.rows.forEach((raw, idx) => {
      const rowNo = idx + 1; // 1-based data row (header is row 0)
      const sku = get(raw, 'sku').trim();
      try {
        const parsed = createItemSchema.safeParse({
          name: get(raw, 'name'),
          sku: sku || undefined,
          category: get(raw, 'category') || undefined,
          unit: get(raw, 'unit') || undefined,
          min_quantity: get(raw, 'min_quantity') || 0,
          quantity: get(raw, 'quantity') || 0,
          location: get(raw, 'location') || undefined,
          notes: get(raw, 'notes') || undefined,
        });
        if (!parsed.success) {
          errors.push({ row: rowNo, sku, message: parsed.error.issues[0]?.message ?? 'Invalid row' });
          return;
        }
        const data = parsed.data;

        // Resolve department / supplier by name (optional columns).
        const deptName = get(raw, 'department').trim();
        const supName = get(raw, 'supplier').trim();
        let departmentId: number | null = null;
        let supplierId: number | null = null;
        if (deptName) {
          const d = queryOne<{ id: number }>('SELECT id FROM departments WHERE name = ? COLLATE NOCASE', deptName);
          if (!d) { errors.push({ row: rowNo, sku, message: `Unknown department "${deptName}"` }); return; }
          departmentId = d.id;
        }
        if (supName) {
          const s = queryOne<{ id: number }>('SELECT id FROM suppliers WHERE name = ? COLLATE NOCASE', supName);
          if (!s) { errors.push({ row: rowNo, sku, message: `Unknown supplier "${supName}"` }); return; }
          supplierId = s.id;
        }

        const existing = sku
          ? queryOne<InventoryItem>('SELECT * FROM inventory_items WHERE sku = ?', sku)
          : undefined;

        if (existing) {
          run(
            `UPDATE inventory_items SET
               name = ?, category = ?, department_id = ?, supplier_id = ?,
               unit = ?, min_quantity = ?, location = ?, notes = ?, updated_at = datetime('now')
             WHERE id = ?`,
            data.name,
            data.category ?? existing.category ?? null,
            departmentId ?? existing.department_id ?? null,
            supplierId ?? existing.supplier_id ?? null,
            data.unit ?? existing.unit ?? 'pcs',
            data.min_quantity,
            data.location ?? existing.location ?? null,
            data.notes ?? existing.notes ?? null,
            existing.id
          );
          updated++;
        } else {
          const info = run(
            `INSERT INTO inventory_items
               (name, sku, category, department_id, supplier_id, quantity, unit, min_quantity, location, notes)
             VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
            data.name,
            data.sku ?? null,
            data.category ?? null,
            departmentId,
            supplierId,
            data.unit ?? 'pcs',
            data.min_quantity,
            data.location ?? null,
            data.notes ?? null
          );
          if (data.quantity && data.quantity !== 0) {
            applyStockChange({
              itemId: Number(info.lastInsertRowid),
              locationId: getDefaultLocationId(),
              change: data.quantity,
              reason: 'Import: initial stock',
              userId: req.user!.id,
            });
          }
          created++;
        }
      } catch (rowErr) {
        errors.push({ row: rowNo, sku, message: rowErr instanceof Error ? rowErr.message : 'Row failed' });
      }
    });

    if (dry_run) db.exec('ROLLBACK');
    else db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  res.json({
    dry_run: !!dry_run,
    total: table.rows.length,
    created,
    updated,
    skipped: errors.length,
    errors: errors.slice(0, 200),
  });
});

// GET /api/inventory/:id/stock — this item's quantity at every location (for adjust/transfer UI)
router.get('/:id/stock', requirePermission('inventory.view'), (req, res) => {
  const id = Number(req.params.id);
  if (!queryOne('SELECT id FROM inventory_items WHERE id = ?', id)) {
    res.status(404).json({ error: 'Item not found' });
    return;
  }
  res.json(stockBreakdown(id));
});

// GET /api/inventory/:id/where-used — finished products / sub-assemblies whose BOM
// consumes this item, directly or indirectly.
router.get('/:id/where-used', requirePermission('inventory.view'), (req, res) => {
  const id = Number(req.params.id);
  if (!queryOne('SELECT id FROM inventory_items WHERE id = ?', id)) {
    res.status(404).json({ error: 'Item not found' });
    return;
  }
  const used = whereUsed(id, dbBomResolvers());
  if (!used.length) { res.json([]); return; }
  const byId = new Map(used.map((u) => [u.product_id, u.indirect]));
  const rows = queryAll<InventoryItem>(
    `SELECT id, name, sku, unit, quantity, is_finished_product
     FROM inventory_items WHERE id IN (${[...byId.keys()].map(() => '?').join(',')})
     ORDER BY name COLLATE NOCASE`,
    ...byId.keys()
  );
  res.json(rows.map((r) => ({ ...r, indirect: byId.get(r.id) ?? false })));
});

// GET /api/inventory/:id — single item with recent transactions + per-location breakdown
router.get('/:id', (req, res) => {
  const item = queryOne<InventoryItem>(ITEM_SELECT + ' WHERE i.id = ?', Number(req.params.id));
  if (!item) {
    res.status(404).json({ error: 'Item not found' });
    return;
  }
  const history = queryAll<InventoryTransaction>(
    `SELECT t.*, u.full_name AS user_name, l.name AS location_name
     FROM inventory_transactions t
     LEFT JOIN users u ON u.id = t.user_id
     LEFT JOIN locations l ON l.id = t.location_id
     WHERE t.item_id = ?
     ORDER BY t.id DESC LIMIT 50`,
    item.id
  );
  const stock = queryAll(
    `SELECT s.location_id, l.name AS location_name, l.type AS location_type, s.quantity
     FROM inventory_stock s JOIN locations l ON l.id = s.location_id
     WHERE s.item_id = ? AND s.quantity <> 0
     ORDER BY s.quantity DESC, l.name COLLATE NOCASE`,
    item.id
  );
  res.json({ ...withParsedAttributes(item), history, stock });
});

// POST /api/inventory — create item
router.post('/', requirePermission('inventory.create'), (req, res) => {
  enforceQuota('inventory_items');
  const input = parseBody(createItemSchema, req.body);
  if (input.sku) {
    const dupe = queryOne('SELECT id FROM inventory_items WHERE sku = ?', input.sku);
    if (dupe) {
      res.status(409).json({ error: 'An item with that SKU already exists' });
      return;
    }
  }

  // Where the starting stock lands: an explicit location, or the default one.
  let startLoc: number | null = null;
  if (input.quantity !== 0) {
    startLoc = input.location_id ?? getDefaultLocationId();
    if (!queryOne('SELECT id FROM locations WHERE id = ?', startLoc)) {
      res.status(400).json({ error: 'Starting-stock location not found' });
      return;
    }
  }

  // Item is inserted at qty 0; applyStockChange bumps both the total and the
  // per-location row so the two can never disagree.
  db.exec('BEGIN');
  let itemId: number | bigint;
  try {
    const info = run(
      `INSERT INTO inventory_items
        (name, sku, category, department_id, supplier_id, quantity, unit, min_quantity, location, notes, attributes)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
      input.name,
      input.sku ?? null,
      input.category ?? null,
      input.department_id,
      input.supplier_id,
      input.unit ?? 'pcs',
      input.min_quantity,
      input.location ?? null,
      input.notes ?? null,
      input.attributes ? JSON.stringify(input.attributes) : null
    );
    itemId = info.lastInsertRowid;

    if (startLoc !== null) {
      applyStockChange({
        itemId: Number(itemId),
        locationId: startLoc,
        change: input.quantity,
        reason: 'Initial stock',
        userId: req.user!.id,
      });
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.status(201).json({ id: itemId });
});

// PUT /api/inventory/:id — update details (not quantity; use /adjust)
router.put('/:id', requirePermission('inventory.edit'), (req, res) => {
  const id = Number(req.params.id);
  const item = queryOne<InventoryItem>('SELECT * FROM inventory_items WHERE id = ?', id);
  if (!item) {
    res.status(404).json({ error: 'Item not found' });
    return;
  }
  const input = parseBody(updateItemSchema, req.body);
  const sku = input.sku !== undefined ? input.sku : item.sku;
  if (sku) {
    const dupe = queryOne('SELECT id FROM inventory_items WHERE sku = ? AND id != ?', sku, id);
    if (dupe) {
      res.status(409).json({ error: 'Another item already uses that SKU' });
      return;
    }
  }

  run(
    `UPDATE inventory_items
     SET name = ?, sku = ?, category = ?, department_id = ?, supplier_id = ?, unit = ?, min_quantity = ?,
         location = ?, notes = ?, attributes = ?, updated_at = datetime('now')
     WHERE id = ?`,
    input.name ?? item.name,
    sku,
    input.category !== undefined ? input.category : item.category,
    input.department_id !== undefined ? input.department_id : item.department_id,
    input.supplier_id !== undefined ? input.supplier_id : item.supplier_id,
    input.unit !== undefined ? (input.unit ?? 'pcs') : item.unit,
    input.min_quantity !== undefined ? input.min_quantity : item.min_quantity,
    input.location !== undefined ? input.location : item.location,
    input.notes !== undefined ? input.notes : item.notes,
    input.attributes !== undefined ? JSON.stringify(input.attributes) : (item.attributes ?? null),
    id
  );
  res.json({ ok: true });
});

// POST /api/inventory/:id/adjust — stock in / out at one location, recorded as a transaction
router.post('/:id/adjust', requirePermission('inventory.adjust'), (req, res) => {
  const id = Number(req.params.id);
  const item = queryOne<InventoryItem>('SELECT * FROM inventory_items WHERE id = ?', id);
  if (!item) {
    res.status(404).json({ error: 'Item not found' });
    return;
  }
  const { change, reason, location_id } = parseBody(adjustStockSchema, req.body);
  const locId = location_id ?? getDefaultLocationId();
  const loc = queryOne<{ name: string }>('SELECT name FROM locations WHERE id = ?', locId);
  if (!loc) {
    res.status(400).json({ error: 'Location not found' });
    return;
  }
  const atLoc = stockAt(id, locId);
  if (atLoc + change < 0) {
    res.status(400).json({ error: `Not enough stock at ${loc.name}. Only ${atLoc} available.` });
    return;
  }

  db.exec('BEGIN');
  let result;
  try {
    result = applyStockChange({
      itemId: id, locationId: locId, change, reason: reason ?? null, userId: req.user!.id,
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  notifyLowStockCrossed(item, item.quantity, result.total);
  res.json({ ok: true, quantity: result.total, location_quantity: result.locationQty });
});

// POST /api/inventory/:id/damage — move damaged units out of an item into its
// "damage twin": a copy row with category 'Damage', created on first use and topped
// up afterwards. The twin is linked back via attributes.damaged_of. Grand total of
// units is preserved (leaves the source, enters the twin).
router.post('/:id/damage', requirePermission('inventory.adjust'), (req, res) => {
  const id = Number(req.params.id);
  const source = queryOne<InventoryItem>('SELECT * FROM inventory_items WHERE id = ?', id);
  if (!source) {
    res.status(404).json({ error: 'Item not found' });
    return;
  }
  if (source.category === DAMAGE_CATEGORY) {
    res.status(400).json({ error: 'That is already a damage record' });
    return;
  }
  const { quantity, reason, location_id } = parseBody(damageStockSchema, req.body);
  const locId = location_id ?? getDefaultLocationId();
  const loc = queryOne<{ name: string }>('SELECT name FROM locations WHERE id = ?', locId);
  if (!loc) {
    res.status(400).json({ error: 'Location not found' });
    return;
  }
  const atLoc = stockAt(id, locId);
  if (quantity > atLoc) {
    res.status(400).json({ error: `Not enough stock at ${loc.name}. Only ${atLoc} available.` });
    return;
  }
  const tail = reason ? ` — ${reason}` : '';

  db.exec('BEGIN');
  let out;
  let inn;
  let twinId: number;
  try {
    // Find or create the damage twin.
    const twin = queryOne<{ id: number }>(
      `SELECT id FROM inventory_items
       WHERE category = ? AND json_extract(attributes, '$.damaged_of') = ?`,
      DAMAGE_CATEGORY,
      id
    );
    if (twin) {
      twinId = twin.id;
    } else {
      let srcAttrs: Record<string, unknown> = {};
      if (typeof source.attributes === 'string' && source.attributes) {
        try { srcAttrs = JSON.parse(source.attributes) as Record<string, unknown>; } catch { /* ignore */ }
      }
      const twinAttrs = { ...srcAttrs, damaged_of: id };
      delete (twinAttrs as { barcode?: unknown }).barcode; // the twin isn't separately scannable
      const info = run(
        `INSERT INTO inventory_items
          (name, sku, category, department_id, supplier_id, quantity, unit, min_quantity, location, notes, attributes)
         VALUES (?, NULL, ?, ?, ?, 0, ?, 0, ?, ?, ?)`,
        source.name,
        DAMAGE_CATEGORY,
        source.department_id,
        source.supplier_id,
        source.unit ?? 'pcs',
        source.location ?? null,
        source.notes ?? null,
        JSON.stringify(twinAttrs)
      );
      twinId = Number(info.lastInsertRowid);
    }

    out = applyStockChange({
      itemId: id, locationId: locId, change: -quantity, userId: req.user!.id,
      reason: `Damaged${tail}`,
    });
    inn = applyStockChange({
      itemId: twinId, locationId: locId, change: quantity, userId: req.user!.id,
      reason: `Damaged stock from #${id}${tail}`,
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  notifyLowStockCrossed(source, source.quantity, out.total);
  res.json({
    ok: true,
    twin_id: twinId,
    twin_quantity: inn.total,
    source_quantity: out.total,
    location_quantity: out.locationQty,
  });
});

// POST /api/inventory/:id/transfer — move stock from one location to another
router.post('/:id/transfer', requirePermission('inventory.adjust'), (req, res) => {
  const id = Number(req.params.id);
  if (!queryOne('SELECT id FROM inventory_items WHERE id = ?', id)) {
    res.status(404).json({ error: 'Item not found' });
    return;
  }
  const { from_location_id, to_location_id, amount, reason } = parseBody(transferStockSchema, req.body);
  if (from_location_id === to_location_id) {
    res.status(400).json({ error: 'Pick two different locations' });
    return;
  }
  const from = queryOne<{ name: string }>('SELECT name FROM locations WHERE id = ?', from_location_id);
  const to = queryOne<{ name: string }>('SELECT name FROM locations WHERE id = ?', to_location_id);
  if (!from || !to) {
    res.status(400).json({ error: 'Location not found' });
    return;
  }
  const available = stockAt(id, from_location_id);
  if (amount > available) {
    res.status(400).json({ error: `Only ${available} available at ${from.name} to transfer.` });
    return;
  }

  db.exec('BEGIN');
  let result;
  try {
    result = transferStock({
      itemId: id, fromId: from_location_id, toId: to_location_id, amount,
      reason: reason ?? null, userId: req.user!.id,
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.json({ ok: true, from: result.from, to: result.to });
});

// DELETE /api/inventory/:id
router.delete('/:id', requirePermission('inventory.delete'), (req, res) => {
  const item = queryOne<InventoryItem>('SELECT image_path FROM inventory_items WHERE id = ?', Number(req.params.id));
  const info = run('DELETE FROM inventory_items WHERE id = ?', Number(req.params.id));
  if (info.changes === 0) {
    res.status(404).json({ error: 'Item not found' });
    return;
  }
  unlinkImage(item?.image_path);
  res.json({ ok: true });
});

// GET /api/inventory/:id/image — stream the item's photo (auth via the shared client)
router.get('/:id/image', (req, res) => {
  const item = queryOne<InventoryItem>(
    'SELECT image_path FROM inventory_items WHERE id = ?',
    Number(req.params.id)
  );
  if (!item || !item.image_path) {
    res.status(404).json({ error: 'No image for this item' });
    return;
  }
  const file = path.join(uploadDir(), item.image_path);
  if (!fs.existsSync(file)) {
    res.status(404).json({ error: 'Image file missing' });
    return;
  }
  res.sendFile(file);
});

// POST /api/inventory/:id/image — upload / replace the item's photo
router.post('/:id/image', requirePermission('inventory.edit'), imageUpload.single('image'), (req, res) => {
  const id = Number(req.params.id);
  const item = queryOne<InventoryItem>('SELECT image_path FROM inventory_items WHERE id = ?', id);
  if (!item) {
    if (req.file) unlinkImage(req.file.filename);
    res.status(404).json({ error: 'Item not found' });
    return;
  }
  if (!req.file) {
    res.status(400).json({ error: 'An image file is required (JPG, PNG, GIF or WebP)' });
    return;
  }
  try {
    enforceQuota('storage_mb', req.file.size);
  } catch (e) {
    unlinkImage(req.file.filename);
    throw e;
  }
  run(
    "UPDATE inventory_items SET image_path = ?, updated_at = datetime('now') WHERE id = ?",
    req.file.filename,
    id
  );
  unlinkImage(item.image_path); // drop the previous file, if any
  res.json({ ok: true, image_path: req.file.filename });
});

// DELETE /api/inventory/:id/image — remove the item's photo
router.delete('/:id/image', requirePermission('inventory.edit'), (req, res) => {
  const id = Number(req.params.id);
  const item = queryOne<InventoryItem>('SELECT image_path FROM inventory_items WHERE id = ?', id);
  if (!item) {
    res.status(404).json({ error: 'Item not found' });
    return;
  }
  run("UPDATE inventory_items SET image_path = NULL, updated_at = datetime('now') WHERE id = ?", id);
  unlinkImage(item.image_path);
  res.json({ ok: true });
});

// Turn multer's upload errors into clean 400s (mirrors forms.routes.ts).
router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Image is larger than 5 MB' : err.message;
    res.status(400).json({ error: msg });
    return;
  }
  next(err);
});

export default router;
