/**
 * Owner-console operator accounts + session auth. Entirely separate from tenant auth
 * (src/auth.ts): these live in `platform.db`, a `platform_users` row can never sign into
 * a tenant workspace, and a tenant bearer token is meaningless here. Used only by
 * src/routes/platform.routes.ts, which is mounted only when PLATFORM_CONSOLE=true.
 */
import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { hashPassword, verifyPassword, passwordNeedsUpgrade } from '../shared/password-hash';
import { cookieValue } from '../shared/browser-session';
import { platformDb } from './platform';
import { tokenDigest } from '../shared/db';
import { passwordPolicyError } from '../shared/password-policy';
import { hasPlatformPasskey, requiresPlatformPasskeySetup, platformSessionVerified } from './platform-passkeys';

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
  const error = passwordPolicyError(password);
  if (error) throw new Error(error);
  const hash = hashPassword(password);
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
export function verifyPlatformPassword(username: string, password: string): number | null {
  const row = platformDb().prepare(
    'SELECT id, password_hash FROM platform_users WHERE username = ?'
  ).get(username.toLowerCase().trim()) as { id: number; password_hash: string } | undefined;
  if (!row || !verifyPassword(password, row.password_hash)) return null;
  if (passwordNeedsUpgrade(row.password_hash)) {
    platformDb().prepare('UPDATE platform_users SET password_hash = ? WHERE id = ? AND password_hash = ?').run(hashPassword(password), row.id, row.password_hash);
  }
  return row.id;
}

export function platformLogin(username: string, password: string): string | null {
  const id = verifyPlatformPassword(username, password);
  if (!id || hasPlatformPasskey(id)) return null;
  return createPlatformSession(id);
}

export function createPlatformSession(userId: number): string {
  const token = newToken();
  const d = platformDb();
  d.prepare(
    `INSERT INTO platform_sessions (token, user_id, expires_at)
     VALUES (?, ?, datetime('now', '+${SESSION_HOURS} hours'))`
  ).run(tokenDigest(token), userId);
  d.prepare("UPDATE platform_users SET last_login_at = datetime('now') WHERE id = ?").run(userId);
  return token;
}

/** Change an operator's own password: the current one must match, the new one follows the
 *  password rules, and every other session of theirs ends (the calling session stays). Returns
 *  an error message, or null on success. */
export function changePlatformPassword(userId: number, current: string, next: string, keepToken: string): string | null {
  const d = platformDb();
  const row = d.prepare('SELECT password_hash FROM platform_users WHERE id = ?').get(userId) as
    { password_hash: string } | undefined;
  if (!row || !verifyPassword(current, row.password_hash)) return 'Current password is incorrect.';
  const error = passwordPolicyError(next, 'New password');
  if (error) return error;
  if (next === current) return 'New password must be different from the current one.';
  d.prepare('UPDATE platform_users SET password_hash = ? WHERE id = ?').run(hashPassword(next), userId);
  d.prepare('DELETE FROM platform_sessions WHERE user_id = ? AND token <> ?').run(userId, tokenDigest(keepToken));
  return null;
}

/** Rename only the authenticated console operator; keep their calling session. */
export function changePlatformUsername(userId: number, current: string, next: string, keepToken: string): string | null {
  const d = platformDb();
  const row = d.prepare('SELECT username, password_hash FROM platform_users WHERE id = ?').get(userId) as { username: string; password_hash: string } | undefined;
  if (!row || !verifyPassword(current, row.password_hash)) return 'Current password is incorrect.';
  const username = next.trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) return 'Username must be 3-30 chars: letters, numbers, dot, underscore, hyphen.';
  if (username === row.username.toLowerCase()) return 'Choose a different username.';
  if (d.prepare('SELECT id FROM platform_users WHERE lower(username) = ? AND id <> ?').get(username, userId)) return 'That username is already in use.';
  d.prepare('UPDATE platform_users SET username = ? WHERE id = ?').run(username, userId);
  d.prepare('DELETE FROM platform_sessions WHERE user_id = ? AND token <> ?').run(userId, tokenDigest(keepToken));
  return null;
}

export function platformLogout(token: string): void {
  platformDb().prepare('DELETE FROM platform_sessions WHERE token = ?').run(tokenDigest(token));
}

export function platformUserFromToken(token: string | null): PlatformUser | null {
  if (!token) return null;
  const row = platformDb().prepare(
    `SELECT u.id, u.username, u.full_name
     FROM platform_sessions s JOIN platform_users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at >= datetime('now')`
  ).get(tokenDigest(token)) as PlatformUser | undefined;
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
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : cookieValue(req.headers.cookie, 'vds_platform_session');
  const user = platformUserFromToken(token);
  if (!user) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  (req as PlatformAuthedRequest).platformUser = user;
  (req as PlatformAuthedRequest).platformToken = token ?? undefined;
  if (requiresPlatformPasskeySetup(user.id) && !req.path.startsWith('/passkeys') && !['/me','/logout'].includes(req.path)) {
    res.status(403).json({ error: 'Enroll a console passkey before accessing the console.', passkey_setup_required: true }); return;
  }
  if (hasPlatformPasskey(user.id) && !req.path.startsWith('/passkeys') && req.path !== '/logout' && !platformSessionVerified(token!, !['GET','HEAD','OPTIONS'].includes(req.method))) {
    res.status(403).json({ error: 'Verify your console passkey to continue.', passkey_required: true }); return;
  }
  next();
}
