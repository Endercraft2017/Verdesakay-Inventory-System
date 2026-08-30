/** Customers registry — the AR-side counterpart of suppliers. Sale orders point at one
    via orders.customer_id; payments + AR aging net down against it. */
import { Router } from 'express';
import { queryOne, queryAll, run } from '../db';
import { requireAuth, requirePermission } from '../auth';
import { parseBody, createCustomerSchema, updateCustomerSchema } from '../validation';
import type { Customer } from '../types';

const router = Router();
router.use(requireAuth);

const LIST_SQL = `
  SELECT c.*,
    (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id AND o.type = 'sale') AS order_count
  FROM customers c
`;

// GET /api/customers?q=&archived=1
router.get('/', requirePermission('orders.view'), (req, res) => {
  const { q, archived } = req.query;
  const where: string[] = [];
  const params: unknown[] = [];
  if (archived !== '1') where.push('c.archived = 0');
  if (typeof q === 'string' && q.trim()) {
    where.push('(c.name LIKE ? OR c.contact_person LIKE ? OR c.email LIKE ? OR c.phone LIKE ? OR c.tin LIKE ?)');
    const like = `%${q.trim()}%`;
    params.push(like, like, like, like, like);
  }
  const sql = LIST_SQL + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY c.name COLLATE NOCASE';
  res.json(queryAll<Customer>(sql, ...params));
});

// GET /api/customers/:id — one customer + its recent sale orders
router.get('/:id', requirePermission('orders.view'), (req, res) => {
  const customer = queryOne<Customer>(LIST_SQL + ' WHERE c.id = ?', Number(req.params.id));
  if (!customer) { res.status(404).json({ error: 'Customer not found' }); return; }
  customer.orders = queryAll<NonNullable<Customer['orders']>[number]>(
    `SELECT id, number, order_date, status, total FROM orders
     WHERE customer_id = ? AND type = 'sale' ORDER BY id DESC LIMIT 50`,
    customer.id
  );
  res.json(customer);
});

// POST /api/customers
router.post('/', requirePermission('orders.create'), (req, res) => {
  const b = parseBody(createCustomerSchema, req.body);
  const info = run(
    `INSERT INTO customers (name, contact_person, phone, email, address, tin, payment_terms_days, notes, archived)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    b.name, b.contact_person ?? null, b.phone ?? null, b.email ?? null, b.address ?? null,
    b.tin ?? null, b.payment_terms_days ?? 0, b.notes ?? null, b.archived ? 1 : 0
  );
  res.status(201).json({ id: Number(info.lastInsertRowid) });
});

// PUT /api/customers/:id
router.put('/:id', requirePermission('orders.edit'), (req, res) => {
  const id = Number(req.params.id);
  const cur = queryOne<Customer>('SELECT * FROM customers WHERE id = ?', id);
  if (!cur) { res.status(404).json({ error: 'Customer not found' }); return; }
  const b = parseBody(updateCustomerSchema, req.body);
  const pick = <K extends keyof Customer>(k: K, v: unknown) => (v !== undefined ? v : cur[k]);
  run(
    `UPDATE customers SET name = ?, contact_person = ?, phone = ?, email = ?, address = ?,
       tin = ?, payment_terms_days = ?, notes = ?, archived = ?, updated_at = datetime('now')
     WHERE id = ?`,
    b.name ?? cur.name,
    pick('contact_person', b.contact_person), pick('phone', b.phone), pick('email', b.email),
    pick('address', b.address), pick('tin', b.tin),
    b.payment_terms_days !== undefined ? b.payment_terms_days : cur.payment_terms_days,
    pick('notes', b.notes),
    b.archived !== undefined ? (b.archived ? 1 : 0) : cur.archived,
    id
  );
  res.json({ ok: true });
});

// DELETE /api/customers/:id — sale orders keep their history; their customer_id goes NULL (FK).
router.delete('/:id', requirePermission('orders.delete'), (req, res) => {
  const info = run('DELETE FROM customers WHERE id = ?', Number(req.params.id));
  if (info.changes === 0) { res.status(404).json({ error: 'Customer not found' }); return; }
  res.json({ ok: true });
});

export default router;
