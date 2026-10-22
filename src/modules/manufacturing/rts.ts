/** Ready-to-sell (RTS) recording rules, shared by POST /job-orders/:id/products-in (desktop
 *  Products In + mobile RTS desk) and the RTS pre-check (/api/rts/check): a finished unit posts
 *  to stock once — never twice, and never under a serial that is already in finished goods —
 *  only into a storage location with room for it (location_capacities, when set), and not while a
 *  product-data mismatch report holds it. Every
 *  refusal happens before any write, so a blocked post makes zero stock change. */
import { queryOne, queryAll } from '../../shared/db';

/** production_issues.category the RTS clerk files for a unit that doesn't match its record.
 *  While one is open on a unit, the unit can't be recorded as ready to sell. */
export const MISMATCH_CATEGORY = 'Product-data mismatch';

/** Location types that can hold ready-to-sell stock. A truck is transit, not storage. */
const STORAGE_TYPES = new Set(['warehouse', 'branch', 'store', 'other']);

/** Unit statuses that mean "already posted to finished goods" (or beyond). */
const POSTED = ['in_stock', 'reserved', 'sold'];

export interface ExistingRecord {
  unit_id: number;
  identifier: string | null;
  status: string;
  location_name: string | null;
  receipt_number: string | null;
  received_at: string | null;
  received_by_name: string | null;
}

export interface UnitBlocker {
  unit_id: number;
  identifier: string | null;
  reason: 'recorded' | 'duplicate_serial' | 'held' | 'not_ready' | 'not_found';
  message: string;
  existing?: ExistingRecord;
  issue_id?: number;
}

/** Null when `locationId` can receive `incoming` units of ready-to-sell stock, else why not:
 *  missing, not storage (a truck), or without room for them under its capacity. */
export function locationError(locationId: number, incoming = 0): string | null {
  const loc = queryOne<{ name: string; type: string }>('SELECT name, type FROM locations WHERE id = ?', locationId);
  if (!loc) return 'That location does not exist';
  if (!STORAGE_TYPES.has(loc.type)) return `${loc.name} is a ${loc.type} location — ready-to-sell stock needs a storage location`;
  const room = locationRoom(locationId);
  if (room && incoming > room.free) {
    return room.free > 0
      ? `${loc.name} has room for only ${room.free} more (capacity ${room.capacity}, ${room.used} in use) — ${incoming} won't fit`
      : `${loc.name} is full (capacity ${room.capacity}, ${room.used} in use)`;
  }
  return null;
}

/** A location's capacity, what it holds now and the room left — null when it has no capacity set. */
export function locationRoom(locationId: number): { capacity: number; used: number; free: number } | null {
  const cap = queryOne<{ max_units: number }>('SELECT max_units FROM location_capacities WHERE location_id = ?', locationId);
  if (!cap) return null;
  const used = queryOne<{ n: number }>('SELECT COALESCE(SUM(quantity), 0) AS n FROM inventory_stock WHERE location_id = ?', locationId)!.n;
  return { capacity: cap.max_units, used, free: Math.max(0, cap.max_units - used) };
}

function existingFor(unitId: number): ExistingRecord | undefined {
  return queryOne<ExistingRecord>(
    `SELECT u.id AS unit_id, u.identifier, u.status, l.name AS location_name, r.number AS receipt_number,
            r.created_at AS received_at, us.full_name AS received_by_name
     FROM job_order_units u
     LEFT JOIN locations l ON l.id = u.location_id
     LEFT JOIN production_receipt_items ri ON ri.unit_id = u.id
     LEFT JOIN production_receipts r ON r.id = ri.receipt_id
     LEFT JOIN users us ON us.id = r.received_by
     WHERE u.id = ? ORDER BY ri.id DESC LIMIT 1`,
    unitId
  );
}

/** Why each of `unitIds` can't be recorded as ready to sell right now (empty = all clear). */
export function unitBlockers(unitIds: number[]): UnitBlocker[] {
  const out: UnitBlocker[] = [];
  for (const id of unitIds) {
    const u = queryOne<{ id: number; identifier: string | null; status: string; product_item_id: number | null }>(
      `SELECT u.id, u.identifier, u.status, COALESCE(u.product_item_id, j.product_item_id) AS product_item_id
       FROM job_order_units u JOIN job_orders j ON j.id = u.job_order_id WHERE u.id = ?`,
      id
    );
    if (!u) { out.push({ unit_id: id, identifier: null, reason: 'not_found', message: 'Unit not found' }); continue; }
    const name = u.identifier || `Unit #${u.id}`;
    if (POSTED.includes(u.status)) {
      out.push({ unit_id: u.id, identifier: u.identifier, reason: 'recorded', message: `${name} is already recorded in finished goods`,
        existing: existingFor(u.id) });
      continue;
    }
    if (u.status !== 'passed') {
      out.push({ unit_id: u.id, identifier: u.identifier, reason: 'not_ready',
        message: `${name} hasn't passed final inspection (status: ${u.status})` });
      continue;
    }
    if (u.identifier) {
      const twin = queryOne<{ id: number }>(
        `SELECT u.id FROM job_order_units u JOIN job_orders j ON j.id = u.job_order_id
         WHERE u.id != ? AND LOWER(TRIM(u.identifier)) = LOWER(TRIM(?))
           AND COALESCE(u.product_item_id, j.product_item_id) IS ?
           AND u.status IN (${POSTED.map(() => '?').join(',')})
         LIMIT 1`,
        u.id, u.identifier, u.product_item_id, ...POSTED
      );
      if (twin) {
        out.push({ unit_id: u.id, identifier: u.identifier, reason: 'duplicate_serial',
          message: `Serial ${u.identifier} is already in finished goods on another record`, existing: existingFor(twin.id) });
        continue;
      }
    }
    const hold = queryOne<{ id: number }>(
      "SELECT id FROM production_issues WHERE unit_id = ? AND category = ? AND status = 'open' ORDER BY id DESC LIMIT 1",
      u.id, MISMATCH_CATEGORY
    );
    if (hold) {
      out.push({ unit_id: u.id, identifier: u.identifier, reason: 'held', issue_id: hold.id,
        message: `${name} is on hold — an open product-data mismatch report must be resolved first` });
    }
  }
  return out;
}

/** Open mismatch holds by unit id, for a set of units (queue decoration). */
export function openHolds(unitIds: number[]): Map<number, { id: number; description: string; created_at: string }> {
  const map = new Map<number, { id: number; description: string; created_at: string }>();
  if (!unitIds.length) return map;
  const rows = queryAll<{ unit_id: number; id: number; description: string; created_at: string }>(
    `SELECT unit_id, id, description, created_at FROM production_issues
     WHERE category = ? AND status = 'open' AND unit_id IN (${unitIds.map(() => '?').join(',')}) ORDER BY id`,
    MISMATCH_CATEGORY, ...unitIds
  );
  for (const r of rows) map.set(r.unit_id, { id: r.id, description: r.description, created_at: r.created_at });
  return map;
}
