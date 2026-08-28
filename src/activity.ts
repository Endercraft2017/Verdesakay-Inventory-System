/**
 * Application activity log. A single middleware (wired in app.ts) records every
 * *mutating* API request — who, when, which endpoint / record, the result, and a
 * redacted snapshot of the request body — into the `activity_log` table.
 * Read it back via GET /api/activity (admin-only, `audit.view`).
 */
import type { Request, Response } from 'express';
import { run } from './db';

const SKIP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const REDACT_KEY = /pass|password|token|secret|hash|otp|\bpin\b/i;
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
  if (value == null || depth > 6) return value;
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

/** Redacted JSON snapshot of what the request carried (body / query / file). */
function buildMeta(req: Request): string | null {
  const payload: Record<string, unknown> = {};
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

/** Record one finished request. Never throws into the response path. */
export function recordActivity(req: Request, res: Response): void {
  try {
    const path = (req.originalUrl || req.url || '').split('?')[0] ?? '';
    if (!path.startsWith('/api')) return;
    if (SKIP_METHODS.has(req.method)) return;
    if (path === '/api/health') return;

    const entity = deriveEntity(path);
    const action = deriveAction(req.method, path);
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
      action === 'login'
        ? (ok ? 'Signed in' : 'Failed sign-in')
        : `${action} ${entity}${entityId ? ` #${entityId}` : ''}${ok ? '' : ` — failed (${res.statusCode})`}`;

    run(
      `INSERT INTO activity_log
        (user_id, user_name, method, path, entity, entity_id, action, status_code, ip, summary, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      user?.id ?? null,
      userName,
      req.method,
      path,
      entity,
      entityId,
      action,
      res.statusCode,
      req.ip ?? req.socket?.remoteAddress ?? null,
      summary,
      buildMeta(req)
    );
  } catch {
    /* the activity log must never break a request */
  }
}
