import {moduleEnabled} from '../../shared/modules';
import { authorizationRequired } from '../inventory/release-auth';
/** Finished products + their bill of materials (bom_components).
    A finished product is an inventory_items row flagged is_finished_product = 1. */
import { Router } from 'express';
import { db, queryOne, queryAll, run } from '../../shared/db';
import { requireAuth, requirePermission, requireAnyPermission } from '../../shared/auth';
import { parseBody, saveBomSchema, assignChecklistSchema, allocateUnitsSchema, packageItemsSchema } from '../../shared/validation';
import { applyStockChange, transferStock, getDefaultLocationId } from '../inventory/inventory-stock';
import { explode, rollupCost, whereUsed } from './bom-explode';
import { dbBomResolvers } from './bom-resolvers';
import type { BomComponent, InventoryItem, JobOrderUnit } from '../../shared/types';
import { syncClass } from '../../sync';
import { idempotency } from '../../shared/idempotency';

const router = Router();
/** The product catalog (list, one product, its units) is read by sales orders and the warehouse
    as well as production; BOM explosion, cost, where-used and labels need production.view. */
const catalogRead = requireAnyPermission(['inventory.view', 'production.view']);
router.use(requireAuth);

/** How many whole units are buildable from current component stock (0 if no BOM). */
const MAX_BUILDABLE_SQL = `
  SELECT COALESCE(MIN(CAST(ci.quantity / b.quantity AS INTEGER)), 0)
  FROM bom_components b JOIN inventory_items ci ON ci.id = b.component_item_id
  WHERE b.product_item_id = i.id
`;

const bomRows = (productId: number) =>
  queryAll<BomComponent>(
    `SELECT b.*, i.name AS component_name, i.sku AS component_sku, i.unit AS component_unit,
            i.quantity AS component_on_hand
     FROM bom_components b JOIN inventory_items i ON i.id = b.component_item_id
     WHERE b.product_item_id = ?
     ORDER BY b.sort, b.id`,
    productId
  );

// Optional per-unit standard costs live in the item's `attributes` JSON (same place
// as standard_cost / purchase_price). Surface them as plain numbers on responses.
const STD_COST_COLS = `
  COALESCE(CAST(json_extract(i.attributes, '$.std_labor_cost')    AS REAL), 0) AS std_labor_cost,
  COALESCE(CAST(json_extract(i.attributes, '$.std_overhead_cost') AS REAL), 0) AS std_overhead_cost,
  CAST(json_extract(i.attributes, '$.selling_markup_percent') AS REAL) AS selling_markup_percent
`;

// GET /api/finished-products — every item flagged as a finished product
router.get('/', catalogRead, (_req, res) => {
  const rows = queryAll<InventoryItem & { component_count: number; max_buildable: number }>(
    `SELECT i.*, cl_qa.name AS qc_checklist_qa_name, cl_qc.name AS qc_checklist_qc_name, ${STD_COST_COLS},
            (SELECT COUNT(*) FROM bom_components b WHERE b.product_item_id = i.id) AS component_count,
            (${MAX_BUILDABLE_SQL}) AS max_buildable
     FROM inventory_items i
     LEFT JOIN qc_checklists cl_qa ON cl_qa.id = i.qc_checklist_qa_id
     LEFT JOIN qc_checklists cl_qc ON cl_qc.id = i.qc_checklist_qc_id
     WHERE i.is_finished_product = 1
     ORDER BY i.name COLLATE NOCASE`
  );
  res.json(rows);
});

