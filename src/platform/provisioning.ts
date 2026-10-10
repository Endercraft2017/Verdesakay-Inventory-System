/**
 * Tenant provisioning / de-provisioning. Runs with catalog-write privileges — kept out
 * of tenant-facing request code (only the `/api/signup` route and the CLI call it).
 * See docs/SAAS-READINESS.md §§7, 11.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import { withTenant, run, DATA_DIR, UPLOAD_DIR } from '../shared/db';
import {
  createTenantRow, getTenant, isValidSlug, logProvisioning, setTenantStatus,
  retiredDefaultTenant,
  type TenantStatus,
} from './platform';

export interface CreateTenantInput {
  slug: string;
  name: string;
  admin_username: string;
  admin_password: string;
  admin_email?: string;
  is_sandbox?: boolean;
  plan?: string;
  status?: TenantStatus;
}

function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

/** Create a tenant: catalog row + a fresh tenant DB seeded with the given admin login. */
export function createTenant(input: CreateTenantInput): { slug: string } {
  const slug = String(input.slug || '').toLowerCase().trim();
  if (!isValidSlug(slug)) {
    throw httpError(400, 'Workspace name must be 2–31 chars: a letter, then letters/numbers/hyphens (no reserved words).');
  }
  if (getTenant(slug)) throw httpError(409, 'That workspace name is already taken.');
  const username = String(input.admin_username || '').toLowerCase().trim();
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) throw httpError(400, 'Admin username must be 3–30 chars: letters, numbers, dot, underscore, hyphen.');
  if (String(input.admin_password || '').length < 6) throw httpError(400, 'Admin password must be at least 6 characters.');

  createTenantRow({ slug, name: input.name.trim() || slug, plan: input.plan, status: input.status, is_sandbox: input.is_sandbox });

  // withTenant opens + creates + migrates + seeds <DATA_DIR>/<slug>.db (seed() makes a
  // default 'admin' account); adopt the caller's chosen credentials onto it.
  withTenant(slug, () => {
    const hash = bcrypt.hashSync(input.admin_password, 10);
    run("UPDATE users SET username = ?, password_hash = ?, email = ? WHERE username = 'admin'", username, hash, input.is_sandbox ? null : (input.admin_email?.trim().toLowerCase() || null));
  });

  logProvisioning(slug, 'create', JSON.stringify({ name: input.name, plan: input.plan ?? 'starter', admin: username }));
  return { slug };
}

export interface ImportTenantInput {
  slug: string;
  name: string;
  plan?: string;
  /** A self-contained SQLite file of an existing workspace — ideally an `npm run backup`
   *  snapshot (VACUUM INTO), not a live data.db whose recent writes may sit in a -wal file. */
  sourceFile: string;
}

/** Adopt an existing workspace DB (e.g. a self-hosted install's data.db) as a new tenant:
 *  validate it, copy it to `<DATA_DIR>/<slug>.db`, drop its login sessions, add the catalog
 *  row, then open it once so it migrates to the current schema. Users, passwords and all
 *  records carry over unchanged. Uploaded files are not part of the DB and are not copied. */
export function importTenant(input: ImportTenantInput): { slug: string; users: number } {
  const slug = String(input.slug || '').toLowerCase().trim();
  if (!isValidSlug(slug)) {
    throw httpError(400, 'Workspace name must be 2–31 chars: a letter, then letters/numbers/hyphens (no reserved words).');
  }
  if (getTenant(slug)) throw httpError(409, 'That workspace name is already taken.');
  const dest = path.join(DATA_DIR, `${slug}.db`);
  if (fs.existsSync(dest)) throw httpError(409, `A database file for "${slug}" already exists on disk.`);

  const head = Buffer.alloc(16);
  const fd = fs.openSync(input.sourceFile, 'r');
  try { fs.readSync(fd, head, 0, 16, 0); } finally { fs.closeSync(fd); }
  if (head.toString('latin1') !== 'SQLite format 3\0') throw httpError(400, 'That file is not a SQLite database.');

  // Work on a private copy so a rejected import never leaves anything behind.
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const staging = path.join(DATA_DIR, `.import-${slug}-${crypto.randomBytes(4).toString('hex')}.db`);
  fs.copyFileSync(input.sourceFile, staging);
  let users = 0;
  try {
    const conn = new DatabaseSync(staging);
    try {
      const ok = (conn.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
      if (ok !== 'ok') throw httpError(400, `The database failed its integrity check (${ok}).`);
      const hasUsers = conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
      if (!hasUsers) throw httpError(400, 'That database is not a workspace from this app (no users table).');
      users = (conn.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
      if (users === 0) throw httpError(400, 'That database has no user accounts, so nobody could log in.');
      // Tokens issued by the old install must not log anyone in here.
      const hasSessions = conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get();
      if (hasSessions) conn.exec('DELETE FROM sessions');
      conn.exec('PRAGMA journal_mode = DELETE'); // fold any WAL back into the single file
    } finally {
      conn.close();
    }
    fs.renameSync(staging, dest);
  } catch (e) {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(staging + suffix, { force: true });
    throw e;
  }

  createTenantRow({ slug, name: input.name.trim() || slug, plan: input.plan });
  try {
    withTenant(slug, () => {}); // open → pre-migration snapshot → migrate to the current schema
  } catch (e) {
    setTenantStatus(slug, 'suspended');
    logProvisioning(slug, 'import-failed', (e as Error).message);
    throw e;
  }
  logProvisioning(slug, 'import', JSON.stringify({ name: input.name, plan: input.plan ?? 'starter', users }));
  return { slug, users };
}

export function suspendTenant(slug: string): boolean {
  const ok = setTenantStatus(slug, 'suspended');
  if (ok) logProvisioning(slug, 'suspend');
  return ok;
}

export function resumeTenant(slug: string): boolean {
  const ok = setTenantStatus(slug, 'active');
  if (ok) logProvisioning(slug, 'resume');
  return ok;
}

/** Mark purged and delete the tenant's DB file(s) + upload folder. Irreversible. */
export function purgeTenant(slug: string): boolean {
  if (slug === retiredDefaultTenant()) throw httpError(409, 'Change DEFAULT_TENANT_REDIRECT before purging the migrated company.');
  if (!getTenant(slug)) return false;
  setTenantStatus(slug, 'purged');
  for (const suffix of ['', '-wal', '-shm']) {
    const f = path.join(DATA_DIR, `${slug}.db${suffix}`);
    try { if (fs.existsSync(f)) fs.rmSync(f); } catch { /* best effort */ }
  }
  try {
    const up = path.join(UPLOAD_DIR, slug);
    if (fs.existsSync(up)) fs.rmSync(up, { recursive: true, force: true });
  } catch { /* best effort */ }
  logProvisioning(slug, 'purge');
  return true;
}
