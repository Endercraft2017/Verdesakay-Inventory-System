/**
 * Approved kiosk devices. The time-in kiosk (hr-kiosk.js) shows the rotating QR and lets anyone
 * at it punch ANY employee by typing their number. On an office-LAN install that screen could
 * only be opened at the office; once the app is on the internet, any HR login could open it from
 * home. With the kiosk lock on, the kiosk endpoints (current QR code, typed punches, corrections,
 * field-work punches) only answer a browser an HR manager approved once, on the office PC.
 *
 * Approval gives that browser a random token (localStorage `vds_kiosk_token`, sent by api.js as
 * the `X-Kiosk-Token` header); only its SHA-256 is stored. Revoking a device stops it at once.
 *
 * The lock is a per-company setting (`kiosk_lock`). Unset, it follows the hosting: ON when the
 * server is internet-facing (BEHIND_PROXY), OFF on an office-LAN install — so a local install
 * keeps working with no setup, and a hosted one is safe by default.
 */
import crypto from 'node:crypto';
import type { RequestHandler } from 'express';
import { getSetting, setSetting, queryOne, queryAll, run } from '../../shared/db';
import { BEHIND_PROXY } from '../../shared/hosting';
import { isInstalledCopy } from '../../sync';

export interface KioskDevice {
  id: number;
  name: string;
  created_by_name: string | null;
  created_at: string;
  last_seen_at: string | null;
}

const hash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

/** The explicit setting, or null when HR never chose (then the hosting default applies). */
export function kioskLockSetting(): boolean | null {
  const s = getSetting<{ enabled: boolean }>('kiosk_lock');
  return s && typeof s.enabled === 'boolean' ? s.enabled : null;
}

export function kioskLockActive(): boolean {
  return kioskLockSetting() ?? BEHIND_PROXY;
}

export function setKioskLock(enabled: boolean): void {
  setSetting('kiosk_lock', { enabled });
}

export function listKioskDevices(): KioskDevice[] {
  return queryAll<KioskDevice>(
    `SELECT k.id, k.name, u.full_name AS created_by_name, k.created_at, k.last_seen_at
     FROM kiosk_devices k LEFT JOIN users u ON u.id = k.created_by
     WHERE k.revoked_at IS NULL ORDER BY k.id`
  );
}

/** Approve a new device. The plain token is returned ONCE, for the browser to keep. */
export function approveKioskDevice(name: string, userId: number): { id: number; name: string; token: string } {
  const token = crypto.randomBytes(32).toString('base64url');
  const info = run('INSERT INTO kiosk_devices (name, token_hash, created_by) VALUES (?, ?, ?)', name, hash(token), userId);
  return { id: Number(info.lastInsertRowid), name, token };
}

export function revokeKioskDevice(id: number): boolean {
  return run("UPDATE kiosk_devices SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL", id).changes > 0;
}

/** The approved, unrevoked device a token belongs to (and note that it was seen). */
export function kioskDeviceFor(token: string | undefined): { id: number; name: string } | undefined {
  if (!token || token.length > 200) return undefined;
  const dev = queryOne<{ id: number; name: string }>(
    'SELECT id, name FROM kiosk_devices WHERE token_hash = ? AND revoked_at IS NULL', hash(token)
  );
  // An installed PC never stamps it: "last seen" is the cloud's own observation (it records it
  // when it replays the kiosk's punches), so the PC's row stays identical to the cloud's.
  if (dev && !isInstalledCopy()) {
    // At most one write per 5 minutes per device — the kiosk polls every few seconds.
    run(`UPDATE kiosk_devices SET last_seen_at = datetime('now')
         WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < datetime('now', '-5 minutes'))`, dev.id);
  }
  return dev;
}

/** Guard for kiosk-only endpoints: a no-op while the lock is off. */
export const requireKioskDevice: RequestHandler = (req, res, next) => {
  if (!kioskLockActive() || kioskDeviceFor(req.get('x-kiosk-token'))) { next(); return; }
  res.status(403).json({
    error: 'This screen is not an approved time-in kiosk. An HR manager must approve it on the office PC.',
    code: 'KIOSK_NOT_APPROVED',
  });
};
