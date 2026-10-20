import { tripSummary, prepareTrip, dispatchTrip, orderOutstanding, bindDelivery, lineHeld, refreshDeliveryCompletion, tripError } from './order-trips';
import { now } from '../../shared/sync-context';
import { parseProductionLabel } from '../manufacturing/label-code';
import { allocateBatch, batchBalances, undoBatchAllocations } from './batch-stock';
/** Job & Sale Orders: stored records with line items, auto numbers, server-computed
    totals. One router serves both types (?type=sale|job). */
import { moduleEnabled, requireModule } from '../../shared/modules';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { createHash } from 'node:crypto';
import { idempotency } from '../../shared/idempotency';
import { notifyAnyPermission, notifyPermission } from '../../shared/push';
import { db, queryOne, queryAll, run, nextSequence } from '../../shared/db';
import { requireAuth, requirePermission, requireAnyPermission } from '../../shared/auth';
import {
  parseBody, ValidationError, createOrderSchema, updateOrderSchema, orderStatusSchema,
  releaseOrderSchema, unreserveOrderSchema, releaseSlipSchema, shortfallActionSchema,
} from '../../shared/validation';
import { getQboStatus, pushOrder, orderExportPermission, orderReadyForExport } from '../quickbooks/quickbooks';
import { fulfillSaleStockInTransaction, maybeAutoPostSale, maybeFulfillSale, postFulfilledSaleCogs, unpostSource } from '../accounting/accounting-autopost';
import { getDefaultLocationId, locationName, overdrawAllowed, variantStockAt } from './inventory-stock';
import { createDraftJobOrder } from '../manufacturing/job-orders.routes';
import { orderAvailability } from './order-availability';
import type { Order, OrderItem, OrderType, AuthUser } from '../../shared/types';
import { recordSiteClash, syncClass } from '../../sync';
import { siteDecisionStands, syncContext } from '../../shared/sync-context';
import { currentAuthorization, latestOverride, slipError } from './release-auth';
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

// Every role needs the explicit permission to release sale-order stock.
const releaseGate = requirePermission('orders.release');

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
function maybeAutoPush(orderId: number, user: AuthUser): void {
  try {
    if (!moduleEnabled('quickbooks')) return;
    if (!getQboStatus().auto_push || !getQboStatus().connected) return;
  } catch { return; }
  const order = queryOne<Order>('SELECT * FROM orders WHERE id = ?', orderId);
  if (!order || !orderReadyForExport(order) || !user.permissions.includes(orderExportPermission(order.type))) return;
  const items = queryAll<OrderItem>("SELECT * FROM order_items WHERE order_id = ? AND fulfillment_mode != 'ckd_component' ORDER BY sort, id", orderId);
  Promise.resolve(pushOrder(order, items)).catch((e) =>
    console.warn(`[qbo] auto-push order ${orderId} failed: ${(e as Error).message}`));
}

