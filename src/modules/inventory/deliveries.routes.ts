/** Field deliveries / drops + proof of delivery. Mounted at /api/deliveries.
 *  - `delivery.manage`: plan (create / reassign / cancel) and see every delivery.
 *  - `delivery.run`: see + complete the deliveries assigned to you.
 *  The POD (recipient, signature, GPS, photos) is captured on `/complete`;
 *  the signature + photos are `attachments` rows (kind 'signature' / 'delivery'). */
import { Router, type Request } from 'express';
import { queryOne, queryAll, run, nextSequence } from '../../shared/db';
import { requireAuth, requirePermission, requireAnyPermission } from '../../shared/auth';
import {
  parseBody, createDeliverySchema, updateDeliverySchema,
  deliveryStatusSchema, deliveryCompleteSchema,
} from '../../shared/validation';
import { notifyUser } from '../../shared/push';
import type { Delivery, OrderItem } from '../../shared/types';
import { recordSiteClash, syncClass } from '../../sync';
import { siteDecisionStands } from '../../shared/sync-context';

const router = Router();
router.use(requireAuth);

/** A delivery belongs to the site of its sale order's stock location; one without is the main
 *  site's (docs/OFFLINE-FIRST.md §16). */
const deliverySite = {
  home: (req: Request) => ({
    location: queryOne<{ location_id: number | null }>(
      'SELECT o.location_id FROM deliveries d JOIN orders o ON o.id = d.order_id WHERE d.id = ?', Number(req.params.id)
    )?.location_id ?? null,
  }),
};

const canManage = (req: Request) => req.user!.permissions.includes('delivery.manage');
const canRun = (req: Request) =>
  req.user!.permissions.includes('delivery.run') || req.user!.permissions.includes('delivery.manage');

const SELECT = `
  SELECT d.*, o.number AS order_number,
         a.full_name AS assigned_to_name, db.full_name AS delivered_by_name,
         (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = d.order_id) AS item_count,
         (SELECT COUNT(*) FROM attachments at WHERE at.kind = 'delivery' AND at.ref_id = d.id) AS photo_count
  FROM deliveries d
  LEFT JOIN orders o ON o.id = d.order_id
  LEFT JOIN users a ON a.id = d.assigned_to
  LEFT JOIN users db ON db.id = d.delivered_by`;

function load(id: number): Delivery | undefined {
  return queryOne<Delivery>(`${SELECT} WHERE d.id = ?`, id);
}
/** May the caller see / act on this delivery? */
function mayTouch(req: Request, d: Delivery): boolean {
  return canManage(req) || d.assigned_to === req.user!.id;
}

/** Starting a trip is allowed before warehouse-out (owner decision). A delivered
 * physical sale still needs its numbered warehouse handoff; failures move no stock. */
function missingSaleSlip(d: Delivery): boolean {
  if (!d.order_id) return false;
  const row = queryOne<{ required: number; issued: number }>(
    `SELECT EXISTS(SELECT 1 FROM order_items oi WHERE oi.order_id = o.id
       AND oi.item_id IS NOT NULL AND oi.fulfillment_mode != 'ckd') AS required,
       EXISTS(SELECT 1 FROM release_slips rs WHERE rs.order_id = o.id) AS issued
     FROM orders o WHERE o.id = ? AND o.type = 'sale'`, d.order_id);
  return !!row?.required && !row.issued;
}

// GET /api/deliveries — manage: all (filters); run-only: mine
router.get('/', requireAnyPermission(['delivery.run', 'delivery.manage']), (req, res) => {
  const where: string[] = [];
  const params: unknown[] = [];
  if (!canManage(req) || req.query.mine === '1') { where.push('d.assigned_to = ?'); params.push(req.user!.id); }
  if (typeof req.query.status === 'string' && req.query.status) { where.push('d.status = ?'); params.push(req.query.status); }
  if (typeof req.query.date === 'string' && req.query.date) { where.push('d.scheduled_date = ?'); params.push(req.query.date); }
  if (typeof req.query.order_id === 'string' && /^\d+$/.test(req.query.order_id)) { where.push('d.order_id = ?'); params.push(Number(req.query.order_id)); }
  if (typeof req.query.assigned_to === 'string' && req.query.assigned_to && canManage(req)) {
    where.push('d.assigned_to = ?'); params.push(Number(req.query.assigned_to));
  }
  const rows = queryAll<Delivery>(
    `${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY (d.status IN ('delivered','failed','cancelled')), d.scheduled_date, d.id DESC`,
    ...params
  );
  res.json(rows);
});

