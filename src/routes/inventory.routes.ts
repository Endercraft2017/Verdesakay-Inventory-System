/** Inventory: items, search/filter, stock adjustments with history, dashboard stats. */
import { Router } from 'express';
import { db, queryOne, queryAll, run, getSetting, setSetting } from '../db';
import { requireAuth, requirePermission } from '../auth';
import {
  parseBody,
  createItemSchema,
  updateItemSchema,
  adjustStockSchema,
  formConfigSchema,
} from '../validation';
import type { InventoryItem, InventoryTransaction } from '../types';

const router = Router();
router.use(requireAuth);

const ITEM_SELECT = `
  SELECT i.*, d.name AS department_name,
         (i.quantity <= i.min_quantity) AS low_stock
  FROM inventory_items i
  LEFT JOIN departments d ON d.id = i.department_id
`;

const FORM_CONFIG_KEY = 'item_form_config';

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
  const { q, department_id, category, low } = req.query;
  const where: string[] = [];
  const params: unknown[] = [];

  if (typeof q === 'string' && q.trim()) {
    where.push('(i.name LIKE ? OR i.sku LIKE ? OR i.category LIKE ? OR i.location LIKE ?)');
    const like = `%${q.trim()}%`;
    params.push(like, like, like, like);
  }
  if (department_id) {
    where.push('i.department_id = ?');
    params.push(Number(department_id));
  }
  if (typeof category === 'string' && category.trim()) {
    where.push('i.category = ?');
    params.push(category.trim());
  }
  if (low === '1' || low === 'true') {
    where.push('i.quantity <= i.min_quantity');
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
     FROM inventory_items`
  );
  res.json(totals);
});

// GET /api/inventory/categories — distinct non-empty categories (for filters)
router.get('/categories', (_req, res) => {
  const rows = queryAll<{ category: string }>(
    `SELECT DISTINCT category FROM inventory_items
     WHERE category IS NOT NULL AND TRIM(category) != ''
     ORDER BY category COLLATE NOCASE`
  );
  res.json(rows.map((r) => r.category));
});

// GET /api/inventory/:id — single item with recent transactions
router.get('/:id', (req, res) => {
  const item = queryOne<InventoryItem>(ITEM_SELECT + ' WHERE i.id = ?', Number(req.params.id));
  if (!item) {
    res.status(404).json({ error: 'Item not found' });
    return;
  }
  const history = queryAll<InventoryTransaction>(
    `SELECT t.*, u.full_name AS user_name
     FROM inventory_transactions t
     LEFT JOIN users u ON u.id = t.user_id
     WHERE t.item_id = ?
     ORDER BY t.id DESC LIMIT 50`,
    item.id
  );
  res.json({ ...withParsedAttributes(item), history });
});

// POST /api/inventory — create item
router.post('/', (req, res) => {
  const input = parseBody(createItemSchema, req.body);
  if (input.sku) {
    const dupe = queryOne('SELECT id FROM inventory_items WHERE sku = ?', input.sku);
    if (dupe) {
      res.status(409).json({ error: 'An item with that SKU already exists' });
      return;
    }
  }

  const info = run(
    `INSERT INTO inventory_items
      (name, sku, category, department_id, quantity, unit, min_quantity, location, notes, attributes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.name,
    input.sku ?? null,
    input.category ?? null,
    input.department_id,
    input.quantity,
    input.unit ?? 'pcs',
    input.min_quantity,
    input.location ?? null,
    input.notes ?? null,
    input.attributes ? JSON.stringify(input.attributes) : null
  );

  if (input.quantity !== 0) {
    run(
      `INSERT INTO inventory_transactions (item_id, user_id, change, balance_after, reason)
       VALUES (?, ?, ?, ?, 'Initial stock')`,
      info.lastInsertRowid,
      req.user!.id,
      input.quantity,
      input.quantity
    );
  }
  res.status(201).json({ id: info.lastInsertRowid });
});

// PUT /api/inventory/:id — update details (not quantity; use /adjust)
router.put('/:id', (req, res) => {
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
     SET name = ?, sku = ?, category = ?, department_id = ?, unit = ?, min_quantity = ?,
         location = ?, notes = ?, attributes = ?, updated_at = datetime('now')
     WHERE id = ?`,
    input.name ?? item.name,
    sku,
    input.category !== undefined ? input.category : item.category,
    input.department_id !== undefined ? input.department_id : item.department_id,
    input.unit !== undefined ? (input.unit ?? 'pcs') : item.unit,
    input.min_quantity !== undefined ? input.min_quantity : item.min_quantity,
    input.location !== undefined ? input.location : item.location,
    input.notes !== undefined ? input.notes : item.notes,
    input.attributes !== undefined ? JSON.stringify(input.attributes) : (item.attributes ?? null),
    id
  );
  res.json({ ok: true });
});

// POST /api/inventory/:id/adjust — stock in / out, recorded as a transaction
router.post('/:id/adjust', (req, res) => {
  const id = Number(req.params.id);
  const item = queryOne<InventoryItem>('SELECT * FROM inventory_items WHERE id = ?', id);
  if (!item) {
    res.status(404).json({ error: 'Item not found' });
    return;
  }
  const { change, reason } = parseBody(adjustStockSchema, req.body);
  const balance = item.quantity + change;
  if (balance < 0) {
    res.status(400).json({ error: `Not enough stock. Only ${item.quantity} available.` });
    return;
  }

  // Update the balance and record the movement atomically.
  db.exec('BEGIN');
  try {
    run("UPDATE inventory_items SET quantity = ?, updated_at = datetime('now') WHERE id = ?", balance, id);
    run(
      `INSERT INTO inventory_transactions (item_id, user_id, change, balance_after, reason)
       VALUES (?, ?, ?, ?, ?)`,
      id,
      req.user!.id,
      change,
      balance,
      reason ?? null
    );
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.json({ ok: true, quantity: balance });
});

// DELETE /api/inventory/:id
router.delete('/:id', (req, res) => {
  const info = run('DELETE FROM inventory_items WHERE id = ?', Number(req.params.id));
  if (info.changes === 0) {
    res.status(404).json({ error: 'Item not found' });
    return;
  }
  res.json({ ok: true });
});

export default router;
