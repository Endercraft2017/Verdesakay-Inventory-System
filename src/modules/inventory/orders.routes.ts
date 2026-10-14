/** Job & Sale Orders: stored records with line items, auto numbers, server-computed
    totals. One router serves both types (?type=sale|job). */
import { moduleEnabled, requireModule } from '../../shared/modules';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { createHash } from 'node:crypto';
import { idempotency } from '../../shared/idempotency';
import { db, queryOne, queryAll, run, nextSequence } from '../../shared/db';
import { requireAuth, requirePermission, requireAnyPermission } from '../../shared/auth';
import {
  parseBody, ValidationError, createOrderSchema, updateOrderSchema, orderStatusSchema,
  releaseOrderSchema, unreserveOrderSchema, releaseSlipSchema, shortfallActionSchema,
} from '../../shared/validation';
import { getQboStatus, pushOrder } from '../quickbooks/quickbooks';
import { fulfillSaleStockInTransaction, maybeAutoPostSale, maybeFulfillSale, postFulfilledSaleCogs, unpostSource } from '../accounting/accounting-autopost';
import { getDefaultLocationId, locationName, overdrawAllowed, stockAt } from './inventory-stock';
import { createDraftJobOrder } from '../manufacturing/job-orders.routes';
import { orderAvailability } from './order-availability';
import type { Order, OrderItem, OrderType } from '../../shared/types';
import { recordSiteClash, syncClass } from '../../sync';
import { siteDecisionStands } from '../../shared/sync-context';
import { currentAuthorization, latestOverride, slipError, splitUnreleased } from './release-auth';
import { isAppClient } from '../../shared/device';
import { canOnOrder, visibleOrderTypes } from './order-access';

const router = Router();
router.use(requireAuth);

// Check the exact order type before replaying a cached save response or queuing sync work.
function createAccess(req: Request, res: Response, next: NextFunction): void {
  if (!canOnOrder(req.user!, req.body?.type, 'create')) {
    res.status(403).json({ error: 'Forbidden: insufficient permissions' }); return;
  }
  next();
}
function editAccess(req: Request, res: Response, next: NextFunction): void {
  const order = queryOne<Order>('SELECT type FROM orders WHERE id = ?', Number(req.params.id));
  if (!order) { res.status(404).json({ error: 'Order not found' }); return; }
  if (!canOnOrder(req.user!, order.type, 'edit')) {
    res.status(403).json({ error: 'Forbidden: insufficient permissions' }); return;
  }
  next();
}


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
    if (!moduleEnabled('quickbooks')) return;
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
  if (![subtotal, tax_amount, total, ...lines.map((l) => l.line_total)].every((n) => Number.isFinite(n) && n <= Number.MAX_SAFE_INTEGER / 100)) {
    throw new ValidationError('Order amounts are too large to calculate accurately. Reduce the quantity or price.');
  }
  return { lines, subtotal, tax_amount, total };
}

/** Content-based edit token detects changes even within SQLite's one-second timestamps. */
function orderRevision(id: number): string {
  const header = queryOne<Order>('SELECT * FROM orders WHERE id = ?', id);
  const lines = queryAll<OrderItem>('SELECT * FROM order_items WHERE order_id = ? ORDER BY sort, id', id);
  const units = queryAll<{ id: number; status: string }>('SELECT id, status FROM job_order_units WHERE order_id = ? ORDER BY id', id);
  return createHash('sha256').update(JSON.stringify([header, lines, units])).digest('hex');
}

function saleStatus(status: string | null | undefined, current?: string): string {
  const next = (status || 'open').toLowerCase();
  if (next === current?.toLowerCase()) return next;
  if (!['open', 'approved', 'released', 'confirmed', 'completed', 'cancelled', 'fulfilled', 'invoiced', 'paid'].includes(next)) {
    throw new ValidationError('Choose a valid sale order status.');
  }
  if (next === 'released') {
    throw new ValidationError('Warehouse picking sets released status automatically. Approve the order, then release its goods.');
  }
  return next;
}

/** Reject broken stock links before writing an order. Repeated stock items must use
 * one line: release and availability track coverage by item, not by price/name. */
