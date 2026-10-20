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
  return createEmployee(ctx.api, adminToken, { role: 'driver' });
}

describe('delivery permissions', () => {
  it('run + manage are in the catalog; driver runs and dispatcher manages; warehouse and releasing do neither', () => {
    expect(ALL_PERMISSIONS).toContain('delivery.run');
    expect(ALL_PERMISSIONS).toContain('delivery.manage');
    expect(roleDefaults('driver')).toContain('delivery.run');
    expect(roleDefaults('warehouse')).not.toContain('delivery.manage');
    expect(roleDefaults('dispatcher')).toContain('delivery.manage');
    expect(roleDefaults('warehouse')).not.toContain('delivery.run');
    expect(roleDefaults('releasing')).not.toContain('delivery.manage');
    expect(roleDefaults('hr')).not.toContain('delivery.run');
  });
});

describe('deliveries', () => {
  it('closes a courier booking at pickup with proof, without recording customer delivery', async () => {
    const warehouse = await driver();
    const item = (await ctx.api.post('/api/inventory').set(A()).send({ name: 'Courier part', quantity: 1 })).body.id;
    const sale = (await ctx.api.post('/api/orders').set(A()).send({ type: 'sale', customer_name: 'Courier buyer',
      items: [{ item_id: item, name: 'Courier part', quantity: 1, unit_price: 10 }] })).body.id;
    const booking = await ctx.api.post('/api/deliveries').set(A()).send({ order_id: sale, assigned_to: warehouse.id,
      delivery_mode: 'courier', courier_name: 'Swift Cargo', tracking_number: 'SW-123' });
    expect(booking.status).toBe(201);
    const id = booking.body.id;
    expect((await ctx.api.post('/api/deliveries').set(A()).send({ order_id: sale, delivery_mode: 'own' })).body.code)
      .toBe('shipment_already_booked');
    expect((await ctx.api.post(`/api/deliveries/${id}/status`).set(bearer(warehouse.token))
      .send({ status: 'out_for_delivery' })).body.code).toBe('courier_handoff_required');
    expect((await ctx.api.post(`/api/deliveries/${id}/complete`).set(bearer(warehouse.token))
      .send({ outcome: 'courier_handoff', recipient: 'Courier driver' })).body.code).toBe('release_required');
    await ctx.api.post(`/api/orders/${sale}/status`).set(A()).send({ status: 'approved' });
    await ctx.api.post(`/api/orders/${sale}/accept-release`).set(A());
    await ctx.api.post(`/api/orders/${sale}/release`).set(A()).send({ bulk: [{ item_id: item, quantity: 1 }] });
    await ctx.api.put('/api/release-slips/policy').set(A()).send({ authorization_required: false });
    expect((await ctx.api.post(`/api/orders/${sale}/release-slip`).set(A()).send({ collected_by: 'Swift Cargo' })).status).toBe(201);
    expect((await ctx.api.post(`/api/deliveries/${id}/status`).set(bearer(warehouse.token))
      .send({ status: 'out_for_delivery' })).body.code).toBe('courier_handoff_required');
    expect((await ctx.api.post(`/api/deliveries/${id}/complete`).set(bearer(warehouse.token))
      .send({ outcome: 'delivered', recipient: 'Buyer' })).body.code).toBe('courier_handoff_required');
    const photo = await ctx.api.post('/api/attachments').set(bearer(warehouse.token))
      .field('kind', 'delivery').field('ref_id', String(id))
      .attach('image', Buffer.from('courier-collection-photo'), 'collection.png');
    expect(photo.status).toBe(201);
    const done = await ctx.api.post(`/api/deliveries/${id}/complete`).set(bearer(warehouse.token))
      .send({ outcome: 'courier_handoff', recipient: 'Courier driver' });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'delivered', handoff: 'courier' });
    expect((await ctx.api.get(`/api/deliveries/${id}`).set(A())).body).toMatchObject({
      delivery_mode: 'courier', courier_name: 'Swift Cargo', tracking_number: 'SW-123',
      status: 'delivered', pod_recipient: 'Courier driver', photo_count: 1,
    });
    expect((await ctx.api.delete(`/api/attachments/${photo.body.id}`).set(A())).status).toBe(409);
  });
  it('allows courier pickup without recipient or evidence, preserves assignment and validates supplied signature', async () => {
    const assigned = await driver(), other = await driver();
    const booking = await ctx.api.post('/api/deliveries').set(A()).send({ assigned_to: assigned.id,
      delivery_mode: 'courier', courier_name: 'Optional Evidence Carrier' });
    const url = `/api/deliveries/${booking.body.id}/complete`;
    expect((await ctx.api.post(url).set(bearer(other.token)).send({ outcome: 'courier_handoff' })).status).toBe(403);
    expect((await ctx.api.post(url).set(bearer(assigned.token)).send({ outcome: 'courier_handoff', signature_attachment_id: 99999 })).status).toBe(400);
    const done = await ctx.api.post(url).set(bearer(assigned.token)).send({ outcome: 'courier_handoff', tracking_number: 'OPTIONAL-123' });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'delivered', handoff: 'courier' });
    expect((await ctx.api.get(`/api/deliveries/${booking.body.id}`).set(A())).body).toMatchObject({
      status: 'delivered', pod_recipient: null, signature_url: null, photos: [], tracking_number: 'OPTIONAL-123' });
  });
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

  it('a manage-only account can operate delivery while a baseline account is denied', async () => {
    const manager = await driver();
    await ctx.api.put('/api/users/' + manager.id + '/permissions').set(A()).send({ overrides: { 'delivery.run': false, 'delivery.manage': true } });
    const del = (await ctx.api.post('/api/deliveries').set(A()).send({ customer_name: 'Managed drop' })).body.id;
    expect((await ctx.api.get('/api/deliveries').set(bearer(manager.token))).status).toBe(200);
    expect((await ctx.api.post(`/api/deliveries/${del}/status`).set(bearer(manager.token)).send({ status: 'out_for_delivery' })).status).toBe(200);
    expect((await ctx.api.post(`/api/deliveries/${del}/complete`).set(bearer(manager.token)).send({ outcome: 'delivered' })).status).toBe(200);
    await ctx.api.put('/api/users/' + manager.id + '/permissions').set(A()).send({ overrides: { 'delivery.run': false, 'delivery.manage': false } });
    expect((await ctx.api.get('/api/deliveries').set(bearer(manager.token))).status).toBe(403);
    expect((await ctx.api.post(`/api/deliveries/${del}/complete`).set(bearer(manager.token)).send({ outcome: 'delivered' })).status).toBe(403);
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
    // `releasing` role has delivery.run AND orders.approve — the hint is gated on orders.approve.
    const rel = await createEmployee(ctx.api, adminToken, { role: 'driver' });
    await ctx.api.put(`/api/users/${rel.id}/permissions`).set(A()).send({overrides:{'orders.approve':true}});
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

  it('no `order` hint for a driver without orders.approve, a failed drop, or a completed order', async () => {
    const wh = await driver(); // warehouse: delivery.run but NOT orders.approve
    const rel = await createEmployee(ctx.api, adminToken, { role: 'driver' });
    await ctx.api.put(`/api/users/${rel.id}/permissions`).set(A()).send({overrides:{'orders.approve':true}});

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
    expect(got.body.items).toHaveLength(0); // no physical trip has been loaded yet

    expect((await ctx.api.delete('/api/deliveries/' + del.body.id).set(A())).status).toBe(200);
  });
});
