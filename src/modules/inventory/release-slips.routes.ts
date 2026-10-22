import { independentApproval } from '../../shared/approval-policy';
import { orderOutstanding, lineHeld } from './order-trips';
import { parseProductionLabel } from '../manufacturing/label-code';
import { batchBalances } from './batch-stock';
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
  releaseOverrideRequestSchema, releaseOverrideDecisionSchema,
} from '../../shared/validation';
import { notifyPermission, notifyUser } from '../../shared/push';
import type { ReleaseSlip, ReleaseSlipItem } from '../../shared/types';
import { syncClass } from '../../sync';
import { orderAvailability } from './order-availability';
import {
  authorizationRequired, currentAuthorization, latestOverride, newToken, packageItemsFor, publicAuthorization, tokenError,
} from './release-auth';

const router = Router();
router.use(requireAuth);

// Same people who release (orders.routes.ts releaseGate), plus anyone who can see orders.
const viewGate = requireAnyPermission(['inventory.adjust', 'orders.release', 'orders.view']);
const releaseGate = requirePermission('orders.release');
const salesGate = requirePermission('orders.authorize');
// A warehouse supervisor: may release without the token the recipient can't present.
const supervisorGate = requirePermission('orders.override_release');
/** An order's home for offline decisions: its location's site (as orders.routes.ts). */
const orderSite = {
  home: (req: Request) => ({
    location: queryOne<{ location_id: number | null }>('SELECT location_id FROM orders WHERE id = ?', Number(req.params.id))?.location_id ?? null,
  }),
};
const saleOrder = (id: number) => queryOne<{ id: number; number: string; status: string; customer_name: string | null; location_id: number | null; currency: string }>(
  "SELECT id, number, status, customer_name, location_id, currency FROM orders WHERE id = ? AND type = 'sale'", id
);

// Per-order line progress: units reserved/sold + bulk released_qty against the ordered qty.
const PROGRESS_SQL = `
  (SELECT COALESCE(SUM(oi.quantity-oi.cancelled_qty-oi.dispatched_qty), 0) FROM order_items oi WHERE oi.order_id = o.id AND oi.item_id IS NOT NULL AND oi.fulfillment_mode != 'ckd') AS qty_ordered,
  (SELECT COALESCE(SUM(MIN(MAX(0,oi.quantity-oi.cancelled_qty-oi.dispatched_qty),
      MAX(0,COALESCE(oi.released_qty,0)-oi.dispatched_bulk_qty)
      + (SELECT COUNT(*) FROM job_order_units ju WHERE ju.order_item_id=oi.id AND (ju.status='reserved' OR ju.direct_sold_at IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM release_slip_units su JOIN release_slip_items sli ON sli.id=su.slip_item_id WHERE su.unit_id=ju.id AND sli.order_item_id=ju.order_item_id))))),0)
     FROM order_items oi WHERE oi.order_id=o.id AND oi.item_id IS NOT NULL AND oi.fulfillment_mode!='ckd') AS qty_released`;