// GET /api/finished-products/:id — the product + its BOM + how many are buildable now
router.get('/:id', catalogRead, (req, res) => {
  const id = Number(req.params.id);
  const item = queryOne<InventoryItem>(
    `SELECT i.*, cl_qa.name AS qc_checklist_qa_name, cl_qc.name AS qc_checklist_qc_name, ${STD_COST_COLS}
     FROM inventory_items i
     LEFT JOIN qc_checklists cl_qa ON cl_qa.id = i.qc_checklist_qa_id
     LEFT JOIN qc_checklists cl_qc ON cl_qc.id = i.qc_checklist_qc_id
     WHERE i.id = ?`,
    id
  );
  if (!item) {
    res.status(404).json({ error: 'Item not found' });
    return;
  }
  const bom = bomRows(id);
  const max_buildable = queryOne<{ n: number }>(
    `SELECT COALESCE(MIN(CAST(ci.quantity / b.quantity AS INTEGER)), 0) AS n
     FROM bom_components b JOIN inventory_items ci ON ci.id = b.component_item_id
     WHERE b.product_item_id = ?`,
    id
  )?.n ?? 0;

  // "Explode" the on-hand quantity by unit identifier (serial / chassis / motor no.).
  // `reserved` units are earmarked for a sale order but still physically in stock, so they
  // count toward the on-hand total the same as `in_stock`.
  const units = queryAll<{ identifier: string; quantity: number }>(
    `SELECT COALESCE(NULLIF(TRIM(identifier), ''), '') AS identifier, COUNT(*) AS quantity
     FROM job_order_units
     WHERE product_item_id = ? AND status IN ('in_stock', 'reserved')
     GROUP BY COALESCE(NULLIF(TRIM(identifier), ''), '')
     ORDER BY quantity DESC, identifier`,
    id
  );
  const serialized_total = units.reduce((s, u) => s + u.quantity, 0);
  const bulk_untracked = Math.max(0, item.quantity - serialized_total);

  res.json({ ...item, bom, max_buildable, units, serialized_total, bulk_untracked });
});

// GET /api/finished-products/:id/explode?qty=N — recursively resolve the BOM down
// to raw materials (sub-assemblies with their own BOM are expanded), aggregated.
router.get('/:id/explode', requirePermission('production.view'), (req, res) => {
  const id = Number(req.params.id);
  if (!queryOne('SELECT id FROM inventory_items WHERE id = ?', id)) {
    res.status(404).json({ error: 'Item not found' });
    return;
  }
  const qty = Math.max(1, Math.floor(Number(req.query.qty) || 1));
  res.json(explode(id, qty, dbBomResolvers()));
});

// GET /api/finished-products/:id/cost — fully-loaded standard material cost for one
// unit, rolling sub-assembly costs up from their own components.
router.get('/:id/cost', requirePermission('production.view'), requirePermission('inventory.costs'), (req, res) => {
  const id = Number(req.params.id);
  if (!queryOne('SELECT id FROM inventory_items WHERE id = ?', id)) {
    res.status(404).json({ error: 'Item not found' });
    return;
  }
  res.json(rollupCost(id, dbBomResolvers()));
});

// Sales may see the suggested price, but not the internal BOM cost breakdown.
router.get('/:id/price-suggestion', catalogRead, (req, res) => {
  const id = Number(req.params.id);
  const item = queryOne<{ is_finished_product: number; attributes: string | null }>(
    'SELECT is_finished_product, attributes FROM inventory_items WHERE id = ?', id);
  if (!item) { res.status(404).json({ error: 'Item not found' }); return; }
  let attrs: Record<string, unknown> = {};
  try { attrs = item.attributes ? JSON.parse(item.attributes) : {}; } catch { /* no pricing configuration */ }
  const markup = attrs.selling_markup_percent;
  if (!item.is_finished_product || typeof markup !== 'number' || !Number.isFinite(markup) || markup < 0 || markup > 10000) {
    res.json({ available: false, reason: 'No product markup configured' }); return;
  }
  const resolvers = dbBomResolvers();
  const exploded = explode(id, 1, resolvers);
  const cost = rollupCost(id, resolvers);
  if (!exploded.materials.length || exploded.had_cycle || cost.had_cycle ||
      exploded.materials.some((line) => !Number.isFinite(line.unit_cost) || line.unit_cost <= 0) ||
      !Number.isFinite(cost.unit_total_cost) || cost.unit_total_cost <= 0) {
    res.json({ available: false, reason: 'BOM or component standard costs need review' }); return;
  }
  const suggested = Math.round((cost.unit_total_cost * (1 + markup / 100) + Number.EPSILON) * 100) / 100;
  if (!Number.isFinite(suggested) || suggested > 1e12) {
    res.json({ available: false, reason: 'Calculated price is out of range' }); return;
  }
  res.json({ available: true, suggested_unit_price: suggested, markup_percent: markup,
    currency: String(attrs.currency || 'PHP').toUpperCase() });
});