// GET /api/deliveries/:id — one delivery + its order lines + POD attachments
router.get('/:id', requireAnyPermission(['delivery.run', 'delivery.manage']), (req, res) => {
  const d = load(Number(req.params.id));
  if (!d) { res.status(404).json({ error: 'Delivery not found' }); return; }
  if (!mayTouch(req, d)) { res.status(403).json({ error: 'Not your delivery' }); return; }
  const items = d.order_id
    ? queryAll<OrderItem>('SELECT id, item_id, name, sku, quantity, unit FROM order_items WHERE order_id = ? ORDER BY sort, id', d.order_id)
    : [];
  const photos = queryAll<{ id: number }>(
    "SELECT id FROM attachments WHERE kind = 'delivery' AND ref_id = ? ORDER BY id", d.id
  ).map((r) => ({ id: r.id, url: `/api/attachments/${r.id}/image` }));
  res.json({
    ...d,
    items,
    photos,
    signature_url: d.pod_signature_attachment_id ? `/api/attachments/${d.pod_signature_attachment_id}/image` : null,
  });
});

// POST /api/deliveries — create (delivery.manage)
router.post('/', requirePermission('delivery.manage'), syncClass('merge'), (req, res) => {
  const input = parseBody(createDeliverySchema, req.body);
  if (input.delivery_mode === 'courier' && !input.courier_name?.trim()) {
    res.status(400).json({ error: 'Name the courier before booking pickup.' }); return;
  }
  if (input.order_id && queryOne(
    "SELECT 1 FROM deliveries WHERE order_id = ? AND status IN ('pending', 'out_for_delivery') LIMIT 1", input.order_id)) {
    res.status(409).json({ error: 'This sale already has an active shipment booking. Complete or cancel it before choosing another delivery method.', code: 'shipment_already_booked' }); return;
  }
  let customer = input.customer_name ?? null;
  const address = input.address ?? null;
  if (input.order_id != null) {
    const o = queryOne<{ customer_name: string | null }>(
      'SELECT customer_name FROM orders WHERE id = ?', input.order_id
    );
    if (!o) { res.status(400).json({ error: 'Order not found' }); return; }
    if (!customer) customer = o.customer_name;
  }
  if (input.assigned_to != null && !queryOne('SELECT id FROM users WHERE id = ? AND active = 1', input.assigned_to)) {
    res.status(400).json({ error: 'Assigned user not found' }); return;
  }
  const number = nextSequence('delivery_seq', 'DEL');
  const info = run(
    `INSERT INTO deliveries
      (number, order_id, customer_name, address, contact_phone, scheduled_date, assigned_to, notes, created_by, delivery_mode, courier_name, tracking_number)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    number, input.order_id, customer, address, input.contact_phone ?? null,
    input.scheduled_date ?? null, input.assigned_to, input.notes ?? null, req.user!.id,
    input.delivery_mode, input.courier_name ?? null, input.tracking_number ?? null
  );
  const id = Number(info.lastInsertRowid);
  if (input.assigned_to && input.assigned_to !== req.user!.id) {
    void notifyUser(input.assigned_to, {
      title: 'Delivery assigned', body: `${number}${customer ? ' — ' + customer : ''}`,
      url: '#/deliveries', tag: 'del-' + id,
    });
  }
  res.status(201).json({ id, number });
});

// PUT /api/deliveries/:id — edit header / reassign (delivery.manage)
router.put('/:id', requirePermission('delivery.manage'), syncClass('claim', deliverySite), (req, res) => {
  const d = load(Number(req.params.id));
  if (!d) { res.status(404).json({ error: 'Delivery not found' }); return; }
  const input = parseBody(updateDeliverySchema, req.body);
  if (d.status !== 'pending' && (input.delivery_mode !== undefined || input.courier_name !== undefined || input.tracking_number !== undefined)) {
    res.status(409).json({ error: 'Delivery method and courier details are locked after handoff starts.' }); return;
  }
  if (input.assigned_to != null && !queryOne('SELECT id FROM users WHERE id = ? AND active = 1', input.assigned_to)) {
    res.status(400).json({ error: 'Assigned user not found' }); return;
  }
  const merged = {
    order_id: input.order_id !== undefined ? input.order_id : d.order_id,
    customer_name: input.customer_name !== undefined ? input.customer_name : d.customer_name,
    address: input.address !== undefined ? input.address : d.address,
    contact_phone: input.contact_phone !== undefined ? input.contact_phone : d.contact_phone,
    scheduled_date: input.scheduled_date !== undefined ? input.scheduled_date : d.scheduled_date,
    assigned_to: input.assigned_to !== undefined ? input.assigned_to : d.assigned_to,
    notes: input.notes !== undefined ? input.notes : d.notes,
    delivery_mode: input.delivery_mode !== undefined ? input.delivery_mode : d.delivery_mode,
    courier_name: input.courier_name !== undefined ? input.courier_name : d.courier_name,
    tracking_number: input.tracking_number !== undefined ? input.tracking_number : d.tracking_number,
  };
  if (merged.delivery_mode === 'courier' && !merged.courier_name?.trim()) {
    res.status(400).json({ error: 'Name the courier before booking pickup.' }); return;
  }
  if (merged.order_id && queryOne(
    "SELECT 1 FROM deliveries WHERE order_id = ? AND status IN ('pending', 'out_for_delivery') AND id != ? LIMIT 1", merged.order_id, d.id)) {
    res.status(409).json({ error: 'This sale already has an active shipment booking. Complete or cancel it before choosing another delivery method.', code: 'shipment_already_booked' }); return;
  }
  run(
    `UPDATE deliveries SET order_id = ?, customer_name = ?, address = ?, contact_phone = ?,
       scheduled_date = ?, assigned_to = ?, notes = ?, delivery_mode = ?, courier_name = ?, tracking_number = ?, updated_at = datetime('now')
     WHERE id = ?`,
    merged.order_id, merged.customer_name, merged.address, merged.contact_phone,
    merged.scheduled_date, merged.assigned_to, merged.notes, merged.delivery_mode, merged.courier_name, merged.tracking_number, d.id
  );
  if (merged.assigned_to && merged.assigned_to !== d.assigned_to && merged.assigned_to !== req.user!.id) {
    void notifyUser(merged.assigned_to, {
      title: 'Delivery assigned', body: `${d.number}${merged.customer_name ? ' — ' + merged.customer_name : ''}`,
      url: '#/deliveries', tag: 'del-' + d.id,
    });
  }
  res.json({ ok: true });
});

// POST /api/deliveries/:id/status — { status: 'out_for_delivery' | 'cancelled' }
router.post('/:id/status', requireAnyPermission(['delivery.run', 'delivery.manage']), syncClass('physical', deliverySite), (req, res) => {
  const d = load(Number(req.params.id));
  if (!d) { res.status(404).json({ error: 'Delivery not found' }); return; }
  if (!mayTouch(req, d)) { res.status(403).json({ error: 'Not your delivery' }); return; }
  const { status } = parseBody(deliveryStatusSchema, req.body);
  if (status === 'cancelled' && !canManage(req)) {
    res.status(403).json({ error: 'Only a delivery manager can cancel' }); return;
  }
  if (status === 'out_for_delivery' && d.delivery_mode === 'courier') {
    res.status(409).json({ error: 'Courier bookings close when the courier picks up; record courier handoff instead.', code: 'courier_handoff_required' }); return;
  }
  if (d.status === 'delivered' || d.status === 'cancelled') {
    // Clash-check (D6): finished on the cloud meanwhile — the cloud's outcome is kept, flagged.
    if (siteDecisionStands()) {
      recordSiteClash(req, `Delivery ${d.number} was marked ${status} at the site after it was ${d.status} on the cloud; ${d.status} was kept.`);
      res.json({ ok: true, clash: true, status: d.status });
      return;
    }
    res.status(409).json({ error: `This delivery is already ${d.status}` }); return;
  }
  run("UPDATE deliveries SET status = ?, updated_at = datetime('now') WHERE id = ?", status, d.id);
  res.json({ ok: true, status });
});

// POST /api/deliveries/:id/complete — the proof of delivery
router.post('/:id/complete', requireAnyPermission(['delivery.run', 'delivery.manage']), syncClass('physical', deliverySite), (req, res) => {
  const d = load(Number(req.params.id));
  if (!d) { res.status(404).json({ error: 'Delivery not found' }); return; }
  if (!mayTouch(req, d)) { res.status(403).json({ error: 'Not your delivery' }); return; }
  if (d.status === 'delivered' || d.status === 'cancelled') {
    // Clash-check (D6): the driver's proof of delivery stands over a cancellation made on the
    // cloud meanwhile; delivered on both sides keeps the first proof. Both are flagged.
    if (!siteDecisionStands()) {
      res.status(409).json({ error: `This delivery is already ${d.status}` }); return;
    }
    recordSiteClash(req, `Delivery ${d.number} was ${d.status} on the cloud when the site's proof of delivery arrived`
      + (d.status === 'delivered' ? '; the first proof was kept.' : '; the proof stands.'));
    if (d.status === 'delivered') { res.json({ ok: true, clash: true, status: d.status, order: null }); return; }
  }
  const input = parseBody(deliveryCompleteSchema, req.body);
  if ((input.outcome === 'delivered' || input.outcome === 'courier_handoff') && missingSaleSlip(d)) {
    res.status(409).json({ error: 'This sale has no warehouse release slip. Complete the stock handoff before closing delivery or courier pickup.', code: 'release_required' }); return;
  }
  // Own-driver recipient, photos, signature and GPS remain optional by owner policy.
  if (d.delivery_mode === 'courier' && input.outcome !== 'courier_handoff') {
    res.status(409).json({ error: 'Record courier pickup for this booking, not customer delivery.', code: 'courier_handoff_required' }); return;
  }
  if (d.delivery_mode !== 'courier' && input.outcome === 'courier_handoff') {
    res.status(409).json({ error: 'This booking uses our own delivery team.', code: 'wrong_delivery_mode' }); return;
  }
  if (input.outcome === 'courier_handoff' && (!input.recipient?.trim() || !d.courier_name?.trim())) {
    res.status(409).json({ error: 'Record the courier and the person who picked up the goods.', code: 'courier_recipient_required' }); return;
  }
  if (input.signature_attachment_id != null
    && !queryOne("SELECT id FROM attachments WHERE id = ? AND kind = 'signature' AND ref_id = ?",
      input.signature_attachment_id, d.id)) {
    res.status(400).json({ error: 'Signature attachment not found for this delivery' }); return;
  }
  if (input.outcome === 'courier_handoff' && input.signature_attachment_id == null && !queryOne(
    "SELECT 1 FROM attachments WHERE kind = 'delivery' AND ref_id = ? LIMIT 1", d.id)) {
    res.status(409).json({ error: 'Capture a courier pickup photo or signature before closing the handoff.', code: 'proof_required' }); return;
  }
  run(
    `UPDATE deliveries SET
       status = ?, pod_recipient = ?, pod_note = ?, pod_lat = ?, pod_lng = ?,
       pod_signature_attachment_id = ?, tracking_number = ?, delivered_at = datetime('now'),
       delivered_by = ?, updated_at = datetime('now')
     WHERE id = ?`,
    input.outcome === 'courier_handoff' ? 'delivered' : input.outcome, input.recipient ?? null, input.note ?? null, input.lat ?? null, input.lng ?? null,
    input.signature_attachment_id ?? null, input.tracking_number ?? d.tracking_number, req.user!.id, d.id
  );
  if (d.created_by && d.created_by !== req.user!.id) {
    void notifyUser(d.created_by, {
      title: input.outcome === 'courier_handoff' ? 'Courier picked up' : input.outcome === 'delivered' ? 'Delivered' : 'Delivery failed',
      body: `${d.number}${d.customer_name ? ' — ' + d.customer_name : ''}` + (input.note ? ' · ' + input.note : ''),
      url: '#/deliveries', tag: 'del-' + d.id,
    });
  }

  // If this delivery drops a sale order that hasn't been fulfilled yet, hand the client
  // enough to offer "mark SO-xxxx completed?" (which ships the remaining stock).
  let order: { id: number; number: string; status: string } | null = null;
  if (input.outcome === 'delivered' && d.order_id
      && req.user!.permissions.includes('orders.edit')) {
    const o = queryOne<{ id: number; number: string; status: string; type: string }>(
      'SELECT id, number, status, type FROM orders WHERE id = ?', d.order_id
    );
    if (o && o.type === 'sale' && !['completed', 'cancelled'].includes(String(o.status).toLowerCase())) {
      order = { id: o.id, number: o.number, status: o.status };
    }
  }

  res.json({ ok: true, status: input.outcome === 'courier_handoff' ? 'delivered' : input.outcome, handoff: input.outcome === 'courier_handoff' ? 'courier' : null, order });
});

// DELETE /api/deliveries/:id — remove a not-yet-started delivery (delivery.manage)
router.delete('/:id', requirePermission('delivery.manage'), syncClass('claim', deliverySite), (req, res) => {
  const d = load(Number(req.params.id));
  if (!d) { res.status(404).json({ error: 'Delivery not found' }); return; }
  if (d.status !== 'pending') { res.status(409).json({ error: 'Only a pending delivery can be deleted' }); return; }
  run('DELETE FROM deliveries WHERE id = ?', d.id);
  res.json({ ok: true });
});

export default router;
