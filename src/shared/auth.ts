/**
 * Session-token authentication and role-based access middleware.
 * Tokens are random 256-bit strings stored in the `sessions` table with a 12-hour expiry.
 *
 * Each session also records where it was signed in (device ID, IP, user agent — see
 * device.ts) and when it was last used. Signing out ENDS the row (ended_at + end_reason)
 * instead of deleting it, so an account's sign-in history survives until cleanupSessions()
 * sweeps it (SESSION_HISTORY_DAYS). Outside this file a session is addressed by its `sid`,
 * never by its token.
 *
 * A "borrowed phone" sign-in (`shared`) is a short session — SHARED_SESSION_HOURS max and
 * SHARED_IDLE_MINUTES idle — for an employee using a coworker's device; the client keeps its
 * token in sessionStorage so it also ends when the app is closed.
 */
import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { db, newToken } from './db';
import type { AuthUser, AuthSession, Role } from './types';
import { userPermissions } from './roles';
import { deviceIdOf, clientIpOf, userAgentOf, deviceLabel } from './device';
import { browserToken } from './browser-session';
import { syncHooks } from './sync-context';

const SESSION_HOURS = 12;
export const SHARED_SESSION_HOURS = 4;
export const SHARED_IDLE_MINUTES = 30;
/** last_seen_at is rewritten at most this often per session (plus whenever the IP changes). */
const TOUCH_SECONDS = 60;

export type SessionEndReason = 'logout' | 'revoked' | 'password' | 'deactivated' | 'expired' | 'idle';

interface UserSessionRow {
  id: number;
  username: string;
  full_name: string;
  role: Role;
  department_id: number | null;
  active: number;
  permission_overrides: string;
  department_name: string | null;
  s_sid: string;
  s_shared: number;
  s_device_id: string | null;
  s_last_seen_at: string | null;
  s_last_ip: string | null;
}

/** Start a session. `req` (the login request) supplies the device ID / IP / user agent. */
export function createSession(userId: number, opts: { req?: Request; shared?: boolean } = {}): string {
  const token = newToken();
  const sid = crypto.randomBytes(8).toString('hex');
  const shared = opts.shared ? 1 : 0;
  const hours = shared ? SHARED_SESSION_HOURS : SESSION_HOURS;
  const ip = opts.req ? clientIpOf(opts.req) : null;
  db.prepare(
    `INSERT INTO sessions (token, sid, user_id, expires_at, device_id, ip, user_agent, last_seen_at, last_ip, shared, idle_minutes)
     VALUES (?, ?, ?, datetime('now', '+${hours} hours'), ?, ?, ?, datetime('now'), ?, ?, ?)`
  ).run(
    token, sid, userId,
    opts.req ? deviceIdOf(opts.req) : null, ip, opts.req ? userAgentOf(opts.req) : null, ip,
    shared, shared ? SHARED_IDLE_MINUTES : null
  );
  return token;
}

/** End one session by token (kept as history). */
export function endSession(token: string, reason: SessionEndReason): void {
  db.prepare(
    "UPDATE sessions SET ended_at = datetime('now'), end_reason = ? WHERE token = ? AND ended_at IS NULL"
  ).run(reason, token);
}

/** Sign-out of the current session. */
export function destroySession(token: string): void {
  endSession(token, 'logout');
}

/** End every live session of a user, optionally keeping one (the caller's own). Returns how many ended. */
export function endUserSessions(userId: number, reason: SessionEndReason, exceptToken?: string): number {
  const info = db.prepare(
    `UPDATE sessions SET ended_at = datetime('now'), end_reason = ?
     WHERE user_id = ? AND ended_at IS NULL AND token != ?`
  ).run(reason, userId, exceptToken ?? '');
  return Number(info.changes);
}

/** End one of a user's sessions by its public sid. False if it isn't theirs or already ended. */
export function endSessionBySid(userId: number, sid: string, reason: SessionEndReason): boolean {
  const info = db.prepare(
    `UPDATE sessions SET ended_at = datetime('now'), end_reason = ?
     WHERE user_id = ? AND sid = ? AND ended_at IS NULL`
  ).run(reason, userId, sid);
  return Number(info.changes) > 0;
}

function resolveSession(token: string | null): { user: AuthUser; session: AuthSession } | null {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.full_name, u.role, u.department_id, u.active,
              u.permission_overrides, d.name AS department_name,
              s.sid AS s_sid, s.shared AS s_shared, s.device_id AS s_device_id,
              s.last_seen_at AS s_last_seen_at, s.last_ip AS s_last_ip
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN departments d ON d.id = u.department_id
       WHERE s.token = ? AND s.ended_at IS NULL AND s.expires_at >= datetime('now')
         AND (s.idle_minutes IS NULL
              OR COALESCE(s.last_seen_at, s.created_at) >= datetime('now', '-' || s.idle_minutes || ' minutes'))`
    )
    .get(token) as UserSessionRow | undefined;
  if (!row || row.active !== 1) return null;
  let overrides: Record<string, boolean> = {};
  try { overrides = JSON.parse(row.permission_overrides) as Record<string, boolean>; } catch { /* use empty */ }
  const {
    permission_overrides: _po, s_sid, s_shared, s_device_id, s_last_seen_at, s_last_ip, ...rest
  } = row;
  return {
    user: { ...rest, permissions: userPermissions(row.role, overrides) },
    session: { sid: s_sid, shared: s_shared === 1, device_id: s_device_id, last_seen_at: s_last_seen_at, last_ip: s_last_ip },
  };
}

/** An active user by id, built exactly as a session user is (current role + overrides), or
 *  null if missing / disabled. Used when a synced command is replayed as its actor. */
export function authUserById(id: number): AuthUser | null {
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.full_name, u.role, u.department_id, u.active,
              u.permission_overrides, d.name AS department_name
       FROM users u LEFT JOIN departments d ON d.id = u.department_id WHERE u.id = ?`
    )
    .get(id) as (Omit<AuthUser, 'permissions'> & { permission_overrides: string }) | undefined;
  if (!row || row.active !== 1) return null;
  let overrides: Record<string, boolean> = {};
  try { overrides = JSON.parse(row.permission_overrides) as Record<string, boolean>; } catch { /* use empty */ }
  const { permission_overrides: _po, ...rest } = row;
  return { ...rest, permissions: userPermissions(row.role, overrides) };
}

