/** Manufacturing job orders (Phase B). Build N units of a finished product by
    consuming its BOM. Lifecycle: draft (→ approved, a sign-off stamp, not a status) →
    released → in_progress → completed,
    with pause / cancel returning components that weren't consumed.
    QA/QC gating (qc_stages > 0) and serialized units come in Phase C. */
import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { db, queryOne, queryAll, run, nextSequence } from '../../shared/db';
import { requireAuth, requirePermission, requireAnyPermission } from '../../shared/auth';
import {
  parseBody,
  createJobOrderSchema,
  updateJobOrderSchema,
  jobOrderComponentsSchema,
  jobOrderProgressSchema,
  acceptJobOrderSchema,
  addUnitSchema,
  inspectUnitsSchema,
  setUnitIdentifierSchema,
  productsInSchema,
  jobOrderIdsSchema,
  prepareJobOrdersSchema,
  releaseJobOrderSchema,
  pauseJobOrderSchema,
} from '../../shared/validation';
import { imageUpload, saveAttachment, unlink } from '../../core/attachments.routes';
import { enforceQuota } from '../../platform/quota';
import { pickListHtml } from './parts-slip-print';
import { applyStockChange, stockAt, getDefaultLocationId } from '../inventory/inventory-stock';
import { postJobOrderMovement, jobOrderWipBalance } from '../accounting/accounting-autopost';
import { createDraftPurchaseOrders } from '../inventory/orders.routes';
import { checklistForProduct } from './qc.routes';
import type { JobOrder, JobOrderComponent, JobOrderUnit, InventoryItem, ProductionReceipt } from '../../shared/types';

const router = Router();
router.use(requireAuth);

const readGate = requirePermission('inventory.view');
const writeGate = requirePermission('inventory.adjust');
// Narrow alternatives to writeGate for the actions a dedicated shop-floor role
// (production_lead / qc_inspector / qa_inspector / receiving_clerk — see
// shared/permissions.ts) performs without needing full inventory.adjust. inventory.adjust
// still works too, so admin/warehouse/admin_staff/releasing accounts are unaffected.
const recordGate = requireAnyPermission(['inventory.adjust', 'production.record']);
// Door-level gate for /:id/units/inspect only — lets a caller with EITHER inspect
// permission in; which *specific* pass(es) they're actually allowed to record is then
// checked inside the handler once it knows which stage(s) the requested units are on
// (see the inspectPermissionError() call below). qc.configure is a separate concern
// (checklist administration, not the pass/fail action itself).
const inspectDoorGate = requireAnyPermission(['inventory.adjust', 'production.inspect_qc', 'production.inspect_qa']);
const receiveGate = requireAnyPermission(['inventory.adjust', 'production.receive']);
// Deliberately NOT satisfied by inventory.adjust: approval is the production manager's
// sign-off, separate from the warehouse that releases the parts. Admin holds every permission.
const approveGate = requirePermission('production.approve');
const pauseGate = requireAnyPermission(['inventory.adjust', 'production.pause', 'production.manage']);
// Close early returns unused components but never releases or cancels — so a Production
// Manager (production.manage) may do it without the warehouse's broad inventory.adjust.
const closeEarlyGate = requireAnyPermission(['inventory.adjust', 'production.manage']);

/** Line decisions made through a narrow production permission (not the broad inventory.adjust
 *  override) must give a reason — the handoff's "pause/resume/close-early require reasons". */
function reasonFor(req: import('express').Request, action: string): { reason: string | null } | { error: string } {
  const { reason } = parseBody(pauseJobOrderSchema, req.body ?? {});
  const r = reason?.trim() || null;
  if (!r && !req.user!.permissions.includes('inventory.adjust')) return { error: `Give a reason to ${action} this job order` };
  return { reason: r };
}
/** Append-only audit trail of pause / resume / close-early (job_order_events). */
function logLineEvent(jobOrderId: number, action: 'pause' | 'resume' | 'close_early', reason: string | null, userId: number): void {
  run('INSERT INTO job_order_events (job_order_id, action, reason, actor_id) VALUES (?, ?, ?, ?)', jobOrderId, action, reason, userId);
}

