import { independentApproval } from '../../shared/approval-policy';
/**
 * Purchasing depth: goods receipts + vendor bills + 3-way match, all hung off a
 * purchase order (an `orders` row with type = 'purchase').
 *
 *   Purchase Order  →  Goods Receipt(s)   (what arrived — posts stock in)
 *                   →  Vendor Bill(s)     (what we're charged — gated on a 3-way match)
 *
 * Reading needs `purchasing.view`. Receiving (which moves stock) needs `inventory.adjust`.
 * Raising / approving vendor bills needs `purchasing.manage` (split from orders.* — the purchase
 * order itself follows the same pair, inventory/order-access.ts).
 */
import { Router, type Request } from 'express';
import { db, queryOne, queryAll, run, nextSequence, getSetting, setSetting } from '../../shared/db';
import { requireAuth, requirePermission } from '../../shared/auth';
import {
  parseBody, createReceiptSchema, vendorBillSchema, approveBillSchema,
  disputeBillSchema, matchToleranceSchema,
} from '../../shared/validation';
import { applyStockChange, locationName } from '../inventory/inventory-stock';
import { maybeAutoPostVendorBill, maybeAutoPostGoodsReceipt, unpostSource } from '../accounting/accounting-autopost';
import {
  threeWayMatch, receiptStatus, DEFAULT_TOLERANCE,
  type MatchInputLine, type MatchTolerance,
} from './purchasing-match';
import type { Order, OrderItem, GoodsReceipt, VendorBill } from '../../shared/types';
import { recordSiteClash, syncClass } from '../../sync';
import { now, siteDecisionStands } from '../../shared/sync-context';
import requestsRoutes from './requests.routes';

const router = Router();
router.use(requireAuth);
router.use('/requests', requestsRoutes);

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const withReceiptPath = (receipt: GoodsReceipt): GoodsReceipt => ({
  ...receipt, location_name: receipt.location_id ? locationName(receipt.location_id) : receipt.location_name,
});
const TOL_KEY = 'purchasing_match_tolerance';

/** A goods receipt belongs to the site of the location the goods arrive at (docs/OFFLINE-FIRST.md
 *  §16, §23); reversing one is decided there too. Vendor bills are company-wide (the main site). */
const receivingSite = {
  home: (req: Request) => ({ location: Number((req.body as { location_id?: unknown } | undefined)?.location_id) || null }),
};
const receiptSite = {
  home: (req: Request) => ({
    location: queryOne<{ location_id: number | null }>('SELECT location_id FROM goods_receipts WHERE id = ?', Number(req.params.id))?.location_id ?? null,
  }),
};

/** Cost value of a goods receipt: Σ received qty × the matching PO line's unit price,
 *  falling back to the item's standard `unit_cost` for a line with no PO link. */
function receiptValue(receiptId: number): number {
  const rows = queryAll<{ quantity: number; po_price: number | null; std: number }>(
    `SELECT gi.quantity,
            (SELECT oi.unit_price FROM order_items oi WHERE oi.id = gi.order_item_id) AS po_price,
            COALESCE((SELECT i.unit_cost FROM inventory_items i WHERE i.id = gi.item_id), 0) AS std
     FROM goods_receipt_items gi WHERE gi.receipt_id = ?`, receiptId
  );
  return round2(rows.reduce((s, r) => s + (Number(r.quantity) || 0) * (r.po_price ?? r.std ?? 0), 0));
}
const tolerance = (): MatchTolerance => ({ ...DEFAULT_TOLERANCE, ...(getSetting<MatchTolerance>(TOL_KEY) || {}) });

/** Load a purchase order, or send the right error and return null. */
function loadPO(res: import('express').Response, id: number): Order | null {
  const order = queryOne<Order>('SELECT * FROM orders WHERE id = ?', id);
  if (!order) { res.status(404).json({ error: 'Purchase order not found' }); return null; }
  if (order.type !== 'purchase') { res.status(400).json({ error: 'Not a purchase order' }); return null; }
  return order;
}

const poItems = (orderId: number) =>
  queryAll<OrderItem>('SELECT * FROM order_items WHERE order_id = ? ORDER BY sort, id', orderId);

