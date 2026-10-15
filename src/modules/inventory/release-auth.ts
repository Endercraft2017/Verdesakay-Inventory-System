/** Sale-order warehouse-out rules (mobile Releasing, Figma 78:*): who may receive the goods,
 *  what must leave with each unit, and when a partial release is allowed. Applied by
 *  POST /api/orders/:id/release-slip before anything is written, so a revoked or wrong token,
 *  an expired authorization or a missing package item makes zero inventory movement.
 *
 *  - Release authorization (Sales, `orders.edit`): pickup or delivery, the approved recipient
 *    (name + the last 4 of an ID reference — never the full number), a time-limited token the
 *    recipient presents, the handoff area, and whether a partial release is allowed. Issuing a
 *    new one revokes the previous. Required for every order unless the company turns the
 *    `release_authorization_required` setting off; an order that has one always enforces it.
 *  - Token override: when the recipient can't present the token, a supervisor (inventory.adjust)
 *    approves releasing without it, with a reason — requested from the counter or made directly.
 *    It replaces only the token: the authorization itself must still be valid.
 *  - Package checklist (per finished product): the items that must leave with each unit
 *    (charger, keys, documents…). Every required item is confirmed explicitly on the slip.
 *  - Partial release: only with an authorization that allows it. The order is split at the slip —
 *    the released quantities stay on it, the rest moves to a new approved backorder sale order —
 *    so stock, COGS and the invoice only ever cover what physically left. */
import { randomInt } from 'node:crypto';
import { queryOne, queryAll, run, nextSequence, getSetting } from '../../shared/db';

export interface ReleaseAuthorization {
  id: number;
  order_id: number;
  mode: 'pickup' | 'delivery';
  recipient_name: string;
  id_last4: string | null;
  token: string;
  valid_until: string;
  handoff_area: string | null;
  partial_allowed: number;
  notes: string | null;
  issued_by: number | null;
  issued_at: string;
  revoked_at: string | null;
  revoke_reason: string | null;
  used_slip_id: number | null;
}

export type AuthState = 'valid' | 'expired' | 'used' | 'revoked' | 'none';

const TOKEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function newToken(mode: 'pickup' | 'delivery'): string {
  let s = '';
  for (let i = 0; i < 4; i++) s += TOKEN_ALPHABET[randomInt(TOKEN_ALPHABET.length)];
  return (mode === 'pickup' ? 'PICKUP-' : 'DELIV-') + s;
}

/** On unless the company turned it off (Releasing policy): every sale order needs Sales'
 *  authorization before the warehouse-out. */
export function authorizationRequired(): boolean {
  return getSetting<boolean>('release_authorization_required') !== false;
}

export interface TokenOverride {
  id: number; order_id: number; authorization_id: number; status: 'requested' | 'approved' | 'declined' | 'used';
  reason: string; requested_by: number | null; requested_at: string; decided_by: number | null; decided_at: string | null;
  decision_note: string | null; used_slip_id: number | null;
  requested_by_name?: string | null; decided_by_name?: string | null;
}

/** The latest supervisor override of an authorization's token (any status), with names. */
export function latestOverride(authorizationId: number): TokenOverride | null {
  return queryOne<TokenOverride>(
    `SELECT o.*, rq.full_name AS requested_by_name, dc.full_name AS decided_by_name FROM release_token_overrides o
     LEFT JOIN users rq ON rq.id = o.requested_by LEFT JOIN users dc ON dc.id = o.decided_by
     WHERE o.authorization_id = ? ORDER BY o.id DESC LIMIT 1`, authorizationId
  ) ?? null;
}

/** The order's latest authorization (revoked or not), with its state right now. */
export function currentAuthorization(orderId: number): { auth: ReleaseAuthorization | null; state: AuthState } {
  const auth = queryOne<ReleaseAuthorization>(
    'SELECT * FROM release_authorizations WHERE order_id = ? ORDER BY id DESC LIMIT 1', orderId
  ) ?? null;
  if (!auth) return { auth: null, state: 'none' };
  if (auth.revoked_at) return { auth, state: 'revoked' };
  if (auth.used_slip_id) return { auth, state: 'used' };
  const expired = queryOne<{ x: number }>("SELECT datetime('now') > ? AS x", auth.valid_until)!.x === 1;
  return { auth, state: expired ? 'expired' : 'valid' };
}

