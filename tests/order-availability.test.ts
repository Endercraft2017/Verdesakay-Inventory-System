/** Sale-order stock-availability gate: approving / confirming an SO is refused when a
 *  line can't be met from stock, unless forced (backorder). Plus the availability
 *  read and the "produce the shortfall" action (with a BOM component check). */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, addSerializedUnits, type TestContext } from './helpers';

let ctx: TestContext;
let token: string;
const H = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  ctx = await setupApp();
  token = await login(ctx.api);
});
afterAll(() => cleanup(ctx));

const mkItem = async (body: Record<string, unknown>) =>
  (await ctx.api.post('/api/inventory').set(H()).send(body)).body.id as number;

const so = async (items: Array<Record<string, unknown>>) =>
  (await ctx.api.post('/api/orders').set(H()).send({ type: 'sale', customer_name: 'ACME', items })).body.id as number;
const approve = (id: number, items: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) =>
  ctx.api.put(`/api/orders/${id}`).set(H()).send({ customer_name: 'ACME', status: 'approved', items, ...extra });

describe('sale-order availability gate', () => {
  it('uses RTS first, builds only the sales shortage, and permits an independent buffer job', async () => {
    const product = await mkItem({ name: 'Mixed RTS Bike', quantity: 2 });
    const part = await mkItem({ name: 'Mixed RTS Part', quantity: 10 });
    await ctx.api.put(`/api/finished-products/${product}`).set(H())
      .send({ components: [{ component_item_id: part, quantity: 1 }] });
    const id = await so([{ item_id: product, name: 'Mixed RTS Bike', quantity: 3, unit_price: 100,
      fulfillment_mode: 'assembled' }]);
    const availability = (await ctx.api.get(`/api/orders/${id}/availability`).set(H())).body;
    expect(availability.lines[0]).toMatchObject({ ordered: 3, on_hand: 2, shortfall: 1 });
    const planned = await ctx.api.post(`/api/orders/${id}/produce-shortfall`).set(H()).send({});
    expect(planned.status).toBe(200);
    expect(planned.body.created).toMatchObject([{ qty: 1 }]);
    const linked = (await ctx.api.get(`/api/job-orders/${planned.body.created[0].job_order_id}`).set(H())).body;
    expect(linked.order_id).toBe(id);
    const buffer = await ctx.api.post('/api/job-orders').set(H()).send({ product_item_id: product, qty_ordered: 4,
      build_mode: 'semi_built' });
    expect(buffer.status).toBe(201);
    const independent = (await ctx.api.get(`/api/job-orders/${buffer.body.id}`).set(H())).body;
    expect(independent.order_id).toBeNull();
    expect(independent.build_mode).toBe('semi_built');
  });

  it('keeps semi-built RTS stock separate from fully built stock under one SKU', async () => {
    const product = await mkItem({ name: 'Variant Bike', sku: 'VARIANT-BIKE', quantity: 1 });
    const part = await mkItem({ name: 'Variant Part', quantity: 10 });
    await ctx.api.put(`/api/finished-products/${product}`).set(H())
      .send({ components: [{ component_item_id: part, quantity: 1 }] });
    const semi = await so([{ item_id: product, name: 'Variant Bike', quantity: 1, unit_price: 100,
      fulfillment_mode: 'semi_built' }]);
    expect((await ctx.api.get(`/api/orders/${semi}/availability`).set(H())).body.lines[0])
      .toMatchObject({ on_hand: 0, shortfall: 1 });
    expect((await ctx.api.post('/api/job-orders').set(H()).send({ product_item_id: product,
      qty_ordered: 1, order_id: semi, build_mode: 'assembled' })).status).toBe(409);
    const planned = await ctx.api.post(`/api/orders/${semi}/produce-shortfall`).set(H()).send({});
    const mo = planned.body.created[0].job_order_id;
    expect((await ctx.api.get(`/api/job-orders/${mo}`).set(H())).body.build_mode).toBe('semi_built');
    await ctx.api.post(`/api/job-orders/${mo}/approve`).set(H());
    await ctx.api.post('/api/job-orders/warehouse-accept').set(H()).send({ job_order_ids: [mo] });
    await ctx.api.post('/api/job-orders/prepare').set(H()).send({ job_orders: [{ id: mo }] });
    await ctx.api.post(`/api/job-orders/${mo}/release`).set(H());
    await ctx.api.post(`/api/job-orders/${mo}/accept`).set(H());
    expect((await ctx.api.post(`/api/job-orders/${mo}/progress`).set(H()).send({ done_delta: 1 })).status).toBe(200);
    const receivable = (await ctx.api.get(`/api/job-orders/${mo}/receivable`).set(H())).body;
    expect((await ctx.api.post(`/api/job-orders/${mo}/products-in`).set(H()).send({
      location_id: receivable.output_location_id,
      batches: [{ batch_id: receivable.batches[0].id, quantity: 1 }],
    })).status).toBe(201);
    expect((await ctx.api.get(`/api/orders/${semi}/availability`).set(H())).body.lines[0])
      .toMatchObject({ on_hand: 1, shortfall: 0 });
    const otherLocation = (await ctx.api.post('/api/locations').set(H()).send({ name: 'Variant Overflow', type: 'warehouse' })).body.id;
    expect((await ctx.api.post(`/api/inventory/${product}/transfer`).set(H()).send({
      from_location_id: receivable.output_location_id, to_location_id: otherLocation, amount: 1, build_mode: 'semi_built',
    })).status).toBe(200);
    expect((await ctx.api.get(`/api/orders/${semi}/availability`).set(H())).body.lines[0])
      .toMatchObject({ on_hand: 0, elsewhere_on_hand: 1, shortfall: 1 });
    expect((await ctx.api.post(`/api/inventory/${product}/transfer`).set(H()).send({
      from_location_id: otherLocation, to_location_id: receivable.output_location_id, amount: 1, build_mode: 'semi_built',
    })).status).toBe(200);
    const full = await so([{ item_id: product, name: 'Variant Bike', quantity: 2, unit_price: 100,
      fulfillment_mode: 'assembled' }]);
    expect((await ctx.api.get(`/api/orders/${full}/availability`).set(H())).body.lines[0])
      .toMatchObject({ on_hand: 1, shortfall: 1 });
    expect((await ctx.api.post(`/api/orders/${semi}/status`).set(H()).send({ status: 'approved' })).status).toBe(200);
    expect((await ctx.api.post(`/api/orders/${semi}/accept-release`).set(H()).send({})).status).toBe(200);
    expect((await ctx.api.post(`/api/orders/${semi}/release`).set(H()).send({ bulk: [{ item_id: product, quantity: 1 }] })).status).toBe(200);
    await ctx.api.put('/api/release-slips/policy').set(H()).send({ authorization_required: false });
    expect((await ctx.api.post(`/api/orders/${semi}/release-slip`).set(H()).send({ collected_by: 'Semi customer' })).status).toBe(201);
    expect((await ctx.api.get(`/api/orders/${full}/availability`).set(H())).body.lines[0])
      .toMatchObject({ on_hand: 1, shortfall: 1 });
    const variantStock = (await ctx.api.get(`/api/inventory/${product}/stock`).set(H())).body;
    expect(variantStock.find((l: { is_default: number }) => l.is_default)).toMatchObject({ assembled_quantity: 1, semi_built_quantity: 0 });
  });

  it('blocks approve when a line is short, and reports per-line detail', async () => {
    const widget = await mkItem({ name: 'AV Widget', quantity: 3 });
    const line = [{ name: 'AV Widget', item_id: widget, quantity: 10, unit_price: 5 }];
    const id = await so(line);

    const av = await ctx.api.get(`/api/orders/${id}/availability`).set(H());
    expect(av.body.ok).toBe(false);
    expect(av.body.short_lines).toBe(1);
    expect(av.body.lines[0]).toMatchObject({ ordered: 10, on_hand: 3, available: 3, shortfall: 7 });

    const blocked = await approve(id, line);
    expect(blocked.status).toBe(409);
    expect(blocked.body.availability.lines[0].shortfall).toBe(7);

    // status did not change
    expect((await ctx.api.get(`/api/orders/${id}`).set(H())).body.status).toBe('open');
  });

  it('allows approve when everything is in stock', async () => {
    const widget = await mkItem({ name: 'AV Enough', quantity: 20 });
    const line = [{ name: 'AV Enough', item_id: widget, quantity: 10, unit_price: 5 }];
    const id = await so(line);
    const ok = await approve(id, line);
    expect(ok.status).toBe(200);
    expect((await ctx.api.get(`/api/orders/${id}`).set(H())).body.status).toBe('approved');
  });

  it('force approves a shortfall as a backorder', async () => {
    const widget = await mkItem({ name: 'AV Back', quantity: 1 });
    const line = [{ name: 'AV Back', item_id: widget, quantity: 5, unit_price: 5 }];
    const id = await so(line);
    expect((await approve(id, line)).status).toBe(409);
    const forced = await approve(id, line, { force: true });
    expect(forced.status).toBe(200);
    expect((await ctx.api.get(`/api/orders/${id}`).set(H())).body.status).toBe('approved');
  });

  it('produce-shortfall raises a linked draft MO and flags a component shortage', async () => {
    // finished product: 1 Frame + 4 Bolts each. Frames short.
    const product = await mkItem({ name: 'AV Bike', unit_cost: 100 });
    const frame = await mkItem({ name: 'AV Frame', quantity: 1 });
    const bolt = await mkItem({ name: 'AV Bolt', quantity: 500 });
    await ctx.api.put(`/api/finished-products/${product}`).set(H())
      .send({ components: [{ component_item_id: frame, quantity: 1 }, { component_item_id: bolt, quantity: 4 }] });

    const line = [{ name: 'AV Bike', item_id: product, quantity: 3, unit_price: 400 }];
    const id = await so(line);

    const av = await ctx.api.get(`/api/orders/${id}/availability`).set(H());
    const l = av.body.lines[0];
    expect(l.shortfall).toBe(3);
    expect(l.is_finished_product).toBe(true);
    expect(l.has_bom).toBe(true);
    expect(l.buildable).toBe(false);
    expect(l.component_shortfalls.map((c: { name: string }) => c.name)).toEqual(['AV Frame']); // bolts fine

    const prod = await ctx.api.post(`/api/orders/${id}/produce-shortfall`).set(H()).send({});
    expect(prod.status).toBe(200);
    expect(prod.body.created).toHaveLength(1);
    expect(prod.body.created[0]).toMatchObject({ line: 'AV Bike', qty: 3, buildable: false });
    expect(prod.body.created[0].number).toMatch(/^MO-\d{5}$/);

    // the MO is linked to this sale order and shows up in availability
    const av2 = await ctx.api.get(`/api/orders/${id}/availability`).set(H());
    expect(av2.body.lines[0].linked_job_orders).toHaveLength(1);

    // running it again doesn't double up
    const again = await ctx.api.post(`/api/orders/${id}/produce-shortfall`).set(H()).send({});
    expect(again.body.created).toHaveLength(0);
    expect(again.body.skipped[0].reason).toMatch(/already covered/i);
  });

  it('a finished-product line whose units exist is not short', async () => {
    // build 2 QC-passed units, order 2
    const product = await mkItem({ name: 'AV Ready', unit_cost: 10 });
    const part = await mkItem({ name: 'AV Ready Part', quantity: 100 });
    await ctx.api.put(`/api/finished-products/${product}`).set(H())
      .send({ components: [{ component_item_id: part, quantity: 1 }] });
    const mo = (await ctx.api.post('/api/job-orders').set(H())
      .send({ product_item_id: product, qty_ordered: 2, qc_stages: 1 })).body.id;
    await ctx.api.post(`/api/job-orders/${mo}/approve`).set(H());
    await ctx.api.post(`/api/job-orders/warehouse-accept`).set(H()).send({ job_order_ids: [mo] });
    await ctx.api.post(`/api/job-orders/prepare`).set(H()).send({ job_orders: [{ id: mo }] });
    await ctx.api.post(`/api/job-orders/${mo}/release`).set(H());
    await ctx.api.post(`/api/job-orders/${mo}/accept`).set(H());
    await addSerializedUnits(ctx.api, token, mo, 2, 'AVReady');
    const u = (await ctx.api.get(`/api/job-orders/${mo}/units`).set(H())).body as Array<{ id: number }>;
    await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(H())
      .send({ unit_ids: u.map((x) => x.id), result: 'pass' });
    // A QC pass only queues units for Products In — receive them so they're on hand.
    const rec = (await ctx.api.get(`/api/job-orders/${mo}/receivable`).set(H())).body;
    await ctx.api.post(`/api/job-orders/${mo}/products-in`).set(H())
      .send({ location_id: rec.output_location_id, unit_ids: rec.units.map((x: { id: number }) => x.id) });

    const line = [{ name: 'AV Ready', item_id: product, quantity: 2, unit_price: 30 }];
    const id = await so(line);
    const ok = await approve(id, line);
    expect(ok.status).toBe(200);
  });
});
