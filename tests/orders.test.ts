/** Orders: create with auto number + server-computed totals, list by type, update
    (replace items + recompute), delete (cascades items), validation, auth. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, type TestContext } from './helpers';

let ctx: TestContext;
let token: string;
const hdr = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  ctx = await setupApp();
  token = await login(ctx.api);
});
afterAll(() => cleanup(ctx));

const sampleItems = [
  { name: 'Bond Paper', sku: 'PPR', quantity: 10, unit: 'reams', unit_price: 120 },
  { name: 'Marker', quantity: 5, unit: 'pcs', unit_price: 35 },
];

describe('orders', () => {
  it('requires authentication', async () => {
    expect((await ctx.api.get('/api/orders')).status).toBe(401);
  });

  it('creates a sale order with an auto number and server-computed totals', async () => {
    const res = await ctx.api.post('/api/orders').set(hdr())
      .send({ type: 'sale', customer_name: 'ACME', tax_percent: 12, items: sampleItems });
    expect(res.status).toBe(201);
    expect(res.body.number).toMatch(/^SO-\d{5}$/);

    const detail = await ctx.api.get('/api/orders/' + res.body.id).set(hdr());
    // 10*120 + 5*35 = 1375 subtotal; 12% tax = 165; total = 1540
    expect(detail.body.subtotal).toBe(1375);
    expect(detail.body.tax_amount).toBe(165);
    expect(detail.body.total).toBe(1540);
    expect(detail.body.items).toHaveLength(2);
    expect(detail.body.items[0].line_total).toBe(1200);
  });

  it('ignores client-sent totals (recomputes from line items)', async () => {
    const res = await ctx.api.post('/api/orders').set(hdr())
      .send({ type: 'sale', total: 999999, subtotal: 999999, items: [{ name: 'X', quantity: 2, unit_price: 50 }] });
    const detail = await ctx.api.get('/api/orders/' + res.body.id).set(hdr());
    expect(detail.body.total).toBe(100); // 2*50, not the bogus 999999
  });

  it('numbers job orders with the JO- prefix and a separate sequence', async () => {
    const res = await ctx.api.post('/api/orders').set(hdr())
      .send({ type: 'job', items: [{ name: 'Repair', quantity: 1, unit_price: 500 }] });
    expect(res.body.number).toMatch(/^JO-\d{5}$/);
  });

  it('creates a purchase request with the PR- prefix', async () => {
    const res = await ctx.api.post('/api/orders').set(hdr())
      .send({ type: 'purchase', items: [{ name: 'Bond Paper', quantity: 5, unit_price: 120 }] });
    expect(res.status).toBe(201);
    expect(res.body.number).toMatch(/^PR-\d{5}$/);
    const detail = await ctx.api.get('/api/orders/' + res.body.id).set(hdr());
    expect(detail.body.type).toBe('purchase');
    expect(detail.body.total).toBe(600);
  });

  it('lists by type', async () => {
    const sales = await ctx.api.get('/api/orders?type=sale').set(hdr());
    expect(sales.body.every((o: { type: string }) => o.type === 'sale')).toBe(true);
    const jobs = await ctx.api.get('/api/orders?type=job').set(hdr());
    expect(jobs.body.every((o: { type: string }) => o.type === 'job')).toBe(true);
  });

  it('updates an order, replacing items and recomputing totals', async () => {
    const created = await ctx.api.post('/api/orders').set(hdr())
      .send({ type: 'sale', items: [{ name: 'Old', quantity: 1, unit_price: 10 }] });
    const upd = await ctx.api.put('/api/orders/' + created.body.id).set(hdr())
      .send({ tax_percent: 0, items: [{ name: 'New', quantity: 3, unit_price: 100 }] });
    expect(upd.status).toBe(200);
    const detail = await ctx.api.get('/api/orders/' + created.body.id).set(hdr());
    expect(detail.body.items).toHaveLength(1);
    expect(detail.body.items[0].name).toBe('New');
    expect(detail.body.total).toBe(300);
  });

  it('rejects an order with no line items', async () => {
    const res = await ctx.api.post('/api/orders').set(hdr()).send({ type: 'sale', items: [] });
    expect(res.status).toBe(400);
  });

  it('deletes an order (and its items cascade)', async () => {
    const created = await ctx.api.post('/api/orders').set(hdr())
      .send({ type: 'sale', items: [{ name: 'Z', quantity: 1, unit_price: 1 }] });
    expect((await ctx.api.delete('/api/orders/' + created.body.id).set(hdr())).status).toBe(200);
    expect((await ctx.api.get('/api/orders/' + created.body.id).set(hdr())).status).toBe(404);
  });
});
