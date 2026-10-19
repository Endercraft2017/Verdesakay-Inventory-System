/** Owner-managed monthly quotes. These settings do not charge a payment method. */
import { z } from 'zod';
import { parseBody } from '../shared/validation';
import { getTenant, platformDb, type TenantRow } from './platform';
import { planModules } from './plans';
import { MODULES, withDeps } from '../shared/modules';

const price = z.number().finite().nonnegative().max(1_000_000_000)
  .refine(v => Math.abs(v * 100 - Math.round(v * 100)) < 0.00001, 'Use at most two decimal places.').nullable();
const schema = z.object({
  mode: z.enum(['bundle', 'per_module']),
  bundle: z.enum(['unlimited', 'trial', 'starter', 'operations', 'complete']),
  modules: z.array(z.enum(MODULES)),
  seat_limit: z.number().int().min(1).max(1_000_000).nullable(),
  bundle_price: price,
  module_prices: z.partialRecord(z.enum(MODULES), price),
  seat_price: price,
}).strict();

export type Subscription = z.infer<typeof schema>;
export function parseSubscription(value: unknown): Subscription {
  const s = schema.parse(value);
  s.modules = withDeps(s.modules);
  return s;
}
export function storedSubscription(t: TenantRow): Subscription | null {
  if (!t.subscription) return null;
  const value = JSON.parse(t.subscription);
  // Older quotes priced employee records. Keep their modules, but do not silently
  // convert the old employee rate/allowance into a login-seat charge.
  if ('employee_limit' in value || 'employee_price' in value) {
    delete value.employee_limit; delete value.employee_price;
    value.seat_limit = null; value.seat_price = null;
  }
  return parseSubscription(value);
}
export function subscriptionView(t: TenantRow) {
  const s = storedSubscription(t);
  if (!s) return null;
  const modules = s.mode === 'bundle' ? withDeps(planModules(s.bundle)) : s.modules;
  const moduleCents = s.mode === 'bundle'
    ? s.bundle_price === null ? null : Math.round(s.bundle_price * 100)
    : !modules.length || modules.some(m => s.module_prices[m] == null) ? null
      : modules.reduce((sum, m) => sum + Math.round(s.module_prices[m]! * 100), 0);
  const seatCents = s.seat_limit === null || s.seat_price === null ? null
      : s.seat_limit * Math.round(s.seat_price * 100);
  return { ...s, effective_modules: modules, currency: 'PHP', interval: 'month',
    monthly_total: moduleCents === null || seatCents === null ? null : (moduleCents + seatCents) / 100 };
}

/** Validate first, then atomically update pricing and the matching entitlements. */
export function saveSubscription(slug: string, value: unknown): void {
  if (!getTenant(slug)) throw new Error('Unknown tenant.');
  const s = parseBody(schema, value);
  s.modules = withDeps(s.modules);
  platformDb().prepare('UPDATE tenants SET subscription = ?, plan = ?, modules = ? WHERE slug = ?')
    .run(JSON.stringify(s), s.mode === 'bundle' ? s.bundle : getTenant(slug)!.plan,
      s.mode === 'bundle' ? null : JSON.stringify(s.modules), slug);
}
