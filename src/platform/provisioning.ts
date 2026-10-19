/**
 * Tenant provisioning / de-provisioning. Runs with catalog-write privileges — kept out
 * of tenant-facing request code (only the `/api/signup` route and the CLI call it).
 * See docs/SAAS-READINESS.md §§7, 11.
 */
import fs from 'node:fs';
import { ControlPlaneError } from './request-errors';
import { PLANS } from './plans';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { hashPassword, hashPasswordForPublicRequest } from '../shared/password-hash';
import { withTenant, initializeFreshTenant, run, closeTenantConnection, DATA_DIR, UPLOAD_DIR } from '../shared/db';
import { securityLog } from '../shared/http-hardening';
import { passwordPolicyError } from '../shared/password-policy';
import { removeUploadFolder } from '../shared/file-store';
import {
  createTenantRow, getTenant, isValidSlug, logProvisioning, setTenantStatus,
  retiredDefaultTenant, platformDb,
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

function httpError(status: 400 | 409, message: string): ControlPlaneError {
  return new ControlPlaneError(status, message);
}

/** Exclusive ownership of a new database path; never adopt an unregistered existing DB. */
function reserveDatabase(slug: string) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, `${slug}.db`);
  if (['', '-wal', '-shm', '-journal'].some(suffix => {
    try { fs.lstatSync(file + suffix); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  })) {
    throw httpError(409, 'A database or recovery file already exists for this workspace. Review it before retrying.');
  }
  return reserveFile(file);
}
function reserveFile(file: string) {
  let descriptor: number;
  try { descriptor = fs.openSync(file, 'wx', 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw httpError(409, 'That workspace database is already reserved.'); throw error; }
  const identity = fs.fstatSync(descriptor, { bigint: true }); fs.closeSync(descriptor);
  return { file, identity };
}
function removeOwnedFile(owned: ReturnType<typeof reserveFile>) {
  const actual = fs.lstatSync(owned.file, { bigint: true });
  if (actual.isSymbolicLink() || actual.dev !== owned.identity.dev || actual.ino !== owned.identity.ino) throw new Error('Database ownership changed');
  for (const suffix of ['-wal', '-shm', '-journal', '']) fs.rmSync(owned.file + suffix, { force: true });
}
function discardOwnedDatabase(slug: string, owned: ReturnType<typeof reserveDatabase>) {
  try {
    if (getTenant(slug)) throw new Error('Catalog publication may have committed');
    closeTenantConnection(slug);
    removeOwnedFile(owned);
  } catch {
    // Keep uncertain artifacts blocked for review; never delete a replacement database.
    securityLog({ event: 'provisioning_cleanup_failed', tenant: slug });
  }
}
function publishTenant(input: Parameters<typeof createTenantRow>[0], action: string, detail: string, setup?: (slug: string) => undefined) {
  const database = platformDb();
  database.exec('SAVEPOINT publish_tenant');
  try {
    createTenantRow(input);
    setup?.(input.slug);
    logProvisioning(input.slug, action, detail);
    database.exec('RELEASE publish_tenant');
  } catch (error) {
    database.exec('ROLLBACK TO publish_tenant'); database.exec('RELEASE publish_tenant'); throw error;
  }
}

/** Create a tenant: catalog row + a fresh tenant DB seeded with the given admin login. */
/** setup is synchronous catalog-only work; never send mail or write tenant/files here. */
function validateCreation(input: CreateTenantInput) {
  if (input.plan !== undefined && !Object.hasOwn(PLANS, input.plan)) throw httpError(400, 'Unknown plan.');
  const slug = String(input.slug || '').toLowerCase().trim();
  if (!isValidSlug(slug)) {
    throw httpError(400, 'Workspace name must be 2–31 chars: a letter, then letters/numbers/hyphens (no reserved words).');
  }
  if (getTenant(slug)) throw httpError(409, 'That workspace name is already taken.');
  const username = String(input.admin_username || '').toLowerCase().trim();
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) throw httpError(400, 'Admin username must be 3–30 chars: letters, numbers, dot, underscore, hyphen.');
  const adminPassword = String(input.admin_password || '');
  const passwordError = passwordPolicyError(adminPassword, 'Admin password');
  if (passwordError) throw httpError(400, passwordError);

  return {slug, username, adminPassword};
}

