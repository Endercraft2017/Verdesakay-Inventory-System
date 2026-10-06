/** Production — repair / rework parts requests.
 *
 *  When a QA/QC inspector fails a unit with disposition = 'repair', the unit goes to
 *  `status = 'rework'`. From the repair view, production raises parts requests to the
 *  warehouse:
 *    - kind 'add'     — a missing part is needed.
 *    - kind 'replace' — a fitted part is swapped; the removed one is booked into its
 *                       damage twin (unless return_to_damage = 0).
 *  Nothing moves until the warehouse ACCEPTS the request — that is when the replacement
 *  is issued from storage and the removed part lands in the damage record. Until then the
 *  request HOLDS its quantity at one approved source (stock-holds.ts), so kit picking, other
 *  requests and the sale-order gate can't take it. The requester is pushed when the part is
 *  issued, rejected, short or needs a revision approved. A rework unit
 *  can only be re-inspected once none of its requests are still `requested`
 *  (see job-orders.routes.ts /units/inspect).
 *
 *  Read = production.view. Writes: raising/cancelling a request needs inventory.adjust
 *  or production.inspect_qc/qa (the QC or QA inspector who failed the unit — either
 *  covers it, this isn't pass-specific the way job-orders.routes.ts /:id/units/inspect
 *  is); accept/reject needs inventory.adjust or production.repairs (the warehouse parts
 *  clerk) — see inspectGate / repairsGate below. Everything else here (teams, batches,
 *  capacity, label templates) stays plain inventory.adjust. Mounted at /api/production. */
import { Router } from 'express';
import { db, queryOne, queryAll, run, nextSequence, getSetting, setSetting } from '../../shared/db';
import { requireAuth, requirePermission, requireAnyPermission } from '../../shared/auth';
import { LABEL_TEMPLATES, LINE, REPAIRS_READ, UNIT_RECORD } from '../../shared/desk-access';
import {
  parseBody,
  repairRequestSchema,
  repairAcceptSchema,
  repairRejectSchema,
  repairRevisionSchema,
  repairRevisionDecisionSchema,
  repairShortageSchema,
  createBatchSchema,
  updateBatchSchema,
  batchInspectSchema,
  productionTeamSchema,
  teamMemberSchema,
  productionCapacitySchema,
} from '../../shared/validation';
import {
  applyStockChange,
  stockAt,
  getDefaultLocationId,
  findOrCreateDamageTwin,
} from '../inventory/inventory-stock';
import { checklistForProduct } from './qc.routes';
import { REPAIR_SOURCE_TYPES, freeFor, holdOf, placeRepairHold, releaseRepairHold } from './stock-holds';
import { notifyPermission, notifyUser } from '../../shared/push';
import type {
  JobOrder, JobOrderUnit, ProductionBatch, ProductionTeam, ProductionTeamMember, RepairPartRequest,
} from '../../shared/types';
import { syncClass } from '../../sync';

const router = Router();
router.use(requireAuth);

const readGate = requirePermission('production.view');
// Desk-scoped reads (shared/desk-access.ts): each floor desk reads only what its task needs.
const repairsRead = requireAnyPermission(['production.view', ...REPAIRS_READ]);
const lineRead = requireAnyPermission(['production.view', ...LINE]);
const labelsRead = requireAnyPermission(['production.view', ...LABEL_TEMPLATES]);
const recordRead = requireAnyPermission(['production.view', ...UNIT_RECORD]);
const writeGate = requirePermission('inventory.adjust');
// See job-orders.routes.ts for why these exist alongside writeGate: a dedicated
// qc_inspector/parts_clerk account can act here without full inventory.adjust.
// Either QC or QA covers these — none of them (parts request, batch sign-off, request
// cancel) is specific to one pass the way job-orders.routes.ts /:id/units/inspect is.
const inspectGate = requireAnyPermission(['inventory.adjust', 'production.inspect_qc', 'production.inspect_qa']);
const repairsGate = requireAnyPermission(['inventory.adjust', 'production.repairs']);

const REQUEST_SELECT = `
  SELECT r.*,
         rb.full_name AS requested_by_name,
         db_.full_name AS decided_by_name,
         u.identifier AS unit_identifier,
         jo.number    AS job_order_number,
         jo.product_name AS product_name,
         fl.name      AS from_location_name
  FROM repair_part_requests r
  LEFT JOIN users rb ON rb.id = r.requested_by
  LEFT JOIN users db_ ON db_.id = r.decided_by
  LEFT JOIN job_order_units u ON u.id = r.unit_id
  LEFT JOIN job_orders jo ON jo.id = r.job_order_id
  LEFT JOIN locations fl ON fl.id = r.from_location_id
`;

function loadRequest(id: number): RepairPartRequest | null {
  return queryOne<RepairPartRequest>(`${REQUEST_SELECT} WHERE r.id = ?`, id) ?? null;
}

const unitLabel = (u: Pick<JobOrderUnit, 'id' | 'identifier'>): string =>
  u.identifier && u.identifier.trim() ? u.identifier.trim() : `unit #${u.id}`;

// GET /api/production/repairs?status=&unit=&job_order= — the warehouse queue
router.get('/repairs', repairsRead, (req, res) => {
  const { status, unit, job_order } = req.query;
  const where: string[] = [];
  const params: unknown[] = [];
  if (typeof status === 'string' && status.trim()) { where.push('r.status = ?'); params.push(status.trim()); }
  if (unit) { where.push('r.unit_id = ?'); params.push(Number(unit)); }
  if (job_order) { where.push('r.job_order_id = ?'); params.push(Number(job_order)); }
  res.json(
    queryAll<RepairPartRequest>(
      `${REQUEST_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.id DESC`,
      ...params
    )
  );
});

// GET /api/production/repairs/:id
router.get('/repairs/:id', repairsRead, (req, res) => {
  const r = loadRequest(Number(req.params.id));
  if (!r) { res.status(404).json({ error: 'Request not found' }); return; }
  res.json(r);
});