/** What releasing staff may see: no token (the recipient presents it), ID masked to its last 4. */
export function publicAuthorization(orderId: number) {
  const { auth, state } = currentAuthorization(orderId);
  if (!auth) return { state, required: authorizationRequired() };
  const ov = latestOverride(auth.id);
  return {
    override: ov ? { id: ov.id, status: ov.status, reason: ov.reason, requested_by_name: ov.requested_by_name ?? null,
      decided_by_name: ov.decided_by_name ?? null, decision_note: ov.decision_note, decided_at: ov.decided_at } : null,
    state, required: authorizationRequired(),
    id: auth.id, mode: auth.mode, recipient_name: auth.recipient_name,
    id_reference: auth.id_last4 ? '••' + auth.id_last4 : null,
    token_hint: auth.token.split('-')[0] + '-••••', valid_until: auth.valid_until,
    handoff_area: auth.handoff_area, partial_allowed: !!auth.partial_allowed,
    revoke_reason: auth.revoke_reason,
  };
}

/** Null when `token` is the order's valid authorization token, else why not. */
export function tokenError(orderId: number, token: string | null | undefined): string | null {
  const { auth, state } = currentAuthorization(orderId);
  if (!auth) return 'This order has no release authorization. Ask Sales to issue one.';
  if (state === 'revoked') return 'The release authorization was revoked' + (auth.revoke_reason ? `: ${auth.revoke_reason}` : '.');
  if (state === 'used') return 'This release authorization was already used.';
  if (state === 'expired') return 'The release authorization has expired. Ask Sales to issue a new one.';
  if (!token || token.trim().toUpperCase() !== auth.token.toUpperCase()) return 'The release token does not match this order.';
  return null;
}

/** Package items for every finished product on the order, in line order. */
export function packageItemsFor(orderId: number): { item_id: number; item_name: string; label: string; required: boolean }[] {
  return queryAll<{ item_id: number; item_name: string; label: string; required: number }>(
    `SELECT p.item_id, oi.name AS item_name, p.label, p.required
     FROM order_items oi JOIN product_package_items p ON p.item_id = oi.item_id
     WHERE oi.order_id = ? AND oi.item_id IS NOT NULL
     GROUP BY p.id ORDER BY MIN(oi.sort), MIN(oi.id), p.sort, p.id`,
    orderId
  ).map((r) => ({ ...r, required: !!r.required }));
}

/** Required package items not confirmed in `confirmed` ([{item_id, label, ok}]). */
export function missingPackageItems(orderId: number, confirmed: { item_id: number; label: string; ok: boolean }[] | undefined): string[] {
  const ok = new Set((confirmed ?? []).filter((c) => c.ok).map((c) => `${c.item_id}\u0000${c.label.trim().toLowerCase()}`));
  return packageItemsFor(orderId)
    .filter((p) => p.required && !ok.has(`${p.item_id}\u0000${p.label.trim().toLowerCase()}`))
    .map((p) => `${p.item_name}: ${p.label}`);
}