export function createTenant(input: CreateTenantInput, setup?: (slug: string) => undefined): { slug: string } {
  const prepared=validateCreation(input);
  return createPreparedTenant(input,prepared,hashPassword(prepared.adminPassword),setup);
}

/** Public signup hashes through the shared bounded native-crypto budget, before any file or
 * publication transaction. Revalidate current catalog state after the await. No caller hash input. */
export async function createTenantForPublicSignup(input: CreateTenantInput, setup?: (slug: string) => undefined): Promise<{slug:string}> {
  const snapshot={...input};
  const prepared=validateCreation(snapshot), hash=await hashPasswordForPublicRequest(prepared.adminPassword);
  validateCreation(snapshot);
  return createPreparedTenant(snapshot,prepared,hash,setup);
}

function createPreparedTenant(input:CreateTenantInput, prepared:ReturnType<typeof validateCreation>, hash:string, setup?: (slug:string)=>undefined):{slug:string} {
  const {slug,username}=prepared;
  const owned = reserveDatabase(slug);
  try {
    // The catalog cannot route requests here until initialization and chosen credentials succeed.
    initializeFreshTenant(slug, hash, () => {
      const changed = run("UPDATE users SET username = ?, password_hash = ?, email = ?, password_change_required = 0 WHERE username = 'admin'", username, hash, input.is_sandbox ? null : (input.admin_email?.trim().toLowerCase() || null));
      if (changed.changes !== 1) throw new Error('Owner initialization failed');
    });
    publishTenant({ slug, name: input.name.trim() || slug, plan: input.plan, status: input.status, is_sandbox: input.is_sandbox },
      'create', JSON.stringify({ name: input.name, plan: input.plan ?? 'starter', admin: username }), setup);
  } catch (error) { discardOwnedDatabase(slug, owned); throw error; }
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
  if (input.plan !== undefined && !Object.hasOwn(PLANS, input.plan)) throw httpError(400, 'Unknown plan.');
  const slug = String(input.slug || '').toLowerCase().trim();
  if (!isValidSlug(slug)) {
    throw httpError(400, 'Workspace name must be 2–31 chars: a letter, then letters/numbers/hyphens (no reserved words).');
  }
  if (getTenant(slug)) throw httpError(409, 'That workspace name is already taken.');
  const head = Buffer.alloc(16);
  const fd = fs.openSync(input.sourceFile, 'r');
  try { fs.readSync(fd, head, 0, 16, 0); } finally { fs.closeSync(fd); }
  if (head.toString('latin1') !== 'SQLite format 3\0') throw httpError(400, 'That file is not a SQLite database.');

  // Validate on a private copy; only exclusively owned artifacts can be cleaned up.
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const staging = path.join(DATA_DIR, `.import-${slug}-${crypto.randomBytes(4).toString('hex')}.db`);
  let users = 0;
  let owned: ReturnType<typeof reserveDatabase> | undefined;
  let stageOwned: ReturnType<typeof reserveFile> | undefined;
  try {
    stageOwned = reserveFile(staging);
    fs.copyFileSync(input.sourceFile, staging);
    const conn = new DatabaseSync(staging);
    try {
      const ok = (conn.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
      if (ok !== 'ok') throw httpError(400, 'The database failed its integrity check.');
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
    owned = reserveDatabase(slug);
    fs.copyFileSync(staging, owned.file);
    withTenant(slug, () => {}); // Complete migration before the catalog can route requests.
    publishTenant({ slug, name: input.name.trim() || slug, plan: input.plan },
      'import', JSON.stringify({ name: input.name, plan: input.plan ?? 'starter', users }));
  } catch (error) {
    if (owned) discardOwnedDatabase(slug, owned);
    throw error;
  } finally {
    if (stageOwned) {
      try { removeOwnedFile(stageOwned); }
      catch { securityLog({ event: 'provisioning_staging_cleanup_failed', tenant: slug }); }
    }
  }

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
  void removeUploadFolder(path.join(UPLOAD_DIR, slug)); // and its copies in the file bucket
  logProvisioning(slug, 'purge');
  return true;
}
