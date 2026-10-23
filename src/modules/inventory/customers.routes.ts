/** Customers registry — the AR-side counterpart of suppliers. Sale orders point at one
    via orders.customer_id; payments + AR aging net down against it. */
import { Router } from 'express';
import { queryOne, queryAll, run } from '../../shared/db';
import { requireAuth, requirePermission } from '../../shared/auth';
import { syncClass } from '../../sync';
import { parseBody, createCustomerSchema, updateCustomerSchema } from '../../shared/validation';
import { normalizePhone, normalizeEmail } from '../../shared/contact';
import { canReadCases, caseError } from './customer-cases';
import type { Customer } from '../../shared/types';

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
    where.push('(c.name LIKE ? OR c.contact_person LIKE ? OR c.email LIKE ? OR c.phone LIKE ? OR c.tin LIKE ? OR c.facebook_name LIKE ? OR c.phone_normalized = ?)');
    const like = `%${q.trim()}%`;
    params.push(like, like, like, like, like, like, normalizePhone(q) || null);
  }
  const sql = LIST_SQL + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY c.name COLLATE NOCASE';
  res.json(queryAll<Customer>(sql, ...params));
});

// Suggestions include archived customers; staff decide identity, never auto-merge.
router.get('/matches', requirePermission('orders.view'), (req, res) => {
  const v = (key: string) => typeof req.query[key] === 'string' ? String(req.query[key]).trim() : '';
  const phone = normalizePhone(v('phone')); const email = normalizeEmail(v('email'));
  res.json(queryAll(`SELECT id,name,phone,email,facebook_name,archived FROM customers
    WHERE id<>? AND ((?<>'' AND phone_normalized=?) OR (?<>'' AND email_normalized=?)
      OR (?<>'' AND lower(trim(name))=lower(?)) OR (?<>'' AND lower(trim(facebook_name))=lower(?)))
    ORDER BY archived,name LIMIT 20`, Number(v('exclude')) || 0,
    phone,phone,email,email,v('name'),v('name'),v('facebook_name'),v('facebook_name')));
});

// Search sale references without limiting linking to the profile's recent 50 orders.
router.get('/:id/sales', requirePermission('orders.view'), (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  res.json(queryAll(`SELECT id,number,status FROM orders WHERE type='sale' AND customer_id=? AND number LIKE ? ORDER BY id DESC LIMIT 20`,
    Number(req.params.id),`%${q}%`));
});

router.get('/:id/cases', requirePermission('orders.view'), requirePermission('cases.view'), (req, res) => {
  res.json(queryAll(`SELECT c.*,u.full_name AS owner_name,cu.name AS customer_name,u.active=0 AS owner_inactive
    FROM customer_cases c JOIN users u ON u.id=c.owner_id JOIN customers cu ON cu.id=c.customer_id
    WHERE c.customer_id=? ORDER BY c.status IN ('resolved','cancelled'),c.due_at,c.id LIMIT 51 OFFSET ?`,
    Number(req.params.id),Math.max(0,Number(req.query.offset)||0)));
});

router.get('/:id/history', requirePermission('orders.view'), (req, res) => {
  if (!queryOne('SELECT id FROM customers WHERE id=?', Number(req.params.id))) caseError(404, 'Customer not found');
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const includeCases = canReadCases(req.user!);
  const caseSQL = includeCases ? ` UNION ALL
    SELECT 'case' AS kind,e.id AS entry_id,e.case_id AS ref_id,e.created_at AS occurred_at,
      json_extract(e.snapshot,'$.summary') AS title,e.actor_name,e.event_type,e.note,e.snapshot
    FROM customer_case_events e JOIN customer_cases c ON c.id=e.case_id WHERE c.customer_id=?` : '';
  const params: unknown[] = [Number(req.params.id)];
  if (includeCases) params.push(Number(req.params.id));
  res.json(queryAll(`SELECT * FROM (
    SELECT 'sale' AS kind,o.id AS entry_id,o.id AS ref_id,
      strftime('%Y-%m-%dT%H:%M:%fZ',o.created_at) AS occurred_at,o.number AS title,
      u.full_name AS actor_name,'sale' AS event_type,o.status AS note,NULL AS snapshot
    FROM orders o LEFT JOIN users u ON u.id=o.created_by WHERE o.type='sale' AND o.customer_id=?
    ${caseSQL}) ORDER BY occurred_at DESC,kind,entry_id DESC LIMIT 51 OFFSET ?`, ...params, offset));
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
router.post('/', requirePermission('orders.create'), syncClass('merge'), (req, res) => {
  const b = parseBody(createCustomerSchema, req.body);
  const info = run(
    `INSERT INTO customers (name, contact_person, phone, email, address, tin, payment_terms_days, notes, archived, facebook_name, facebook_url, phone_normalized, email_normalized)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    b.name, b.contact_person ?? null, b.phone ?? null, b.email ?? null, b.address ?? null,
    b.tin ?? null, b.payment_terms_days ?? 0, b.notes ?? null, b.archived ? 1 : 0,
    b.facebook_name ?? null, b.facebook_url ?? null, normalizePhone(b.phone), normalizeEmail(b.email)
  );
  res.status(201).json({ id: Number(info.lastInsertRowid) });
});

// PUT /api/customers/:id
router.put('/:id', requirePermission('orders.edit'), syncClass('claim'), (req, res) => {
  const id = Number(req.params.id);
  const cur = queryOne<Customer>('SELECT * FROM customers WHERE id = ?', id);
  if (!cur) { res.status(404).json({ error: 'Customer not found' }); return; }
  const b = parseBody(updateCustomerSchema, req.body);
  if (b.version !== cur.version) caseError(409, 'Customer changed. Reopen the profile before saving.');
  const pick = <K extends keyof Customer>(k: K, v: unknown) => (v !== undefined ? v : cur[k]);
  const saved = run(
    `UPDATE customers SET name = ?, contact_person = ?, phone = ?, email = ?, address = ?,
       tin = ?, payment_terms_days = ?, notes = ?, archived = ?, facebook_name = ?, facebook_url = ?,
       phone_normalized = ?, email_normalized = ?, version = version + 1, updated_at = datetime('now')
     WHERE id = ? AND version = ?`,
    b.name ?? cur.name,
    pick('contact_person', b.contact_person), pick('phone', b.phone), pick('email', b.email),
    pick('address', b.address), pick('tin', b.tin),
    b.payment_terms_days !== undefined ? b.payment_terms_days : cur.payment_terms_days,
    pick('notes', b.notes),
    b.archived !== undefined ? (b.archived ? 1 : 0) : cur.archived,
    pick('facebook_name', b.facebook_name), pick('facebook_url', b.facebook_url),
    normalizePhone((b.phone !== undefined ? b.phone : cur.phone)), normalizeEmail((b.email !== undefined ? b.email : cur.email)),
    id, b.version
  );
  if (!saved.changes) caseError(409, 'Customer changed. Reopen before saving.');
  res.json({ ok: true, version: b.version + 1 });
});

// DELETE /api/customers/:id — sale orders keep their history; their customer_id goes NULL (FK).
router.delete('/:id', requirePermission('orders.delete'), syncClass('claim'), (req, res) => {
  let info;
  try { info = run('DELETE FROM customers WHERE id = ?', Number(req.params.id)); }
  catch(e) { if (/history|FOREIGN KEY/.test(String(e))) caseError(409, 'Customer has history; archive instead'); throw e; }
  if (info.changes === 0) { res.status(404).json({ error: 'Customer not found' }); return; }
  res.json({ ok: true });
});

export default router;