const today = (): string => new Date().toISOString().slice(0, 10);
const r2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** Standard-cost value of a job order's components: `released` = Σ qty_planned × unit_cost
 *  (the whole reservation, removed from stock at release); `perUnit` = Σ qty_per_unit ×
 *  unit_cost (one finished unit's *material* cost). `perUnitTotal` adds the built product's
 *  optional standard labour + overhead (attributes JSON) on top — that is what a finished
 *  unit is valued at when it enters stock. GL postings use the material-only figures.
 *  Reads `inventory_items.unit_cost` + the product's attributes live. */
function componentCostFor(joId: number): {
  released: number; perUnit: number; perUnitTotal: number; addons: number;
} {
  let released = 0, perUnit = 0;
  for (const c of queryAll<{ qty_planned: number; qty_per_unit: number; cost: number }>(
    `SELECT c.qty_planned, c.qty_per_unit, COALESCE(i.unit_cost, 0) AS cost
     FROM job_order_components c LEFT JOIN inventory_items i ON i.id = c.component_item_id
     WHERE c.job_order_id = ?`, joId
  )) {
    released += (c.qty_planned || 0) * (c.cost || 0);
    perUnit += (c.qty_per_unit || 0) * (c.cost || 0);
  }
  let addons = 0;
  const prod = queryOne<{ attributes: string | null }>(
    `SELECT ii.attributes FROM job_orders jo
     LEFT JOIN inventory_items ii ON ii.id = jo.product_item_id WHERE jo.id = ?`, joId
  );
  if (prod?.attributes) {
    try {
      const a = JSON.parse(prod.attributes) as Record<string, unknown>;
      addons = (Number(a.std_labor_cost) || 0) + (Number(a.std_overhead_cost) || 0);
    } catch { /* attributes not JSON — no add-ons */ }
  }
  return { released: r2(released), perUnit: r2(perUnit), perUnitTotal: r2(perUnit + addons), addons: r2(addons) };
}

/** True while this job order still has produced output awaiting Products In: serialized
 *  units at status 'passed', or a non-serialized batch (no job_order_units of its own) with
 *  an unreceived quantity remaining. NOTE: a non-serialized batch's own `status` column is
 *  an unrelated, optional QA sign-off flag (production.routes.ts POST /batches/:id/inspect) —
 *  receivability is purely qty vs. SUM(production_receipt_items.quantity), not that column.
 *  A job order can finish production (maybeComplete) or even be cancelled/closed early while
 *  output is still sitting here — real physical units don't un-produce themselves — so this
 *  must stay true (and settleJobOrderGl must keep waiting) until POST /:id/products-in clears
 *  it, however the job order's own status got here. */
function hasReceivable(joId: number): boolean {
  const passed = queryOne<{ n: number }>(
    "SELECT COUNT(*) AS n FROM job_order_units WHERE job_order_id = ? AND status = 'passed'",
    joId
  )?.n ?? 0;
  if (passed > 0) return true;
  const receivableBatches = queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM production_batches pb
     WHERE pb.job_order_id = ?
       AND NOT EXISTS (SELECT 1 FROM job_order_units u WHERE u.batch_id = pb.id)
       AND pb.qty > COALESCE((SELECT SUM(quantity) FROM production_receipt_items WHERE batch_id = pb.id), 0)`,
    joId
  )?.n ?? 0;
  return receivableBatches > 0;
}

/** After a job order reaches a terminal state, flush its residual WIP balance: the value
 *  of unconsumed components physically returned to stock goes back to Inventory, the rest
 *  (materials consumed by scrapped units + rounding) to Manufacturing Variance. Best-effort
 *  — no-op if the ledger is off, the job order isn't terminal, WIP is already flat, or output
 *  is still awaiting Products In (its 'produce' GL entry — and so the true WIP balance —
 *  hasn't posted yet; settleJobOrderGl runs again from POST /:id/products-in once clear). */
function settleJobOrderGl(joId: number, userId: number | null): void {
  const jo = queryOne<JobOrder>('SELECT * FROM job_orders WHERE id = ?', joId);
  if (!jo || (jo.status !== 'completed' && jo.status !== 'cancelled')) return;
  if (hasReceivable(joId)) return;
  const bal = jobOrderWipBalance(joId);
  if (Math.abs(bal) < 0.005) return;
  const scrap = r2((jo.qty_scrapped || 0) * componentCostFor(joId).perUnit);
  postJobOrderMovement(joId, jo.number, today(), 'settle', bal, userId, r2(bal - scrap));
}

function loadJobOrder(id: number): JobOrder | null {
  const jo = queryOne<JobOrder>(
    `SELECT j.*, u.full_name AS created_by_name, rb.full_name AS released_by_name,
            ab.full_name AS accepted_by_name, apb.full_name AS approved_by_name,
            wab.full_name AS warehouse_accepted_by_name, prb.full_name AS prepared_by_name,
            pab.full_name AS paused_by_name,
            prs.id AS parts_slip_id, prs.number AS parts_slip_number,
            (SELECT COUNT(*) FROM production_issues pi WHERE pi.job_order_id = j.id AND pi.status = 'open') AS open_issues,
            o.number AS order_number, t.name AS team_name,
            sl.name AS source_location_name, ol.name AS output_location_name
     FROM job_orders j
     LEFT JOIN users u ON u.id = j.created_by
     LEFT JOIN users rb ON rb.id = j.released_by
     LEFT JOIN users ab ON ab.id = j.accepted_by
     LEFT JOIN users apb ON apb.id = j.approved_by
     LEFT JOIN users wab ON wab.id = j.warehouse_accepted_by
     LEFT JOIN users prb ON prb.id = j.prepared_by
     LEFT JOIN users pab ON pab.id = j.paused_by
     LEFT JOIN parts_release_slips prs ON prs.job_order_id = j.id
     LEFT JOIN orders o ON o.id = j.order_id
     LEFT JOIN production_teams t ON t.id = j.team_id
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
  const counts = queryAll<{ status: string; n: number }>(
    'SELECT status, COUNT(*) AS n FROM job_order_units WHERE job_order_id = ? GROUP BY status',
    id
  );
  const summary: Record<string, number> = { pending: 0, in_stock: 0, failed: 0, scrapped: 0, rework: 0, sold: 0 };
  for (const c of counts) summary[c.status] = c.n;
  (jo as JobOrder & { units_summary: Record<string, number> }).units_summary = summary;
  jo.qc_checklist_qc = jo.qc_stages > 0 ? checklistForProduct(jo.product_item_id, 1) : null;
  jo.qc_checklist_qa = jo.qc_stages > 0 ? checklistForProduct(jo.product_item_id, 2) : null;
  return jo;
}

const OPEN_STATES = new Set(['draft', 'released', 'in_progress', 'paused']);

/** A draft's plan changed (or its approval was withdrawn): drop the approval and everything the
 *  warehouse did on the strength of it — acceptance, picked quantities — so it goes round
 *  again. Nothing to undo in stock: parts only leave at /release. */
function resetPreRelease(joId: number): void {
  run(
    `UPDATE job_orders SET approved_by = NULL, approved_at = NULL, approve_notes = NULL,
       warehouse_accepted_by = NULL, warehouse_accepted_at = NULL, prepared_by = NULL, prepared_at = NULL
     WHERE id = ?`,
    joId
  );
  run('UPDATE job_order_components SET qty_picked = 0 WHERE job_order_id = ?', joId);
}

/** True when the production lead still has to accept this job order's parts kit (POST
 *  /:id/accept) before output can be recorded. Job orders that already have output on
 *  record — anything built before the accept step existed (SCHEMA_VERSION 45) — are
 *  exempt, so they keep working without a backfilled acceptance. */
function needsAcceptance(jo: JobOrder): boolean {
  if (jo.accepted_at) return false;
  if (jo.qty_done > 0 || jo.qty_scrapped > 0) return false;
  return !queryOne('SELECT 1 FROM job_order_units WHERE job_order_id = ? LIMIT 1', jo.id)
    && !queryOne('SELECT 1 FROM production_batches WHERE job_order_id = ? LIMIT 1', jo.id);
}
const ACCEPT_FIRST = 'Production has to accept the parts kit for this job order before recording output.';

function pendingCount(joId: number): number {
  return queryOne<{ n: number }>(
    "SELECT COUNT(*) AS n FROM job_order_units WHERE job_order_id = ? AND status = 'pending'",
    joId
  )?.n ?? 0;
}

/** Units not yet finally accounted for: awaiting first inspection ('pending') or sent
 *  back for repair ('rework'). A job order can't auto-complete while any exist. */
function unresolvedCount(joId: number): number {
  return queryOne<{ n: number }>(
    "SELECT COUNT(*) AS n FROM job_order_units WHERE job_order_id = ? AND status IN ('pending', 'rework')",
    joId
  )?.n ?? 0;
}

/** Create a production batch/lot row for a job order's progress entry. Returns its id. */
function createBatch(
  joId: number,
  productId: number | null,
  qty: number,
  label: string | null,
  status: 'open' | 'released' | 'closed',
  userId: number
): number {
  const number = nextSequence('batch_seq', 'BATCH');
  const info = run(
    `INSERT INTO production_batches
       (number, job_order_id, product_item_id, qty, identifier, status, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    number,
    joId,
    productId,
    qty,
    label,
    status,
    userId
  );
  return Number(info.lastInsertRowid);
}

/** Find this job order's open batch/lot with the given label, or start a new one — so
 *  POST /:id/units (one call per unit) can still group serialized units under a shared
 *  label the same way a bulk /progress entry used to, one unit at a time. */
function findOrCreateOpenBatch(joId: number, productId: number | null, label: string, userId: number): number {
  const existing = queryOne<{ id: number }>(
    "SELECT id FROM production_batches WHERE job_order_id = ? AND identifier = ? AND status = 'open'",
    joId,
    label
  );
  if (existing) {
    run('UPDATE production_batches SET qty = qty + 1 WHERE id = ?', existing.id);
    return existing.id;
  }
  return createBatch(joId, productId, 1, label, 'open', userId);
}

/** Consume `units` units' worth of every component, capped at what was reserved. */
function consumeComponents(joId: number, units: number): void {
  if (units <= 0) return;
  for (const c of queryAll<JobOrderComponent>('SELECT * FROM job_order_components WHERE job_order_id = ?', joId)) {
    const add = Math.min(c.qty_per_unit * units, c.qty_planned - c.qty_consumed);
    if (add > 0) run('UPDATE job_order_components SET qty_consumed = qty_consumed + ? WHERE id = ?', add, c.id);
  }
}

/** If every ordered unit is accounted for and nothing is still in inspection, close
    the job order out and return the components that were reserved but never used. */
function maybeComplete(joId: number, userId: number): void {
  const jo = queryOne<JobOrder>('SELECT * FROM job_orders WHERE id = ?', joId);
  if (!jo || jo.status === 'completed' || jo.status === 'cancelled') return;
  if (jo.qty_done + jo.qty_scrapped >= jo.qty_ordered && unresolvedCount(joId) === 0) {
    returnUnused(joId, jo.number, jo.source_location_id, userId);
    run(
      "UPDATE job_orders SET status = 'completed', closed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
      joId
    );
  }
}

// GET /api/job-orders — list, filterable by ?status= / ?order_id= / ?product_item_id= / ?team_id= / ?scheduled=1
router.get('/', readGate, (req, res) => {
  const { status, order_id, product_item_id, team_id, scheduled, stage } = req.query;
  const where: string[] = [];
  const params: unknown[] = [];
  if (typeof status === 'string' && status.trim()) { where.push('j.status = ?'); params.push(status.trim()); }
  if (order_id) { where.push('j.order_id = ?'); params.push(Number(order_id)); }
  if (product_item_id) { where.push('j.product_item_id = ?'); params.push(Number(product_item_id)); }
  if (team_id) { where.push('j.team_id = ?'); params.push(Number(team_id)); }
  if (scheduled === '1' || scheduled === 'true') where.push('(j.planned_start IS NOT NULL OR j.due_date IS NOT NULL)');
  // Pre-release queues: drafts waiting for the manager's approval, and approved drafts
  // waiting for the warehouse to release the parts.
  // awaiting_release covers every approved draft; the other three split it by warehouse step.
  if (stage === 'awaiting_approval') where.push("j.status = 'draft' AND j.approved_at IS NULL");
  if (stage === 'awaiting_release') where.push("j.status = 'draft' AND j.approved_at IS NOT NULL");
  if (stage === 'awaiting_warehouse') where.push("j.status = 'draft' AND j.approved_at IS NOT NULL AND j.warehouse_accepted_at IS NULL");
  if (stage === 'preparing') where.push("j.status = 'draft' AND j.warehouse_accepted_at IS NOT NULL AND j.prepared_at IS NULL");
  if (stage === 'ready_to_release') where.push("j.status = 'draft' AND j.prepared_at IS NOT NULL");
  const rows = queryAll<JobOrder & {
    remaining: number; units_pending: number; units_rework: number; units_passed: number;
    batches_receivable: number; overdue: number;
    units_first_pass_open: number; units_final_pass_open: number;
  }>(
    `SELECT j.*, o.number AS order_number, t.name AS team_name,
            (j.qty_ordered - j.qty_done - j.qty_scrapped) AS remaining,
            (SELECT COUNT(*) FROM production_issues pi WHERE pi.job_order_id = j.id AND pi.status = 'open') AS open_issues,
            (j.due_date IS NOT NULL AND j.due_date < date('now')
              AND j.status IN ('draft','released','in_progress','paused')) AS overdue,
            (SELECT COUNT(*) FROM job_order_units u
              WHERE u.job_order_id = j.id AND u.status = 'pending') AS units_pending,
            (SELECT COUNT(*) FROM job_order_units u
              WHERE u.job_order_id = j.id AND u.status = 'rework') AS units_rework,
            (SELECT COUNT(*) FROM job_order_units u
              WHERE u.job_order_id = j.id AND u.status = 'passed') AS units_passed,
            (SELECT COUNT(*) FROM production_batches pb
              WHERE pb.job_order_id = j.id
                AND NOT EXISTS (SELECT 1 FROM job_order_units u WHERE u.batch_id = pb.id)
                AND pb.qty > COALESCE((SELECT SUM(quantity) FROM production_receipt_items WHERE batch_id = pb.id), 0)
            ) AS batches_receivable,
            -- Awaiting inspection units bucketed by which pass they're actually on (QC =
            -- first, QA = final; a single-stage MO's one pass satisfies both buckets at
            -- once) — lets the caller's own units_actionable below reflect only what a
            -- narrow qc_inspector/qa_inspector account can act on, not every open unit
            -- regardless of stage.
            (SELECT COUNT(*) FROM job_order_units u
              WHERE u.job_order_id = j.id AND u.status IN ('pending','rework') AND (u.stage + 1) = 1
            ) AS units_first_pass_open,
            (SELECT COUNT(*) FROM job_order_units u
              WHERE u.job_order_id = j.id AND u.status IN ('pending','rework') AND (u.stage + 1) >= j.qc_stages
            ) AS units_final_pass_open
     FROM job_orders j
     LEFT JOIN orders o ON o.id = j.order_id
     LEFT JOIN production_teams t ON t.id = j.team_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY j.id DESC`,
    ...params
  );
  // units_actionable: how many of this job order's pending/rework units the CALLER's own
  // account can actually pass/fail — inventory.adjust (or holding both split permissions)
  // covers everything; a qc_inspector-only or qa_inspector-only account only its own pass.
  // Drives mobile's Production-tab and Home QA badge counts (see production.js / home.js) —
  // without this, those badges showed every open unit regardless of stage, which didn't
  // match qc.js's own queue (already filtered to just what that account can act on).
  const perms = req.user!.permissions;
  const canAdjust = perms.includes('inventory.adjust');
  const hasQc = perms.includes('production.inspect_qc');
  const hasQa = perms.includes('production.inspect_qa');
  for (const r of rows as unknown as Array<{
    units_pending: number; units_rework: number; units_first_pass_open: number;
    units_final_pass_open: number; units_actionable: number;
  }>) {
    if (canAdjust || (hasQc && hasQa)) r.units_actionable = r.units_pending + r.units_rework;
    else if (hasQc) r.units_actionable = r.units_first_pass_open;
    else if (hasQa) r.units_actionable = r.units_final_pass_open;
    else r.units_actionable = 0;
  }
  res.json(rows);
});

// GET /api/job-orders/pick-list?ids=1,2,3[&format=html] — one consolidated pick list for
// several job orders the warehouse is preparing together: each component (per source
// location) with the total needed, already picked, on hand, and the per-job-order split.
// format=html returns a printable page.
router.get('/pick-list', readGate, (req, res) => {
  const ids = [...new Set(String(req.query.ids || '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) { res.status(400).json({ error: 'Pass ?ids= with at least one job order id' }); return; }
  const jos = ids.map((id) => loadJobOrder(id));
  const missing = ids.find((_, i) => !jos[i]);
  if (missing) { res.status(404).json({ error: `Job order #${missing} not found` }); return; }
  type Line = {
    component_item_id: number; component_name: string; sku: string | null; unit: string | null;
    location_id: number; location_name: string | null; need: number; picked: number; on_hand: number;
    job_orders: Array<{ job_order_id: number; number: string; need: number; picked: number }>;
  };
  const lines = new Map<string, Line>();
  for (const jo of jos as JobOrder[]) {
    const loc = jo.source_location_id ?? getDefaultLocationId();
    for (const c of jo.components ?? []) {
      if (c.qty_planned <= 0 || c.component_item_id == null) continue;
      const key = `${c.component_item_id}@${loc}`;
      let l = lines.get(key);
      if (!l) {
        const it = queryOne<{ sku: string | null; unit: string | null }>('SELECT sku, unit FROM inventory_items WHERE id = ?', c.component_item_id);
        l = {
          component_item_id: c.component_item_id, component_name: c.component_name, sku: it?.sku ?? null, unit: it?.unit ?? null,
          location_id: loc, location_name: jo.source_location_name ?? null, need: 0, picked: 0,
          on_hand: stockAt(c.component_item_id, loc), job_orders: [],
        };
        lines.set(key, l);
      }
      l.need += c.qty_planned;
      l.picked += c.qty_picked ?? 0;
      l.job_orders.push({ job_order_id: jo.id, number: jo.number, need: c.qty_planned, picked: c.qty_picked ?? 0 });
    }
  }
  const out = {
    job_orders: (jos as JobOrder[]).map((j) => ({
      id: j.id, number: j.number, product_name: j.product_name, qty_ordered: j.qty_ordered,
      source_location_name: j.source_location_name ?? null, team_name: j.team_name ?? null,
      warehouse_accepted_at: j.warehouse_accepted_at, prepared_at: j.prepared_at,
    })),
    lines: [...lines.values()].sort((a, b) => (a.location_name ?? '').localeCompare(b.location_name ?? '') || a.component_name.localeCompare(b.component_name)),
  };
  if (req.query.format === 'html') { res.type('html').send(pickListHtml(out)); return; }
  res.json(out);
});

