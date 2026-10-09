/** Owner-managed monthly quotes. These settings do not charge a payment method. */
import { z } from 'zod';
import { getTenant, platformDb, type TenantRow } from './platform';
import { planModules } from './plans';
import { MODULES, withDeps } from '../shared/modules';

const price = z.number().finite().nonnegative().max(1_000_000_000)
  .refine(v => Math.abs(v * 100 - Math.round(v * 100)) < 0.00001, 'Use at most two decimal places.').nullable();
const schema = z.object({
  mode: z.enum(['bundle', 'per_module']),
  bundle: z.enum(['unlimited', 'trial', 'starter', 'operations', 'complete']),
  modules: z.array(z.enum(MODULES)),
  employee_limit: z.number().int().min(0).max(1_000_000).nullable(),
  bundle_price: price,
  module_prices: z.partialRecord(z.enum(MODULES), price),
  employee_price: price,
}).strict();

export type Subscription = z.infer<typeof schema>;
export function parseSubscription(value: unknown): Subscription {
  const s = schema.parse(value);
  s.modules = withDeps(s.modules);
  return s;
}
export function storedSubscription(t: TenantRow): Subscription | null {
  return t.subscription ? parseSubscription(JSON.parse(t.subscription)) : null;
}
export function subscriptionView(t: TenantRow) {
  const s = storedSubscription(t);
  if (!s) return null;
  const modules = s.mode === 'bundle' ? withDeps(planModules(s.bundle)) : s.modules;
  const moduleCents = s.mode === 'bundle'
    ? s.bundle_price === null ? null : Math.round(s.bundle_price * 100)
    : !modules.length || modules.some(m => s.module_prices[m] == null) ? null
      : modules.reduce((sum, m) => sum + Math.round(s.module_prices[m]! * 100), 0);
  const employeeCents = s.employee_limit === 0 ? 0
    : s.employee_limit === null || s.employee_price === null ? null
      : s.employee_limit * Math.round(s.employee_price * 100);
  return { ...s, effective_modules: modules, currency: 'PHP', interval: 'month',
    monthly_total: moduleCents === null || employeeCents === null ? null : (moduleCents + employeeCents) / 100 };
}

/** Validate first, then atomically update pricing and the matching entitlements. */
export function saveSubscription(slug: string, value: unknown): void {
  if (!getTenant(slug)) throw new Error('Unknown tenant.');
  const s = parseSubscription(value);
  platformDb().prepare('UPDATE tenants SET subscription = ?, plan = ?, modules = ? WHERE slug = ?')
    .run(JSON.stringify(s), s.mode === 'bundle' ? s.bundle : getTenant(slug)!.plan,
      s.mode === 'bundle' ? null : JSON.stringify(s.modules), slug);
}
