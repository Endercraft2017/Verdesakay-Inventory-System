/** Job & Sale Orders: stored records with line items, auto numbers, server-computed
    totals. One router serves both types (?type=sale|job). */
import { Router, type Request } from 'express';
import { db, queryOne, queryAll, run, nextSequence } from '../../shared/db';
import { requireAuth, requirePermission, requireAnyPermission } from '../../shared/auth';
import {
  parseBody, createOrderSchema, updateOrderSchema, orderStatusSchema,
  releaseOrderSchema, unreserveOrderSchema, releaseSlipSchema,
} from '../../shared/validation';
import { getQboStatus, pushOrder } from '../quickbooks/quickbooks';
import { maybeAutoPostSale, maybeFulfillSale, unpostSource } from '../accounting/accounting-autopost';
import { getDefaultLocationId } from './inventory-stock';
import { createDraftJobOrder } from '../manufacturing/job-orders.routes';
import type { Order, OrderItem, OrderType } from '../../shared/types';
import { recordSiteClash, syncClass } from '../../sync';
import { siteDecisionStands } from '../../shared/sync-context';

const router = Router();
router.use(requireAuth);

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// Narrow releasing_clerk role (src/shared/permissions.ts) — a mobile-only account scoped
// to just scanning/entering goods out against an approved sale order, without the broad
// inventory.adjust the 'releasing'/'warehouse'/'admin'/'admin_staff' roles use for this
// same action (those roles already satisfy this via inventory.adjust, unaffected).
const releaseGate = requireAnyPermission(['inventory.adjust', 'orders.release']);

/** An order's decisions belong to the site of its stock location; one without one (every purchase
 *  order, a sale order with no location) is company-wide: the main site's (docs/OFFLINE-FIRST.md §16). */
const orderSite = {
  home: (req: Request) => ({
    location: queryOne<{ location_id: number | null }>('SELECT location_id FROM orders WHERE id = ?', Number(req.params.id))?.location_id ?? null,
  }),
};

/** Clash-check (D6) for the availability gate: the site approved its own order with enough stock
 *  in its view; if the cloud's stock is short by now, the approval stands and is flagged. */
function shortageStands(req: Request, number: string, shortLines: number): boolean {
  if (!siteDecisionStands()) return false;
  recordSiteClash(req, `Sale order ${number} was approved at the site, but the cloud's stock is now short on ${shortLines} line(s).`);
  return true;
}

/** Best-effort background push after a save when the tenant has QuickBooks auto-push on.
    Never blocks the response; failures are logged only. */
function maybeAutoPush(orderId: number): void {
  try {
    if (!getQboStatus().auto_push || !getQboStatus().connected) return;
  } catch { return; }
  const order = queryOne<Order>('SELECT * FROM orders WHERE id = ?', orderId);
  if (!order) return;
  const items = queryAll<OrderItem>('SELECT * FROM order_items WHERE order_id = ? ORDER BY sort, id', orderId);
  Promise.resolve(pushOrder(order, items)).catch((e) =>
    console.warn(`[qbo] auto-push order ${orderId} failed: ${(e as Error).message}`));
}

type LineInput = {
  item_id?: number | null; name: string; sku?: string | null; description?: string | null;
  quantity: number; unit?: string | null; unit_price: number; tax_code_id?: number | null;
};

/** Compute line totals + subtotal/tax/total from raw line inputs (never trust the client). */
function computeTotals(items: LineInput[], taxPercent: number) {
  const lines = items.map((it) => ({ ...it, line_total: round2((it.quantity || 0) * (it.unit_price || 0)) }));
  const subtotal = round2(lines.reduce((s, l) => s + l.line_total, 0));
  const tax_amount = round2((subtotal * (taxPercent || 0)) / 100);
  const total = round2(subtotal + tax_amount);
  return { lines, subtotal, tax_amount, total };
}

/** Resolve the customer link for a sale order — pull name/contact from the customers row
 *  when a `customer_id` is given and the caller didn't type its own. Non-sale orders never
 *  carry a customer_id. */
function resolveCustomer(
  type: OrderType,
  input: { customer_id?: number | null; customer_name?: string | null; customer_contact?: string | null }
): { customer_id: number | null; customer_name: string | null; customer_contact: string | null } {
  if (type !== 'sale' || input.customer_id == null) {
    return {
      customer_id: null,
      customer_name: input.customer_name ?? null,
      customer_contact: input.customer_contact ?? null,
    };
  }
  const c = queryOne<{ name: string; contact_person: string | null; phone: string | null }>(
    'SELECT name, contact_person, phone FROM customers WHERE id = ?', input.customer_id
  );
  return {
    customer_id: c ? input.customer_id : null,
    customer_name: input.customer_name ?? c?.name ?? null,
    customer_contact: input.customer_contact ?? c?.contact_person ?? c?.phone ?? null,
  };
}

/** Next order number for a type, e.g. SO-00001 / JO-00001 / PR-00001 (counter in settings). */
function nextOrderNumber(type: OrderType): string {
  const prefix = type === 'sale' ? 'SO' : type === 'job' ? 'JO' : 'PR';
  return nextSequence(`order_seq_${type}`, prefix);
}

