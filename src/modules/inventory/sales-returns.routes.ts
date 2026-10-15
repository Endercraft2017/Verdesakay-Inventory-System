/** Physical customer returns against an issued release slip. Receipt is evidence of goods
 * arriving, inspection decides whether they re-enter sellable stock. A credit note is a
 * separate Finance decision and never moves inventory. */
import { Router, type Request } from 'express';
import { db, queryAll, queryOne, run, nextSequence } from '../../shared/db';
import { requireAuth, requireAnyPermission, requirePermission } from '../../shared/auth';
import { parseBody, salesReturnReceiveSchema, salesReturnInspectSchema, salesReturnDispositionSchema, salesReturnRepairCompleteSchema, salesReturnReinspectSchema, salesReturnCreditLinkSchema } from '../../shared/validation';
import { syncClass } from '../../sync';
import { applyStockChange, findOrCreateDamageTwin, getDefaultLocationId } from './inventory-stock';
import { postSalesReturnCogs } from '../accounting/accounting-autopost';

const router = Router();
router.use(requireAuth);
const warehouse = requireAnyPermission(['inventory.adjust', 'orders.release']);
const returnSite = { home: (req: Request) => ({ location: queryOne<{ location_id: number | null }>(
  `SELECT o.location_id FROM orders o JOIN release_slips s ON s.order_id = o.id
   ${req.params.id ? 'JOIN sales_returns r ON r.slip_id = s.id WHERE r.id = ?' : 'WHERE s.id = ?'}`,
  Number(req.params.id || req.body?.slip_id)
)?.location_id ?? null }) };

type ReturnRow = { id: number; number: string; slip_id: number; slip_item_id: number; item_id: number;
  fulfillment_mode: string;
  quantity: number; unit_id: number | null; unit_cost: number | null; status: string; credit_note_id: number | null;
  order_id: number; order_number: string; customer_id: number | null; customer_name: string | null;
  item_name: string; slip_number: string; location_id: number | null; credit_note_status: string | null;
  disposition_state: string | null; decision_note: string | null; repair_note: string | null; };
const SELECT = `SELECT r.*, s.number AS slip_number, s.order_id, o.number AS order_number,
  o.customer_id, o.customer_name, i.name AS item_name, COALESCE(oi.fulfillment_mode, 'assembled') AS fulfillment_mode, cn.status AS credit_note_status,
  d.state AS disposition_state, d.decision_note, d.repair_note
  FROM sales_returns r JOIN release_slips s ON s.id = r.slip_id
  JOIN orders o ON o.id = s.order_id JOIN inventory_items i ON i.id = r.item_id
  LEFT JOIN release_slip_items li ON li.id = r.slip_item_id
  LEFT JOIN order_items oi ON oi.id = li.order_item_id
  LEFT JOIN credit_notes cn ON cn.id = r.credit_note_id
  LEFT JOIN sales_return_dispositions d ON d.return_id = r.id`;
const getReturn = (id: number) => queryOne<ReturnRow>(`${SELECT} WHERE r.id = ?`, id);

router.get('/', requireAnyPermission(['inventory.view', 'inventory.adjust', 'orders.release', 'orders.view']), (req, res) => {
  const slipId = Number(req.query.slip_id);
  res.json(slipId > 0 ? queryAll<ReturnRow>(`${SELECT} WHERE r.slip_id = ? ORDER BY r.id DESC`, slipId)
    : queryAll<ReturnRow>(`${SELECT} ORDER BY r.id DESC LIMIT 300`));
});
router.get('/slips/:slipId/context', requireAnyPermission(['inventory.view', 'inventory.adjust', 'orders.release', 'orders.view']), (req, res) => {
  const slipId = Number(req.params.slipId);
  const slip = queryOne<{ id: number; number: string; order_id: number }>(
    'SELECT id, number, order_id FROM release_slips WHERE id = ?', slipId);
  if (!slip) { res.status(404).json({ error: 'Release slip not found.' }); return; }
  const lines = queryAll(`SELECT li.id, li.item_id, li.name, li.sku, li.unit, li.quantity,
    li.unit_identifiers, COALESCE((SELECT SUM(r.quantity) FROM sales_returns r WHERE r.slip_item_id = li.id), 0) AS returned_qty
    FROM release_slip_items li WHERE li.slip_id = ? AND li.item_id IS NOT NULL ORDER BY li.id`, slipId);
  const units = queryAll(`SELECT u.id, u.product_item_id AS item_id, u.identifier
    FROM job_order_units u WHERE u.order_id = ? AND u.status = 'sold'
    AND NOT EXISTS (SELECT 1 FROM sales_returns r WHERE r.unit_id = u.id) ORDER BY u.id`, slip.order_id);
  res.json({ slip, lines, units, returns: queryAll<ReturnRow>(`${SELECT} WHERE r.slip_id = ? ORDER BY r.id DESC`, slipId) });
});
router.get('/:id', requireAnyPermission(['inventory.view', 'inventory.adjust', 'orders.release', 'orders.view']), (req, res) => {
  const row = getReturn(Number(req.params.id));
  if (!row) { res.status(404).json({ error: 'Return not found.' }); return; }
  res.json(row);
});
router.get('/:id/events', requireAnyPermission(['inventory.view', 'inventory.adjust', 'orders.release', 'orders.view']), (req, res) => {
  const id = Number(req.params.id);
  if (!getReturn(id)) { res.status(404).json({ error: 'Return not found.' }); return; }
  res.json(queryAll('SELECT * FROM sales_return_disposition_events WHERE return_id = ? ORDER BY id', id));
});

