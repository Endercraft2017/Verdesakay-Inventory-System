/**
 * Per-tenant plan-limit enforcement. Called at the "create one more of X" endpoints.
 * The `default` tenant (self-hosted / single-tenant) has no catalog row → `unlimited`,
 * and every check is a no-op. See src/plans.ts, docs/SAAS-READINESS.md §9.
 */
import fs from 'node:fs';
import path from 'node:path';
import { tenantStore, queryOne, getSetting, setSetting, uploadDir, getDb, DEFAULT_TENANT } from '../shared/db';
import { getTenant } from './platform';
import { storedSubscription } from './subscription';
import { bucketOnlyBytes, hasBucketCopy } from '../shared/file-store';
import { PLANS, planLimitsFor, type PlanLimits } from './plans';

export type QuotaKind = keyof PlanLimits | 'employees';

const LABEL: Record<QuotaKind, string> = {
  employees: 'employee record',
  users: 'user',
  inventory_items: 'inventory item',
  storage_mb: 'storage',
  ai_calls_month: 'monthly AI request',
};

export function currentSlug(): string {
  return tenantStore.getStore()?.slug ?? DEFAULT_TENANT;
}

export function planFor(slug = currentSlug()): { plan: string; limits: PlanLimits & { employees: number } } {
  if (slug === DEFAULT_TENANT) return { plan: 'unlimited', limits: { ...PLANS.unlimited, employees: Infinity } };
  const t = getTenant(slug);
  const base = planLimitsFor(t?.plan);
  const subscription = t ? storedSubscription(t) : null;
  return { plan: t?.plan ?? 'trial', limits: { ...base, users: subscription?.seat_limit ?? base.users, employees: Infinity } };
}

export function dirSizeBytes(dir: string): number {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) total += dirSizeBytes(file);
      else if (entry.isFile()) total += fs.statSync(file).size;
      // Do not follow links out of a tenant's upload directory.
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  return total;
}

/** Logical upload usage: count working files once, plus files held only in the file bucket or
 * the database (each counted once, wherever it is). A lost upload folder must not reset a
 * tenant's quota. */
function storageUsageBytes(slug: string): number {
  const root = uploadDir(slug);
  let bytes = dirSizeBytes(root) + bucketOnlyBytes(root);
  const elsewhere = (file: string) => !fs.existsSync(file) && !hasBucketCopy(file);
  const conn = getDb(slug);
  for (const row of conn.prepare('SELECT name, size_bytes FROM durable_uploads').all() as Array<{ name: string; size_bytes: number }>) {
    if (elsewhere(path.join(root, row.name))) bytes += row.size_bytes;
  }
  for (const row of conn.prepare('SELECT stored_name, size_bytes FROM message_attachments WHERE data IS NOT NULL').all() as Array<{ stored_name: string; size_bytes: number }>) {
    if (elsewhere(path.join(root, row.stored_name))) bytes += row.size_bytes;
  }
  return bytes;
}

const AI_KEY = () => `ai_calls_${new Date().toISOString().slice(0, 7)}`; // ai_calls_YYYY-MM

/** Record one AI Assistant chat call against this month's counter. */
export function recordAiCall(): void {
  if (currentSlug() === DEFAULT_TENANT) return;
  setSetting(AI_KEY(), (getSetting<number>(AI_KEY()) || 0) + 1);
}

export function tenantUsage(slug = currentSlug()): Record<QuotaKind, number> {
  return {
    employees: queryOne<{ c: number }>('SELECT COUNT(*) AS c FROM employees')?.c ?? 0,
    users: queryOne<{ c: number }>('SELECT COUNT(*) AS c FROM users WHERE active = 1')?.c ?? 0,
    inventory_items: queryOne<{ c: number }>(
      "SELECT COUNT(*) AS c FROM inventory_items WHERE IFNULL(category,'') <> 'Damage'"
    )?.c ?? 0,
    storage_mb: Math.round(storageUsageBytes(slug) / (1024 * 1024) * 10) / 10,
    ai_calls_month: getSetting<number>(AI_KEY()) || 0,
  };
}

/**
 * Throw a 402 if adding one more of `kind` would exceed the tenant's plan.
 * `addingBytes` is only used for `storage_mb`. Pass zero after multer has already
 * written a file into uploadDir(), since dirSizeBytes includes those bytes.
 */
export function enforceQuota(kind: QuotaKind, addingBytes = 0): void {
  const slug = currentSlug();
  if (slug === DEFAULT_TENANT) return;
  const { limits } = planFor(slug);
  const cap = limits[kind];
  if (!Number.isFinite(cap)) return;

  const used = kind === 'storage_mb' ? storageUsageBytes(slug) / (1024 * 1024) : tenantUsage(slug)[kind];
  const willBe = kind === 'storage_mb' ? used + addingBytes / (1024 * 1024) : used + 1;
  if (willBe > cap) {
    throw Object.assign(
      new Error(`Your plan's ${LABEL[kind]} limit (${cap}${kind === 'storage_mb' ? ' MB' : ''}) has been reached. Upgrade the plan to add more.`),
      { status: 402 }
    );
  }
}
