/** Job & Sale Orders: stored records with line items, auto numbers, server-computed
    totals. One router serves both types (?type=sale|job). */
import { Router } from 'express';
import { db, queryOne, queryAll, run, getSetting, setSetting } from '../db';
import { requireAuth } from '../auth';
import { parseBody, createOrderSchema, updateOrderSchema } from '../validation';
import type { Order, OrderItem, OrderType } from '../types';

const router = Router();
router.use(requireAuth);

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

type LineInput = {
  item_id?: number | null; name: string; sku?: string | null; description?: string | null;
  quantity: number; unit?: string | null; unit_price: number;
};

/** Compute line totals + subtotal/tax/total from raw line inputs (never trust the client). */
function computeTotals(items: LineInput[], taxPercent: number) {
  const lines = items.map((it) => ({ ...it, line_total: round2((it.quantity || 0) * (it.unit_price || 0)) }));
  const subtotal = round2(lines.reduce((s, l) => s + l.line_total, 0));
  const tax_amount = round2((subtotal * (taxPercent || 0)) / 100);
  const total = round2(subtotal + tax_amount);
  return { lines, subtotal, tax_amount, total };
}

/** Next order number for a type, e.g. SO-00001 / JO-00001 (counter in settings). */
function nextOrderNumber(type: OrderType): string {
  const key = `order_seq_${type}`;
  const next = (getSetting<number>(key) || 0) + 1;
  setSetting(key, next);
  const prefix = type === 'sale' ? 'SO' : 'JO';
  return `${prefix}-${String(next).padStart(5, '0')}`;
}

function insertItems(orderId: number, lines: ReturnType<typeof computeTotals>['lines']): void {
  lines.forEach((l, i) => {
    run(
      `INSERT INTO order_items
        (order_id, item_id, name, sku, description, quantity, unit, unit_price, line_total, sort)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      orderId,
      l.item_id ?? null,
      l.name,
      l.sku ?? null,
      l.description ?? null,
      l.quantity,
      l.unit ?? null,
      l.unit_price,
      l.line_total,
      i
    );
  });
}

// GET /api/orders?type=&q=
router.get('/', (req, res) => {
  const { type, q } = req.query;
  const where: string[] = [];
  const params: unknown[] = [];
  if (type === 'sale' || type === 'job') { where.push('o.type = ?'); params.push(type); }
  if (typeof q === 'string' && q.trim()) {
    where.push('(o.number LIKE ? OR o.customer_name LIKE ?)');
    const like = `%${q.trim()}%`;
    params.push(like, like);
  }
  const rows = queryAll<Order>(
    `SELECT o.*, u.full_name AS created_by_name
     FROM orders o LEFT JOIN users u ON u.id = o.created_by
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY o.id DESC`,
    ...params
  );
  res.json(rows);
});

// GET /api/orders/:id — order + line items
router.get('/:id', (req, res) => {
  const order = queryOne<Order>(
    `SELECT o.*, u.full_name AS created_by_name
     FROM orders o LEFT JOIN users u ON u.id = o.created_by WHERE o.id = ?`,
    Number(req.params.id)
  );
  if (!order) {
    res.status(404).json({ error: 'Order not found' });
    return;
  }
  order.items = queryAll<OrderItem>(
    'SELECT * FROM order_items WHERE order_id = ? ORDER BY sort, id',
    order.id
  );
  res.json(order);
});

// POST /api/orders — create with auto number + computed totals
router.post('/', (req, res) => {
  const input = parseBody(createOrderSchema, req.body);
  const { lines, subtotal, tax_amount, total } = computeTotals(input.items, input.tax_percent);

  db.exec('BEGIN');
  try {
    const number = nextOrderNumber(input.type);
    const info = run(
      `INSERT INTO orders
        (type, number, customer_name, customer_contact, order_date, status, notes, currency,
         subtotal, tax_percent, tax_amount, total, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.type,
      number,
      input.customer_name ?? null,
      input.customer_contact ?? null,
      input.order_date ?? null,
      input.status || 'open',
      input.notes ?? null,
      input.currency || 'PHP',
      subtotal,
      input.tax_percent,
      tax_amount,
      total,
      req.user!.id
    );
    insertItems(Number(info.lastInsertRowid), lines);
    db.exec('COMMIT');
    res.status(201).json({ id: info.lastInsertRowid, number });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
});

// PUT /api/orders/:id — replace header + items, recompute totals (type/number unchanged)
router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const order = queryOne<Order>('SELECT * FROM orders WHERE id = ?', id);
  if (!order) {
    res.status(404).json({ error: 'Order not found' });
    return;
  }
  const input = parseBody(updateOrderSchema, req.body);
  const { lines, subtotal, tax_amount, total } = computeTotals(input.items, input.tax_percent);

  db.exec('BEGIN');
  try {
    run(
      `UPDATE orders SET customer_name = ?, customer_contact = ?, order_date = ?, status = ?,
         notes = ?, currency = ?, subtotal = ?, tax_percent = ?, tax_amount = ?, total = ?,
         updated_at = datetime('now')
       WHERE id = ?`,
      input.customer_name ?? null,
      input.customer_contact ?? null,
      input.order_date ?? null,
      input.status || 'open',
      input.notes ?? null,
      input.currency || 'PHP',
      subtotal,
      input.tax_percent,
      tax_amount,
      total,
      id
    );
    run('DELETE FROM order_items WHERE order_id = ?', id);
    insertItems(id, lines);
    db.exec('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
});

// DELETE /api/orders/:id (cascades items)
router.delete('/:id', (req, res) => {
  const info = run('DELETE FROM orders WHERE id = ?', Number(req.params.id));
  if (info.changes === 0) {
    res.status(404).json({ error: 'Order not found' });
    return;
  }
  res.json({ ok: true });
});

export default router;