function validateOrderLinks(type: OrderType, input: {
  items: LineInput[]; customer_id?: number | null; location_id?: number | null;
  supplier_id?: number | null; tax_code_id?: number | null;
}): void {
  const seen = new Set<number>();
  for (const [i, line] of input.items.entries()) {
    if (!Number.isFinite(line.quantity) || line.quantity <= 0) throw new ValidationError(`Line ${i + 1}: quantity must be greater than zero`);
    if (line.item_id != null) {
      if (!queryOne('SELECT id FROM inventory_items WHERE id = ?', line.item_id)) {
        throw new ValidationError(`Line ${i + 1}: inventory item no longer exists. Choose another item or use a non-stock line.`);
      }
      if (type === 'sale' && seen.has(line.item_id)) {
        throw new ValidationError(`Line ${i + 1}: this inventory item is already on the order. Combine its quantity into one line.`);
      }
      seen.add(line.item_id);
    }
    if (line.tax_code_id != null && !queryOne('SELECT id FROM tax_codes WHERE id = ?', line.tax_code_id)) {
      throw new ValidationError(`Line ${i + 1}: tax code not found`);
    }
  }
  const links = [
    [type === 'sale' ? input.customer_id : null, 'customers', 'Customer'],
    [type === 'sale' ? input.location_id : null, 'locations', 'Ship-from location'],
    [type === 'purchase' ? input.supplier_id : null, 'suppliers', 'Supplier'],
    [input.tax_code_id, 'tax_codes', 'Tax code'],
  ] as const;
  for (const [id, table, label] of links) {
    if (id != null && !queryOne(`SELECT id FROM ${table} WHERE id = ?`, id)) {
      throw new ValidationError(`${label} not found. Refresh the order and choose again.`);
    }
  }
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
    customer_name: input.customer_name?.trim() || c?.name || null,
    customer_contact: input.customer_contact?.trim() || c?.contact_person || c?.phone || null,
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

// GET /api/orders?type=&q=&backorder=1 — sale / job orders need orders.view, purchase orders
// purchasing.view (order-access.ts); without a type, the list holds the types the caller may see.
router.get('/', (req, res) => {
  const { type, q } = req.query;
  const where: string[] = [];
  const params: unknown[] = [];
  const types = visibleOrderTypes(req.user!);
  if (type === 'sale' || type === 'job' || type === 'purchase') {
    if (!types.includes(type)) { res.status(403).json({ error: 'Forbidden: insufficient permissions' }); return; }
    where.push('o.type = ?'); params.push(type);
  } else {
    if (!types.length) { res.status(403).json({ error: 'Forbidden: insufficient permissions' }); return; }
    where.push(`o.type IN (${types.map(() => '?').join(', ')})`); params.push(...types);
  }
  if (typeof q === 'string' && q.trim()) {
    where.push('(o.number LIKE ? OR o.customer_name LIKE ?)');
    const like = `%${q.trim()}%`;
    params.push(like, like);
  }
  if (req.query.backorder === '1' || req.query.backorder === 'true') where.push(`(${BACKORDER_SQL})`);
  const rows = queryAll<Order>(
    `SELECT o.*, u.full_name AS created_by_name, s.name AS supplier_name,
            jo.id AS job_order_id, jo.number AS job_order_number, jo.status AS job_order_status,
            rs.number AS release_slip_number, (${BACKORDER_SQL}) AS backordered
     FROM orders o
     LEFT JOIN users u ON u.id = o.created_by
     LEFT JOIN suppliers s ON s.id = o.supplier_id
     LEFT JOIN job_orders jo ON jo.id = (SELECT id FROM job_orders WHERE order_id = o.id ORDER BY id DESC LIMIT 1)
     LEFT JOIN release_slips rs ON rs.order_id = o.id
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
  if (!canOnOrder(req.user!, order.type, 'view')) {
    res.status(403).json({ error: 'Forbidden: insufficient permissions' });
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
  res.json({ ...order, revision: orderRevision(order.id) });
});

/* ---------------------------------------------------- sale-order release / pick --- */

const RELEASE_STATES = new Set(['approved', 'released']);

/** Once warehouse work or delivery has begun, completing a physical sale requires
 * its warehouse-out record. This catches both status shortcuts and legacy delivery UI. */
function physicalSaleNeedsSlip(orderId: number, next: string): boolean {
  if (!['confirmed', 'completed', 'fulfilled', 'invoiced', 'paid'].includes(next)) return false;
  return !!queryOne('SELECT 1 FROM order_items WHERE order_id = ? AND item_id IS NOT NULL LIMIT 1', orderId)
    && (!!queryOne('SELECT 1 FROM orders WHERE id = ? AND warehouse_accepted_at IS NOT NULL', orderId)
      || !!queryOne("SELECT 1 FROM deliveries WHERE order_id = ? AND status = 'delivered' LIMIT 1", orderId))
    && !queryOne('SELECT 1 FROM release_slips WHERE order_id = ? LIMIT 1', orderId);
}

function shippedSaleCannotReopen(orderId: number, next: string): boolean {
  return ['open', 'approved', 'released', 'cancelled'].includes(next)
    && !!queryOne('SELECT 1 FROM release_slips WHERE order_id = ? LIMIT 1', orderId);
}

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

// Shared with approval gates and shortage planning; never treats drafts as received stock.
export { orderAvailability } from './order-availability';

/** Raise one draft purchase order per supplier for a list of items to buy. `item_id` is
 *  required on every entry (it's how they group by supplier). Unit price defaults to the
 *  item's standard cost. Shared by the sale-order and job-order "buy the shortfall"
 *  actions and the reorder-level PO. */
export function createDraftPurchaseOrders(
  wants: { item_id: number; quantity: number }[],
  note: string | null,
  userId: number | null,
  sourceOrderId?: number
): { id: number; number: string; supplier_id: number | null; supplier_name: string | null; lines: number }[] {
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
      quantity: Number(w.quantity.toPrecision(15)), unit_price: it.unit_cost || 0,
    });
  }
  const created: { id: number; number: string; supplier_id: number | null; supplier_name: string | null; lines: number }[] = [];
  for (const [supplierId, group] of bySupplier) {
    if (!group.length) continue;
    const sup = supplierId
      ? queryOne<{ name: string; contact_person: string | null; phone: string | null }>(
          'SELECT name, contact_person, phone FROM suppliers WHERE id = ?', supplierId
        )
      : null;
    const { lines, subtotal, tax_amount, total } = computeTotals(group, 0);
    db.exec('SAVEPOINT shortfall_purchase');
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
      const id = Number(info.lastInsertRowid);
      insertItems(id, lines);
      if (sourceOrderId) run('INSERT INTO sale_shortfall_purchases (source_order_id, purchase_order_id) VALUES (?, ?)', sourceOrderId, id);
      db.exec('RELEASE shortfall_purchase');
      created.push({ id, number, supplier_id: supplierId, supplier_name: sup?.name ?? null, lines: group.length });
    } catch (e) { db.exec('ROLLBACK TO shortfall_purchase'); db.exec('RELEASE shortfall_purchase'); throw e; }
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
  if (!queryOne('SELECT 1 FROM order_items WHERE order_id = ? AND item_id IS NOT NULL LIMIT 1', id)) {
    res.status(409).json({ error: 'This sale has no stock goods to release. Complete its service workflow without a warehouse release slip.' });
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
// outgoing goods are `attachments` kind 'release' on the slip id: attached afterwards (desktop),
// or uploaded first as kind 'release_proof' on the order and passed as `evidence_ids`, which the
// slip takes over — both apps (phone and desktop) must do the latter, with at least one photo.
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
  // A partial release needs Sales' authorization (release-auth.ts): the order is split at the slip.
  const { auth, state: authState } = currentAuthorization(id);
  let partial = false;
  if (String(order.status || '').toLowerCase() !== 'released') {
    if (!stands) {
      if (!(auth && authState === 'valid' && auth.partial_allowed)) {
        res.status(409).json({ error: 'Release every line of the order before issuing the release slip.', blocked: 'incomplete' });
        return;
      }
      partial = true;
    } else {
      recordSiteClash(req, `Sale order ${order.number} was ${order.status} on the cloud when the site's release slip arrived; the goods had left, so the slip stands.`);
    }
  }
  const input = parseBody(releaseSlipSchema, req.body);
  // Warehouse-out rules (release-auth.ts): the recipient's token and every required package item,
  // checked before any write — a refusal moves no stock.
  const rule = slipError(id, input);
  if (rule) {
    if (!stands) { res.status(409).json({ error: rule.error, blocked: rule.code, missing: rule.missing }); return; }
    recordSiteClash(req, `Sale order ${order.number}: the site's release slip stands although — ${rule.error}`);
  }
  // Handoff photos already uploaded for this order (kind 'release_proof'); either app needs one.
  const evidence = (input.evidence_ids ?? []).length ? queryAll<{ id: number }>(
    `SELECT id FROM attachments WHERE kind = 'release_proof' AND ref_id = ? AND id IN (${input.evidence_ids!.map(() => '?').join(',')})`,
    id, ...input.evidence_ids!
  ).map((a) => a.id) : [];
  if (!stands && isAppClient(req) && !evidence.length) {
    res.status(409).json({ error: 'Add at least one handoff photo before the warehouse-out.', blocked: 'evidence' });
    return;
  }
  const override = auth && authState === 'valid' ? latestOverride(auth.id) : null;
  if (partial && !queryOne<{ n: number }>(
    `SELECT (SELECT COUNT(*) FROM job_order_units WHERE order_id = ? AND status IN ('reserved', 'sold'))
          + (SELECT COALESCE(SUM(released_qty), 0) FROM order_items WHERE order_id = ?) AS n`, id, id
  )!.n) {
    res.status(409).json({ error: 'Nothing on this order has been allocated yet — scan or enter what is leaving first.', blocked: 'incomplete' });
    return;
  }

  // A staged allocation is not physical stock. An adjustment or another warehouse
  // action may have changed the location after the scan; refuse the handoff before
  // creating its numbered slip when the location can no longer cover the goods.
  if (!stands && !overdrawAllowed()) {
    const locationId = order.location_id ?? getDefaultLocationId();
    const leaving = new Map<number, number>();
    for (const line of queryAll<OrderItem>('SELECT * FROM order_items WHERE order_id = ?', id)) {
      if (line.item_id == null) continue;
      const amount = partial ? Math.min(line.quantity, lineCoverage(id, line).units + lineCoverage(id, line).bulk) : line.quantity;
      leaving.set(line.item_id, (leaving.get(line.item_id) ?? 0) + amount);
    }
    for (const [itemId, amount] of leaving) {
      if (stockAt(itemId, locationId) + 1e-9 < amount) {
        res.status(409).json({ error: `Stock at ${locationName(locationId)} changed after allocation. Reconcile the stock before issuing the release slip.`, blocked: 'stock_changed' });
        return;
      }
    }
  }

  let slipId: number;
  let backorder: { id: number; number: string } | null = null;
  let stockMoved = false;
  db.exec('BEGIN');
  try {
    if (partial) backorder = splitUnreleased(id, auth!.issued_by ?? req.user!.id);
    const lines = queryAll<OrderItem>('SELECT * FROM order_items WHERE order_id = ? ORDER BY sort, id', id);
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
        `INSERT INTO release_slip_items (slip_id, order_item_id, item_id, name, sku, unit, quantity, unit_identifiers, unit_cost)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        slipId, l.id, l.item_id, l.name, l.sku ?? null, l.unit ?? null, l.quantity,
        serials.length ? serials.join(', ') : null,
        queryOne<{ unit_cost: number }>('SELECT unit_cost FROM inventory_items WHERE id = ?', l.item_id)?.unit_cost ?? null
      );
    }
    run(
      `INSERT INTO release_slip_details (slip_id, authorization_id, mode, recipient_name, handoff_area, seal_tag, package, acknowledged, backorder_order_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      slipId, auth && authState === 'valid' ? auth.id : null, auth?.mode ?? null, input.collected_by,
      input.handoff_area ?? auth?.handoff_area ?? null, input.seal_tag ?? null,
      input.package?.length ? JSON.stringify(input.package) : null, input.acknowledged ? 1 : 0, backorder?.id ?? null
    );
    if (auth && authState === 'valid') run('UPDATE release_authorizations SET used_slip_id = ? WHERE id = ?', slipId, auth.id);
    // A supervisor's override is spent on this slip only when it stood in for the token.
    if (override?.status === 'approved' && rule === null && auth && input.authorization_token?.trim().toUpperCase() !== auth.token.toUpperCase()) {
      run("UPDATE release_token_overrides SET status = 'used', used_slip_id = ? WHERE id = ?", slipId, override.id);
    }
    if (evidence.length) {
      run(`UPDATE attachments SET kind = 'release', ref_id = ? WHERE id IN (${evidence.map(() => '?').join(',')})`, slipId, ...evidence);
    }
    run("UPDATE orders SET status = 'confirmed', updated_at = datetime('now') WHERE id = ?", id);
    stockMoved = fulfillSaleStockInTransaction(id, req.user!.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  // Physical stock and its slip are committed together. Accounting follows that commit.
  maybeAutoPostSale(id, req.user!.id);
  if (stockMoved) postFulfilledSaleCogs(id, req.user!.id);
  maybeAutoPush(id);
  res.status(201).json({ ok: true, id: slipId, order: orderWithLines(id), backorder });
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
  // The release payload identifies a product, not a sale line. Updating by item would
  // otherwise increment every duplicate line and count the same serial against each one.
  if (lineByItem.size !== lines.filter((l) => l.item_id != null).length) {
    res.status(409).json({ error: 'This order has the same stock item on multiple lines. Combine those lines before warehouse release.' });
    return;
  }

  // Resolve scanned codes → in-stock serialized units by identifier.
  const unitIds = new Set<number>(input.unit_ids ?? []);
  for (const code of input.codes ?? []) {
    const u = queryOne<{ id: number }>(
      `SELECT id FROM job_order_units WHERE LOWER(TRIM(identifier)) = LOWER(?) AND status IN (${stands ? "'in_stock', 'reserved'" : "'in_stock'"})
       ORDER BY status = 'in_stock' DESC, id DESC LIMIT 1`,
      code.trim()
    );
    if (!u) { res.status(400).json({ error: `No in-stock unit with label "${code.trim()}".` }); return; }
    unitIds.add(u.id);
  }

  const units = unitIds.size
    ? queryAll<{ id: number; status: string; product_item_id: number | null; identifier: string | null; location_id: number | null }>(
        `SELECT u.id, u.status, u.product_item_id, u.identifier, COALESCE(u.location_id, j.output_location_id) AS location_id
         FROM job_order_units u LEFT JOIN job_orders j ON j.id = u.job_order_id
         WHERE u.id IN (${[...unitIds].map(() => '?').join(',')})`,
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
    if (!stands && u.location_id !== (order.location_id ?? getDefaultLocationId())) {
      res.status(409).json({ error: `Unit ${u.identifier || '#' + u.id} is at another location. Transfer it to this order's ship-from location first.` });
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

  // Validate the whole request against the order's location-scoped ATP. Entries for
  // one item are aggregated so repeats cannot bypass a per-entry cap. This also keeps
  // other sales' commitments, serialized reservations, and kit/repair holds intact.
  const requested = new Map<number, number>(addPerItem);
  for (const b of input.bulk ?? []) {
    const line = lineByItem.get(b.item_id);
    if (!line) { res.status(400).json({ error: `Item #${b.item_id} is not on this order.` }); return; }
    if (queryOne('SELECT 1 FROM job_order_units WHERE product_item_id = ? LIMIT 1', b.item_id)) {
      res.status(409).json({ error: `${line.name} has serialized units. Scan its unit labels instead of entering a bulk quantity.` });
      return;
    }
    requested.set(b.item_id, (requested.get(b.item_id) ?? 0) + b.quantity);
  }
  const availability = orderAvailability(id);
  for (const [itemId, amount] of requested) {
    const line = lineByItem.get(itemId)!;
    const cov = lineCoverage(id, line);
    if (cov.units + cov.bulk + amount > line.quantity + 1e-9) {
      if (refused(400, `That exceeds the ${line.quantity} ordered of ${line.name}.`)) return;
    }
    const stockLine = availability.lines.find((l) => l.item_id === itemId);
    const free = Math.max(0, (stockLine?.available ?? 0) - (stockLine?.covered_here ?? 0));
    if (amount > free + 1e-9 && !overdrawAllowed() && refused(409,
      `${line.name} has only ${free} uncommitted at ${availability.location_name || 'the ship-from location'}. Receive or transfer stock before allocating more.`)) return;
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
  if (order.fulfilled_at || !RELEASE_STATES.has(String(order.status).toLowerCase())) {
    res.status(409).json({ error: 'Only an unshipped approved sale can have its allocation undone.' });
    return;
  }
  const input = parseBody(unreserveOrderSchema, req.body);
  const stands = siteDecisionStands();
  const clashes: string[] = [];
  const unitIds = input.unit_ids ?? [];
  if (new Set(unitIds).size !== unitIds.length) {
    res.status(400).json({ error: 'Each unit may be selected only once.' }); return;
  }
  if (unitIds.length) {
    const held = queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM job_order_units WHERE order_id = ? AND status = 'reserved'
       AND id IN (${unitIds.map(() => '?').join(',')})`, id, ...unitIds
    )?.n ?? 0;
    if (held !== unitIds.length) {
      if (!stands) { res.status(409).json({ error: 'One or more units are no longer allocated to this order. Refresh before undoing.' }); return; }
      clashes.push(`Some units were no longer allocated to ${order.number} when the site's undo arrived.`);
    }
  }
  const bulkToUndo = new Map<number, number>();
  for (const b of input.bulk ?? []) bulkToUndo.set(b.item_id, (bulkToUndo.get(b.item_id) ?? 0) + b.quantity);
  for (const [itemId, amount] of bulkToUndo) {
    const line = queryOne<{ released_qty: number }>('SELECT released_qty FROM order_items WHERE order_id = ? AND item_id = ?', id, itemId);
    if (!line || amount > line.released_qty + 1e-9) {
      if (!stands) { res.status(409).json({ error: 'That quantity is no longer allocated to this order. Refresh before undoing.' }); return; }
      clashes.push(`Bulk item #${itemId} had less allocated on the cloud when the site's undo arrived.`);
    }
  }

  db.exec('BEGIN');
  try {
    if (unitIds.length) {
      run(
        `UPDATE job_order_units SET status = 'in_stock', order_id = NULL, updated_at = datetime('now')
         WHERE order_id = ? AND status = 'reserved' AND id IN (${unitIds.map(() => '?').join(',')})`,
        id, ...unitIds
      );
    }
    for (const [itemId, amount] of bulkToUndo) {
      run('UPDATE order_items SET released_qty = MAX(0, released_qty - ?) WHERE order_id = ? AND item_id = ?', amount, id, itemId);
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
  for (const clash of clashes) recordSiteClash(req, clash);
  res.json({ ok: true, order: orderWithLines(id) });
});

// GET /api/orders/:id/availability — per-line stock picture for a sale order.
router.get('/:id/availability', (req, res) => {
  const id = Number(req.params.id);
  const order = queryOne<Order>('SELECT type, status FROM orders WHERE id = ?', id);
  if (!order) { res.status(404).json({ error: 'Order not found' }); return; }
  if (!canOnOrder(req.user!, order.type, 'view')) {
    res.status(403).json({ error: 'Forbidden: insufficient permissions' }); return;
  }
  if (order.type !== 'sale') { res.json({ ok: true, short_lines: 0, lines: [] }); return; }
  res.json({ ...orderAvailability(id), revision: orderRevision(id), order_status: order.status });
});

/** Optional for legacy/mobile callers; desktop reviews use it for all decisions. */
function checkReviewRevision(req: Request, res: Response, order: Order, revision?: string): (() => void) | null {
  if (!revision || revision === orderRevision(order.id)) return () => {};
  if (siteDecisionStands()) {
    // Record replay-only audit rows after planned business inserts, preserving their IDs.
    return () => recordSiteClash(req, `Order ${order.number} changed after a revision-checked site decision; the owning site's decision stands.`);
  }
  res.status(409).json({ error: 'This order changed since your review. Refresh stock and review the latest order.', code: 'stale_order' });
  return null;
}

/** Closed demand must not create new supply. Approval is optional: planning starts in open. */
function canPlanShortfall(order: Order, res: Response): boolean {
  if (order.fulfilled_at || !['open', 'approved', 'released'].includes(String(order.status).toLowerCase())) {
    res.status(409).json({ error: 'Shortfall planning is available only for open, approved or released unfulfilled sales.' });
    return false;
  }
  return true;
}

// POST /api/orders/:id/produce-shortfall — for each finished-product line that's short,
// raise a draft job order (linked to this sale order) for the missing quantity. Reports
// per line whether the components are on hand to actually build it.
router.post('/:id/produce-shortfall', requireModule('manufacturing'), requirePermission('inventory.adjust'), syncClass('claim', orderSite), (req, res) => {
  const id = Number(req.params.id);
  const order = queryOne<Order>('SELECT * FROM orders WHERE id = ?', id);
  if (!order || order.type !== 'sale') { res.status(404).json({ error: 'Sale order not found' }); return; }

  if (!canPlanShortfall(order, res)) return;
  const review = parseBody(shortfallActionSchema, req.body ?? {});
  const recordReview = checkReviewRevision(req, res, order, review.expected_revision);
  if (!recordReview) return;
  let defLoc: number;
  try { defLoc = getDefaultLocationId(); }
  catch { res.status(409).json({ error: 'Create a stock location first (Inventory → Locations).' }); return; }

  const av = orderAvailability(id);
  const created: { line: string; job_order_id: number; number: string; qty: number; buildable: boolean; component_shortfalls: unknown[] }[] = [];
  const skipped: { line: string; reason: string }[] = [];

  db.exec('BEGIN');
  try {
    for (const l of av.lines) {
      if (l.shortfall <= 0) continue;
      if (!l.is_finished_product) { skipped.push({ line: l.name, reason: 'not a finished product — adjust the line or restock' }); continue; }
      const alreadyCovered = l.linked_job_orders.reduce((s, jo) => s + Math.max(0, jo.remaining), 0);
      const need = Math.max(0, Math.ceil(l.shortfall) - alreadyCovered);
      if (need <= 0) { skipped.push({ line: l.name, reason: `already covered by ${l.linked_job_orders.map((j) => j.number).join(', ')}` }); continue; }
      if (!l.has_bom) { skipped.push({ line: l.name, reason: 'no bill of materials — define its BOM first' }); continue; }
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

    recordReview();
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.json({ created, skipped, availability: orderAvailability(id) });
});

// Draft only the purchase demand not already covered by a live linked PO. Source links
// survive PO line edits; received quantities and cancellations release their planning cover.
router.post('/:id/purchase-shortfall', requireModule('purchasing'), requirePermission('purchasing.manage'), syncClass('claim', orderSite), (req, res) => {
  const id = Number(req.params.id);
  const order = queryOne<Order>('SELECT * FROM orders WHERE id = ?', id);
  if (!order || order.type !== 'sale') { res.status(404).json({ error: 'Sale order not found' }); return; }
  if (!canPlanShortfall(order, res)) return;
  const review = parseBody(shortfallActionSchema, req.body ?? {});
  const recordReview = checkReviewRevision(req, res, order, review.expected_revision);
  if (!recordReview) return;
  db.exec('BEGIN');
  try {
    const av = orderAvailability(id);
    const wants = av.purchase_requirements.filter((w) => w.to_purchase > 0)
      .map((w) => ({ item_id: w.item_id, quantity: w.to_purchase }));
    const created = createDraftPurchaseOrders(wants, `Shortfall for ${order.number}`, req.user!.id, id);
    recordReview();
    db.exec('COMMIT');
    res.json({ created, note: created.length ? undefined : 'Nothing to purchase — current requirements are on hand or covered by linked purchase orders.', availability: orderAvailability(id) });
  } catch (e) { db.exec('ROLLBACK'); throw e; }
});

// POST /api/orders — create with auto number + computed totals
router.post('/', requireAnyPermission(['orders.create', 'purchasing.manage']), createAccess, idempotency, syncClass('merge'), (req, res) => {
  const input = parseBody(createOrderSchema, req.body);
  if (!canOnOrder(req.user!, input.type, 'create')) {
    res.status(403).json({ error: 'Forbidden: insufficient permissions' });
    return;
  }
  if (input.type === 'sale') input.status = saleStatus(input.status);
  validateOrderLinks(input.type, input);
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
    if (input.type === 'sale' && ['approved', 'confirmed', 'completed', 'fulfilled', 'invoiced', 'paid'].includes(String(input.status || '').toLowerCase()) && !input.force) {
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
  const { status, force, expected_revision } = parseBody(orderStatusSchema, req.body);
  const recordReview = checkReviewRevision(req, res, order, expected_revision);
  if (!recordReview) return;
  const cur = String(order.status || '').toLowerCase();
  const next = saleStatus(status, cur);
  if (next === cur) { recordReview(); res.json({ ok: true, status: order.status }); return; }
  if (shippedSaleCannotReopen(id, next)) {
    res.status(409).json({ error: 'This sale has a release slip. Record a return or correction instead of reopening or cancelling the physical handoff.', code: 'already_shipped' });
    return;
  }
  if (physicalSaleNeedsSlip(id, next) && !siteDecisionStands()) {
    res.status(409).json({ error: 'This sale has entered warehouse or delivery work, but the goods have no release slip. Complete the warehouse handoff first.', code: 'release_required' });
    return;
  }

  const goingFirm = ['approved', 'confirmed', 'completed', 'fulfilled', 'invoiced', 'paid'].includes(next)
    && !['released', 'confirmed', 'completed', 'fulfilled', 'invoiced', 'paid'].includes(cur);

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
    run("UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?", next, id);
    recordReview();
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
  res.json({ ok: true, status: next });
  maybeAutoPush(id);
});

// PUT /api/orders/:id — replace header + items, recompute totals (type/number unchanged)
router.put('/:id', requireAnyPermission(['orders.edit', 'purchasing.manage']), editAccess, idempotency, syncClass('claim', orderSite), (req, res) => {
  const id = Number(req.params.id);
  const order = queryOne<Order>('SELECT * FROM orders WHERE id = ?', id);
  if (!order) {
    res.status(404).json({ error: 'Order not found' });
    return;
  }
  if (!canOnOrder(req.user!, order.type, 'edit')) {
    res.status(403).json({ error: 'Forbidden: insufficient permissions' });
    return;
  }
  // A sale order's LINE ITEMS lock once it's past `open` (goods may already be
  // released / reserved against them). Header fields — customer, status, notes,
  // dates — stay editable; totals are recomputed from the existing lines.
  const cur = String(order.status || '').toLowerCase();
  const lockLines = order.type === 'sale' && cur !== 'open' && cur !== 'cancelled';
  const input = parseBody(updateOrderSchema, { ...order, ...req.body, ...(lockLines ? { items: undefined } : {}) });
  if (input.expected_revision && input.expected_revision !== orderRevision(id) && siteDecisionStands()) {
    recordSiteClash(req, `Order ${order.number} changed on the cloud after a revision-checked site edit; the owning site's decision stands.`);
  } else if (input.expected_revision && input.expected_revision !== orderRevision(id)) {
    res.status(409).json({ error: 'This order changed after you opened it. Review the latest order before saving; your edits have been kept on screen.', code: 'stale_order' });
    return;
  }
  if (order.type === 'sale') input.status = saleStatus(input.status, cur);
  if (order.type === 'sale' && shippedSaleCannotReopen(id, String(input.status || '').toLowerCase())) {
    res.status(409).json({ error: 'This sale has a release slip. Record a return or correction instead of reopening or cancelling the physical handoff.', code: 'already_shipped' });
    return;
  }
  if (order.type === 'sale' && physicalSaleNeedsSlip(id, String(input.status || '').toLowerCase()) && !siteDecisionStands()) {
    res.status(409).json({ error: 'This sale has entered warehouse or delivery work, but the goods have no release slip. Complete the warehouse handoff first.', code: 'release_required' });
    return;
  }
  if (lockLines) {
    input.tax_percent = order.tax_percent;
    input.tax_code_id = order.tax_code_id;
    input.currency = order.currency;
  }
  if (order.type === 'sale' && (order.released_at || order.fulfilled_at)) input.location_id = order.location_id;
  const cust = resolveCustomer(order.type, input);
  const storedItems = queryAll<OrderItem>('SELECT * FROM order_items WHERE order_id = ? ORDER BY sort, id', id);
  const sourceItems = lockLines ? storedItems : input.items ?? storedItems;
  // Validate effective lines: a locked order retains its original stock links.
  // Legacy repeated lines can still have their header saved without rewriting them.
  validateOrderLinks(order.type, { ...input, items: lockLines ? [] : sourceItems });
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
      order.type === 'sale' ? (input.location_id ?? null) : null,
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
    if (!lockLines && input.items) {
      run('DELETE FROM order_items WHERE order_id = ?', id);
      insertItems(id, lines);
    }

    // Stock-availability gate: moving a sale order to a firm status (approve / confirm /
    // complete) is refused if any line can't be met from stock, unless `force` (an
    // explicit backorder). Re-checked on open→firm AND approved→confirm (stock may have
    // dropped in between); a `released` order is by definition already covered.
    const newStatus = String(input.status || '').toLowerCase();
    const goingFirm = order.type === 'sale'
      && ['approved', 'confirmed', 'completed', 'fulfilled', 'invoiced', 'paid'].includes(newStatus) && newStatus !== cur
      && !['released', 'confirmed', 'completed', 'fulfilled', 'invoiced', 'paid'].includes(cur);
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
router.delete('/:id', requireAnyPermission(['orders.delete', 'purchasing.manage']), syncClass('claim', orderSite), (req, res) => {
  const id = Number(req.params.id);
  const kind = queryOne<{ type: string }>('SELECT type FROM orders WHERE id = ?', id);
  if (kind && !canOnOrder(req.user!, kind.type, 'delete')) {
    res.status(403).json({ error: 'Forbidden: insufficient permissions' });
    return;
  }
  if (kind?.type === 'sale' && queryOne('SELECT 1 FROM release_slips WHERE order_id = ? LIMIT 1', id)) {
    res.status(409).json({ error: 'This sale has a release slip. Record a return or correction instead of deleting its physical handoff.', code: 'already_shipped' });
    return;
  }
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
