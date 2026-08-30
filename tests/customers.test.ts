/** Customers registry + the orders.customer_id link. */
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

describe('customers', () => {
  let id = 0;

  it('creates, lists, and reads a customer', async () => {
    const c = await ctx.api.post('/api/customers').set(hdr())
      .send({ name: 'Acme Corp', email: 'ap@acme.test', tin: '123-456-789-000', payment_terms_days: 30 });
    expect(c.status).toBe(201);
    id = c.body.id;

    const list = await ctx.api.get('/api/customers').set(hdr());
    expect(list.body.some((x: { id: number }) => x.id === id)).toBe(true);

    const one = await ctx.api.get(`/api/customers/${id}`).set(hdr());
    expect(one.body).toMatchObject({ name: 'Acme Corp', payment_terms_days: 30 });
    expect(Array.isArray(one.body.orders)).toBe(true);
  });

  it('a sale order links to the customer and pulls its name when none is typed', async () => {
    const so = await ctx.api.post('/api/orders').set(hdr()).send({
      type: 'sale', customer_id: id, order_date: '2026-04-01', status: 'open',
      items: [{ name: 'Thing', quantity: 1, unit_price: 500 }],
    });
    expect(so.status).toBe(201);
    const detail = await ctx.api.get(`/api/orders/${so.body.id}`).set(hdr());
    expect(detail.body.customer_id).toBe(id);
    expect(detail.body.customer_name).toBe('Acme Corp');

    const cust = await ctx.api.get(`/api/customers/${id}`).set(hdr());
    expect(cust.body.order_count).toBe(1);
  });

  it('archives without deleting; archived hidden by default', async () => {
    await ctx.api.put(`/api/customers/${id}`).set(hdr()).send({ archived: true });
    const def = await ctx.api.get('/api/customers').set(hdr());
    expect(def.body.some((x: { id: number }) => x.id === id)).toBe(false);
    const all = await ctx.api.get('/api/customers?archived=1').set(hdr());
    expect(all.body.some((x: { id: number }) => x.id === id)).toBe(true);
    await ctx.api.put(`/api/customers/${id}`).set(hdr()).send({ archived: false });
  });

  it('deleting a customer leaves its sale orders (customer_id -> NULL)', async () => {
    const c = await ctx.api.post('/api/customers').set(hdr()).send({ name: 'Temp Buyer' });
    const so = await ctx.api.post('/api/orders').set(hdr()).send({
      type: 'sale', customer_id: c.body.id, status: 'open',
      items: [{ name: 'X', quantity: 1, unit_price: 10 }],
    });
    expect((await ctx.api.delete(`/api/customers/${c.body.id}`).set(hdr())).status).toBe(200);
    const detail = await ctx.api.get(`/api/orders/${so.body.id}`).set(hdr());
    expect(detail.status).toBe(200);
    expect(detail.body.customer_id).toBeNull();
  });
});
