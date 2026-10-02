/** Sale-order releasing — the warehouse side of the SO pipeline. Mounted at /api/release-slips.
 *  - GET /queue: approved SOs waiting for the warehouse to accept, and accepted ones being picked.
 *  - GET / and /:id: issued release slips (the record of what physically left).
 *  The actions themselves live on the order (orders.routes.ts): /accept-release, /release,
 *  /release-slip. Photos of the outgoing goods are `attachments` kind 'release' on the slip id. */
import { Router, type Request } from 'express';
import { queryOne, queryAll, run, setSetting } from '../../shared/db';
import { requireAuth, requireAnyPermission, requirePermission } from '../../shared/auth';
import {
  parseBody, releaseAuthorizationSchema, revokeReleaseAuthorizationSchema, releaseReportSchema, resolveReleaseReportSchema,
} from '../../shared/validation';
import type { ReleaseSlip, ReleaseSlipItem } from '../../shared/types';
import { syncClass } from '../../sync';
import { authorizationRequired, currentAuthorization, newToken, packageItemsFor, publicAuthorization, tokenError } from './release-auth';

const router = Router();
router.use(requireAuth);

// Same people who release (orders.routes.ts releaseGate), plus anyone who can see orders.
const viewGate = requireAnyPermission(['inventory.adjust', 'orders.release', 'orders.view']);
const releaseGate = requireAnyPermission(['inventory.adjust', 'orders.release']);
const salesGate = requirePermission('orders.edit');
/** An order's home for offline decisions: its location's site (as orders.routes.ts). */
const orderSite = {
  home: (req: Request) => ({
    location: queryOne<{ location_id: number | null }>('SELECT location_id FROM orders WHERE id = ?', Number(req.params.id))?.location_id ?? null,
  }),
};
const saleOrder = (id: number) => queryOne<{ id: number; number: string; status: string; customer_name: string | null; location_id: number | null }>(
  "SELECT id, number, status, customer_name, location_id FROM orders WHERE id = ? AND type = 'sale'", id
);

// Per-order line progress: units reserved/sold + bulk released_qty against the ordered qty.
const PROGRESS_SQL = `
  (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi WHERE oi.order_id = o.id AND oi.item_id IS NOT NULL) AS qty_ordered,
  (SELECT COALESCE(SUM(MIN(oi.quantity, COALESCE(oi.released_qty, 0)
      + (SELECT COUNT(*) FROM job_order_units ju
          WHERE ju.order_id = o.id AND ju.product_item_id = oi.item_id AND ju.status IN ('reserved', 'sold')))), 0)
     FROM order_items oi WHERE oi.order_id = o.id AND oi.item_id IS NOT NULL) AS qty_released`;

// GET /api/release-slips/queue — { to_accept, releasing }
router.get('/queue', viewGate, (req, res) => {
  const rows = queryAll<Record<string, unknown>>(
    `SELECT o.id, o.number, o.status, o.customer_name, o.order_date, o.expected_date,
            o.warehouse_accepted_at, wa.full_name AS warehouse_accepted_by_name,
            ${PROGRESS_SQL}
     FROM orders o
     LEFT JOIN users wa ON wa.id = o.warehouse_accepted_by
     WHERE o.type = 'sale' AND LOWER(o.status) IN ('approved', 'released')
       AND NOT EXISTS (SELECT 1 FROM release_slips rs WHERE rs.order_id = o.id)
     ORDER BY COALESCE(o.expected_date, '9999-12-31'), o.id`
  );
  // Mobile Releasing (Figma 78:16): each order's authorization (masked), what is leaving, its
  // delivery booking and open release reports; plus the caller's slips today.
  for (const r of rows) {
    const id = Number(r.id);
    r.authorization = publicAuthorization(id);
    r.summary = queryOne<{ first_name: string | null; lines: number }>(
      'SELECT MIN(name) AS first_name, COUNT(*) AS lines FROM order_items WHERE order_id = ? AND item_id IS NOT NULL', id
    );
    r.delivery = queryOne('SELECT number, scheduled_date, status FROM deliveries WHERE order_id = ? ORDER BY id DESC LIMIT 1', id) ?? null;
    r.open_reports = queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM release_reports WHERE order_id = ? AND status = 'open'", id)!.n;
  }
  const completed = queryAll(
    `SELECT rs.id, rs.number, rs.order_id, rs.released_at, o.number AS order_number, o.customer_name, d.mode
     FROM release_slips rs JOIN orders o ON o.id = rs.order_id LEFT JOIN release_slip_details d ON d.slip_id = rs.id
     WHERE rs.released_by = ? AND rs.released_at >= datetime('now', 'start of day') ORDER BY rs.id DESC LIMIT 50`,
    req.user!.id
  );
  res.json({
    to_accept: rows.filter((r) => !r.warehouse_accepted_at),
    releasing: rows.filter((r) => r.warehouse_accepted_at),
    completed,
    authorization_required: authorizationRequired(),
  });
});

