/** Field deliveries + proof of delivery. delivery.manage plans + sees all;
 *  delivery.run does its own assigned drops. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';
import { roleDefaults, ALL_PERMISSIONS } from '../src/permissions';

let ctx: TestContext;
let adminToken: string;
const A = () => ({ Authorization: `Bearer ${adminToken}` });
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  ctx = await setupApp();
  adminToken = await login(ctx.api);
});
afterAll(() => cleanup(ctx));

/** A driver — warehouse role has delivery.run but NOT delivery.manage. */
async function driver() {
  return createEmployee(ctx.api, adminToken, { role: 'warehouse' });
}

describe('delivery permissions', () => {
  it('run + manage are in the catalog; warehouse=run, releasing=run+manage', () => {
    expect(ALL_PERMISSIONS).toContain('delivery.run');
    expect(ALL_PERMISSIONS).toContain('delivery.manage');
    expect(roleDefaults('warehouse')).toContain('delivery.run');
    expect(roleDefaults('warehouse')).not.toContain('delivery.manage');
    expect(roleDefaults('releasing')).toEqual(expect.arrayContaining(['delivery.run', 'delivery.manage']));
    expect(roleDefaults('hr')).not.toContain('delivery.run');
  });
});

describe('deliveries', () => {
  it('manager creates + assigns; the driver sees only their own', async () => {
    const d1 = await driver();
    const d2 = await driver();
    const made = await ctx.api.post('/api/deliveries').set(A())
      .send({ customer_name: 'ACME Corp', address: '1 Market St', contact_phone: '0917', assigned_to: d1.id });
    expect(made.status).toBe(201);
    expect(made.body.number).toMatch(/^DEL-\d+$/);

    const mine = await ctx.api.get('/api/deliveries').set(bearer(d1.token));
    expect(mine.body.map((x: { id: number }) => x.id)).toContain(made.body.id);
    const others = await ctx.api.get('/api/deliveries').set(bearer(d2.token));
    expect(others.body.map((x: { id: number }) => x.id)).not.toContain(made.body.id);

    // a driver can't create/reassign
    expect((await ctx.api.post('/api/deliveries').set(bearer(d1.token))
      .send({ customer_name: 'x' })).status).toBe(403);
    // can't see someone else's detail
    expect((await ctx.api.get('/api/deliveries/' + made.body.id).set(bearer(d2.token))).status).toBe(403);
  });

  it('start → complete captures the POD', async () => {
    const d1 = await driver();
    const del = (await ctx.api.post('/api/deliveries').set(A())
      .send({ customer_name: 'Bravo Ltd', assigned_to: d1.id })).body.id;

    expect((await ctx.api.post(`/api/deliveries/${del}/status`).set(bearer(d1.token))
      .send({ status: 'out_for_delivery' })).status).toBe(200);

    const done = await ctx.api.post(`/api/deliveries/${del}/complete`).set(bearer(d1.token))
      .send({ outcome: 'delivered', recipient: 'J. Cruz', note: 'left at guardhouse', lat: 14.55, lng: 121.02 });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('delivered');

    const got = await ctx.api.get('/api/deliveries/' + del).set(bearer(d1.token));
    expect(got.body).toMatchObject({ status: 'delivered', pod_recipient: 'J. Cruz', pod_lat: 14.55 });
    expect(got.body.delivered_by_name).toBeTruthy();

    // already delivered → can't re-complete
    expect((await ctx.api.post(`/api/deliveries/${del}/complete`).set(bearer(d1.token))
      .send({ outcome: 'delivered' })).status).toBe(409);
  });

  it('a failed delivery needs a reason; only a manager cancels', async () => {
    const d1 = await driver();
    const del = (await ctx.api.post('/api/deliveries').set(A())
      .send({ customer_name: 'Charlie', assigned_to: d1.id })).body.id;
    await ctx.api.post(`/api/deliveries/${del}/status`).set(bearer(d1.token)).send({ status: 'out_for_delivery' });

    expect((await ctx.api.post(`/api/deliveries/${del}/complete`).set(bearer(d1.token))
      .send({ outcome: 'failed' })).status).toBe(400);
    expect((await ctx.api.post(`/api/deliveries/${del}/complete`).set(bearer(d1.token))
      .send({ outcome: 'failed', note: 'nobody home' })).status).toBe(200);

    const del2 = (await ctx.api.post('/api/deliveries').set(A()).send({ customer_name: 'D', assigned_to: d1.id })).body.id;
    expect((await ctx.api.post(`/api/deliveries/${del2}/status`).set(bearer(d1.token))
      .send({ status: 'cancelled' })).status).toBe(403);
    expect((await ctx.api.post(`/api/deliveries/${del2}/status`).set(A())
      .send({ status: 'cancelled' })).status).toBe(200);
  });

  it('copies the customer from a linked order; deletes only a pending one', async () => {
    const order = await ctx.api.post('/api/orders').set(A()).send({
      type: 'sale', customer_name: 'Order Customer',
      items: [{ name: 'widget', quantity: 2, unit_price: 50 }],
    });
    const del = await ctx.api.post('/api/deliveries').set(A()).send({ order_id: order.body.id });
    expect(del.status).toBe(201);
    const got = await ctx.api.get('/api/deliveries/' + del.body.id).set(A());
    expect(got.body.customer_name).toBe('Order Customer');
    expect(got.body.order_number).toBeTruthy();
    expect(got.body.items).toHaveLength(1);

    expect((await ctx.api.delete('/api/deliveries/' + del.body.id).set(A())).status).toBe(200);
  });
});