/** Every goods-receipt line for a PO, flattened, as match input. */
function receivedLines(orderId: number): MatchInputLine[] {
  return queryAll<{ order_item_id: number | null; name: string; quantity: number }>(
    `SELECT gi.order_item_id, gi.name, gi.quantity
     FROM goods_receipt_items gi JOIN goods_receipts g ON g.id = gi.receipt_id
     WHERE g.order_id = ?`,
    orderId
  );
}

/** Lines of approved bills for a PO other than `exceptBillId`, as match input. */
function priorBilledLines(orderId: number, exceptBillId = 0): MatchInputLine[] {
  return queryAll<{ order_item_id: number | null; name: string; quantity: number }>(
    `SELECT bi.order_item_id, bi.name, bi.quantity
     FROM vendor_bill_items bi JOIN vendor_bills b ON b.id = bi.bill_id
     WHERE b.order_id = ? AND b.status = 'approved' AND b.id <> ?`,
    orderId, exceptBillId
  );
}

function billLines(billId: number): MatchInputLine[] {
  return queryAll<{ order_item_id: number | null; name: string; quantity: number; unit_price: number }>(
    'SELECT order_item_id, name, quantity, unit_price FROM vendor_bill_items WHERE bill_id = ?',
    billId
  );
}

function matchForBill(order: Order, billId: number): ReturnType<typeof threeWayMatch> {
  return threeWayMatch({
    poLines: poItems(order.id).map((oi) => ({
      order_item_id: oi.id, name: oi.name, quantity: oi.quantity, unit_price: oi.unit_price,
    })),
    receiptLines: receivedLines(order.id),
    billLines: billLines(billId),
    priorBillLines: priorBilledLines(order.id, billId),
    tolerance: tolerance(),
  });
}

/* --------------------------------------------------------------- PO summary --- */

// GET /api/purchasing/orders/:id — receiving + billing picture for one PO.
router.get('/orders/:id', requirePermission('purchasing.view'), (req, res) => {
  const order = loadPO(res, Number(req.params.id));
  if (!order) return;

  const items = poItems(order.id);
  const recv = receivedLines(order.id);
  const billed = queryAll<{ order_item_id: number | null; name: string; quantity: number }>(
    `SELECT bi.order_item_id, bi.name, bi.quantity
     FROM vendor_bill_items bi JOIN vendor_bills b ON b.id = bi.bill_id
     WHERE b.order_id = ? AND b.status <> 'disputed'`,
    order.id
  );
  const sumBy = (rows: { order_item_id?: number | null; quantity: number }[], id: number) =>
    round2(rows.filter((r) => r.order_item_id === id).reduce((s, r) => s + (Number(r.quantity) || 0), 0));

  const lines = items.map((oi) => {
    const received = sumBy(recv, oi.id);
    const bl = sumBy(billed, oi.id);
    return {
      ...oi,
      received,
      billed: bl,
      outstanding: round2(oi.quantity - received),
    };
  });

  const ordByKey = new Map(items.map((oi) => [`oi:${oi.id}`, oi.quantity]));
  const recvByKey = new Map<string, number>();
  for (const r of recv) {
    const k = r.order_item_id != null ? `oi:${r.order_item_id}` : `nm:${r.name.trim().toLowerCase()}`;
    recvByKey.set(k, round2((recvByKey.get(k) ?? 0) + (Number(r.quantity) || 0)));
  }

  res.json({
    order,
    lines,
    receipts: queryAll<GoodsReceipt>(
      `SELECT g.*, l.name AS location_name, u.full_name AS received_by_name,
              (SELECT COUNT(*) FROM goods_receipt_items x WHERE x.receipt_id = g.id) AS line_count
       FROM goods_receipts g
       LEFT JOIN locations l ON l.id = g.location_id
       LEFT JOIN users u ON u.id = g.received_by
       WHERE g.order_id = ? ORDER BY g.id DESC`,
      order.id
    ).map(withReceiptPath),
    bills: queryAll<VendorBill>(
      `SELECT b.*, u.full_name AS approved_by_name
       FROM vendor_bills b LEFT JOIN users u ON u.id = b.approved_by
       WHERE b.order_id = ? ORDER BY b.id DESC`,
      order.id
    ),
    receipt_status: receiptStatus(ordByKey, recvByKey),
    tolerance: tolerance(),
  });
});

/* ------------------------------------------------------------ goods receipts --- */