// GET /api/release-slips/queue — { to_accept, releasing }
router.get('/queue', viewGate, (req, res) => {
  const rows = queryAll<Record<string, unknown>>(
    `SELECT o.id, o.number, o.status, o.customer_name, o.order_date, o.expected_date,
            o.warehouse_accepted_at, wa.full_name AS warehouse_accepted_by_name,
            COALESCE(ship.name, fallback.name) AS location_name,
            ${PROGRESS_SQL}
     FROM orders o
     LEFT JOIN users wa ON wa.id = o.warehouse_accepted_by
     LEFT JOIN locations ship ON ship.id = o.location_id
     LEFT JOIN locations fallback ON fallback.is_default = 1 AND o.location_id IS NULL
     WHERE o.type = 'sale' AND LOWER(o.status) IN ('approved', 'released')
       AND EXISTS (SELECT 1 FROM order_items physical WHERE physical.order_id = o.id AND physical.item_id IS NOT NULL)
       AND EXISTS(SELECT 1 FROM order_items x WHERE x.order_id=o.id AND x.item_id IS NOT NULL AND x.fulfillment_mode!='ckd' AND x.quantity-x.cancelled_qty-x.dispatched_qty>0)
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
    `SELECT oi.id, oi.item_id, oi.name, oi.sku, oi.unit_price, oi.quantity, oi.released_qty, oi.dispatched_qty, oi.dispatched_bulk_qty, oi.cancelled_qty, oi.fulfillment_mode, oi.parent_order_item_id,
            ((SELECT COUNT(*) FROM job_order_units u WHERE u.order_item_id=oi.id AND u.status='reserved')+MAX(oi.dispatched_qty-oi.dispatched_bulk_qty,(SELECT COUNT(*) FROM job_order_units u WHERE u.order_item_id=oi.id AND u.status='sold'))) AS units,
            EXISTS (SELECT 1 FROM job_order_units u JOIN job_orders j ON j.id = u.job_order_id
              WHERE u.product_item_id = oi.item_id AND j.build_mode = CASE WHEN oi.fulfillment_mode = 'semi_built' THEN 'semi_built' ELSE 'assembled' END) AS serialized
     FROM order_items oi WHERE oi.order_id = ? ORDER BY oi.sort, oi.id`, id
  );
  const units = queryAll(
    `SELECT u.id, u.identifier, u.status, u.product_item_id, u.order_item_id, j.product_name, l.name AS location_name,
            CASE WHEN u.direct_sold_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM release_slip_units su JOIN release_slip_items sli ON sli.id=su.slip_item_id WHERE su.unit_id=u.id AND sli.order_item_id=u.order_item_id) THEN 1 ELSE 0 END AS pending_direct,
            (SELECT r.number FROM production_receipt_items ri JOIN production_receipts r ON r.id = ri.receipt_id
              WHERE ri.unit_id = u.id ORDER BY ri.id DESC LIMIT 1) AS receipt_number
     FROM job_order_units u JOIN job_orders j ON j.id = u.job_order_id LEFT JOIN locations l ON l.id = u.location_id
     WHERE u.order_id = ? AND u.status IN ('reserved', 'sold') ORDER BY u.id`, id
  );
  const accepted = queryOne<{ warehouse_accepted_at: string | null }>('SELECT warehouse_accepted_at FROM orders WHERE id = ?', id);
  const availability = orderAvailability(id);
  res.json({
    order: { id, number: order.number, status: order.status, customer_name: order.customer_name, currency: order.currency,
      warehouse_accepted_at: accepted?.warehouse_accepted_at ?? null, location_id: availability.location_id,
      location_name: availability.location_name },
    lines: lines.map((l:any)=>({...l,held_qty:lineHeld(l).reserved+lineHeld(l).bulk})), units,
    outstanding:orderOutstanding(id),
    slips:queryAll('SELECT id,number,released_at FROM release_slips WHERE order_id=? ORDER BY id DESC',id),
    deliveries:queryAll("SELECT id,number,status,release_slip_id FROM deliveries WHERE order_id=? ORDER BY id DESC",id),
    batch_allocations:queryAll(`SELECT a.*,pb.number AS batch_number FROM production_batch_allocations a JOIN production_batches pb ON pb.id=a.batch_id WHERE a.order_id=? ORDER BY a.id`,id),
    availability: availability.lines.map((l) => ({ order_item_id: l.order_item_id, item_id: l.item_id, fulfillment_mode: l.fulfillment_mode, free_to_allocate: Math.max(0, l.available - l.covered_here),
      on_hand: l.on_hand, committed_elsewhere: l.committed_elsewhere, kit_held: l.kit_held, repair_held: l.repair_held, elsewhere_on_hand:l.elsewhere_on_hand,linked_job_orders:l.linked_job_orders })),
    authorization: publicAuthorization(id),
    package: packageItemsFor(id),
    reports: queryAll("SELECT id, kind, description, unit_identifier, created_at FROM release_reports WHERE order_id = ? AND status = 'open' ORDER BY id", id),
    delivery: queryOne('SELECT number, scheduled_date, status FROM deliveries WHERE order_id = ? ORDER BY id DESC LIMIT 1', id) ?? null,
    slip: queryOne(
      `SELECT rs.id, rs.number, rs.released_at, rs.collected_by, u.full_name AS released_by_name, d.backorder_order_id,
              bo.number AS backorder_number
       FROM release_slips rs LEFT JOIN users u ON u.id = rs.released_by LEFT JOIN release_slip_details d ON d.slip_id = rs.id
       LEFT JOIN orders bo ON bo.id = d.backorder_order_id WHERE rs.order_id = ? ORDER BY rs.id DESC LIMIT 1`, id
    ) ?? null,
  });
});

/* GET /api/release-slips/orders/:id/unit?code= — what a scanned label is, for this order
   (78:147 / 78:365). Read-only: allocating it is POST /orders/:id/release. */
router.get('/orders/:id/unit', releaseGate, (req, res) => {
  const id = Number(req.params.id);
  const code = String(req.query.code ?? '').trim();
  if (!saleOrder(id)) { res.status(404).json({ error: 'Sale order not found' }); return; }
  const label=parseProductionLabel(code);
  if(!label){
    const identities=queryOne<{n:number}>(`SELECT (SELECT COUNT(*) FROM job_order_units WHERE LOWER(COALESCE(NULLIF(TRIM(identifier),''),'UNIT-' || id))=LOWER(?))
      +(SELECT COUNT(*) FROM production_batches WHERE LOWER(number)=LOWER(?))
      +(SELECT COUNT(*) FROM inventory_items WHERE LOWER(sku)=LOWER(?) OR LOWER(json_extract(attributes,'$.barcode'))=LOWER(?)) AS n`,code,code,code,code)!.n;
    if(identities>1){res.status(409).json({error:'Ambiguous older label. Open the exact record and reprint its QR sticker.',code:'ambiguous_label'});return;}
  }
  if(!label&&queryOne<{n:number}>("SELECT COUNT(*) AS n FROM job_order_units WHERE LOWER(COALESCE(NULLIF(TRIM(identifier),''),'UNIT-' || id))=LOWER(?)",code)!.n>1){res.json({state:'ambiguous_label',code});return;}
  const batch=queryOne<{id:number;number:string;product_item_id:number;product_name:string;build_mode:string}>(
    `SELECT pb.id,pb.number,COALESCE(pb.product_item_id,j.product_item_id) AS product_item_id,j.product_name,j.build_mode
     FROM production_batches pb JOIN job_orders j ON j.id=pb.job_order_id WHERE (CASE WHEN ? IS NOT NULL THEN (?='batch' AND pb.id=?) ELSE LOWER(pb.number)=LOWER(?) END)
     AND NOT EXISTS(SELECT 1 FROM job_order_units u WHERE u.batch_id=pb.id)`,label?.kind??null,label?.kind??null,label?.id??null,code);
  if(batch){
    const order=queryOne<{location_id:number|null}>('SELECT location_id FROM orders WHERE id=?',id)!;
    const lines=queryAll<{id:number;quantity:number;released_qty:number;fulfillment_mode:string}>(
      `SELECT id,quantity,released_qty,fulfillment_mode FROM order_items WHERE order_id=? AND item_id=? AND fulfillment_mode!='ckd' AND CASE WHEN fulfillment_mode='semi_built' THEN 'semi_built' ELSE 'assembled' END=? ORDER BY sort,id`,id,batch.product_item_id,batch.build_mode);
    const context=orderAvailability(id);
    const balances=batchBalances(batch.id),balance=balances.find(x=>x.location_id===context.location_id);
    const open=lines.reduce((n,l)=>n+Math.max(0,l.quantity-l.released_qty),0);
    const pool=context.lines.find(x=>x.item_id===batch.product_item_id&&(x.fulfillment_mode==='semi_built'?'semi_built':'assembled')===batch.build_mode);
    const free=pool?Math.max(0,pool.on_hand-pool.committed_elsewhere-
      context.lines.filter(x=>x.item_id===batch.product_item_id&&(x.fulfillment_mode==='semi_built'?'semi_built':'assembled')===batch.build_mode)
        .reduce((n,x)=>{const l=queryOne<{dispatched_qty:number}>('SELECT dispatched_qty FROM order_items WHERE id=?',x.order_item_id);return n+x.covered_here-(l?.dispatched_qty||0);},0)):0;
    const available=Math.max(0,Math.min(balance?.available??0,free,open));
    res.json({state:!lines.length?'wrong_product':available>0?'batch_available':'batch_unavailable',batch:{...batch,balances,available},
      matching_lines:lines.map(l=>({order_item_id:l.id,remaining:Math.max(0,l.quantity-l.released_qty)}))});return;
  }
  const u = queryOne<{ id: number; identifier: string | null; status: string; order_id: number | null; product_item_id: number | null;
    product_name: string; build_mode: string; location_id: number | null; location_name: string | null; order_number: string | null; receipt_number: string | null }>(
    `SELECT u.id, u.identifier, u.status, u.order_id, u.product_item_id, u.location_id, j.product_name, j.build_mode, l.name AS location_name, o.number AS order_number,
            (SELECT r.number FROM production_receipt_items ri JOIN production_receipts r ON r.id = ri.receipt_id
              WHERE ri.unit_id = u.id ORDER BY ri.id DESC LIMIT 1) AS receipt_number
     FROM job_order_units u JOIN job_orders j ON j.id = u.job_order_id LEFT JOIN locations l ON l.id = u.location_id
     LEFT JOIN orders o ON o.id = u.order_id
     WHERE (CASE WHEN ? IS NOT NULL THEN (?='unit' AND u.id=?) ELSE LOWER(COALESCE(NULLIF(TRIM(u.identifier), ''), 'UNIT-' || u.id)) = LOWER(?) END) ORDER BY u.id DESC LIMIT 1`, label?.kind??null,label?.kind??null,label?.id??null,code
  );
  if (!u) {
    const item=queryOne<{id:number;name:string}>(`SELECT id,name FROM inventory_items WHERE LOWER(sku)=LOWER(?) OR LOWER(json_extract(attributes,'$.barcode'))=LOWER(?)`,code,code);
    const lines=item?orderAvailability(id).lines.filter(l=>l.item_id===item.id&&l.fulfillment_mode!=='ckd'):[];
    const tracked=item&&queryOne(`SELECT 1 FROM production_batch_stock s JOIN production_batches pb ON pb.id=s.batch_id JOIN job_orders j ON j.id=pb.job_order_id WHERE COALESCE(pb.product_item_id,j.product_item_id)=? AND s.quantity>0 LIMIT 1`,item.id) || item&&queryOne(`SELECT 1 FROM production_receipt_items ri JOIN production_batches pb ON pb.id=ri.batch_id JOIN job_orders j ON j.id=pb.job_order_id WHERE COALESCE(pb.product_item_id,j.product_item_id)=? LIMIT 1`,item.id);
    const line=lines.length===1?lines[0]:null;
    if(item&&line&&!tracked&&!queryOne('SELECT 1 FROM job_order_units WHERE product_item_id=? LIMIT 1',item.id)) {
      res.json({state:'bulk_available',stock:{...item,code,build_mode:line.fulfillment_mode,available:Math.max(0,line.available-line.covered_here)}});return;
    }
    if(item&&lines.length>1&&!tracked&&!queryOne('SELECT 1 FROM job_order_units WHERE product_item_id=? LIMIT 1',item.id)) {
      res.json({state:'line_required',code,matching_lines:lines.map(l=>({order_item_id:l.order_item_id,
        fulfillment_mode:l.fulfillment_mode,remaining:Math.max(0,l.ordered-l.covered_here)}))});return;
    }
    res.json({ state: tracked?'batch_label_required':'not_found', code }); return;
  }
  const onOrder = queryOne(`SELECT 1 FROM order_items WHERE order_id = ? AND item_id = ?
    AND fulfillment_mode!='ckd' AND CASE WHEN fulfillment_mode='semi_built' THEN 'semi_built' ELSE 'assembled' END = ?`, id, u.product_item_id, u.build_mode);
  const state = u.order_id === id && (u.status === 'reserved' || u.status === 'sold') ? 'allocated'
    : u.order_id && u.order_id !== id && u.status === 'reserved' ? 'other_order'
    : !onOrder && queryOne("SELECT 1 FROM order_items WHERE order_id = ? AND item_id = ? AND fulfillment_mode != 'ckd'", id, u.product_item_id) ? 'wrong_build'
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

/* Token override (release-auth.ts). The releaser asks from the counter; every supervisor is
   pushed. A supervisor approves or declines it — or overrides directly — always with a reason.
   It replaces only the token: the authorization must still be valid, and it is spent on one slip. */
router.post('/orders/:id/override-request', releaseGate, syncClass('merge'), (req, res) => {
  const id = Number(req.params.id);
  const order = saleOrder(id);
  if (!order) { res.status(404).json({ error: 'Sale order not found' }); return; }
  const { auth, state } = currentAuthorization(id);
  if (!auth || state !== 'valid') { res.status(409).json({ error: 'There is no valid release authorization to override — ask Sales to issue one.' }); return; }
  const open = latestOverride(auth.id);
  if (open && (open.status === 'requested' || open.status === 'approved')) { res.json({ override: publicAuthorization(id).override }); return; }
  const { reason } = parseBody(releaseOverrideRequestSchema, req.body);
  run('INSERT INTO release_token_overrides (order_id, authorization_id, reason, requested_by) VALUES (?, ?, ?, ?)', id, auth.id, reason, req.user!.id);
  void notifyPermission('inventory.adjust', {
    title: `Release without token? ${order.number}`,
    body: `${req.user!.full_name || 'The releaser'}: ${auth.recipient_name} can't present the token — ${reason}`,
    url: `#/so?id=${id}&step=override`, link: { route: 'releasing' }, tag: `rel-override-${id}`,
  });
  res.status(201).json({ override: publicAuthorization(id).override });
});