type LineInput = {
  item_id?: number | null; name: string; sku?: string | null; description?: string | null;
  quantity: number; unit?: string | null; unit_price: number; tax_code_id?: number | null;
  fulfillment_mode?: 'assembled' | 'semi_built' | 'ckd' | 'ckd_component';
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

/** Validate stock links. Separate sale lines may share a SKU but keep their own
 * commercial price/build state and their own physical allocations. */
function validateOrderLinks(type: OrderType, input: {
  items: LineInput[]; customer_id?: number | null; location_id?: number | null;
  supplier_id?: number | null; tax_code_id?: number | null;
}, existingCkd?: Map<number, CkdPart[]>): void {
  const ckdProducts = new Set<number>();
  for (const [i, line] of input.items.entries()) {
    if (!Number.isFinite(line.quantity) || line.quantity <= 0) throw new ValidationError(`Line ${i + 1}: quantity must be greater than zero`);
    if (line.item_id != null) {
      if (!queryOne('SELECT id FROM inventory_items WHERE id = ?', line.item_id)) {
        throw new ValidationError(`Line ${i + 1}: inventory item no longer exists. Choose another item or use a non-stock line.`);
      }
    }
    if (line.fulfillment_mode === 'ckd') {
      if (ckdProducts.has(line.item_id!)) throw new ValidationError('Use one CKD line per product on a sale; set its whole-unit quantity and price there.');
      ckdProducts.add(line.item_id!);
      if (type !== 'sale' || !line.item_id || !Number.isSafeInteger(line.quantity))
        throw new ValidationError(`Line ${i + 1}: CKD needs a stocked product and a whole-unit quantity.`);
      const product = queryOne<{ is_finished_product: number }>('SELECT is_finished_product FROM inventory_items WHERE id = ?', line.item_id);
      if (!product?.is_finished_product) throw new ValidationError(`Line ${i + 1}: CKD requires a finished product with a parts BOM.`);
      const parts = existingCkd?.get(line.item_id) ?? queryAll<{ component_item_id: number }>('SELECT component_item_id FROM bom_components WHERE product_item_id = ?', line.item_id);
      if (!parts.length) throw new ValidationError(`Line ${i + 1}: define the CKD product BOM before ordering it.`);
      for (const part of parts) {
        if (part.component_item_id === line.item_id)
          throw new ValidationError('A CKD product cannot contain itself as a direct part.');
      }
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

type CkdPart = { component_item_id: number; name: string; sku: string | null; unit: string | null; quantity: number };
function insertItems(orderId: number, lines: ReturnType<typeof computeTotals>['lines'], existingCkd?: Map<number, CkdPart[]>): void {
  lines.forEach((l, i) => {
    const parent = run(
      `INSERT INTO order_items
        (order_id, item_id, name, sku, description, quantity, unit, unit_price, line_total, tax_code_id, sort, fulfillment_mode)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      i, l.fulfillment_mode ?? 'assembled'
    );
    if (l.fulfillment_mode === 'ckd') {
      const parts = existingCkd?.get(l.item_id!) ?? queryAll<CkdPart>(
        `SELECT b.component_item_id, c.name, c.sku, c.unit, b.quantity FROM bom_components b
         JOIN inventory_items c ON c.id = b.component_item_id WHERE b.product_item_id = ? ORDER BY b.sort, b.id`, l.item_id);
      for (const part of parts) {
        run(`INSERT INTO order_items (order_id, item_id, name, sku, quantity, unit, unit_price, line_total, sort, fulfillment_mode, parent_order_item_id)
          VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, 'ckd_component', ?)`,
        orderId, part.component_item_id, part.name, part.sku, part.quantity * l.quantity, part.unit, i, Number(parent.lastInsertRowid));
      }
    }
  });
}

// A firm-ish sale order (approved/released, not fulfilled) with at least one line whose
// ordered quantity isn't yet covered by released_qty + its reserved/sold serialized units.
const BACKORDER_SQL = `
  o.type = 'sale' AND o.fulfilled_at IS NULL AND LOWER(o.status) IN ('approved', 'released')
  AND EXISTS (
    SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND oi.item_id IS NOT NULL AND oi.fulfillment_mode != 'ckd'
      AND oi.quantity > COALESCE(oi.released_qty, 0)
        + (SELECT COUNT(*) FROM job_order_units ju
            WHERE ju.order_item_id = oi.id AND ju.status IN ('reserved', 'sold'))
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
            (SELECT GROUP_CONCAT(DISTINCT CASE WHEN oi.fulfillment_mode = 'assembled' AND COALESCE(ii.is_finished_product, 0) = 0
              THEN 'part' ELSE oi.fulfillment_mode END) FROM order_items oi
             LEFT JOIN inventory_items ii ON ii.id = oi.item_id
             WHERE oi.order_id = o.id AND oi.item_id IS NOT NULL AND oi.fulfillment_mode != 'ckd_component') AS fulfillment_modes,
            rs.number AS release_slip_number, (${BACKORDER_SQL}) AS backordered
     FROM orders o
     LEFT JOIN users u ON u.id = o.created_by
     LEFT JOIN suppliers s ON s.id = o.supplier_id
     LEFT JOIN job_orders jo ON jo.id = (SELECT id FROM job_orders WHERE order_id = o.id ORDER BY id DESC LIMIT 1)
     LEFT JOIN release_slips rs ON rs.id=(SELECT id FROM release_slips WHERE order_id=o.id ORDER BY id DESC LIMIT 1)
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
     LEFT JOIN release_slips rs ON rs.id=(SELECT id FROM release_slips WHERE order_id=o.id ORDER BY id DESC LIMIT 1)
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
              WHERE ju.order_item_id = oi.id AND ju.status = 'sold') AS allocated_qty,
            (SELECT COUNT(*) FROM job_order_units ju
              WHERE ju.order_item_id = oi.id AND ju.status = 'reserved') AS reserved_qty
     FROM order_items oi WHERE oi.order_id = ? ORDER BY oi.sort, oi.id`,
    order.id
  );
  res.json({ ...order, revision: orderRevision(order.id), ...(order.type==='sale'?{fulfillment:tripSummary(order.id),trips:queryAll('SELECT id,number,released_at FROM release_slips WHERE order_id=? ORDER BY id',order.id)}:{}) });
});

/* ---------------------------------------------------- sale-order release / pick --- */

const RELEASE_STATES = new Set(['approved', 'released']);

/** Every physical sale must leave through the warehouse-out record, even when
 * warehouse acceptance or delivery work has not started yet. */
function physicalSaleNeedsSlip(orderId: number, next: string): boolean {
  if (!['confirmed', 'completed', 'fulfilled', 'invoiced', 'paid'].includes(next)) return false;
  return !!queryOne('SELECT 1 FROM order_items WHERE order_id = ? AND item_id IS NOT NULL LIMIT 1', orderId)
    && (!queryOne('SELECT 1 FROM release_slips WHERE order_id = ? LIMIT 1', orderId) || orderOutstanding(orderId)>1e-9 || next==='completed'&&!!queryOne(`SELECT 1 FROM release_slips s LEFT JOIN release_slip_details sd ON sd.slip_id=s.id
      WHERE s.order_id=? AND (sd.mode='delivery' OR EXISTS(SELECT 1 FROM deliveries d WHERE d.release_slip_id=s.id))
      AND NOT EXISTS(SELECT 1 FROM deliveries d WHERE d.release_slip_id=s.id AND d.status='delivered' AND d.delivery_mode!='courier') LIMIT 1`,orderId));
}

function shippedSaleCannotReopen(orderId: number, next: string, current: string): boolean {
  if ((['open','cancelled'].includes(next)||['approved','released'].includes(next)&&orderOutstanding(orderId)<=1e-9)
    && queryOne('SELECT 1 FROM release_slips WHERE order_id = ? LIMIT 1', orderId)) return true;
  return (next === 'cancelled' || next === 'open' && current !== 'open')
    && !!queryOne('SELECT 1 FROM job_order_units WHERE order_id = ? AND direct_sold_at IS NOT NULL LIMIT 1', orderId);
}

/** For one line: units of this product `reserved`/`sold` against this order + the line's
 *  own `released_qty` (bulk). "Covered" once that reaches the ordered quantity. */
function lineCoverage(orderId: number, line: Pick<OrderItem, 'id' | 'item_id' | 'quantity' | 'released_qty' | 'dispatched_qty' | 'dispatched_bulk_qty' | 'cancelled_qty'>): {
  units: number; bulk: number; covered: boolean;
} {
  const units = line.item_id
    ? queryOne<{ n: number }>(
        `SELECT COUNT(*) AS n FROM job_order_units
         WHERE order_item_id = ? AND status IN ('reserved', 'sold')`,
        line.id
      )?.n ?? 0
    : 0;
  const bulk = line.released_qty || 0;
  const counted=Math.max(units,(line.dispatched_qty||0)-(line.dispatched_bulk_qty||0)+lineHeld(line as OrderItem).reserved);
  return { units:counted, bulk, covered: counted + bulk >= line.quantity-(line.cancelled_qty||0) };
}

function orderWithLines(id: number): Order | null {
  const order = queryOne<Order>('SELECT * FROM orders WHERE id = ?', id);
  if (!order) return null;
  order.items = queryAll<OrderItem>(
    `SELECT oi.*,
            (SELECT COUNT(*) FROM job_order_units ju WHERE ju.order_item_id = oi.id AND ju.status = 'sold') AS allocated_qty,
            (SELECT COUNT(*) FROM job_order_units ju WHERE ju.order_item_id = oi.id AND ju.status = 'reserved') AS reserved_qty
     FROM order_items oi WHERE oi.order_id = ? ORDER BY oi.sort, oi.id`,
    id
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
    "UPDATE job_order_units SET status = 'in_stock', order_id = NULL, order_item_id = NULL, updated_at = datetime('now') WHERE order_id = ? AND status = 'reserved'",
    orderId
  );
  run("DELETE FROM production_batch_allocations WHERE order_id=? AND state='reserved'",orderId);
  run('UPDATE order_items SET released_qty = 0 WHERE order_id = ?', orderId);
  // Re-opened/cancelled: a re-approved order goes back through warehouse acceptance.
  run('UPDATE orders SET warehouse_accepted_at = NULL, warehouse_accepted_by = NULL WHERE id = ?', orderId);
}

// POST /api/orders/:id/accept-release — the warehouse takes on an approved sale order for
// releasing. Picking (/release) is refused until this is done.
router.post('/:id/accept-release', requireModule('sales'), releaseGate, syncClass('claim', orderSite), (req, res) => {
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

// POST /api/orders/:id/release-slip — immutable trip manifest for held goods. Only this
// load leaves stock; the same order retains its unshipped remainder. Photos of the
// outgoing goods are `attachments` kind 'release' on the slip id: attached afterwards (desktop),
// or uploaded first as kind 'release_proof' on the order and passed as `evidence_ids`, which the
// slip takes over — both apps (phone and desktop) must do the latter, with at least one photo.
router.post('/:id/release-slip', requireModule('sales'), releaseGate, syncClass('physical', orderSite), (req, res) => {
  const id=Number(req.params.id), order=queryOne<Order>('SELECT * FROM orders WHERE id=?',id);
  if(!order||order.type!=='sale'){res.status(404).json({error:'Sale order not found'});return;}
  const input=parseBody(releaseSlipSchema,req.body);
  const latest=queryOne<{id:number;number:string}>('SELECT id,number FROM release_slips WHERE order_id=? ORDER BY id DESC LIMIT 1',id);
  if(latest&&input.previous_slip_id!==latest.id){
    if(siteDecisionStands()&&!('previous_slip_id' in req.body)){
      recordSiteClash(req,`Sale ${order.number}: the original cloud slip ${latest.number} was retained for a legacy site replay.`);
      res.status(201).json({ok:true,clash:true,id:latest.id,order:orderWithLines(id)});return;
    }
    res.status(409).json({error:'This order has a newer release slip. Review the current trip before another handoff.',code:'trip_changed'});return;
  }
  if(!latest&&input.previous_slip_id!=null){res.status(409).json({error:'The previous trip changed. Refresh the order.',code:'trip_changed'});return;}
  if(!['approved','released'].includes(String(order.status).toLowerCase())||order.fulfilled_at){
    if(!siteDecisionStands()){res.status(409).json({error:'Only an approved order with an unshipped remainder can issue a trip slip.'});return;}
    recordSiteClash(req,`The site handed off a trip for ${order.number} after its cloud state changed.`);
  }
  const {auth,state:authState}=currentAuthorization(id);
  let trip:ReturnType<typeof prepareTrip>;
  try{trip=prepareTrip(id,input.lines);}catch(e){const err=e as Error&{code?:string};res.status(409).json({error:err.message,blocked:err.code,code:err.code});return;}
  const leaving=trip.filter(t=>t.line.fulfillment_mode!=='ckd').reduce((n,t)=>n+t.quantity,0);
  const partial=leaving+1e-9<orderOutstanding(id);
  if(partial&&!(auth&&authState==='valid'&&auth.partial_allowed)){
    res.status(409).json({error:'Sales must authorize a partial trip. The remainder stays reserved on this order.',blocked:'incomplete'});return;
  }
  const rule=slipError(id,{...input,shipping_item_ids:trip.map(t=>t.line.item_id!).filter(Boolean)});
  if(rule&&!siteDecisionStands()){res.status(409).json({error:rule.error,blocked:rule.code,missing:rule.missing});return;}
  if(rule)recordSiteClash(req,`${order.number}: site handoff stands although ${rule.error}`);
  const evidence=input.evidence_ids?.length?queryAll<{id:number}>(`SELECT id FROM attachments WHERE kind='release_proof' AND ref_id=? AND id IN (${input.evidence_ids.map(()=>'?').join(',')})`,id,...input.evidence_ids).map(a=>a.id):[];
  if(isAppClient(req)&&!evidence.length&&!siteDecisionStands()){res.status(409).json({error:'Add at least one handoff photo before warehouse-out.',blocked:'evidence'});return;}
  const override=auth&&authState==='valid'?latestOverride(auth.id):null;
  let slipId:number,deliveryId:number|null;
  db.exec('BEGIN');
  try{
    const number=nextSequence('release_slip_number','RS');
    slipId=Number(run('INSERT INTO release_slips(number,order_id,released_by,collected_by,vehicle_plate,notes) VALUES(?,?,?,?,?,?)',number,id,req.user!.id,input.collected_by,input.vehicle_plate??null,input.notes??null).lastInsertRowid);
    dispatchTrip(id,slipId,trip,req.user!.id);
    run(`INSERT INTO release_slip_details(slip_id,authorization_id,mode,recipient_name,handoff_area,seal_tag,package,acknowledged,backorder_order_id)
      VALUES(?,?,?,?,?,?,?,?,NULL)`,slipId,auth&&authState==='valid'?auth.id:null,auth?.mode??null,input.collected_by,input.handoff_area??auth?.handoff_area??null,input.seal_tag??null,input.package?.length?JSON.stringify(input.package):null,input.acknowledged?1:0);
    if(auth&&authState==='valid')run('UPDATE release_authorizations SET used_slip_id=? WHERE id=?',slipId,auth.id);
    if(override?.status==='approved'&&rule===null&&auth&&input.authorization_token?.trim().toUpperCase()!==auth.token.toUpperCase())run("UPDATE release_token_overrides SET status='used',used_slip_id=? WHERE id=?",slipId,override.id);
    if(evidence.length)run(`UPDATE attachments SET kind='release',ref_id=? WHERE id IN (${evidence.map(()=>'?').join(',')})`,slipId,...evidence);
    const ctx=syncContext(),snapshot=ctx?.validatedSnapshots?.releaseTrip as {orderId:number;deliveryId:number|null}|undefined;
    const originalDelivery=snapshot?.orderId===id?snapshot.deliveryId:input.delivery_id;
    deliveryId=snapshot?.orderId===id&&snapshot.deliveryId===null?null:bindDelivery(id,slipId,originalDelivery,siteDecisionStands()&&snapshot?.orderId===id&&snapshot.deliveryId===originalDelivery);
    if(ctx&&!snapshot)(ctx.validatedSnapshots??={}).releaseTrip={orderId:id,deliveryId};
    db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');const err=e as Error&{status?:number;code?:string};if(err.status===409){res.status(409).json({error:err.message,code:err.code,blocked:err.code});return;}throw e;}
  maybeAutoPostSale(id,req.user!.id);postFulfilledSaleCogs(id,req.user!.id);maybeAutoPush(id,req.user!);
  res.status(201).json({ok:true,id:slipId,delivery_id:deliveryId,order:orderWithLines(id),backorder:null,remaining:orderOutstanding(id)});
});

// Customer-authorized cancellation releases only goods that have not left the warehouse.
router.post('/:id/cancel-remainder', requireModule('sales'), requirePermission('orders.approve'), syncClass('claim',orderSite),(req,res)=>{
  const id=Number(req.params.id), order=queryOne<Order>('SELECT * FROM orders WHERE id=?',id);
  if(!order||order.type!=='sale'){res.status(404).json({error:'Sale order not found'});return;}
  if(queryOne(`SELECT 1 FROM job_order_units u WHERE u.order_id=? AND u.direct_sold_at IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM release_slip_units su JOIN release_slip_items sli ON sli.id=su.slip_item_id WHERE su.unit_id=u.id AND sli.order_item_id=u.order_item_id)`,id)){
    res.status(409).json({error:'Directly sold units still need a trip slip before cancelling the remainder.',code:'direct_sale_required'});return;
  }
  const reason=String(req.body.reason||'').trim();
  if(reason.length<3||reason.length>1000){res.status(400).json({error:'Record the customer cancellation reason (3–1000 characters).'});return;}
  if(orderOutstanding(id)<=1e-9){res.status(409).json({error:'No unshipped remainder remains to cancel.'});return;}
  const revision=orderRevision(id);
  if(req.body.expected_revision!==revision){res.status(409).json({error:'Review the current order before cancelling its remainder.',code:'stale_order'});return;}
  db.exec('BEGIN');
  try{
    run('INSERT INTO order_remainder_cancellations(order_id,reason,cancelled_by,cancelled_at) VALUES(?,?,?,?)',id,reason,req.user!.id,now().toISOString().replace('T',' ').slice(0,19));
    run("DELETE FROM production_batch_allocations WHERE order_id=? AND state='reserved'",id);
    run("UPDATE job_order_units SET status='in_stock',order_id=NULL,order_item_id=NULL,updated_at=? WHERE order_id=? AND status='reserved'",now().toISOString().replace('T',' ').slice(0,19),id);
    run('UPDATE order_items SET cancelled_qty=MAX(cancelled_qty,quantity-dispatched_qty),released_qty=dispatched_bulk_qty WHERE order_id=? AND item_id IS NOT NULL',id);
    const subtotal=queryOne<{n:number}>('SELECT COALESCE(SUM((quantity-cancelled_qty)*unit_price),0) AS n FROM order_items WHERE order_id=?',id)!.n;
    const tax=round2(subtotal*order.tax_percent/100);
    const anySlip=!!queryOne('SELECT 1 FROM release_slips WHERE order_id=?',id);
    run('UPDATE orders SET subtotal=?,tax_amount=?,total=?,status=?,fulfilled_at=?,updated_at=? WHERE id=?',round2(subtotal),tax,round2(subtotal+tax),anySlip?'confirmed':'cancelled',anySlip?now().toISOString().replace('T',' ').slice(0,19):null,now().toISOString().replace('T',' ').slice(0,19),id);
    run("UPDATE deliveries SET status='cancelled',updated_at=? WHERE order_id=? AND release_slip_id IS NULL AND status IN ('pending','out_for_delivery')",now().toISOString().replace('T',' ').slice(0,19),id);
    if(anySlip)refreshDeliveryCompletion(id);db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  maybeAutoPostSale(id,req.user!.id);res.json({ok:true,order:orderWithLines(id)});
});

// POST /api/orders/:id/release — a warehouse releaser scans / enters goods out against an
// approved sale order. Records only — reserves the serialized units + bumps each bulk
// line's released_qty; stock is drawn down later when the order is confirmed/completed.
router.post('/:id/release', requireModule('sales'), releaseGate, syncClass('physical', orderSite), (req, res) => {
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
  const physicalLines = lines.filter((l) => l.item_id != null && l.fulfillment_mode !== 'ckd');
  const lineById = new Map(physicalLines.map((l) => [l.id, l]));
  const modeOf = (l: OrderItem) => l.fulfillment_mode === 'semi_built' ? 'semi_built' : 'assembled';
  const matching = (itemId: number, mode?: string) => physicalLines.filter((l) =>
    l.item_id === itemId && (!mode || modeOf(l) === mode));
  const resolveLine = (itemId: number, lineId?: number, mode?: string): OrderItem | null => {
    if (lineId) {
      const l = lineById.get(lineId);
      return l?.item_id === itemId && (!mode || modeOf(l) === mode) ? l : null;
    }
    const candidates = matching(itemId, mode);
    return candidates.length === 1 ? candidates[0]! : null;
  };

  // Resolve scanned codes → in-stock serialized units by identifier.
  const unitIds = new Set<number>(input.unit_ids ?? []);
  for (const code of input.codes ?? []) {
    const label=parseProductionLabel(code);
    if(label?.kind==='batch'){res.status(400).json({error:'Allocate a batch with its batch ID and counted quantity.'});return;}
    if(!label&&queryOne<{n:number}>("SELECT COUNT(*) AS n FROM job_order_units WHERE LOWER(COALESCE(NULLIF(TRIM(identifier),''),'UNIT-' || id))=LOWER(?)",code.trim())!.n>1){res.status(409).json({error:'Ambiguous older label. Reprint the unit QR from its record.'});return;}
    const u = queryOne<{ id: number }>(
      `SELECT id FROM job_order_units WHERE (CASE WHEN ? IS NOT NULL THEN id=? ELSE LOWER(COALESCE(NULLIF(TRIM(identifier), ''), 'UNIT-' || id)) = LOWER(?) END) AND status IN (${stands ? "'in_stock', 'reserved'" : "'in_stock'"})
       ORDER BY status = 'in_stock' DESC, id DESC LIMIT 1`,
      label?.id??null,label?.id??null,code.trim()
    );
    if (!u) { res.status(400).json({ error: `No in-stock unit with label "${code.trim()}".` }); return; }
    unitIds.add(u.id);
  }

  const units = unitIds.size
    ? queryAll<{ id: number; status: string; product_item_id: number | null; identifier: string | null; location_id: number | null; build_mode: string }>(
        `SELECT u.id, u.status, u.product_item_id, u.identifier, COALESCE(j.build_mode, 'assembled') AS build_mode, COALESCE(u.location_id, j.output_location_id) AS location_id
         FROM job_order_units u LEFT JOIN job_orders j ON j.id = u.job_order_id
         WHERE u.id IN (${[...unitIds].map(() => '?').join(',')})`,
        ...unitIds
      )
    : [];
  if (units.length !== unitIds.size) { res.status(400).json({ error: 'One or more scanned units were not found.' }); return; }

  // Validate each unit is available and belongs to a line on this order; cap per line.
  const requestedPerLine = new Map<number, number>();
  const unitLine = new Map<number, OrderItem>();
  for (const u of units) {
    if (u.status !== 'in_stock') {
      const error = `Unit ${u.identifier || '#' + u.id} is ${u.status}, not available to release.`;
      // Reserved for another order on the cloud meanwhile: the site holds and scanned it.
      if (u.status !== 'reserved' || refused(409, error)) {
        if (!res.headersSent) res.status(409).json({ error });
        return;
      }
    }
    if (u.product_item_id == null || !matching(u.product_item_id).length) {
      res.status(400).json({ error: `Unit ${u.identifier || '#' + u.id} is not for a product on this order.` });
      return;
    }
    const candidates = matching(u.product_item_id, u.build_mode);
    if (!candidates.length) {
      res.status(409).json({ error: `Unit ${u.identifier || '#' + u.id} is ${u.build_mode === 'semi_built' ? 'semi-built' : 'fully built'}, but this sale has no matching build-state line.` });
      return;
    }
    const line = resolveLine(u.product_item_id, input.order_item_id, u.build_mode);
    if (!line) {
      res.status(409).json({ error: `Select the exact sale line for ${u.identifier || '#' + u.id}. This product appears on more than one line.`, code: 'line_required' }); return;
    }
    if (!stands && u.location_id !== (order.location_id ?? getDefaultLocationId())) {
      res.status(409).json({ error: `Unit ${u.identifier || '#' + u.id} is at another location. Transfer it to this order's ship-from location first.` });
      return;
    }
    const already = lineCoverage(id, line).units + lineCoverage(id, line).bulk;
    const pending = requestedPerLine.get(line.id) ?? 0;
    if (already + pending + 1 > line.quantity-(line.cancelled_qty||0)) {
      if (refused(400, `That exceeds the ${line.quantity} ordered of ${line.name}.`)) return;
    }
    requestedPerLine.set(line.id, pending + 1);
    unitLine.set(u.id, line);
  }

  // Validate the whole request against the order's location-scoped ATP. Entries for
  // one item are aggregated so repeats cannot bypass a per-entry cap. This also keeps
  // other sales' commitments, serialized reservations, and kit/repair holds intact.
  const bulkLine = new Map<number, OrderItem>();
  for (const b of input.bulk ?? []) {
    const line = resolveLine(b.item_id, b.order_item_id);
    if (!line) {
      if (!matching(b.item_id).length) res.status(400).json({ error: `Item #${b.item_id} is not on this sale order.` });
      else res.status(409).json({ error: `Select the exact sale line for item #${b.item_id}.`, code: 'line_required' });
      return;
    }
    if (!b.batch_id && queryOne(`SELECT 1 FROM job_order_units u JOIN job_orders j ON j.id = u.job_order_id
      WHERE u.product_item_id = ? AND j.build_mode = ? LIMIT 1`, b.item_id,
      line.fulfillment_mode === 'semi_built' ? 'semi_built' : 'assembled')) {
      res.status(409).json({ error: `${line.name} has serialized units. Scan its unit labels instead of entering a bulk quantity.` });
      return;
    }
    if (b.batch_id) {
      const batch = queryOne<{ item_id:number; build_mode:string }>(`SELECT COALESCE(pb.product_item_id,j.product_item_id) AS item_id,j.build_mode
        FROM production_batches pb JOIN job_orders j ON j.id=pb.job_order_id WHERE pb.id=?
        AND NOT EXISTS(SELECT 1 FROM job_order_units u WHERE u.batch_id=pb.id)`,b.batch_id);
      if (!batch || batch.item_id!==b.item_id || batch.build_mode!==(line.fulfillment_mode==='semi_built'?'semi_built':'assembled')) {
        res.status(409).json({error:'The scanned batch does not match this sale product and build state.'});return;
      }
      const wanted=(input.bulk??[]).filter(x=>x.batch_id===b.batch_id).reduce((n,x)=>n+x.quantity,0);
      const balance=batchBalances(b.batch_id).find(x=>x.location_id===(order.location_id??getDefaultLocationId()));
      if(!balance||wanted>balance.available+1e-9){res.status(409).json({error:'This batch has insufficient free quantity at the ship-from location. Rescan and review.'});return;}
    }
    requestedPerLine.set(line.id, (requestedPerLine.get(line.id) ?? 0) + b.quantity);
    bulkLine.set((input.bulk ?? []).indexOf(b), line);
  }
  const availability = orderAvailability(id);
  const requestedPools = new Map<string, number>();
  for (const [lineId, amount] of requestedPerLine) {
    const line = lineById.get(lineId)!;
    const cov = lineCoverage(id, line);
    if (cov.units + cov.bulk + amount > line.quantity-(line.cancelled_qty||0) + 1e-9) {
      if (refused(400, `That exceeds the ${line.quantity} ordered of ${line.name}.`)) return;
    }
    const key = `${line.item_id}:${modeOf(line)}`;
    requestedPools.set(key, (requestedPools.get(key) ?? 0) + amount);
  }
  for (const [key, amount] of requestedPools) {
    const [itemId, mode] = key.split(':');
    const line = matching(Number(itemId), mode)[0]!;
    const stockLine = availability.lines.find((l) => l.item_id === Number(itemId) && (l.fulfillment_mode === 'semi_built' ? 'semi_built' : 'assembled') === mode);
    const ownCovered = matching(Number(itemId), mode).reduce((n, l) => {
      const c = lineCoverage(id, l);
      const directOut = queryOne<{n:number}>(`SELECT COUNT(*) AS n FROM job_order_units u WHERE u.order_item_id=?
        AND u.direct_sold_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM release_slip_units su JOIN release_slip_items sli ON sli.id=su.slip_item_id WHERE su.unit_id=u.id AND sli.order_item_id=u.order_item_id)`,l.id)?.n??0;
      return n + c.units + c.bulk-(l.dispatched_qty||0)-directOut;
    }, 0);
    const free = Math.max(0, (stockLine?.on_hand ?? 0) - (stockLine?.committed_elsewhere ?? 0) - ownCovered);
    if (amount > free + 1e-9 && !overdrawAllowed() && refused(409,
      `${line.name} has only ${free} uncommitted at ${availability.location_name || 'the ship-from location'}. Receive or transfer stock before allocating more.`)) return;
  }

  db.exec('BEGIN');
  try {
    for (const u of units) {
      run(
        "UPDATE job_order_units SET status = 'reserved', order_id = ?, order_item_id = ?, updated_at = datetime('now') WHERE id = ?",
        id, unitLine.get(u.id)!.id, u.id
      );
    }
    for (const [index, b] of (input.bulk ?? []).entries()) {
      const line = bulkLine.get(index)!;
      if(b.batch_id) allocateBatch(b.batch_id,id,b.item_id,order.location_id??getDefaultLocationId(),b.quantity,line.id);
      else {
        // Legacy quantity clients reserve known lots FIFO; QR clients select an exact lot.
        let remaining=b.quantity;
        for(const lot of queryAll<{id:number}>(`SELECT pb.id FROM production_batches pb JOIN job_orders j ON j.id=pb.job_order_id
          WHERE COALESCE(pb.product_item_id,j.product_item_id)=? AND j.build_mode=? ORDER BY pb.id`,b.item_id,modeOf(line))) {
          const balance=batchBalances(lot.id).find(x=>x.location_id===(order.location_id??getDefaultLocationId()));
          const take=Math.min(remaining,balance?.available??0);if(take>0){allocateBatch(lot.id,id,b.item_id,order.location_id??getDefaultLocationId(),take,line.id);remaining-=take;}if(remaining<=1e-9)break;
        }
      }
      run(
        'UPDATE order_items SET released_qty = MIN(quantity, released_qty + ?) WHERE id = ?',
        b.quantity, line.id
      );
    }
    if (!order.released_at) {
      run("UPDATE orders SET released_at = datetime('now'), released_by = ?, updated_at = datetime('now') WHERE id = ?", req.user!.id, id);
    }
    // Auto-advance to 'released' once every line is fully covered.
    const fresh = queryAll<OrderItem>('SELECT * FROM order_items WHERE order_id = ?', id);
    const allCovered = fresh.length > 0 && fresh.every((l) => !l.item_id || l.fulfillment_mode === 'ckd' || lineCoverage(id, l).covered
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
router.post('/:id/release/unreserve', requireModule('sales'), releaseGate, syncClass('claim', orderSite), (req, res) => {
  const id = Number(req.params.id);
  const order = queryOne<Order>('SELECT * FROM orders WHERE id = ?', id);
  if (!order || order.type !== 'sale') { res.status(404).json({ error: 'Sale order not found' }); return; }

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
  const choices:{lineId:number;quantity:number;allocationId?:number;untracked?:boolean}[]=[];
  const allocationUndo=new Map<number,number>(),untrackedUndo=new Map<number,number>();
  const physicalLines = queryAll<OrderItem>("SELECT * FROM order_items WHERE order_id = ? AND fulfillment_mode != 'ckd'", id);
  for (const b of input.bulk ?? []) {
    const candidates = physicalLines.filter((l) => l.item_id === b.item_id);
    const line = b.order_item_id ? candidates.find((l) => l.id === b.order_item_id) : candidates.length === 1 ? candidates[0] : null;
    if (!line) { res.status(409).json({ error: `Select the exact sale line for item #${b.item_id}.`, code: 'line_required' }); return; }
    if(b.allocation_id){const lot=queryOne<{quantity:number}>("SELECT quantity FROM production_batch_allocations WHERE id=? AND order_id=? AND order_item_id=? AND state='reserved'",b.allocation_id,id,line.id);const n=(allocationUndo.get(b.allocation_id)||0)+b.quantity;if(!lot||n>lot.quantity+1e-9){res.status(409).json({error:'That exact batch allocation changed. Review the current held goods.',code:'allocation_changed'});return;}allocationUndo.set(b.allocation_id,n);}
    if(b.untracked){const lots=queryOne<{n:number}>("SELECT COALESCE(SUM(quantity),0) AS n FROM production_batch_allocations WHERE order_item_id=? AND state='reserved'",line.id)!.n;const n=(untrackedUndo.get(line.id)||0)+b.quantity;if(n>line.released_qty-(line.dispatched_bulk_qty||0)-lots+1e-9){res.status(409).json({error:'That untracked allocation changed. Refresh before correction.'});return;}untrackedUndo.set(line.id,n);}
    choices.push({lineId:line.id,quantity:b.quantity,allocationId:b.allocation_id,untracked:b.untracked});
    bulkToUndo.set(line.id, (bulkToUndo.get(line.id) ?? 0) + b.quantity);
  }
  if(choices.some(c=>!c.allocationId&&!c.untracked&&choices.some(other=>other.lineId===c.lineId&&(other.allocationId||other.untracked)))){
    res.status(400).json({error:'Choose exact batches and untracked quantities consistently for this sale line.'});return;
  }
  for (const [lineId, amount] of bulkToUndo) {
    const line = physicalLines.find((l) => l.id === lineId);
    if (!line || amount > line.released_qty-(line.dispatched_bulk_qty||0) + 1e-9) {
      if (!stands) { res.status(409).json({ error: 'That quantity is no longer allocated to this order. Refresh before undoing.' }); return; }
      clashes.push(`Sale line #${lineId} had less allocated on the cloud when the site's undo arrived.`);
    }
  }

  db.exec('BEGIN');
  try {
    if (unitIds.length) {
      run(
        `UPDATE job_order_units SET status = 'in_stock', order_id = NULL, order_item_id = NULL, updated_at = datetime('now')
         WHERE order_id = ? AND status = 'reserved' AND id IN (${unitIds.map(() => '?').join(',')})`,
        id, ...unitIds
      );
    }
    for(const choice of choices){if(!choice.untracked){const line=physicalLines.find(l=>l.id===choice.lineId)!;undoBatchAllocations(id,line.item_id!,choice.quantity,line.id,choice.allocationId);}}
    for (const [lineId, amount] of bulkToUndo) {
      const line = physicalLines.find((l) => l.id === lineId)!;
      run('UPDATE order_items SET released_qty = MAX(dispatched_bulk_qty, released_qty - ?) WHERE id = ?', amount, lineId);
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
router.post('/:id/produce-shortfall', requireModule('sales'), requireModule('manufacturing'), requirePermission('inventory.adjust'), syncClass('claim', orderSite), (req, res) => {
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
        buildMode: l.fulfillment_mode === 'semi_built' ? 'semi_built' : 'assembled',
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
router.post('/:id/purchase-shortfall', requireModule('sales'), requireModule('purchasing'), requirePermission('purchasing.manage'), syncClass('claim', orderSite), (req, res) => {
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
  if (input.type !== 'purchase' && !['open','draft'].includes(String(input.status||'open').toLowerCase()) && !req.user!.permissions.includes('orders.approve')) { res.status(403).json({error:'Sales approval permission is required for this status'}); return; }
  if (input.type === 'sale' && input.items.some((line) => line.item_id != null)
      && !['open', 'approved'].includes(String(input.status || 'open').toLowerCase())) {
    res.status(409).json({ error: 'Physical goods must go through warehouse allocation and a release slip.', code: 'release_required' }); return;
  }
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
    maybeAutoPush(Number(info.lastInsertRowid),req.user!);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
});

// POST /api/orders/:id/status — advance a sale order's status only (no line-item body).
// Same availability gate as PUT, and the same auto-post / fulfil / teardown side effects.
// Used by the delivery-completed "mark the order completed?" prompt.
router.post('/:id/status', requireModule('sales'), requirePermission('orders.approve'), syncClass('claim', orderSite), (req, res) => {
  const id = Number(req.params.id);
  const order = queryOne<Order>('SELECT * FROM orders WHERE id = ?', id);
  if (!order || order.type !== 'sale') { res.status(404).json({ error: 'Sale order not found' }); return; }
  const { status, force, expected_revision } = parseBody(orderStatusSchema, req.body);
  const recordReview = checkReviewRevision(req, res, order, expected_revision);
  if (!recordReview) return;
  const cur = String(order.status || '').toLowerCase();
  const next = saleStatus(status, cur);
  if (next === cur) { recordReview(); res.json({ ok: true, status: order.status }); return; }
  if (shippedSaleCannotReopen(id, next, cur)) {
    res.status(409).json({ error: 'This sale has a release slip. Record a return or correction instead of reopening or cancelling the physical handoff.', code: 'already_shipped' });
    return;
  }
  if (physicalSaleNeedsSlip(id, next)) {
    res.status(409).json({ error: 'Physical goods need a warehouse release slip before this sale can be completed.', code: 'release_required' });
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
  const needsWarehouse = queryOne('SELECT 1 FROM order_items WHERE order_id=? AND item_id IS NOT NULL AND quantity > COALESCE(released_qty,0) LIMIT 1', id);
  if (next === 'approved' && needsWarehouse) {
    void notifyAnyPermission(['orders.release'], {
    title: `Sale order ready for warehouse — ${order.number}`,
    body: 'Review the order lines, accept it, then pick the available stock for release.',
    url: `#/so?id=${id}`, link: { route: 'releasing', params: { tab: 'queue' } }, tag: `sale-release-${id}`,
    }, req.user!.id);
    void notifyPermission('inventory.adjust', {
      title: `Sale order to track — ${order.number}`,
      body: 'Warehouse can review this sale and prepare stock; a releaser with orders.release completes the handoff.',
      url: '#/notifications', link: { route: 'orders', params: { type: 'sale', mode: 'track', id } }, tag: `sale-track-${id}`,
    });
  }
  maybeAutoPush(id,req.user!);
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
  const directStockOut = order.type === 'sale' && !!queryOne('SELECT 1 FROM job_order_units WHERE order_id=? AND direct_sold_at IS NOT NULL LIMIT 1',id);
  const lockLines = order.type === 'sale' && (directStockOut || cur !== 'open' && cur !== 'cancelled');
  const input = parseBody(updateOrderSchema, { ...order, ...req.body, ...(lockLines ? { items: undefined } : {}) });
  if (order.type !== 'purchase' && input.status && input.status !== order.status && !req.user!.permissions.includes('orders.approve')) { res.status(403).json({error:'Sales status decisions require approval permission'}); return; }
  if (input.expected_revision && input.expected_revision !== orderRevision(id) && siteDecisionStands()) {
    recordSiteClash(req, `Order ${order.number} changed on the cloud after a revision-checked site edit; the owning site's decision stands.`);
  } else if (input.expected_revision && input.expected_revision !== orderRevision(id)) {
    res.status(409).json({ error: 'This order changed after you opened it. Review the latest order before saving; your edits have been kept on screen.', code: 'stale_order' });
    return;
  }
  if (order.type === 'sale') input.status = saleStatus(input.status, cur);
  if (order.type === 'sale' && shippedSaleCannotReopen(id, String(input.status || '').toLowerCase(), cur)) {
    res.status(409).json({ error: 'This sale has a release slip. Record a return or correction instead of reopening or cancelling the physical handoff.', code: 'already_shipped' });
    return;
  }
  if (order.type === 'sale' && physicalSaleNeedsSlip(id, String(input.status || '').toLowerCase())) {
    res.status(409).json({ error: 'Physical goods need a warehouse release slip before this sale can be completed.', code: 'release_required' });
    return;
  }
  if (lockLines) {
    input.tax_percent = order.tax_percent;
    input.tax_code_id = order.tax_code_id;
    input.currency = order.currency;
  }
  if (order.type === 'sale' && (directStockOut || order.released_at || order.fulfilled_at)) input.location_id = order.location_id;
  const cust = resolveCustomer(order.type, input);
  const storedItems = queryAll<OrderItem>('SELECT * FROM order_items WHERE order_id = ? ORDER BY sort, id', id);
  const existingCkd = new Map<number, CkdPart[]>();
  for (const parent of storedItems.filter((line) => line.fulfillment_mode === 'ckd')) {
    const parts = storedItems.filter((line) => line.parent_order_item_id === parent.id).map((line) => ({
      component_item_id: line.item_id!, name: line.name, sku: line.sku, unit: line.unit,
      quantity: line.quantity / parent.quantity,
    }));
    if (parent.item_id && parts.length) existingCkd.set(parent.item_id, parts);
  }
  const sourceItems = lockLines ? storedItems : input.items ?? storedItems;
  if (order.type === 'sale' && ['confirmed', 'completed', 'fulfilled', 'invoiced', 'paid'].includes(String(input.status || '').toLowerCase())
      && sourceItems.some((line) => line.fulfillment_mode === 'ckd') && !queryOne('SELECT 1 FROM release_slips WHERE order_id = ?', id)) {
    res.status(409).json({ error: 'CKD goods must go through warehouse allocation and a release slip.', code: 'release_required' }); return;
  }
  // Validate effective lines: a locked order retains its original stock links.
  // Legacy repeated lines can still have their header saved without rewriting them.
  validateOrderLinks(order.type, { ...input, items: lockLines ? [] : sourceItems }, existingCkd);
  const taxPct = lockLines ? order.tax_percent : input.tax_percent;
  const { lines, subtotal, tax_amount, total } = computeTotals(sourceItems.map((l:any)=>({...l,quantity:Math.max(0,l.quantity-(l.cancelled_qty||0))})), taxPct);

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
      insertItems(id, lines, existingCkd);
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
    maybeAutoPush(id,req.user!);
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
  if(queryOne('SELECT record_id FROM form_sales_links WHERE order_id=?',id)){res.status(409).json({error:'This sales order was created from a submitted form. Cancel or correct it instead of deleting its audit link.'});return;}
  if (kind?.type === 'sale' && (queryOne('SELECT 1 FROM release_slips WHERE order_id = ? LIMIT 1', id)
    || queryOne('SELECT 1 FROM job_order_units WHERE order_id=? AND direct_sold_at IS NOT NULL LIMIT 1',id))) {
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

/** Form submissions reuse the order validator, totals and item writer. Caller owns the transaction. */
export function createDraftSaleForForm(raw:Record<string,unknown>,actor:number) {
  const input=parseBody(createOrderSchema,{...raw,type:'sale',status:'open'});
  validateOrderLinks('sale',input);
  const {lines,subtotal,tax_amount,total}=computeTotals(input.items,input.tax_percent);
  const customer=resolveCustomer('sale',input),number=nextOrderNumber('sale');
  const info=run(`INSERT INTO orders(type,number,customer_id,customer_name,customer_contact,order_date,status,notes,currency,subtotal,tax_percent,tax_amount,total,created_by)
    VALUES('sale',?,?,?,?,?,'open',?,?,?,?,?,?,?)`,number,customer.customer_id,customer.customer_name,customer.customer_contact,input.order_date??null,input.notes??null,input.currency||'PHP',subtotal,input.tax_percent,tax_amount,total,actor);
  const id=Number(info.lastInsertRowid);insertItems(id,lines);
  return {id,number,total};
}