// GET /api/purchasing/receipts — recent receipts (optionally ?order_id=).
router.get('/receipts', requirePermission('purchasing.view'), (req, res) => {
  const where: string[] = [];
  const params: unknown[] = [];
  if (req.query.order_id) { where.push('g.order_id = ?'); params.push(Number(req.query.order_id)); }
  res.json(
    queryAll<GoodsReceipt>(
      `SELECT g.*, l.name AS location_name, u.full_name AS received_by_name, o.number AS order_number,
              (SELECT COUNT(*) FROM goods_receipt_items x WHERE x.receipt_id = g.id) AS line_count
       FROM goods_receipts g
       LEFT JOIN locations l ON l.id = g.location_id
       LEFT JOIN users u ON u.id = g.received_by
       LEFT JOIN orders o ON o.id = g.order_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY g.id DESC LIMIT 200`,
      ...params
    ).map(withReceiptPath)
  );
});

// GET /api/purchasing/receipts/:id — one receipt + its lines.
router.get('/receipts/:id', requirePermission('purchasing.view'), (req, res) => {
  const receipt = queryOne<GoodsReceipt>(
    `SELECT g.*, l.name AS location_name, u.full_name AS received_by_name, o.number AS order_number
     FROM goods_receipts g
     LEFT JOIN locations l ON l.id = g.location_id
     LEFT JOIN users u ON u.id = g.received_by
     LEFT JOIN orders o ON o.id = g.order_id
     WHERE g.id = ?`,
    Number(req.params.id)
  );
  if (!receipt) { res.status(404).json({ error: 'Receipt not found' }); return; }
  receipt.items = queryAll('SELECT * FROM goods_receipt_items WHERE receipt_id = ? ORDER BY sort, id', receipt.id);
  res.json(withReceiptPath(receipt));
});

// POST /api/purchasing/orders/:id/receipts — record what arrived + post stock in.
router.post('/orders/:id/receipts', requirePermission('inventory.receive'), syncClass('physical', receivingSite), (req, res) => {
  const order = loadPO(res, Number(req.params.id));
  if (!order) return;
  const input = parseBody(createReceiptSchema, req.body);

  if (!queryOne('SELECT id FROM locations WHERE id = ?', input.location_id)) {
    res.status(400).json({ error: 'That location does not exist' });
    return;
  }
  // Validate any PO-line / item references up front.
  for (const l of input.lines) {
    if (l.order_item_id != null
      && !queryOne('SELECT id FROM order_items WHERE id = ? AND order_id = ?', l.order_item_id, order.id)) {
      // Clash-check (D6): the PO line was removed on the cloud after the site received against
      // it. The goods arrived — the line is kept, unlinked from the PO, and flagged.
      if (siteDecisionStands()) {
        recordSiteClash(req, `Goods receipt on ${order.number}: line "${l.name}" was removed from the PO on the cloud; it was received unlinked.`);
        l.order_item_id = null;
      } else {
        res.status(400).json({ error: `Line "${l.name}" points at a PO line that isn't on this order` });
        return;
      }
    }
    if (l.item_id != null && !queryOne('SELECT id FROM inventory_items WHERE id = ?', l.item_id)) {
      res.status(400).json({ error: `Line "${l.name}" points at an item that doesn't exist` });
      return;
    }
  }

  db.exec('BEGIN');
  try {
    const number = nextSequence('grn_seq', 'GRN');
    const info = run(
      `INSERT INTO goods_receipts (number, order_id, supplier_id, location_id, received_date, notes, received_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      number, order.id, order.supplier_id ?? null, input.location_id,
      input.received_date ?? null, input.notes ?? null, req.user!.id
    );
    const receiptId = Number(info.lastInsertRowid);

    input.lines.forEach((l, i) => {
      run(
        `INSERT INTO goods_receipt_items (receipt_id, order_item_id, item_id, name, sku, quantity, unit, sort)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        receiptId, l.order_item_id ?? null, l.item_id ?? null, l.name, l.sku ?? null,
        l.quantity ?? 0, l.unit ?? null, i
      );
      if (l.item_id != null && (l.quantity ?? 0) > 0) {
        const poPrice = l.order_item_id != null
          ? queryOne<{ unit_price: number }>('SELECT unit_price FROM order_items WHERE id = ?', l.order_item_id)?.unit_price
          : undefined;
        applyStockChange({
          itemId: l.item_id, locationId: input.location_id, change: l.quantity ?? 0,
          userId: req.user!.id, reason: `Goods receipt ${number} — ${order.number}`,
          unitCost: poPrice,   // rolls the item's moving-average cost
        });
      }
    });
    db.exec('COMMIT');
    // GL: perpetual inventory — DR Inventory / CR Goods Received Not Invoiced (best-effort).
    maybeAutoPostGoodsReceipt(receiptId, number, input.received_date ?? now().toISOString().slice(0, 10),
      receiptValue(receiptId), req.user!.id);
    res.status(201).json({ id: receiptId, number });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
});

