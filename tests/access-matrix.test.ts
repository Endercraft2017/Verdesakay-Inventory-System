/** Who can read what (shared/desk-access.ts; user decision 2026-10-06: a floor role sees only its own
 *  desk). Each shop-floor desk gets a role holding nothing but that desk's permission (plus the phone
 *  and messages baseline), and is checked against every area's read: allowed reads are exactly the
 *  ones its task makes. A role with no work permission reads none of them. Picker reads give a desk
 *  only what a picker shows; an assistant report is its owner's alone. */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';

let ctx: TestContext;
let token: string;
let item: number;
let jo: number;
const H = () => ({ Authorization: `Bearer ${token}` });
const BASE = ['mobile.access', 'messages.view', 'messages.send'];

/** Area → the read it makes. "Allowed" = anything but 401 / 403 (a 404 for a made-up id still means the gate let you in). */
const AREAS: Record<string, () => string> = {
  'item picker': () => '/api/inventory?q=Seat',
  'item detail': () => `/api/inventory/${item}`,
  'stock stats': () => '/api/inventory/stats',
  'item categories': () => '/api/inventory/categories',
  'scan lookup': () => '/api/inventory/lookup?code=NOPE-404',
  locations: () => '/api/locations',
  suppliers: () => '/api/suppliers',
  customers: () => '/api/customers',
  'products / BOM': () => '/api/finished-products',
  'sale orders': () => '/api/orders?type=sale',
  'purchase orders': () => '/api/orders?type=purchase',
  'release queue': () => '/api/release-slips/queue',
  'job-order list': () => '/api/job-orders',
  'job-order detail': () => `/api/job-orders/${jo}`,
  'job-order history': () => `/api/job-orders/${jo}/events`,
  'QC queue': () => '/api/qc/queue',
  checklists: () => '/api/qc/checklists',
  'QC records': () => '/api/qc/records',
  repairs: () => '/api/production/repairs',
  'unit record': () => '/api/production/record?unit=999999',
  batches: () => '/api/production/batches',
  'label templates': () => '/api/production/label-templates',
  'production issues': () => '/api/production-issues',
  'RTS queue': () => '/api/rts/queue',
  'receipt history': () => '/api/job-orders/production-receipts',
  'receipt detail': () => '/api/job-orders/production-receipts/999999',
  templates: () => '/api/templates',
  employees: () => '/api/hr/employees',
  'payroll tables': () => '/api/hr/payroll-tables',
  'cash book': () => '/api/accounting/cash-book',
  roles: () => '/api/roles',
};

/** Each desk's own reads — nothing else may open. */
const DESKS: Record<string, { permissions: string[]; reads: string[] }> = {
  'no work permission': { permissions: [], reads: [] },
  'QC inspector': { permissions: ['production.inspect_qc'],
    reads: ['item picker', 'scan lookup', 'job-order detail', 'QC queue', 'checklists', 'repairs', 'unit record'] },
  'QA inspector': { permissions: ['production.inspect_qa'],
    reads: ['item picker', 'scan lookup', 'job-order detail', 'QC queue', 'checklists', 'repairs', 'unit record'] },
  'parts clerk': { permissions: ['production.repairs'],
    reads: ['item picker', 'scan lookup', 'job-order detail', 'repairs', 'unit record'] },
  'production lead': { permissions: ['production.record'],
    reads: ['scan lookup', 'job-order list', 'job-order detail', 'job-order history', 'repairs', 'unit record', 'batches', 'label templates'] },
  'RTS clerk': { permissions: ['production.receive'],
    reads: ['scan lookup', 'locations', 'job-order detail', 'unit record', 'label templates', 'RTS queue', 'receipt history', 'receipt detail'] },
  'releasing clerk': { permissions: ['orders.release'],
    reads: ['scan lookup', 'release queue', 'unit record'] },
};

const accounts: Record<string, { id: number; token: string }> = {};

beforeAll(async () => {
  ctx = await setupApp();
  token = await login(ctx.api);
  item = (await ctx.api.post('/api/inventory').set(H()).send({ name: 'Seat AM', sku: 'SEAT-AM', quantity: 4, unit_cost: 120, notes: 'Supplier price list Q3' })).body.id;
  const product = (await ctx.api.post('/api/inventory').set(H()).send({ name: 'Bike AM', quantity: 0 })).body.id;
  await ctx.api.put(`/api/finished-products/${product}`).set(H()).send({ components: [{ component_item_id: item, quantity: 1 }] });
  jo = (await ctx.api.post('/api/job-orders').set(H()).send({ product_item_id: product, qty_ordered: 1, qc_stages: 1 })).body.id;
  let n = 0;
  for (const [desk, d] of Object.entries(DESKS)) {
    const key = 'desk_' + (++n);
    const r = await ctx.api.post('/api/roles').set(H()).send({ label: 'Desk ' + desk, key, permissions: [...BASE, ...d.permissions] });
    expect(r.status, desk).toBe(201);
    accounts[desk] = await createEmployee(ctx.api, token, { role: key });
    if (desk === 'production lead') expect((await ctx.api.put(`/api/job-orders/${jo}/assignees`).set(H()).send({user_ids:[accounts[desk]!.id]})).status).toBe(200);
  }
});
afterAll(() => cleanup(ctx));

describe('each floor desk reads only its own desk', () => {
  for (const [desk, d] of Object.entries(DESKS)) {
    it(desk, async () => {
      const allowed: string[] = [];
      for (const [area, path] of Object.entries(AREAS)) {
        const res = await ctx.api.get(path()).set({ Authorization: `Bearer ${accounts[desk]!.token}` });
        if (res.status !== 401 && res.status !== 403) allowed.push(area);
      }
      expect(allowed.sort()).toEqual([...d.reads].sort());
    });
  }
});

describe('what a desk gets from a shared read', () => {
  it('the item picker gives a desk the name, code and stock — not costs or notes', async () => {
    const rows = (await ctx.api.get('/api/inventory?q=Seat').set({ Authorization: `Bearer ${accounts['QC inspector']!.token}` })).body;
    expect(rows[0]).toEqual({ id: item, name: 'Seat AM', sku: 'SEAT-AM', unit: expect.anything(), quantity: 4 });
    const full = (await ctx.api.get('/api/inventory?q=Seat').set(H())).body;
    expect(full[0]).toMatchObject({ unit_cost: 120, notes: 'Supplier price list Q3' });
  });

  it("an assistant report downloads only for whoever generated it", async () => {
    const { uploadDir } = await import('../src/shared/db');
    const admin = (await ctx.api.get('/api/auth/me').set(H())).body;
    const adminId = (admin.user ?? admin).id as number;
    const name = `ai-report-u${adminId}-payroll-summary-1700000000000-abcdef.html`;
    fs.writeFileSync(path.join(uploadDir(), name), '<p>Pay</p>');
    expect((await ctx.api.get(`/api/ai/reports/${name}`).set({ Authorization: `Bearer ${accounts['QC inspector']!.token}` })).status).toBe(404);
    expect((await ctx.api.get(`/api/ai/reports/${name}`).set(H())).status).toBe(200);
  });
});
