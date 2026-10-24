/** Sales entry needs catalog identity, without widening Inventory or Production access. */
import { beforeAll, afterAll, it, expect } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';
let ctx: TestContext, admin: string, item: number;
const staff: Record<string, string> = {};
beforeAll(async () => {
  ctx = await setupApp(); admin = await login(ctx.api);
  item = (await ctx.api.post('/api/inventory').auth(admin, { type: 'bearer' }).send({
    name: 'Sales catalog product', sku: 'SALES-CATALOG', quantity: 3, unit_cost: 70,
    notes: 'Private supplier pricing', attributes: { supplier_terms: 'Private' },
  })).body.id;
  await ctx.api.put('/api/finished-products/' + item).auth(admin, { type: 'bearer' }).send({ components: [] });
  for (const permission of ['orders.create', 'orders.edit', 'orders.approve']) {
    const key = permission.replace('.', '_');
    await ctx.api.post('/api/roles').auth(admin, { type: 'bearer' }).send({ key, label: key,
      permissions: ['mobile.access', 'orders.view', permission] });
    staff[permission] = (await createEmployee(ctx.api, admin, { role: key })).token;
  }
});
afterAll(() => cleanup(ctx));
for (const permission of ['orders.create', 'orders.edit']) {
  it(`${permission} can find and scan catalog products but cannot read production records or change stock`, async () => {
    const token = staff[permission]!;
    const rows = await ctx.api.get('/api/inventory?q=Sales%20catalog').auth(token, { type: 'bearer' });
    expect(rows.status).toBe(200);
    expect(rows.body).toEqual([{ id: item, name: 'Sales catalog product', sku: 'SALES-CATALOG',
      unit: expect.any(String), quantity: 3, is_finished_product: 1 }]);
    const scan = await ctx.api.get('/api/inventory/lookup?code=SALES-CATALOG').auth(token, { type: 'bearer' });
    expect(scan.status).toBe(200); expect(scan.body).toEqual(rows.body[0]);
    for (const path of [`/inventory/${item}`, '/inventory/stats', '/inventory/lookup?code=VDS:UNIT:9999',
      '/inventory/lookup?code=VDS:BATCH:9999', '/job-orders', '/production/batches']) {
      expect((await ctx.api.get('/api' + path).auth(token, { type: 'bearer' })).status, path).toBe(403);
    }
    expect((await ctx.api.post(`/api/inventory/${item}/adjust`).auth(token, { type: 'bearer' }).send({ change: 1 })).status).toBe(403);
    expect((await ctx.api.get(`/api/inventory/${item}`).auth(admin, { type: 'bearer' })).body.quantity).toBe(3);
  });
}
it('approval alone does not grant catalog browsing or scanning', async () => {
  for (const path of ['/inventory?q=Sales', '/inventory/lookup?code=SALES-CATALOG']) {
    expect((await ctx.api.get('/api' + path).auth(staff['orders.approve']!, { type: 'bearer' })).status).toBe(403);
  }
});
