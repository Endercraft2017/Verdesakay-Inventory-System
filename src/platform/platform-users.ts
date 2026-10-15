/**
 * Owner-console operator accounts + session auth. Entirely separate from tenant auth
 * (src/auth.ts): these live in `platform.db`, a `platform_users` row can never sign into
 * a tenant workspace, and a tenant bearer token is meaningless here. Used only by
 * src/routes/platform.routes.ts, which is mounted only when PLATFORM_CONSOLE=true.
 */
import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import { platformDb } from './platform';

const SESSION_HOURS = 12;
const newToken = () => crypto.randomBytes(32).toString('hex');

export interface PlatformUser {
  id: number;
  username: string;
  full_name: string | null;
}

export interface PlatformAuthedRequest extends Request {
  platformUser?: PlatformUser;
  platformToken?: string;
}

/** Create or reset an operator. Returns the row id. */
export function upsertPlatformUser(username: string, password: string, fullName?: string): number {
  const u = username.toLowerCase().trim();
  if (!/^[a-z0-9._-]{3,30}$/.test(u)) throw new Error('Username must be 3–30 chars: letters, numbers, dot, underscore, hyphen.');
  if (password.length < 6) throw new Error('Password must be at least 6 characters.');
  const hash = bcrypt.hashSync(password, 10);
  const d = platformDb();
  d.prepare(
    `INSERT INTO platform_users (username, password_hash, full_name) VALUES (?, ?, ?)
     ON CONFLICT(username) DO UPDATE SET
       password_hash = excluded.password_hash,
       full_name     = COALESCE(excluded.full_name, platform_users.full_name)`
  ).run(u, hash, fullName ?? null);
  const id = (d.prepare('SELECT id FROM platform_users WHERE username = ?').get(u) as { id: number }).id;
  d.prepare('DELETE FROM platform_sessions WHERE user_id = ?').run(id);
  return id;
}

export function listPlatformUsers(): PlatformUser[] {
  return platformDb().prepare(
    'SELECT id, username, full_name FROM platform_users ORDER BY username'
  ).all() as unknown as PlatformUser[];
}

export function platformUserCount(): number {
  return (platformDb().prepare('SELECT COUNT(*) AS c FROM platform_users').get() as { c: number }).c;
}

/** Verify credentials and open a session. Returns the bearer token, or null. */
export function platformLogin(username: string, password: string): string | null {
  const row = platformDb().prepare(
    'SELECT id, password_hash FROM platform_users WHERE username = ?'
  ).get(username.toLowerCase().trim()) as { id: number; password_hash: string } | undefined;
  if (!row || !bcrypt.compareSync(password, row.password_hash)) return null;
  const token = newToken();
  const d = platformDb();
  d.prepare(
    `INSERT INTO platform_sessions (token, user_id, expires_at)
     VALUES (?, ?, datetime('now', '+${SESSION_HOURS} hours'))`
  ).run(token, row.id);
  d.prepare("UPDATE platform_users SET last_login_at = datetime('now') WHERE id = ?").run(row.id);
  return token;
}

export function platformLogout(token: string): void {
  platformDb().prepare('DELETE FROM platform_sessions WHERE token = ?').run(token);
}

export function platformUserFromToken(token: string | null): PlatformUser | null {
  if (!token) return null;
  const row = platformDb().prepare(
    `SELECT u.id, u.username, u.full_name
     FROM platform_sessions s JOIN platform_users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at >= datetime('now')`
  ).get(token) as PlatformUser | undefined;
  return row ?? null;
}

export function cleanupPlatformSessions(): void {
  try {
    platformDb().prepare("DELETE FROM platform_sessions WHERE expires_at < datetime('now')").run();
  } catch { /* platform.db may not exist on a single-tenant install */ }
}

/** Require a valid operator session. Also enforces the optional X-Platform-Token shared
 *  secret when PLATFORM_ADMIN_TOKEN is set in the environment. */
export function requirePlatformAuth(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.PLATFORM_ADMIN_TOKEN;
  if (secret && req.get('x-platform-token') !== secret) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  const user = platformUserFromToken(token);
  if (!user) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  (req as PlatformAuthedRequest).platformUser = user;
  (req as PlatformAuthedRequest).platformToken = token ?? undefined;
  next();
}
