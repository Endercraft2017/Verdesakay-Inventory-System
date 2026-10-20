import { saleHeld } from './sale-holds';
import { kitPickedAt, repairHeld } from '../manufacturing/stock-holds';
import { parseProductionLabel } from '../manufacturing/label-code';
import { batchBalances } from './batch-stock';
/** Inventory: items, search/filter, stock adjustments with history, dashboard stats. */
import path from 'node:path';
import fs from 'node:fs';
import { storeDurableUpload, resolveDurableUploadAsync, forgetDurableUpload } from '../../shared/durable-uploads';
import crypto from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { db, queryOne, queryAll, run, getSetting, setSetting, uploadDir } from '../../shared/db';
import { requireAuth, requirePermission, requireAnyPermission } from '../../shared/auth';
import { ITEM_PICKER, UNIT_RECORD } from '../../shared/desk-access';
import { recordSiteClash, syncClass } from '../../sync';
import { syncUpload } from '../../sync/files';
import { siteDecisionStands, syncContext } from '../../shared/sync-context';
import {
  parseBody,
  ValidationError,
  createItemSchema,
  updateItemSchema,
  adjustStockSchema,
  damageStockSchema,
  transferStockSchema,
  formConfigSchema,
  importInventorySchema,
  reorderPoSchema,
  resolveDiscrepancySchema,
  directSaleStockoutReviewSchema,
} from '../../shared/validation';
import { createDraftPurchaseOrders } from './orders.routes';
import {
  applyStockChange,
  transferStock,
  stockAt,
  variantStockAt,
  serializedOnHand,
  stockBreakdown,
  locationName,
  getDefaultLocationId,
  findOrCreateDamageTwin,
  overdrawAllowed,
} from './inventory-stock';
import { notifyLowStockCrossed } from '../../shared/push';
import { enforceQuota } from '../../platform/quota';
import { parseCsvTable, toCsv } from '../../shared/csv';
import { whereUsed } from '../manufacturing/bom-explode';
import { dbBomResolvers } from '../manufacturing/bom-resolvers';
import type { InventoryItem, InventoryTransaction } from '../../shared/types';
import { findDirectSaleStockoutCase, listDirectSaleStockoutCases } from './direct-sale-stockout-audit';
import stockCountRoutes from './stock-counts.routes';

function salesStock(itemId:number) {
  return stockBreakdown(itemId).map(s=>{
    const assembled=Math.max(0,s.assembled_quantity-saleHeld(itemId,s.location_id,'assembled')-kitPickedAt(itemId,s.location_id)-repairHeld(itemId,s.location_id));
    const semi=Math.max(0,s.semi_built_quantity-saleHeld(itemId,s.location_id,'semi_built'));
    return {...s,reserved_for_sales:saleHeld(itemId,s.location_id),available_quantity:assembled+semi,assembled_available:assembled,semi_built_available:semi};
  });
}
function salesAvailability(itemId:number) {
  return {reserved_for_sales:saleHeld(itemId),available_quantity:salesStock(itemId).reduce((n,s)=>n+s.available_quantity,0)};
}

const router = Router();
router.use(requireAuth);
router.use('/stock-counts', stockCountRoutes);

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
  if (name) {
    forgetDurableUpload(name);
    fs.promises.unlink(path.join(uploadDir(), name)).catch(() => {});
  }
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

// Reads need inventory.view. The item picker (a parts request / revision) and a scanned code also
// open to the desks that make them (shared/desk-access.ts) — those callers get only what a picker
// shows (id, name, SKU, unit, on hand), not costs, suppliers or notes.
const viewGate = requirePermission('inventory.view');
const pickerGate = requireAnyPermission(['inventory.view', ...ITEM_PICKER]);
const lookupGate = requireAnyPermission(['inventory.view', ...ITEM_PICKER, ...UNIT_RECORD]);
const pickerView = (req: Request, item: InventoryItem): object => req.user!.permissions.includes('inventory.view')
  ? withParsedAttributes(item)
  : { id: item.id, name: item.name, sku: item.sku, unit: item.unit, quantity: item.quantity };

