import { beforeAll, afterAll, it, expect } from 'vitest';
import { setupApp, cleanup, login, createEmployee, addSerializedUnits, type TestContext } from './helpers';
let ctx: TestContext, token: string, manager: { token: string }, product: number, part: number, jo: number, units: number[], request: number;
const H = () => ({ Authorization: `Bearer ${token}` });
beforeAll(async () => {
  ctx = await setupApp(); token = await login(ctx.api);
  manager = await createEmployee(ctx.api, token, { role: 'production_manager' });
  expect((await ctx.api.post('/api/accounting/ledger/setup').set(H()).send({ fiscal_year_start: '2026-01-01' })).status).toBe(201);
  product = (await ctx.api.post('/api/inventory').set(H()).send({ name: 'Close preserved product', quantity: 0 })).body.id;
  part = (await ctx.api.post('/api/inventory').set(H()).send({ name: 'Close preserved part', quantity: 100, unit_cost: 10 })).body.id;
  await ctx.api.put(`/api/finished-products/${product}`).set(H()).send({ components: [{ component_item_id: part, quantity: 2 }] });
  jo = (await ctx.api.post('/api/job-orders').set(H()).send({ product_item_id: product, qty_ordered: 5, qc_stages: 2 })).body.id;
  await ctx.api.post(`/api/job-orders/${jo}/approve`).set(H());
  await ctx.api.post('/api/job-orders/warehouse-accept').set(H()).send({ job_order_ids: [jo] });
  await ctx.api.post('/api/job-orders/prepare').set(H()).send({ job_orders: [{ id: jo }] });
  await ctx.api.post(`/api/job-orders/${jo}/release`).set(H());
  await ctx.api.post(`/api/job-orders/${jo}/accept`).set(H());
  units = await addSerializedUnits(ctx.api, token, jo, 4, 'CLOSE-PRESERVE');
  const inspect = (u: number, body: any) => ctx.api.post(`/api/job-orders/${jo}/units/inspect`).set(H()).send({ unit_ids: [u], ...body });
  await inspect(units[1]!, { result: 'fail', disposition: 'repair', remarks: 'Replace defective component' });
  request = (await ctx.api.post(`/api/production/units/${units[1]}/repairs`).set(H()).send({ kind: 'add', component_item_id: part, quantity: 1 })).body.id;
  await inspect(units[2]!, { result: 'pass' });
  await inspect(units[2]!, { result: 'fail', disposition: 'hold', remarks: 'Awaiting final review' });
  await inspect(units[3]!, { result: 'pass' });
  await inspect(units[3]!, { result: 'pass' });
});
afterAll(() => cleanup(ctx));
it('closes only new production, returns unused parts once, and keeps pending/rework/hold/passed output and requests', async () => {
  const r = await ctx.api.post(`/api/job-orders/${jo}/close`).set({ Authorization: `Bearer ${manager.token}` })
    .set('Idempotency-Key', 'preserve-close-original').send({ reason: 'Customer reduced remaining demand' });
  expect(r.status).toBe(200); expect(r.body.job_order.status).toBe('completed');
  expect(r.body.job_order.qty_ordered).toBe(5); expect(r.body.job_order.qty_scrapped).toBe(0);
  const after = (await ctx.api.get(`/api/job-orders/${jo}/units`).set(H())).body;
  expect(after.map((u: any) => u.status)).toEqual(['pending', 'rework', 'hold', 'passed']);
  expect((await ctx.api.get(`/api/production/repairs/${request}/context`).set(H())).body.request.status).toBe('requested');
  expect((await ctx.api.get(`/api/inventory/${part}`).set(H())).body.quantity).toBe(92);
  const repeat = await ctx.api.post(`/api/job-orders/${jo}/close`).set({ Authorization: `Bearer ${manager.token}` })
    .set('Idempotency-Key', 'preserve-close-original').send({ reason: 'Customer reduced remaining demand' });
  expect(repeat.status).toBe(200);
  expect((await ctx.api.get(`/api/inventory/${part}`).set(H())).body.quantity).toBe(92);
  expect((await ctx.api.post(`/api/job-orders/${jo}/units`).set(H()).field('identifier', 'not-built').attach('image', Buffer.from('x'), 'unit.png')).status).toBe(409);
  expect((await ctx.api.post(`/api/job-orders/${jo}/progress`).set(H()).send({ scrapped_delta: 1 })).status).toBe(409);
});
it('keeps WIP open until preserved units finish inspection and receiving', async () => {
  const db = await import('../src/shared/db');
  const { jobOrderWipBalance } = await import('../src/modules/accounting/accounting-autopost');
  expect(jobOrderWipBalance(jo)).toBe(100); // no premature settlement of pending built output
  await ctx.api.post(`/api/production/repairs/${request}/reject`).set(H()).send({ warehouse_remarks: 'Repair completed without an extra part' });
  const inspect = async (u: number) => {
    const result = await ctx.api.post(`/api/job-orders/${jo}/units/inspect`).set(H()).send({ unit_ids: [u], result: 'pass' });
    expect(result.status).toBe(200);
  };
  for (const u of [units[0]!, units[1]!]) { await inspect(u); await inspect(u); }
  expect((await ctx.api.post(`/api/job-orders/${jo}/units/${units[2]}/hold-decision`).set(H())
    .send({ outcome: 'pass', remarks: 'Final quality verified' })).status).toBe(200);
  const location = db.queryOne<{ id: number }>('SELECT id FROM locations WHERE is_default = 1')!.id;
  const receipt = await ctx.api.post(`/api/job-orders/${jo}/products-in`).set(H()).send({ unit_ids: units, location_id: location });
  expect(receipt.status).toBe(201);
  expect((await ctx.api.get(`/api/inventory/${product}`).set(H())).body.quantity).toBe(4);
  expect(jobOrderWipBalance(jo)).toBe(0);
  expect((await ctx.api.get(`/api/job-orders/${jo}/units`).set(H())).body.every((u: any) => u.status === 'in_stock')).toBe(true);
});
