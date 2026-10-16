/**
 * Phone punches in two steps (time_punch_holds, SCHEMA_VERSION 51). Step 1, the QR scan (or a
 * clock_anywhere employee's "clock in here"), passes every check a punch needs -- the kiosk code,
 * the office location lock -- and parks a hold stamped with the server's time. Step 2, the selfie,
 * turns that hold into the real time_punches row AT the scan time, with the photo attached
 * (punch-photos.ts). Taking the selfie never makes anyone late, and a punch is never recorded
 * without one.
 *
 * Holds are short-lived: an employee has at most one, it expires after HOLD_TTL_MS, and it is
 * deleted when used. Expired rows are swept on the next scan. All times come from now(), so a
 * synced pair of commands replays with each step at its own time (docs/OFFLINE-FIRST.md §20).
 */
import { queryOne, run } from '../../shared/db';
import { now } from '../../shared/sync-context';
import { localStamp } from './clock';
import type { PunchGeo } from './clock-geofence';

/** Long enough for a slow phone to open its front camera; a punch still lands at the scan time. */
export const HOLD_TTL_MS = 5 * 60_000;

export interface PunchHold {
  id: number;
  employee_id: number;
  user_id: number | null;
  scanned_at: string;
  scanned_ms: number;
  source: 'phone' | 'remote';
  lat: number | null;
  lng: number | null;
  accuracy_m: number | null;
  distance_m: number | null;
  geo_site: string | null;
}

/** Park a scan for the selfie step. Replaces any earlier hold of the employee's. */
export function createPunchHold(
  employeeId: number,
  userId: number,
  source: 'phone' | 'remote',
  geo: PunchGeo | null
): { hold_id: number; expires_in_s: number } {
  const at = now();
  run('DELETE FROM time_punch_holds WHERE employee_id = ? OR scanned_ms < ?', employeeId, at.getTime() - HOLD_TTL_MS);
  const info = run(
    `INSERT INTO time_punch_holds (employee_id, user_id, scanned_at, scanned_ms, source, lat, lng, accuracy_m, distance_m, geo_site)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    employeeId, userId, localStamp(at), at.getTime(), source,
    geo?.lat ?? null, geo?.lng ?? null, geo?.accuracy_m ?? null, geo?.distance_m ?? null, geo?.site ?? null
  );
  return { hold_id: Number(info.lastInsertRowid), expires_in_s: HOLD_TTL_MS / 1000 };
}

/** Use up the employee's hold: deleted whether or not it was still fresh. Undefined when there is
 *  no such hold (wrong employee, already used) or it has expired. */
export function takePunchHold(holdId: number, employeeId: number): PunchHold | undefined {
  const hold = queryOne<PunchHold>('SELECT * FROM time_punch_holds WHERE id = ? AND employee_id = ?', holdId, employeeId);
  if (!hold) return undefined;
  run('DELETE FROM time_punch_holds WHERE id = ?', hold.id);
  return now().getTime() - hold.scanned_ms > HOLD_TTL_MS ? undefined : hold;
}

/** The location the scan passed with, in the shape recordPunch stores. */
export function holdGeo(hold: PunchHold): PunchGeo | null {
  if (hold.lat == null || hold.lng == null) return null;
  return { lat: hold.lat, lng: hold.lng, accuracy_m: hold.accuracy_m ?? 0, distance_m: hold.distance_m, site: hold.geo_site };
}