/* GET /api/release-slips/orders/:id/context — everything the releaser needs for one order
   (Figma 78:68 to 78:481): lines with coverage, the units allocated to it (with their stock
   receipt), the authorization (masked), package checklist, open reports, and its slip. */
router.get('/orders/:id/context', releaseGate, (req, res) => {
  const id = Number(req.params.id);
  const order = saleOrder(id);
  if (!order) { res.status(404).json({ error: 'Sale order not found' }); return; }
  const lines = queryAll(
    `SELECT oi.id, oi.item_id, oi.name, oi.sku, oi.quantity, oi.released_qty,
            (SELECT COUNT(*) FROM job_order_units u WHERE u.order_id = oi.order_id AND u.product_item_id = oi.item_id
               AND u.status IN ('reserved', 'sold')) AS units,
            EXISTS (SELECT 1 FROM job_order_units u WHERE u.product_item_id = oi.item_id) AS serialized
     FROM order_items oi WHERE oi.order_id = ? ORDER BY oi.sort, oi.id`, id
  );
  const units = queryAll(
    `SELECT u.id, u.identifier, u.status, u.product_item_id, j.product_name, l.name AS location_name,
            (SELECT r.number FROM production_receipt_items ri JOIN production_receipts r ON r.id = ri.receipt_id
              WHERE ri.unit_id = u.id ORDER BY ri.id DESC LIMIT 1) AS receipt_number
     FROM job_order_units u JOIN job_orders j ON j.id = u.job_order_id LEFT JOIN locations l ON l.id = u.location_id
     WHERE u.order_id = ? AND u.status IN ('reserved', 'sold') ORDER BY u.id`, id
  );
  const accepted = queryOne<{ warehouse_accepted_at: string | null }>('SELECT warehouse_accepted_at FROM orders WHERE id = ?', id);
  res.json({
    order: { id, number: order.number, status: order.status, customer_name: order.customer_name,
      warehouse_accepted_at: accepted?.warehouse_accepted_at ?? null, location_id: order.location_id },
    lines, units,
    authorization: publicAuthorization(id),
    package: packageItemsFor(id),
    reports: queryAll("SELECT id, kind, description, unit_identifier, created_at FROM release_reports WHERE order_id = ? AND status = 'open' ORDER BY id", id),
    delivery: queryOne('SELECT number, scheduled_date, status FROM deliveries WHERE order_id = ? ORDER BY id DESC LIMIT 1', id) ?? null,
    slip: queryOne(
      `SELECT rs.id, rs.number, rs.released_at, rs.collected_by, u.full_name AS released_by_name, d.backorder_order_id,
              bo.number AS backorder_number
       FROM release_slips rs LEFT JOIN users u ON u.id = rs.released_by LEFT JOIN release_slip_details d ON d.slip_id = rs.id
       LEFT JOIN orders bo ON bo.id = d.backorder_order_id WHERE rs.order_id = ?`, id
    ) ?? null,
  });
});

/* GET /api/release-slips/orders/:id/unit?code= — what a scanned label is, for this order
   (78:147 / 78:365). Read-only: allocating it is POST /orders/:id/release. */