// GET /api/production/units/:unitId/repairs — a unit's parts requests (for the repair panel)
router.get('/units/:unitId/repairs', repairsRead, (req, res) => {
  const unitId = Number(req.params.unitId);
  if (!queryOne('SELECT id FROM job_order_units WHERE id = ?', unitId)) {
    res.status(404).json({ error: 'Unit not found' });
    return;
  }
  res.json(queryAll<RepairPartRequest>(`${REQUEST_SELECT} WHERE r.unit_id = ? ORDER BY r.id DESC`, unitId));
});

// POST /api/production/units/:unitId/repairs — production raises a parts request
router.post('/units/:unitId/repairs', inspectGate, syncClass('merge'), (req, res) => {
  const unitId = Number(req.params.unitId);
  const unit = queryOne<JobOrderUnit>('SELECT * FROM job_order_units WHERE id = ?', unitId);
  if (!unit) { res.status(404).json({ error: 'Unit not found' }); return; }
  if (unit.status !== 'rework') {
    res.status(409).json({ error: 'Only a unit sent back for repair can request parts' });
    return;
  }
  const input = parseBody(repairRequestSchema, req.body);
  const comp = queryOne<{ name: string }>('SELECT name FROM inventory_items WHERE id = ?', input.component_item_id);
  if (!comp) { res.status(400).json({ error: 'That component item does not exist' }); return; }

  const number = nextSequence('rpr_seq', 'RPR');
  const info = run(
    `INSERT INTO repair_part_requests
       (number, unit_id, job_order_id, kind, component_item_id, component_name, quantity,
        fault, return_to_damage, status, requested_by, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?)`,
    number,
    unitId,
    unit.job_order_id,
    input.kind,
    input.component_item_id,
    comp.name,
    input.quantity,
    input.fault ?? null,
    input.kind === 'replace' && input.return_to_damage ? 1 : 0,
    req.user!.id,
    input.notes ?? null
  );
  // Set the part aside at an approved source now; none with enough free stock = a shortage.
  placeRepairHold(Number(info.lastInsertRowid));
  res.status(201).json(loadRequest(Number(info.lastInsertRowid)));
});

