import { batchBalances, consumeSemiBatchUnit, receiveBatch, restoreBatchStock } from '../inventory/batch-stock';
/** Manufacturing job orders (Phase B). Build N units of a finished product by
    consuming its BOM. Lifecycle: draft (→ approved, a sign-off stamp, not a status) →
    released → in_progress → completed,
    with pause / cancel returning components that weren't consumed.
    QA/QC gating (qc_stages > 0) and serialized units come in Phase C. */
import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { createHash } from 'node:crypto';
import { db, queryOne, queryAll, run, nextSequence } from '../../shared/db';
import { requireAuth, requirePermission, requireAnyPermission } from '../../shared/auth';
import { JOB_ORDER_DETAIL, JOB_ORDER_LIST, LINE } from '../../shared/desk-access';
import {
  parseBody,
  createJobOrderSchema,
  convertSemiBuiltSchema,
  cancelSemiConversionSchema,
  updateJobOrderSchema,
  jobOrderComponentsSchema,
  jobOrderProgressSchema,
  acceptJobOrderSchema,
  approveJobOrderSchema,
  addUnitSchema,
  inspectUnitsSchema,
  setUnitIdentifierSchema,
  productsInSchema,
  jobOrderIdsSchema,
  prepareJobOrdersSchema,
  releaseJobOrderSchema,
  pauseJobOrderSchema,
  holdDecisionSchema,
} from '../../shared/validation';
import { isAppClient } from '../../shared/device';
import { notifyAnyPermission, notifyUser } from '../../shared/push';
import { imageUpload, saveAttachment, unlink } from '../../core/attachments.routes';
import { enforceQuota } from '../../platform/quota';
import { pickListHtml } from './parts-slip-print';
import { applyStockChange, stockAt, variantStockAt, getDefaultLocationId, locationName, overdrawAllowed } from '../inventory/inventory-stock';
import { postJobOrderMovement, jobOrderWipBalance } from '../accounting/accounting-autopost';
import { createDraftPurchaseOrders } from '../inventory/orders.routes';
import { checklistForProduct } from './qc.routes';
import { kitPickedAt, repairHeld } from './stock-holds';
import { locationError, unitBlockers } from './rts';
import { orderAvailability } from '../inventory/order-availability';
import type { JobOrder, JobOrderComponent, JobOrderUnit, InventoryItem, ProductionReceipt } from '../../shared/types';
import { recordSiteClash, syncClass } from '../../sync';
import { syncUpload } from '../../sync/files';
import { now, siteDecisionStands } from '../../shared/sync-context';

const router = Router();
router.use(requireAuth);

const readGate = requirePermission('production.view'); // the production screens' own permission (split from inventory.view)
// Desk-scoped reads (shared/desk-access.ts): the line sees its job orders; every production desk
// can open the one job order it is working on (its units, checklist, receivable output).
const listGate = requireAnyPermission(['production.view', ...JOB_ORDER_LIST]);
const detailGate = requireAnyPermission(['production.view', ...JOB_ORDER_DETAIL]);
const eventsGate = requireAnyPermission(['production.view', ...LINE]);
const writeGate = requirePermission('inventory.adjust');
/** A job order's decisions belong to the site of its source (parts) location; one without one is
 *  company-wide (the main site) — docs/OFFLINE-FIRST.md §16. */
const joSite = {
  home: (req: Request) => ({
    location: queryOne<{ source_location_id: number | null }>('SELECT source_location_id FROM job_orders WHERE id = ?', Number(req.params.id))?.source_location_id ?? null,
  }),
};
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
const conversionGate = requireAnyPermission(['production.approve', 'production.manage']);
const pauseGate = requireAnyPermission(['inventory.adjust', 'production.pause', 'production.manage']);
// Close early returns unused components but never releases or cancels — so a Production
// Manager (production.manage) may do it without the warehouse's broad inventory.adjust.
const closeEarlyGate = requireAnyPermission(['inventory.adjust', 'production.manage']);
// A unit QA held for review is decided by any QA inspector or someone granted production.qa_review
// (the Production Manager by default); inventory.adjust keeps its usual override.
const holdGate = requireAnyPermission(['inventory.adjust', 'production.inspect_qa', 'production.qa_review']);

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

// The action's own date under sync (an offline production record keeps its day) — §20.
const today = (): string => now().toISOString().slice(0, 10);
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
  const conversion = queryOne<{ source_cost: number; finishing_cost: number }>(
    'SELECT source_cost, finishing_cost FROM semi_build_conversions WHERE job_order_id = ?', joId);
  if (conversion) return {
    released: r2(conversion.source_cost), perUnit: r2(conversion.source_cost),
    perUnitTotal: r2(conversion.source_cost + conversion.finishing_cost), addons: r2(conversion.finishing_cost),
  };
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
  // Early close stops new output, but built units still need inspection/rework
  // before receiving. Their material value must remain in WIP until resolved.
  if (unresolvedCount(joId) > 0 || hasReceivable(joId)) return;
  const bal = jobOrderWipBalance(joId);
  if (Math.abs(bal) < 0.005) return;
  const scrap = r2((jo.qty_scrapped || 0) * componentCostFor(joId).perUnit);
  postJobOrderMovement(joId, jo.number, today(), 'settle', bal, userId, r2(bal - scrap));
}

function loadJobOrder(id: number): JobOrder | null {
  const jo = queryOne<JobOrder>(
    `SELECT j.*, sc.job_order_id AS conversion_job_order_id, sc.source_unit_id AS conversion_source_unit_id,
            sc.source_batch_id AS conversion_source_batch_id, cb.number AS conversion_source_batch_number,
            sc.source_cost AS conversion_source_cost,
            sc.finishing_cost AS conversion_finishing_cost, sc.cancel_reason AS conversion_cancel_reason,
            u.full_name AS created_by_name, rb.full_name AS released_by_name,
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
     LEFT JOIN semi_build_conversions sc ON sc.job_order_id = j.id
     LEFT JOIN production_batches cb ON cb.id = sc.source_batch_id
     LEFT JOIN parts_release_slips prs ON prs.job_order_id = j.id
     LEFT JOIN orders o ON o.id = j.order_id
     LEFT JOIN production_teams t ON t.id = j.team_id
     LEFT JOIN locations sl ON sl.id = j.source_location_id
     LEFT JOIN locations ol ON ol.id = j.output_location_id
     WHERE j.id = ?`,
    id
  );
  if (!jo) return null;
  if (jo.source_location_id) jo.source_location_name = locationName(jo.source_location_id);
  if (jo.output_location_id) jo.output_location_name = locationName(jo.output_location_id);
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
  const snapshot = (raw: string | null | undefined) => {
    try { return raw ? JSON.parse(raw) as NonNullable<JobOrder['qc_checklist_qc']> : null; } catch { return null; }
  };
  jo.qc_checklist_qc = jo.qc_stages > 0 ? (jo.qc_checklist_qc_snapshot ? snapshot(jo.qc_checklist_qc_snapshot) : checklistForProduct(jo.product_item_id, 1)) : null;
  jo.qc_checklist_qa = jo.qc_stages > 0 ? (jo.qc_checklist_qa_snapshot ? snapshot(jo.qc_checklist_qa_snapshot) : checklistForProduct(jo.product_item_id, 2)) : null;
  jo.approval_revision = createHash('sha256').update(JSON.stringify({
    product: [jo.product_item_id, jo.product_name], build: jo.build_mode, quantity: jo.qty_ordered,
    source: jo.source_location_id ?? getDefaultLocationId(), output: jo.output_location_id ?? getDefaultLocationId(),
    team: jo.team_id, order: jo.order_id, schedule: [jo.planned_start, jo.due_date, jo.priority, jo.work_center], notes: jo.notes,
    stages: jo.qc_stages, qc: jo.qc_checklist_qc, qa: jo.qc_checklist_qa,
    components: jo.components.map(c => [c.component_item_id, c.component_name, c.qty_per_unit, c.qty_planned]),
  })).digest('hex');
  return jo;
}