function covered(_orderId: number, l: { id: number; item_id: number | null; quantity: number; released_qty: number | null }): number {
  if (l.item_id == null) return l.quantity;
  const units = queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM job_order_units WHERE order_item_id = ? AND status IN ('reserved', 'sold')`,
    l.id
  )!.n;
  return Math.min(l.quantity, units + (l.released_qty || 0));
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const quantity = (n: number) => Number(n.toPrecision(15));

/** Partial release: keep what is allocated on the order, move the rest to a new approved
 *  backorder sale order, re-total both, and mark the order released. Runs inside the caller's
 *  transaction. Returns the backorder, or null when nothing is outstanding. Throws when
 *  nothing at all has been allocated yet. */
export function splitUnreleased(orderId: number, userId: number): { id: number; number: string } | null {
  const order = queryOne<{ number: string; customer_name: string | null; customer_contact: string | null; customer_id: number | null;
    location_id: number | null; tax_code_id: number | null; currency: string | null; tax_percent: number | null }>(
    'SELECT * FROM orders WHERE id = ?', orderId
  )!;
  const lines = queryAll<{ id: number; item_id: number | null; name: string; sku: string | null; description: string | null;
    quantity: number; unit: string | null; unit_price: number; tax_code_id: number | null; released_qty: number | null; sort: number;
    fulfillment_mode: string; parent_order_item_id: number | null }>(
    'SELECT * FROM order_items WHERE order_id = ? ORDER BY sort, id', orderId
  );
  const rest: typeof lines = [];
  const ckdKits = new Map<number, number>();
  for (const parent of lines.filter((l) => l.fulfillment_mode === 'ckd')) {
    const parts = lines.filter((l) => l.parent_order_item_id === parent.id);
    if (!parts.length) throw new Error(`CKD kit ${parent.name} has no snapshotted parts.`);
    const kits = Math.min(parent.quantity, ...parts.map((p) => Math.floor((covered(orderId, p) + 1e-9) / (p.quantity / parent.quantity))));
    // A partial handoff must not strand already picked components on the shipped order.
    for (const p of parts) {
      const picked = covered(orderId, p);
      const shipped = kits * p.quantity / parent.quantity;
      if (picked > shipped + 1e-9) throw new Error(`Unreserve extra ${p.name} before shipping complete CKD kits.`);
    }
    ckdKits.set(parent.id, kits);
  }
  let kept = 0;
  for (const l of lines) {
    if (l.item_id == null) continue;
    const c = l.fulfillment_mode === 'ckd' ? ckdKits.get(l.id) ?? 0
      : l.parent_order_item_id ? (ckdKits.get(l.parent_order_item_id) ?? 0) * l.quantity /
        lines.find((p) => p.id === l.parent_order_item_id)!.quantity : covered(orderId, l);
    if (c > 0) kept++;
    if (c >= l.quantity) continue;
    rest.push({ ...l, quantity: quantity(l.quantity - c) });
    if (c > 0) {
      run('UPDATE order_items SET quantity = ?, line_total = ?, released_qty = MIN(COALESCE(released_qty, 0), ?) WHERE id = ?',
        c, r2(c * l.unit_price), c, l.id);
    } else {
      run('DELETE FROM order_items WHERE id = ?', l.id);
    }
  }
  if (!kept) throw new Error('Nothing on this order has been allocated yet — scan or enter what is leaving first.');
  if (!rest.length) return null;
  const totals = (rows: { quantity: number; unit_price: number }[]) => {
    const subtotal = r2(rows.reduce((s, x) => s + r2(x.quantity * x.unit_price), 0));
    const tax_amount = r2((subtotal * (order.tax_percent || 0)) / 100);
    return { subtotal, tax_amount, total: r2(subtotal + tax_amount) };
  };
  const left = totals(queryAll<{ quantity: number; unit_price: number }>('SELECT quantity, unit_price FROM order_items WHERE order_id = ?', orderId));
  run("UPDATE orders SET subtotal = ?, tax_amount = ?, total = ?, status = 'released', updated_at = datetime('now') WHERE id = ?",
    left.subtotal, left.tax_amount, left.total, orderId);
  const bo = totals(rest);
  const number = nextSequence('order_seq_sale', 'SO');
  const boId = Number(run(
    `INSERT INTO orders (type, number, customer_name, customer_contact, customer_id, location_id, tax_code_id, order_date, status,
       notes, currency, subtotal, tax_percent, tax_amount, total, created_by)
     VALUES ('sale', ?, ?, ?, ?, ?, ?, date('now'), 'approved', ?, ?, ?, ?, ?, ?, ?)`,
    number, order.customer_name, order.customer_contact, order.customer_id, order.location_id, order.tax_code_id,
    `Backorder of ${order.number} (partial release)`, order.currency ?? 'PHP', bo.subtotal, order.tax_percent ?? 0,
    bo.tax_amount, bo.total, userId
  ).lastInsertRowid);
  const newParentIds = new Map<number, number>();
  rest.forEach((l, i) => {
    const newId = Number(run(
    `INSERT INTO order_items (order_id, item_id, name, sku, description, quantity, unit, unit_price, line_total, tax_code_id, sort, fulfillment_mode, parent_order_item_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    boId, l.item_id, l.name, l.sku, l.description, l.quantity, l.unit, l.unit_price, r2(l.quantity * l.unit_price), l.tax_code_id, i, l.fulfillment_mode
    , l.parent_order_item_id ? newParentIds.get(l.parent_order_item_id) ?? null : null).lastInsertRowid);
    if (l.fulfillment_mode === 'ckd') newParentIds.set(l.id, newId);
  });
  return { id: boId, number };
}

/** Everything the slip must satisfy beyond "every line released" (checked by the route). */
export function slipError(orderId: number, input: { authorization_token?: string | null; package?: { item_id: number; label: string; ok: boolean }[] }):
  { code: 'authorization' | 'package'; error: string; missing?: string[] } | null {
  const { auth, state } = currentAuthorization(orderId);
  if (auth || authorizationRequired()) {
    const err = tokenError(orderId, input.authorization_token);
    // A supervisor's approved override stands in for the token — never for a missing, revoked,
    // expired or used authorization.
    if (err && !(auth && state === 'valid' && latestOverride(auth.id)?.status === 'approved')) return { code: 'authorization', error: err };
  }
  const missing = missingPackageItems(orderId, input.package);
  if (missing.length) return { code: 'package', error: `Confirm every required package item: ${missing.join(', ')}`, missing };
  return null;
}
