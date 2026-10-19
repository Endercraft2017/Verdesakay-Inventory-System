/** Completed creation receipts live in the control-plane transaction, never tenant sync. */
import { createHash } from 'node:crypto';
import { platformDb, getTenant } from './platform';
import { hashPassword, verifyPassword } from '../shared/password-hash';
import { ControlPlaneError } from './request-errors';

const TTL_MS = 24 * 60 * 60 * 1000;
type ReceiptRow = { verifier: string | null; response: string | null; tenant_slug: string; expires_at: number };
export type CreationReceipt = { scope: string; keyHash: string; verifier: string; replay?: unknown };

// Schemas have parsed/stripped unknown properties before this function. Property order is irrelevant;
// array order remains significant. Never persist this serialization or a fast password verifier.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value)
    .filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}

export function pruneCreationReceipts(): void {
  // Keep a minimal tombstone: expiring a response must not permit the same key to create again.
  platformDb().prepare(`UPDATE platform_creation_receipts SET verifier=NULL,response=NULL
    WHERE expires_at<=? AND response IS NOT NULL`).run(Date.now());
}

export function prepareCreationReceipt(scope: string, key: string | undefined, input: unknown): CreationReceipt | null {
  if (key === undefined) return null; // Compatibility for older API clients, not duplicate protection.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) {
    throw new ControlPlaneError(400, 'Idempotency-Key must be a random UUID v4.');
  }
  pruneCreationReceipts();
  const keyHash = createHash('sha256').update(key.toLowerCase()).digest('hex');
  const digest = createHash('sha256').update(canonical(input)).digest('hex');
  const row = platformDb().prepare('SELECT verifier,response,tenant_slug,expires_at FROM platform_creation_receipts WHERE scope=? AND key_hash=?')
    .get(scope, keyHash) as ReceiptRow | undefined;
  if (row) {
    if (!row.verifier || !row.response || row.expires_at <= Date.now()) {
      throw new ControlPlaneError(409, 'This creation request has expired. Check the existing workspaces before starting a new request.');
    }
    if (!verifyPassword(digest, row.verifier)) throw new ControlPlaneError(409, 'This creation request was already used with different details. Check the existing workspace.');
    const tenant = getTenant(row.tenant_slug);
    if (!tenant || tenant.status === 'purged') throw new ControlPlaneError(409, 'The workspace for this creation request is no longer available.');
    return { scope, keyHash, verifier: row.verifier, replay: JSON.parse(row.response) };
  }
  // Salted scrypt is deliberate: hashing a payload containing a password with SHA alone would
  // add a cheap offline password oracle to a stolen platform database.
  return { scope, keyHash, verifier: hashPassword(digest) };
}

/** Call only within createTenant's publication callback, after the response has been prepared. */
export function saveCreationReceipt(receipt: CreationReceipt | null, slug: string, response: unknown): undefined {
  if (!receipt) return;
  const inserted = platformDb().prepare(`INSERT INTO platform_creation_receipts
    (scope,key_hash,verifier,response,tenant_slug,expires_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(scope,key_hash) DO NOTHING`).run(receipt.scope, receipt.keyHash, receipt.verifier, JSON.stringify(response), slug, Date.now() + TTL_MS);
  if (inserted.changes !== 1) throw new ControlPlaneError(409, 'Another request completed this creation. Retry with the same key and details.');
}
