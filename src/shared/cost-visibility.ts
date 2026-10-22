import type { AuthUser } from './types';

const COST_KEYS = new Set([
  'unit_cost', 'std_labor_cost', 'std_overhead_cost', 'source_cost', 'finishing_cost',
  'standard_cost', 'purchase_price', 'cost', 'cost_basis', 'cost_total', 'material_cost',
  'total_cost', 'selling_markup_percent', 'markup_percent', 'stock_value', 'dead_stock_value', 'value_by_location', 'top_value_items',
]);
const PURCHASE_VALUES = new Set([
  'unit_price', 'price', 'line_total', 'po_price', 'std', 'subtotal', 'total', 'tax', 'tax_amount', 'discount', 'discount_amount',
  'amount', 'amount_paid', 'balance', 'freight', 'freight_amount', 'landed_cost',
]);

/** Receiving staff can identify supplier goods without seeing their acquisition prices. */
export function redactInventoryCosts<T>(value: T, user: Pick<AuthUser, 'permissions'> | undefined, path = ''): T {
  if (!user || user.permissions.includes('inventory.costs')) return value;
  const supplierDocument = /\/purchasing\/(?:orders|bills|receipts|tolerance)(?:\/|$|\?)/.test(path);
  const strip = (v: unknown, purchase: boolean): unknown => {
    if (Array.isArray(v)) return v.map(row => strip(row, purchase));
    if (!v || typeof v !== 'object') return v;
    const entries = Object.entries(v);
    const isPurchase = purchase || (v as Record<string, unknown>).type === 'purchase';
    return Object.fromEntries(entries
      .filter(([key]) => !COST_KEYS.has(key) && !/(?:^|_)cost(?:_|$)/i.test(key) && !(isPurchase && (key === 'match' || key === 'match_json' || PURCHASE_VALUES.has(key) || /(?:^|_)(?:price|cost|amount|value)(?:_|$)/i.test(key))))
      .map(([key, val]) => {
        if (key === 'attributes' && typeof val === 'string') {
          try { return [key, JSON.stringify(strip(JSON.parse(val), isPurchase))]; } catch { /* preserve other metadata */ }
        }
        return [key, strip(val, isPurchase)];
      }));
  };
  return strip(value, supplierDocument) as T;
}

/** Operational order visibility does not confer commercial pricing authority. Applied
 * to every JSON response on the document family, including nested context/replay data. */
export function redactSaleCommercial<T>(value: T, user: Pick<AuthUser, 'permissions'> | undefined, path = ''): T {
  if (/\/purchasing(?:\/|$)/.test(path)) return value;
  if (!user || !/\/(?:orders|release-slips|customers)(?:\/|$|\?)/.test(path)) return value;
  if (['orders.create', 'orders.edit', 'orders.approve', 'orders.authorize', 'accounting.view'].some(p => user.permissions.includes(p as AuthUser['permissions'][number]))) return value;
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (!v || typeof v !== 'object') return v;
    // Supplier-order costing uses its own independent inventory.costs policy.
    if ((v as Record<string, unknown>).type === 'purchase') return v;
    return Object.fromEntries(Object.entries(v).filter(([key]) =>
      !PURCHASE_VALUES.has(key) && !COST_KEYS.has(key) &&
      !/(?:^|_)(?:price|cost|amount|value|margin|markup|tax|discount)(?:_|$)/i.test(key)
    ).map(([key, val]) => [key, strip(val)]));
  };
  return strip(value) as T;
}
