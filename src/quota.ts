/**
 * Per-tenant plan-limit enforcement. Called at the "create one more of X" endpoints.
 * The `default` tenant (self-hosted / single-tenant) has no catalog row → `unlimited`,
 * and every check is a no-op. See src/plans.ts, docs/SAAS-READINESS.md §9.
 */
import fs from 'node:fs';
import path from 'node:path';
import { tenantStore, queryOne, getSetting, setSetting, uploadDir, DEFAULT_TENANT } from './db';
import { getTenant } from './platform';
import { PLANS, planLimitsFor, type PlanLimits } from './plans';

export type QuotaKind = keyof PlanLimits;

const LABEL: Record<QuotaKind, string> = {
  users: 'user',
  inventory_items: 'inventory item',
  storage_mb: 'storage',
  ai_calls_month: 'monthly AI request',
};

export function currentSlug(): string {
  return tenantStore.getStore()?.slug ?? DEFAULT_TENANT;
}

export function planFor(slug = currentSlug()): { plan: string; limits: PlanLimits } {
  if (slug === DEFAULT_TENANT) return { plan: 'unlimited', limits: PLANS.unlimited };
  const t = getTenant(slug);
  return { plan: t?.plan ?? 'trial', limits: planLimitsFor(t?.plan) };
}

function dirSizeBytes(dir: string): number {
  let total = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      const st = fs.statSync(path.join(dir, name));
      total += st.isDirectory() ? 0 : st.size; // per-tenant folders are flat
    }
  } catch { /* missing dir → 0 */ }
  return total;
}

const AI_KEY = () => `ai_calls_${new Date().toISOString().slice(0, 7)}`; // ai_calls_YYYY-MM

/** Record one AI Assistant chat call against this month's counter. */
export function recordAiCall(): void {
  if (currentSlug() === DEFAULT_TENANT) return;
  setSetting(AI_KEY(), (getSetting<number>(AI_KEY()) || 0) + 1);
}

export function tenantUsage(slug = currentSlug()): Record<QuotaKind, number> {
  return {
    users: queryOne<{ c: number }>('SELECT COUNT(*) AS c FROM users WHERE active = 1')?.c ?? 0,
    inventory_items: queryOne<{ c: number }>(
      "SELECT COUNT(*) AS c FROM inventory_items WHERE IFNULL(category,'') <> 'Damage'"
    )?.c ?? 0,
    storage_mb: Math.round(dirSizeBytes(uploadDir(slug)) / (1024 * 1024) * 10) / 10,
    ai_calls_month: getSetting<number>(AI_KEY()) || 0,
  };
}

/**
 * Throw a 402 if adding one more of `kind` would exceed the tenant's plan.
 * `addingBytes` is only used for `storage_mb`.
 */
export function enforceQuota(kind: QuotaKind, addingBytes = 0): void {
  const slug = currentSlug();
  if (slug === DEFAULT_TENANT) return;
  const { limits } = planFor(slug);
  const cap = limits[kind];
  if (!Number.isFinite(cap)) return;

  const used = tenantUsage(slug)[kind];
  const willBe = kind === 'storage_mb' ? used + addingBytes / (1024 * 1024) : used + 1;
  if (willBe > cap) {
    throw Object.assign(
      new Error(`Your plan's ${LABEL[kind]} limit (${cap}${kind === 'storage_mb' ? ' MB' : ''}) has been reached. Upgrade the plan to add more.`),
      { status: 402 }
    );
  }
}
