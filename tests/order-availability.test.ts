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
