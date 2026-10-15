/** Shared doc context: base build, field aliases, constants, formula eval order. */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// doc-context requires doc-formula via require('./doc-formula.js'); run it from the
// public/js dir so that relative require resolves, using a real module + require.
function load() {
  const dir = path.join(import.meta.dirname, '../public/js');
  const src = fs.readFileSync(path.join(dir, 'doc-context.js'), 'utf8');
  const mod: { exports: Record<string, unknown> } = { exports: {} };
  const require2 = (p: string) => {
    // resolve sibling module (doc-formula.js) the same sandbox way
    const fsrc = fs.readFileSync(path.join(dir, p), 'utf8');
    const m: { exports: Record<string, unknown> } = { exports: {} };
    // eslint-disable-next-line no-new-func
    new Function('module', 'exports', fsrc)(m, m.exports);
    return m.exports;
  };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', src)(mod, mod.exports, require2);
  return mod.exports as {
    buildDocContext: (o: unknown) => Record<string, unknown>;
  };
}
const { buildDocContext } = load();

const order = {
  number: 'SO-00001', type: 'sale', order_date: '2026-06-27', status: 'open',
  customer_name: 'ACME', currency: 'PHP', subtotal: 1375, tax_percent: 12, tax_amount: 165, total: 1540,
  items: [
    { name: 'Paper', sku: 'PPR', quantity: 10, unit: 'reams', unit_price: 120, line_total: 1200 },
    { name: 'Marker', sku: 'MK', quantity: 5, unit: 'pcs', unit_price: 35, line_total: 175 },
  ],
};
const company = { name: 'Verdesakay', address: 'Cebu' };
const user = { full_name: 'Admin User' };

describe('buildDocContext', () => {
  it('prints the CKD and semi-built descriptors on commercial sale lines', () => {
    const ctx = buildDocContext({ order: { type: 'sale', items: [
      { name: 'Bike', fulfillment_mode: 'semi_built', quantity: 1, unit_price: 1, line_total: 1 },
      { name: 'Bike', fulfillment_mode: 'ckd', quantity: 1, unit_price: 1, line_total: 1 },
    ] }, company, user, variables: [] }) as { items: Array<{ name: string; fulfillment_label: string }> };
    expect(ctx.items.map((item) => item.name)).toEqual(['Bike (Semi-built)', 'Bike (CKD)']);
    expect(ctx.items.map((item) => item.fulfillment_label)).toEqual(['Semi-built', 'CKD']);
  });

  it('builds base context with formatted money + items', () => {
    const ctx = buildDocContext({ order, company, user, variables: [] }) as never;
    expect((ctx as never as { order: { no: string; total: string } }).order.no).toBe('SO-00001');
    expect((ctx as never as { order: { total: string } }).order.total).toBe('1,540.00');
    expect((ctx as never as { items: unknown[] }).items).toHaveLength(2);
    expect((ctx as never as { user: { name: string } }).user.name).toBe('Admin User');
  });

  it('aliases a catalog field to a friendly key', () => {
    const ctx = buildDocContext({
      order, company, user,
      variables: [{ scope: 'global', key: 'client', source_type: 'field', field_path: 'order.customer_name', data_type: 'text' }],
    }) as Record<string, unknown>;
    expect(ctx.client).toBe('ACME');
  });

  it('merges typed constants', () => {
    const ctx = buildDocContext({
      order, company, user,
      variables: [
        { scope: 'global', key: 'vat', source_type: 'constant', value: '12', data_type: 'number' },
        { scope: 'global', key: 'terms', source_type: 'constant', value: 'Net 30', data_type: 'text' },
      ],
    }) as Record<string, unknown>;
    expect(ctx.vat).toBe(12);
    expect(ctx.terms).toBe('Net 30');
  });

  it('evaluates formulas, resolving dependencies across passes', () => {
    const ctx = buildDocContext({
      order, company, user,
      variables: [
        // grand depends on net which depends on goods (declared out of order on purpose)
        { scope: 'template', key: 'grand', source_type: 'formula', formula: 'net + net * 0.12', data_type: 'currency' },
        { scope: 'template', key: 'net', source_type: 'formula', formula: 'goods', data_type: 'currency' },
        { scope: 'template', key: 'goods', source_type: 'formula', formula: 'sum(items.line_total)', data_type: 'currency' },
      ],
    }) as Record<string, unknown>;
    expect(ctx.goods).toBe('1,375.00');
    expect(ctx.net).toBe('1,375.00');
    expect(ctx.grand).toBe('1,540.00');
  });

  it('does not throw on a bad formula (leaves it unset/empty)', () => {
    const ctx = buildDocContext({
      order, company, user,
      variables: [{ scope: 'template', key: 'bad', source_type: 'formula', formula: '1 + ', data_type: 'number' }],
    }) as Record<string, unknown>;
    expect(ctx.bad === undefined || ctx.bad === '').toBe(true);
  });
});
