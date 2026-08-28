/** GET /api/inventory/lookup?code= — resolve a scanned/typed code to one item. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';

let ctx: TestContext;
let token: string;
const hdr = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  ctx = await setupApp();
  token = await login(ctx.api);
});
afterAll(() => cleanup(ctx));

describe('inventory: code lookup', () => {
  it('resolves by SKU', async () => {
    const { body } = await ctx.api
      .post('/api/inventory')
      .set(hdr())
      .send({ name: 'Lookup By Sku', sku: 'LK-SKU-1', quantity: 3 });
    const res = await ctx.api.get('/api/inventory/lookup?code=LK-SKU-1').set(hdr());
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(body.id);
  });

  it('resolves by the barcode attribute', async () => {
    const { body } = await ctx.api
      .post('/api/inventory')
      .set(hdr())
      .send({ name: 'Lookup By Barcode', quantity: 1, attributes: { barcode: 'VDS-XYZ-9animal' } });
    const res = await ctx.api.get('/api/inventory/lookup?code=VDS-XYZ-9animal').set(hdr());
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(body.id);
    expect(res.body.attributes.barcode).toBe('VDS-XYZ-9animal');
  });

  it('404s an unknown code and 400s a blank one', async () => {
    expect((await ctx.api.get('/api/inventory/lookup?code=NOPE-NOPE').set(hdr())).status).toBe(404);
    expect((await ctx.api.get('/api/inventory/lookup?code=').set(hdr())).status).toBe(400);
  });

  it('needs inventory.view', async () => {
    const marketing = await createEmployee(ctx.api, token, { username: 'lk_mkt', role: 'marketing' });
    const res = await ctx.api
      .get('/api/inventory/lookup?code=whatever')
      .set({ Authorization: `Bearer ${marketing.token}` });
    expect(res.status).toBe(403);
  });
});
