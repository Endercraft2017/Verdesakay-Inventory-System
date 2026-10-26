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
 *  - Partial release: only with an authorization that allows it. Each trip has its own immutable slip; unshipped demand
 *    stays committed on the same order. Stock and COGS cover only the actual trip load. */
import { randomInt } from 'node:crypto';
import { queryOne, queryAll, run, getSetting } from '../../shared/db';

export interface ReleaseAuthorization {
  id: number;
  order_id: number;
  mode: 'pickup' | 'delivery';
  recipient_name: string;
  handoff_type: 'external' | 'internal';
  receiver_user_id: number | null;
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
    handoff_type: auth.handoff_type,receiver_user_id:auth.receiver_user_id,token_required:auth.handoff_type!=='internal',
    receiver_active:auth.handoff_type==='internal'?!!queryOne('SELECT 1 FROM users WHERE id=? AND active=1',auth.receiver_user_id):null,
    id_reference: auth.id_last4 ? '••' + auth.id_last4 : null,
    token_hint: auth.handoff_type==='internal'?null:auth.token.split('-')[0] + '-••••', valid_until: auth.valid_until,
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
  if (auth.handoff_type==='internal') return 'Internal staff handoff uses assigned-receiver acknowledgment, not a release code.';
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
export function missingPackageItems(orderId: number, confirmed: { item_id: number; label: string; ok: boolean }[] | undefined, itemIds?:number[]): string[] {
  const ok = new Set((confirmed ?? []).filter((c) => c.ok).map((c) => `${c.item_id}\u0000${c.label.trim().toLowerCase()}`));
  return packageItemsFor(orderId)
    .filter((p) => (!itemIds||itemIds.includes(p.item_id))&&p.required && !ok.has(`${p.item_id}\u0000${p.label.trim().toLowerCase()}`))
    .map((p) => `${p.item_name}: ${p.label}`);
}

/** Everything the slip must satisfy beyond "every line released" (checked by the route). */
export interface ReleaseHandoffInput {
  authorization_token?: string | null;
  authorization_id?: number | null;
  handoff_type?: 'external' | 'internal';
  receiver_user_id?: number | null;
  signature_attachment_id?: number | null;
  acknowledged?: boolean;
  package?: { item_id: number; label: string; ok: boolean }[];
  shipping_item_ids?: number[];
}
export function slipError(orderId: number, input: ReleaseHandoffInput):
  { code: 'authorization' | 'package' | 'receiver' | 'acknowledgment'; error: string; missing?: string[] } | null {
  const { auth, state } = currentAuthorization(orderId);
  const type = auth?.handoff_type || 'external';
  // The Sales-issued authorization is authoritative; release payloads cannot switch paths.
  if (input.handoff_type && input.handoff_type !== type) {
    return { code: 'authorization', error: 'The handoff type does not match Sales authorization. Review the current order.' };
  }
  if (input.authorization_id != null && input.authorization_id !== auth?.id) {
    return { code: 'authorization', error: 'The release authorization changed. Review the current assignment before signing again.' };
  }
  if (auth && type === 'internal') {
    if (state !== 'valid') {
      return { code: 'authorization', error: `The internal handoff authorization is ${state}. Ask Sales to issue a valid assignment.` };
    }
    if (!auth.receiver_user_id || !queryOne('SELECT 1 FROM users WHERE id=? AND active=1', auth.receiver_user_id)) {
      return { code: 'receiver', error: 'The assigned staff receiver is no longer active. Ask Sales to assign an active receiver.' };
    }
    if (input.receiver_user_id !== auth.receiver_user_id || input.authorization_id !== auth.id) {
      return { code: 'receiver', error: 'Confirm the exact staff receiver assigned by Sales for this handoff.' };
    }
    const signed = input.signature_attachment_id && queryOne(
      "SELECT 1 FROM attachments WHERE id=? AND kind='release_acknowledgment' AND ref_id=?",
      input.signature_attachment_id, auth.id
    );
    if (!input.acknowledged || !signed) {
      return { code: 'acknowledgment', error: 'Attach the assigned receiver’s signed acknowledgment for this authorization before handing over the goods.' };
    }
  } else if (auth || authorizationRequired()) {
    const err = tokenError(orderId, input.authorization_token);
    if (err && !(auth && state === 'valid' && latestOverride(auth.id)?.status === 'approved')) {
      return { code: 'authorization', error: err };
    }
  }
  const missing = missingPackageItems(orderId, input.package, input.shipping_item_ids);
  if (missing.length) return { code: 'package', error: `Confirm every required package item: ${missing.join(', ')}`, missing };
  return null;
}