function insertItems(orderId: number, lines: ReturnType<typeof computeTotals>['lines']): void {
  lines.forEach((l, i) => {
    run(
      `INSERT INTO order_items
        (order_id, item_id, name, sku, description, quantity, unit, unit_price, line_total, tax_code_id, sort)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      orderId,
      l.item_id ?? null,
      l.name,
      l.sku ?? null,
      l.description ?? null,
      l.quantity,
      l.unit ?? null,
      l.unit_price,
      l.line_total,
      l.tax_code_id ?? null,
      i
    );
  });
}

// A firm-ish sale order (approved/released, not fulfilled) with at least one line whose
// ordered quantity isn't yet covered by released_qty + its reserved/sold serialized units.
const BACKORDER_SQL = `
  o.type = 'sale' AND o.fulfilled_at IS NULL AND LOWER(o.status) IN ('approved', 'released')
  AND EXISTS (
    SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND oi.item_id IS NOT NULL
      AND oi.quantity > COALESCE(oi.released_qty, 0)
        + (SELECT COUNT(*) FROM job_order_units ju
            WHERE ju.order_id = o.id AND ju.product_item_id = oi.item_id AND ju.status IN ('reserved', 'sold'))
  )`;

// GET /api/orders?type=&q=&backorder=1
router.get('/', (req, res) => {
  const { type, q } = req.query;
  const where: string[] = [];
  const params: unknown[] = [];
  if (type === 'sale' || type === 'job' || type === 'purchase') { where.push('o.type = ?'); params.push(type); }
  if (typeof q === 'string' && q.trim()) {
    where.push('(o.number LIKE ? OR o.customer_name LIKE ?)');
    const like = `%${q.trim()}%`;
    params.push(like, like);
  }
  if (req.query.backorder === '1' || req.query.backorder === 'true') where.push(`(${BACKORDER_SQL})`);
  const rows = queryAll<Order>(
    `SELECT o.*, u.full_name AS created_by_name, s.name AS supplier_name,
            jo.id AS job_order_id, jo.number AS job_order_number, jo.status AS job_order_status,
            (${BACKORDER_SQL}) AS backordered
     FROM orders o
     LEFT JOIN users u ON u.id = o.created_by
     LEFT JOIN suppliers s ON s.id = o.supplier_id
     LEFT JOIN job_orders jo ON jo.id = (SELECT id FROM job_orders WHERE order_id = o.id ORDER BY id DESC LIMIT 1)
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY o.id DESC`,
    ...params
  );
  res.json(rows);
});

// GET /api/orders/:id — order + line items
router.get('/:id', (req, res) => {
  const order = queryOne<Order>(
    `SELECT o.*, u.full_name AS created_by_name, s.name AS supplier_name,
            jo.id AS job_order_id, jo.number AS job_order_number, jo.status AS job_order_status,
            wa.full_name AS warehouse_accepted_by_name,
            rs.id AS release_slip_id, rs.number AS release_slip_number
     FROM orders o
     LEFT JOIN users u ON u.id = o.created_by
     LEFT JOIN suppliers s ON s.id = o.supplier_id
     LEFT JOIN job_orders jo ON jo.id = (SELECT id FROM job_orders WHERE order_id = o.id ORDER BY id DESC LIMIT 1)
     LEFT JOIN users wa ON wa.id = o.warehouse_accepted_by
     LEFT JOIN release_slips rs ON rs.order_id = o.id
     WHERE o.id = ?`,
    Number(req.params.id)
  );
  if (!order) {
    res.status(404).json({ error: 'Order not found' });
    return;
  }
  order.items = queryAll<OrderItem>(
    `SELECT oi.*,
            (SELECT COUNT(*) FROM job_order_units ju
              WHERE ju.order_id = ? AND ju.product_item_id = oi.item_id AND ju.status = 'sold') AS allocated_qty,
            (SELECT COUNT(*) FROM job_order_units ju
              WHERE ju.order_id = ? AND ju.product_item_id = oi.item_id AND ju.status = 'reserved') AS reserved_qty
     FROM order_items oi WHERE oi.order_id = ? ORDER BY oi.sort, oi.id`,
    order.id,
    order.id,
    order.id
  );
  res.json(order);
});

/* ---------------------------------------------------- sale-order release / pick --- */

const RELEASE_STATES = new Set(['approved', 'released']);

/** For one line: units of this product `reserved`/`sold` against this order + the line's
 *  own `released_qty` (bulk). "Covered" once that reaches the ordered quantity. */
function lineCoverage(orderId: number, line: Pick<OrderItem, 'id' | 'item_id' | 'quantity' | 'released_qty'>): {
  units: number; bulk: number; covered: boolean;
} {
  const units = line.item_id
    ? queryOne<{ n: number }>(
        `SELECT COUNT(*) AS n FROM job_order_units
         WHERE order_id = ? AND product_item_id = ? AND status IN ('reserved', 'sold')`,
        orderId, line.item_id
      )?.n ?? 0
    : 0;
  const bulk = line.released_qty || 0;
  return { units, bulk, covered: units + bulk >= line.quantity };
}

function orderWithLines(id: number): Order | null {
  const order = queryOne<Order>('SELECT * FROM orders WHERE id = ?', id);
  if (!order) return null;
  order.items = queryAll<OrderItem>(
    `SELECT oi.*,
            (SELECT COUNT(*) FROM job_order_units ju WHERE ju.order_id = ? AND ju.product_item_id = oi.item_id AND ju.status = 'sold') AS allocated_qty,
            (SELECT COUNT(*) FROM job_order_units ju WHERE ju.order_id = ? AND ju.product_item_id = oi.item_id AND ju.status = 'reserved') AS reserved_qty
     FROM order_items oi WHERE oi.order_id = ? ORDER BY oi.sort, oi.id`,
    id, id, id
  );
  return order;
}

/* --------------------------------------------- sale-order stock availability (ATP) --- */

interface LineAvailability {
  order_item_id: number;
  item_id: number | null;
  name: string;
  ordered: number;
  on_hand: number;
  /** Reserved to other sale orders + bulk released_qty committed on other open sale orders. */
  committed_elsewhere: number;
  /** Already reserved / sold / bulk-released against THIS order. */
  covered_here: number;
  /** What this order can still draw on: free stock + its own reservations. */
  available: number;
  shortfall: number;
  is_finished_product: boolean;
  has_bom: boolean;
  /** Finished products with a BOM: can the shortfall be built from components on hand now? */
  buildable: boolean;
  component_shortfalls: { component_item_id: number; name: string; need: number; have: number }[];
  linked_job_orders: { id: number; number: string; status: string; remaining: number }[];
}

/** Per-line stock picture for a sale order — what's on hand, what's committed elsewhere,
 *  what this order still needs, and (for finished products) whether the shortfall can be
 *  built right now. Free-text lines are skipped (nothing to gate). */
export function orderAvailability(orderId: number): {
  ok: boolean; short_lines: number; lines: LineAvailability[];
} {
  const items = queryAll<OrderItem>('SELECT * FROM order_items WHERE order_id = ?', orderId);
  const lines: LineAvailability[] = [];
  for (const oi of items) {
    if (oi.item_id == null) continue;
    const inv = queryOne<{ quantity: number; is_finished_product: number }>(
      'SELECT quantity, is_finished_product FROM inventory_items WHERE id = ?', oi.item_id
    );
    if (!inv) continue;

    const reservedAll = queryOne<{ n: number }>(
      "SELECT COUNT(*) AS n FROM job_order_units WHERE product_item_id = ? AND status = 'reserved'", oi.item_id
    )?.n ?? 0;
    // Units this order can still draw on = its own `reserved` (still on hand). A `sold`
    // unit has already left stock and is baked into `on_hand`, so it isn't added back.
    const coveredUnits = queryOne<{ n: number }>(
      "SELECT COUNT(*) AS n FROM job_order_units WHERE product_item_id = ? AND order_id = ? AND status = 'reserved'",
      oi.item_id, orderId
    )?.n ?? 0;
    // Demand from OTHER firm-ish (approved/released, not-yet-fulfilled) sale orders on
    // this same product: the qty they've physically pulled (released_qty, still sitting in
    // on_hand) + the remainder of their line they haven't reserved/pulled yet (a claim on
    // free stock). This is what makes the gate hold across two orders raised close together.
    const others = queryOne<{ released: number; committed: number }>(
      `SELECT COALESCE(SUM(x.released_qty), 0) AS released,
              COALESCE(SUM(MAX(0,
                x.quantity - x.released_qty -
                (SELECT COUNT(*) FROM job_order_units ju
                  WHERE ju.order_id = x.order_id AND ju.product_item_id = x.item_id
                    AND ju.status IN ('reserved', 'sold'))
              )), 0) AS committed
       FROM order_items x JOIN orders o ON o.id = x.order_id
       WHERE x.item_id = ? AND x.order_id != ? AND o.type = 'sale'
         AND o.fulfilled_at IS NULL AND LOWER(o.status) IN ('approved', 'released')`,
      oi.item_id, orderId
    );
    const othersReleased = others?.released ?? 0;
    const othersCommitted = others?.committed ?? 0;

    const on_hand = inv.quantity;
    const committed_elsewhere = Math.max(0, reservedAll - coveredUnits) + othersReleased + othersCommitted;
    // Free = on hand, minus every reserved unit, minus what other orders have pulled, minus
    // their un-pulled promises. This order's own reserved units + bulk pulls are still in
    // `free` (not subtracted), so `available` adds only its reserved units back explicitly.
    const free = Math.max(0, on_hand - reservedAll - othersReleased - othersCommitted);
    const covered_here = coveredUnits + (oi.released_qty || 0);
    const available = free + coveredUnits;
    const shortfall = Math.max(0, oi.quantity - available);

    const bom = inv.is_finished_product
      ? queryAll<{ component_item_id: number; name: string; per: number; have: number }>(
          `SELECT b.component_item_id, i.name, b.quantity AS per, i.quantity AS have
           FROM bom_components b JOIN inventory_items i ON i.id = b.component_item_id
           WHERE b.product_item_id = ?`, oi.item_id
        )
      : [];
    const component_shortfalls = shortfall > 0
      ? bom.filter((c) => c.have < c.per * shortfall)
           .map((c) => ({ component_item_id: c.component_item_id, name: c.name, need: c.per * shortfall, have: c.have }))
      : [];
    const linked_job_orders = queryAll<{ id: number; number: string; status: string; remaining: number }>(
      `SELECT id, number, status, (qty_ordered - qty_done - qty_scrapped) AS remaining
       FROM job_orders WHERE order_id = ? AND product_item_id = ? AND status NOT IN ('completed', 'cancelled')`,
      orderId, oi.item_id
    );

    lines.push({
      order_item_id: oi.id, item_id: oi.item_id, name: oi.name, ordered: oi.quantity,
      on_hand, committed_elsewhere, covered_here, available, shortfall,
      is_finished_product: !!inv.is_finished_product, has_bom: bom.length > 0,
      buildable: shortfall > 0 && bom.length > 0 && component_shortfalls.length === 0,
      component_shortfalls, linked_job_orders,
    });
  }
  return { ok: lines.every((l) => l.shortfall <= 0), short_lines: lines.filter((l) => l.shortfall > 0).length, lines };
}

/** Raise one draft purchase order per supplier for a list of items to buy. `item_id` is
 *  required on every entry (it's how they group by supplier). Unit price defaults to the
 *  item's standard cost. Shared by the sale-order and job-order "buy the shortfall"
 *  actions and the reorder-level PO. */
export function createDraftPurchaseOrders(
  wants: { item_id: number; quantity: number }[],
  note: string | null,
  userId: number | null
): { number: string; supplier_id: number | null; supplier_name: string | null; lines: number }[] {
  const bySupplier = new Map<number | null, { item_id: number; name: string; sku: string | null; unit: string | null; quantity: number; unit_price: number }[]>();
  for (const w of wants) {
    if (!(w.quantity > 0)) continue;
    const it = queryOne<{ name: string; sku: string | null; unit: string | null; supplier_id: number | null; unit_cost: number }>(
      'SELECT name, sku, unit, supplier_id, unit_cost FROM inventory_items WHERE id = ?', w.item_id
    );
    if (!it) continue;
    const key = it.supplier_id ?? null;
    if (!bySupplier.has(key)) bySupplier.set(key, []);
    bySupplier.get(key)!.push({
      item_id: w.item_id, name: it.name, sku: it.sku, unit: it.unit,
      quantity: Math.ceil(w.quantity), unit_price: it.unit_cost || 0,
    });
  }
  const created: { number: string; supplier_id: number | null; supplier_name: string | null; lines: number }[] = [];
  for (const [supplierId, group] of bySupplier) {
    if (!group.length) continue;
    const sup = supplierId
      ? queryOne<{ name: string; contact_person: string | null; phone: string | null }>(
          'SELECT name, contact_person, phone FROM suppliers WHERE id = ?', supplierId
        )
      : null;
    const { lines, subtotal, tax_amount, total } = computeTotals(group, 0);
    db.exec('BEGIN');
    try {
      const number = nextOrderNumber('purchase');
      const info = run(
        `INSERT INTO orders
          (type, number, customer_name, customer_contact, status, notes, currency,
           subtotal, tax_percent, tax_amount, total, created_by, supplier_id)
         VALUES ('purchase', ?, ?, ?, 'open', ?, 'PHP', ?, 0, ?, ?, ?, ?)`,
        number, sup?.name ?? null, sup?.contact_person ?? sup?.phone ?? null,
        note, subtotal, tax_amount, total, userId, supplierId
      );
      insertItems(Number(info.lastInsertRowid), lines);
      db.exec('COMMIT');
      created.push({ number, supplier_id: supplierId, supplier_name: sup?.name ?? null, lines: group.length });
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  return created;
}

/** Flip every serialized unit reserved for this order back to stock and zero every line's
 *  bulk release. Called when a sale is deleted or pulled out of an active state. Does not
 *  touch `sold` units — `maybeFulfillSale(…, 'release')` reverses those first. */
export function releaseTeardown(orderId: number): void {
  run(
    "UPDATE job_order_units SET status = 'in_stock', order_id = NULL, updated_at = datetime('now') WHERE order_id = ? AND status = 'reserved'",
    orderId
  );
  run('UPDATE order_items SET released_qty = 0 WHERE order_id = ?', orderId);
  // Re-opened/cancelled: a re-approved order goes back through warehouse acceptance.
  run('UPDATE orders SET warehouse_accepted_at = NULL, warehouse_accepted_by = NULL WHERE id = ?', orderId);
}

// POST /api/orders/:id/accept-release — the warehouse takes on an approved sale order for
// releasing. Picking (/release) is refused until this is done.
router.post('/:id/accept-release', releaseGate, syncClass('claim', orderSite), (req, res) => {
  const id = Number(req.params.id);
  const order = queryOne<Order>('SELECT * FROM orders WHERE id = ?', id);
  if (!order || order.type !== 'sale') { res.status(404).json({ error: 'Sale order not found' }); return; }
  if (!RELEASE_STATES.has(String(order.status || '').toLowerCase())) {
    res.status(409).json({ error: order.status === 'open'
      ? 'The sale order must be approved before the warehouse can accept it.'
      : `Cannot accept an order that is ${order.status}.` });
    return;
  }
  if (order.warehouse_accepted_at) { res.json({ ok: true, order: orderWithLines(id) }); return; }
  run(
    "UPDATE orders SET warehouse_accepted_at = datetime('now'), warehouse_accepted_by = ?, updated_at = datetime('now') WHERE id = ?",
    req.user!.id, id
  );
  res.json({ ok: true, order: orderWithLines(id) });
});

// POST /api/orders/:id/release-slip — issue the release slip for a fully released sale order:
// the numbered record of what physically left (lines + unit serials, who collected it). Issuing
// it confirms the order, which is when stock goes out (maybeFulfillSale). Photos of the
// outgoing goods are attached afterwards as `attachments` kind 'release' on the slip id.
router.post('/:id/release-slip', releaseGate, syncClass('physical', orderSite), (req, res) => {
  const id = Number(req.params.id);
  const order = queryOne<Order>('SELECT * FROM orders WHERE id = ?', id);
  if (!order || order.type !== 'sale') { res.status(404).json({ error: 'Sale order not found' }); return; }
  const existing = queryOne<{ id: number; number: string }>('SELECT id, number FROM release_slips WHERE order_id = ?', id);
  // Clash-checks (D6), replaying a site's slip for its own order: the goods left the site.
  const stands = siteDecisionStands();
  if (existing) {
    if (stands) {
      // Issued on the cloud and at the site: the goods left once — the first slip is kept.
      recordSiteClash(req, `Sale order ${order.number} got a release slip on the cloud and at the site; ${existing.number} was kept.`);
      res.status(201).json({ ok: true, clash: true, id: existing.id, order: orderWithLines(id) });
      return;
    }
    res.status(409).json({ error: 'A release slip was already issued for this order.' });
    return;
  }
  if (String(order.status || '').toLowerCase() !== 'released') {
    if (!stands) {
      res.status(409).json({ error: 'Release every line of the order before issuing the release slip.' });
      return;
    }
    recordSiteClash(req, `Sale order ${order.number} was ${order.status} on the cloud when the site's release slip arrived; the goods had left, so the slip stands.`);
  }
  const input = parseBody(releaseSlipSchema, req.body);
  const lines = queryAll<OrderItem>('SELECT * FROM order_items WHERE order_id = ? ORDER BY sort, id', id);

  let slipId: number;
  db.exec('BEGIN');
  try {
    const number = nextSequence('release_slip_number', 'RS');
    slipId = Number(run(
      'INSERT INTO release_slips (number, order_id, released_by, collected_by, vehicle_plate, notes) VALUES (?, ?, ?, ?, ?, ?)',
      number, id, req.user!.id, input.collected_by, input.vehicle_plate ?? null, input.notes ?? null
    ).lastInsertRowid);
    for (const l of lines) {
      if (l.item_id == null) continue; // free-text / service lines — nothing physical leaves
      const serials = queryAll<{ identifier: string | null }>(
        `SELECT identifier FROM job_order_units
         WHERE order_id = ? AND product_item_id = ? AND status IN ('reserved', 'sold') ORDER BY id`,
        id, l.item_id
      ).map((u) => u.identifier).filter(Boolean);
      run(
        `INSERT INTO release_slip_items (slip_id, order_item_id, item_id, name, sku, unit, quantity, unit_identifiers)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        slipId, l.id, l.item_id, l.name, l.sku ?? null, l.unit ?? null, l.quantity,
        serials.length ? serials.join(', ') : null
      );
    }
    run("UPDATE orders SET status = 'confirmed', updated_at = datetime('now') WHERE id = ?", id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  // Goods have left: post the sale and draw the stock down (COGS too when the ledger is on).
  maybeAutoPostSale(id, req.user!.id);
  maybeFulfillSale(id, req.user!.id);
  maybeAutoPush(id);
  res.status(201).json({ ok: true, id: slipId, order: orderWithLines(id) });
});

// POST /api/orders/:id/release — a warehouse releaser scans / enters goods out against an
// approved sale order. Records only — reserves the serialized units + bumps each bulk
// line's released_qty; stock is drawn down later when the order is confirmed/completed.
router.post('/:id/release', releaseGate, syncClass('physical', orderSite), (req, res) => {
  const id = Number(req.params.id);
  const order = queryOne<Order>('SELECT * FROM orders WHERE id = ?', id);
  if (!order || order.type !== 'sale') { res.status(404).json({ error: 'Sale order not found' }); return; }
  // Clash-checks (D6): replaying a site's release of its own order, a check that fails only
  // because the cloud changed the order or its units meanwhile is flagged instead — the goods
  // were scanned out at the site.
  const stands = siteDecisionStands();
  const clashes: string[] = [];
  const refused = (status: number, error: string): boolean => {
    if (stands) { clashes.push(error); return false; }
    res.status(status).json({ error });
    return true;
  };
  if (order.status === 'open') {
    if (refused(409, 'Approve the sale order before releasing goods.')) return;
  } else if (!RELEASE_STATES.has(String(order.status || '').toLowerCase())) {
    if (refused(409, `Cannot release goods against an order that is ${order.status}.`)) return;
  }
  if (!order.warehouse_accepted_at) {
    if (refused(409, 'The warehouse must accept this order for releasing first.')) return;
  }
  const input = parseBody(releaseOrderSchema, req.body);
  const lines = queryAll<OrderItem>('SELECT * FROM order_items WHERE order_id = ?', id);
  const lineByItem = new Map(lines.filter((l) => l.item_id != null).map((l) => [l.item_id!, l]));

  // Resolve scanned codes → in-stock serialized units by identifier.
  const unitIds = new Set<number>(input.unit_ids ?? []);
  for (const code of input.codes ?? []) {
    const u = queryOne<{ id: number }>(
      `SELECT id FROM job_order_units WHERE identifier = ? AND status IN (${stands ? "'in_stock', 'reserved'" : "'in_stock'"})
       ORDER BY status = 'in_stock' DESC, id DESC LIMIT 1`,
      code.trim()
    );
    if (!u) { res.status(400).json({ error: `No in-stock unit with label "${code.trim()}".` }); return; }
    unitIds.add(u.id);
  }

  const units = unitIds.size
    ? queryAll<{ id: number; status: string; product_item_id: number | null; identifier: string | null }>(
        `SELECT id, status, product_item_id, identifier FROM job_order_units WHERE id IN (${[...unitIds].map(() => '?').join(',')})`,
        ...unitIds
      )
    : [];
  if (units.length !== unitIds.size) { res.status(400).json({ error: 'One or more scanned units were not found.' }); return; }

  // Validate each unit is available and belongs to a line on this order; cap per line.
  const addPerItem = new Map<number, number>();
  for (const u of units) {
    if (u.status !== 'in_stock') {
      const error = `Unit ${u.identifier || '#' + u.id} is ${u.status}, not available to release.`;
      // Reserved for another order on the cloud meanwhile: the site holds and scanned it.
      if (u.status !== 'reserved' || refused(409, error)) {
        if (!res.headersSent) res.status(409).json({ error });
        return;
      }
    }
    if (u.product_item_id == null || !lineByItem.has(u.product_item_id)) {
      res.status(400).json({ error: `Unit ${u.identifier || '#' + u.id} is not for a product on this order.` });
      return;
    }
    const line = lineByItem.get(u.product_item_id)!;
    const already = lineCoverage(id, line).units + lineCoverage(id, line).bulk;
    const pending = addPerItem.get(u.product_item_id) ?? 0;
    if (already + pending + 1 > line.quantity) {
      if (refused(400, `That exceeds the ${line.quantity} ordered of ${line.name}.`)) return;
    }
    addPerItem.set(u.product_item_id, pending + 1);
  }

  // Validate bulk entries.
  for (const b of input.bulk ?? []) {
    const line = lineByItem.get(b.item_id);
    if (!line) { res.status(400).json({ error: `Item #${b.item_id} is not on this order.` }); return; }
    const cov = lineCoverage(id, line);
    if (cov.units + cov.bulk + b.quantity > line.quantity + 1e-9) {
      if (refused(400, `That exceeds the ${line.quantity} ordered of ${line.name}.`)) return;
    }
  }

  db.exec('BEGIN');
  try {
    for (const u of units) {
      run(
        "UPDATE job_order_units SET status = 'reserved', order_id = ?, updated_at = datetime('now') WHERE id = ?",
        id, u.id
      );
    }
    for (const b of input.bulk ?? []) {
      run(
        'UPDATE order_items SET released_qty = MIN(quantity, released_qty + ?) WHERE order_id = ? AND item_id = ?',
        b.quantity, id, b.item_id
      );
    }
    if (!order.released_at) {
      run("UPDATE orders SET released_at = datetime('now'), released_by = ?, updated_at = datetime('now') WHERE id = ?", req.user!.id, id);
    }
    // Auto-advance to 'released' once every line is fully covered.
    const fresh = queryAll<OrderItem>('SELECT * FROM order_items WHERE order_id = ?', id);
    const allCovered = fresh.length > 0 && fresh.every((l) => !l.item_id || lineCoverage(id, l).covered
      || l.quantity <= (l.released_qty || 0));
    if (allCovered && String(order.status).toLowerCase() === 'approved') {
      run("UPDATE orders SET status = 'released', updated_at = datetime('now') WHERE id = ?", id);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  for (const c of clashes) recordSiteClash(req, `Release on ${order.number} at the site stands: ${c}`);
  res.json({
    ok: true,
    reserved: units.length,
    bulk_released: (input.bulk ?? []).reduce((s, b) => s + b.quantity, 0),
    order: orderWithLines(id),
  });
});

// POST /api/orders/:id/release/unreserve — undo a release (units back to stock, bulk down)
router.post('/:id/release/unreserve', releaseGate, syncClass('claim', orderSite), (req, res) => {
  const id = Number(req.params.id);
  const order = queryOne<Order>('SELECT * FROM orders WHERE id = ?', id);
  if (!order || order.type !== 'sale') { res.status(404).json({ error: 'Sale order not found' }); return; }
  if (queryOne('SELECT id FROM release_slips WHERE order_id = ?', id)) {
    res.status(409).json({ error: 'These goods already left on a release slip.' });
    return;
  }
  const input = parseBody(unreserveOrderSchema, req.body);

  db.exec('BEGIN');
  try {
    if (input.unit_ids?.length) {
      run(
        `UPDATE job_order_units SET status = 'in_stock', order_id = NULL, updated_at = datetime('now')
         WHERE order_id = ? AND status = 'reserved' AND id IN (${input.unit_ids.map(() => '?').join(',')})`,
        id, ...input.unit_ids
      );
    }
    for (const b of input.bulk ?? []) {
      run('UPDATE order_items SET released_qty = MAX(0, released_qty - ?) WHERE order_id = ? AND item_id = ?', b.quantity, id, b.item_id);
    }
    // If it no longer fully covers, drop 'released' back to 'approved'.
    if (String(order.status).toLowerCase() === 'released') {
      const fresh = queryAll<OrderItem>('SELECT * FROM order_items WHERE order_id = ?', id);
      const stillCovered = fresh.every((l) => !l.item_id || lineCoverage(id, l).covered || l.quantity <= (l.released_qty || 0));
      if (!stillCovered) run("UPDATE orders SET status = 'approved', updated_at = datetime('now') WHERE id = ?", id);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.json({ ok: true, order: orderWithLines(id) });
});

// GET /api/orders/:id/availability — per-line stock picture for a sale order.
router.get('/:id/availability', (req, res) => {
  const id = Number(req.params.id);
  const order = queryOne<Order>('SELECT type FROM orders WHERE id = ?', id);
  if (!order) { res.status(404).json({ error: 'Order not found' }); return; }
  if (order.type !== 'sale') { res.json({ ok: true, short_lines: 0, lines: [] }); return; }
  res.json(orderAvailability(id));
});

// POST /api/orders/:id/produce-shortfall — for each finished-product line that's short,
// raise a draft job order (linked to this sale order) for the missing quantity. Reports
// per line whether the components are on hand to actually build it.
router.post('/:id/produce-shortfall', requirePermission('inventory.adjust'), syncClass('claim', orderSite), (req, res) => {
  const id = Number(req.params.id);
  const order = queryOne<Order>('SELECT * FROM orders WHERE id = ?', id);
  if (!order || order.type !== 'sale') { res.status(404).json({ error: 'Sale order not found' }); return; }

  let defLoc: number;
  try { defLoc = getDefaultLocationId(); }
  catch { res.status(409).json({ error: 'Create a stock location first (Inventory → Locations).' }); return; }

  const av = orderAvailability(id);
  const created: { line: string; job_order_id: number; number: string; qty: number; buildable: boolean; component_shortfalls: unknown[] }[] = [];
  const skipped: { line: string; reason: string }[] = [];

  for (const l of av.lines) {
    if (l.shortfall <= 0) continue;
    if (!l.is_finished_product) { skipped.push({ line: l.name, reason: 'not a finished product — adjust the line or restock' }); continue; }
    if (!l.has_bom) { skipped.push({ line: l.name, reason: 'no bill of materials — define its BOM first' }); continue; }
    const alreadyCovered = l.linked_job_orders.reduce((s, jo) => s + Math.max(0, jo.remaining), 0);
    const need = Math.max(0, Math.ceil(l.shortfall) - alreadyCovered);
    if (need <= 0) { skipped.push({ line: l.name, reason: `already covered by ${l.linked_job_orders.map((j) => j.number).join(', ')}` }); continue; }
    const jo = createDraftJobOrder({
      productId: l.item_id!, productName: l.name, qty: need, orderId: id,
      sourceLocationId: order.location_id ?? defLoc, outputLocationId: order.location_id ?? defLoc,
      notes: `Backorder for ${order.number}`, userId: req.user!.id,
    });
    created.push({
      line: l.name, job_order_id: jo.id, number: jo.number, qty: need,
      buildable: l.buildable, component_shortfalls: l.component_shortfalls,
    });
  }

  res.json({ created, skipped, availability: orderAvailability(id) });
});

// POST /api/orders/:id/purchase-shortfall — draft purchase order(s) for what has to be
// bought: short lines that aren't made here, plus the short BOM components of finished-
// product lines. Grouped by each item's preferred supplier.
router.post('/:id/purchase-shortfall', requirePermission('orders.create'), syncClass('claim', orderSite), (req, res) => {
  const id = Number(req.params.id);
  const order = queryOne<Order>('SELECT * FROM orders WHERE id = ?', id);
  if (!order || order.type !== 'sale') { res.status(404).json({ error: 'Sale order not found' }); return; }

  const av = orderAvailability(id);
  const wants = new Map<number, number>();
  const bump = (itemId: number, qty: number) => wants.set(itemId, (wants.get(itemId) ?? 0) + qty);

  for (const l of av.lines) {
    if (l.shortfall <= 0) continue;
    if (!l.is_finished_product) { bump(l.item_id!, l.shortfall); continue; }      // buy the finished item itself
    for (const c of l.component_shortfalls) bump(c.component_item_id, c.need - c.have); // buy the missing components
  }

  if (!wants.size) {
    res.json({ created: [], note: 'Nothing to purchase — the shortfalls are buildable from stock or are serialized units.' });
    return;
  }
  const created = createDraftPurchaseOrders(
    [...wants.entries()].map(([item_id, quantity]) => ({ item_id, quantity })),
    `Shortfall for ${order.number}`,
    req.user!.id
  );
  res.json({ created });
});

// POST /api/orders — create with auto number + computed totals
router.post('/', requirePermission('orders.create'), syncClass('merge'), (req, res) => {
  const input = parseBody(createOrderSchema, req.body);
  const { lines, subtotal, tax_amount, total } = computeTotals(input.items, input.tax_percent);

  const cust = resolveCustomer(input.type, input);

  db.exec('BEGIN');
  try {
    const number = nextOrderNumber(input.type);
    const info = run(
      `INSERT INTO orders
        (type, number, customer_name, customer_contact, customer_id, location_id, tax_code_id, order_date, status, notes, currency,
         subtotal, tax_percent, tax_amount, total, created_by, supplier_id, expected_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.type,
      number,
      cust.customer_name,
      cust.customer_contact,
      cust.customer_id,
      input.type === 'sale' ? (input.location_id ?? null) : null,
      input.tax_code_id ?? null,
      input.order_date ?? null,
      input.status || 'open',
      input.notes ?? null,
      input.currency || 'PHP',
      subtotal,
      input.tax_percent,
      tax_amount,
      total,
      req.user!.id,
      input.type === 'purchase' ? (input.supplier_id ?? null) : null,
      input.type === 'purchase' ? (input.expected_date ?? null) : null
    );
    const newId = Number(info.lastInsertRowid);
    insertItems(newId, lines);

    // Stock-availability gate — a sale order created straight into a firm status.
    if (input.type === 'sale' && ['approved', 'confirmed', 'completed'].includes(String(input.status || '').toLowerCase()) && !input.force) {
      const av = orderAvailability(newId);
      if (!av.ok) {
        db.exec('ROLLBACK');
        res.status(409).json({
          error: `${av.short_lines} line(s) don't have enough stock. Save as open, then trim / produce the shortfall / approve as a backorder.`,
          availability: av,
        });
        return;
      }
    }
    db.exec('COMMIT');
    if (input.type === 'sale') {
      maybeAutoPostSale(newId, req.user!.id);
      maybeFulfillSale(newId, req.user!.id);
    }
    res.status(201).json({ id: info.lastInsertRowid, number });
    maybeAutoPush(Number(info.lastInsertRowid));
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
});

// POST /api/orders/:id/status — advance a sale order's status only (no line-item body).
// Same availability gate as PUT, and the same auto-post / fulfil / teardown side effects.
// Used by the delivery-completed "mark the order completed?" prompt.
router.post('/:id/status', requirePermission('orders.edit'), syncClass('claim', orderSite), (req, res) => {
  const id = Number(req.params.id);
  const order = queryOne<Order>('SELECT * FROM orders WHERE id = ?', id);
  if (!order || order.type !== 'sale') { res.status(404).json({ error: 'Sale order not found' }); return; }
  const { status, force } = parseBody(orderStatusSchema, req.body);
  const cur = String(order.status || '').toLowerCase();
  const next = status.toLowerCase();
  if (next === cur) { res.json({ ok: true, status: order.status }); return; }

  const goingFirm = ['approved', 'confirmed', 'completed'].includes(next)
    && !['released', 'confirmed', 'completed'].includes(cur);

  db.exec('BEGIN');
  try {
    if (goingFirm && !force) {
      const av = orderAvailability(id);
      if (!av.ok && !shortageStands(req, order.number, av.short_lines)) {
        db.exec('ROLLBACK');
        res.status(409).json({
          error: `${av.short_lines} line(s) don't have enough stock. Produce or purchase the shortfall, or confirm as a backorder.`,
          availability: av,
        });
        return;
      }
    }
    run("UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?", status, id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  maybeAutoPostSale(id, req.user!.id);
  maybeFulfillSale(id, req.user!.id);
  if ((next === 'cancelled' || next === 'open') && cur !== 'cancelled' && cur !== 'open') {
    releaseTeardown(id);
  }
  res.json({ ok: true, status });
  maybeAutoPush(id);
});

// PUT /api/orders/:id — replace header + items, recompute totals (type/number unchanged)
router.put('/:id', requirePermission('orders.edit'), syncClass('claim', orderSite), (req, res) => {
  const id = Number(req.params.id);
  const order = queryOne<Order>('SELECT * FROM orders WHERE id = ?', id);
  if (!order) {
    res.status(404).json({ error: 'Order not found' });
    return;
  }
  const input = parseBody(updateOrderSchema, req.body);
  const cust = resolveCustomer(order.type, input);

  // A sale order's LINE ITEMS lock once it's past `open` (goods may already be
  // released / reserved against them). Header fields — customer, status, notes,
  // dates — stay editable; totals are recomputed from the existing lines.
  const cur = String(order.status || '').toLowerCase();
  const lockLines = order.type === 'sale' && cur !== 'open' && cur !== 'cancelled';
  const sourceItems = lockLines
    ? queryAll<{ item_id: number | null; name: string; sku: string | null; description: string | null; quantity: number; unit: string | null; unit_price: number; tax_code_id: number | null }>(
        'SELECT item_id, name, sku, description, quantity, unit, unit_price, tax_code_id FROM order_items WHERE order_id = ? ORDER BY sort, id', id
      )
    : input.items;
  const taxPct = lockLines ? order.tax_percent : input.tax_percent;
  const { lines, subtotal, tax_amount, total } = computeTotals(sourceItems, taxPct);

  db.exec('BEGIN');
  try {
    run(
      `UPDATE orders SET customer_name = ?, customer_contact = ?, customer_id = ?, location_id = ?, tax_code_id = ?, order_date = ?, status = ?,
         notes = ?, currency = ?, subtotal = ?, tax_percent = ?, tax_amount = ?, total = ?,
         supplier_id = ?, expected_date = ?, updated_at = datetime('now')
       WHERE id = ?`,
      cust.customer_name,
      cust.customer_contact,
      cust.customer_id,
      order.type === 'sale' ? (input.location_id ?? order.location_id ?? null) : null,
      input.tax_code_id ?? null,
      input.order_date ?? null,
      input.status || 'open',
      input.notes ?? null,
      input.currency || 'PHP',
      subtotal,
      taxPct,
      tax_amount,
      total,
      order.type === 'purchase' ? (input.supplier_id ?? null) : null,
      order.type === 'purchase' ? (input.expected_date ?? null) : null,
      id
    );
    if (!lockLines) {
      run('DELETE FROM order_items WHERE order_id = ?', id);
      insertItems(id, lines);
    }

    // Stock-availability gate: moving a sale order to a firm status (approve / confirm /
    // complete) is refused if any line can't be met from stock, unless `force` (an
    // explicit backorder). Re-checked on open→firm AND approved→confirm (stock may have
    // dropped in between); a `released` order is by definition already covered.
    const newStatus = String(input.status || '').toLowerCase();
    const goingFirm = order.type === 'sale'
      && ['approved', 'confirmed', 'completed'].includes(newStatus) && newStatus !== cur
      && !['released', 'confirmed', 'completed'].includes(cur);
    if (goingFirm && !input.force) {
      const av = orderAvailability(id);
      if (!av.ok && !shortageStands(req, order.number, av.short_lines)) {
        db.exec('ROLLBACK');
        res.status(409).json({
          error: `${av.short_lines} line(s) don't have enough stock. Trim the order, produce the shortfall, or approve as a backorder.`,
          availability: av,
        });
        return;
      }
    }

    db.exec('COMMIT');
    if (order.type === 'sale') {
      maybeAutoPostSale(id, req.user!.id);
      maybeFulfillSale(id, req.user!.id);   // reverses stock + flips sold → reserved when leaving a firm status
      // Cancelling or re-opening returns the order's reserved units to available stock
      // (must run AFTER maybeFulfillSale, which may have just un-sold them to 'reserved').
      if ((newStatus === 'cancelled' || newStatus === 'open') && cur !== 'cancelled' && cur !== 'open') {
        releaseTeardown(id);
      }
    }
    res.json({ ok: true });
    maybeAutoPush(id);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
});

// DELETE /api/orders/:id (cascades items)
router.delete('/:id', requirePermission('orders.delete'), syncClass('claim', orderSite), (req, res) => {
  const id = Number(req.params.id);
  // If this sale was posted to the ledger / drew down stock, reverse both before the row
  // (and its cascaded line items) go away; then return any reserved units to stock.
  maybeFulfillSale(id, req.user!.id, 'release');
  releaseTeardown(id);
  unpostSource('sale_order', id, req.user!.id);
  const info = run('DELETE FROM orders WHERE id = ?', id);
  if (info.changes === 0) {
    res.status(404).json({ error: 'Order not found' });
    return;
  }
  res.json({ ok: true });
});

export default router;
