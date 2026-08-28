/** Manufacturing job orders (Phase B). Build N units of a finished product by
    consuming its BOM. Lifecycle: draft → released → in_progress → completed,
    with pause / cancel returning components that weren't consumed.
    QA/QC gating (qc_stages > 0) and serialized units come in Phase C. */
import { Router } from 'express';
import { db, queryOne, queryAll, run, nextSequence } from '../db';
import { requireAuth, requirePermission } from '../auth';
import {
  parseBody,
  createJobOrderSchema,
  updateJobOrderSchema,
  jobOrderComponentsSchema,
  jobOrderProgressSchema,
} from '../validation';
import { applyStockChange, stockAt, getDefaultLocationId } from '../inventory-stock';
import type { JobOrder, JobOrderComponent, InventoryItem } from '../types';

const router = Router();
router.use(requireAuth);

const readGate = requirePermission('inventory.view');
const writeGate = requirePermission('inventory.adjust');

function loadJobOrder(id: number): JobOrder | null {
  const jo = queryOne<JobOrder>(
    `SELECT j.*, u.full_name AS created_by_name, o.number AS order_number,
            sl.name AS source_location_name, ol.name AS output_location_name
     FROM job_orders j
     LEFT JOIN users u ON u.id = j.created_by
     LEFT JOIN orders o ON o.id = j.order_id
     LEFT JOIN locations sl ON sl.id = j.source_location_id
     LEFT JOIN locations ol ON ol.id = j.output_location_id
     WHERE j.id = ?`,
    id
  );
  if (!jo) return null;
  jo.components = queryAll<JobOrderComponent>(
    `SELECT c.*, i.quantity AS component_on_hand
     FROM job_order_components c
     LEFT JOIN inventory_items i ON i.id = c.component_item_id
     WHERE c.job_order_id = ?
     ORDER BY c.id`,
    id
  );
  return jo;
}

const OPEN_STATES = new Set(['draft', 'released', 'in_progress', 'paused']);

// GET /api/job-orders — list, filterable by ?status= / ?order_id= / ?product_item_id=
router.get('/', readGate, (req, res) => {
  const { status, order_id, product_item_id } = req.query;
  const where: string[] = [];
  const params: unknown[] = [];
  if (typeof status === 'string' && status.trim()) { where.push('j.status = ?'); params.push(status.trim()); }
  if (order_id) { where.push('j.order_id = ?'); params.push(Number(order_id)); }
  if (product_item_id) { where.push('j.product_item_id = ?'); params.push(Number(product_item_id)); }
  const rows = queryAll<JobOrder & { remaining: number }>(
    `SELECT j.*, o.number AS order_number,
            (j.qty_ordered - j.qty_done - j.qty_scrapped) AS remaining
     FROM job_orders j LEFT JOIN orders o ON o.id = j.order_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY j.id DESC`,
    ...params
  );
  res.json(rows);
});

// GET /api/job-orders/:id
router.get('/:id', readGate, (req, res) => {
  const jo = loadJobOrder(Number(req.params.id));
  if (!jo) {
    res.status(404).json({ error: 'Job order not found' });
    return;
  }
  res.json(jo);
});