router.get('/orders/:id/unit', releaseGate, (req, res) => {
  const id = Number(req.params.id);
  const code = String(req.query.code ?? '').trim();
  if (!saleOrder(id)) { res.status(404).json({ error: 'Sale order not found' }); return; }
  const u = queryOne<{ id: number; identifier: string | null; status: string; order_id: number | null; product_item_id: number | null;
    product_name: string; location_name: string | null; order_number: string | null; receipt_number: string | null }>(
    `SELECT u.id, u.identifier, u.status, u.order_id, u.product_item_id, j.product_name, l.name AS location_name, o.number AS order_number,
            (SELECT r.number FROM production_receipt_items ri JOIN production_receipts r ON r.id = ri.receipt_id
              WHERE ri.unit_id = u.id ORDER BY ri.id DESC LIMIT 1) AS receipt_number
     FROM job_order_units u JOIN job_orders j ON j.id = u.job_order_id LEFT JOIN locations l ON l.id = u.location_id
     LEFT JOIN orders o ON o.id = u.order_id
     WHERE LOWER(TRIM(u.identifier)) = LOWER(?) ORDER BY u.id DESC LIMIT 1`, code
  );
  if (!u) { res.json({ state: 'not_found', code }); return; }
  const onOrder = queryOne('SELECT 1 FROM order_items WHERE order_id = ? AND item_id = ?', id, u.product_item_id);
  const state = u.order_id === id && (u.status === 'reserved' || u.status === 'sold') ? 'allocated'
    : u.order_id && u.order_id !== id && u.status === 'reserved' ? 'other_order'
    : !onOrder ? 'wrong_product'
    : u.status === 'in_stock' ? 'available' : 'unavailable';
  res.json({ state, unit: u });
});

/* GET /api/release-slips/orders/:id/verify-token?token= — check the token the recipient
   presents (78:240) before handoff. The slip re-checks it. */
router.get('/orders/:id/verify-token', releaseGate, (req, res) => {
  const id = Number(req.params.id);
  if (!saleOrder(id)) { res.status(404).json({ error: 'Sale order not found' }); return; }
  const err = tokenError(id, String(req.query.token ?? ''));
  res.json(err ? { ok: false, error: err } : { ok: true });
});

/* Sales: list / issue / revoke an order's release authorizations (desktop sale order). */
router.get('/orders/:id/authorizations', requireAnyPermission(['orders.view', 'orders.edit']), (req, res) => {
  const id = Number(req.params.id);
  const showToken = req.user!.permissions.includes('orders.edit');
  const rows = queryAll<Record<string, unknown>>(
    `SELECT a.*, u.full_name AS issued_by_name, rv.full_name AS revoked_by_name FROM release_authorizations a
     LEFT JOIN users u ON u.id = a.issued_by LEFT JOIN users rv ON rv.id = a.revoked_by WHERE a.order_id = ? ORDER BY a.id DESC`, id
  ).map((a) => ({ ...a, token: showToken ? a.token : String(a.token).split('-')[0] + '-••••',
    id_reference: a.id_last4 ? '••' + a.id_last4 : null }));
  res.json({ current: publicAuthorization(id), history: rows, required: authorizationRequired() });
});

router.post('/orders/:id/authorizations', salesGate, syncClass('claim', orderSite), (req, res) => {
  const id = Number(req.params.id);
  if (!saleOrder(id)) { res.status(404).json({ error: 'Sale order not found' }); return; }
  if (queryOne('SELECT 1 FROM release_slips WHERE order_id = ?', id)) { res.status(409).json({ error: 'This order was already released.' }); return; }
  const input = parseBody(releaseAuthorizationSchema, req.body);
  const last4 = input.id_reference ? input.id_reference.replace(/[^0-9A-Za-z]/g, '').slice(-4) || null : null;
  const token = newToken(input.mode);
  run(
    `UPDATE release_authorizations SET revoked_at = datetime('now'), revoked_by = ?, revoke_reason = 'Replaced by a new authorization'
     WHERE order_id = ? AND revoked_at IS NULL AND used_slip_id IS NULL`, req.user!.id, id
  );
  run(
    `INSERT INTO release_authorizations (order_id, mode, recipient_name, id_last4, token, valid_until, handoff_area, partial_allowed, notes, issued_by)
     VALUES (?, ?, ?, ?, ?, datetime('now', ?), ?, ?, ?, ?)`,
    id, input.mode, input.recipient_name, last4, token, `+${Math.round(input.valid_hours * 60)} minutes`, input.handoff_area ?? null,
    input.partial_allowed ? 1 : 0, input.notes ?? null, req.user!.id
  );
  res.status(201).json({ token, authorization: publicAuthorization(id) });
});

router.post('/orders/:id/authorizations/revoke', salesGate, syncClass('claim', orderSite), (req, res) => {
  const id = Number(req.params.id);
  const { auth, state } = currentAuthorization(id);
  if (!auth || (state !== 'valid' && state !== 'expired')) { res.status(409).json({ error: 'No active release authorization to revoke.' }); return; }
  const { reason } = parseBody(revokeReleaseAuthorizationSchema, req.body);
  run("UPDATE release_authorizations SET revoked_at = datetime('now'), revoked_by = ?, revoke_reason = ? WHERE id = ?", req.user!.id, reason, auth.id);
  res.json({ ok: true, authorization: publicAuthorization(id) });
});