router.post('/orders/:id/override', supervisorGate, syncClass('claim', orderSite), (req, res) => {
  const id = Number(req.params.id);
  const order = saleOrder(id);
  if (!order) { res.status(404).json({ error: 'Sale order not found' }); return; }
  const { auth, state } = currentAuthorization(id);
  if (!auth || state !== 'valid') { res.status(409).json({ error: 'There is no valid release authorization to override — ask Sales to issue one.' }); return; }
  const { approve, reason } = parseBody(releaseOverrideDecisionSchema, req.body);
  const open = latestOverride(auth.id);
  if (!independentApproval(req,res,open?.requested_by ?? req.user!.id,'approve this release exception')) return;
  if (open?.status === 'approved' && approve) { res.json({ override: publicAuthorization(id).override }); return; }
  if (open?.status === 'requested') {
    run("UPDATE release_token_overrides SET status = ?, decided_by = ?, decided_at = datetime('now'), decision_note = ? WHERE id = ?",
      approve ? 'approved' : 'declined', req.user!.id, reason, open.id);
    if (open.requested_by && open.requested_by !== req.user!.id) {
      void notifyUser(open.requested_by, {
        title: approve ? `Override approved — ${order.number}` : `Override declined — ${order.number}`,
        body: `${req.user!.full_name || 'A supervisor'}: ${reason}`, url: `#/so?id=${id}&step=handoff`, tag: `rel-override-${id}`,
      });
    }
  } else if (approve) {
    run(`INSERT INTO release_token_overrides (order_id, authorization_id, status, reason, requested_by, decided_by, decided_at, decision_note)
         VALUES (?, ?, 'approved', ?, ?, ?, datetime('now'), ?)`, id, auth.id, reason, req.user!.id, req.user!.id, reason);
  } else {
    res.status(409).json({ error: 'There is no override request to decline.' });
    return;
  }
  res.json({ override: publicAuthorization(id).override });
});