// GET /api/inventory — list with optional search / filters
router.get('/', pickerGate, (req, res) => {
  const { q, department_id, supplier_id, category, product_group, low, kind } = req.query;
  const where: string[] = [];
  const params: unknown[] = [];

  // Both kinds share inventory_items and stock accounting; the list can focus on
  // one kind without inventing a second SKU or duplicating a stock balance.
  if (kind === 'parts') where.push('COALESCE(i.is_finished_product, 0) = 0');
  else if (kind === 'finished') where.push('i.is_finished_product = 1');
  else if (kind !== undefined && kind !== 'all') { res.status(400).json({ error: 'Unknown item kind' }); return; }

  if (typeof q === 'string' && q.trim()) {
    // `spec` lives in the attributes JSON, not a column — reach it with json_extract.
    // product_group is searchable too, so typing the base product's name surfaces every
    // variant even when the variant's own name doesn't repeat it (e.g. just "Red").
    where.push(
      "(i.name LIKE ? OR i.sku LIKE ? OR i.category LIKE ? OR i.location LIKE ?" +
        " OR i.product_group LIKE ? OR json_extract(i.attributes, '$.spec') LIKE ?)"
    );
    const like = `%${q.trim()}%`;
    params.push(like, like, like, like, like, like);
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
  if (typeof product_group === 'string' && product_group.trim()) {
    where.push('i.product_group = ?');
    params.push(product_group.trim());
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
  res.json(queryAll<InventoryItem>(sql, ...params).map((i) => pickerView(req, {...i,...salesAvailability(i.id)})));
});

// GET /api/inventory/form-config — the saved Item-form customization (or null).
router.get('/form-config', viewGate, (_req, res) => {
  res.json(getSetting(FORM_CONFIG_KEY) ?? null);
});

// PUT /api/inventory/form-config — save the customization (admin only).
router.put('/form-config', requirePermission('inventory.configure'), syncClass('claim'), (req, res) => {
  const config = parseBody(formConfigSchema, req.body);
  setSetting(FORM_CONFIG_KEY, config);
  res.json({ ok: true });
});

// GET /api/inventory/stats — dashboard summary
router.get('/stats', viewGate, (_req, res) => {
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
router.get('/categories', viewGate, (_req, res) => {
  const rows = queryAll<{ category: string }>(
    `SELECT DISTINCT category FROM inventory_items
     WHERE category IS NOT NULL AND TRIM(category) != '' AND category <> ?
     ORDER BY category COLLATE NOCASE`,
    DAMAGE_CATEGORY
  );
  res.json(rows.map((r) => r.category));
});

// GET /api/inventory/product-groups — distinct non-empty product groups (for filters and the
// item form's "existing group" suggestions)
router.get('/product-groups', viewGate, (_req, res) => {
  const rows = queryAll<{ product_group: string }>(
    `SELECT DISTINCT product_group FROM inventory_items
     WHERE product_group IS NOT NULL AND TRIM(product_group) != ''
     ORDER BY product_group COLLATE NOCASE`
  );
  res.json(rows.map((r) => r.product_group));
});

// POST /api/inventory/reorder-po — draft purchase order(s) to restock items at/under their
// reorder level, grouped by each item's preferred supplier. Body: { item_ids?, multiplier? }.
// With no item_ids it sweeps every low-stock item (damage twins + finished products excluded
// — a low finished product is produced, not bought). Order qty tops each item up to
// `min_quantity * multiplier` (default 2×), always at least 1.
router.post('/reorder-po', requirePermission('purchasing.manage'), syncClass('claim'), (req, res) => {
  const { item_ids, multiplier } = parseBody(reorderPoSchema, req.body);
  const mult = multiplier ?? 2;

  const where = [
    'i.quantity <= i.min_quantity',
    '(i.category IS NULL OR i.category <> ?)',
    'COALESCE(i.is_finished_product, 0) = 0',
  ];
  const params: unknown[] = [DAMAGE_CATEGORY];
  if (item_ids && item_ids.length) {
    where.push(`i.id IN (${item_ids.map(() => '?').join(',')})`);
    params.push(...item_ids);
  }
  const low = queryAll<{ id: number; quantity: number; min_quantity: number }>(
    `SELECT i.id, i.quantity, i.min_quantity FROM inventory_items i WHERE ${where.join(' AND ')}`,
    ...params
  );
  if (!low.length) {
    res.json({ created: [], considered: 0, note: 'Nothing is at or below its reorder level.' });
    return;
  }
  const wants = low.map((it) => {
    const target = Math.ceil((Number(it.min_quantity) || 0) * mult);
    return { item_id: it.id, quantity: Math.max(1, target - (Number(it.quantity) || 0)) };
  });
  const created = createDraftPurchaseOrders(wants, 'Reorder-level restock', req.user!.id);
  res.json({ created, considered: low.length });
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
router.get('/lookup', lookupGate, (req, res) => {
  const code = typeof req.query.code === 'string' ? req.query.code.trim() : '';
  if (!code) {
    res.status(400).json({ error: 'A code is required' });
    return;
  }
  const label=parseProductionLabel(code);
  if(!label){
    const identities=queryOne<{n:number}>(`SELECT (SELECT COUNT(*) FROM job_order_units WHERE LOWER(COALESCE(NULLIF(TRIM(identifier),''),'UNIT-' || id))=LOWER(?))
      +(SELECT COUNT(*) FROM production_batches WHERE LOWER(number)=LOWER(?))
      +(SELECT COUNT(*) FROM inventory_items WHERE LOWER(sku)=LOWER(?) OR LOWER(json_extract(attributes,'$.barcode'))=LOWER(?)) AS n`,code,code,code,code)!.n;
    if(identities>1){res.status(409).json({error:'Ambiguous older label. Open the exact record and reprint its QR sticker.',code:'ambiguous_label'});return;}
  }
  const item = !label && queryOne<InventoryItem>(
    ITEM_SELECT + " WHERE i.sku = ? OR json_extract(i.attributes, '$.barcode') = ? LIMIT 1",
    code,
    code
  );
  if (item) {
    res.json(pickerView(req, item));
    return;
  }

  // Not a SKU / barcode — try a serialized finished-product unit's identifier
  // (the codes printed on QR labels for units that passed QA/QC).
  const unit = queryOne<{ id: number; identifier: string; status: string; product_item_id: number; job_order_number: string | null }>(
    `SELECT u.id, u.identifier, u.status, u.product_item_id, jo.number AS job_order_number
     FROM job_order_units u LEFT JOIN job_orders jo ON jo.id = u.job_order_id
     WHERE (CASE WHEN ? IS NOT NULL THEN (?='unit' AND u.id=?) ELSE LOWER(COALESCE(NULLIF(TRIM(u.identifier), ''),'UNIT-' || u.id))=LOWER(?) END) AND u.product_item_id IS NOT NULL
     ORDER BY u.id DESC LIMIT 1`,
    label?.kind??null,label?.kind??null,label?.id??null,code
  );
  if (unit) {
    const prod = queryOne<InventoryItem>(ITEM_SELECT + ' WHERE i.id = ? LIMIT 1', unit.product_item_id);
    if (prod) {
      res.json({
        ...pickerView(req, prod),
        unit: { id: unit.id, identifier: unit.identifier || ('UNIT-' + unit.id), status: unit.status, job_order_number: unit.job_order_number },
      });
      return;
    }
  }

  // Or a production batch/lot — by its BATCH-##### number or its identifier label.
  const batch = queryOne<{ id: number; number: string; identifier: string | null; status: string; qty: number; product_item_id: number | null; job_order_number: string | null }>(
    `SELECT b.id, b.number, b.identifier, b.status, b.qty, b.product_item_id, jo.number AS job_order_number
     FROM production_batches b LEFT JOIN job_orders jo ON jo.id = b.job_order_id
     WHERE (CASE WHEN ? IS NOT NULL THEN (?='batch' AND b.id=?) ELSE (b.number = ? OR b.identifier = ?) END)
     ORDER BY b.id DESC LIMIT 1`,
    label?.kind??null,label?.kind??null,label?.id??null,code,code
  );
  if (batch) {
    const prod = batch.product_item_id
      ? queryOne<InventoryItem>(ITEM_SELECT + ' WHERE i.id = ? LIMIT 1', batch.product_item_id)
      : null;
    res.json({
      ...(prod ? pickerView(req, prod) : {}),
      batch: {
        id: batch.id, number: batch.number, identifier: batch.identifier,
        status: batch.status, qty: batch.qty, job_order_number: batch.job_order_number,
        balances:batchBalances(batch.id),
        received_quantity:queryOne<{n:number}>('SELECT COALESCE(SUM(quantity),0) AS n FROM production_receipt_items WHERE batch_id=?',batch.id)?.n??0,
        allocations:queryAll(`SELECT a.quantity,a.state,o.number AS order_number FROM production_batch_allocations a JOIN orders o ON o.id=a.order_id WHERE a.batch_id=?`,batch.id),
      },
    });
    return;
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
router.post('/import', requirePermission('inventory.create'), syncClass('claim'), (req, res) => {
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
          if (!req.user!.permissions.includes('inventory.edit')) {
            errors.push({ row: rowNo, sku, message: 'Editing an existing item requires inventory.edit' }); return;
          }
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
          if (data.quantity && !req.user!.permissions.includes('inventory.adjust')) { errors.push({row:rowNo,sku,message:'Starting stock requires inventory.adjust'}); return; }
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


// Historical direct sales may have been deducted again when their slip was issued.
// This queue presents ledger evidence only; reviewing never changes quantities.
router.get('/direct-sale-audit', viewGate, (req, res) => {
  const status = req.query.status === 'reviewed' ? 'reviewed' : req.query.status === 'all' ? 'all' : 'open';
  res.json(listDirectSaleStockoutCases(status));
});

router.post('/direct-sale-audit/:orderId/:itemId/review', requirePermission('inventory.adjust'),
  syncClass('claim', { home: (req: Request) => ({ location: queryOne<{location_id:number|null}>(
    'SELECT location_id FROM orders WHERE id=?', Number(req.params.orderId))?.location_id ?? null }) }), (req, res) => {
  const orderId = Number(req.params.orderId);
  const itemId = Number(req.params.itemId);
  if (!Number.isSafeInteger(orderId) || orderId < 1 || !Number.isSafeInteger(itemId) || itemId < 1) {
    res.status(400).json({ error: 'Invalid order or item' });
    return;
  }
  const { evidence_hash, note } = parseBody(directSaleStockoutReviewSchema, req.body);
  const candidate = findDirectSaleStockoutCase(orderId, itemId);
  if (!candidate) {
    res.status(404).json({ error: 'Audit candidate no longer exists; refresh the queue' });
    return;
  }
  if (candidate.evidence_hash !== evidence_hash) {
    res.status(409).json({ error: 'Audit evidence changed; refresh and review the new movements' });
    return;
  }
  const info = run(`INSERT OR IGNORE INTO direct_sale_stockout_reviews(order_id,item_id,evidence_hash,note,reviewed_by)
    VALUES(?,?,?,?,?)`, orderId, itemId, evidence_hash, note, req.user!.id);
  if (!info.changes) {
    const existing = queryOne<{note:string}>(`SELECT note FROM direct_sale_stockout_reviews
      WHERE order_id=? AND item_id=? AND evidence_hash=?`,orderId,itemId,evidence_hash);
    if (existing?.note === note) res.json({ ok: true, already_reviewed: true });
    else res.status(409).json({ error: 'This evidence was already reviewed; refresh the queue' });
    return;
  }
  res.json({ ok: true });
});

// ---- Stock discrepancies (docs/OFFLINE-FIRST.md decision D1) ----
// An offline stock-out is accepted even when the records say the stock isn't there (the goods
// physically left); the location then goes below zero and a discrepancy is opened for a
// supervisor to count or correct. Registered before '/:id' so the path isn't read as an id.

// GET /api/inventory/discrepancies?status=open|resolved|all (default open), newest first
router.get('/discrepancies', requirePermission('inventory.view'), (req, res) => {
  const status = req.query.status === 'all' ? 'all' : req.query.status === 'resolved' ? 'resolved' : 'open';
  const rows = queryAll(
    `SELECT d.*, i.name AS item_name, i.sku, i.unit, l.name AS location_name,
            cu.full_name AS created_by_name, ru.full_name AS resolved_by_name,
            COALESCE(s.quantity, 0) AS location_quantity_now
       FROM stock_discrepancies d
       JOIN inventory_items i ON i.id = d.item_id
       LEFT JOIN locations l ON l.id = d.location_id
       LEFT JOIN inventory_stock s ON s.item_id = d.item_id AND s.location_id = d.location_id
       LEFT JOIN users cu ON cu.id = d.created_by
       LEFT JOIN users ru ON ru.id = d.resolved_by
      WHERE ? = 'all' OR d.status = ?
      ORDER BY d.created_at DESC, d.id DESC
      LIMIT 500`,
    status, status
  );
  res.json(rows);
});

// POST /api/inventory/discrepancies/:id/resolve — record what was found/done. Moves no stock:
// correct the count with a normal adjustment first. A decision, so `claim` offline — made by
// the site the discrepancy's location belongs to (docs/OFFLINE-FIRST.md §16).
const discrepancySite = {
  home: (req: Request) => ({
    location: queryOne<{ location_id: number | null }>('SELECT location_id FROM stock_discrepancies WHERE id = ?', Number(req.params.id))?.location_id ?? null,
  }),
};
router.post('/discrepancies/:id/resolve', requirePermission('inventory.adjust'), syncClass('claim', discrepancySite), (req, res) => {
  const id = Number(req.params.id);
  const { note } = parseBody(resolveDiscrepancySchema, req.body);
  const info = run(
    `UPDATE stock_discrepancies
        SET status = 'resolved', resolution_note = ?, resolved_by = ?, resolved_at = datetime('now')
      WHERE id = ? AND status = 'open'`,
    note, req.user!.id, id
  );
  if (info.changes === 0) {
    const exists = queryOne('SELECT id FROM stock_discrepancies WHERE id = ?', id);
    // Clash-check (D6): resolved elsewhere meanwhile. A site's resolution of its own discrepancy
    // stands — the first resolution is kept, and the clash is flagged for an admin.
    if (exists && siteDecisionStands()) {
      recordSiteClash(req, `Stock discrepancy #${id} was resolved on the cloud and at the site; the first resolution was kept. Site's note: ${note}`);
      res.json({ ok: true, clash: true });
      return;
    }
    res.status(exists ? 409 : 404).json({ error: exists ? 'Already resolved' : 'Discrepancy not found' });
    return;
  }
  res.json({ ok: true });
});

// GET /api/inventory/:id/stock — this item's quantity at every location (for adjust/transfer UI)
router.get('/:id/stock', requirePermission('inventory.view'), (req, res) => {
  const id = Number(req.params.id);
  if (!queryOne('SELECT id FROM inventory_items WHERE id = ?', id)) {
    res.status(404).json({ error: 'Item not found' });
    return;
  }
  res.json(salesStock(id));
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
router.get('/:id', viewGate, (req, res) => {
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
  const stock = queryAll<{ location_id: number; location_name: string; location_type: string; quantity: number }>(
    `SELECT s.location_id, l.name AS location_name, l.type AS location_type, s.quantity
     FROM inventory_stock s JOIN locations l ON l.id = s.location_id
     WHERE s.item_id = ? AND s.quantity <> 0
     ORDER BY s.quantity DESC, l.name COLLATE NOCASE`,
    item.id
  );
  res.json({ ...withParsedAttributes(item), ...salesAvailability(item.id),
    preferred_location_name: item.preferred_location_id ? locationName(item.preferred_location_id) : null,
    history: history.map((h) => ({ ...h, location_name: h.location_id ? locationName(h.location_id) : null })),
    stock: stock.map((s) => ({ ...s, ...salesStock(item.id).find(x=>x.location_id===s.location_id),location_name: locationName(s.location_id) })) });
});

// POST /api/inventory — create item
router.post('/', requirePermission('inventory.create'), syncClass('merge'), (req, res) => {
  enforceQuota('inventory_items');
  const input = parseBody(createItemSchema, req.body);
  if (input.quantity && !req.user!.permissions.includes('inventory.adjust')) { res.status(403).json({error:'Starting stock requires inventory.adjust'}); return; }
  if (!req.user!.permissions.includes('inventory.costs') && (input.unit_cost || Object.keys(input.attributes || {}).some(k => /cost|purchase_price/.test(k)))) { res.status(403).json({error:'Cost entry requires inventory.costs'}); return; }
  if (input.sku) {
    const dupe = queryOne('SELECT id FROM inventory_items WHERE sku = ?', input.sku);
    if (dupe) {
      res.status(409).json({ error: 'An item with that SKU already exists' });
      return;
    }
  }

  // Create optional child locations and the item in one transaction: a failed item
  // save must not leave empty shelves behind. Existing callers can omit location_id.
  db.exec('BEGIN');
  let itemId: number | bigint;
  let startLoc: number;
  try {
    if (input.new_location_levels?.length && input.location_id == null) {
      throw new ValidationError('Choose the parent location before adding sublocations');
    }
    startLoc = input.location_id ?? getDefaultLocationId();
    const parent = queryOne<{ parent_id: number | null }>(
      'SELECT parent_id FROM locations WHERE id = ?', startLoc
    );
    if (!parent) throw new ValidationError('Starting-stock location not found');
    let depth = 1;
    let ancestor = parent.parent_id;
    const seen = new Set([startLoc]);
    while (ancestor != null) {
      if (seen.has(ancestor)) throw new ValidationError('Starting-stock location hierarchy is invalid');
      seen.add(ancestor);
      const row = queryOne<{ parent_id: number | null }>('SELECT parent_id FROM locations WHERE id = ?', ancestor);
      if (!row) throw new ValidationError('Starting-stock location hierarchy is invalid');
      depth++;
      ancestor = row.parent_id;
    }
    if (depth + (input.new_location_levels?.length ?? 0) > 5) throw new ValidationError('A location can have at most five levels');
    for (const name of input.new_location_levels ?? []) {
      if (queryOne('SELECT 1 FROM locations WHERE name = ? COLLATE NOCASE AND parent_id = ? LIMIT 1', name, startLoc)) {
        throw Object.assign(new Error(`Sublocation "${name}" already exists under this location; select it instead.`), { status: 409 });
      }
      const child = run(
        "INSERT INTO locations (name, parent_id, type, is_default) VALUES (?, ?, 'other', 0)", name, startLoc
      );
      startLoc = Number(child.lastInsertRowid);
    }
    const info = run(
      `INSERT INTO inventory_items
        (name, sku, category, department_id, supplier_id, quantity, unit, min_quantity, unit_cost, location, preferred_location_id, notes, product_group, attributes)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.name,
      input.sku ?? null,
      input.category ?? null,
      input.department_id,
      input.supplier_id,
      input.unit ?? 'pcs',
      input.min_quantity,
      input.unit_cost ?? 0,
      input.location ?? null,
      startLoc,
      input.notes ?? null,
      input.product_group ?? null,
      input.attributes ? JSON.stringify(input.attributes) : null
    );
    itemId = info.lastInsertRowid;

    if (input.quantity !== 0) {
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
  res.status(201).json({ id: itemId, preferred_location_id: startLoc });
});

// PUT /api/inventory/:id — update details (not quantity; use /adjust)
router.put('/:id', requirePermission('inventory.edit'), syncClass('claim'), (req, res) => {
  const id = Number(req.params.id);
  const item = queryOne<InventoryItem>('SELECT * FROM inventory_items WHERE id = ?', id);
  if (!item) {
    res.status(404).json({ error: 'Item not found' });
    return;
  }
  const input = parseBody(updateItemSchema, req.body);
  if (!req.user!.permissions.includes('inventory.costs')) {
    if (input.unit_cost !== undefined && input.unit_cost !== (item.unit_cost || 0)) { res.status(403).json({error:'Cost changes require inventory.costs'}); return; }
    if (input.attributes !== undefined) {
      let previous: Record<string,string|number|boolean|null> = {}; try {previous=typeof item.attributes === 'string' ? JSON.parse(item.attributes || '{}') : (item.attributes || {});} catch {}
      for (const k of new Set([...Object.keys(previous),...Object.keys(input.attributes)])) if (/cost|purchase_price/.test(k)) {
        if (k in input.attributes && input.attributes[k] !== previous[k]) {res.status(403).json({error:'Cost changes require inventory.costs'});return;}
        if (k in previous) input.attributes[k]=previous[k]!;
      }
    }
  }
  if (input.preferred_location_id != null && !queryOne('SELECT id FROM locations WHERE id = ?', input.preferred_location_id)) {
    res.status(400).json({ error: 'Preferred location not found' }); return;
  }
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
     SET name = ?, sku = ?, category = ?, department_id = ?, supplier_id = ?, preferred_location_id = ?, unit = ?, min_quantity = ?,
         unit_cost = ?, location = ?, notes = ?, product_group = ?, attributes = ?, updated_at = datetime('now')
     WHERE id = ?`,
    input.name ?? item.name,
    sku,
    input.category !== undefined ? input.category : item.category,
    input.department_id !== undefined ? input.department_id : item.department_id,
    input.supplier_id !== undefined ? input.supplier_id : item.supplier_id,
    input.preferred_location_id !== undefined ? input.preferred_location_id : item.preferred_location_id,
    input.unit !== undefined ? (input.unit ?? 'pcs') : item.unit,
    input.min_quantity !== undefined ? input.min_quantity : item.min_quantity,
    input.unit_cost !== undefined ? input.unit_cost : item.unit_cost ?? 0,
    input.location !== undefined ? input.location : item.location,
    input.notes !== undefined ? input.notes : item.notes,
    input.product_group !== undefined ? input.product_group : item.product_group,
    input.attributes !== undefined ? JSON.stringify(input.attributes) : (item.attributes ?? null),
    id
  );
  res.json({ ok: true });
});

// POST /api/inventory/:id/adjust — stock in / out at one location, recorded as a transaction
// Offline sync class (docs/OFFLINE-FIRST.md §7.1): a stock movement records something that
// physically happened, so it is `physical` — see overdrawAllowed() below.
router.post('/:id/adjust', requirePermission('inventory.adjust'), syncClass('physical'), (req, res) => {
  const id = Number(req.params.id);
  const item = queryOne<InventoryItem>('SELECT * FROM inventory_items WHERE id = ?', id);
  if (!item) {
    res.status(404).json({ error: 'Item not found' });
    return;
  }
  const { change, reason, location_id, build_mode } = parseBody(adjustStockSchema, req.body);
  if (build_mode === 'semi_built' && !item.is_finished_product) {
    res.status(400).json({ error: 'Semi-built stock is only for finished products. Parts use standard stock.' }); return;
  }
  // The legacy phone Pick screen uses this exact adjustment reason for sale/job
  // fulfilment. A generic adjustment has no order allocation or slip, so accepting
  // it can deduct the same goods twice. Existing offline commands already recorded
  // at a site still replay as physical decisions; new Pick requests must use the
  // order release or production kit workflow.
  if (change < 0 && /^Picked for order\s+/i.test(reason ?? '')
    && !['replay', 'rebase'].includes(syncContext()?.mode ?? '')) {
    res.status(409).json({
      error: 'Legacy Pick cannot adjust stock for an order. Use its warehouse release or production kit workflow.',
      code: 'use_release_workflow',
    });
    return;
  }
  const locId = location_id ?? getDefaultLocationId();
  const loc = queryOne<{ name: string }>('SELECT name FROM locations WHERE id = ?', locId);
  if (!loc) {
    res.status(400).json({ error: 'Location not found' });
    return;
  }
  const atLoc = variantStockAt(id, locId, build_mode);
  const serialQty=serializedOnHand(id,locId,build_mode);
  if(change<0 && serialQty>0 && -change>atLoc-serialQty+1e-9){
    res.status(409).json({error:'This stock includes serialized units. Move or resolve their exact unit records before adjusting them.',code:'use_unit_workflow'});
    return;
  }
  // Offline (D1): the goods left even if the records say they weren't there — accepted and
  // flagged as a stock discrepancy by applyStockChange instead of refused.
  if (atLoc + change < 0 && !overdrawAllowed()) {
    res.status(400).json({ error: `Not enough stock at ${loc.name}. Only ${atLoc} available.` });
    return;
  }

  db.exec('BEGIN');
  let result;
  try {
    result = applyStockChange({
      itemId: id, locationId: locId, change, reason: reason ?? null, userId: req.user!.id, buildMode: build_mode,
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  notifyLowStockCrossed(item, item.quantity, result.total);
  res.json({
    ok: true, quantity: result.total, location_quantity: result.locationQty,
    ...(result.discrepancyId ? { discrepancy_id: result.discrepancyId } : {}),
  });
});

// POST /api/inventory/:id/damage — move damaged units out of an item into its
// "damage twin": a copy row with category 'Damage', created on first use and topped
// up afterwards. The twin is linked back via attributes.damaged_of. Grand total of
// units is preserved (leaves the source, enters the twin).
router.post('/:id/damage', requirePermission('inventory.adjust'), syncClass('physical'), (req, res) => {
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
  const { quantity, reason, location_id, build_mode } = parseBody(damageStockSchema, req.body);
  if (build_mode === 'semi_built' && !source.is_finished_product) {
    res.status(400).json({ error: 'Semi-built stock is only for finished products. Parts use standard stock.' }); return;
  }
  const locId = location_id ?? getDefaultLocationId();
  const loc = queryOne<{ name: string }>('SELECT name FROM locations WHERE id = ?', locId);
  if (!loc) {
    res.status(400).json({ error: 'Location not found' });
    return;
  }
  const atLoc = variantStockAt(id, locId, build_mode);
  const serialQty=serializedOnHand(id,locId,build_mode);
  if(serialQty>0 && quantity>atLoc-serialQty+1e-9){
    res.status(409).json({error:'This stock includes serialized units. Report damage against their exact unit records first.',code:'use_unit_workflow'});
    return;
  }
  if (quantity > atLoc && !overdrawAllowed()) { // offline: accepted + flagged (D1)
    res.status(400).json({ error: `Not enough stock at ${loc.name}. Only ${atLoc} available.` });
    return;
  }
  const tail = reason ? ` — ${reason}` : '';

  db.exec('BEGIN');
  let out;
  let inn;
  let twinId: number;
  try {
    twinId = findOrCreateDamageTwin(id);

    out = applyStockChange({
      itemId: id, locationId: locId, change: -quantity, userId: req.user!.id,
      reason: `Damaged${tail}`, buildMode: build_mode,
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
router.post('/:id/transfer', requirePermission('inventory.transfer'), syncClass('physical'), (req, res) => {
  const id = Number(req.params.id);
  const item = queryOne<InventoryItem>('SELECT id,is_finished_product FROM inventory_items WHERE id = ?', id);
  if (!item) {
    res.status(404).json({ error: 'Item not found' });
    return;
  }
  const { from_location_id, to_location_id, amount, reason, build_mode } = parseBody(transferStockSchema, req.body);
  if (build_mode === 'semi_built' && !item.is_finished_product) {
    res.status(400).json({ error: 'Semi-built stock is only for finished products. Parts use standard stock.' }); return;
  }
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
  const available = variantStockAt(id, from_location_id, build_mode);
  if (amount > available && !overdrawAllowed()) { // offline: accepted + flagged (D1)
    res.status(400).json({ error: `Only ${available} available at ${from.name} to transfer.` });
    return;
  }
  if (queryOne(`SELECT 1 FROM job_order_units u JOIN job_orders j ON j.id = u.job_order_id
    WHERE u.product_item_id = ? AND j.build_mode = ? AND u.status IN ('in_stock', 'reserved')
      AND COALESCE(u.location_id, j.output_location_id, ?) = ? LIMIT 1`,
    id, build_mode, getDefaultLocationId(), from_location_id)) {
    res.status(409).json({ error: 'This build state has tracked units here. Move their unit records from Production → Finished Products so stock and serial locations stay together.', code: 'use_unit_move' });
    return;
  }

  db.exec('BEGIN');
  let result;
  try {
    result = transferStock({
      itemId: id, fromId: from_location_id, toId: to_location_id, amount,
      reason: reason ?? null, userId: req.user!.id, buildMode: build_mode,
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.json({ ok: true, from: result.from, to: result.to });
});

// DELETE /api/inventory/:id
router.delete('/:id', requirePermission('inventory.delete'), syncClass('claim'), (req, res) => {
  const id = Number(req.params.id);
  const item = queryOne<InventoryItem & { quantity: number }>(
    'SELECT image_path, quantity FROM inventory_items WHERE id = ?', id);
  if (!item) { res.status(404).json({ error: 'Item not found' }); return; }

  // An item that still holds stock can't be deleted — zero it out (or transfer/damage it)
  // first, so stock never silently disappears from the books.
  const onHand = queryOne<{ q: number }>(
    'SELECT COALESCE(SUM(quantity), 0) AS q FROM inventory_stock WHERE item_id = ?', id)?.q ?? 0;
  const stockLeft = Math.max(Number(item.quantity) || 0, onHand);
  if (stockLeft > 0) {
    res.status(409).json({
      error: `This item still has ${stockLeft} in stock. Set its quantity to 0 (stock out / transfer / damage) before deleting.`,
    });
    return;
  }

  const info = run('DELETE FROM inventory_items WHERE id = ?', id);
  if (info.changes === 0) { res.status(404).json({ error: 'Item not found' }); return; }
  unlinkImage(item.image_path);
  res.json({ ok: true });
});

// GET /api/inventory/:id/image — stream the item's photo (auth via the shared client)
router.get('/:id/image', viewGate, async (req, res) => {
  const item = queryOne<InventoryItem>(
    'SELECT image_path FROM inventory_items WHERE id = ?',
    Number(req.params.id)
  );
  if (!item || !item.image_path) {
    res.status(404).json({ error: 'No image for this item' });
    return;
  }
  const file = await resolveDurableUploadAsync(item.image_path);
  if (!file) {
    res.status(404).json({ error: 'Image file missing' });
    return;
  }
  res.sendFile(file);
});

// POST /api/inventory/:id/image — upload / replace the item's photo
// An item photo is an edit of company-wide master data: decided offline only at the main site
// (docs/OFFLINE-FIRST.md §16). syncUpload lets the photo travel with the command (§18).
router.post('/:id/image', requirePermission('inventory.edit'), syncClass('claim'), syncUpload(imageUpload.single('image')), (req, res) => {
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
    enforceQuota('storage_mb');
  } catch (e) {
    unlinkImage(req.file.filename);
    throw e;
  }
  run(
    "UPDATE inventory_items SET image_path = ?, updated_at = datetime('now') WHERE id = ?",
    req.file.filename,
    id
  );
  storeDurableUpload(req.file.filename);
  unlinkImage(item.image_path); // drop the previous file, if any
  res.json({ ok: true, image_path: req.file.filename });
});

// DELETE /api/inventory/:id/image — remove the item's photo
router.delete('/:id/image', requirePermission('inventory.edit'), syncClass('claim'), (req, res) => {
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