/** Resolve a bearer token to the current user, or null if invalid/expired/ended/disabled. */
export function userFromToken(token: string | null): AuthUser | null {
  return resolveSession(token)?.user ?? null;
}

/** Record that the session was just used (throttled — see TOUCH_SECONDS). */
function touchSession(token: string, session: AuthSession, ip: string | null): void {
  const stale = !session.last_seen_at
    || Date.now() - new Date(session.last_seen_at.replace(' ', 'T') + 'Z').getTime() >= TOUCH_SECONDS * 1000;
  if (!stale && ip === session.last_ip) return;
  try {
    db.prepare("UPDATE sessions SET last_seen_at = datetime('now'), last_ip = ? WHERE token = ?").run(ip, token);
  } catch { /* bookkeeping must never fail a request */ }
}

export function getToken(req: Request): string | null {
  const header = req.headers['authorization'] || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return browserToken(req);
}

/** Require a logged-in user; attaches req.user, req.token and req.authSession. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  // An internal sync replay (src/sync/replay.ts) runs as the command's actor, not a session.
  const replayUser = syncHooks.replayUser?.(req);
  if (replayUser) {
    req.user = replayUser;
    next();
    return;
  }
  const token = getToken(req);
  const resolved = resolveSession(token);
  if (!resolved || !token) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  const expectedActor = req.get('X-Queue-Actor');
  if (expectedActor && expectedActor !== String(resolved.user.id)) {
    res.status(409).json({ error: 'Queued action belongs to another account. Sign in as its owner.' }); return;
  }
  touchSession(token, resolved.session, clientIpOf(req));
  req.user = resolved.user;
  req.token = token;
  req.authSession = resolved.session;
  next();
}

export interface SessionListRow {
  id: string;
  current: boolean;
  device: string;
  device_id: string | null;
  shared: boolean;
  ip: string | null;
  last_ip: string | null;
  created_at: string;
  last_seen_at: string | null;
  expires_at: string;
  ended_at: string | null;
  end_reason: string | null;
}

/** A user's sessions, newest first: live ones, plus ended/expired history when asked. The
 *  token is never returned. Live-but-idle-timed-out borrowed sessions are reported as ended. */
export function listUserSessions(userId: number, opts: { currentToken?: string; includeEnded?: boolean } = {}): SessionListRow[] {
  const rows = db.prepare(
    `SELECT token, sid, device_id, user_agent, shared, ip, last_ip, created_at, last_seen_at, expires_at,
            CASE
              WHEN ended_at IS NOT NULL THEN ended_at
              WHEN expires_at < datetime('now') THEN expires_at
              WHEN idle_minutes IS NOT NULL
                AND COALESCE(last_seen_at, created_at) < datetime('now', '-' || idle_minutes || ' minutes')
                THEN datetime(COALESCE(last_seen_at, created_at), '+' || idle_minutes || ' minutes')
            END AS ended_at,
            CASE
              WHEN ended_at IS NOT NULL THEN end_reason
              WHEN expires_at < datetime('now') THEN 'expired'
              WHEN idle_minutes IS NOT NULL
                AND COALESCE(last_seen_at, created_at) < datetime('now', '-' || idle_minutes || ' minutes')
                THEN 'idle'
            END AS end_reason
     FROM sessions WHERE user_id = ?
     ORDER BY COALESCE(last_seen_at, created_at) DESC LIMIT 200`
  ).all(userId) as Array<{
    token: string; sid: string; device_id: string | null; user_agent: string | null; shared: number;
    ip: string | null; last_ip: string | null; created_at: string; last_seen_at: string | null;
    expires_at: string; ended_at: string | null; end_reason: string | null;
  }>;
  return rows
    .filter((r) => opts.includeEnded || !r.ended_at)
    .map((r) => ({
      id: r.sid,
      current: !!opts.currentToken && r.token === opts.currentToken,
      device: deviceLabel(r.user_agent),
      device_id: r.device_id,
      shared: r.shared === 1,
      ip: r.ip,
      last_ip: r.last_ip,
      created_at: r.created_at,
      last_seen_at: r.last_seen_at,
      expires_at: r.expires_at,
      ended_at: r.ended_at,
      end_reason: r.end_reason,
    }));
}

/** The account that normally uses a device: the one with the most ordinary (not borrowed-phone)
 *  sign-ins on it within the kept history, ties going to the most recent. Null if unknown. */
export function deviceUsualUserId(deviceId: string | null): number | null {
  if (!deviceId) return null;
  const row = db.prepare(
    `SELECT user_id FROM sessions WHERE device_id = ? AND shared = 0
     GROUP BY user_id ORDER BY COUNT(*) DESC, MAX(created_at) DESC LIMIT 1`
  ).get(deviceId) as { user_id: number } | undefined;
  return row?.user_id ?? null;
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
