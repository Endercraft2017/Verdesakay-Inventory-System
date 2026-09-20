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
import { db } from './db';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const KEY_RE = /^[A-Za-z0-9._:-]{8,200}$/;
const DONT_STORE = new Set([401, 403, 429]); // retryable without changing the request

interface StoredRow {
  status_code: number;
  response: string;
}

export function idempotency(req: Request, res: Response, next: NextFunction): void {
  const key = req.get('Idempotency-Key');
  if (!key || !MUTATING.has(req.method)) return next();
  if (!KEY_RE.test(key)) {
    res.status(400).json({ error: 'Malformed Idempotency-Key' });
    return;
  }

  const existing = db
    .prepare('SELECT status_code, response FROM idempotency_keys WHERE key = ?')
    .get(key) as StoredRow | undefined;
  if (existing) {
    res.set('Idempotency-Replayed', 'true');
    res.status(existing.status_code).type('application/json').send(existing.response);
    return;
  }

  // Capture the JSON body the handler sends, then persist the outcome.
  const sendJson = res.json.bind(res);
  res.json = (body: unknown) => {
    if (res.statusCode < 500 && !DONT_STORE.has(res.statusCode)) {
      try {
        db.prepare(
          `INSERT OR IGNORE INTO idempotency_keys (key, user_id, method, path, status_code, response)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(key, req.user?.id ?? null, req.method, req.path, res.statusCode, JSON.stringify(body));
      } catch {
        /* never let bookkeeping break the response */
      }
    }
    return sendJson(body);
  };
  next();
}
