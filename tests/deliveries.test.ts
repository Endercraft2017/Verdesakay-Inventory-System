/** Field deliveries + proof of delivery. delivery.manage plans + sees all;
 *  delivery.run does its own assigned drops. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';
import { roleDefaults, ALL_PERMISSIONS } from '../src/shared/permissions';

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
    const d2 = await driver();
    const del = (await ctx.api.post('/api/deliveries').set(A())
      .send({ customer_name: 'Bravo Ltd', assigned_to: d1.id })).body.id;

    const image = await ctx.api.post('/api/attachments').set(bearer(d1.token))
      .field('kind', 'delivery').field('ref_id', String(del))
      .attach('image', Buffer.from('proof-by-assigned-driver'), 'proof.png');
    expect(image.status).toBe(201);
    expect((await ctx.api.get(`/api/attachments?kind=delivery&ref_id=${del}`).set(bearer(d2.token))).status).toBe(403);
    expect((await ctx.api.get(`/api/attachments/${image.body.id}/image`).set(bearer(d2.token))).status).toBe(403);
    expect((await ctx.api.post('/api/attachments').set(bearer(d2.token))
      .field('kind', 'delivery').field('ref_id', String(del))
      .attach('image', Buffer.from('other-driver'), 'other.png')).status).toBe(403);

    expect((await ctx.api.post(`/api/deliveries/${del}/status`).set(bearer(d1.token))
      .send({ status: 'out_for_delivery' })).status).toBe(200);

    const done = await ctx.api.post(`/api/deliveries/${del}/complete`).set(bearer(d1.token))
      .send({ outcome: 'delivered', recipient: 'J. Cruz', note: 'left at guardhouse', lat: 14.55, lng: 121.02 });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('delivered');

    const got = await ctx.api.get('/api/deliveries/' + del).set(bearer(d1.token));
    expect(got.body).toMatchObject({ status: 'delivered', pod_recipient: 'J. Cruz', pod_lat: 14.55 });
    expect(got.body.delivered_by_name).toBeTruthy();
    expect((await ctx.api.delete(`/api/attachments/${image.body.id}`).set(bearer(d1.token))).status).toBe(409);
    expect((await ctx.api.post('/api/attachments').set(bearer(d1.token))
      .field('kind', 'signature').field('ref_id', String(del))
      .attach('image', Buffer.from('late-signature'), 'late.png')).status).toBe(409);

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

  it('completing a delivery for an unfulfilled sale order hands back an `order` hint', async () => {
    // `releasing` role has delivery.run AND orders.edit — the hint is gated on orders.edit.
    const rel = await createEmployee(ctx.api, adminToken, { role: 'releasing' });
    const order = await ctx.api.post('/api/orders').set(A()).send({
      type: 'sale', customer_name: 'Fulfil Me', status: 'approved',
      items: [{ name: 'loose widget', quantity: 1, unit_price: 10 }],
    });
    const del = (await ctx.api.post('/api/deliveries').set(A())
      .send({ order_id: order.body.id, assigned_to: rel.id })).body.id;
    await ctx.api.post(`/api/deliveries/${del}/status`).set(bearer(rel.token)).send({ status: 'out_for_delivery' });

    const done = await ctx.api.post(`/api/deliveries/${del}/complete`).set(bearer(rel.token))
      .send({ outcome: 'delivered', recipient: 'R' });
    expect(done.status).toBe(200);
    expect(done.body.order).toMatchObject({ id: order.body.id, status: 'approved' });
    expect(done.body.order.number).toMatch(/^SO-\d+$/);
  });

  it('no `order` hint for a driver without orders.edit, a failed drop, or a completed order', async () => {
    const wh = await driver(); // warehouse: delivery.run but NOT orders.edit
    const rel = await createEmployee(ctx.api, adminToken, { role: 'releasing' });

    const approved = (await ctx.api.post('/api/orders').set(A()).send({
      type: 'sale', customer_name: 'No Edit', status: 'approved',
      items: [{ name: 'w', quantity: 1, unit_price: 1 }],
    })).body.id;
    const dWh = (await ctx.api.post('/api/deliveries').set(A())
      .send({ order_id: approved, assigned_to: wh.id })).body.id;
    await ctx.api.post(`/api/deliveries/${dWh}/status`).set(bearer(wh.token)).send({ status: 'out_for_delivery' });
    const doneWh = await ctx.api.post(`/api/deliveries/${dWh}/complete`).set(bearer(wh.token))
      .send({ outcome: 'delivered', recipient: 'R' });
    expect(doneWh.body.order).toBeNull();

    const completed = (await ctx.api.post('/api/orders').set(A()).send({
      type: 'sale', customer_name: 'Done Already', status: 'completed',
      items: [{ name: 'w', quantity: 1, unit_price: 1 }],
    })).body.id;
    const dDone = (await ctx.api.post('/api/deliveries').set(A())
      .send({ order_id: completed, assigned_to: rel.id })).body.id;
    await ctx.api.post(`/api/deliveries/${dDone}/status`).set(bearer(rel.token)).send({ status: 'out_for_delivery' });
    const doneDone = await ctx.api.post(`/api/deliveries/${dDone}/complete`).set(bearer(rel.token))
      .send({ outcome: 'delivered', recipient: 'R' });
    expect(doneDone.body.order).toBeNull();
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