// POST /api/job-orders — create a draft; snapshots the product's BOM
router.post('/', writeGate, (req, res) => {
  const input = parseBody(createJobOrderSchema, req.body);
  const product = queryOne<InventoryItem>('SELECT * FROM inventory_items WHERE id = ?', input.product_item_id);
  if (!product) {
    res.status(404).json({ error: 'Product not found' });
    return;
  }
  if (!product.is_finished_product) {
    res.status(400).json({ error: 'That item is not a finished product. Define its BOM first.' });
    return;
  }
  const bom = queryAll<{ component_item_id: number; component_name: string; quantity: number }>(
    `SELECT b.component_item_id, i.name AS component_name, b.quantity
     FROM bom_components b JOIN inventory_items i ON i.id = b.component_item_id
     WHERE b.product_item_id = ? ORDER BY b.sort, b.id`,
    product.id
  );
  if (!bom.length) {
    res.status(400).json({ error: 'That finished product has no components in its BOM.' });
    return;
  }
  if (input.order_id && !queryOne('SELECT id FROM orders WHERE id = ?', input.order_id)) {
    res.status(400).json({ error: 'Linked order not found' });
    return;
  }
  const defLoc = getDefaultLocationId();
  const sourceLoc = input.source_location_id ?? defLoc;
  const outputLoc = input.output_location_id ?? defLoc;
  for (const loc of [sourceLoc, outputLoc]) {
    if (!queryOne('SELECT id FROM locations WHERE id = ?', loc)) {
      res.status(400).json({ error: 'Location not found' });
      return;
    }
  }

  db.exec('BEGIN');
  let id: number | bigint;
  try {
    const number = nextSequence('mo_seq', 'MO');
    const info = run(
      `INSERT INTO job_orders
        (number, order_id, product_item_id, product_name, qty_ordered, status,
         source_location_id, output_location_id, qc_stages, notes, created_by)
       VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
      number,
      input.order_id ?? null,
      product.id,
      product.name,
      input.qty_ordered,
      sourceLoc,
      outputLoc,
      input.qc_stages,
      input.notes ?? null,
      req.user!.id
    );
    id = info.lastInsertRowid;
    for (const c of bom) {
      run(
        `INSERT INTO job_order_components
          (job_order_id, component_item_id, component_name, qty_per_unit, qty_planned)
         VALUES (?, ?, ?, ?, ?)`,
        id,
        c.component_item_id,
        c.component_name,
        c.quantity,
        c.quantity * input.qty_ordered
      );
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.status(201).json({ id, number: loadJobOrder(Number(id))!.number });
});

// PUT /api/job-orders/:id — edit a draft (recomputes planned qty if qty_ordered changed)
router.put('/:id', writeGate, (req, res) => {
  const id = Number(req.params.id);
  const jo = queryOne<JobOrder>('SELECT * FROM job_orders WHERE id = ?', id);
  if (!jo) {
    res.status(404).json({ error: 'Job order not found' });
    return;
  }
  if (jo.status !== 'draft') {
    res.status(409).json({ error: 'Only a draft job order can be edited' });
    return;
  }
  const input = parseBody(updateJobOrderSchema, req.body);
  const qty = input.qty_ordered ?? jo.qty_ordered;
  for (const loc of [input.source_location_id, input.output_location_id]) {
    if (loc && !queryOne('SELECT id FROM locations WHERE id = ?', loc)) {
      res.status(400).json({ error: 'Location not found' });
      return;
    }
  }

  db.exec('BEGIN');
  try {
    run(
      `UPDATE job_orders SET qty_ordered = ?, source_location_id = ?, output_location_id = ?,
         qc_stages = ?, notes = ?, updated_at = datetime('now')
       WHERE id = ?`,
      qty,
      input.source_location_id !== undefined ? input.source_location_id : jo.source_location_id,
      input.output_location_id !== undefined ? input.output_location_id : jo.output_location_id,
      input.qc_stages !== undefined ? input.qc_stages : jo.qc_stages,
      input.notes !== undefined ? input.notes : jo.notes,
      id
    );
    if (input.qty_ordered !== undefined && input.qty_ordered !== jo.qty_ordered) {
      run('UPDATE job_order_components SET qty_planned = qty_per_unit * ? WHERE job_order_id = ?', qty, id);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.json({ ok: true });
});

// PUT /api/job-orders/:id/components — manually override planned quantities (draft only)
router.put('/:id/components', writeGate, (req, res) => {
  const id = Number(req.params.id);
  const jo = queryOne<JobOrder>('SELECT status FROM job_orders WHERE id = ?', id);
  if (!jo) {
    res.status(404).json({ error: 'Job order not found' });
    return;
  }
  if (jo.status !== 'draft') {
    res.status(409).json({ error: 'Planned quantities can only be changed while the job order is a draft' });
    return;
  }
  const { components } = parseBody(jobOrderComponentsSchema, req.body);
  db.exec('BEGIN');
  try {
    for (const c of components) {
      run(
        'UPDATE job_order_components SET qty_planned = ? WHERE job_order_id = ? AND component_item_id = ?',
        c.qty_planned,
        id,
        c.component_item_id
      );
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.json({ ok: true, job_order: loadJobOrder(id) });
});

// POST /api/job-orders/:id/release — deduct planned components from the source location
router.post('/:id/release', writeGate, (req, res) => {
  const id = Number(req.params.id);
  const jo = loadJobOrder(id);
  if (!jo) {
    res.status(404).json({ error: 'Job order not found' });
    return;
  }
  if (jo.status !== 'draft') {
    res.status(409).json({ error: `Cannot release a job order that is ${jo.status}` });
    return;
  }
  const sourceLoc = jo.source_location_id ?? getDefaultLocationId();
  const shortfalls: string[] = [];
  for (const c of jo.components ?? []) {
    if (c.qty_planned <= 0 || c.component_item_id == null) continue;
    const have = stockAt(c.component_item_id, sourceLoc);
    if (have < c.qty_planned) shortfalls.push(`${c.component_name}: need ${c.qty_planned}, have ${have}`);
  }
  if (shortfalls.length) {
    res.status(400).json({ error: `Not enough stock at ${jo.source_location_name ?? 'the source location'} — ${shortfalls.join('; ')}` });
    return;
  }

  db.exec('BEGIN');
  try {
    for (const c of jo.components ?? []) {
      if (c.qty_planned <= 0 || c.component_item_id == null) continue;
      applyStockChange({
        itemId: c.component_item_id,
        locationId: sourceLoc,
        change: -c.qty_planned,
        reason: `${jo.number}: released to production`,
        userId: req.user!.id,
      });
    }
    run(
      "UPDATE job_orders SET status = 'released', released_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
      id
    );
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.json({ ok: true, job_order: loadJobOrder(id) });
});

// POST /api/job-orders/:id/progress — record finished / scrapped units
router.post('/:id/progress', writeGate, (req, res) => {
  const id = Number(req.params.id);
  const jo = loadJobOrder(id);
  if (!jo) {
    res.status(404).json({ error: 'Job order not found' });
    return;
  }
  if (jo.status !== 'released' && jo.status !== 'in_progress') {
    res.status(409).json({ error: `Job order must be released before recording progress (it is ${jo.status})` });
    return;
  }
  if (jo.qc_stages > 0) {
    res.status(400).json({ error: 'QA/QC inspection is not available yet — set this job order to 0 inspection stages.' });
    return;
  }
  const { done_delta, scrapped_delta } = parseBody(jobOrderProgressSchema, req.body);
  const newDone = jo.qty_done + done_delta;
  const newScrapped = jo.qty_scrapped + scrapped_delta;
  if (newDone + newScrapped > jo.qty_ordered) {
    res.status(400).json({
      error: `That exceeds the ${jo.qty_ordered} ordered (already ${jo.qty_done} done, ${jo.qty_scrapped} scrapped).`,
    });
    return;
  }
  const madeUnits = done_delta + scrapped_delta; // both consume components
  const outputLoc = jo.output_location_id ?? getDefaultLocationId();
  const fullyAccounted = newDone + newScrapped >= jo.qty_ordered;

  db.exec('BEGIN');
  try {
    // Consume components for the units just built (capped at what was reserved).
    for (const c of jo.components ?? []) {
      const add = Math.min(c.qty_per_unit * madeUnits, c.qty_planned - c.qty_consumed);
      if (add > 0) {
        run('UPDATE job_order_components SET qty_consumed = qty_consumed + ? WHERE id = ?', add, c.id);
      }
    }
    // Finished units go into stock (no QC gate at qc_stages = 0).
    if (done_delta > 0 && jo.product_item_id != null) {
      applyStockChange({
        itemId: jo.product_item_id,
        locationId: outputLoc,
        change: done_delta,
        reason: `${jo.number}: produced`,
        userId: req.user!.id,
      });
    }
    // On completion, return whatever was reserved but never consumed.
    if (fullyAccounted) {
      returnUnused(id, jo.number, jo.source_location_id, req.user!.id);
      run(
        "UPDATE job_orders SET qty_done = ?, qty_scrapped = ?, status = 'completed', closed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
        newDone,
        newScrapped,
        id
      );
    } else {
      run(
        "UPDATE job_orders SET qty_done = ?, qty_scrapped = ?, status = 'in_progress', updated_at = datetime('now') WHERE id = ?",
        newDone,
        newScrapped,
        id
      );
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.json({ ok: true, job_order: loadJobOrder(id) });
});

/** Put `qty_planned - qty_consumed` of every component back at the source location.
    Re-reads the component rows so it always sees the latest qty_consumed. */
function returnUnused(joId: number, number: string, sourceLocId: number | null, userId: number): void {
  const sourceLoc = sourceLocId ?? getDefaultLocationId();
  const comps = queryAll<JobOrderComponent>('SELECT * FROM job_order_components WHERE job_order_id = ?', joId);
  for (const c of comps) {
    const back = c.qty_planned - c.qty_consumed;
    if (back > 0 && c.component_item_id != null) {
      applyStockChange({
        itemId: c.component_item_id,
        locationId: sourceLoc,
        change: back,
        reason: `${number}: unused components returned`,
        userId,
      });
      run('UPDATE job_order_components SET qty_consumed = qty_planned WHERE id = ?', c.id);
    }
  }
}

// POST /api/job-orders/:id/pause  &  /resume — no stock movement
router.post('/:id/pause', writeGate, (req, res) => {
  const id = Number(req.params.id);
  const jo = queryOne<JobOrder>('SELECT * FROM job_orders WHERE id = ?', id);
  if (!jo) { res.status(404).json({ error: 'Job order not found' }); return; }
  if (jo.status !== 'released' && jo.status !== 'in_progress') {
    res.status(409).json({ error: `Cannot pause a job order that is ${jo.status}` });
    return;
  }
  run("UPDATE job_orders SET status = 'paused', updated_at = datetime('now') WHERE id = ?", id);
  res.json({ ok: true, job_order: loadJobOrder(id) });
});

router.post('/:id/resume', writeGate, (req, res) => {
  const id = Number(req.params.id);
  const jo = queryOne<JobOrder>('SELECT * FROM job_orders WHERE id = ?', id);
  if (!jo) { res.status(404).json({ error: 'Job order not found' }); return; }
  if (jo.status !== 'paused') {
    res.status(409).json({ error: 'Only a paused job order can be resumed' });
    return;
  }
  run("UPDATE job_orders SET status = 'in_progress', updated_at = datetime('now') WHERE id = ?", id);
  res.json({ ok: true, job_order: loadJobOrder(id) });
});

// POST /api/job-orders/:id/cancel — return unconsumed components, close it out
router.post('/:id/cancel', writeGate, (req, res) => {
  const id = Number(req.params.id);
  const jo = loadJobOrder(id);
  if (!jo) { res.status(404).json({ error: 'Job order not found' }); return; }
  if (!OPEN_STATES.has(jo.status)) {
    res.status(409).json({ error: `Job order is already ${jo.status}` });
    return;
  }
  db.exec('BEGIN');
  try {
    if (jo.released_at) returnUnused(id, jo.number, jo.source_location_id, req.user!.id);
    run(
      "UPDATE job_orders SET status = 'cancelled', closed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
      id
    );
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.json({ ok: true, job_order: loadJobOrder(id) });
});

// POST /api/job-orders/:id/close — force-complete early, returning unused components
router.post('/:id/close', writeGate, (req, res) => {
  const id = Number(req.params.id);
  const jo = loadJobOrder(id);
  if (!jo) { res.status(404).json({ error: 'Job order not found' }); return; }
  if (!['released', 'in_progress', 'paused'].includes(jo.status)) {
    res.status(409).json({ error: `Cannot close a job order that is ${jo.status}` });
    return;
  }
  db.exec('BEGIN');
  try {
    returnUnused(id, jo.number, jo.source_location_id, req.user!.id);
    run(
      "UPDATE job_orders SET status = 'completed', closed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
      id
    );
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.json({ ok: true, job_order: loadJobOrder(id) });
});

// DELETE /api/job-orders/:id — only a never-released draft
router.delete('/:id', writeGate, (req, res) => {
  const id = Number(req.params.id);
  const jo = queryOne<JobOrder>('SELECT status FROM job_orders WHERE id = ?', id);
  if (!jo) { res.status(404).json({ error: 'Job order not found' }); return; }
  if (jo.status !== 'draft') {
    res.status(409).json({ error: 'Only a draft job order can be deleted — cancel it instead.' });
    return;
  }
  run('DELETE FROM job_orders WHERE id = ?', id);
  res.json({ ok: true });
});

export default router;