// GET /api/finished-products/:id/where-used — products whose BOM consumes this item
// (directly or through a sub-assembly).
router.get('/:id/where-used', requirePermission('production.view'), (req, res) => {
  const id = Number(req.params.id);
  if (!queryOne('SELECT id FROM inventory_items WHERE id = ?', id)) {
    res.status(404).json({ error: 'Item not found' });
    return;
  }
  const used = whereUsed(id, dbBomResolvers());
  const byId = new Map(used.map((u) => [u.product_id, u.indirect]));
  if (!byId.size) { res.json([]); return; }
  const rows = queryAll<InventoryItem>(
    `SELECT id, name, sku, unit, quantity, is_finished_product
     FROM inventory_items WHERE id IN (${[...byId.keys()].map(() => '?').join(',')})
     ORDER BY name COLLATE NOCASE`,
    ...byId.keys()
  );
  res.json(rows.map((r) => ({ ...r, indirect: byId.get(r.id) ?? false })));
});

// PUT /api/finished-products/:id — mark as a finished product + replace its BOM
router.put('/:id', requirePermission('production.configure'), syncClass('claim'), (req, res) => {
  const id = Number(req.params.id);
  const item = queryOne<InventoryItem>('SELECT id FROM inventory_items WHERE id = ?', id);
  if (!item) {
    res.status(404).json({ error: 'Item not found' });
    return;
  }
  const { components, qc_checklist_qa_id, qc_checklist_qc_id, std_labor_cost, std_overhead_cost, selling_markup_percent } = parseBody(saveBomSchema, req.body);
  if (!req.user!.permissions.includes('inventory.costs') && [std_labor_cost,std_overhead_cost,selling_markup_percent].some(v=>v!==undefined)) {res.status(403).json({error:'Cost and markup changes require inventory.costs'});return;}
  if (!req.user!.permissions.includes('qc.configure') && (qc_checklist_qa_id!==undefined || qc_checklist_qc_id!==undefined)) {res.status(403).json({error:'Checklist assignment requires qc.configure'});return;}

  for (const [label, stage, checklistId] of [['QC', 1, qc_checklist_qc_id], ['QA', 2, qc_checklist_qa_id]] as const) {
    if (checklistId === undefined || checklistId === null) continue;
    const row = queryOne<{ stage: number }>('SELECT stage FROM qc_checklists WHERE id = ?', checklistId);
    if (!row) { res.status(400).json({ error: `That ${label} checklist does not exist` }); return; }
    if (row.stage !== stage) { res.status(400).json({ error: `That checklist isn't a ${label} checklist` }); return; }
  }

  const seen = new Set<number>();
  for (const c of components) {
    if (c.component_item_id === id) {
      res.status(400).json({ error: 'A product cannot be a component of itself' });
      return;
    }
    if (seen.has(c.component_item_id)) {
      res.status(400).json({ error: 'The same component is listed twice' });
      return;
    }
    seen.add(c.component_item_id);
    if (!queryOne('SELECT id FROM inventory_items WHERE id = ?', c.component_item_id)) {
      res.status(400).json({ error: `Component #${c.component_item_id} does not exist` });
      return;
    }
  }

  db.exec('BEGIN');
  try {
    run("UPDATE inventory_items SET is_finished_product = 1, updated_at = datetime('now') WHERE id = ?", id);
    if (qc_checklist_qa_id !== undefined) {
      run('UPDATE inventory_items SET qc_checklist_qa_id = ? WHERE id = ?', qc_checklist_qa_id, id);
    }
    if (qc_checklist_qc_id !== undefined) {
      run('UPDATE inventory_items SET qc_checklist_qc_id = ? WHERE id = ?', qc_checklist_qc_id, id);
    }
    if (std_labor_cost !== undefined || std_overhead_cost !== undefined || selling_markup_percent !== undefined) {
      const row = queryOne<{ attributes: string | null }>('SELECT attributes FROM inventory_items WHERE id = ?', id);
      let attrs: Record<string, unknown> = {};
      try { attrs = row?.attributes ? (JSON.parse(row.attributes) as Record<string, unknown>) : {}; } catch { attrs = {}; }
      const setOrClear = (key: string, val: number | null | undefined): void => {
        if (val === undefined) return;
        if (val === null) delete attrs[key];
        else attrs[key] = val;
      };
      setOrClear('std_labor_cost', std_labor_cost);
      setOrClear('std_overhead_cost', std_overhead_cost);
      setOrClear('selling_markup_percent', selling_markup_percent);
      run("UPDATE inventory_items SET attributes = ?, updated_at = datetime('now') WHERE id = ?", JSON.stringify(attrs), id);
    }
    run('DELETE FROM bom_components WHERE product_item_id = ?', id);
    components.forEach((c, i) => {
      run(
        `INSERT INTO bom_components (product_item_id, component_item_id, quantity, notes, sort)
         VALUES (?, ?, ?, ?, ?)`,
        id,
        c.component_item_id,
        c.quantity,
        c.notes ?? null,
        i
      );
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.json({ ok: true, bom: bomRows(id) });
});

// PATCH /api/finished-products/:id/checklist — assign or clear (null) one stage's
// checklist only, without touching components/costs. Scoped to qc.configure rather than
// inventory.edit — deciding which checklist enforces a stage is a QC decision, not a BOM
// edit — so it works from the QC/QA inspection queue's side panel when a unit shows up
// with no checklist (production-qc.js), without requiring BOM-edit rights.
router.patch('/:id/checklist', requirePermission('qc.configure'), syncClass('claim'), (req, res) => {
  const id = Number(req.params.id);
  if (!queryOne('SELECT id FROM inventory_items WHERE id = ?', id)) {
    res.status(404).json({ error: 'Item not found' });
    return;
  }
  const { stage, checklist_id } = parseBody(assignChecklistSchema, req.body);
  if (checklist_id != null) {
    const row = queryOne<{ stage: number }>('SELECT stage FROM qc_checklists WHERE id = ?', checklist_id);
    if (!row) { res.status(400).json({ error: 'That checklist does not exist' }); return; }
    if (row.stage !== stage) { res.status(400).json({ error: `That checklist isn't a ${stage === 1 ? 'QC' : 'QA'} checklist` }); return; }
  }
  const col = stage === 1 ? 'qc_checklist_qc_id' : 'qc_checklist_qa_id';
  run(`UPDATE inventory_items SET ${col} = ?, updated_at = datetime('now') WHERE id = ?`, checklist_id, id);
  res.json({ ok: true });
});

// GET /api/finished-products/:id/units — this product's physical units.
// `?status=` filters (default `in_stock` — the QC-passed units eligible for label
// printing / sale). Pass `?status=all` for everything.
// GET/PUT /api/finished-products/:id/package — what must leave with each unit of this product
// (charger, keys, documents...). The releaser confirms every required item on the release slip
// (modules/inventory/release-auth.ts); a missing one blocks warehouse-out.
router.get('/:id/package', requirePermission('production.view'), (req, res) => {
  const id = Number(req.params.id);
  res.json(queryAll<{ id: number; label: string; required: number }>(
    'SELECT id, label, required FROM product_package_items WHERE item_id = ? ORDER BY sort, id', id
  ).map((r) => ({ ...r, required: !!r.required })));
});

router.put('/:id/package', requirePermission('production.configure'), syncClass('claim'), (req, res) => {
  const id = Number(req.params.id);
  if (!queryOne('SELECT id FROM inventory_items WHERE id = ?', id)) {
    res.status(404).json({ error: 'Item not found' });
    return;
  }
  const { items } = parseBody(packageItemsSchema, req.body);
  db.exec('BEGIN');
  try {
    run('DELETE FROM product_package_items WHERE item_id = ?', id);
    items.forEach((it, i) => run('INSERT INTO product_package_items (item_id, label, required, sort) VALUES (?, ?, ?, ?)',
      id, it.label, it.required ? 1 : 0, i));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.json({ ok: true, items: items.length });
});

router.get('/:id/units', catalogRead, (req, res) => {
  const id = Number(req.params.id);
  if (!queryOne('SELECT id FROM inventory_items WHERE id = ?', id)) {
    res.status(404).json({ error: 'Item not found' });
    return;
  }
  const status = typeof req.query.status === 'string' ? req.query.status : 'in_stock';
  const where = ['u.product_item_id = ?'];
  const params: unknown[] = [id];
  if (status && status !== 'all') { where.push('u.status = ?'); params.push(status); }
  res.json(
    queryAll<JobOrderUnit>(
      `SELECT u.id, u.identifier, u.status, u.stage, u.location_id, u.order_id,
              u.created_at, u.updated_at,
              jo.number AS job_order_number, jo.build_mode, l.name AS location_name, o.number AS order_number
       FROM job_order_units u
       LEFT JOIN job_orders jo ON jo.id = u.job_order_id
       LEFT JOIN locations l ON l.id = u.location_id
       LEFT JOIN orders o ON o.id = u.order_id
       WHERE ${where.join(' AND ')}
       ORDER BY u.id DESC`,
      ...params
    )
  );
});

// POST /api/finished-products/:id/units/allocate — sell or relocate in-stock units.
// Only units that have passed QA/QC (status = 'in_stock') can be allocated.
router.post('/:id/units/allocate', requireAnyPermission(['inventory.transfer','orders.direct_sale']), idempotency, syncClass('claim'), (req, res) => {
  const id = Number(req.params.id);
  const item = queryOne<InventoryItem>('SELECT * FROM inventory_items WHERE id = ?', id);
  if (!item) { res.status(404).json({ error: 'Item not found' }); return; }
  const input = parseBody(allocateUnitsSchema, req.body);
  if (input.action === 'sell') {
    if (!moduleEnabled('sales')) {res.status(403).json({error:'Sales is not enabled',code:'module_disabled'});return;}
    if (!req.user!.permissions.includes('orders.direct_sale') || !req.user!.permissions.includes('orders.release')) { res.status(403).json({error:'Direct sale and physical release permissions are required'}); return; }
    if (authorizationRequired()) { res.status(409).json({error:'Use Release orders to verify the authorization and issue the trip slip before stock leaves.',code:'release_required'}); return; }
  } else if (!req.user!.permissions.includes('inventory.transfer')) { res.status(403).json({error:'Stock transfer permission is required'}); return; }


  let order: { id: number; number: string; type: string; status: string; location_id: number | null; fulfilled_at: string | null } | undefined;
  let saleLine: { id: number; quantity: number; released_qty: number; dispatched_qty: number; dispatched_bulk_qty: number; cancelled_qty: number } | null = null;
  if (input.order_id != null) {
    order = queryOne<{ id: number; number: string; type: string; status: string; location_id: number | null; fulfilled_at: string | null }>(
      "SELECT id, number, type, status, location_id, fulfilled_at FROM orders WHERE id = ?", input.order_id
    );
    if (!order) { res.status(400).json({ error: 'Sales order not found' }); return; }
    if (input.action === 'sell') {
      if (order.type !== 'sale') { res.status(400).json({ error: 'Choose a sales order for units being sold.' }); return; }
      if (order.fulfilled_at) {
        res.status(409).json({ error: 'This sale already has a physical stock-out. Record a return or correction instead.', code: 'already_shipped' }); return;
      }
      if (!['approved','released'].includes(String(order.status).toLowerCase())) { res.status(409).json({error:'The sales order must be approved before stock can be sold',code:'approval_required'}); return; }
      if (String(order.status).toLowerCase() === 'cancelled') {
        res.status(409).json({ error: 'Cancelled sales cannot receive sold units.' }); return;
      }
      const lines = queryAll<{ id: number; quantity: number; released_qty: number; dispatched_qty: number; dispatched_bulk_qty: number; cancelled_qty: number; fulfillment_mode: string }>(`SELECT id,quantity,released_qty,dispatched_qty,dispatched_bulk_qty,cancelled_qty,fulfillment_mode FROM order_items
        WHERE order_id = ? AND item_id = ? AND fulfillment_mode NOT IN ('ckd','ckd_component')`, input.order_id, id);
      const matching = lines.filter((l) => (l.fulfillment_mode === 'semi_built' ? 'semi_built' : 'assembled') === input.build_mode);
      const selected = input.order_item_id ? matching.find((l) => l.id === input.order_item_id) : matching.length === 1 ? matching[0] : null;
      if (!selected) {
        res.status(409).json({ error: matching.length ? 'Select the exact sale line for these units.' : 'The sale has no line for these units and build state.',
          code: matching.length ? 'line_required' : 'wrong_build' }); return;
      }
      saleLine = selected ?? null;
    }
  }
  if (input.action === 'move' && input.to_location_id != null
    && !queryOne('SELECT id FROM locations WHERE id = ?', input.to_location_id)) {
    res.status(400).json({ error: 'Destination location not found' });
    return;
  }

  // Resolve the target units — explicit ids, else the first N bulk (no-identifier) in-stock.
  let units: Array<JobOrderUnit & { build_mode: 'assembled' | 'semi_built' }>;
  if (input.unit_ids && input.unit_ids.length) {
    units = queryAll<JobOrderUnit & { build_mode: 'assembled' | 'semi_built' }>(
      `SELECT u.*, j.build_mode FROM job_order_units u JOIN job_orders j ON j.id = u.job_order_id
       WHERE u.product_item_id = ? AND u.id IN (${input.unit_ids.map(() => '?').join(',')})`,
      id, ...input.unit_ids
    );
    if (units.length !== input.unit_ids.length) {
      res.status(400).json({ error: 'One or more units are not units of this product' });
      return;
    }
    const notReady = units.filter((u) => u.status !== 'in_stock');
    if (notReady.length) {
      res.status(409).json({ error: 'Only units that have passed QA/QC can be sold or moved' });
      return;
    }
  } else {
    units = queryAll<JobOrderUnit & { build_mode: 'assembled' | 'semi_built' }>(
      `SELECT u.*, j.build_mode FROM job_order_units u JOIN job_orders j ON j.id = u.job_order_id
       WHERE u.product_item_id = ? AND j.build_mode = ? AND u.status = 'in_stock' AND (u.identifier IS NULL OR TRIM(u.identifier) = '')
       ORDER BY u.id LIMIT ?`,
      id, input.build_mode, input.quantity
    );
    if (units.length < (input.quantity ?? 0)) {
      res.status(400).json({ error: `Only ${units.length} untracked in-stock unit(s) available` });
      return;
    }
  }
  if (units.some((u) => u.build_mode !== input.build_mode)) {
    res.status(409).json({ error: 'Selected units have a different build state. Choose fully built or semi-built units separately.' }); return;
  }
  if (saleLine) {
    const occupied = queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM job_order_units u
      WHERE u.order_item_id = ? AND (u.status='reserved' OR u.status='sold' AND u.direct_sold_at IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM release_slip_units su JOIN release_slip_items sli ON sli.id=su.slip_item_id WHERE su.unit_id=u.id AND sli.order_item_id=u.order_item_id))`, saleLine.id)?.n ?? 0;
    const heldBulk = Math.max(0, saleLine.released_qty - saleLine.dispatched_bulk_qty);
    if (occupied + heldBulk + saleLine.dispatched_qty + units.length > saleLine.quantity - saleLine.cancelled_qty + 1e-9) {
      res.status(409).json({ error: 'These units exceed the remaining quantity on this sale line.', code: 'line_full' }); return;
    }
    const shipFrom = order!.location_id ?? getDefaultLocationId();
    if (units.some((u) => (u.location_id ?? getDefaultLocationId()) !== shipFrom)) {
      res.status(409).json({ error: 'Move these units to the sale ship-from location before selling them.', code: 'wrong_location' }); return;
    }
  }

  const fallbackLoc = getDefaultLocationId();
  db.exec('BEGIN');
  try {
    for (const u of units) {
      const from = u.location_id ?? fallbackLoc;
      if (input.action === 'sell') {
        applyStockChange({
          itemId: id, locationId: from, change: -1, userId: req.user!.id,
          buildMode: u.build_mode,
          reason: `Sold${order ? ' — ' + order.number : ''}${input.reason ? ' — ' + input.reason : ''}`,
        });
        run(
          "UPDATE job_order_units SET status = 'sold', order_id = ?, order_item_id = ?, direct_sold_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
          order ? order.id : null, saleLine?.id ?? null, u.id
        );
      } else {
        if (from !== input.to_location_id) {
          transferStock({
            itemId: id, fromId: from, toId: input.to_location_id as number, amount: 1,
            buildMode: u.build_mode,
            userId: req.user!.id, reason: input.reason ?? (order ? order.number : null),
          });
        }
        run(
          "UPDATE job_order_units SET location_id = ?, order_id = COALESCE(?, order_id), updated_at = datetime('now') WHERE id = ?",
          input.to_location_id, order ? order.id : null, u.id
        );
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  const now = queryOne<{ quantity: number }>('SELECT quantity FROM inventory_items WHERE id = ?', id);
  res.json({ ok: true, action: input.action, affected: units.length, product_quantity: now?.quantity ?? 0 });
});

// DELETE /api/finished-products/:id — unflag + drop the BOM (the item itself stays)
router.delete('/:id', requirePermission('production.configure'), syncClass('claim'), (req, res) => {
  const id = Number(req.params.id);
  if (!queryOne('SELECT id FROM inventory_items WHERE id = ?', id)) {
    res.status(404).json({ error: 'Item not found' });
    return;
  }
  db.exec('BEGIN');
  try {
    run('DELETE FROM bom_components WHERE product_item_id = ?', id);
    run("UPDATE inventory_items SET is_finished_product = 0, updated_at = datetime('now') WHERE id = ?", id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.json({ ok: true });
});

export default router;
