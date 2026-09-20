/**
 * Tenant provisioning / de-provisioning. Runs with catalog-write privileges — kept out
 * of tenant-facing request code (only the `/api/signup` route and the CLI call it).
 * See docs/SAAS-READINESS.md §§7, 11.
 */
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { withTenant, run, DATA_DIR, UPLOAD_DIR } from '../shared/db';
import {
  createTenantRow, getTenant, isValidSlug, logProvisioning, setTenantStatus,
  type TenantStatus,
} from './platform';

export interface CreateTenantInput {
  slug: string;
  name: string;
  admin_username: string;
  admin_password: string;
  admin_email?: string;
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

  createTenantRow({ slug, name: input.name.trim() || slug, plan: input.plan, status: input.status });

  // withTenant opens + creates + migrates + seeds <DATA_DIR>/<slug>.db (seed() makes a
  // default 'admin' account); adopt the caller's chosen credentials onto it.
  withTenant(slug, () => {
    const hash = bcrypt.hashSync(input.admin_password, 10);
    run("UPDATE users SET username = ?, password_hash = ? WHERE username = 'admin'", username, hash);
  });

  logProvisioning(slug, 'create', JSON.stringify({ name: input.name, plan: input.plan ?? 'starter', admin: username }));
  return { slug };
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