// Candidate packages for the manager's explicit CKD-vs-semi planning decision.
router.get('/convert-semi/options', conversionGate, (req, res) => {
  const productId = Number(req.query.product_item_id);
  const locationId = Number(req.query.location_id);
  if (!Number.isSafeInteger(productId) || !Number.isSafeInteger(locationId) || productId <= 0 || locationId <= 0) {
    res.status(400).json({ error: 'Choose a product and stock location.' }); return;
  }
  const units = queryAll<{ id: number; identifier: string | null }>(`SELECT u.id, u.identifier FROM job_order_units u
    JOIN job_orders j ON j.id = u.job_order_id WHERE u.product_item_id = ? AND j.build_mode = 'semi_built'
      AND u.status = 'in_stock' AND COALESCE(u.location_id, j.output_location_id) = ? ORDER BY u.id`, productId, locationId);
  const tracked = queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM job_order_units u JOIN job_orders j ON j.id = u.job_order_id
    WHERE u.product_item_id = ? AND j.build_mode = 'semi_built' AND u.status IN ('in_stock', 'reserved')
      AND COALESCE(u.location_id, j.output_location_id) = ?`, productId, locationId)?.n ?? 0;
  const onHand = variantStockAt(productId, locationId, 'semi_built');
  const batches = queryAll<{ id: number; number: string }>(`SELECT b.id, b.number FROM production_batches b
    JOIN job_orders j ON j.id=b.job_order_id WHERE COALESCE(b.product_item_id,j.product_item_id)=?
    AND j.build_mode='semi_built' ORDER BY b.id`, productId)
    .map((batch) => ({ ...batch, available: batchBalances(batch.id).find((row) => row.location_id === locationId)?.available ?? 0 }))
    .filter((batch) => batch.available >= 1);
  const lotOnHand = queryOne<{ n: number }>(`SELECT COALESCE(SUM(s.quantity),0) AS n FROM production_batch_stock s
    JOIN production_batches b ON b.id=s.batch_id JOIN job_orders j ON j.id=b.job_order_id
    WHERE COALESCE(b.product_item_id,j.product_item_id)=? AND j.build_mode='semi_built' AND s.location_id=?`, productId, locationId)?.n ?? 0;
  res.json({ units, batches, bulk_available: Math.max(0, onHand - tracked - lotOnHand), on_hand: onHand });
});

// Minimal production-facing demand list: managers can choose a supply path without
// gaining access to sales prices or customer details.
router.get('/convert-semi/demand', conversionGate, (_req, res) => {
  const sales = queryAll<{ id: number; number: string }>(`SELECT id, number FROM orders WHERE type = 'sale'
    AND fulfilled_at IS NULL AND LOWER(status) IN ('open', 'approved', 'released') ORDER BY id DESC LIMIT 200`);
  const demand = sales.flatMap((sale) => {
    const availability = orderAvailability(sale.id);
    return availability.lines.filter((line) => line.fulfillment_mode === 'assembled' && line.is_finished_product
      && line.semi_built_available >= 1 && line.shortfall > line.linked_job_orders.reduce((n, job) => n + job.remaining, 0))
      .map((line) => ({ order_id: sale.id, order_number: sale.number, product_item_id: line.item_id,
        product_name: line.name, location_id: availability.location_id, location_name: availability.location_name,
        uncovered: line.shortfall - line.linked_job_orders.reduce((n, job) => n + job.remaining, 0),
        semi_built_available: line.semi_built_available }));
  });
  res.json(demand);
});

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

/** Units not yet finally accounted for: awaiting first inspection ('pending'), sent back for
 *  repair ('rework') or held by QA for review ('hold'). A job order can't auto-complete while any exist. */
function unresolvedCount(joId: number): number {
  return queryOne<{ n: number }>(
    "SELECT COUNT(*) AS n FROM job_order_units WHERE job_order_id = ? AND status IN ('pending', 'rework', 'hold')",
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
router.get('/', listGate, (req, res) => {
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
    remaining: number; units_pending: number; units_rework: number; units_hold: number; units_passed: number;
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
              WHERE u.job_order_id = j.id AND u.status = 'hold') AS units_hold,
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
    held_elsewhere: number; free_for_list: number;
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
          on_hand: stockAt(c.component_item_id, loc),
          held_elsewhere: pickedElsewhere(c.component_item_id, loc, ids),
          free_for_list: 0, job_orders: [],
        };
        lines.set(key, l);
      }
      l.need += c.qty_planned;
      l.picked += c.qty_picked ?? 0;
      l.job_orders.push({ job_order_id: jo.id, number: jo.number, need: c.qty_planned, picked: c.qty_picked ?? 0 });
    }
  }
  for (const line of lines.values()) line.free_for_list = Math.max(0, line.on_hand - line.held_elsewhere);
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
router.get('/:id/events', eventsGate, (req, res) => {
  res.json(queryAll<{ id: number; action: string; reason: string | null; created_at: string; actor_name: string | null }>(
    `SELECT e.id, e.action, e.reason, e.created_at, u.full_name AS actor_name
     FROM job_order_events e LEFT JOIN users u ON u.id = e.actor_id
     WHERE e.job_order_id = ? ORDER BY e.id DESC`,
    Number(req.params.id)
  ));
});

router.get('/:id', detailGate, (req, res) => {
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
  buildMode?: 'assembled' | 'semi_built';
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
  db.exec('SAVEPOINT draft_job_order');
  let id: number;
  try {
    const number = nextSequence('mo_seq', 'MO');
    const info = run(
      `INSERT INTO job_orders
        (number, order_id, product_item_id, product_name, qty_ordered, status, build_mode,
         source_location_id, output_location_id, qc_stages,
         team_id, planned_start, due_date, priority, work_center, notes, created_by)
       VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      number, opts.orderId ?? null, opts.productId, opts.productName, opts.qty,
      opts.buildMode ?? 'assembled',
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
    db.exec('RELEASE draft_job_order');
  } catch (e) {
    db.exec('ROLLBACK TO draft_job_order'); db.exec('RELEASE draft_job_order');
    throw e;
  }
  return { id, number: loadJobOrder(id)!.number };
}