/* Release reports: the releaser flags a problem for Sales; Sales resolves it. */
router.post('/orders/:id/reports', releaseGate, syncClass('merge'), (req, res) => {
  const id = Number(req.params.id);
  if (!saleOrder(id)) { res.status(404).json({ error: 'Sale order not found' }); return; }
  const input = parseBody(releaseReportSchema, req.body);
  const rid = Number(run(
    'INSERT INTO release_reports (order_id, kind, description, unit_identifier, reported_by) VALUES (?, ?, ?, ?, ?)',
    id, input.kind, input.description, input.unit_identifier ?? null, req.user!.id
  ).lastInsertRowid);
  res.status(201).json({ id: rid });
});

router.get('/reports/list', requireAnyPermission(['orders.view', 'orders.edit']), (req, res) => {
  const orderId = req.query.order_id ? Number(req.query.order_id) : null;
  const status = req.query.status === 'resolved' ? 'resolved' : req.query.status === 'all' ? null : 'open';
  const where: string[] = []; const params: unknown[] = [];
  if (orderId) { where.push('r.order_id = ?'); params.push(orderId); }
  if (status) { where.push('r.status = ?'); params.push(status); }
  res.json(queryAll(
    `SELECT r.*, o.number AS order_number, u.full_name AS reported_by_name FROM release_reports r JOIN orders o ON o.id = r.order_id
     LEFT JOIN users u ON u.id = r.reported_by ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.id DESC LIMIT 200`, ...params
  ));
});

router.post('/reports/:rid/resolve', salesGate, syncClass('merge'), (req, res) => {
  const rid = Number(req.params.rid);
  const r = queryOne<{ status: string }>('SELECT status FROM release_reports WHERE id = ?', rid);
  if (!r) { res.status(404).json({ error: 'Report not found' }); return; }
  if (r.status === 'resolved') { res.status(409).json({ error: 'Already resolved' }); return; }
  const { resolution } = parseBody(resolveReleaseReportSchema, req.body);
  run("UPDATE release_reports SET status = 'resolved', resolution = ?, resolved_by = ?, resolved_at = datetime('now') WHERE id = ?",
    resolution ?? null, req.user!.id, rid);
  res.json({ ok: true });
});

/* Company policy: require a release authorization for every sale order (default off). */
router.get('/policy', viewGate, (_req, res) => { res.json({ authorization_required: authorizationRequired() }); });
router.put('/policy', salesGate, syncClass('claim'), (req, res) => {
  setSetting('release_authorization_required', req.body?.authorization_required === true);
  res.json({ authorization_required: authorizationRequired() });
});

const SLIP_SELECT = `
  SELECT rs.*, o.number AS order_number, o.customer_name, o.customer_contact, o.status AS order_status,
         u.full_name AS released_by_name,
         (SELECT COUNT(*) FROM attachments a WHERE a.kind = 'release' AND a.ref_id = rs.id) AS photo_count
  FROM release_slips rs
  JOIN orders o ON o.id = rs.order_id
  LEFT JOIN users u ON u.id = rs.released_by`;

// GET /api/release-slips?q= — issued slips, newest first
router.get('/', viewGate, (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const rows = q
    ? queryAll<ReleaseSlip>(
        `${SLIP_SELECT} WHERE rs.number LIKE ? OR o.number LIKE ? OR o.customer_name LIKE ? OR rs.collected_by LIKE ?
         ORDER BY rs.id DESC LIMIT 500`,
        `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`)
    : queryAll<ReleaseSlip>(`${SLIP_SELECT} ORDER BY rs.id DESC LIMIT 500`);
  res.json(rows);
});

// GET /api/release-slips/:id — slip + its line snapshot
router.get('/:id', viewGate, (req, res) => {
  const slip = queryOne<ReleaseSlip>(`${SLIP_SELECT} WHERE rs.id = ?`, Number(req.params.id));
  if (!slip) { res.status(404).json({ error: 'Release slip not found' }); return; }
  slip.items = queryAll<ReleaseSlipItem>('SELECT * FROM release_slip_items WHERE slip_id = ? ORDER BY id', slip.id);
  res.json(slip);
});

export default router;