// DELETE /api/purchasing/receipts/:id — reverse the posted stock and remove the receipt.
router.delete('/receipts/:id', requirePermission('inventory.receive'), syncClass('claim', receiptSite), (req, res) => {
  const receipt = queryOne<GoodsReceipt>('SELECT * FROM goods_receipts WHERE id = ?', Number(req.params.id));
  if (!receipt) { res.status(404).json({ error: 'Receipt not found' }); return; }
  const lines = queryAll<{ item_id: number | null; quantity: number; name: string }>(
    'SELECT item_id, quantity, name FROM goods_receipt_items WHERE receipt_id = ?', receipt.id
  );
  db.exec('BEGIN');
  try {
    for (const l of lines) {
      if (l.item_id != null && (l.quantity ?? 0) > 0 && receipt.location_id != null) {
        applyStockChange({
          itemId: l.item_id, locationId: receipt.location_id, change: -(l.quantity ?? 0),
          userId: req.user!.id, reason: `Reversed goods receipt ${receipt.number}`,
        });
      }
    }
    run('DELETE FROM goods_receipts WHERE id = ?', receipt.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  unpostSource('goods_receipt', receipt.id, req.user!.id);   // GL: reverse the receipt entry
  res.json({ ok: true });
});

/* -------------------------------------------------------------- vendor bills --- */

function computeBillTotals<T extends { quantity: number; unit_price: number }>(lines: T[], taxPercent: number) {
  const withTotals = lines.map((l) => ({
    ...l, line_total: round2((Number(l.quantity) || 0) * (Number(l.unit_price) || 0)),
  }));
  const subtotal = round2(withTotals.reduce((s, l) => s + l.line_total, 0));
  const tax_amount = round2((subtotal * (taxPercent || 0)) / 100);
  return { withTotals, subtotal, tax_amount, total: round2(subtotal + tax_amount) };
}

// GET /api/purchasing/bills — AP worklist (optionally ?status= / ?order_id=).
router.get('/bills', requirePermission('purchasing.view'), (req, res) => {
  const where: string[] = [];
  const params: unknown[] = [];
  if (typeof req.query.status === 'string') { where.push('b.status = ?'); params.push(req.query.status); }
  if (req.query.order_id) { where.push('b.order_id = ?'); params.push(Number(req.query.order_id)); }
  res.json(
    queryAll<VendorBill>(
      `SELECT b.*, s.name AS supplier_name, o.number AS order_number, u.full_name AS approved_by_name
       FROM vendor_bills b
       LEFT JOIN suppliers s ON s.id = b.supplier_id
       LEFT JOIN orders o ON o.id = b.order_id
       LEFT JOIN users u ON u.id = b.approved_by
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY b.id DESC LIMIT 300`,
      ...params
    )
  );
});

// GET /api/purchasing/bills/:id — a bill, its lines, and a fresh 3-way match.
router.get('/bills/:id', requirePermission('purchasing.view'), (req, res) => {
  const bill = queryOne<VendorBill>(
    `SELECT b.*, s.name AS supplier_name, o.number AS order_number, u.full_name AS approved_by_name
     FROM vendor_bills b
     LEFT JOIN suppliers s ON s.id = b.supplier_id
     LEFT JOIN orders o ON o.id = b.order_id
     LEFT JOIN users u ON u.id = b.approved_by
     WHERE b.id = ?`,
    Number(req.params.id)
  );
  if (!bill) { res.status(404).json({ error: 'Bill not found' }); return; }
  bill.items = queryAll('SELECT * FROM vendor_bill_items WHERE bill_id = ? ORDER BY sort, id', bill.id);
  const order = queryOne<Order>('SELECT * FROM orders WHERE id = ?', bill.order_id);
  res.json({ ...bill, match: order ? matchForBill(order, bill.id) : null });
});

// POST /api/purchasing/orders/:id/bills — enter a supplier's invoice against the PO.
router.post('/orders/:id/bills', requirePermission('purchasing.manage'), syncClass('merge'), (req, res) => {
  const order = loadPO(res, Number(req.params.id));
  if (!order) return;
  const input = parseBody(vendorBillSchema, req.body);
  const { withTotals, subtotal, tax_amount, total } = computeBillTotals(input.lines, input.tax_percent);
  const ewtAmount = round2(input.ewt_amount != null ? input.ewt_amount : subtotal * (input.ewt_rate || 0) / 100);

  db.exec('BEGIN');
  try {
    const number = nextSequence('vbill_seq', 'BILL');
    const info = run(
      `INSERT INTO vendor_bills
        (number, vendor_ref, order_id, supplier_id, tax_code_id, ewt_rate, ewt_amount, ewt_atc,
         bill_date, due_date, currency, subtotal, tax_percent, tax_amount, total, status, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
      number, input.vendor_ref ?? null, order.id, order.supplier_id ?? null, input.tax_code_id ?? null,
      input.ewt_rate || 0, ewtAmount, input.ewt_atc ?? null,
      input.bill_date ?? null, input.due_date ?? null,
      input.currency || order.currency || 'PHP',
      subtotal, input.tax_percent, tax_amount, total, input.notes ?? null, req.user!.id
    );
    const billId = Number(info.lastInsertRowid);
    withTotals.forEach((l, i) => {
      run(
        `INSERT INTO vendor_bill_items
          (bill_id, order_item_id, item_id, name, sku, quantity, unit, unit_price, line_total, tax_code_id, sort)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        billId, l.order_item_id ?? null, l.item_id ?? null, l.name, l.sku ?? null,
        l.quantity ?? 0, l.unit ?? null, l.unit_price ?? 0, l.line_total, l.tax_code_id ?? null, i
      );
    });
    db.exec('COMMIT');
    res.status(201).json({ id: billId, number });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
});

// PUT /api/purchasing/bills/:id — edit a bill that isn't approved yet.
router.put('/bills/:id', requirePermission('purchasing.manage'), syncClass('claim'), (req, res) => {
  const bill = queryOne<VendorBill>('SELECT * FROM vendor_bills WHERE id = ?', Number(req.params.id));
  if (!bill) { res.status(404).json({ error: 'Bill not found' }); return; }
  if (bill.status === 'approved') {
    res.status(409).json({ error: 'An approved bill cannot be edited — dispute it first' });
    return;
  }
  const input = parseBody(vendorBillSchema, req.body);
  const { withTotals, subtotal, tax_amount, total } = computeBillTotals(input.lines, input.tax_percent);
  const ewtAmount = round2(input.ewt_amount != null ? input.ewt_amount : subtotal * (input.ewt_rate || 0) / 100);

  db.exec('BEGIN');
  try {
    run(
      `UPDATE vendor_bills SET vendor_ref = ?, bill_date = ?, due_date = ?, currency = ?, tax_code_id = ?,
         ewt_rate = ?, ewt_amount = ?, ewt_atc = ?,
         subtotal = ?, tax_percent = ?, tax_amount = ?, total = ?, notes = ?,
         status = CASE WHEN status = 'disputed' THEN 'draft' ELSE status END,
         dispute_note = NULL, last_edited_by = ?
       WHERE id = ?`,
      input.vendor_ref ?? null, input.bill_date ?? null, input.due_date ?? null,
      input.currency || bill.currency, input.tax_code_id ?? null,
      input.ewt_rate || 0, ewtAmount, input.ewt_atc ?? null,
      subtotal, input.tax_percent, tax_amount, total,
      input.notes ?? null, req.user!.id, bill.id
    );
    run('DELETE FROM vendor_bill_items WHERE bill_id = ?', bill.id);
    withTotals.forEach((l, i) => {
      run(
        `INSERT INTO vendor_bill_items
          (bill_id, order_item_id, item_id, name, sku, quantity, unit, unit_price, line_total, tax_code_id, sort)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        bill.id, l.order_item_id ?? null, l.item_id ?? null, l.name, l.sku ?? null,
        l.quantity ?? 0, l.unit ?? null, l.unit_price ?? 0, l.line_total, l.tax_code_id ?? null, i
      );
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.json({ ok: true });
});

// POST /api/purchasing/bills/:id/approve — passes only on a clean 3-way match,
// unless `force` is set (which records who overrode and why).
router.post('/bills/:id/approve', requirePermission('purchasing.approve_bills'), syncClass('claim'), (req, res) => {
  const bill = queryOne<VendorBill>('SELECT * FROM vendor_bills WHERE id = ?', Number(req.params.id));
  if (!bill) { res.status(404).json({ error: 'Bill not found' }); return; }
  if (bill.status === 'approved') {
    // Clash-check (D6): approved on the cloud meanwhile — the first approval is kept, flagged.
    if (siteDecisionStands()) {
      recordSiteClash(req, `Vendor bill ${bill.number} was approved on the cloud and at the main site; the first approval was kept.`);
      res.json({ ok: true, clash: true });
      return;
    }
    res.status(409).json({ error: 'Already approved' });
    return;
  }
  if (!independentApproval(req,res,bill.created_by,'approve this vendor bill',bill.last_edited_by)) return;
  if (req.body?.force && !req.user!.permissions.includes('purchasing.override_match')) { res.status(403).json({error:'Match override permission is required'}); return; }
  const input = parseBody(approveBillSchema, req.body);
  const order = queryOne<Order>('SELECT * FROM orders WHERE id = ?', bill.order_id);
  if (!order) { res.status(404).json({ error: 'Purchase order not found' }); return; }

  const match = matchForBill(order, bill.id);
  if (!match.ok && !input.force) {
    // Clash-check (D6): the match held at the main site; receipts or the PO changed on the cloud
    // meanwhile. The approval stands, flagged (its match_json records the cloud's exceptions).
    if (!siteDecisionStands()) {
      res.status(409).json({ error: '3-way match failed', match });
      return;
    }
    recordSiteClash(req, `Vendor bill ${bill.number} was approved at the main site, but the cloud's 3-way match now has ${match.issues.length} exception(s).`);
  }
  const note = input.force && !match.ok
    ? `Force-approved over ${match.issues.length} exception(s)${input.note ? ' — ' + input.note : ''}`
    : (input.note ?? null);
  run(
    `UPDATE vendor_bills SET status = 'approved', approved_by = ?, approved_at = datetime('now'),
       match_json = ?, notes = COALESCE(?, notes)
     WHERE id = ?`,
    req.user!.id, JSON.stringify(match), note, bill.id
  );
  maybeAutoPostVendorBill(bill.id, req.user!.id);
  res.json({ ok: true, forced: input.force && !match.ok, match });
});

// POST /api/purchasing/bills/:id/dispute — park a bill with a reason.
router.post('/bills/:id/dispute', requirePermission('purchasing.manage'), syncClass('claim'), (req, res) => {
  const bill = queryOne<VendorBill>('SELECT id FROM vendor_bills WHERE id = ?', Number(req.params.id));
  if (!bill) { res.status(404).json({ error: 'Bill not found' }); return; }
  const input = parseBody(disputeBillSchema, req.body);
  run(
    `UPDATE vendor_bills SET status = 'disputed', dispute_note = ?, approved_by = NULL, approved_at = NULL
     WHERE id = ?`,
    input.note, Number(req.params.id)
  );
  // A bill pulled back from "approved" is no longer a payable — reverse any GL posting.
  unpostSource('vendor_bill', Number(req.params.id), req.user!.id);
  res.json({ ok: true });
});

// DELETE /api/purchasing/bills/:id — only while not approved.
router.delete('/bills/:id', requirePermission('purchasing.manage'), syncClass('claim'), (req, res) => {
  const bill = queryOne<VendorBill>('SELECT status FROM vendor_bills WHERE id = ?', Number(req.params.id));
  if (!bill) { res.status(404).json({ error: 'Bill not found' }); return; }
  if (bill.status === 'approved') {
    res.status(409).json({ error: 'Dispute an approved bill instead of deleting it' });
    return;
  }
  run('DELETE FROM vendor_bills WHERE id = ?', Number(req.params.id));
  res.json({ ok: true });
});

/* ----------------------------------------------------------------- tolerance --- */

router.get('/tolerance', requirePermission('purchasing.view'), (_req, res) => {
  res.json(tolerance());
});

router.put('/tolerance', requirePermission('purchasing.override_match'), syncClass('claim'), (req, res) => {
  const input = parseBody(matchToleranceSchema, req.body);
  setSetting(TOL_KEY, input);
  res.json(input);
});

export default router;