// GET /api/job-orders/production-receipts — Products In history (declared before /:id so
// "production-receipts" isn't captured as an id)
router.get('/production-receipts', readGate, (req, res) => {
  const { job_order_id } = req.query;
  const where: string[] = [];
  const params: unknown[] = [];
  if (job_order_id) { where.push('r.job_order_id = ?'); params.push(Number(job_order_id)); }
  const rows = queryAll<ProductionReceipt & { line_count: number }>(
    `SELECT r.*, j.number AS job_order_number, j.product_name, u.full_name AS received_by_name,
            l.name AS location_name,
            (SELECT COUNT(*) FROM production_receipt_items x WHERE x.receipt_id = r.id) AS line_count
     FROM production_receipts r
     JOIN job_orders j ON j.id = r.job_order_id
     LEFT JOIN users u ON u.id = r.received_by
     LEFT JOIN locations l ON l.id = r.location_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY r.id DESC`,
    ...params
  );
  res.json(rows);
});

// GET /api/job-orders/production-receipts/:receiptId — one receipt + its lines
router.get('/production-receipts/:receiptId', readGate, (req, res) => {
  const receipt = queryOne<ProductionReceipt>(
    `SELECT r.*, j.number AS job_order_number, j.product_name, u.full_name AS received_by_name,
            l.name AS location_name
     FROM production_receipts r
     JOIN job_orders j ON j.id = r.job_order_id
     LEFT JOIN users u ON u.id = r.received_by
     LEFT JOIN locations l ON l.id = r.location_id
     WHERE r.id = ?`,
    Number(req.params.receiptId)
  );
  if (!receipt) { res.status(404).json({ error: 'Receipt not found' }); return; }
  receipt.items = queryAll(
    `SELECT ri.*, un.identifier AS unit_identifier, pb.number AS batch_number
     FROM production_receipt_items ri
     LEFT JOIN job_order_units un ON un.id = ri.unit_id
     LEFT JOIN production_batches pb ON pb.id = ri.batch_id
     WHERE ri.receipt_id = ? ORDER BY ri.id`,
    receipt.id
  );
  res.json(receipt);
});

// GET /api/job-orders/:id
// GET /api/job-orders/:id/events — pause / resume / close-early history, newest first
router.get('/:id/events', readGate, (req, res) => {
  res.json(queryAll<{ id: number; action: string; reason: string | null; created_at: string; actor_name: string | null }>(
    `SELECT e.id, e.action, e.reason, e.created_at, u.full_name AS actor_name
     FROM job_order_events e LEFT JOIN users u ON u.id = e.actor_id
     WHERE e.job_order_id = ? ORDER BY e.id DESC`,
    Number(req.params.id)
  ));
});

router.get('/:id', readGate, (req, res) => {
  const jo = loadJobOrder(Number(req.params.id));
  if (!jo) {
    res.status(404).json({ error: 'Job order not found' });
    return;
  }
  res.json(jo);
});

/** Create a `draft` job order for `productId` × `qty`, snapshotting the product's BOM.
 *  Shared by `POST /api/job-orders` and the sale-order "produce the shortfall" action.
 *  Caller owns validation; this just writes (its own transaction). */
