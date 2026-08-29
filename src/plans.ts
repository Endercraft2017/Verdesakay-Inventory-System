/**
 * SaaS plan definitions — per-tenant caps enforced at the create endpoints
 * (see src/quota.ts). `Infinity` = no limit. The `default` tenant (self-hosted /
 * single-tenant) is always `unlimited` and never checked.
 */
export interface PlanLimits {
  /** Active user accounts. */
  users: number;
  /** Inventory items (excluding damage twins). */
  inventory_items: number;
  /** Total size of uploaded files, MB. */
  storage_mb: number;
  /** AI Assistant chat calls per calendar month. */
  ai_calls_month: number;
}

export type PlanName = 'unlimited' | 'trial' | 'starter' | 'operations' | 'complete';

export const PLANS: Record<PlanName, PlanLimits> = {
  unlimited:  { users: Infinity, inventory_items: Infinity, storage_mb: Infinity, ai_calls_month: Infinity },
  trial:      { users: 5,        inventory_items: 200,      storage_mb: 200,      ai_calls_month: 300 },
  starter:    { users: 10,       inventory_items: 2_000,    storage_mb: 2_000,    ai_calls_month: 1_000 },
  operations: { users: 40,       inventory_items: 20_000,   storage_mb: 10_000,   ai_calls_month: 5_000 },
  complete:   { users: 150,      inventory_items: 100_000,  storage_mb: 50_000,   ai_calls_month: 20_000 },
};

export function planLimitsFor(plan: string | null | undefined): PlanLimits {
  return PLANS[(plan as PlanName)] ?? PLANS.trial;
}
