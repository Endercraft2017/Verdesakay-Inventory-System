/** Sale-order releasing — the warehouse side of the SO pipeline. Mounted at /api/release-slips.
 *  - GET /queue: approved SOs waiting for the warehouse to accept, and accepted ones being picked.
 *  - GET / and /:id: issued release slips (the record of what physically left).
 *  The actions themselves live on the order (orders.routes.ts): /accept-release, /release,
 *  /release-slip. Photos of the outgoing goods are `attachments` kind 'release' on the slip id. */
import { Router } from 'express';
import { queryOne, queryAll } from '../../shared/db';
import { requireAuth, requireAnyPermission } from '../../shared/auth';
import type { ReleaseSlip, ReleaseSlipItem } from '../../shared/types';

const router = Router();
router.use(requireAuth);

// Same people who release (orders.routes.ts releaseGate), plus anyone who can see orders.
const viewGate = requireAnyPermission(['inventory.adjust', 'orders.release', 'orders.view']);

// Per-order line progress: units reserved/sold + bulk released_qty against the ordered qty.
const PROGRESS_SQL = `
  (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi WHERE oi.order_id = o.id AND oi.item_id IS NOT NULL) AS qty_ordered,
  (SELECT COALESCE(SUM(MIN(oi.quantity, COALESCE(oi.released_qty, 0)
      + (SELECT COUNT(*) FROM job_order_units ju
          WHERE ju.order_id = o.id AND ju.product_item_id = oi.item_id AND ju.status IN ('reserved', 'sold')))), 0)
     FROM order_items oi WHERE oi.order_id = o.id AND oi.item_id IS NOT NULL) AS qty_released`;

// GET /api/release-slips/queue — { to_accept, releasing }
router.get('/queue', viewGate, (_req, res) => {
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
  res.json({
    to_accept: rows.filter((r) => !r.warehouse_accepted_at),
    releasing: rows.filter((r) => r.warehouse_accepted_at),
  });
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
