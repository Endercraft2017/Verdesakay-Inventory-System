/**
 * Idempotency middleware. When a mutating request carries an `Idempotency-Key`
 * header (the mobile offline queue sets one per queued operation), the first
 * outcome is recorded and any later request with the same key returns that stored
 * response verbatim instead of running the handler again.
 *
 * A 2xx or a deterministic 4xx (e.g. "not enough stock") is stored and replayed.
 * 5xx and the "try again later" statuses (401 / 403 / 429) are NOT stored, so a
 * genuine retry after a token refresh or transient failure still runs.
 */
import type { Request, Response, NextFunction } from 'express';
import { db, queryAll } from './db';
import { enabledModules } from './modules';
import { redactInventoryCosts } from './cost-visibility';
import { userFromToken, getToken, requireAuth } from './auth';
import { createHash } from 'node:crypto';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const KEY_RE = /^[A-Za-z0-9._:-]{8,200}$/;
const DONT_STORE = new Set([401, 403, 429]); // retryable without changing the request
// A local acknowledgement must stay local on retry. The prefix cannot collide
// with a JSON response; older plain JSON rows remain readable without migration.
const LOCAL_RESPONSE_PREFIX = 'vds-local-response-v1:';
const AUTH_RESPONSE_PREFIX = 'vds-authorized-response-v2:';

interface StoredRow {
  status_code: number;
  response: string;
  user_id: number | null;
  method: string;
  path: string;
  request_hash: string | null;
}

export function idempotency(req: Request, res: Response, next: NextFunction): void {
  // Case writes use their own transaction-bound request keys, ownership and versions.
  // General attachment/order retries retain the upstream authenticated cache behavior.
  if (/^\/customer-cases(\/|$)/i.test(req.path)) return next();
  const key = req.get('Idempotency-Key');
  if (!key || !MUTATING.has(req.method)) return next();
  if (!KEY_RE.test(key)) {
    res.status(400).json({ error: 'Malformed Idempotency-Key' });
    return;
  }
  const user = req.user ?? userFromToken(getToken(req));
  // Never serve cached private responses before authentication. Public endpoints
  // proceed normally; they do not use authenticated request deduplication.
  if (!user) return next();
  const assignments = user.permissions.includes('production.record') ? queryAll<{id:number}>(`SELECT j.id FROM job_orders j WHERE
    EXISTS(SELECT 1 FROM job_order_assignees a WHERE a.job_order_id=j.id AND a.user_id=?) OR
    EXISTS(SELECT 1 FROM production_team_members m JOIN employees e ON e.id=m.employee_id WHERE m.team_id=j.team_id AND e.user_id=?) ORDER BY j.id`,user.id,user.id).map(r=>r.id) : [];
  const accessHash = createHash('sha256').update(JSON.stringify([
    user.role, [...user.permissions].sort(), user.department_id, !!user.password_change_required,
    [...enabledModules()].sort(),assignments,
  ])).digest('hex');
  const path = req.originalUrl.split('?')[0]!;
  // Older global middleware stored paths relative to /api; retain those retry keys.
  const apiIndex = path.indexOf('/api/');
  const legacyPath = apiIndex >= 0 ? path.slice(apiIndex + 4) : path;
  // The JSON parser runs before this middleware. Multipart bodies are parsed later by the
  // route, so their existing stable-key behavior remains unchanged.
  const requestHash = req.is('application/json') ? createHash('sha256').update(JSON.stringify(req.body)).digest('hex') : null;

  const existing = db
    .prepare('SELECT status_code, response, user_id, method, path, request_hash FROM idempotency_keys WHERE key = ?')
    .get(key) as StoredRow | undefined;
  if (existing) {
    if (existing.user_id !== user.id || existing.method !== req.method || (existing.path !== path && existing.path !== req.path && existing.path !== legacyPath)) {
      res.status(409).json({ error: 'This save key belongs to a different request. Start a new save attempt.' });
      return;
    }
    if (existing.request_hash && existing.request_hash !== requestHash) {
      res.status(409).json({ error: 'This save key belongs to a different request body. Review the result and use a new key for a changed decision.' });
      return;
    }
    requireAuth(req, res, () => {
      if (!existing.response.startsWith(AUTH_RESPONSE_PREFIX)) {
        res.status(409).json({ error: 'This saved result predates access verification. Check the existing record before making another save.', code: 'saved_access_changed' }); return;
      }
      const saved = JSON.parse(existing.response.slice(AUTH_RESPONSE_PREFIX.length)) as { accessHash: string; response: string };
      if (saved.accessHash !== accessHash) {
        res.status(409).json({ error: 'Your access changed since this save. Check the existing record before retrying.', code: 'saved_access_changed' }); return;
      }
      res.set('Idempotency-Replayed', 'true');
      let response = saved.response;
      if (response.startsWith(LOCAL_RESPONSE_PREFIX)) {
        const local = JSON.parse(response.slice(LOCAL_RESPONSE_PREFIX.length)) as { response: string; command: string };
        res.set('X-Sync-State', 'local'); res.set('X-Sync-Command', local.command); response = local.response;
      }
      res.status(existing.status_code).type('application/json').send(response);
    });
    return;
  }

  // Capture the JSON body the handler sends, then persist the outcome.
  const sendJson = res.json.bind(res);
  res.json = (body: unknown) => {
    if (res.statusCode < 500 && !DONT_STORE.has(res.statusCode)) {
      try {
        let response = JSON.stringify(redactInventoryCosts(body,user,req.originalUrl));
        if (res.getHeader('X-Sync-State') === 'local') {
          response = LOCAL_RESPONSE_PREFIX + JSON.stringify({ response, command: String(res.getHeader('X-Sync-Command') || 'local') });
        }
        response = AUTH_RESPONSE_PREFIX + JSON.stringify({ accessHash, response });
        db.prepare(
          `INSERT OR IGNORE INTO idempotency_keys (key, user_id, method, path, status_code, response, request_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(key, user.id, req.method, path, res.statusCode, response, requestHash);
      } catch {
        /* never let bookkeeping break the response */
      }
    }
    return sendJson(body);
  };
  next();
}