export function createDraftJobOrder(opts: {
  productId: number; productName: string; qty: number;
  orderId?: number | null; sourceLocationId: number; outputLocationId: number;
  qcStages?: number; teamId?: number | null; plannedStart?: string | null;
  dueDate?: string | null; priority?: number; workCenter?: string | null;
  notes?: string | null; userId: number | null;
}): { id: number; number: string } {
  const bom = queryAll<{ component_item_id: number; component_name: string; quantity: number }>(
    `SELECT b.component_item_id, i.name AS component_name, b.quantity
     FROM bom_components b JOIN inventory_items i ON i.id = b.component_item_id
     WHERE b.product_item_id = ? ORDER BY b.sort, b.id`,
    opts.productId
  );
  db.exec('BEGIN');
  let id: number;
  try {
    const number = nextSequence('mo_seq', 'MO');
    const info = run(
      `INSERT INTO job_orders
        (number, order_id, product_item_id, product_name, qty_ordered, status,
         source_location_id, output_location_id, qc_stages,
         team_id, planned_start, due_date, priority, work_center, notes, created_by)
       VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      number, opts.orderId ?? null, opts.productId, opts.productName, opts.qty,
      opts.sourceLocationId, opts.outputLocationId, opts.qcStages ?? 0,
      opts.teamId ?? null, opts.plannedStart ?? null, opts.dueDate ?? null,
      opts.priority ?? 0, opts.workCenter ?? null, opts.notes ?? null, opts.userId
    );
    id = Number(info.lastInsertRowid);
    for (const c of bom) {
      run(
        `INSERT INTO job_order_components
          (job_order_id, component_item_id, component_name, qty_per_unit, qty_planned)
         VALUES (?, ?, ?, ?, ?)`,
        id, c.component_item_id, c.component_name, c.quantity, c.quantity * opts.qty
      );
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { id, number: loadJobOrder(id)!.number };
}

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
  if (input.order_id && !queryOne('SELECT id FROM orders WHERE id = ?', input.order_id)) {
    res.status(400).json({ error: 'Linked order not found' });
    return;
  }
  if (input.team_id && !queryOne('SELECT id FROM production_teams WHERE id = ?', input.team_id)) {
    res.status(400).json({ error: 'Production team not found' });
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

  // A finished product may have no BOM yet — the job order is still created and can be
  // built; it just reserves/consumes nothing unless components are added on the draft.
  const created = createDraftJobOrder({
    productId: product.id, productName: product.name, qty: input.qty_ordered,
    orderId: input.order_id ?? null, sourceLocationId: sourceLoc, outputLocationId: outputLoc,
    qcStages: input.qc_stages, teamId: input.team_id ?? null, plannedStart: input.planned_start ?? null,
    dueDate: input.due_date ?? null, priority: input.priority ?? 0, workCenter: input.work_center ?? null,
    notes: input.notes ?? null, userId: req.user!.id,
  });
  res.status(201).json(created);
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
  if (input.team_id && !queryOne('SELECT id FROM production_teams WHERE id = ?', input.team_id)) {
    res.status(400).json({ error: 'Production team not found' });
    return;
  }
  const pick = <T>(v: T | undefined, cur: T): T => (v !== undefined ? v : cur);

  db.exec('BEGIN');
  try {
    run(
      `UPDATE job_orders SET qty_ordered = ?, source_location_id = ?, output_location_id = ?,
         qc_stages = ?, team_id = ?, planned_start = ?, due_date = ?, priority = ?,
         work_center = ?, notes = ?, updated_at = datetime('now')
       WHERE id = ?`,
      qty,
      pick(input.source_location_id, jo.source_location_id),
      pick(input.output_location_id, jo.output_location_id),
      pick(input.qc_stages, jo.qc_stages),
      pick(input.team_id, jo.team_id),
      pick(input.planned_start, jo.planned_start),
      pick(input.due_date, jo.due_date),
      pick(input.priority, jo.priority),
      pick(input.work_center, jo.work_center),
      pick(input.notes, jo.notes),
      id
    );
    if (input.qty_ordered !== undefined && input.qty_ordered !== jo.qty_ordered) {
      run('UPDATE job_order_components SET qty_planned = qty_per_unit * ? WHERE job_order_id = ?', qty, id);
    }
    resetPreRelease(id); // the approved plan changed — it needs signing off again
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.json({ ok: true });
});

// PUT /api/job-orders/:id/schedule — reassign the team / re-plan an open job order
// (team, planned start, due date, priority, work centre — allowed after release too).
router.put('/:id/schedule', writeGate, (req, res) => {
  const id = Number(req.params.id);
  const jo = queryOne<JobOrder>('SELECT * FROM job_orders WHERE id = ?', id);
  if (!jo) { res.status(404).json({ error: 'Job order not found' }); return; }
  if (jo.status === 'completed' || jo.status === 'cancelled') {
    res.status(409).json({ error: `Cannot re-schedule a job order that is ${jo.status}` });
    return;
  }
  const input = parseBody(updateJobOrderSchema, req.body);
  if (input.team_id && !queryOne('SELECT id FROM production_teams WHERE id = ?', input.team_id)) {
    res.status(400).json({ error: 'Production team not found' });
    return;
  }
  run(
    `UPDATE job_orders SET team_id = ?, planned_start = ?, due_date = ?, priority = ?,
       work_center = ?, updated_at = datetime('now')
     WHERE id = ?`,
    input.team_id !== undefined ? input.team_id : jo.team_id,
    input.planned_start !== undefined ? input.planned_start : jo.planned_start,
    input.due_date !== undefined ? input.due_date : jo.due_date,
    input.priority !== undefined ? input.priority : jo.priority,
    input.work_center !== undefined ? input.work_center : jo.work_center,
    id
  );
  res.json({ ok: true, job_order: loadJobOrder(id) });
});

// PUT /api/job-orders/:id/components — override planned quantities, and add ad-hoc
// component lines that aren't on the product's BOM (draft only). A line already on the
// job order is updated; a new one is inserted (qty_per_unit defaults to the planned
// quantity spread over the ordered quantity).
router.put('/:id/components', writeGate, (req, res) => {
  const id = Number(req.params.id);
  const jo = queryOne<JobOrder>('SELECT * FROM job_orders WHERE id = ?', id);
  if (!jo) {
    res.status(404).json({ error: 'Job order not found' });
    return;
  }
  if (jo.status !== 'draft') {
    res.status(409).json({ error: 'Planned quantities can only be changed while the job order is a draft' });
    return;
  }
  const { components } = parseBody(jobOrderComponentsSchema, req.body);

  const existing = new Set(
    queryAll<{ component_item_id: number }>(
      'SELECT component_item_id FROM job_order_components WHERE job_order_id = ?', id
    ).map((r) => r.component_item_id)
  );
  const seen = new Set<number>();
  for (const c of components) {
    if (seen.has(c.component_item_id)) {
      res.status(400).json({ error: 'The same component is listed twice' });
      return;
    }
    seen.add(c.component_item_id);
    if (jo.product_item_id != null && c.component_item_id === jo.product_item_id) {
      res.status(400).json({ error: 'A product cannot be a component of itself' });
      return;
    }
    if (!existing.has(c.component_item_id)
      && !queryOne('SELECT id FROM inventory_items WHERE id = ?', c.component_item_id)) {
      res.status(400).json({ error: `Component #${c.component_item_id} does not exist` });
      return;
    }
  }

  db.exec('BEGIN');
  try {
    for (const c of components) {
      if (existing.has(c.component_item_id)) {
        run(
          'UPDATE job_order_components SET qty_planned = ? WHERE job_order_id = ? AND component_item_id = ?',
          c.qty_planned,
          id,
          c.component_item_id
        );
      } else {
        const it = queryOne<{ name: string }>('SELECT name FROM inventory_items WHERE id = ?', c.component_item_id);
        const perUnit = c.qty_per_unit != null
          ? c.qty_per_unit
          : (jo.qty_ordered > 0 ? Math.ceil(c.qty_planned / jo.qty_ordered) : c.qty_planned);
        run(
          `INSERT INTO job_order_components
             (job_order_id, component_item_id, component_name, qty_per_unit, qty_planned)
           VALUES (?, ?, ?, ?, ?)`,
          id,
          c.component_item_id,
          it?.name ?? `#${c.component_item_id}`,
          perUnit,
          c.qty_planned
        );
      }
    }
    resetPreRelease(id); // the approved component plan changed — it needs signing off again
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.json({ ok: true, job_order: loadJobOrder(id) });
});

/** Components a job order can't cover from its source location: `{component_item_id,
 *  component_name, need, have, short}`. Empty ⇒ the job order is releasable. */
function jobOrderComponentShortfalls(joId: number): Array<{
  component_item_id: number; component_name: string; need: number; have: number; short: number;
}> {
  const jo = loadJobOrder(joId);
  if (!jo) return [];
  const sourceLoc = jo.source_location_id ?? getDefaultLocationId();
  const out: Array<{ component_item_id: number; component_name: string; need: number; have: number; short: number }> = [];
  for (const c of jo.components ?? []) {
    if (c.qty_planned <= 0 || c.component_item_id == null) continue;
    const have = stockAt(c.component_item_id, sourceLoc);
    if (have < c.qty_planned) {
      out.push({ component_item_id: c.component_item_id, component_name: c.component_name, need: c.qty_planned, have, short: c.qty_planned - have });
    }
  }
  return out;
}

/** Every planned component vs. what's on hand at the source location, for the pre-release
 *  stock check. `short` is 0 when covered. */
function jobOrderComponentAvailability(joId: number): Array<{
  component_item_id: number; component_name: string; need: number; have: number; short: number; picked: number;
}> {
  const jo = loadJobOrder(joId);
  if (!jo) return [];
  const sourceLoc = jo.source_location_id ?? getDefaultLocationId();
  const out: Array<{ component_item_id: number; component_name: string; need: number; have: number; short: number; picked: number }> = [];
  for (const c of jo.components ?? []) {
    if (c.qty_planned <= 0 || c.component_item_id == null) continue;
    const have = stockAt(c.component_item_id, sourceLoc);
    out.push({
      component_item_id: c.component_item_id, component_name: c.component_name,
      need: c.qty_planned, have, short: Math.max(0, c.qty_planned - have), picked: c.qty_picked ?? 0,
    });
  }
  return out;
}

/** Quantity of `itemId` already picked at `locationId` for other not-yet-released job orders
 *  (their kits are set aside but haven't left stock yet), so two kits can't both claim it. */
function pickedElsewhere(itemId: number, locationId: number, excludeJoIds: number[]): number {
  const defLoc = getDefaultLocationId();
  const ex = excludeJoIds.length ? `AND j.id NOT IN (${excludeJoIds.map(() => '?').join(',')})` : '';
  return queryOne<{ n: number }>(
    `SELECT COALESCE(SUM(c.qty_picked), 0) AS n
     FROM job_order_components c JOIN job_orders j ON j.id = c.job_order_id
     WHERE j.status = 'draft' AND c.component_item_id = ? AND COALESCE(j.source_location_id, ?) = ? ${ex}`,
    itemId, defLoc, locationId, ...excludeJoIds
  )?.n ?? 0;
}

/** Why a job order can't enter the warehouse's hands (accept / prepare), or null if it can. */
function warehouseStepError(jo: JobOrder | null, needAccepted: boolean): { status: number; error: string } | null {
  if (!jo) return { status: 404, error: 'Job order not found' };
  if (jo.status !== 'draft') return { status: 409, error: `${jo.number} is already ${jo.status}` };
  if (!jo.approved_at) return { status: 409, error: `${jo.number} has not been approved yet` };
  if (needAccepted && !jo.warehouse_accepted_at) return { status: 409, error: `The warehouse has not accepted ${jo.number} yet` };
  return null;
}

// POST /api/job-orders/warehouse-accept — the warehouse takes on one or more approved drafts
// for preparing. All-or-nothing; already-accepted ones are left as they are.
router.post('/warehouse-accept', writeGate, (req, res) => {
  const { job_order_ids } = parseBody(jobOrderIdsSchema, req.body);
  const ids = [...new Set(job_order_ids)];
  for (const id of ids) {
    const err = warehouseStepError(loadJobOrder(id), false);
    if (err) { res.status(err.status).json({ error: err.error, job_order_id: id }); return; }
  }
  for (const id of ids) {
    run(
      `UPDATE job_orders SET warehouse_accepted_by = ?, warehouse_accepted_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ? AND warehouse_accepted_at IS NULL`,
      req.user!.id, id
    );
  }
  res.json({ ok: true, job_orders: ids.map((id) => loadJobOrder(id)) });
});