/* Sales: list / issue / revoke an order's release authorizations (desktop sale order). */
router.get('/orders/:id/authorizations', requireAnyPermission(['orders.view', 'orders.edit']), (req, res) => {
  const id = Number(req.params.id);
  const showToken = req.user!.permissions.includes('orders.authorize');
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
  if (orderOutstanding(id)<=1e-9) { res.status(409).json({ error:'No unshipped remainder remains on this order.' }); return; }
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
  // Sales hears about it at once: whoever issued the order's authorization, and everyone who edits orders.
  const order = saleOrder(id)!;
  const push = { title: `Release report — ${order.number}`, body: input.description.slice(0, 160),
    link: { route: 'orders', params: { id } }, tag: `rel-report-${rid}` };
  const issuer = currentAuthorization(id).auth?.issued_by;
  if (issuer && issuer !== req.user!.id) void notifyUser(issuer, push);
  void notifyPermission('orders.edit', push);
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

/* Company policy: require a release authorization for every sale order (on unless turned off). */
router.get('/policy', viewGate, (_req, res) => { res.json({ authorization_required: authorizationRequired() }); });
router.put('/policy', requirePermission('orders.configure'), syncClass('claim'), (req, res) => {
  setSetting('release_authorization_required', req.body?.authorization_required === true);
  res.json({ authorization_required: authorizationRequired() });
});

const SLIP_SELECT = `
  SELECT rs.*, o.number AS order_number, o.customer_name, o.customer_contact, o.status AS order_status,
         u.full_name AS released_by_name,
         (SELECT COUNT(*) FROM attachments a WHERE a.kind = 'release' AND a.ref_id = rs.id) AS photo_count,
         (SELECT t.decision_note FROM release_token_overrides t WHERE t.used_slip_id = rs.id) AS override_reason,
         (SELECT su.full_name FROM release_token_overrides t JOIN users su ON su.id = t.decided_by WHERE t.used_slip_id = rs.id) AS override_by_name
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
