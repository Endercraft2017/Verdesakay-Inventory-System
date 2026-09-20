/**
 * SaaS control plane. A separate SQLite file (`platform.db`, NOT a tenant DB and never
 * reached through `tenantStore`) holding the tenant catalog + provisioning log, plus the
 * request → tenant-slug resolver. See docs/SAAS-READINESS.md §§2, 6, 8, 11.
 *
 * Single-tenant / self-hosted installs never touch this: the `default` tenant resolves
 * without a catalog row and everything behaves exactly as before.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import { DEFAULT_TENANT } from '../shared/db';

const ROOT = path.join(import.meta.dirname, '..', '..');

export const PLATFORM_DB_PATH = process.env.PLATFORM_DB_PATH || path.join(ROOT, 'db', 'platform.db');
/** Root domain for tenant subdomains, e.g. `verdesakay.app`. Empty ⇒ single-tenant. */
export const APP_DOMAIN = (process.env.APP_DOMAIN || '').toLowerCase().trim();
/** Self-serve `POST /api/signup` is only live when this is exactly "true". */
export const SIGNUPS_OPEN = process.env.SIGNUPS_OPEN === 'true';
/** The owner console at `/_platform` is only mounted when this is exactly "true".
 *  Off ⇒ the path 404s entirely (single-tenant / self-hosted installs never expose it). */
export const PLATFORM_CONSOLE = process.env.PLATFORM_CONSOLE === 'true';

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
  /** Per-tenant feature-module override: a JSON string array, or null to use the
   *  plan's default bundle. Resolved in src/modules.ts. */
  modules: string | null;
  /** Kiosk punch-photo retention, owner-only (see src/punch-photos.ts). null = use the
   *  system default; 0 = no limit for that dimension. */
  photo_retention_days: number | null;
  photo_max_mb: number | null;
  notes: string | null;
  created_at: string;
}

let _db: DatabaseSync | null = null;
function pdb(): DatabaseSync {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(PLATFORM_DB_PATH), { recursive: true });
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
    -- The owner-console operators. Completely separate from any tenant users table:
    -- a platform_users row can never log into a tenant, and vice-versa.
    CREATE TABLE IF NOT EXISTS platform_users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      full_name     TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      last_login_at TEXT
    );
    CREATE TABLE IF NOT EXISTS platform_sessions (
      token      TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  ensureColumn(d, 'tenants', 'modules', 'TEXT'); // added after the initial control-plane schema
  ensureColumn(d, 'tenants', 'photo_retention_days', 'INTEGER');
  ensureColumn(d, 'tenants', 'photo_max_mb', 'INTEGER');
  _db = d;
  seedPlatformUserFromEnv();
  return d;
}

/** The control-plane connection — for src/platform-users.ts. Never a tenant DB. */
export function platformDb(): DatabaseSync {
  return pdb();
}

/** First-run bootstrap: if there are no operators yet and PLATFORM_ADMIN_USERNAME /
 *  PLATFORM_ADMIN_PASSWORD are set, create one. Also lets you reset the password by
 *  restarting with those vars set (it upserts). Safe to call repeatedly. */
function seedPlatformUserFromEnv(): void {
  const u = (process.env.PLATFORM_ADMIN_USERNAME || '').toLowerCase().trim();
  const p = process.env.PLATFORM_ADMIN_PASSWORD || '';
  if (!u || p.length < 6) return;
  const count = (_db!.prepare('SELECT COUNT(*) AS c FROM platform_users').get() as { c: number }).c;
  const exists = _db!.prepare('SELECT 1 FROM platform_users WHERE username = ?').get(u);
  if (count > 0 && !exists) return; // don't silently add a second operator once set up
  const hash = bcrypt.hashSync(p, 10);
  _db!.prepare(
    `INSERT INTO platform_users (username, password_hash, full_name) VALUES (?, ?, ?)
     ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash`
  ).run(u, hash, process.env.PLATFORM_ADMIN_NAME || 'Owner');
}

/** Add a column to a platform.db table if it isn't there yet (control-plane migrations
 *  are rare — a probe-and-ALTER is enough, no version table). */
function ensureColumn(d: DatabaseSync, table: string, col: string, decl: string): void {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
  if (!cols.some((c) => c.name === col)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
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

export function setTenantName(slug: string, name: string): boolean {
  return pdb().prepare('UPDATE tenants SET name = ? WHERE slug = ?').run(name, slug).changes > 0;
}

export interface ProvisioningLogRow {
  id: number; slug: string; action: string; detail: string | null; created_at: string;
}

/** Recent control-plane events, newest first. Pass a slug to scope to one workspace. */
export function listProvisioningLog(slug?: string, limit = 100): ProvisioningLogRow[] {
  const q = slug
    ? pdb().prepare('SELECT * FROM provisioning_log WHERE slug = ? ORDER BY id DESC LIMIT ?').all(slug, limit)
    : pdb().prepare('SELECT * FROM provisioning_log ORDER BY id DESC LIMIT ?').all(limit);
  return q as unknown as ProvisioningLogRow[];
}

/** Set the per-tenant feature-module override. `mods` = an array of module names (stored
 *  as JSON), or null to clear the override and fall back to the plan's default bundle. */
export function setTenantModules(slug: string, mods: string[] | null): boolean {
  const value = mods === null ? null : JSON.stringify(mods);
  return pdb().prepare('UPDATE tenants SET modules = ? WHERE slug = ?').run(value, slug).changes > 0;
}

/** Kiosk punch-photo retention override for this tenant. Either value: null = system default,
 *  0 = no limit, a positive number = that many days / that many MB. */
export function setTenantPhotoRetention(
  slug: string,
  input: { days?: number | null; maxMb?: number | null }
): boolean {
  let changed = false;
  if ('days' in input) {
    changed = pdb().prepare('UPDATE tenants SET photo_retention_days = ? WHERE slug = ?').run(input.days ?? null, slug).changes > 0 || changed;
  }
  if ('maxMb' in input) {
    changed = pdb().prepare('UPDATE tenants SET photo_max_mb = ? WHERE slug = ?').run(input.maxMb ?? null, slug).changes > 0 || changed;
  }
  return changed;
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