// POST /api/job-orders/prepare — the warehouse records what it picked for one or more accepted
// job orders (several kits can be picked in one go). A job order without `lines` is picked in
// full. A job order whose every line is fully picked is marked prepared (ready to release);
// a partial pick is saved but leaves it preparing. Picks are checked against on-hand stock
// minus what other unreleased kits already set aside. All-or-nothing.
router.post('/prepare', writeGate, (req, res) => {
  const { job_orders } = parseBody(prepareJobOrdersSchema, req.body);
  const ids = job_orders.map((j) => j.id);
  if (new Set(ids).size !== ids.length) { res.status(400).json({ error: 'The same job order is listed twice' }); return; }

  // Resolve the requested pick per job order + component.
  const plan: Array<{ jo: JobOrder; picks: Map<number, number> }> = [];
  for (const req0 of job_orders) {
    const jo = loadJobOrder(req0.id);
    const err = warehouseStepError(jo, true);
    if (err) { res.status(err.status).json({ error: err.error, job_order_id: req0.id }); return; }
    const comps = (jo!.components ?? []).filter((c) => c.component_item_id != null);
    const picks = new Map<number, number>(comps.map((c) => [c.component_item_id!, c.qty_picked ?? 0]));
    if (!req0.lines) {
      for (const c of comps) picks.set(c.component_item_id!, c.qty_planned);
    } else {
      for (const l of req0.lines) {
        const c = comps.find((x) => x.component_item_id === l.component_item_id);
        if (!c) { res.status(400).json({ error: `Component #${l.component_item_id} is not on ${jo!.number}` }); return; }
        if (l.qty_picked > c.qty_planned) {
          res.status(400).json({ error: `${c.component_name} on ${jo!.number}: picked ${l.qty_picked} but only ${c.qty_planned} planned` });
          return;
        }
        picks.set(c.component_item_id!, l.qty_picked);
      }
    }
    plan.push({ jo: jo!, picks });
  }

  // Stock check per component + location across the whole request.
  const demand = new Map<string, { itemId: number; loc: number; qty: number; name: string }>();
  for (const { jo, picks } of plan) {
    const loc = jo.source_location_id ?? getDefaultLocationId();
    for (const [itemId, qty] of picks) {
      const key = `${itemId}@${loc}`;
      const name = (jo.components ?? []).find((c) => c.component_item_id === itemId)?.component_name ?? `#${itemId}`;
      const d = demand.get(key) ?? { itemId, loc, qty: 0, name };
      d.qty += qty;
      demand.set(key, d);
    }
  }
  const short: Array<{ component_item_id: number; component_name: string; picking: number; available: number }> = [];
  for (const d of demand.values()) {
    const available = stockAt(d.itemId, d.loc) - pickedElsewhere(d.itemId, d.loc, ids);
    if (d.qty > available) short.push({ component_item_id: d.itemId, component_name: d.name, picking: d.qty, available: Math.max(0, available) });
  }
  if (short.length) {
    res.status(400).json({
      error: 'Not enough stock to pick — ' + short.map((s) => `${s.component_name}: picking ${s.picking}, available ${s.available}`).join('; '),
      shortfalls: short,
    });
    return;
  }

  db.exec('BEGIN');
  try {
    for (const { jo, picks } of plan) {
      for (const [itemId, qty] of picks) {
        run('UPDATE job_order_components SET qty_picked = ? WHERE job_order_id = ? AND component_item_id = ?', qty, jo.id, itemId);
      }
      const complete = (jo.components ?? []).every((c) => c.component_item_id == null || c.qty_planned <= 0
        || (picks.get(c.component_item_id) ?? 0) >= c.qty_planned);
      if (complete) {
        run(
          `UPDATE job_orders SET prepared_by = ?, prepared_at = COALESCE(prepared_at, datetime('now')), updated_at = datetime('now') WHERE id = ?`,
          req.user!.id, jo.id
        );
      } else {
        run("UPDATE job_orders SET prepared_by = NULL, prepared_at = NULL, updated_at = datetime('now') WHERE id = ?", jo.id);
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.json({ ok: true, job_orders: ids.map((id) => loadJobOrder(id)) });
});

// GET /api/job-orders/:id/availability — stock check before release: each planned component's
// need vs. on-hand at the source location, plus whether the job order can be released now.
router.get('/:id/availability', readGate, (req, res) => {
  const id = Number(req.params.id);
  const jo = loadJobOrder(id);
  if (!jo) { res.status(404).json({ error: 'Job order not found' }); return; }
  const lines = jobOrderComponentAvailability(id);
  const shortfalls = lines.filter((l) => l.short > 0);
  const approved = !!jo.approved_at;
  const warehouseAccepted = !!jo.warehouse_accepted_at;
  const prepared = !!jo.prepared_at;
  res.json({
    job_order_id: id,
    status: jo.status,
    source_location_id: jo.source_location_id ?? getDefaultLocationId(),
    source_location_name: jo.source_location_name ?? null,
    lines,
    shortfalls,
    in_stock: shortfalls.length === 0,
    approved,
    warehouse_accepted: warehouseAccepted,
    prepared,
    // Everything /release checks, in one flag.
    releasable: jo.status === 'draft' && approved && warehouseAccepted && prepared && shortfalls.length === 0,
  });
});

// POST /api/job-orders/:id/approve — the production manager signs off the draft (quantity,
// locations, components) so the warehouse may release its parts. Short stock doesn't block
// approval (purchasing can fill the gap before release); the response lists it as a warning.
router.post('/:id/approve', approveGate, (req, res) => {
  const id = Number(req.params.id);
  const jo = loadJobOrder(id);
  if (!jo) { res.status(404).json({ error: 'Job order not found' }); return; }
  if (jo.status !== 'draft') {
    res.status(409).json({ error: `Only a draft job order can be approved (this one is ${jo.status})` });
    return;
  }
  if (jo.approved_at) {
    res.status(409).json({ error: `Already approved by ${jo.approved_by_name ?? 'a manager'}` });
    return;
  }
  const { notes } = parseBody(acceptJobOrderSchema, req.body);
  run(
    "UPDATE job_orders SET approved_by = ?, approved_at = datetime('now'), approve_notes = ?, updated_at = datetime('now') WHERE id = ?",
    req.user!.id, notes ?? null, id
  );
  res.json({ ok: true, job_order: loadJobOrder(id), shortfalls: jobOrderComponentShortfalls(id) });
});

// POST /api/job-orders/:id/unapprove — withdraw the approval of a not-yet-released draft.
router.post('/:id/unapprove', approveGate, (req, res) => {
  const id = Number(req.params.id);
  const jo = queryOne<JobOrder>('SELECT status, approved_at FROM job_orders WHERE id = ?', id);
  if (!jo) { res.status(404).json({ error: 'Job order not found' }); return; }
  if (jo.status !== 'draft') {
    res.status(409).json({ error: 'The parts are already released — cancel the job order instead' });
    return;
  }
  if (!jo.approved_at) { res.status(409).json({ error: 'This job order is not approved' }); return; }
  resetPreRelease(id);
  run("UPDATE job_orders SET updated_at = datetime('now') WHERE id = ?", id);
  res.json({ ok: true, job_order: loadJobOrder(id) });
});

// POST /api/job-orders/:id/purchase-shortfall — draft purchase order(s) for the components
// this job order can't cover from its source location, grouped by supplier.
router.post('/:id/purchase-shortfall', writeGate, (req, res) => {
  const id = Number(req.params.id);
  const jo = queryOne<JobOrder>('SELECT number FROM job_orders WHERE id = ?', id);
  if (!jo) { res.status(404).json({ error: 'Job order not found' }); return; }
  const short = jobOrderComponentShortfalls(id);
  if (!short.length) { res.json({ created: [], note: 'All components are in stock.' }); return; }
  const created = createDraftPurchaseOrders(
    short.map((s) => ({ item_id: s.component_item_id, quantity: s.short })),
    `Components for ${jo.number}`,
    req.user!.id
  );
  res.json({ created, shortfalls: short });
});

// POST /api/job-orders/:id/release — issue the parts release slip for a prepared kit: the
// numbered record (PRS-#####) of what the warehouse handed to production, snapshotting the
// lines. Issuing it IS the release — planned components leave the source location here.
// Needs approval → warehouse acceptance → a fully picked kit. Photos of the kit attach
// afterwards as `attachments` kind 'parts_release' on the slip id.
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
  if (!jo.approved_at) {
    res.status(409).json({ error: 'This job order has not been approved yet', needs_approval: true });
    return;
  }
  if (!jo.warehouse_accepted_at) {
    res.status(409).json({ error: 'The warehouse has not accepted this job order yet', needs_warehouse_accept: true });
    return;
  }
  if (!jo.prepared_at) {
    res.status(409).json({ error: 'Prepare (pick) the whole parts kit before releasing it', needs_prepare: true });
    return;
  }
  const input = parseBody(releaseJobOrderSchema, req.body ?? {});
  const shortfalls = jobOrderComponentShortfalls(id);
  if (shortfalls.length) {
    res.status(400).json({
      error: `Not enough stock at ${jo.source_location_name ?? 'the source location'} — `
        + shortfalls.map((s) => `${s.component_name}: need ${s.need}, have ${s.have}`).join('; '),
      shortfalls,
    });
    return;
  }
  const sourceLoc = jo.source_location_id ?? getDefaultLocationId();

  let slipId: number;
  let slipNumber: string;
  db.exec('BEGIN');
  try {
    slipNumber = nextSequence('parts_release_slip_number', 'PRS');
    slipId = Number(run(
      'INSERT INTO parts_release_slips (number, job_order_id, released_by, received_by, notes) VALUES (?, ?, ?, ?, ?)',
      slipNumber, id, req.user!.id, input.received_by ?? null, input.notes ?? null
    ).lastInsertRowid);
    for (const c of jo.components ?? []) {
      if (c.qty_planned <= 0 || c.component_item_id == null) continue;
      applyStockChange({
        itemId: c.component_item_id,
        locationId: sourceLoc,
        change: -c.qty_planned,
        reason: `${jo.number}: released to production (${slipNumber})`,
        userId: req.user!.id,
      });
      const it = queryOne<{ sku: string | null; unit: string | null }>('SELECT sku, unit FROM inventory_items WHERE id = ?', c.component_item_id);
      run(
        'INSERT INTO parts_release_slip_items (slip_id, component_item_id, name, sku, unit, quantity) VALUES (?, ?, ?, ?, ?, ?)',
        slipId, c.component_item_id, c.component_name, it?.sku ?? null, it?.unit ?? null, c.qty_planned
      );
    }
    run(
      "UPDATE job_orders SET status = 'released', released_by = ?, released_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
      req.user!.id, id
    );
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  // GL: raw materials leave Inventory into Work in Process (best-effort).
  postJobOrderMovement(id, jo.number, today(), 'release', componentCostFor(id).released, req.user!.id);
  res.json({ ok: true, job_order: loadJobOrder(id), slip: { id: slipId, number: slipNumber } });
});

// POST /api/job-orders/:id/accept — the production lead signs for the parts kit the
// warehouse released. Records who/when (+ optional handover notes); no stock movement —
// the parts already left the source location at /release. Unlocks recording output.
router.post('/:id/accept', recordGate, (req, res) => {
  const id = Number(req.params.id);
  const jo = loadJobOrder(id);
  if (!jo) {
    res.status(404).json({ error: 'Job order not found' });
    return;
  }
  if (jo.status === 'draft') {
    res.status(409).json({ error: 'The warehouse has not released the parts for this job order yet' });
    return;
  }
  if (!OPEN_STATES.has(jo.status)) {
    res.status(409).json({ error: `Cannot accept a job order that is ${jo.status}` });
    return;
  }
  if (jo.accepted_at) {
    res.status(409).json({ error: `Already accepted by ${jo.accepted_by_name ?? 'production'}` });
    return;
  }
  const { notes } = parseBody(acceptJobOrderSchema, req.body);
  run(
    "UPDATE job_orders SET accepted_by = ?, accepted_at = datetime('now'), accept_notes = ?, updated_at = datetime('now') WHERE id = ?",
    req.user!.id, notes ?? null, id
  );
  res.json({ ok: true, job_order: loadJobOrder(id) });
});

// POST /api/job-orders/:id/progress — record finished / scrapped units
router.post('/:id/progress', recordGate, (req, res) => {
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
  if (needsAcceptance(jo)) {
    res.status(409).json({ error: ACCEPT_FIRST, needs_acceptance: true });
    return;
  }
  const { done_delta, scrapped_delta, batch_label } = parseBody(jobOrderProgressSchema, req.body);
  if (jo.qc_stages > 0 && done_delta > 0) {
    res.status(400).json({
      error: 'Serialized job orders record finished units individually (with their own identifier + photo) via "Add unit", not a bulk count here.',
    });
    return;
  }
  const madeUnits = done_delta + scrapped_delta; // every unit off the line consumes components
  const outputLoc = jo.output_location_id ?? getDefaultLocationId();
  // "Accounted for" = in stock + scrapped + still under inspection + out for repair.
  const accounted = jo.qty_done + jo.qty_scrapped + unresolvedCount(id);
  if (accounted + madeUnits > jo.qty_ordered) {
    res.status(400).json({
      error: `That exceeds the ${jo.qty_ordered} ordered (${accounted} already produced).`,
    });
    return;
  }

  db.exec('BEGIN');
  try {
    consumeComponents(id, madeUnits);

    if (jo.qc_stages > 0) {
      // Optional: group this progress entry's units into a batch/lot.
      const batchId = batch_label
        ? createBatch(id, jo.product_item_id, done_delta, batch_label, 'open', req.user!.id)
        : null;
      // Units queue for inspection instead of going straight to stock.
      for (let i = 0; i < done_delta; i++) {
        run(
          `INSERT INTO job_order_units (job_order_id, product_item_id, status, stage, location_id, batch_id)
           VALUES (?, ?, 'pending', 0, ?, ?)`,
          id,
          jo.product_item_id,
          outputLoc,
          batchId
        );
      }
      for (let i = 0; i < scrapped_delta; i++) {
        run(
          `INSERT INTO job_order_units (job_order_id, product_item_id, status, stage, location_id, batch_id, remarks)
           VALUES (?, ?, 'scrapped', 0, ?, ?, 'Scrapped on the line')`,
          id,
          jo.product_item_id,
          outputLoc,
          batchId
        );
      }
      run(
        "UPDATE job_orders SET qty_scrapped = qty_scrapped + ?, status = 'in_progress', updated_at = datetime('now') WHERE id = ?",
        scrapped_delta,
        id
      );
    } else {
      // No inspection gate — but still awaits Products In before it hits stock (see
      // POST /:id/products-in). Each progress entry is recorded as one open batch/lot,
      // the receivable line for this output, so bulk production stays traceable.
      if (done_delta > 0) {
        createBatch(id, jo.product_item_id, done_delta, batch_label ?? null, 'open', req.user!.id);
      }
      run(
        "UPDATE job_orders SET qty_done = qty_done + ?, qty_scrapped = qty_scrapped + ?, status = 'in_progress', updated_at = datetime('now') WHERE id = ?",
        done_delta,
        scrapped_delta,
        id
      );
    }
    maybeComplete(id, req.user!.id);
    maybeCloseBatches(id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  // Production's "DR Inventory / CR WIP" GL entry now posts at Products In (with the stock
  // movement itself) rather than here — see POST /:id/products-in. settleJobOrderGl() no-ops
  // on its own while this job order still has receivable output (hasReceivable()).
  settleJobOrderGl(id, req.user!.id);
  res.json({ ok: true, job_order: loadJobOrder(id) });
});

// POST /api/job-orders/:id/units — add ONE serialized (QC-gated) unit "off the line" with
// its identifier AND its photo, both required, in one multipart request (fields
// `identifier`, `batch_label`, file `image`). The photo is saved as `attachments` kind
// 'qc_unit' on the new unit — the same kind the QC/QA pass/fail flow uses for defect
// photos. Unit and photo commit together, so no unit reaches QC without one (SCHEMA 50;
// it used to be a separate POST /api/attachments that could fail after the unit was
// already created). "N units finished at once" loops this endpoint once per unit rather than one
// request for many, so each keeps its own identifier + photo; an optional batch_label
// still groups them under a shared lot the same way a bulk progress entry used to (each
// call with the same label adds to that job order's open batch of it). A non-serialized
// (qc_stages = 0) job order has no individual unit to attach either to, so it still
// records output as a batch quantity via /progress, unchanged.
router.post('/:id/units', recordGate, imageUpload.single('image'), (req, res) => {
  // The photo arrives with the unit (multipart field `image`), so a unit can't reach QC
  // without one. Any refusal below deletes the uploaded file again.
  const file = req.file;
  const fail = (status: number, body: Record<string, unknown>) => { unlink(file?.filename); res.status(status).json(body); };
  const id = Number(req.params.id);
  const jo = loadJobOrder(id);
  if (!jo) { fail(404, { error: 'Job order not found' }); return; }
  if (jo.status !== 'released' && jo.status !== 'in_progress') {
    fail(409, { error: `Job order must be released before recording progress (it is ${jo.status})` });
    return;
  }
  if (needsAcceptance(jo)) { fail(409, { error: ACCEPT_FIRST, needs_acceptance: true }); return; }
  if (jo.qc_stages <= 0) {
    fail(400, { error: "This job order isn't serialized — record output as a batch quantity via progress instead." });
    return;
  }
  let parsed: { identifier: string; batch_label?: string | null };
  try { parsed = parseBody(addUnitSchema, req.body); } catch (e) { unlink(file?.filename); throw e; }
  const { identifier, batch_label } = parsed;
  if (!file) { fail(400, { error: 'A photo of the unit is required (JPG, PNG, GIF or WebP)', needs_photo: true }); return; }
  const accounted = jo.qty_done + jo.qty_scrapped + unresolvedCount(id);
  if (accounted + 1 > jo.qty_ordered) {
    fail(400, { error: `That exceeds the ${jo.qty_ordered} ordered (${accounted} already produced).` });
    return;
  }
  try { enforceQuota('storage_mb', file.size); } catch (e) { unlink(file.filename); throw e; }
  const outputLoc = jo.output_location_id ?? getDefaultLocationId();

  db.exec('BEGIN');
  let unitId: number;
  try {
    consumeComponents(id, 1);
    const batchId = batch_label ? findOrCreateOpenBatch(id, jo.product_item_id, batch_label, req.user!.id) : null;
    const info = run(
      `INSERT INTO job_order_units (job_order_id, product_item_id, identifier, status, stage, location_id, batch_id)
       VALUES (?, ?, ?, 'pending', 0, ?, ?)`,
      id,
      jo.product_item_id,
      identifier,
      outputLoc,
      batchId
    );
    unitId = Number(info.lastInsertRowid);
    saveAttachment('qc_unit', unitId, file.filename, 'Off the line', req.user!.id);
    run("UPDATE job_orders SET status = 'in_progress', updated_at = datetime('now') WHERE id = ?", id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    unlink(file.filename);
    throw e;
  }
  res.status(201).json({ id: unitId, job_order: loadJobOrder(id) });
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

/** When a job order is force-closed or cancelled, tidy its loose ends: cancel any parts
 *  requests the warehouse never acted on, and treat units still awaiting inspection or
 *  out for repair as scrapped (their components were already consumed → they settle to
 *  Manufacturing Variance). Returns the number of units scrapped. Caller is in a txn. */
function resolveDanglingUnits(joId: number, reason: string): number {
  run(
    `UPDATE repair_part_requests SET status = 'cancelled', updated_at = datetime('now')
     WHERE status = 'requested'
       AND unit_id IN (SELECT id FROM job_order_units WHERE job_order_id = ?)`,
    joId
  );
  const info = run(
    `UPDATE job_order_units
       SET status = 'scrapped',
           remarks = TRIM(COALESCE(remarks || ' · ', '') || ?),
           updated_at = datetime('now')
     WHERE job_order_id = ? AND status IN ('pending', 'rework')`,
    reason,
    joId
  );
  const n = Number(info.changes) || 0;
  if (n > 0) run('UPDATE job_orders SET qty_scrapped = qty_scrapped + ? WHERE id = ?', n, joId);
  return n;
}

/** Close any of a job order's batches whose units have all reached a terminal state. */
function maybeCloseBatches(joId: number): void {
  run(
    `UPDATE production_batches SET status = 'closed', updated_at = datetime('now')
     WHERE job_order_id = ? AND status != 'closed'
       AND EXISTS (SELECT 1 FROM job_order_units u WHERE u.batch_id = production_batches.id)
       AND NOT EXISTS (
         SELECT 1 FROM job_order_units u
         WHERE u.batch_id = production_batches.id AND u.status IN ('pending', 'rework')
       )`,
    joId
  );
}

// POST /api/job-orders/:id/pause  &  /resume — no stock movement
// (inventory.adjust, or production.pause for a line lead trusted to hold the line — e.g. to
// switch to a higher-priority job order). The reason and who paused are kept until resume.
router.post('/:id/pause', pauseGate, (req, res) => {
  const id = Number(req.params.id);
  const jo = queryOne<JobOrder>('SELECT * FROM job_orders WHERE id = ?', id);
  if (!jo) { res.status(404).json({ error: 'Job order not found' }); return; }
  if (jo.status !== 'released' && jo.status !== 'in_progress') {
    res.status(409).json({ error: `Cannot pause a job order that is ${jo.status}` });
    return;
  }
  const why = reasonFor(req, 'pause');
  if ('error' in why) { res.status(400).json({ error: why.error }); return; }
  run(
    `UPDATE job_orders SET status = 'paused', paused_by = ?, paused_at = datetime('now'), pause_reason = ?,
       updated_at = datetime('now') WHERE id = ?`,
    req.user!.id, why.reason, id
  );
  logLineEvent(id, 'pause', why.reason, req.user!.id);
  res.json({ ok: true, job_order: loadJobOrder(id) });
});

router.post('/:id/resume', pauseGate, (req, res) => {
  const id = Number(req.params.id);
  const jo = queryOne<JobOrder>('SELECT * FROM job_orders WHERE id = ?', id);
  if (!jo) { res.status(404).json({ error: 'Job order not found' }); return; }
  if (jo.status !== 'paused') {
    res.status(409).json({ error: 'Only a paused job order can be resumed' });
    return;
  }
  const why = reasonFor(req, 'resume');
  if ('error' in why) { res.status(400).json({ error: why.error }); return; }
  logLineEvent(id, 'resume', why.reason, req.user!.id);
  run(
    `UPDATE job_orders SET status = 'in_progress', paused_by = NULL, paused_at = NULL, pause_reason = NULL,
       updated_at = datetime('now') WHERE id = ?`,
    id
  );
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
    resolveDanglingUnits(id, `${jo.number} cancelled`);
    if (jo.released_at) returnUnused(id, jo.number, jo.source_location_id, req.user!.id);
    maybeCloseBatches(id);
    run(
      "UPDATE job_orders SET status = 'cancelled', closed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
      id
    );
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  settleJobOrderGl(id, req.user!.id);   // GL: flush any WIP back to Inventory / Variance
  res.json({ ok: true, job_order: loadJobOrder(id) });
});

// POST /api/job-orders/:id/close — force-complete early, returning unused components
router.post('/:id/close', closeEarlyGate, (req, res) => {
  const id = Number(req.params.id);
  const jo = loadJobOrder(id);
  if (!jo) { res.status(404).json({ error: 'Job order not found' }); return; }
  if (!['released', 'in_progress', 'paused'].includes(jo.status)) {
    res.status(409).json({ error: `Cannot close a job order that is ${jo.status}` });
    return;
  }
  const why = reasonFor(req, 'close');
  if ('error' in why) { res.status(400).json({ error: why.error }); return; }
  db.exec('BEGIN');
  try {
    logLineEvent(id, 'close_early', why.reason, req.user!.id);
    resolveDanglingUnits(id, `${jo.number} closed early`);
    returnUnused(id, jo.number, jo.source_location_id, req.user!.id);
    maybeCloseBatches(id);
    run(
      "UPDATE job_orders SET status = 'completed', closed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
      id
    );
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  settleJobOrderGl(id, req.user!.id);   // GL: flush any WIP back to Inventory / Variance
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

// ----- Phase C: per-unit tracking + QA/QC -----

// GET /api/job-orders/:id/units — every unit this job order produced
router.get('/:id/units', readGate, (req, res) => {
  const id = Number(req.params.id);
  if (!queryOne('SELECT id FROM job_orders WHERE id = ?', id)) {
    res.status(404).json({ error: 'Job order not found' });
    return;
  }
  res.json(
    queryAll<JobOrderUnit>(
      'SELECT * FROM job_order_units WHERE job_order_id = ? ORDER BY id',
      id
    )
  );
});

// GET /api/job-orders/:id/qc — the inspection log
router.get('/:id/qc', readGate, (req, res) => {
  const id = Number(req.params.id);
  if (!queryOne('SELECT id FROM job_orders WHERE id = ?', id)) {
    res.status(404).json({ error: 'Job order not found' });
    return;
  }
  const rows = queryAll<{ checklist: string | null }>(
    `SELECT q.*, u.full_name AS inspector_name, un.identifier AS unit_identifier
     FROM qc_records q
     LEFT JOIN users u ON u.id = q.inspector_id
     LEFT JOIN job_order_units un ON un.id = q.unit_id
     WHERE q.job_order_id = ?
     ORDER BY q.id DESC`,
    id
  );
  res.json(
    rows.map((r) => {
      let checklist: unknown = null;
      try { checklist = r.checklist ? JSON.parse(r.checklist) : null; } catch { checklist = null; }
      return { ...r, checklist };
    })
  );
});

// POST /api/job-orders/:id/units/inspect — pass/fail one or more pending units
router.post('/:id/units/inspect', inspectDoorGate, (req, res) => {
  const id = Number(req.params.id);
  const jo = loadJobOrder(id);
  if (!jo) {
    res.status(404).json({ error: 'Job order not found' });
    return;
  }
  const { unit_ids, result, remarks, identifier, checklist, disposition } = parseBody(inspectUnitsSchema, req.body);
  const units = queryAll<JobOrderUnit>(
    `SELECT * FROM job_order_units WHERE job_order_id = ? AND id IN (${unit_ids.map(() => '?').join(',')})`,
    id,
    ...unit_ids
  );
  if (units.length !== unit_ids.length) {
    res.status(400).json({ error: 'One or more units were not found on this job order' });
    return;
  }
  // 'pending' = awaiting inspection; 'rework' = a repaired unit coming back for re-inspection.
  const notInspectable = units.filter((u) => u.status !== 'pending' && u.status !== 'rework');
  if (notInspectable.length) {
    res.status(409).json({ error: 'Only units under inspection or back from repair can be passed or failed' });
    return;
  }
  // A repaired unit can only be re-inspected once its outstanding parts requests to the
  // warehouse have been dealt with (accepted / rejected / cancelled — nothing still open).
  const reworkIds = units.filter((u) => u.status === 'rework').map((u) => u.id);
  if (reworkIds.length) {
    const openReq = queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM repair_part_requests
       WHERE status = 'requested' AND unit_id IN (${reworkIds.map(() => '?').join(',')})`,
      ...reworkIds
    )?.n ?? 0;
    if (openReq > 0) {
      res.status(409).json({ error: 'This unit still has parts requests the warehouse has not acted on yet.' });
      return;
    }
  }
  const outputLoc = jo.output_location_id ?? getDefaultLocationId();
  const stages = Math.max(1, jo.qc_stages || 1);

  // Which checklist(s) apply to this pass: the QC checklist on the first pass, the QA
  // checklist on the final one. On a single-stage MO the one inspection is both first
  // and final, so both the product's QC and QA checklists apply together.
  const isFirstPass = units.some((u) => u.stage + 1 === 1);
  const isFinalPass = units.some((u) => u.stage + 1 >= stages);

  // inspectDoorGate only confirmed the caller holds SOME inspect permission; a
  // qc_inspector/qa_inspector account is further restricted to the specific pass(es)
  // these units are actually on. A single-stage job order's one pass is both first and
  // final together (it runs both checklists in one go), so either permission covers it.
  if (!req.user!.permissions.includes('inventory.adjust')) {
    const hasQc = req.user!.permissions.includes('production.inspect_qc');
    const hasQa = req.user!.permissions.includes('production.inspect_qa');
    const combinedPass = stages <= 1;
    const covered = combinedPass ? (hasQc || hasQa) : ((!isFirstPass || hasQc) && (!isFinalPass || hasQa));
    if (!covered) {
      res.status(403).json({
        error: combinedPass
          ? 'Forbidden: needs QC or QA inspection permission'
          : `Forbidden: needs ${isFirstPass ? 'QC' : 'QA'} inspection permission for this pass`,
      });
      return;
    }
  }

  // A unit can only become finished stock once its checklist is complete — every
  // configured *required* check that applies to this pass must be ticked OK.
  if (result === 'pass') {
    const activeItems = [
      ...(isFirstPass ? checklistForProduct(jo.product_item_id, 1)?.items ?? [] : []),
      ...(isFinalPass ? checklistForProduct(jo.product_item_id, 2)?.items ?? [] : []),
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
    for (const u of units) {
      const stage = u.stage + 1;
      run(
        `INSERT INTO qc_records (job_order_id, unit_id, stage, result, disposition, remarks, checklist, inspector_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        u.id,
        stage,
        result,
        result === 'fail' ? (disposition ?? null) : null,
        remarks ?? null,
        checklistJson,
        req.user!.id
      );
      if (result === 'fail' && disposition === 'repair') {
        // Send it back for repair — not scrapped, keeps its stage so it re-does the
        // inspection it failed once the parts are sorted.
        run(
          "UPDATE job_order_units SET status = 'rework', disposition = 'repair', remarks = ?, updated_at = datetime('now') WHERE id = ?",
          remarks ?? u.remarks,
          u.id
        );
      } else if (result === 'fail') {
        run(
          "UPDATE job_order_units SET status = 'failed', disposition = ?, stage = ?, remarks = ?, updated_at = datetime('now') WHERE id = ?",
          disposition ?? 'scrap',
          stage,
          remarks ?? u.remarks,
          u.id
        );
        run('UPDATE job_orders SET qty_scrapped = qty_scrapped + 1, updated_at = datetime(\'now\') WHERE id = ?', id);
      } else {
        const identSql = identifier !== undefined && identifier !== null ? identifier : u.identifier;
        if (stage >= stages) {
          // Final pass — not into stock yet. 'passed' queues it for Products In
          // (POST /:id/products-in), which is where the unit actually posts to stock and
          // becomes sellable/reservable (orders.routes.ts still gates on 'in_stock'). Keep
          // its default location as the receiving screen's pre-filled destination.
          const unitLoc = u.location_id ?? outputLoc;
          run(
            "UPDATE job_order_units SET status = 'passed', stage = ?, identifier = ?, remarks = ?, location_id = ?, updated_at = datetime('now') WHERE id = ?",
            stage,
            identSql,
            remarks ?? u.remarks,
            unitLoc,
            u.id
          );
          run('UPDATE job_orders SET qty_done = qty_done + 1, updated_at = datetime(\'now\') WHERE id = ?', id);
        } else {
          run(
            "UPDATE job_order_units SET stage = ?, identifier = ?, remarks = ?, updated_at = datetime('now') WHERE id = ?",
            stage,
            identSql,
            remarks ?? u.remarks,
            u.id
          );
        }
      }
    }
    maybeComplete(id, req.user!.id);
    maybeCloseBatches(id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  // A passed unit's "DR Inventory / CR WIP" GL entry now posts at Products In, not here —
  // see POST /:id/products-in. settleJobOrderGl() no-ops on its own while this job order
  // still has receivable output (hasReceivable()).
  settleJobOrderGl(id, req.user!.id);
  res.json({ ok: true, job_order: loadJobOrder(id) });
});

// GET /api/job-orders/:id/receivable — what's ready for Products In on this job order:
// serialized units at status 'passed', and/or open non-serialized batches with an
// unreceived quantity remaining.
router.get('/:id/receivable', readGate, (req, res) => {
  const id = Number(req.params.id);
  const jo = queryOne<JobOrder>('SELECT * FROM job_orders WHERE id = ?', id);
  if (!jo) { res.status(404).json({ error: 'Job order not found' }); return; }
  const units = queryAll<JobOrderUnit & { location_name: string | null }>(
    `SELECT u.*, l.name AS location_name FROM job_order_units u
     LEFT JOIN locations l ON l.id = u.location_id
     WHERE u.job_order_id = ? AND u.status = 'passed' ORDER BY u.id`,
    id
  );
  const batches = queryAll<{ id: number; number: string; qty: number; received_qty: number; remaining_qty: number }>(
    `SELECT pb.id, pb.number, pb.qty,
            COALESCE((SELECT SUM(quantity) FROM production_receipt_items WHERE batch_id = pb.id), 0) AS received_qty,
            pb.qty - COALESCE((SELECT SUM(quantity) FROM production_receipt_items WHERE batch_id = pb.id), 0) AS remaining_qty
     FROM production_batches pb
     WHERE pb.job_order_id = ?
       AND NOT EXISTS (SELECT 1 FROM job_order_units u WHERE u.batch_id = pb.id)
     ORDER BY pb.id`,
    id
  ).filter((b) => b.remaining_qty > 0);
  res.json({ units, batches, output_location_id: jo.output_location_id });
});

// POST /api/job-orders/:id/products-in — "Products In": receive produced output into stock
// at a chosen location (the Purchasing Goods Receipt pattern mirrored for production).
router.post('/:id/products-in', receiveGate, (req, res) => {
  const id = Number(req.params.id);
  const jo = queryOne<JobOrder>('SELECT * FROM job_orders WHERE id = ?', id);
  if (!jo) { res.status(404).json({ error: 'Job order not found' }); return; }
  const input = parseBody(productsInSchema, req.body);
  if (!queryOne('SELECT id FROM locations WHERE id = ?', input.location_id)) {
    res.status(400).json({ error: 'That location does not exist' });
    return;
  }

  const unitIds = input.unit_ids ?? [];
  let units: JobOrderUnit[] = [];
  if (unitIds.length) {
    units = queryAll<JobOrderUnit>(
      `SELECT * FROM job_order_units WHERE job_order_id = ? AND id IN (${unitIds.map(() => '?').join(',')})`,
      id,
      ...unitIds
    );
    if (units.length !== unitIds.length) {
      res.status(400).json({ error: 'One or more units were not found on this job order' });
      return;
    }
    const notPassed = units.filter((u) => u.status !== 'passed');
    if (notPassed.length) {
      res.status(409).json({ error: 'Only units that passed final QC and are awaiting receipt can be received' });
      return;
    }
  }

  let batch: { id: number; qty: number; remaining_qty: number } | null = null;
  if (input.batch_id != null) {
    const b = queryOne<{ id: number; qty: number; job_order_id: number | null }>(
      'SELECT * FROM production_batches WHERE id = ?', input.batch_id
    );
    if (!b || b.job_order_id !== id) { res.status(400).json({ error: 'Batch not found on this job order' }); return; }
    const hasUnits = (queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM job_order_units WHERE batch_id = ?', b.id)?.n ?? 0) > 0;
    if (hasUnits) {
      // A serialized (QC-stage) batch — its units are received individually via unit_ids,
      // not as a bulk quantity against the batch.
      res.status(409).json({ error: 'This batch tracks individual serialized units — receive them by unit instead' });
      return;
    }
    const receivedSoFar = queryOne<{ n: number }>(
      'SELECT COALESCE(SUM(quantity), 0) AS n FROM production_receipt_items WHERE batch_id = ?', b.id
    )?.n ?? 0;
    const remaining = b.qty - receivedSoFar;
    const qty = input.quantity ?? 0;
    if (remaining <= 0) { res.status(409).json({ error: 'This batch has already been fully received' }); return; }
    if (qty > remaining) {
      res.status(400).json({ error: `Only ${remaining} of this batch remains to receive` });
      return;
    }
    batch = { id: b.id, qty: b.qty, remaining_qty: remaining };
  }

  const receivedQty = unitIds.length + (input.batch_id != null ? (input.quantity ?? 0) : 0);
  if (receivedQty <= 0) { res.status(400).json({ error: 'Nothing to receive' }); return; }

  db.exec('BEGIN');
  let receiptId: number;
  let receiptNumber: string;
  try {
    const number = (receiptNumber = nextSequence('production_receipt_seq', 'PI'));
    const info = run(
      `INSERT INTO production_receipts (number, job_order_id, location_id, received_date, notes, received_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      number, id, input.location_id, input.received_date ?? null, input.notes ?? null, req.user!.id
    );
    receiptId = Number(info.lastInsertRowid);
    const unitCost = componentCostFor(id).perUnitTotal;

    for (const u of units) {
      run(
        "UPDATE job_order_units SET status = 'in_stock', location_id = ?, updated_at = datetime('now') WHERE id = ?",
        input.location_id, u.id
      );
      run('INSERT INTO production_receipt_items (receipt_id, unit_id, quantity) VALUES (?, ?, 1)', receiptId, u.id);
      if (jo.product_item_id != null) {
        applyStockChange({
          itemId: jo.product_item_id, locationId: input.location_id, change: 1,
          // Prefix with the job order number — production.routes.ts GET /record's dossier
          // matches movements with `reason LIKE '${joNumber}%'`.
          reason: `${jo.number}: received (Products In ${number})`, userId: req.user!.id, unitCost,
        });
      }
    }
    if (batch && input.quantity) {
      run('INSERT INTO production_receipt_items (receipt_id, batch_id, quantity) VALUES (?, ?, ?)', receiptId, batch.id, input.quantity);
      if (jo.product_item_id != null) {
        applyStockChange({
          itemId: jo.product_item_id, locationId: input.location_id, change: input.quantity,
          reason: `${jo.number}: received (Products In ${number})`, userId: req.user!.id, unitCost,
        });
      }
      // Nothing to flip on the batch itself — its `status` is the separate, optional QA
      // sign-off flag (production.routes.ts); "received" is derived from qty vs. this table.
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  // GL: the material-only "DR Inventory / CR WIP" entry for what just posted to stock — the
  // same movement /progress and /units/inspect used to post inline (see their comments).
  postJobOrderMovement(id, jo.number, today(), 'produce', r2(receivedQty * componentCostFor(id).perUnit), req.user!.id);
  settleJobOrderGl(id, req.user!.id);   // clears now if this was the last thing this job order was waiting on
  res.status(201).json({ id: receiptId, number: receiptNumber });
});

// PUT /api/job-orders/:id/units/:unitId/identifier — set / clear a unit's identifier
router.put('/:id/units/:unitId/identifier', recordGate, (req, res) => {
  const id = Number(req.params.id);
  const unitId = Number(req.params.unitId);
  const unit = queryOne<JobOrderUnit>(
    'SELECT * FROM job_order_units WHERE id = ? AND job_order_id = ?',
    unitId,
    id
  );
  if (!unit) {
    res.status(404).json({ error: 'Unit not found' });
    return;
  }
  const { identifier } = parseBody(setUnitIdentifierSchema, req.body);
  run(
    "UPDATE job_order_units SET identifier = ?, updated_at = datetime('now') WHERE id = ?",
    identifier ?? null,
    unitId
  );
  res.json({ ok: true });
});

// Multer errors on the unit photo (file too large, wrong field) → 400
router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (err instanceof multer.MulterError) { res.status(400).json({ error: `Upload failed: ${err.message}` }); return; }
  next(err);
});

export default router;
