/** Stock that is set aside but hasn't left yet — one answer for "how much of item X at location
 *  L is spoken for":
 *  - kit picks: components picked for a draft job order's parts kit (job_order_components.qty_picked
 *    on a `draft` job order at its source location) until the kit is released;
 *  - repair holds (`repair_part_holds`): an open repair-parts request holds its quantity at one
 *    approved source from the moment it is raised (or its revision is approved) until the part is
 *    issued, or the request is rejected or cancelled. A request raised when no approved source has
 *    enough free stock holds nothing; it is then a shortage until stock arrives.
 *  Used by repair issue (production.routes.ts), kit picking (job-orders.routes.ts /prepare) and the
 *  sale-order availability gate (orders.routes.ts). Adjustments and transfers are not blocked by
 *  holds, as with kit picks. */
import { queryOne, queryAll, run } from '../../shared/db';
import { stockAt, getDefaultLocationId } from '../inventory/inventory-stock';

/** Location types repair parts may be issued from (rts.ts uses the same storage set). */
export const REPAIR_SOURCE_TYPES = new Set(['warehouse', 'branch', 'store', 'other']);

/** Quantity of `itemId` picked at `locationId` for draft job orders' kits (except `excludeJoIds`). */
export function kitPickedAt(itemId: number, locationId: number, excludeJoIds: number[] = []): number {
  const ex = excludeJoIds.length ? `AND j.id NOT IN (${excludeJoIds.map(() => '?').join(',')})` : '';
  return queryOne<{ n: number }>(
    `SELECT COALESCE(SUM(c.qty_picked), 0) AS n
     FROM job_order_components c JOIN job_orders j ON j.id = c.job_order_id
     WHERE j.status = 'draft' AND c.component_item_id = ? AND COALESCE(j.source_location_id, ?) = ? ${ex}`,
    itemId, getDefaultLocationId(), locationId, ...excludeJoIds
  )?.n ?? 0;
}

/** Quantity of `itemId` held at `locationId` (or anywhere, when null) for open repair requests,
 *  except `excludeRequestId`'s own hold. */
export function repairHeld(itemId: number, locationId: number | null, excludeRequestId?: number): number {
  return queryOne<{ n: number }>(
    `SELECT COALESCE(SUM(h.quantity), 0) AS n FROM repair_part_holds h
     JOIN repair_part_requests r ON r.id = h.request_id AND r.status = 'requested'
     WHERE h.item_id = ? ${locationId == null ? '' : 'AND h.location_id = ?'} AND h.request_id != ?`,
    ...(locationId == null ? [itemId, excludeRequestId ?? 0] : [itemId, locationId, excludeRequestId ?? 0])
  )?.n ?? 0;
}

/** What `requestId` (or anyone, without one) can still take of `itemId` at `locationId`:
 *  stock there minus kit picks and other requests' holds. */
export function freeFor(itemId: number, locationId: number, requestId?: number): number {
  return stockAt(itemId, locationId) - kitPickedAt(itemId, locationId) - repairHeld(itemId, locationId, requestId);
}

export interface RepairHold { request_id: number; item_id: number; location_id: number; quantity: number; location_name?: string }

export function holdOf(requestId: number): RepairHold | null {
  return queryOne<RepairHold>(
    `SELECT h.request_id, h.item_id, h.location_id, h.quantity, l.name AS location_name
     FROM repair_part_holds h LEFT JOIN locations l ON l.id = h.location_id WHERE h.request_id = ?`, requestId
  ) ?? null;
}

/** (Re)place an open request's hold at the first approved source (default location first) with
 *  enough free stock. Returns the hold, or null when none has enough (a shortage). */
export function placeRepairHold(requestId: number): RepairHold | null {
  run('DELETE FROM repair_part_holds WHERE request_id = ?', requestId);
  const r = queryOne<{ status: string; component_item_id: number | null; quantity: number }>(
    'SELECT status, component_item_id, quantity FROM repair_part_requests WHERE id = ?', requestId
  );
  if (!r || r.status !== 'requested' || r.component_item_id == null) return null;
  const sources = queryAll<{ id: number; type: string }>('SELECT id, type FROM locations ORDER BY is_default DESC, name COLLATE NOCASE')
    .filter((l) => REPAIR_SOURCE_TYPES.has(l.type));
  const at = sources.find((l) => freeFor(r.component_item_id!, l.id, requestId) >= r.quantity);
  if (!at) return null;
  run('INSERT INTO repair_part_holds (request_id, item_id, location_id, quantity) VALUES (?, ?, ?, ?)',
    requestId, r.component_item_id, at.id, r.quantity);
  return holdOf(requestId);
}

export function releaseRepairHold(requestId: number): void {
  run('DELETE FROM repair_part_holds WHERE request_id = ?', requestId);
}
