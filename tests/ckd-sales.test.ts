import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, addSerializedUnits, type TestContext } from './helpers';

let ctx: TestContext;
let token: string;
const H = () => ({ Authorization: `Bearer ${token}` });
const stock = async (id: number) => (await ctx.api.get(`/api/inventory/${id}`).set(H())).body.quantity as number;

beforeAll(async () => { ctx = await setupApp(); token = await login(ctx.api); });
afterAll(() => cleanup(ctx));

describe('same product SKU, CKD fulfillment', () => {
  it('ships one complete CKD kit from a two-kit sale and holds the other intact on the same order', async () => {
    const product = (await ctx.api.post('/api/inventory').set(H()).send({ name: 'Partial CKD Unit' })).body.id;
    const frame = (await ctx.api.post('/api/inventory').set(H()).send({ name: 'Partial CKD Frame', quantity: 2 })).body.id;
    const wheel = (await ctx.api.post('/api/inventory').set(H()).send({ name: 'Partial CKD Wheel', quantity: 4 })).body.id;
    await ctx.api.put(`/api/finished-products/${product}`).set(H()).send({ components: [
      { component_item_id: frame, quantity: 1 }, { component_item_id: wheel, quantity: 2 },
    ] });
    const sale = (await ctx.api.post('/api/orders').set(H()).send({ type: 'sale', customer_name: 'Partial CKD Buyer',
      items: [{ item_id: product, name: 'Partial CKD Unit', quantity: 2, unit_price: 100, fulfillment_mode: 'ckd' }] })).body.id;
    await ctx.api.post(`/api/orders/${sale}/status`).set(H()).send({ status: 'approved' });
    const authorization = await ctx.api.post(`/api/release-slips/orders/${sale}/authorizations`).set(H())
      .send({ mode: 'pickup', recipient_name: 'CKD Collector', partial_allowed: true });
    expect(authorization.status).toBe(201);
    await ctx.api.post(`/api/orders/${sale}/accept-release`).set(H());
    await ctx.api.post(`/api/orders/${sale}/release`).set(H()).send({ bulk: [{ item_id: frame, quantity: 1 }] });
    const half = await ctx.api.post(`/api/orders/${sale}/release-slip`).set(H())
      .send({ collected_by: 'CKD Collector', authorization_token: authorization.body.token });
    expect(half.status).toBe(409);
    await ctx.api.post(`/api/orders/${sale}/release`).set(H()).send({ bulk: [{ item_id: wheel, quantity: 3 }] });
    const extra = await ctx.api.post(`/api/orders/${sale}/release-slip`).set(H())
      .send({ collected_by: 'CKD Collector', authorization_token: authorization.body.token });
    expect(extra.status).toBe(409);
    expect(extra.body.error).toMatch(/complete CKD kits/i);
    await ctx.api.post(`/api/orders/${sale}/release/unreserve`).set(H())
      .send({ bulk: [{ item_id: wheel, quantity: 1 }] });
    const shipped = await ctx.api.post(`/api/orders/${sale}/release-slip`).set(H())
      .send({ collected_by: 'CKD Collector', authorization_token: authorization.body.token });
    expect(shipped.status).toBe(201);
    expect(shipped.body.backorder).toBeNull();
    const original=(await ctx.api.get(`/api/orders/${sale}`).set(H())).body;
    expect(original.items.map((l:any)=>[l.fulfillment_mode,l.quantity,l.dispatched_qty])).toEqual([['ckd',2,1],['ckd_component',2,1],['ckd_component',4,2]]);
    expect(original.total).toBe(200);
    expect(await stock(frame)).toBe(1);
    expect(await stock(wheel)).toBe(2);
    expect(await stock(product)).toBe(0);
  });
  it('does not reserve assembled RTS stock for a firm CKD order', async () => {
    const product = (await ctx.api.post('/api/inventory').set(H()).send({ name: 'CKD ATP Bike', quantity: 1 })).body.id;
    const part = (await ctx.api.post('/api/inventory').set(H()).send({ name: 'CKD ATP Part', quantity: 1 })).body.id;
    await ctx.api.put(`/api/finished-products/${product}`).set(H())
      .send({ components: [{ component_item_id: part, quantity: 1 }] });
    const ckd = (await ctx.api.post('/api/orders').set(H()).send({ type: 'sale', customer_name: 'CKD Buyer',
      items: [{ item_id: product, name: 'CKD ATP Bike', quantity: 1, unit_price: 100, fulfillment_mode: 'ckd' }] })).body.id;
    expect((await ctx.api.post(`/api/orders/${ckd}/status`).set(H()).send({ status: 'approved' })).status).toBe(200);
    const built = (await ctx.api.post('/api/orders').set(H()).send({ type: 'sale', customer_name: 'Built Buyer',
      items: [{ item_id: product, name: 'CKD ATP Bike', quantity: 1, unit_price: 100, fulfillment_mode: 'assembled' }] })).body.id;
    const availability = (await ctx.api.get(`/api/orders/${built}/availability`).set(H())).body;
    expect(availability.lines[0]).toMatchObject({ on_hand: 1, available: 1, shortfall: 0 });
    const aftersales = (await ctx.api.post('/api/orders').set(H()).send({ type: 'sale', customer_name: 'Parts Buyer',
      items: [{ item_id: part, name: 'CKD ATP Part', quantity: 1, unit_price: 10 }] })).body.id;
    expect((await ctx.api.get(`/api/orders/${aftersales}/availability`).set(H())).body.lines[0])
      .toMatchObject({ on_hand: 1, available: 0, shortfall: 1 });
  });

  it('does not promise CKD from assembled-unit stock when its parts are missing', async () => {
    const product = (await ctx.api.post('/api/inventory').set(H()).send({ name: 'CKD Short Bike', quantity: 3 })).body.id;
    const part = (await ctx.api.post('/api/inventory').set(H()).send({ name: 'CKD Short Frame', quantity: 0 })).body.id;
    await ctx.api.put(`/api/finished-products/${product}`).set(H())
      .send({ components: [{ component_item_id: part, quantity: 1 }] });
    const sale = await ctx.api.post('/api/orders').set(H()).send({ type: 'sale', customer_name: 'Short Customer',
      items: [{ item_id: product, name: 'CKD Short Bike', quantity: 1, unit_price: 100, fulfillment_mode: 'ckd' }] });
    expect(sale.status).toBe(201);
    const availability = (await ctx.api.get(`/api/orders/${sale.body.id}/availability`).set(H())).body;
    expect(availability.ok).toBe(false);
    expect(availability.lines).toMatchObject([{ item_id: part, shortfall: 1 }]);
    expect(await stock(product)).toBe(3);
  });

  it('snapshots BOM parts, checks and ships parts, and leaves built-unit stock untouched', async () => {
    const product = (await ctx.api.post('/api/inventory').set(H()).send({ name: 'CKD Bike', sku: 'BIKE-ONE' })).body.id;
    const frame = (await ctx.api.post('/api/inventory').set(H()).send({ name: 'CKD Frame', quantity: 3, unit_cost: 25 })).body.id;
    const wheel = (await ctx.api.post('/api/inventory').set(H()).send({ name: 'CKD Wheel', quantity: 6, unit_cost: 10 })).body.id;
    await ctx.api.put(`/api/finished-products/${product}`).set(H()).send({ components: [
      { component_item_id: frame, quantity: 1 }, { component_item_id: wheel, quantity: 2 },
    ] });
    const mo = (await ctx.api.post('/api/job-orders').set(H()).send({ product_item_id: product, qty_ordered: 1, qc_stages: 1 })).body.id;
    await ctx.api.post(`/api/job-orders/${mo}/approve`).set(H());
    await ctx.api.post('/api/job-orders/warehouse-accept').set(H()).send({ job_order_ids: [mo] });
    await ctx.api.post('/api/job-orders/prepare').set(H()).send({ job_orders: [{ id: mo }] });
    await ctx.api.post(`/api/job-orders/${mo}/release`).set(H());
    await ctx.api.post(`/api/job-orders/${mo}/accept`).set(H());
    const [unitId] = await addSerializedUnits(ctx.api, token, mo, 1, 'BUILT');
    await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(H()).send({ unit_ids: [unitId], result: 'pass' });
    const rec = (await ctx.api.get(`/api/job-orders/${mo}/receivable`).set(H())).body;
    await ctx.api.post(`/api/job-orders/${mo}/products-in`).set(H())
      .send({ location_id: rec.output_location_id, unit_ids: [unitId] });
    expect(await stock(product)).toBe(1);
    const create = await ctx.api.post('/api/orders').set(H()).send({ type: 'sale', customer_name: 'CKD Customer',
      items: [{ item_id: product, name: 'CKD Bike', sku: 'BIKE-ONE', quantity: 1, unit_price: 100, fulfillment_mode: 'ckd' }] });
    expect(create.status).toBe(201);
    const id = create.body.id;
    let order = (await ctx.api.get(`/api/orders/${id}`).set(H())).body;
    expect(order.total).toBe(100);
    expect(order.items.map((l: { item_id: number; fulfillment_mode: string; quantity: number }) =>
      [l.item_id, l.fulfillment_mode, l.quantity])).toEqual([
      [product, 'ckd', 1], [frame, 'ckd_component', 1], [wheel, 'ckd_component', 2],
    ]);
    const availability = (await ctx.api.get(`/api/orders/${id}/availability`).set(H())).body;
    expect(availability.ok).toBe(true);
    expect(availability.lines.map((l: { item_id: number }) => l.item_id)).toEqual([frame, wheel]);
    const premature = await ctx.api.post(`/api/orders/${id}/status`).set(H()).send({ status: 'confirmed' });
    expect(premature.status).toBe(409);
    expect(premature.body.code).toBe('release_required');

    await ctx.api.put(`/api/finished-products/${product}`).set(H()).send({ components: [
      { component_item_id: frame, quantity: 2 },
    ] });
    expect((await ctx.api.put(`/api/orders/${id}`).set(H()).send({ notes: 'Pack as CKD', items: [order.items[0]] })).status).toBe(200);
    order = (await ctx.api.get(`/api/orders/${id}`).set(H())).body;
    expect(order.items.filter((l: { fulfillment_mode: string }) => l.fulfillment_mode === 'ckd_component')
      .map((l: { quantity: number }) => l.quantity)).toEqual([1, 2]);

    await ctx.api.post(`/api/orders/${id}/status`).set(H()).send({ status: 'approved' });
    await ctx.api.post(`/api/orders/${id}/accept-release`).set(H());
    const wrong = await ctx.api.post(`/api/orders/${id}/release`).set(H()).send({ bulk: [{ item_id: product, quantity: 1 }] });
    expect(wrong.status).toBe(400);
    const partial = await ctx.api.post(`/api/orders/${id}/release`).set(H()).send({ bulk: [{ item_id: frame, quantity: 1 }] });
    expect(partial.status).toBe(200);
    expect((await ctx.api.get(`/api/orders/${id}`).set(H())).body.status).toBe('approved');
    const incomplete = await ctx.api.post(`/api/orders/${id}/release-slip`).set(H()).send({ collected_by: 'Customer' });
    expect(incomplete.status).toBe(409);
    expect(incomplete.body.blocked).toBe('incomplete');
    expect(await stock(frame)).toBe(2);
    await ctx.api.post(`/api/orders/${id}/release`).set(H()).send({ bulk: [{ item_id: wheel, quantity: 2 }] });
    expect((await ctx.api.get(`/api/orders/${id}`).set(H())).body.status).toBe('released');
    await ctx.api.put('/api/release-slips/policy').set(H()).send({ authorization_required: false });
    const slip = await ctx.api.post(`/api/orders/${id}/release-slip`).set(H()).send({ collected_by: 'Customer' });
    expect(slip.status).toBe(201);
    expect(await stock(product)).toBe(1);
    expect(await stock(frame)).toBe(1);
    expect(await stock(wheel)).toBe(2);
    const context = (await ctx.api.get(`/api/sales-returns/slips/${slip.body.id}/context`).set(H())).body;
    expect(context.lines.map((l: { item_id: number }) => l.item_id)).toEqual([frame, wheel]);

    const semi = (await ctx.api.post('/api/orders').set(H()).send({ type: 'sale', customer_name: 'Semi Customer',
      items: [{ item_id: product, name: 'CKD Bike', sku: 'BIKE-ONE', quantity: 1, unit_price: 120,
        fulfillment_mode: 'semi_built' }] })).body.id;
    expect((await ctx.api.post(`/api/orders/${semi}/status`).set(H()).send({ status: 'approved', force: true })).status).toBe(200);
    await ctx.api.post(`/api/orders/${semi}/accept-release`).set(H());
    const wrongBuild = await ctx.api.post(`/api/orders/${semi}/release`).set(H()).send({ unit_ids: [unitId] });
    expect(wrongBuild.status).toBe(409);
    expect(wrongBuild.body.error).toMatch(/fully built/i);

    // The same product/SKU can also be sold from its built-unit stock on another order.
    const built = await ctx.api.post('/api/orders').set(H()).send({ type: 'sale', customer_name: 'Built Customer',
      items: [{ item_id: product, name: 'CKD Bike', sku: 'BIKE-ONE', quantity: 1, unit_price: 120 }] });
    expect(built.status).toBe(201);
    const builtId = built.body.id;
    const builtAvailability = (await ctx.api.get(`/api/orders/${builtId}/availability`).set(H())).body;
    expect(builtAvailability.lines.map((l: { item_id: number }) => l.item_id)).toEqual([product]);
    await ctx.api.post(`/api/orders/${builtId}/status`).set(H()).send({ status: 'approved' });
    await ctx.api.post(`/api/orders/${builtId}/accept-release`).set(H());
    expect((await ctx.api.post(`/api/orders/${builtId}/release`).set(H())
      .send({ unit_ids: [unitId] })).status).toBe(200);
    expect((await ctx.api.post(`/api/orders/${builtId}/release-slip`).set(H())
      .send({ collected_by: 'Built Customer' })).status).toBe(201);
    expect(await stock(product)).toBe(0);
    expect(await stock(frame)).toBe(1);
    expect(await stock(wheel)).toBe(2);

    const aftersales = await ctx.api.post('/api/orders').set(H()).send({ type: 'sale', customer_name: 'Aftersales Customer',
      items: [{ item_id: frame, name: 'CKD Frame', quantity: 1, unit_price: 40 }] });
    expect(aftersales.status).toBe(201);
    const partsOrder = aftersales.body.id;
    await ctx.api.post(`/api/orders/${partsOrder}/status`).set(H()).send({ status: 'approved' });
    await ctx.api.post(`/api/orders/${partsOrder}/accept-release`).set(H());
    expect((await ctx.api.post(`/api/orders/${partsOrder}/release`).set(H())
      .send({ bulk: [{ item_id: frame, quantity: 1 }] })).status).toBe(200);
    expect((await ctx.api.post(`/api/orders/${partsOrder}/release-slip`).set(H())
      .send({ collected_by: 'Aftersales Customer' })).status).toBe(201);
    expect(await stock(frame)).toBe(0);
    expect(await stock(product)).toBe(0);
  });
});
