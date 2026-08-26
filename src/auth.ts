/**
 * Session-token authentication and role-based access middleware.
 * Tokens are random 256-bit strings stored in the `sessions` table with a 12-hour expiry.
 */
import type { Request, Response, NextFunction } from 'express';
import { db, newToken } from './db';
import type { AuthUser, Role } from './types';
import { resolvePermissions } from './permissions';

const SESSION_HOURS = 12;

interface UserSessionRow {
  id: number;
  username: string;
  full_name: string;
  role: Role;
  department_id: number | null;
  active: number;
  permission_overrides: string;
  department_name: string | null;
}

export function createSession(userId: number): string {
  const token = newToken();
  db.prepare(
    `INSERT INTO sessions (token, user_id, expires_at)
     VALUES (?, ?, datetime('now', '+${SESSION_HOURS} hours'))`
  ).run(token, userId);
  return token;
}

export function destroySession(token: string): void {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

/** Resolve a bearer token to the current user, or null if invalid/expired/disabled. */
export function userFromToken(token: string | null): AuthUser | null {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.full_name, u.role, u.department_id, u.active,
              u.permission_overrides, d.name AS department_name
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN departments d ON d.id = u.department_id
       WHERE s.token = ? AND s.expires_at >= datetime('now')`
    )
    .get(token) as UserSessionRow | undefined;
  if (!row || row.active !== 1) return null;
  let overrides: Record<string, boolean> = {};
  try { overrides = JSON.parse(row.permission_overrides) as Record<string, boolean>; } catch { /* use empty */ }
  const { permission_overrides: _po, ...rest } = row;
  return { ...rest, permissions: resolvePermissions(row.role, overrides) };
}

export function getToken(req: Request): string | null {
  const header = req.headers['authorization'] || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return null;
}

/** Require a logged-in user; attaches req.user and req.token. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = getToken(req);
  const user = userFromToken(token);
  if (!user) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  req.user = user;
  req.token = token ?? undefined;
  next();
}

/** Require a resolved permission key (use after requireAuth). */
export function requirePermission(permission: import('./types').Permission) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user || !req.user.permissions.includes(permission)) {
      res.status(403).json({ error: 'Forbidden: insufficient permissions' });
      return;
    }
    next();
  };
}

/** Require any one of several permission keys (use after requireAuth) — for an action that
    more than one distinct area of the app is independently allowed to perform. */
export function requireAnyPermission(permissions: import('./types').Permission[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user || !permissions.some((p) => req.user!.permissions.includes(p))) {
      res.status(403).json({ error: 'Forbidden: insufficient permissions' });
      return;
    }
    next();
  };
}