router.post('/', warehouse, syncClass('physical', returnSite), (req, res) => {
  const b = parseBody(salesReturnReceiveSchema, req.body);
  const line = queryOne<{ id: number; item_id: number; quantity: number; unit_cost: number | null; order_id: number; fulfillment_mode: string }>(
    `SELECT li.id, li.item_id, li.quantity, li.unit_cost, s.order_id, COALESCE(oi.fulfillment_mode, 'assembled') AS fulfillment_mode FROM release_slip_items li
     LEFT JOIN order_items oi ON oi.id = li.order_item_id
     JOIN release_slips s ON s.id = li.slip_id WHERE s.id = ? AND li.id = ?`, b.slip_id, b.slip_item_id);
  if (!line || !line.item_id) { res.status(404).json({ error: 'Slip line not found.' }); return; }
  const already = queryOne<{ n: number }>('SELECT COALESCE(SUM(quantity), 0) AS n FROM sales_returns WHERE slip_item_id = ?', line.id)!.n;
  if (already + b.quantity > line.quantity + 1e-9) {
    res.status(409).json({ error: 'This would exceed the quantity shipped on the slip.', code: 'return_exceeds_shipped' }); return;
  }
  const serialized = !!queryOne(`SELECT 1 FROM job_order_units u JOIN job_orders j ON j.id = u.job_order_id
    WHERE u.product_item_id = ? AND j.build_mode = ? LIMIT 1`, line.item_id,
  line.fulfillment_mode === 'semi_built' ? 'semi_built' : 'assembled');
  if (serialized) {
    const unit = b.unit_id && queryOne<{ id: number; status: string }>(
      'SELECT id, status FROM job_order_units WHERE id = ? AND product_item_id = ? AND order_id = ?',
      b.unit_id, line.item_id, line.order_id);
    if (!unit || unit.status !== 'sold' || b.quantity !== 1) {
      res.status(409).json({ error: 'Select one sold serial from this slip for this return.', code: 'return_serial_required' }); return;
    }
  } else if (b.unit_id) {
    res.status(400).json({ error: 'Bulk goods do not take a serial unit ID.' }); return;
  }
  const evidence = queryAll<{ id: number }>(
    `SELECT id FROM attachments WHERE kind = 'sales_return_proof' AND ref_id = ?
     AND id IN (${b.evidence_ids.map(() => '?').join(',')})`, b.slip_id, ...b.evidence_ids);
  if (new Set(b.evidence_ids).size !== b.evidence_ids.length || evidence.length !== b.evidence_ids.length) {
    res.status(409).json({ error: 'Upload a new photo for this slip before recording the return.', code: 'return_evidence_required' }); return;
  }
  db.exec('BEGIN');
  try {
    const number = nextSequence('sales_return_number', 'SR', 5);
    const id = Number(run(`INSERT INTO sales_returns
      (number, slip_id, slip_item_id, item_id, quantity, unit_id, unit_cost, reason, received_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, number, b.slip_id, b.slip_item_id, line.item_id,
      b.quantity, b.unit_id ?? null, line.unit_cost, b.reason, req.user!.id).lastInsertRowid);
    run(`UPDATE attachments SET kind = 'sales_return', ref_id = ?
      WHERE kind = 'sales_return_proof' AND ref_id = ? AND id IN (${b.evidence_ids.map(() => '?').join(',')})`,
      id, b.slip_id, ...b.evidence_ids);
    db.exec('COMMIT');
    res.status(201).json(getReturn(id));
  } catch (e) { db.exec('ROLLBACK'); throw e; }
});

router.post('/:id/inspect', requirePermission('inventory.adjust'), syncClass('physical', returnSite), (req, res) => {
  const row = getReturn(Number(req.params.id));
  if (!row) { res.status(404).json({ error: 'Return not found.' }); return; }
  if (row.status !== 'received') { res.status(409).json({ error: 'This return was already inspected.', code: 'return_inspected' }); return; }
  const b = parseBody(salesReturnInspectSchema, req.body);
  const loc = b.decision === 'restock' ? (b.location_id ?? getDefaultLocationId()) : null;
  if (loc && !queryOne('SELECT 1 FROM locations WHERE id = ?', loc)) {
    res.status(400).json({ error: 'Receiving location not found.' }); return;
  }
  db.exec('BEGIN');
  try {
    // The return is a distinct receiving event: never change the issued slip or the sale.
    if (loc) applyStockChange({ itemId: row.item_id, locationId: loc, change: row.quantity,
      userId: req.user!.id, reason: `Customer return ${row.number} for ${row.slip_number}`,
      buildMode: row.fulfillment_mode === 'semi_built' ? 'semi_built' : 'assembled' });
    if (row.unit_id) {
      const changed = run(`UPDATE job_order_units SET status = ?, location_id = COALESCE(?, location_id),
        order_id = CASE WHEN ? = 'restock' THEN NULL ELSE order_id END, updated_at = datetime('now')
        WHERE id = ? AND status = 'sold' AND order_id = ?`,
      loc ? 'in_stock' : 'returned_rejected', loc, b.decision, row.unit_id, row.order_id);
      if (changed.changes !== 1) throw new Error('The serialized unit changed since return receipt.');
    }
    run(`UPDATE sales_returns SET status = ?, condition_note = ?, location_id = ?,
      inspected_by = ?, inspected_at = datetime('now') WHERE id = ?`,
      loc ? 'restocked' : 'rejected', b.condition_note, loc, req.user!.id, row.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  const accounting = loc ? postSalesReturnCogs(row.id, req.user!.id) : null;
  res.json({ ...getReturn(row.id), accounting });
});

function event(id: number, action: string, note: string, actor: number) {
  run('INSERT INTO sales_return_disposition_events (return_id, action, note, actor_id) VALUES (?, ?, ?, ?)', id, action, note, actor);
}

router.post('/:id/disposition', requirePermission('inventory.adjust'), syncClass('physical', returnSite), (req, res) => {
  const row = getReturn(Number(req.params.id));
  if (!row) { res.status(404).json({ error: 'Return not found.' }); return; }
  if (row.status !== 'rejected' || row.disposition_state) {
    res.status(409).json({ error: 'Only a rejected return without a disposition can be decided.', code: 'return_disposition_locked' }); return;
  }
  const b = parseBody(salesReturnDispositionSchema, req.body);
  if (b.decision === 'repair' && !row.unit_id) {
    res.status(409).json({ error: 'Repair requires an individually tracked serial. Use salvage or disposal for bulk goods.', code: 'return_serial_required' }); return;
  }
  const loc = b.decision === 'salvage' ? b.location_id : null;
  if (b.decision === 'salvage' && (!loc || !queryOne('SELECT 1 FROM locations WHERE id = ?', loc))) {
    res.status(400).json({ error: 'Choose a valid salvage location.' }); return;
  }
  db.exec('BEGIN');
  try {
    const state = b.decision === 'repair' ? 'repair' : b.decision === 'salvage' ? 'salvaged' : 'disposed';
    if (row.unit_id) {
      const changed = run("UPDATE job_order_units SET status = ?, updated_at = datetime('now') WHERE id = ? AND status = 'returned_rejected' AND order_id = ?",
        state === 'repair' ? 'returned_rework' : state === 'salvaged' ? 'returned_salvaged' : 'returned_disposed', row.unit_id, row.order_id);
      if (changed.changes !== 1) throw new Error('The returned serial changed before disposition.');
    }
    if (state === 'salvaged') {
      const twinId = findOrCreateDamageTwin(row.item_id);
      applyStockChange({ itemId: twinId, locationId: loc!, change: row.quantity,
        reason: `Customer return ${row.number}: salvage`, userId: req.user!.id });
    }
    run(`INSERT INTO sales_return_dispositions (return_id, state, decision_note, location_id, decided_by,
      completed_by, completed_at) VALUES (?, ?, ?, ?, ?, ?, CASE WHEN ? = 'repair' THEN NULL ELSE datetime('now') END)`,
      row.id, state, b.note, loc, req.user!.id, state === 'repair' ? null : req.user!.id, state);
    event(row.id, state, b.note, req.user!.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.json(getReturn(row.id));
});

router.post('/:id/repair-complete', requireAnyPermission(['inventory.adjust', 'production.inspect_qc', 'production.inspect_qa']), syncClass('claim', returnSite), (req, res) => {
  const row = getReturn(Number(req.params.id));
  if (!row) { res.status(404).json({ error: 'Return not found.' }); return; }
  if (row.status !== 'rejected' || row.disposition_state !== 'repair' || !row.unit_id) {
    res.status(409).json({ error: 'This return is not in repair.', code: 'return_not_in_repair' }); return;
  }
  if (queryOne("SELECT 1 FROM repair_part_requests WHERE sales_return_id = ? AND status = 'requested' LIMIT 1", row.id)) {
    res.status(409).json({ error: 'Resolve outstanding parts requests before completing repair.', code: 'return_parts_pending' }); return;
  }
  const b = parseBody(salesReturnRepairCompleteSchema, req.body);
  db.exec('BEGIN');
  try {
    run("UPDATE sales_return_dispositions SET state = 'awaiting_inspection', repair_note = ?, completed_by = ?, completed_at = datetime('now') WHERE return_id = ? AND state = 'repair'",
      b.note, req.user!.id, row.id);
    event(row.id, 'repair_complete', b.note, req.user!.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.json(getReturn(row.id));
});

router.post('/:id/reinspect', requirePermission('inventory.adjust'), syncClass('physical', returnSite), (req, res) => {
  const row = getReturn(Number(req.params.id));
  if (!row) { res.status(404).json({ error: 'Return not found.' }); return; }
  if (row.status !== 'rejected' || row.disposition_state !== 'awaiting_inspection' || !row.unit_id) {
    res.status(409).json({ error: 'Complete repair before reinspection.', code: 'return_not_ready_for_inspection' }); return;
  }
  const b = parseBody(salesReturnReinspectSchema, req.body);
  const loc = b.decision === 'restock' ? (b.location_id ?? getDefaultLocationId()) : null;
  if (loc && !queryOne('SELECT 1 FROM locations WHERE id = ?', loc)) {
    res.status(400).json({ error: 'Receiving location not found.' }); return;
  }
  db.exec('BEGIN');
  try {
    if (loc) applyStockChange({ itemId: row.item_id, locationId: loc, change: row.quantity,
      userId: req.user!.id, reason: `Customer return ${row.number}: repaired and reinspected`,
      buildMode: row.fulfillment_mode === 'semi_built' ? 'semi_built' : 'assembled' });
    const changed = run(`UPDATE job_order_units SET status = ?, location_id = COALESCE(?, location_id),
      order_id = CASE WHEN ? IS NOT NULL THEN NULL ELSE order_id END, updated_at = datetime('now')
      WHERE id = ? AND status = 'returned_rework' AND order_id = ?`,
      loc ? 'in_stock' : 'returned_rework', loc, loc, row.unit_id, row.order_id);
    if (changed.changes !== 1) throw new Error('The returned serial changed before reinspection.');
    if (loc) run("UPDATE sales_returns SET status = 'restocked', location_id = ?, condition_note = ? WHERE id = ?",
      loc, b.condition_note, row.id);
    run(`UPDATE sales_return_dispositions SET state = ?, completed_by = ?, completed_at = datetime('now') WHERE return_id = ?`,
      loc ? 'completed' : 'repair', req.user!.id, row.id);
    event(row.id, loc ? 'reinspection_pass' : 'reinspection_reject', b.condition_note, req.user!.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  const accounting = loc ? postSalesReturnCogs(row.id, req.user!.id) : null;
  res.json({ ...getReturn(row.id), accounting });
});

router.post('/:id/link-credit', requirePermission('accounting.manage'), syncClass('claim', returnSite), (req, res) => {
  const row = getReturn(Number(req.params.id));
  if (!row) { res.status(404).json({ error: 'Return not found.' }); return; }
  if (row.credit_note_id && row.credit_note_status !== 'void') {
    res.status(409).json({ error: 'An issued credit note is already linked to this return.' }); return;
  }
  const b = parseBody(salesReturnCreditLinkSchema, req.body);
  const note = queryOne<{ id: number; kind: string; status: string; party_id: number | null; source_doc_type: string | null; source_doc_id: number | null }>(
    'SELECT id, kind, status, party_id, source_doc_type, source_doc_id FROM credit_notes WHERE id = ?', b.credit_note_id);
  if (!note || note.kind !== 'customer' || note.status !== 'issued' || note.source_doc_type !== 'sale_order'
    || note.source_doc_id !== row.order_id || (row.customer_id && note.party_id !== row.customer_id)) {
    res.status(409).json({ error: 'Choose an issued customer credit note linked to this sale and customer.' }); return;
  }
  db.exec('BEGIN');
  try {
    run('UPDATE sales_returns SET credit_note_id = ? WHERE id = ?', note.id, row.id);
    run('INSERT INTO sales_return_credit_links (return_id, credit_note_id, linked_by) VALUES (?, ?, ?)', row.id, note.id, req.user!.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.json(getReturn(row.id));
});

export default router;