// POST /api/production/repairs/:id/accept — warehouse issues the part (stock moves now)
router.post('/repairs/:id/accept', repairsGate, syncClass('claim'), (req, res) => {
  const id = Number(req.params.id);
  const r = queryOne<RepairPartRequest>('SELECT * FROM repair_part_requests WHERE id = ?', id);
  if (!r) { res.status(404).json({ error: 'Request not found' }); return; }
  if (r.status !== 'requested') {
    res.status(409).json({ error: `Request is already ${r.status}` });
    return;
  }
  const { from_location_id, warehouse_remarks, scanned_code, picked_quantity } = parseBody(repairAcceptSchema, req.body);
  const unit = queryOne<JobOrderUnit>('SELECT * FROM job_order_units WHERE id = ?', r.unit_id);
  const jo = r.job_order_id ? queryOne<JobOrder>('SELECT * FROM job_orders WHERE id = ?', r.job_order_id) : null;
  const fromLoc = from_location_id ?? jo?.source_location_id ?? getDefaultLocationId();
  const loc = queryOne<{ name: string; type: string }>('SELECT name, type FROM locations WHERE id = ?', fromLoc);
  if (!loc) { res.status(400).json({ error: 'Location not found' }); return; }
  // Approved repair-parts sources only (a truck is transit, not storage).
  if (!REPAIR_SOURCE_TYPES.has(loc.type)) {
    res.status(400).json({ error: `${loc.name} is not an approved repair-parts source`, blocked: 'source' });
    return;
  }
  if (queryOne("SELECT 1 FROM repair_revisions WHERE request_id = ? AND status = 'pending'", id)) {
    res.status(409).json({ error: 'A revision of this request is waiting for approval — it can’t be issued yet.', blocked: 'revision' });
    return;
  }
  // Exact-request rule: a different SKU or another quantity needs a formal revision.
  if (picked_quantity != null && picked_quantity !== r.quantity) {
    res.status(409).json({ error: `Picked ${picked_quantity} but ${r.quantity} were requested — revise the request to change the quantity.`, blocked: 'quantity' });
    return;
  }
  if (scanned_code) {
    const item = r.component_item_id != null
      ? queryOne<{ sku: string | null }>('SELECT sku FROM inventory_items WHERE id = ?', r.component_item_id) : null;
    const code = scanned_code.trim().toLowerCase();
    if (!item || (String(item.sku ?? '').toLowerCase() !== code && String(r.component_item_id) !== code)) {
      res.status(409).json({ error: `${scanned_code} is not the requested part (${item?.sku || r.component_name}).`, blocked: 'sku' });
      return;
    }
  }

  if (r.component_item_id == null) {
    res.status(400).json({ error: 'The requested component no longer exists' });
    return;
  }
  const have = stockAt(r.component_item_id, fromLoc);
  if (have < r.quantity) {
    res.status(400).json({ error: `Only ${have} of ${r.component_name} at ${loc.name} — need ${r.quantity}.` });
    return;
  }
  // Stock held for other repair requests or picked for kits isn't this request's to take.
  const free = freeFor(r.component_item_id, fromLoc, id);
  if (free < r.quantity) {
    res.status(409).json({ error: `Only ${Math.max(0, free)} of ${r.component_name} at ${loc.name} is free — the rest is held for other repair requests or kits.`, blocked: 'held' });
    return;
  }
  const who = unit ? unitLabel(unit) : `unit #${r.unit_id}`;

  db.exec('BEGIN');
  try {
    applyStockChange({
      itemId: r.component_item_id,
      locationId: fromLoc,
      change: -r.quantity,
      reason: `${r.number}: issued to repair ${who}`,
      userId: req.user!.id,
    });
    if (r.kind === 'replace' && r.return_to_damage) {
      const twinId = findOrCreateDamageTwin(r.component_item_id);
      applyStockChange({
        itemId: twinId,
        locationId: fromLoc,
        change: r.quantity,
        reason: `${r.number}: removed from ${who}${r.fault ? ` (${r.fault})` : ''}`,
        userId: req.user!.id,
      });
    }
    run(
      `UPDATE repair_part_requests
       SET status = 'accepted', decided_by = ?, decided_at = datetime('now'),
           from_location_id = ?, warehouse_remarks = ?, updated_at = datetime('now')
       WHERE id = ?`,
      req.user!.id,
      fromLoc,
      warehouse_remarks ?? null,
      id
    );
    releaseRepairHold(id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  if (r.requested_by && r.requested_by !== req.user!.id) {
    void notifyUser(r.requested_by, { title: `Part issued — ${r.number}`, body: `${r.quantity} × ${r.component_name} for ${who}`, ...requesterLinks(r.unit_id), tag: `rpr-${id}` });
  }
  res.json(loadRequest(id));
});

// POST /api/production/repairs/:id/reject — warehouse declines (no stock movement)
router.post('/repairs/:id/reject', repairsGate, syncClass('claim'), (req, res) => {
  const id = Number(req.params.id);
  const r = queryOne<RepairPartRequest>('SELECT * FROM repair_part_requests WHERE id = ?', id);
  if (!r) { res.status(404).json({ error: 'Request not found' }); return; }
  if (r.status !== 'requested') {
    res.status(409).json({ error: `Request is already ${r.status}` });
    return;
  }
  const { warehouse_remarks } = parseBody(repairRejectSchema, req.body);
  releaseRepairHold(id);
  if (r.requested_by && r.requested_by !== req.user!.id) {
    void notifyUser(r.requested_by, { title: `Part request rejected — ${r.number}`, body: warehouse_remarks, ...requesterLinks(r.unit_id), tag: `rpr-${id}` });
  }
  run(
    `UPDATE repair_part_requests
     SET status = 'rejected', decided_by = ?, decided_at = datetime('now'),
         warehouse_remarks = ?, updated_at = datetime('now')
     WHERE id = ?`,
    req.user!.id,
    warehouse_remarks,
    id
  );
  res.json(loadRequest(id));
});

/** Where the requester (QC / QA) opens the unit a request is for, and its job order on the desktop. */
function requesterLinks(unitId: number): { url: string; link?: { route: string; params: Record<string, unknown> } } {
  const u = queryOne<{ stage: number; qc_stages: number; job_order_id: number }>(
    'SELECT u.stage, j.qc_stages, u.job_order_id FROM job_order_units u JOIN job_orders j ON j.id = u.job_order_id WHERE u.id = ?', unitId
  );
  if (!u) return { url: '#/qc' };
  const role = u.qc_stages > 1 && u.stage + 1 >= u.qc_stages ? 'qa' : 'qc';
  return { url: `#/qc?role=${role}&unit=${unitId}`, link: { route: 'job-orders', params: { id: u.job_order_id } } };
}

function repairEvent(requestId: number, kind: string, details: unknown, actorId: number): void {
  run('INSERT INTO repair_request_events (request_id, kind, details, actor_id) VALUES (?, ?, ?, ?)',
    requestId, kind, details == null ? null : JSON.stringify(details), actorId);
}

/* GET /api/production/repairs/:id/context — what the parts clerk verifies before issuing
   (Figma 83:68 to 83:452): the unit and its source inspection, duplicate open requests for the
   same unit and part, stock at every location (approved sources first), a pending revision
   and the request's history. */
router.get('/repairs/:id/context', repairsRead, (req, res) => {
  const id = Number(req.params.id);
  const r = loadRequest(id);
  if (!r) { res.status(404).json({ error: 'Request not found' }); return; }
  const unit = queryOne<{ id: number; identifier: string | null; status: string; product_name: string }>(
    'SELECT u.id, u.identifier, u.status, j.product_name FROM job_order_units u JOIN job_orders j ON j.id = u.job_order_id WHERE u.id = ?', r.unit_id
  );
  const inspection = queryOne<Record<string, unknown>>(
    `SELECT q.id, q.stage, q.remarks, q.created_at, us.full_name AS inspector_name, rd.category, rd.station, rd.priority
     FROM qc_records q LEFT JOIN users us ON us.id = q.inspector_id LEFT JOIN qc_repair_details rd ON rd.qc_record_id = q.id
     WHERE q.unit_id = ? AND q.result = 'fail' ORDER BY q.id DESC LIMIT 1`, r.unit_id
  ) ?? null;
  const item = r.component_item_id != null
    ? queryOne<{ id: number; name: string; sku: string | null }>('SELECT id, name, sku FROM inventory_items WHERE id = ?', r.component_item_id) ?? null : null;
  const duplicates = queryAll<{ id: number; number: string }>(
    `SELECT id, number FROM repair_part_requests WHERE unit_id = ? AND component_item_id IS ? AND status = 'requested' AND id != ?`,
    r.unit_id, r.component_item_id, id
  );
  const sources = r.component_item_id == null ? [] : queryAll<{ id: number; name: string; type: string; is_default: number }>(
    'SELECT id, name, type, is_default FROM locations ORDER BY is_default DESC, name COLLATE NOCASE'
  ).map((l) => {
    // free: what this request can take there — stock minus kit picks and other requests' holds.
    const available = stockAt(r.component_item_id!, l.id);
    return { ...l, available, free: Math.max(0, freeFor(r.component_item_id!, l.id, id)), approved: REPAIR_SOURCE_TYPES.has(l.type) };
  }).sort((a, b) => Number(b.approved) - Number(a.approved) || b.free - a.free);
  const hold = r.status === 'requested' ? holdOf(id) : null;
  const revision = queryOne<Record<string, unknown>>(
    `SELECT v.*, u.full_name AS proposed_by_name FROM repair_revisions v LEFT JOIN users u ON u.id = v.proposed_by
     WHERE v.request_id = ? ORDER BY v.id DESC LIMIT 1`, id
  ) ?? null;
  const events = queryAll(
    `SELECT e.kind, e.details, e.created_at, u.full_name AS actor_name FROM repair_request_events e LEFT JOIN users u ON u.id = e.actor_id
     WHERE e.request_id = ? ORDER BY e.id`, id
  );
  const shortage = r.status === 'requested' && !sources.some((x) => x.approved && x.free >= r.quantity);
  res.json({ request: r, unit, inspection, item, duplicates, sources, hold, revision, events, shortage });
});

/* GET /api/production/repair-history?q=&state=issued|rejected|blocked — read-only audit list
   (83:488) with counts. "blocked" = still requested with no approved source holding enough. */
router.get('/repair-history', repairsRead, (req, res) => {
  const q = String(req.query.q ?? '').trim().toLowerCase();
  const want = String(req.query.state ?? '');
  const rows = queryAll<RepairPartRequest & { sku: string | null; quantity: number; component_item_id: number | null }>(
    `${REQUEST_SELECT.replace('FROM repair_part_requests r', ', ci.sku AS sku FROM repair_part_requests r LEFT JOIN inventory_items ci ON ci.id = r.component_item_id')}
     ORDER BY r.id DESC LIMIT 500`
  );
  const approved = queryAll<{ id: number }>("SELECT id FROM locations WHERE type IN ('warehouse', 'branch', 'store', 'other')");
  const stateOf = (r: { id: number; status: string; component_item_id: number | null; quantity: number }) =>
    r.status === 'accepted' ? 'issued' : r.status === 'rejected' ? 'rejected'
      : r.status === 'requested' && (r.component_item_id == null || !approved.some((l) => freeFor(r.component_item_id!, l.id, r.id) >= r.quantity)) ? 'blocked'
      : r.status;
  const all = rows.map((r) => ({ ...r, state: stateOf(r) }));
  const counts = { issued: 0, rejected: 0, blocked: 0 };
  all.forEach((r) => { if (r.state in counts) counts[r.state as keyof typeof counts]++; });
  const out = all.filter((r) => (!want || r.state === want) && (!q || [r.number, r.unit_identifier, r.job_order_number, r.sku, r.component_name]
    .some((v) => v != null && String(v).toLowerCase().includes(q))));
  res.json({ counts, rows: out.slice(0, 100) });
});

/* POST /api/production/repairs/:id/shortage — escalate "no approved stock" (83:416). Records
   only; the request stays open and blocked until stock arrives or it is revised. */
router.post('/repairs/:id/shortage', repairsGate, syncClass('merge'), (req, res) => {
  const id = Number(req.params.id);
  const r = queryOne<{ status: string }>('SELECT status FROM repair_part_requests WHERE id = ?', id);
  if (!r) { res.status(404).json({ error: 'Request not found' }); return; }
  if (r.status !== 'requested') { res.status(409).json({ error: `Request is already ${r.status}` }); return; }
  const { note } = parseBody(repairShortageSchema, req.body);
  repairEvent(id, 'shortage', { note: note ?? null }, req.user!.id);
  // The repair station waits on it; the warehouse supervisors arrange replenishment.
  const sr = loadRequest(id)!;
  const push = { title: `Repair part short — ${sr.number}`, body: `${sr.quantity} × ${sr.component_name} for ${sr.unit_identifier || 'unit #' + sr.unit_id}${note ? ' — ' + note : ''}`, tag: `rpr-${id}` };
  if (sr.requested_by && sr.requested_by !== req.user!.id) void notifyUser(sr.requested_by, { ...push, ...requesterLinks(sr.unit_id) });
  void notifyPermission('inventory.adjust', { ...push, url: `#/repairs?id=${id}`, link: { route: 'repairs' } });
  res.status(201).json({ ok: true });
});

/* POST /api/production/repairs/:id/revision — the parts clerk proposes another part or quantity
   (83:452). The clerk can't approve their own proposal. */
router.post('/repairs/:id/revision', repairsGate, syncClass('merge'), (req, res) => {
  const id = Number(req.params.id);
  const r = queryOne<RepairPartRequest>('SELECT * FROM repair_part_requests WHERE id = ?', id);
  if (!r) { res.status(404).json({ error: 'Request not found' }); return; }
  if (r.status !== 'requested') { res.status(409).json({ error: `Request is already ${r.status}` }); return; }
  if (queryOne("SELECT 1 FROM repair_revisions WHERE request_id = ? AND status = 'pending'", id)) {
    res.status(409).json({ error: 'A revision is already waiting for approval.' });
    return;
  }
  const input = parseBody(repairRevisionSchema, req.body);
  const itemId = input.component_item_id ?? r.component_item_id;
  const item = itemId != null ? queryOne<{ name: string }>('SELECT name FROM inventory_items WHERE id = ?', itemId) : null;
  if (!item) { res.status(400).json({ error: 'That component item does not exist' }); return; }
  if (itemId === r.component_item_id && input.quantity === r.quantity) {
    res.status(400).json({ error: 'The revision changes nothing — pick another part or quantity.' });
    return;
  }
  const rid = Number(run(
    `INSERT INTO repair_revisions (request_id, proposed_item_id, proposed_name, proposed_quantity, reason, proposed_by)
     VALUES (?, ?, ?, ?, ?, ?)`, id, itemId, item.name, input.quantity, input.reason, req.user!.id
  ).lastInsertRowid);
  repairEvent(id, 'revision_requested', { revision_id: rid, item: item.name, quantity: input.quantity, reason: input.reason }, req.user!.id);
  if (r.requested_by && r.requested_by !== req.user!.id) {
    void notifyUser(r.requested_by, { title: `Approve a revision — ${r.number}`, body: `${input.quantity} × ${item.name} instead of ${r.quantity} × ${r.component_name}: ${input.reason}`,
      url: `#/repairs?id=${id}&step=decide`, link: r.job_order_id ? { route: 'job-orders', params: { id: r.job_order_id } } : undefined, tag: `rpr-${id}` });
  }
  res.status(201).json({ id: rid });
});

/* POST /api/production/repairs/:id/revision/decide — the requester or a supervisor
   (production.approve / inventory.adjust) approves or rejects; never the proposer. */
router.post('/repairs/:id/revision/decide', readGate, syncClass('claim'), (req, res) => {
  const id = Number(req.params.id);
  const r = queryOne<RepairPartRequest>('SELECT * FROM repair_part_requests WHERE id = ?', id);
  const v = queryOne<{ id: number; proposed_item_id: number | null; proposed_name: string; proposed_quantity: number; proposed_by: number | null }>(
    "SELECT * FROM repair_revisions WHERE request_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1", id
  );
  if (!r || !v) { res.status(404).json({ error: 'No pending revision for this request' }); return; }
  const perms = req.user!.permissions;
  const mayDecide = r.requested_by === req.user!.id || perms.includes('production.approve') || perms.includes('inventory.adjust');
  if (!mayDecide) { res.status(403).json({ error: 'Only the requester or a supervisor can decide a revision.' }); return; }
  if (v.proposed_by === req.user!.id) { res.status(403).json({ error: 'You proposed this revision — someone else must approve it.' }); return; }
  const { approve, note } = parseBody(repairRevisionDecisionSchema, req.body);
  db.exec('BEGIN');
  try {
    run("UPDATE repair_revisions SET status = ?, decided_by = ?, decision_note = ?, decided_at = datetime('now') WHERE id = ?",
      approve ? 'approved' : 'rejected', req.user!.id, note ?? null, v.id);
    if (approve) {
      run("UPDATE repair_part_requests SET component_item_id = ?, component_name = ?, quantity = ?, updated_at = datetime('now') WHERE id = ?",
        v.proposed_item_id, v.proposed_name, v.proposed_quantity, id);
      placeRepairHold(id); // hold the revised part / quantity instead
    }
    repairEvent(id, approve ? 'revision_approved' : 'revision_rejected', { revision_id: v.id, note: note ?? null }, req.user!.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  if (v.proposed_by) {
    void notifyUser(v.proposed_by, { title: `Revision ${approve ? 'approved' : 'rejected'} — ${r.number}`, body: note || (approve ? `Issue ${v.proposed_quantity} × ${v.proposed_name}` : 'Keep the original request'),
      url: `#/repairs?id=${id}`, tag: `rpr-${id}` });
  }
  res.json(loadRequest(id));
});

// ------------------------------------------------------------ teams & scheduling ---

const CAPACITY_KEY = 'production_daily_capacity';

function teamMembers(teamId: number): ProductionTeamMember[] {
  return queryAll<ProductionTeamMember>(
    `SELECT m.*, e.name, e.employee_no, e.position
     FROM production_team_members m LEFT JOIN employees e ON e.id = m.employee_id
     WHERE m.team_id = ? ORDER BY e.name COLLATE NOCASE`,
    teamId
  );
}

// GET /api/production/employees — the roster to pick team members from. Deliberately its own
// endpoint (rather than reusing /api/hr/employees) so anyone who can manage production teams
// can staff them without also needing hr.view; only the fields the picker needs are exposed.
router.get('/employees', lineRead, (_req, res) => {
  res.json(queryAll(
    `SELECT e.id, e.name, e.employee_no, e.position, d.name AS department_name
     FROM employees e LEFT JOIN departments d ON d.id = e.department_id
     WHERE e.status NOT IN ('suspended', 'resigned', 'terminated')
     ORDER BY d.name COLLATE NOCASE, e.name COLLATE NOCASE`
  ));
});

// GET /api/production/teams — teams with member count + open job-order count
router.get('/teams', lineRead, (req, res) => {
  const activeOnly = req.query.active === '1' || req.query.active === 'true';
  const rows = queryAll<ProductionTeam>(
    `SELECT t.*,
            (SELECT COUNT(*) FROM production_team_members m WHERE m.team_id = t.id) AS member_count,
            (SELECT COUNT(*) FROM job_orders j
              WHERE j.team_id = t.id AND j.status IN ('draft','released','in_progress','paused')) AS open_job_orders
     FROM production_teams t
     ${activeOnly ? 'WHERE t.is_active = 1' : ''}
     ORDER BY t.is_active DESC, t.name COLLATE NOCASE`
  );
  res.json(rows.map((t) => ({ ...t, members: teamMembers(t.id) })));
});

// GET /api/production/teams/:id
router.get('/teams/:id', lineRead, (req, res) => {
  const id = Number(req.params.id);
  const team = queryOne<ProductionTeam>('SELECT * FROM production_teams WHERE id = ?', id);
  if (!team) { res.status(404).json({ error: 'Team not found' }); return; }
  res.json({ ...team, members: teamMembers(id) });
});

// POST /api/production/teams
router.post('/teams', writeGate, syncClass('claim'), (req, res) => {
  const input = parseBody(productionTeamSchema, req.body);
  const info = run(
    'INSERT INTO production_teams (name, notes, is_active) VALUES (?, ?, ?)',
    input.name, input.notes ?? null, input.is_active === false ? 0 : 1
  );
  res.status(201).json(queryOne<ProductionTeam>('SELECT * FROM production_teams WHERE id = ?', Number(info.lastInsertRowid)));
});

// PUT /api/production/teams/:id
router.put('/teams/:id', writeGate, syncClass('claim'), (req, res) => {
  const id = Number(req.params.id);
  const team = queryOne<ProductionTeam>('SELECT * FROM production_teams WHERE id = ?', id);
  if (!team) { res.status(404).json({ error: 'Team not found' }); return; }
  const input = parseBody(productionTeamSchema, req.body);
  run(
    "UPDATE production_teams SET name = ?, notes = ?, is_active = ?, updated_at = datetime('now') WHERE id = ?",
    input.name,
    input.notes !== undefined ? input.notes : team.notes,
    input.is_active === undefined ? team.is_active : (input.is_active ? 1 : 0),
    id
  );
  res.json({ ...queryOne<ProductionTeam>('SELECT * FROM production_teams WHERE id = ?', id), members: teamMembers(id) });
});

// DELETE /api/production/teams/:id — blocked while a job order still points at it
router.delete('/teams/:id', writeGate, syncClass('claim'), (req, res) => {
  const id = Number(req.params.id);
  if (!queryOne('SELECT id FROM production_teams WHERE id = ?', id)) {
    res.status(404).json({ error: 'Team not found' });
    return;
  }
  const used = queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM job_orders WHERE team_id = ?', id)?.n ?? 0;
  if (used > 0) {
    res.status(409).json({ error: `${used} job order(s) are assigned to this team — deactivate it instead.` });
    return;
  }
  run('DELETE FROM production_teams WHERE id = ?', id);
  res.json({ ok: true });
});

// POST /api/production/teams/:id/members  { employee_id, role? }
router.post('/teams/:id/members', writeGate, syncClass('claim'), (req, res) => {
  const id = Number(req.params.id);
  if (!queryOne('SELECT id FROM production_teams WHERE id = ?', id)) {
    res.status(404).json({ error: 'Team not found' });
    return;
  }
  const input = parseBody(teamMemberSchema, req.body);
  if (!queryOne('SELECT id FROM employees WHERE id = ?', input.employee_id)) {
    res.status(400).json({ error: 'Employee not found' });
    return;
  }
  if (queryOne('SELECT id FROM production_team_members WHERE team_id = ? AND employee_id = ?', id, input.employee_id)) {
    res.status(409).json({ error: 'Already on this team' });
    return;
  }
  run(
    'INSERT INTO production_team_members (team_id, employee_id, role) VALUES (?, ?, ?)',
    id, input.employee_id, input.role ?? null
  );
  res.status(201).json({ ok: true, members: teamMembers(id) });
});

// DELETE /api/production/teams/:id/members/:employeeId
router.delete('/teams/:id/members/:employeeId', writeGate, syncClass('claim'), (req, res) => {
  const id = Number(req.params.id);
  const info = run(
    'DELETE FROM production_team_members WHERE team_id = ? AND employee_id = ?',
    id, Number(req.params.employeeId)
  );
  if (!info.changes) { res.status(404).json({ error: 'Not a member of this team' }); return; }
  res.json({ ok: true, members: teamMembers(id) });
});

// GET / PUT /api/production/capacity — advisory units/day for the schedule board
router.get('/capacity', lineRead, (_req, res) => {
  res.json({ daily_capacity: Number(getSetting<number>(CAPACITY_KEY)) || 0 });
});
router.put('/capacity', writeGate, syncClass('claim'), (req, res) => {
  const { daily_capacity } = parseBody(productionCapacitySchema, req.body);
  setSetting(CAPACITY_KEY, daily_capacity);
  res.json({ daily_capacity });
});

// ---------------------------------------------------------------- batches / lots ---

const BATCH_SELECT = `
  SELECT b.*, jo.number AS job_order_number, jo.qc_stages AS job_order_qc_stages, i.name AS product_name,
         cb.full_name AS created_by_name,
         (SELECT COUNT(*) FROM job_order_units u WHERE u.batch_id = b.id) AS unit_count,
         (SELECT COALESCE(SUM(quantity), 0) FROM production_receipt_items WHERE batch_id = b.id) AS received_qty
  FROM production_batches b
  LEFT JOIN job_orders jo ON jo.id = b.job_order_id
  LEFT JOIN inventory_items i ON i.id = b.product_item_id
  LEFT JOIN users cb ON cb.id = b.created_by
`;

const loadBatch = (id: number): ProductionBatch | null =>
  queryOne<ProductionBatch>(`${BATCH_SELECT} WHERE b.id = ?`, id) ?? null;

// GET /api/production/batches?job_order=&product=&status=
router.get('/batches', lineRead, (req, res) => {
  const { job_order, product, status } = req.query;
  const where: string[] = [];
  const params: unknown[] = [];
  if (job_order) { where.push('b.job_order_id = ?'); params.push(Number(job_order)); }
  if (product) { where.push('b.product_item_id = ?'); params.push(Number(product)); }
  if (typeof status === 'string' && status.trim()) { where.push('b.status = ?'); params.push(status.trim()); }
  res.json(
    queryAll<ProductionBatch>(
      `${BATCH_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY b.id DESC`,
      ...params
    )
  );
});

// GET /api/production/batches/:id — batch + its units + QC records
router.get('/batches/:id', lineRead, (req, res) => {
  const id = Number(req.params.id);
  const batch = loadBatch(id);
  if (!batch) { res.status(404).json({ error: 'Batch not found' }); return; }
  const units = queryAll<JobOrderUnit>('SELECT * FROM job_order_units WHERE batch_id = ? ORDER BY id', id);
  const qc = queryAll<{ checklist: string | null }>(
    `SELECT q.*, u.full_name AS inspector_name
     FROM qc_records q LEFT JOIN users u ON u.id = q.inspector_id
     WHERE q.batch_id = ? ORDER BY q.id DESC`,
    id
  ).map((r) => {
    let checklist: unknown = null;
    try { checklist = r.checklist ? JSON.parse(r.checklist) : null; } catch { checklist = null; }
    return { ...r, checklist };
  });
  res.json({ ...batch, units, qc });
});

// POST /api/production/batches — create one by hand (grouping / relabelling)
router.post('/batches', writeGate, syncClass('merge'), (req, res) => {
  const input = parseBody(createBatchSchema, req.body);
  if (input.job_order_id && !queryOne('SELECT id FROM job_orders WHERE id = ?', input.job_order_id)) {
    res.status(400).json({ error: 'Job order not found' });
    return;
  }
  if (input.product_item_id && !queryOne('SELECT id FROM inventory_items WHERE id = ?', input.product_item_id)) {
    res.status(400).json({ error: 'Product not found' });
    return;
  }
  const number = nextSequence('batch_seq', 'BATCH');
  const info = run(
    `INSERT INTO production_batches
       (number, job_order_id, product_item_id, qty, identifier, status, notes, created_by)
     VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
    number,
    input.job_order_id ?? null,
    input.product_item_id ?? null,
    input.qty,
    input.identifier ?? null,
    input.notes ?? null,
    req.user!.id
  );
  res.status(201).json(loadBatch(Number(info.lastInsertRowid)));
});

// PUT /api/production/batches/:id — relabel / re-note / change status
router.put('/batches/:id', writeGate, syncClass('claim'), (req, res) => {
  const id = Number(req.params.id);
  const batch = queryOne<ProductionBatch>('SELECT * FROM production_batches WHERE id = ?', id);
  if (!batch) { res.status(404).json({ error: 'Batch not found' }); return; }
  const input = parseBody(updateBatchSchema, req.body);
  run(
    `UPDATE production_batches
     SET identifier = ?, notes = ?, status = ?, updated_at = datetime('now')
     WHERE id = ?`,
    input.identifier !== undefined ? input.identifier : batch.identifier,
    input.notes !== undefined ? input.notes : batch.notes,
    input.status ?? batch.status,
    id
  );
  res.json(loadBatch(id));
});

// POST /api/production/batches/:id/inspect — one optional batch-level QA/QC sign-off. Purely
// a quality record (this batch's `status` open<->closed here means "signed off", not
// "received") — independent of Products In, which is what actually posts the batch's stock
// (see job-orders.routes.ts POST /:id/products-in).
router.post('/batches/:id/inspect', inspectGate, syncClass('physical'), (req, res) => {
  const id = Number(req.params.id);
  const batch = queryOne<ProductionBatch>('SELECT * FROM production_batches WHERE id = ?', id);
  if (!batch) { res.status(404).json({ error: 'Batch not found' }); return; }
  const { result, disposition, remarks, checklist } = parseBody(batchInspectSchema, req.body);

  if (result === 'pass') {
    // A non-serialized batch gets one sign-off pass, not a QC-then-QA sequence — combine
    // both of the product's checklists (if any) into that one pass.
    const activeItems = [
      ...(checklistForProduct(batch.product_item_id, 1)?.items ?? []),
      ...(checklistForProduct(batch.product_item_id, 2)?.items ?? []),
    ];
    const required = [...new Map(activeItems.filter((it) => it.required).map((it) => [it.label, it])).values()];
    if (required.length) {
      const ticked = new Map((checklist ?? []).map((c) => [c.label, c.ok]));
      const missing = required.filter((it) => ticked.get(it.label) !== true).map((it) => it.label);
      if (missing.length) {
        res.status(400).json({ error: `Complete the required QC/QA checks before passing: ${missing.join(', ')}` });
        return;
      }
    }
  }
  const checklistJson = checklist && checklist.length ? JSON.stringify(checklist) : null;

  db.exec('BEGIN');
  try {
    run(
      `INSERT INTO qc_records (job_order_id, batch_id, stage, result, disposition, remarks, checklist, inspector_id)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
      batch.job_order_id,
      id,
      result,
      result === 'fail' ? (disposition ?? null) : null,
      remarks ?? null,
      checklistJson,
      req.user!.id
    );
    run(
      "UPDATE production_batches SET status = ?, updated_at = datetime('now') WHERE id = ?",
      result === 'pass' ? 'closed' : 'open',
      id
    );
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.json(loadBatch(id));
});

// ---------------------------------------------------------- label templates ---

const UNIT_LABEL_KEY = 'label_template_unit';
const BATCH_LABEL_KEY = 'label_template_batch';

/** Inner fragment for one label. Rendered by public/js/doc-template.js against a
 *  { product, unit|batch, code, sub, qr_src, date } context; the print sheet supplies
 *  the surrounding .lbl / .lbl-qr / .lbl-txt CSS. Admin-editable. */
export const DEFAULT_UNIT_LABEL = `<img class="lbl-qr" src="{{qr_src}}" alt="" />
<div class="lbl-txt">
  <div class="lbl-name">{{product.name}}</div>
  {{#if product.variant}}<div class="lbl-variant">{{product.variant}}</div>{{/if}}
  {{#if product.model}}<div class="lbl-model">{{product.model}}</div>{{/if}}
  <div class="lbl-code">{{code}}</div>
  {{#if sub}}<div class="lbl-sub">{{sub}}</div>{{/if}}
</div>`;

export const DEFAULT_BATCH_LABEL = `<img class="lbl-qr" src="{{qr_src}}" alt="" />
<div class="lbl-txt">
  <div class="lbl-name">{{product.name}}</div>
  {{#if product.variant}}<div class="lbl-variant">{{product.variant}}</div>{{/if}}
  <div class="lbl-code">{{batch.number}}</div>
  {{#if batch.identifier}}<div class="lbl-sub">Lot: {{batch.identifier}}</div>{{/if}}
  <div class="lbl-sub">Qty: {{batch.qty}} · {{date}}</div>
</div>`;

// GET /api/production/label-templates — the editable unit + batch label bodies
router.get('/label-templates', labelsRead, (_req, res) => {
  res.json({
    unit: getSetting<string>(UNIT_LABEL_KEY) || DEFAULT_UNIT_LABEL,
    batch: getSetting<string>(BATCH_LABEL_KEY) || DEFAULT_BATCH_LABEL,
    default_unit: DEFAULT_UNIT_LABEL,
    default_batch: DEFAULT_BATCH_LABEL,
  });
});

// PUT /api/production/label-templates — save one or both; '' / null resets to default
router.put('/label-templates', writeGate, syncClass('claim'), (req, res) => {
  const body = (req.body ?? {}) as { unit?: unknown; batch?: unknown };
  if (body.unit !== undefined) {
    const v = typeof body.unit === 'string' ? body.unit.trim() : '';
    setSetting(UNIT_LABEL_KEY, v && v.length <= 20000 ? v : '');
  }
  if (body.batch !== undefined) {
    const v = typeof body.batch === 'string' ? body.batch.trim() : '';
    setSetting(BATCH_LABEL_KEY, v && v.length <= 20000 ? v : '');
  }
  res.json({
    unit: getSetting<string>(UNIT_LABEL_KEY) || DEFAULT_UNIT_LABEL,
    batch: getSetting<string>(BATCH_LABEL_KEY) || DEFAULT_BATCH_LABEL,
  });
});

// --------------------------------------------------------- unit / batch dossier ---

function qcRows(col: 'unit_id' | 'batch_id', id: number) {
  return queryAll<{ checklist: string | null }>(
    `SELECT q.*, u.full_name AS inspector_name
     FROM qc_records q LEFT JOIN users u ON u.id = q.inspector_id
     WHERE q.${col} = ? ORDER BY q.id`,
    id
  ).map((r) => {
    let checklist: unknown = null;
    try { checklist = r.checklist ? JSON.parse(r.checklist) : null; } catch { checklist = null; }
    return { ...r, checklist };
  });
}

// GET /api/production/record?unit=<id>  |  ?batch=<id> — the full read-only history.
router.get('/record', recordRead, (req, res) => {
  const unitId = req.query.unit ? Number(req.query.unit) : null;
  const batchId = req.query.batch ? Number(req.query.batch) : null;
  if (!unitId && !batchId) { res.status(400).json({ error: 'A unit or batch id is required' }); return; }

  let productId: number | null = null;
  let joId: number | null = null;
  const out: Record<string, unknown> = { kind: unitId ? 'unit' : 'batch' };

  if (unitId) {
    const u = queryOne<JobOrderUnit & { location_name: string | null; order_number: string | null; batch_number: string | null }>(
      `SELECT u.*, l.name AS location_name, o.number AS order_number, b.number AS batch_number
       FROM job_order_units u
       LEFT JOIN locations l ON l.id = u.location_id
       LEFT JOIN orders o ON o.id = u.order_id
       LEFT JOIN production_batches b ON b.id = u.batch_id
       WHERE u.id = ?`, unitId
    );
    if (!u) { res.status(404).json({ error: 'Unit not found' }); return; }
    out.unit = u;
    productId = u.product_item_id;
    joId = u.job_order_id;
    out.repairs = queryAll<RepairPartRequest>(`${REQUEST_SELECT} WHERE r.unit_id = ? ORDER BY r.id`, unitId);
    out.qc = qcRows('unit_id', unitId);
    // Photos attached to this unit (kind 'qc_unit') — the one taken when the unit was
    // added off the line (job-orders.routes.ts POST /:id/units) plus any added later
    // during a QC/QA fail (production-qc.js / mobile qc.js checklist sheets).
    out.photos = queryAll<{ id: number; caption: string | null; created_at: string }>(
      'SELECT id, caption, created_at FROM attachments WHERE kind = ? AND ref_id = ? ORDER BY id',
      'qc_unit',
      unitId
    ).map((r) => ({ ...r, url: `/api/attachments/${r.id}/image` }));
  } else {
    const b = loadBatch(batchId!);
    if (!b) { res.status(404).json({ error: 'Batch not found' }); return; }
    out.batch = b;
    productId = b.product_item_id;
    joId = b.job_order_id;
    out.units = queryAll<JobOrderUnit>('SELECT * FROM job_order_units WHERE batch_id = ? ORDER BY id', batchId);
    out.qc = qcRows('batch_id', batchId!);
  }

  if (productId) {
    const p = queryOne<{ id: number; name: string; sku: string | null; unit: string | null; product_group: string | null; attributes: string | null }>(
      'SELECT id, name, sku, unit, product_group, attributes FROM inventory_items WHERE id = ?', productId
    );
    if (p) {
      let spec: unknown = null;
      try { spec = p.attributes ? (JSON.parse(p.attributes) as Record<string, unknown>).spec : null; } catch { spec = null; }
      out.product = { id: p.id, name: p.name, sku: p.sku, unit: p.unit, model: p.product_group, variant: spec ?? null };
    }
  }
  if (joId) {
    out.job_order = queryOne(
      `SELECT j.id, j.number, j.product_name, j.status, j.planned_start, j.due_date, j.accepted_at,
              t.name AS team_name, cb.full_name AS created_by_name, rb.full_name AS released_by_name, ab.full_name AS accepted_by_name,
              sl.name AS source_location_name, ol.name AS output_location_name
       FROM job_orders j
       LEFT JOIN production_teams t ON t.id = j.team_id
       LEFT JOIN users cb ON cb.id = j.created_by
       LEFT JOIN users rb ON rb.id = j.released_by
       LEFT JOIN users ab ON ab.id = j.accepted_by
       LEFT JOIN locations sl ON sl.id = j.source_location_id
       LEFT JOIN locations ol ON ol.id = j.output_location_id
       WHERE j.id = ?`, joId
    );
    const joNum = (out.job_order as { number?: string } | undefined)?.number;
    if (productId && joNum) {
      out.movements = queryAll(
        `SELECT t.change, t.balance_after, t.reason, t.created_at, l.name AS location_name, u.full_name AS user_name
         FROM inventory_transactions t
         LEFT JOIN locations l ON l.id = t.location_id
         LEFT JOIN users u ON u.id = t.user_id
         WHERE t.item_id = ? AND t.reason LIKE ?
         ORDER BY t.id DESC LIMIT 40`,
        productId, `${joNum}%`
      );
    }
  }
  res.json(out);
});

// POST /api/production/repairs/:id/cancel — pull a request back before the warehouse acts
router.post('/repairs/:id/cancel', inspectGate, syncClass('claim'), (req, res) => {
  const id = Number(req.params.id);
  const r = queryOne<RepairPartRequest>('SELECT status FROM repair_part_requests WHERE id = ?', id);
  if (!r) { res.status(404).json({ error: 'Request not found' }); return; }
  if (r.status !== 'requested') {
    res.status(409).json({ error: `Cannot cancel a request that is ${r.status}` });
    return;
  }
  run(
    "UPDATE repair_part_requests SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?",
    id
  );
  releaseRepairHold(id);
  res.json(loadRequest(id));
});

export default router;
