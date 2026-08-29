/**
 * SaaS control plane. A separate SQLite file (`platform.db`, NOT a tenant DB and never
 * reached through `tenantStore`) holding the tenant catalog + provisioning log, plus the
 * request → tenant-slug resolver. See docs/SAAS-READINESS.md §§2, 6, 8, 11.
 *
 * Single-tenant / self-hosted installs never touch this: the `default` tenant resolves
 * without a catalog row and everything behaves exactly as before.
 */
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_TENANT } from './db';

const ROOT = path.join(import.meta.dirname, '..');

export const PLATFORM_DB_PATH = process.env.PLATFORM_DB_PATH || path.join(ROOT, 'platform.db');
/** Root domain for tenant subdomains, e.g. `verdesakay.app`. Empty ⇒ single-tenant. */
export const APP_DOMAIN = (process.env.APP_DOMAIN || '').toLowerCase().trim();
/** Self-serve `POST /api/signup` is only live when this is exactly "true". */
export const SIGNUPS_OPEN = process.env.SIGNUPS_OPEN === 'true';

/** Sub-domains that can never be a tenant slug. */
export const RESERVED_SLUGS = new Set([
  'www', 'app', 'api', 'admin', 'static', 'assets', 'cdn', 'img', 'files',
  'mail', 'smtp', 'imap', 'ftp', 'ns1', 'ns2',
  'platform', '_platform', 'default', 'localhost', 'test', 'tests', 'staging',
  'stage', 'dev', 'demo', 'status', 'health', 'help', 'support', 'docs', 'blog',
  'signup', 'login', 'auth', 'billing', 'account',
]);

export type TenantStatus = 'trial' | 'active' | 'past_due' | 'suspended' | 'purged';

export interface TenantRow {
  id: number;
  slug: string;
  name: string;
  status: TenantStatus;
  plan: string;
  trial_ends_at: string | null;
  notes: string | null;
  created_at: string;
}

let _db: DatabaseSync | null = null;
function pdb(): DatabaseSync {
  if (_db) return _db;
  const d = new DatabaseSync(PLATFORM_DB_PATH);
  d.exec('PRAGMA journal_mode = WAL;');
  d.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      slug          TEXT NOT NULL UNIQUE,
      name          TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('trial','active','past_due','suspended','purged')),
      plan          TEXT NOT NULL DEFAULT 'starter',
      trial_ends_at TEXT,
      notes         TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS provisioning_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      slug       TEXT NOT NULL,
      action     TEXT NOT NULL,
      detail     TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  _db = d;
  return d;
}

/** For tests: drop the cached handle so a new PLATFORM_DB_PATH takes effect. */
export function _resetPlatformDb(): void {
  try { _db?.close(); } catch { /* ignore */ }
  _db = null;
}

export function isValidSlug(slug: string): boolean {
  return /^[a-z][a-z0-9-]{1,30}$/.test(slug) && !slug.includes('--') && !RESERVED_SLUGS.has(slug);
}

export function getTenant(slug: string): TenantRow | null {
  return (pdb().prepare('SELECT * FROM tenants WHERE slug = ?').get(slug) as unknown as TenantRow | undefined) ?? null;
}

export function listTenants(): TenantRow[] {
  return pdb().prepare('SELECT * FROM tenants ORDER BY created_at DESC').all() as unknown as TenantRow[];
}

export function createTenantRow(input: {
  slug: string; name: string; plan?: string; status?: TenantStatus; trial_ends_at?: string | null;
}): TenantRow {
  const info = pdb().prepare(
    `INSERT INTO tenants (slug, name, plan, status, trial_ends_at) VALUES (?, ?, ?, ?, ?)`
  ).run(
    input.slug, input.name, input.plan ?? 'starter', input.status ?? 'active', input.trial_ends_at ?? null
  );
  return pdb().prepare('SELECT * FROM tenants WHERE id = ?').get(info.lastInsertRowid) as unknown as TenantRow;
}

export function setTenantStatus(slug: string, status: TenantStatus): boolean {
  return pdb().prepare('UPDATE tenants SET status = ? WHERE slug = ?').run(status, slug).changes > 0;
}

export function setTenantPlan(slug: string, plan: string): boolean {
  return pdb().prepare('UPDATE tenants SET plan = ? WHERE slug = ?').run(plan, slug).changes > 0;
}

/** ISO datetime string, or null to clear the trial end. */
export function setTrialEndsAt(slug: string, when: string | null): boolean {
  return pdb().prepare('UPDATE tenants SET trial_ends_at = ? WHERE slug = ?').run(when, slug).changes > 0;
}

export function logProvisioning(slug: string, action: string, detail?: string): void {
  pdb().prepare('INSERT INTO provisioning_log (slug, action, detail) VALUES (?, ?, ?)')
    .run(slug, action, detail ?? null);
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Which tenant a request is for. In non-production, an `X-Tenant` header or `?tenant=`
 * query wins (so tests / localhost work with no DNS). Otherwise the sub-domain:
 * `<slug>.<APP_DOMAIN>` → `slug`; the apex, `www`, an IP, `localhost`, a reserved label,
 * or anything when `APP_DOMAIN` is unset → the `default` tenant.
 */
export function resolveTenantSlug(
  host: string | undefined,
  headerTenant?: string | null,
  queryTenant?: string | null
): string {
  if (process.env.NODE_ENV !== 'production') {
    const o = String(headerTenant || queryTenant || '').toLowerCase().trim();
    if (o) return isValidSlug(o) ? o : DEFAULT_TENANT;
  }
  const h = String(host || '').toLowerCase().split(':')[0]!.trim();
  if (!h || h === 'localhost' || h === '[::1]' || IPV4.test(h)) return DEFAULT_TENANT;

  const label = h.split('.')[0]!;
  if (APP_DOMAIN) {
    if (h === APP_DOMAIN || h === `www.${APP_DOMAIN}`) return DEFAULT_TENANT;
    if (h.endsWith(`.${APP_DOMAIN}`)) return isValidSlug(label) ? label : DEFAULT_TENANT;
    return DEFAULT_TENANT; // custom domains handled in a later phase
  }
  // No APP_DOMAIN configured — treat a valid first label as the tenant, else default.
  return isValidSlug(label) ? label : DEFAULT_TENANT;
}
