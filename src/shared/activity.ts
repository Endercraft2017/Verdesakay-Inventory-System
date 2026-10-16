/**
 * Application activity log. A single middleware (wired in app.ts) records every
 * *mutating* API request — who, when, which endpoint / record, the result, and a
 * redacted snapshot of the request body — into the `activity_log` table, with the caller's IP
 * and device (random device ID + a readable label; see device.ts).
 * Read it back via GET /api/activity (admin-only, `audit.view`).
 */
import type { Request, Response } from 'express';
import { run } from './db';
import { deviceIdOf, userAgentOf, deviceLabel, clientIpOf } from './device';

const SKIP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Field names whose values never reach the log: credentials and keys of every kind (an AI or
// payment provider key arrives as `api_key`, a bucket key as `key_id` / `access_key`).
const REDACT_KEY = /pass|password|token|secret|hash|otp|\bpin\b|api[_-]?key|private[_-]?key|access[_-]?key|key[_-]?id|credential|authorization|mfa|recovery|^code$/i;
const META_MAX = 4000;

/** Coarse module name for a path, e.g. "/api/inventory/5/adjust" -> "inventory". */
function deriveEntity(p: string): string {
  const seg = p.replace(/^\/api\/?/, '').split('/')[0] || 'api';
  const map: Record<string, string> = {
    auth: 'auth', users: 'users', inventory: 'inventory', orders: 'orders',
    forms: 'forms', messages: 'messages', templates: 'templates', hr: 'hr', ai: 'ai',
    'form-definitions': 'form-builder', 'form-records': 'form-builder',
    'global-variables': 'form-builder',
    notes: 'personal', tasks: 'personal', bookmarks: 'personal',
    activity: 'activity',
  };
  return map[seg] ?? seg;
}

/** Short verb for method + path. */
function deriveAction(method: string, p: string): string {
  if (p === '/api/auth/login') return 'login';
  if (p === '/api/auth/logout') return 'logout';
  if (/\/sessions\/(?:[^/]+\/)?revoke(?:-others|-all)?$/.test(p)) return 'session-revoke';
  if (/\/adjust$/.test(p)) return 'stock-adjust';
  if (/\/image$/.test(p)) return method === 'DELETE' ? 'image-remove' : 'image-set';
  if (/\/permissions$/.test(p)) return 'permissions-change';
  if (/\/reset-password$/.test(p)) return 'password-reset';
  if (/\/import$/.test(p)) return 'import';
  switch (method) {
    case 'POST': return 'create';
    case 'PUT':
    case 'PATCH': return 'update';
    case 'DELETE': return 'delete';
    default: return method.toLowerCase();
  }
}

/** Last numeric path segment, if any — the affected record id. */
function deriveEntityId(p: string): string | null {
  const segs = p.split('/').filter(Boolean);
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i];
    if (s && /^\d+$/.test(s)) return s;
  }
  return null;
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth limit]';
  if (value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 500) return value.slice(0, 500) + '…';
  return value;
}

/** What a route may put on `res.locals.activity` to replace the generic "delete hr #3" row with
 *  something readable. `snapshot` lands in meta — use it for records a DELETE is about to erase. */
export interface ActivityOverride {
  action?: string;
  summary?: string;
  snapshot?: unknown;
}

/** Redacted JSON snapshot of what the request carried (body / query / file). */
function buildMeta(req: Request, snapshot?: unknown): string | null {
  const payload: Record<string, unknown> = {};
  if (snapshot !== undefined) payload.snapshot = redact(snapshot);
  const body = req.body as unknown;
  if (body && typeof body === 'object' && Object.keys(body as object).length) {
    payload.body = redact(body);
  }
  if (req.query && Object.keys(req.query).length) payload.query = redact(req.query);
  const file = (req as Request & { file?: { fieldname: string; originalname: string; size: number } }).file;
  if (file) payload.file = { field: file.fieldname, name: file.originalname, size: file.size };
  if (!Object.keys(payload).length) return null;
  let json = JSON.stringify(payload);
  if (json.length > META_MAX) json = JSON.stringify({ truncated: true, preview: json.slice(0, META_MAX) });
  return json;
}

/** Record a named event the method-based middleware can't see — e.g. a GET that hands out a
 *  sensitive file (payslip download). Never throws into the response path. */
export function logEvent(
  req: Request,
  ev: { entity: string; entityId?: string | number | null; action: string; summary: string; statusCode?: number }
): void {
  try {
    const path = (req.originalUrl || req.url || '').split('?')[0] ?? '';
    run(
      `INSERT INTO activity_log
        (user_id, user_name, method, path, entity, entity_id, action, status_code, ip, device_id, device, summary, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      req.user?.id ?? null, req.user?.full_name ?? null, req.method, path, ev.entity,
      ev.entityId == null ? null : String(ev.entityId), ev.action, ev.statusCode ?? 200,
      clientIpOf(req), deviceIdOf(req), deviceLabel(userAgentOf(req)), ev.summary
    );
  } catch {
    /* the activity log must never break a request */
  }
}

/** Record one finished request. Never throws into the response path. */
export function recordActivity(req: Request, res: Response): void {
  try {
    const path = (req.originalUrl || req.url || '').split('?')[0] ?? '';
    if (!path.startsWith('/api')) return;
    if (SKIP_METHODS.has(req.method)) return;
    if (path === '/api/health') return;

    const entity = deriveEntity(path);
    const override = res.locals?.activity as ActivityOverride | undefined;
    const action = override?.action ?? deriveAction(req.method, path);
    // Prefer an id in the path; for creates, fall back to the id in the JSON response.
    const created = res.locals?.createdId;
    const entityId =
      deriveEntityId(path) ??
      (req.method === 'POST' && (typeof created === 'number' || typeof created === 'string')
        ? String(created)
        : null);
    const user = req.user ?? null;
    const ok = res.statusCode < 400;

    // Login isn't authenticated — record the attempted username instead.
    let userName: string | null = user?.full_name ?? null;
    const bodyUser = (req.body as { username?: unknown } | undefined)?.username;
    if (!userName && path === '/api/auth/login' && typeof bodyUser === 'string') userName = bodyUser;

    const summary =
      override?.summary && ok
        ? override.summary
        : action === 'login'
        ? (ok
          ? ((req.body as { shared?: unknown } | undefined)?.shared === true ? 'Signed in on a borrowed device' : 'Signed in')
          : 'Failed sign-in')
        : `${action} ${entity}${entityId ? ` #${entityId}` : ''}${ok ? '' : ` — failed (${res.statusCode})`}`;

    run(
      `INSERT INTO activity_log
        (user_id, user_name, method, path, entity, entity_id, action, status_code, ip, device_id, device, summary, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      user?.id ?? null,
      userName,
      req.method,
      path,
      entity,
      entityId,
      action,
      res.statusCode,
      clientIpOf(req),
      deviceIdOf(req),
      deviceLabel(userAgentOf(req)),
      summary,
      buildMeta(req, ok ? override?.snapshot : undefined)
    );
  } catch {
    /* the activity log must never break a request */
  }
}

/** Reapply current redaction to older records on read; malformed legacy metadata stays private. */
export function redactStoredMeta(meta: string | null): string | null {
  if (!meta) return meta;
  try {
    const parsed = JSON.parse(meta);
    if (parsed?.truncated) return JSON.stringify({ truncated: true, preview: '[legacy metadata withheld]' });
    return JSON.stringify(redact(parsed));
  } catch { return JSON.stringify({ unavailable: 'Legacy metadata requires restricted review.' }); }
}
