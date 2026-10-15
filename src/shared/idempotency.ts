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
import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { db, activeDb } from './db';
import { requireAuth } from './auth';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const KEY_RE = /^[A-Za-z0-9._:-]{8,200}$/;
const DONT_STORE = new Set([401, 403, 429]); // retryable without changing the request

interface StoredRow {
  status_code: number;
  response: string;
  path: string;
  method: string;
}

const pending = new WeakMap<object, Set<string>>();

export function idempotency(req: Request, res: Response, next: NextFunction): void {
  const key = req.get('Idempotency-Key');
  if (!key || !MUTATING.has(req.method)) return next();
  if (!KEY_RE.test(key)) {
    res.status(400).json({ error: 'Malformed Idempotency-Key' });
    return;
  }

  // Recovery and sign-in must never cache bearer tokens or bypass password checks.
  // Multipart bodies are parsed later: their key identifies the whole upload; only
  // JSON requests can additionally compare parsed payloads here.
  if (/^\/api\/(auth|signup|sync)(?:\/|$)/i.test(req.originalUrl.split('?')[0] ?? '')) return next();

  requireAuth(req, res, () => {
    const user = req.user!;
    // Legacy rows lack reliable request binding. Never replay their private response,
    // and never reapply an old stock action just because the cache format changed.
    if (db.prepare('SELECT 1 FROM idempotency_keys WHERE key = ?').get(key)) {
      res.status(409).json({ error: 'This action predates the security upgrade. Check its status before retrying with a new key.' });
      return;
    }
    const scopedKey = 'v2:' + crypto.createHash('sha256')
      .update(JSON.stringify([user.id, key])).digest('hex');
    const fingerprint = JSON.stringify([
      req.originalUrl, req.body, user.role, user.department_id,
      [...user.permissions].sort(),
    ]);
    const requestPath = crypto.createHash('sha256').update(fingerprint).digest('hex');
    const existing = db.prepare('SELECT status_code, response, path, method FROM idempotency_keys WHERE key = ?')
      .get(scopedKey) as StoredRow | undefined;
    if (existing) {
      if (existing.method !== req.method || existing.path !== requestPath) {
        res.status(409).json({ error: 'Idempotency-Key was already used for a different request or access scope.' });
        return;
      }
      res.set('Idempotency-Replayed', 'true');
      res.status(existing.status_code).type('application/json').send(existing.response);
      return;
    }
    const conn = activeDb();
    let active = pending.get(conn);
    if (!active) { active = new Set(); pending.set(conn, active); }
    if (active.has(scopedKey)) {
      res.status(409).json({ error: 'This request is still processing. Retry shortly.' });
      return;
    }
    active.add(scopedKey);
    const release = () => active!.delete(scopedKey);
    res.once('finish', release);
    res.once('close', release);

    // Capture the JSON body the handler sends, then persist the outcome.
    const sendJson = res.json.bind(res);
    res.json = (body: unknown) => {
      if (res.statusCode < 500 && !DONT_STORE.has(res.statusCode)) {
        try {
          db.prepare(
            `INSERT OR IGNORE INTO idempotency_keys (key, user_id, method, path, status_code, response)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).run(scopedKey, user.id, req.method, requestPath, res.statusCode, JSON.stringify(body));
        } catch {
          /* never let bookkeeping break the response */
        }
      }
      return sendJson(body);
    };
    next();
  });
}