// A semi-built package is a whole unit with its remaining pieces inside. Finishing it
// is a build-state change, not another BOM build. The manager selects the actual
// package; production inspects it and Products In posts the finished variant.
router.post('/convert-semi', conversionGate, syncClass('physical'), syncUpload(imageUpload.single('image')), (req, res) => {
  const file = req.file;
  const fail = (status: number, error: string) => { unlink(file?.filename); res.status(status).json({ error }); };
  if (!file) { fail(400, 'Photograph the semi-built package before moving it into finishing.'); return; }
  let input: ReturnType<typeof convertSemiBuiltSchema.parse>;
  try { input = parseBody(convertSemiBuiltSchema, req.body); } catch (e) { unlink(file.filename); throw e; }
  const product = queryOne<InventoryItem>('SELECT * FROM inventory_items WHERE id = ?', input.product_item_id);
  if (!product?.is_finished_product) { fail(400, 'Choose a finished product.'); return; }
  for (const locationId of [input.source_location_id, input.output_location_id]) {
    if (!queryOne('SELECT id FROM locations WHERE id = ?', locationId)) {
      fail(400, 'Source or output location no longer exists.'); return;
    }
  }
  if (input.order_id) {
    const sale = queryOne<{ status: string; type: string; fulfilled_at: string | null }>('SELECT type, status, fulfilled_at FROM orders WHERE id = ?', input.order_id);
    if (!sale || sale.type !== 'sale' || sale.fulfilled_at || !['open', 'approved', 'released'].includes(String(sale.status).toLowerCase())) {
      fail(409, 'Choose an open, approved or released unfulfilled sale.'); return;
    }
    if (!queryOne(`SELECT id FROM order_items WHERE order_id = ? AND item_id = ? AND fulfillment_mode = 'assembled'`, input.order_id, product.id)) {
      fail(409, 'The sale needs a matching fully built line.'); return;
    }
  }
  const serial = input.source_unit_id == null ? null : queryOne<{ id: number; identifier: string | null; status: string; location_id: number | null; job_order_id: number; build_mode: string; received_unit_cost: number | null }>(
    `SELECT u.id, u.identifier, u.status, u.received_unit_cost, COALESCE(u.location_id, j.output_location_id) AS location_id,
            u.job_order_id, j.build_mode FROM job_order_units u JOIN job_orders j ON j.id = u.job_order_id
     WHERE u.id = ? AND u.product_item_id = ?`, input.source_unit_id, product.id);
  if (input.source_unit_id != null && (!serial || serial.status !== 'in_stock' || serial.build_mode !== 'semi_built' || serial.location_id !== input.source_location_id)) {
    fail(409, 'The selected semi-built unit is no longer in stock at this source location.'); return;
  }
  if (serial?.identifier && serial.identifier.trim() !== input.identifier.trim()) {
    fail(409, 'Keep the existing identifier for this physical unit.'); return;
  }
  if (!serial && queryOne(`SELECT 1 FROM job_order_units WHERE product_item_id = ? AND identifier = ?
      AND status IN ('pending', 'passed', 'in_stock', 'reserved', 'hold', 'rework')`, product.id, input.identifier)) {
    fail(409, 'This identifier already belongs to another active unit.'); return;
  }
  const onHand = variantStockAt(product.id, input.source_location_id, 'semi_built');
  const tracked = queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM job_order_units u JOIN job_orders j ON j.id = u.job_order_id
    WHERE u.product_item_id = ? AND j.build_mode = 'semi_built' AND u.status IN ('in_stock', 'reserved')
      AND COALESCE(u.location_id, j.output_location_id) = ?`, product.id, input.source_location_id)?.n ?? 0;
  const lotOnHand = queryOne<{ n: number }>(`SELECT COALESCE(SUM(s.quantity),0) AS n FROM production_batch_stock s
    JOIN production_batches b ON b.id=s.batch_id JOIN job_orders j ON j.id=b.job_order_id
    WHERE COALESCE(b.product_item_id,j.product_item_id)=? AND j.build_mode='semi_built' AND s.location_id=?`,
    product.id, input.source_location_id)?.n ?? 0;
  const selectedBatch = input.source_batch_id == null ? null : queryOne<{ id: number }>(`SELECT b.id FROM production_batches b
    JOIN job_orders j ON j.id=b.job_order_id WHERE b.id=? AND COALESCE(b.product_item_id,j.product_item_id)=?
    AND j.build_mode='semi_built'`, input.source_batch_id, product.id);
  if (input.source_batch_id != null && (!selectedBatch ||
    (batchBalances(input.source_batch_id).find((row) => row.location_id === input.source_location_id)?.available ?? 0) < 1)) {
    fail(409, 'This semi-built batch has no free unit at the source location. Rescan its QR and review stock.'); return;
  }
  const firmDemand = queryOne<{ n: number }>(`SELECT COALESCE(SUM(MAX(0, oi.quantity - oi.released_qty)), 0) AS n
    FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.item_id = ? AND oi.fulfillment_mode = 'semi_built'
      AND o.type = 'sale' AND o.fulfilled_at IS NULL AND LOWER(o.status) IN ('approved', 'released')
      AND COALESCE(o.location_id, ?) = ?`, product.id, getDefaultLocationId(), input.source_location_id)?.n ?? 0;
  if (onHand < 1 || (!serial && !selectedBatch && onHand - tracked - lotOnHand < 1) || onHand - firmDemand < 1) {
    fail(409, 'No uncommitted semi-built RTS unit is available at this location.'); return;
  }
  if (input.order_id) {
    const line = orderAvailability(input.order_id).lines.find((l) => l.item_id === product.id && l.fulfillment_mode === 'assembled');
    const planned = line?.linked_job_orders.reduce((n, j) => n + j.remaining, 0) ?? 0;
    if (!line || line.shortfall - planned < 1) {
      fail(409, 'This sale has no uncovered fully built shortage. Refresh its stock review.'); return;
    }
  }
  const cost = serial?.received_unit_cost ?? (Number(product.unit_cost) || (serial ? componentCostFor(serial.job_order_id).perUnitTotal : 0));
  try { enforceQuota('storage_mb'); } catch (e) { unlink(file.filename); throw e; }
  let jobId!: number;
  db.exec('BEGIN');
  try {
    const number = nextSequence('mo_seq', 'MO');
    jobId = Number(run(`INSERT INTO job_orders
      (number, order_id, product_item_id, product_name, qty_ordered, status, build_mode,
       source_location_id, output_location_id, qc_stages, notes, created_by, approved_by, approved_at,
       released_by, released_at, accepted_by, accepted_at, qc_checklist_qc_snapshot, qc_checklist_qa_snapshot)
      VALUES (?, ?, ?, ?, 1, 'released', 'assembled', ?, ?, 1, ?, ?, ?, datetime('now'),
              ?, datetime('now'), ?, datetime('now'), ?, ?)`,
      number, input.order_id ?? null, product.id, product.name, input.source_location_id, input.output_location_id,
      input.notes ?? 'Finish complete semi-built package', req.user!.id, req.user!.id, req.user!.id, req.user!.id,
      JSON.stringify(checklistForProduct(product.id, 1)), JSON.stringify(checklistForProduct(product.id, 2))).lastInsertRowid);
    run('INSERT INTO semi_build_conversions (job_order_id, source_unit_id, source_batch_id, source_cost, finishing_cost) VALUES (?, ?, ?, ?, ?)',
      jobId, serial?.id ?? null, selectedBatch?.id ?? null, cost, input.finishing_cost);
    if (selectedBatch) consumeSemiBatchUnit(selectedBatch.id, product.id, input.source_location_id);
    applyStockChange({ itemId: product.id, locationId: input.source_location_id, change: -1,
      buildMode: 'semi_built', batchHandled: !!selectedBatch,
      reason: `${number}: semi-built package released for finishing`, userId: req.user!.id });
    if (serial) run("UPDATE job_order_units SET status = 'converted', updated_at = datetime('now') WHERE id = ?", serial.id);
    const outputId = Number(run(`INSERT INTO job_order_units (job_order_id, product_item_id, identifier, status, stage, location_id, conversion_source_unit_id)
      VALUES (?, ?, ?, 'pending', 0, ?, ?)`, jobId, product.id, input.identifier.trim(), input.output_location_id, serial?.id ?? null).lastInsertRowid);
    saveAttachment('qc_unit', outputId, file.filename, 'Semi-built package at finishing intake', req.user!.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); unlink(file.filename); throw e; }
  postJobOrderMovement(jobId, queryOne<{ number: string }>('SELECT number FROM job_orders WHERE id = ?', jobId)!.number,
    today(), 'release', r2(cost), req.user!.id);
  res.status(201).json({ id: jobId, job_order: loadJobOrder(jobId) });
});

// POST /api/job-orders — create a draft; snapshots the product's BOM
router.post('/', writeGate, syncClass('merge'), (req, res) => {
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
  if (input.order_id) {
    const linked = queryOne<{ type: string }>('SELECT type FROM orders WHERE id = ?', input.order_id);
    if (!linked) { res.status(400).json({ error: 'Linked order not found' }); return; }
    if (linked.type === 'sale' && !queryOne(`SELECT 1 FROM order_items WHERE order_id = ? AND item_id = ?
      AND fulfillment_mode = ? LIMIT 1`, input.order_id, product.id, input.build_mode)) {
      res.status(409).json({ error: 'The sale has no matching fully built or semi-built line. Match the job order build state to the sale, or create an independent RTS buffer job.' });
      return;
    }
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
    buildMode: input.build_mode,
    orderId: input.order_id ?? null, sourceLocationId: sourceLoc, outputLocationId: outputLoc,
    qcStages: input.qc_stages, teamId: input.team_id ?? null, plannedStart: input.planned_start ?? null,
    dueDate: input.due_date ?? null, priority: input.priority ?? 0, workCenter: input.work_center ?? null,
    notes: input.notes ?? null, userId: req.user!.id,
  });
  res.status(201).json(created);
});

// PUT /api/job-orders/:id — edit a draft (recomputes planned qty if qty_ordered changed)
router.put('/:id', writeGate, syncClass('claim', joSite), (req, res) => {
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
router.put('/:id/schedule', writeGate, syncClass('claim', joSite), (req, res) => {
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
router.put('/:id/components', writeGate, syncClass('claim', joSite), (req, res) => {
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
  component_item_id: number; component_name: string; need: number; have: number;
  held_elsewhere: number; available: number; short: number; picked: number;
}> {
  const jo = loadJobOrder(joId);
  if (!jo) return [];
  const sourceLoc = jo.source_location_id ?? getDefaultLocationId();
  const out: Array<{ component_item_id: number; component_name: string; need: number; have: number;
    held_elsewhere: number; available: number; short: number; picked: number }> = [];
  for (const c of jo.components ?? []) {
    if (c.qty_planned <= 0 || c.component_item_id == null) continue;
    const have = stockAt(c.component_item_id, sourceLoc);
    const heldElsewhere = pickedElsewhere(c.component_item_id, sourceLoc, [joId]);
    const available = Math.max(0, have - heldElsewhere);
    out.push({
      component_item_id: c.component_item_id, component_name: c.component_name,
      need: c.qty_planned, have, held_elsewhere: heldElsewhere, available,
      short: Math.max(0, c.qty_planned - available), picked: c.qty_picked ?? 0,
    });
  }
  return out;
}

/** Outstanding linked procurement covers only planning demand; receipts must still put
 * physical stock at the job's source before its kit can be picked. */
function jobOrderPurchaseCoverage(joId: number, joNumber: string, shortfalls: ReturnType<typeof jobOrderComponentAvailability>) {
  const linked = queryAll<{ id: number; number: string; status: string; item_id: number; outstanding: number }>(
    `SELECT o.id, o.number, o.status, oi.item_id,
       MAX(0, SUM(oi.quantity) - COALESCE((SELECT SUM(gi.quantity) FROM goods_receipt_items gi
         JOIN goods_receipts gr ON gr.id = gi.receipt_id WHERE gr.order_id = o.id AND gi.item_id = oi.item_id), 0)) AS outstanding
     FROM orders o JOIN order_items oi ON oi.order_id = o.id
     WHERE o.type = 'purchase' AND LOWER(o.status) NOT IN ('cancelled', 'closed') AND oi.item_id IS NOT NULL
       AND (EXISTS (SELECT 1 FROM job_shortfall_purchases jp WHERE jp.job_order_id = ? AND jp.purchase_order_id = o.id)
         OR (o.notes = ? AND NOT EXISTS (SELECT 1 FROM job_shortfall_purchases jp WHERE jp.purchase_order_id = o.id)))
     GROUP BY o.id, oi.item_id ORDER BY o.id`,
    joId, `Components for ${joNumber}`
  ).filter((p) => p.outstanding > 0);
  const requirements = shortfalls.map((s) => {
    const pending = linked.filter((p) => p.item_id === s.component_item_id).reduce((n, p) => n + p.outstanding, 0);
    return { ...s, pending_purchase: pending, to_purchase: Math.max(0, Number((s.short - pending).toPrecision(15))) };
  });
  return { linked_purchase_orders: linked, purchase_requirements: requirements };
}

/** Sale-linked jobs share component demand with the sale's aggregate supply plan. */
function saleSupplyOwner(orderId: number | null | undefined) {
  if (!orderId) return null;
  return queryOne<{ id: number; number: string }>("SELECT id, number FROM orders WHERE id = ? AND type = 'sale'", orderId) ?? null;
}

/** Quantity of `itemId` already set aside at `locationId`: picked for other not-yet-released job
 *  orders' kits, or held for open repair-parts requests (stock-holds.ts) — so they can't both claim it. */
function pickedElsewhere(itemId: number, locationId: number, excludeJoIds: number[]): number {
  return kitPickedAt(itemId, locationId, excludeJoIds) + repairHeld(itemId, locationId);
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
router.post('/warehouse-accept', writeGate, syncClass('claim'), (req, res) => {
  const { job_order_ids } = parseBody(jobOrderIdsSchema, req.body);
  const ids = [...new Set(job_order_ids)];
  for (const id of ids) {
    const err = warehouseStepError(loadJobOrder(id), false);
    if (err) { res.status(err.status).json({ error: err.error, job_order_id: id }); return; }
  }
  db.exec('BEGIN');
  try {
    for (const id of ids) {
      run(
        `UPDATE job_orders SET warehouse_accepted_by = ?, warehouse_accepted_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ? AND warehouse_accepted_at IS NULL`,
        req.user!.id, id
      );
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.json({ ok: true, job_orders: ids.map((id) => loadJobOrder(id)) });
});

// POST /api/job-orders/prepare — the warehouse records what it picked for one or more accepted
// job orders (several kits can be picked in one go). A job order without `lines` is picked in
// full. A job order whose every line is fully picked is marked prepared (ready to release);
// a partial pick is saved but leaves it preparing. Picks are checked against on-hand stock
// minus what other unreleased kits already set aside. All-or-nothing.
router.post('/prepare', writeGate, syncClass('claim'), (req, res) => {
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
      const seen = new Set<number>();
      for (const l of req0.lines) {
        if (seen.has(l.component_item_id)) { res.status(400).json({ error: `Component #${l.component_item_id} is listed twice for ${jo!.number}` }); return; }
        seen.add(l.component_item_id);
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
  const shortText = short.map((s) => `${s.component_name}: picking ${s.picking}, available ${s.available}`).join('; ');
  // Clash-check (D6): the site picked when its records said the stock was there; by the time the
  // cloud re-runs it, stock may have been taken elsewhere. The site's pick stands — flagged.
  if (short.length && siteDecisionStands()) {
    recordSiteClash(req, `Parts were picked at the site, but by the time it synced the cloud had less stock — ${shortText}.`);
  } else if (short.length) {
    res.status(400).json({ error: 'Not enough stock to pick — ' + shortText, shortfalls: short });
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
router.get('/:id/availability', requireAnyPermission(['production.view', 'production.approve']), (req, res) => {
  const id = Number(req.params.id);
  const jo = loadJobOrder(id);
  if (!jo) { res.status(404).json({ error: 'Job order not found' }); return; }
  const lines = jobOrderComponentAvailability(id);
  const shortfalls = lines.filter((l) => l.short > 0);
  const supply_planning_order = saleSupplyOwner(jo.order_id);
  const purchasing = supply_planning_order
    ? { linked_purchase_orders: [], purchase_requirements: [] }
    : jobOrderPurchaseCoverage(id, jo.number, shortfalls);
  const approved = !!jo.approved_at;
  const warehouseAccepted = !!jo.warehouse_accepted_at;
  const prepared = !!jo.prepared_at;
  res.json({
    job_order_id: id,
    approval_revision: jo.approval_revision,
    status: jo.status,
    source_location_id: jo.source_location_id ?? getDefaultLocationId(),
    source_location_name: jo.source_location_name ?? null,
    lines,
    shortfalls,
    ...purchasing,
    supply_planning_order,
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
router.post('/:id/approve', approveGate, syncClass('claim', joSite), (req, res) => {
  const id = Number(req.params.id);
  const jo = loadJobOrder(id);
  if (!jo) { res.status(404).json({ error: 'Job order not found' }); return; }
  if (jo.status !== 'draft') {
    res.status(409).json({ error: `Only a draft job order can be approved (this one is ${jo.status})` });
    return;
  }
  const { notes, expected_revision } = parseBody(approveJobOrderSchema, req.body ?? {});
  if (expected_revision && expected_revision !== jo.approval_revision) {
    res.status(409).json({ code: 'stale_job_order', error: 'The draft plan changed. Refresh and review it before approving.', job_order: jo });
    return;
  }
  if (jo.approved_at) {
    // Clash-check (D6): approved elsewhere meanwhile — the site's approval stands (the first
    // approval is kept), flagged for an admin.
    if (siteDecisionStands()) {
      recordSiteClash(req, `Job order ${jo.number} was approved on the cloud and at the site; the first approval was kept.`);
      res.json({ ok: true, clash: true, job_order: loadJobOrder(id), shortfalls: jobOrderComponentShortfalls(id) });
      return;
    }
    res.status(409).json({ error: `Already approved by ${jo.approved_by_name ?? 'a manager'}` });
    return;
  }
  run(
    "UPDATE job_orders SET approved_by = ?, approved_at = datetime('now'), approve_notes = ?, updated_at = datetime('now') WHERE id = ?",
    req.user!.id, notes ?? null, id
  );
  res.json({ ok: true, job_order: loadJobOrder(id), shortfalls: jobOrderComponentShortfalls(id) });
});

// POST /api/job-orders/:id/unapprove — withdraw the approval of a not-yet-released draft.
router.post('/:id/unapprove', approveGate, syncClass('claim', joSite), (req, res) => {
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
router.post('/:id/purchase-shortfall', writeGate, syncClass('claim', joSite), (req, res) => {
  const id = Number(req.params.id);
  const jo = queryOne<JobOrder>('SELECT number, status, order_id FROM job_orders WHERE id = ?', id);
  if (!jo) { res.status(404).json({ error: 'Job order not found' }); return; }
  if (jo.status !== 'draft') { res.status(409).json({ error: 'Only a draft job order can plan component purchases.' }); return; }
  const supplyOrder = saleSupplyOwner(jo.order_id);
  if (supplyOrder) {
    res.status(409).json({ error: `Plan components from sale ${supplyOrder.number}'s stock review so its jobs share one purchase plan.`,
      code: 'sale_supply_owner', supply_planning_order: supplyOrder });
    return;
  }
  db.exec('BEGIN');
  try {
    const short = jobOrderComponentAvailability(id).filter((line) => line.short > 0);
    const coverage = jobOrderPurchaseCoverage(id, jo.number, short);
    const wants = coverage.purchase_requirements.filter((s) => s.to_purchase > 0)
      .map((s) => ({ item_id: s.component_item_id, quantity: s.to_purchase }));
    const created = createDraftPurchaseOrders(wants, `Components for ${jo.number}`, req.user!.id);
    for (const po of created) run('INSERT INTO job_shortfall_purchases (job_order_id, purchase_order_id) VALUES (?, ?)', id, po.id);
    db.exec('COMMIT');
    res.json({ created, shortfalls: short, ...jobOrderPurchaseCoverage(id, jo.number, short),
      note: !short.length ? 'All components are available for this kit.' : wants.length ? undefined : 'Existing purchase orders cover this shortage; receive them into the job source location.' });
  } catch (e) { db.exec('ROLLBACK'); throw e; }
});

// POST /api/job-orders/:id/release — issue the parts release slip for a prepared kit: the
// numbered record (PRS-#####) of what the warehouse handed to production, snapshotting the
// lines. Issuing it IS the release — planned components leave the source location here.
// Needs approval → warehouse acceptance → a fully picked kit. Photos of the kit attach
// afterwards as `attachments` kind 'parts_release' on the slip id.
router.post('/:id/release', writeGate, syncClass('physical'), (req, res) => {
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
  if (jo.qc_stages === 1) {
    const checks = [...(jo.qc_checklist_qc?.items ?? []), ...(jo.qc_checklist_qa?.items ?? [])];
    const labels = checks.map((item) => item.label.trim().toLocaleLowerCase());
    if (new Set(labels).size !== labels.length) {
      res.status(409).json({ error: 'QC and QA checklists contain the same check label. Give each check a distinct label before releasing this kit.', blocked: 'checklist' });
      return;
    }
  }
  const input = parseBody(releaseJobOrderSchema, req.body ?? {});
  const shortfalls = jobOrderComponentAvailability(id).filter((line) => line.short > 0);
  // Offline (D1): the kit physically left the warehouse — accepted, and any location that goes
  // below zero is flagged as a stock discrepancy by applyStockChange.
  if (shortfalls.length && !overdrawAllowed()) {
    res.status(400).json({
      error: `Not enough stock at ${jo.source_location_name ?? 'the source location'} — `
        + shortfalls.map((s) => `${s.component_name}: need ${s.need}, ${s.available} free (${s.have} on hand, ${s.held_elsewhere} held elsewhere)`).join('; '),
      blocked: 'components_unavailable',
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
      "UPDATE job_orders SET status = 'released', released_by = ?, released_at = datetime('now'), qc_checklist_qc_snapshot = ?, qc_checklist_qa_snapshot = ?, updated_at = datetime('now') WHERE id = ?",
      req.user!.id, JSON.stringify(jo.qc_checklist_qc), JSON.stringify(jo.qc_checklist_qa), id
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
router.post('/:id/accept', recordGate, syncClass('physical'), (req, res) => {
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
router.post('/:id/progress', recordGate, syncClass('physical'), (req, res) => {
  const id = Number(req.params.id);
  const jo = loadJobOrder(id);
  if (!jo) {
    res.status(404).json({ error: 'Job order not found' });
    return;
  }
  if (queryOne('SELECT 1 FROM semi_build_conversions WHERE job_order_id = ?', id)) {
    res.status(409).json({ error: 'This job finishes one existing semi-built unit. Inspect its linked unit, then record Products In.' }); return;
  }
  if (jo.status !== 'released' && jo.status !== 'in_progress') {
    res.status(409).json({ error: `Job order must be released before recording progress (it is ${jo.status})` });
    return;
  }
  if (needsAcceptance(jo)) {
    res.status(409).json({ error: ACCEPT_FIRST, needs_acceptance: true });
    return;
  }
  const { done_delta, scrapped_delta, batch_label, reason } = parseBody(jobOrderProgressSchema, req.body);
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
           VALUES (?, ?, 'scrapped', 0, ?, ?, ?)`,
          id,
          jo.product_item_id,
          outputLoc,
          batchId,
          reason ? `Scrapped on the line — ${reason}` : 'Scrapped on the line'
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
router.post('/:id/units', recordGate, syncClass('physical'), syncUpload(imageUpload.single('image')), (req, res) => {
  // The photo arrives with the unit (multipart field `image`), so a unit can't reach QC
  // without one. Any refusal below deletes the uploaded file again.
  const file = req.file;
  const fail = (status: number, body: Record<string, unknown>) => { unlink(file?.filename); res.status(status).json(body); };
  const id = Number(req.params.id);
  const jo = loadJobOrder(id);
  if (!jo) { fail(404, { error: 'Job order not found' }); return; }
  if (queryOne('SELECT 1 FROM semi_build_conversions WHERE job_order_id = ?', id)) {
    fail(409, { error: 'The original semi-built package already has a linked unit for inspection. Do not add another unit.' }); return;
  }
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
  try { enforceQuota('storage_mb'); } catch (e) { unlink(file.filename); throw e; }
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

/** When a job order is cancelled, tidy its loose ends: cancel any parts
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
     WHERE job_order_id = ? AND status IN ('pending', 'rework', 'hold')`,
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
         WHERE u.batch_id = production_batches.id AND u.status IN ('pending', 'rework', 'hold')
       )`,
    joId
  );
}

// POST /api/job-orders/:id/pause  &  /resume — no stock movement
// (inventory.adjust, or production.pause for a line lead trusted to hold the line — e.g. to
// switch to a higher-priority job order). The reason and who paused are kept until resume.
router.post('/:id/pause', pauseGate, syncClass('claim', joSite), (req, res) => {
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

router.post('/:id/resume', pauseGate, syncClass('claim', joSite), (req, res) => {
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
router.post('/:id/cancel', requireAnyPermission(['inventory.adjust', 'production.approve', 'production.manage']), syncClass('claim', joSite), (req, res) => {
  const id = Number(req.params.id);
  const jo = loadJobOrder(id);
  if (!jo) { res.status(404).json({ error: 'Job order not found' }); return; }
  if (!req.user!.permissions.includes('inventory.adjust') && !queryOne('SELECT 1 FROM semi_build_conversions WHERE job_order_id = ?', id)) {
    res.status(403).json({ error: 'Only warehouse inventory staff can cancel a parts-based job order.' }); return;
  }
  if (!OPEN_STATES.has(jo.status)) {
    res.status(409).json({ error: `Job order is already ${jo.status}` });
    return;
  }
  const conversion = queryOne<{ source_unit_id: number | null; source_batch_id: number | null; source_cost: number }>(
    'SELECT source_unit_id, source_batch_id, source_cost FROM semi_build_conversions WHERE job_order_id = ?', id);
  if (conversion) {
    const cancellation = parseBody(cancelSemiConversionSchema, req.body ?? {});
    const output = queryOne<{ id: number; status: string }>('SELECT id, status FROM job_order_units WHERE job_order_id = ?', id);
    if (!output || output.status !== 'pending' || queryOne('SELECT 1 FROM qc_records WHERE unit_id = ? LIMIT 1', output.id)) {
      res.status(409).json({ error: 'This package has entered inspection. Resolve its inspection or rework before closing it; it cannot go back to semi-built RTS automatically.' }); return;
    }
    db.exec('BEGIN');
    try {
      run("UPDATE job_order_units SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?", output.id);
      if (conversion.source_unit_id) run("UPDATE job_order_units SET status = 'in_stock', updated_at = datetime('now') WHERE id = ?", conversion.source_unit_id);
      applyStockChange({ itemId: jo.product_item_id!, locationId: jo.source_location_id!, change: 1,
        buildMode: 'semi_built', reason: `${jo.number}: finishing cancelled; complete package returned`,
        userId: req.user!.id, unitCost: conversion.source_cost });
      if (conversion.source_batch_id) restoreBatchStock(conversion.source_batch_id, jo.source_location_id!, 1);
      run("UPDATE semi_build_conversions SET cancel_reason = ?, cancelled_by = ?, cancelled_at = datetime('now') WHERE job_order_id = ?",
        cancellation.reason, req.user!.id, id);
      run("UPDATE job_orders SET status = 'cancelled', closed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?", id);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    settleJobOrderGl(id, req.user!.id);
    res.json({ ok: true, job_order: loadJobOrder(id) }); return;
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
router.post('/:id/close', closeEarlyGate, syncClass('claim', joSite), (req, res) => {
  const id = Number(req.params.id);
  const jo = loadJobOrder(id);
  if (!jo) { res.status(404).json({ error: 'Job order not found' }); return; }
  if (queryOne('SELECT 1 FROM semi_build_conversions WHERE job_order_id = ?', id)) {
    res.status(409).json({ error: 'Finish this one-unit conversion through inspection and Products In, or cancel it before inspection to return the package.' }); return;
  }
  if (!['released', 'in_progress', 'paused'].includes(jo.status)) {
    res.status(409).json({ error: `Cannot close a job order that is ${jo.status}` });
    return;
  }
  const why = reasonFor(req, 'close');
  if ('error' in why) { res.status(400).json({ error: why.error }); return; }
  db.exec('BEGIN');
  try {
    logLineEvent(id, 'close_early', why.reason, req.user!.id);
    // Preserve all built units and their open repair requests. Only cancellation
    // explicitly writes off unresolved output; closing early stops further builds.
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
router.delete('/:id', writeGate, syncClass('claim', joSite), (req, res) => {
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
router.get('/:id/units', detailGate, (req, res) => {
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
router.get('/:id/qc', detailGate, (req, res) => {
  const id = Number(req.params.id);
  if (!queryOne('SELECT id FROM job_orders WHERE id = ?', id)) {
    res.status(404).json({ error: 'Job order not found' });
    return;
  }
  const rows = queryAll<{ checklist: string | null }>(
    `SELECT q.*, u.full_name AS inspector_name, un.identifier AS unit_identifier,
            rd.category AS repair_category, rd.station AS repair_station, rd.priority AS repair_priority
     FROM qc_records q
     LEFT JOIN users u ON u.id = q.inspector_id
     LEFT JOIN job_order_units un ON un.id = q.unit_id
     LEFT JOIN qc_repair_details rd ON rd.qc_record_id = q.id
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
router.post('/:id/units/inspect', inspectDoorGate, syncClass('physical'), (req, res) => {
  const id = Number(req.params.id);
  const jo = loadJobOrder(id);
  if (!jo) {
    res.status(404).json({ error: 'Job order not found' });
    return;
  }
  const { unit_ids, result, remarks, identifier, checklist, disposition, repair, evidence_ids } = parseBody(inspectUnitsSchema, req.body);
  const units = queryAll<JobOrderUnit>(
    `SELECT * FROM job_order_units WHERE job_order_id = ? AND id IN (${unit_ids.map(() => '?').join(',')})`,
    id,
    ...unit_ids
  );
  if (units.length !== unit_ids.length) {
    res.status(400).json({ error: 'One or more units were not found on this job order' });
    return;
  }
  if (jo.conversion_job_order_id && identifier != null && units.some((u) => identifier !== u.identifier)) {
    res.status(409).json({ error: 'Inspection cannot change the identity of a unit finished from semi-built RTS.' }); return;
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
  const passStages = new Set(units.map((u) => u.stage + 1));
  if (passStages.size > 1) {
    res.status(400).json({ error: 'Inspect units from one QC/QA stage at a time.' });
    return;
  }

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
  {
    const activeItems = [
      ...(isFirstPass ? jo.qc_checklist_qc?.items ?? [] : []),
      ...(isFinalPass ? jo.qc_checklist_qa?.items ?? [] : []),
    ];
    const labels = new Set<string>();
    for (const item of activeItems) {
      const key = item.label.trim().toLocaleLowerCase();
      if (labels.has(key)) {
        res.status(409).json({ error: `Checklist label "${item.label}" appears more than once on this pass. Configure distinct labels before inspecting.`, blocked: 'checklist' });
        return;
      }
      labels.add(key);
    }
    const submitted = new Map<string, NonNullable<typeof checklist>[number]>();
    for (const item of checklist ?? []) {
      const key = item.label.trim().toLocaleLowerCase();
      if (submitted.has(key)) {
        res.status(400).json({ error: `Checklist answer "${item.label}" was submitted twice.` });
        return;
      }
      submitted.set(key, item);
    }
    if (result === 'pass') {
      // A required check needs an explicit pass. Measurements need a recorded reading.
      const missing = activeItems.filter((it) => it.required && !(submitted.get(it.label.trim().toLocaleLowerCase())?.status
        ? submitted.get(it.label.trim().toLocaleLowerCase())?.status === 'pass'
        : submitted.get(it.label.trim().toLocaleLowerCase())?.ok === true)).map((it) => it.label);
      if (missing.length) {
        res.status(400).json({ error: `Complete the required QC/QA checks before passing: ${missing.join(', ')}` });
        return;
      }
      const noReading = activeItems.filter((it) => {
        const answer = submitted.get(it.label.trim().toLocaleLowerCase());
        return it.measure && answer && (answer.status ? answer.status === 'pass' : answer.ok === true) && !answer.value?.trim();
      });
      if (noReading.length) {
        res.status(400).json({ error: `Record a reading for: ${noReading.map((it) => it.label).join(', ')}` });
        return;
      }
    }
  }
  const checklistJson = checklist && checklist.length ? JSON.stringify(checklist) : null;

  // A hold is QA's: only on the final pass, and only for a failing result.
  const hold = result === 'fail' && disposition === 'hold';
  if (hold && units.some((u) => u.stage + 1 < stages)) {
    res.status(400).json({ error: 'Only the final (QA) pass can hold a unit for review.' });
    return;
  }
  // Evidence (phone and desktop apps): every failing / held unit needs a photo of its own, uploaded by
  // this inspector and not already behind an earlier result.
  const evidence = new Map<number, number[]>();
  if (result === 'fail' && (evidence_ids ?? []).length) {
    for (const a of queryAll<{ id: number; unit_id: number }>(
      `SELECT a.id, CASE WHEN a.kind = 'qc_unit' THEN a.ref_id ELSE pi.unit_id END AS unit_id
       FROM attachments a LEFT JOIN production_issues pi ON a.kind = 'production_issue' AND pi.id = a.ref_id
       WHERE (a.kind = 'qc_unit' OR (a.kind = 'production_issue' AND pi.job_order_id = ? AND pi.unit_id IS NOT NULL))
         AND a.uploaded_by = ? AND a.id IN (${evidence_ids!.map(() => '?').join(',')})
         AND a.id NOT IN (SELECT attachment_id FROM qc_evidence)`, id, req.user!.id, ...evidence_ids!
    )) evidence.set(a.unit_id, [...(evidence.get(a.unit_id) ?? []), a.id]);
  }
  // Inspectors always need evidence, even when a direct API caller omits X-Client.
  // An inventory.adjust integration without an app header retains the existing
  // audited import/correction path; desktop and phone users still need photos.
  if (result === 'fail' && (isAppClient(req) || !req.user!.permissions.includes('inventory.adjust')) && units.some((u) => !evidence.has(u.id))) {
    res.status(409).json({ error: 'Attach at least one evidence photo of the unit before recording this result.', blocked: 'evidence' });
    return;
  }

  const holdRecords: Array<{ unit: JobOrderUnit; recordId: number }> = [];
  db.exec('BEGIN');
  try {
    for (const u of units) {
      const stage = u.stage + 1;
      if (hold) {
        // Held for review: the unit keeps its stage (the decision completes this pass).
        const rec = Number(run(
          `INSERT INTO qc_records (job_order_id, unit_id, stage, result, disposition, remarks, checklist, inspector_id)
           VALUES (?, ?, ?, 'hold', 'hold', ?, ?, ?)`,
          id, u.id, stage, remarks ?? null, checklistJson, req.user!.id
        ).lastInsertRowid);
        for (const a of evidence.get(u.id) ?? []) run('INSERT INTO qc_evidence (attachment_id, qc_record_id) VALUES (?, ?)', a, rec);
        run("UPDATE job_order_units SET status = 'hold', disposition = 'hold', remarks = ?, updated_at = datetime('now') WHERE id = ?",
          remarks ?? u.remarks, u.id);
        holdRecords.push({ unit: u, recordId: rec });
        continue;
      }
      const rec = run(
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
      for (const a of evidence.get(u.id) ?? []) run('INSERT INTO qc_evidence (attachment_id, qc_record_id) VALUES (?, ?)', a, Number(rec.lastInsertRowid));
      if (result === 'fail' && disposition === 'repair' && repair && (repair.category || repair.station || repair.priority)) {
        run('INSERT INTO qc_repair_details (qc_record_id, category, station, priority) VALUES (?, ?, ?, ?)',
          Number(rec.lastInsertRowid), repair.category ?? null, repair.station ?? null, repair.priority ?? null);
      }
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
  if (holdRecords.length) {
    const what = holdRecords.length === 1 ? (holdRecords[0]!.unit.identifier || `unit #${holdRecords[0]!.unit.id}`) : `${holdRecords.length} units`;
    void notifyAnyPermission(['production.inspect_qa', 'production.qa_review'], {
      title: `QA hold — ${what}`, body: `${jo.number}: ${remarks || 'held for review'}`,
      url: holdRecords.length === 1 ? `#/qc?role=qa&unit=${holdRecords[0]!.unit.id}&step=hold` : '#/qc?role=qa&tab=hold',
      link: { route: 'job-orders', params: { id } }, tag: `qa-hold-${id}`,
    }, req.user!.id);
  }
  res.json({ ok: true, job_order: loadJobOrder(id) });
});

// POST /api/job-orders/:id/units/:unitId/hold-decision — release a unit QA held for review:
// pass it (completes the final pass as-is), send it to rectification (rework, with the repair
// order) or fail it (scrap / dispose / recycle). Decided by any QA inspector or a
// production.qa_review holder, with a reason; the inspector who held it is pushed the outcome.
router.post('/:id/units/:unitId/hold-decision', holdGate, syncClass('physical'), (req, res) => {
  const id = Number(req.params.id);
  const jo = loadJobOrder(id);
  if (!jo) { res.status(404).json({ error: 'Job order not found' }); return; }
  const u = queryOne<JobOrderUnit>('SELECT * FROM job_order_units WHERE id = ? AND job_order_id = ?', Number(req.params.unitId), id);
  if (!u) { res.status(404).json({ error: 'Unit not found on this job order' }); return; }
  if (u.status !== 'hold') { res.status(409).json({ error: `This unit isn't on hold (it is ${u.status}).` }); return; }
  const { outcome, disposition, remarks, repair, checklist, expected_hold_record_id } = parseBody(holdDecisionSchema, req.body);
  const held = queryOne<{ id: number; inspector_id: number | null; checklist: string | null }>(
    "SELECT id, inspector_id, checklist FROM qc_records WHERE unit_id = ? AND result = 'hold' ORDER BY id DESC LIMIT 1", u.id
  );
  if (expected_hold_record_id && held?.id !== expected_hold_record_id) {
    res.status(409).json({ code: 'stale_hold', error: 'This unit has a different hold record. Refresh and review the current hold before deciding.' });
    return;
  }
  let heldChecklist: NonNullable<typeof checklist> = [];
  try { const parsed = held?.checklist ? JSON.parse(held.checklist) : []; heldChecklist = Array.isArray(parsed) ? parsed : []; }
  catch { /* corrupt historical answer cannot satisfy a pass */ }
  const decisionChecklist = checklist ?? heldChecklist;
  if (outcome === 'pass') {
    const required = [
      ...(jo.qc_stages <= 1 ? jo.qc_checklist_qc?.items ?? [] : []),
      ...(jo.qc_checklist_qa?.items ?? []),
    ];
    const labels = new Set<string>();
    for (const item of required) {
      const key = item.label.trim().toLocaleLowerCase();
      if (labels.has(key)) { res.status(409).json({ error: `Checklist label "${item.label}" appears more than once on this pass.`, blocked: 'checklist' }); return; }
      labels.add(key);
    }
    const answers = new Map<string, (typeof decisionChecklist)[number]>();
    for (const answer of decisionChecklist) {
      const key = answer.label.trim().toLocaleLowerCase();
      if (answers.has(key)) { res.status(400).json({ error: `Checklist answer "${answer.label}" was submitted twice.` }); return; }
      answers.set(key, answer);
    }
    const missing = required.filter((item) => item.required && !(answers.get(item.label.trim().toLocaleLowerCase())?.status
      ? answers.get(item.label.trim().toLocaleLowerCase())?.status === 'pass'
      : answers.get(item.label.trim().toLocaleLowerCase())?.ok === true)).map((item) => item.label);
    if (missing.length) { res.status(400).json({ error: `Complete the required QA checks before passing: ${missing.join(', ')}`, blocked: 'checklist' }); return; }
    const noReading = required.filter((item) => {
      const answer = answers.get(item.label.trim().toLocaleLowerCase());
      return item.measure && answer && (answer.status ? answer.status === 'pass' : answer.ok === true) && !answer.value?.trim();
    }).map((item) => item.label);
    if (noReading.length) { res.status(400).json({ error: `Record a reading for: ${noReading.join(', ')}`, blocked: 'checklist' }); return; }
  }
  const stage = u.stage + 1;
  const note = `Hold decision: ${remarks}`;
  db.exec('BEGIN');
  try {
    const rec = Number(run(
      `INSERT INTO qc_records (job_order_id, unit_id, stage, result, disposition, remarks, checklist, inspector_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id, u.id, stage, outcome === 'pass' ? 'pass' : 'fail',
      outcome === 'pass' ? null : outcome === 'rectify' ? 'repair' : (disposition ?? 'scrap'),
      note, outcome === 'pass' && checklist ? JSON.stringify(decisionChecklist) : held?.checklist ?? null, req.user!.id
    ).lastInsertRowid);
    if (outcome === 'pass') {
      run(
        "UPDATE job_order_units SET status = 'passed', stage = ?, disposition = NULL, remarks = ?, location_id = COALESCE(location_id, ?), updated_at = datetime('now') WHERE id = ?",
        stage, note, jo.output_location_id ?? getDefaultLocationId(), u.id
      );
      run("UPDATE job_orders SET qty_done = qty_done + 1, updated_at = datetime('now') WHERE id = ?", id);
    } else if (outcome === 'rectify') {
      if (repair && (repair.category || repair.station || repair.priority)) {
        run('INSERT INTO qc_repair_details (qc_record_id, category, station, priority) VALUES (?, ?, ?, ?)',
          rec, repair.category ?? null, repair.station ?? null, repair.priority ?? null);
      }
      run("UPDATE job_order_units SET status = 'rework', disposition = 'repair', remarks = ?, updated_at = datetime('now') WHERE id = ?", note, u.id);
    } else {
      run("UPDATE job_order_units SET status = 'failed', disposition = ?, stage = ?, remarks = ?, updated_at = datetime('now') WHERE id = ?",
        disposition ?? 'scrap', stage, note, u.id);
      run("UPDATE job_orders SET qty_scrapped = qty_scrapped + 1, updated_at = datetime('now') WHERE id = ?", id);
    }
    maybeComplete(id, req.user!.id);
    maybeCloseBatches(id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  settleJobOrderGl(id, req.user!.id);
  if (held?.inspector_id && held.inspector_id !== req.user!.id) {
    void notifyUser(held.inspector_id, {
      title: `QA hold decided — ${u.identifier || 'unit #' + u.id}`,
      body: `${outcome === 'pass' ? 'Passed' : outcome === 'rectify' ? 'Sent to rectification' : 'Failed'}: ${remarks}`,
      url: `#/record?unit=${u.id}`, link: { route: 'job-orders', params: { id } }, tag: `qa-hold-${u.id}`,
    });
  }
  res.json({ ok: true, job_order: loadJobOrder(id) });
});

// GET /api/job-orders/:id/receivable — what's ready for Products In on this job order:
// serialized units at status 'passed', and/or open non-serialized batches with an
// unreceived quantity remaining.
router.get('/:id/receivable', detailGate, (req, res) => {
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
router.post('/:id/products-in', receiveGate, syncClass('physical'), (req, res) => {
  const id = Number(req.params.id);
  const jo = queryOne<JobOrder>('SELECT * FROM job_orders WHERE id = ?', id);
  if (!jo) { res.status(404).json({ error: 'Job order not found' }); return; }
  const input = parseBody(productsInSchema, req.body);
  // Ready-to-sell storage only (rts.ts): a missing or transit (truck) location, or one without
  // room for what is coming in, is refused.
  const batchLines = input.batches ?? (input.batch_id == null ? [] : [{ batch_id: input.batch_id, quantity: input.quantity! }]);
  const receivedQty = (input.unit_ids ?? []).length + batchLines.reduce((sum, line) => sum + line.quantity, 0);
  const locErr = locationError(input.location_id, receivedQty);
  if (locErr) {
    res.status(400).json({ error: locErr, location_error: true });
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
    // Duplicate / hold protection (rts.ts): already in finished goods, a serial that's already
    // in stock on another record, or an open product-data mismatch — nothing posts.
    const blockers = unitBlockers(unitIds);
    if (notPassed.length || blockers.length) {
      res.status(409).json({
        error: notPassed.length ? 'Only units that passed final QC and are awaiting receipt can be received' : blockers[0]!.message,
        blockers,
      });
      return;
    }
  }

  for (const line of batchLines) {
    const b = queryOne<{ id: number; qty: number; job_order_id: number | null }>(
      'SELECT * FROM production_batches WHERE id = ?', line.batch_id
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
    if (remaining <= 0) { res.status(409).json({ error: 'This batch has already been fully received' }); return; }
    if (line.quantity > remaining) {
      res.status(400).json({ error: `Only ${remaining} of this batch remains to receive` });
      return;
    }
  }

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
        "UPDATE job_order_units SET status = 'in_stock', location_id = ?, received_unit_cost = ?, updated_at = datetime('now') WHERE id = ?",
        input.location_id, unitCost, u.id
      );
      run('INSERT INTO production_receipt_items (receipt_id, unit_id, quantity) VALUES (?, ?, 1)', receiptId, u.id);
      if (jo.product_item_id != null) {
        applyStockChange({
          itemId: jo.product_item_id, locationId: input.location_id, change: 1,
          buildMode: jo.build_mode,
          // Prefix with the job order number — production.routes.ts GET /record's dossier
          // matches movements with `reason LIKE '${joNumber}%'`.
          reason: `${jo.number}: received (Products In ${number})`, userId: req.user!.id, unitCost,
        });
      }
    }
    for (const line of batchLines) {
      run('INSERT INTO production_receipt_items (receipt_id, batch_id, quantity) VALUES (?, ?, ?)', receiptId, line.batch_id, line.quantity);
      if (jo.product_item_id != null) {
        applyStockChange({
          itemId: jo.product_item_id, locationId: input.location_id, change: line.quantity,
          buildMode: jo.build_mode,
          reason: `${jo.number}: received (Products In ${number})`, userId: req.user!.id, unitCost,
        });
      }
      receiveBatch(line.batch_id, input.location_id, line.quantity);
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
router.put('/:id/units/:unitId/identifier', recordGate, syncClass('claim', joSite), (req, res) => {
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
  if (queryOne('SELECT 1 FROM semi_build_conversions WHERE job_order_id = ?', id)) {
    res.status(409).json({ error: 'A finished semi-built package keeps its original physical identifier. Correct the source record with a supervisor before conversion.' }); return;
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
