/** Finished-product units after QA/QC: list them, print-eligible only when in_stock,
 *  sell or relocate them against a sales order, and resolve a printed label's
 *  identifier back to its product via /inventory/lookup. */
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

const mkItem = async (name: string, quantity = 0) =>
  (await ctx.api.post('/api/inventory').set(H()).send({ name, quantity })).body.id as number;
const onHand = async (id: number) =>
  (await ctx.api.get(`/api/inventory/${id}`).set(H())).body.quantity as number;

/** Released MO + progress N units, no QC (qc_stages 0) unless asked. */
async function buildUnits(prefix: string, qty: number, qc_stages = 1) {
  const product = await mkItem(`${prefix} Product`);
  const part = await mkItem(`${prefix} Part`, 1000);
  await ctx.api.put(`/api/finished-products/${product}`).set(H())
    .send({ components: [{ component_item_id: part, quantity: 1 }] });
  const mo = (await ctx.api.post('/api/job-orders').set(H())
    .send({ product_item_id: product, qty_ordered: qty, qc_stages })).body.id;
  await ctx.api.post(`/api/job-orders/${mo}/release`).set(H());
  if (qc_stages > 0) await addSerializedUnits(ctx.api, token, mo, qty, prefix);
  else await ctx.api.post(`/api/job-orders/${mo}/progress`).set(H()).send({ done_delta: qty });
  return { product, mo };
}
const pendingUnits = async (mo: number) =>
  ((await ctx.api.get(`/api/job-orders/${mo}/units`).set(H())).body as Array<{ id: number; status: string }>)
    .filter((u) => u.status === 'pending');

/** A QC pass only queues a unit for Products In (status 'passed') — receive everything
    awaiting it on this job order so it's actually on hand ('in_stock'), same as a real
    warehouse flow. See job-orders.routes.ts GET /:id/receivable, POST /:id/products-in. */
async function receiveAll(mo: number): Promise<void> {
  const rec = (await ctx.api.get(`/api/job-orders/${mo}/receivable`).set(H())).body;
  if (rec.units?.length) {
    const r = await ctx.api.post(`/api/job-orders/${mo}/products-in`).set(H())
      .send({ location_id: rec.output_location_id, unit_ids: rec.units.map((u: { id: number }) => u.id) });
    if (r.status !== 201) throw new Error(`receive units failed: ${JSON.stringify(r.body)}`);
  }
}

async function saleOrder(): Promise<number> {
  const r = await ctx.api.post('/api/orders').set(H()).send({
    type: 'sale', customer_name: 'ACME',
    items: [{ name: 'widget', quantity: 1, unit_price: 100 }],
  });
  return r.body.id as number;
}

describe('finished-product units list', () => {
  it('returns only in_stock (QC-passed) units by default, with identifier + MO number', async () => {
    const { product, mo } = await buildUnits('FPU', 2);
    // still pending inspection → not listed as in_stock
    expect((await ctx.api.get(`/api/finished-products/${product}/units`).set(H())).body).toHaveLength(0);

    const u = await pendingUnits(mo);
    await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(H())
      .send({ unit_ids: [u[0]!.id], result: 'pass', identifier: 'SN-100' });
    await receiveAll(mo);

    const units = (await ctx.api.get(`/api/finished-products/${product}/units`).set(H())).body;
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ identifier: 'SN-100', status: 'in_stock' });
    expect(units[0].job_order_number).toBeTruthy();
  });
});

describe('sell / move units', () => {
  it('sells in_stock units against a sales order: status → sold, stock drops, order_id stamped', async () => {
    const { product, mo } = await buildUnits('SELL', 3);
    const u = await pendingUnits(mo);
    await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(H())
      .send({ unit_ids: u.map((x) => x.id), result: 'pass' }); // 3 units in stock, no identifier
    await receiveAll(mo);
    expect(await onHand(product)).toBe(3);

    const so = await saleOrder();
    const before = (await ctx.api.get(`/api/finished-products/${product}/units`).set(H())).body;
    const sell = await ctx.api.post(`/api/finished-products/${product}/units/allocate`).set(H())
      .send({ action: 'sell', unit_ids: [before[0].id, before[1].id], order_id: so });
    expect(sell.status).toBe(200);
    expect(sell.body).toMatchObject({ action: 'sell', affected: 2, product_quantity: 1 });
    expect(await onHand(product)).toBe(1);

    const sold = (await ctx.api.get(`/api/finished-products/${product}/units?status=sold`).set(H())).body;
    expect(sold).toHaveLength(2);
    expect(sold[0].order_number).toBeTruthy();
    // only 1 left available
    expect((await ctx.api.get(`/api/finished-products/${product}/units`).set(H())).body).toHaveLength(1);
  });

  it('sell needs an order, and rejects units that have not passed QC', async () => {
    const { product, mo } = await buildUnits('GUARD', 2);
    const pend = await pendingUnits(mo);
    // no order_id
    expect((await ctx.api.post(`/api/finished-products/${product}/units/allocate`).set(H())
      .send({ action: 'sell', quantity: 1 })).status).toBe(400);
    // a pending (not in_stock) unit
    const so = await saleOrder();
    const r = await ctx.api.post(`/api/finished-products/${product}/units/allocate`).set(H())
      .send({ action: 'sell', unit_ids: [pend[0]!.id], order_id: so });
    expect(r.status).toBe(409);
  });

  it('exposes allocated_qty per line on GET /orders/:id for a finished-product line', async () => {
    const { product, mo } = await buildUnits('ALLOC', 3);
    const u = await pendingUnits(mo);
    await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(H())
      .send({ unit_ids: u.map((x) => x.id), result: 'pass' });
    await receiveAll(mo);

    const so = (await ctx.api.post('/api/orders').set(H()).send({
      type: 'sale', customer_name: 'ACME',
      items: [{ name: 'ALLOC Product', item_id: product, quantity: 5, unit_price: 200 }],
    })).body.id;

    let detail = (await ctx.api.get(`/api/orders/${so}`).set(H())).body;
    expect(detail.items[0].allocated_qty).toBe(0);

    const inStock = (await ctx.api.get(`/api/finished-products/${product}/units`).set(H())).body;
    await ctx.api.post(`/api/finished-products/${product}/units/allocate`).set(H())
      .send({ action: 'sell', unit_ids: [inStock[0].id, inStock[1].id], order_id: so });

    detail = (await ctx.api.get(`/api/orders/${so}`).set(H())).body;
    expect(detail.items[0].allocated_qty).toBe(2);
  });

  it('moves units to another location without changing the grand total', async () => {
    const { product, mo } = await buildUnits('MOVE', 2);
    const u = await pendingUnits(mo);
    await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(H())
      .send({ unit_ids: u.map((x) => x.id), result: 'pass' });
    await receiveAll(mo);
    const dest = (await ctx.api.post('/api/locations').set(H()).send({ name: 'MOVE Branch', type: 'branch' })).body.id;
    const list = (await ctx.api.get(`/api/finished-products/${product}/units`).set(H())).body;

    const mv = await ctx.api.post(`/api/finished-products/${product}/units/allocate`).set(H())
      .send({ action: 'move', unit_ids: [list[0].id], to_location_id: dest });
    expect(mv.status).toBe(200);
    expect(mv.body.product_quantity).toBe(2); // total unchanged
    const after = (await ctx.api.get(`/api/finished-products/${product}/units`).set(H())).body;
    expect(after.find((x: { id: number }) => x.id === list[0].id).location_name).toBe('MOVE Branch');
  });
});

describe('label lookup', () => {
  it('resolves a printed unit identifier to its product via /inventory/lookup', async () => {
    const { mo } = await buildUnits('LBL', 1);
    const u = await pendingUnits(mo);
    await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(H())
      .send({ unit_ids: [u[0]!.id], result: 'pass', identifier: 'CHASSIS-777' });
    await receiveAll(mo);

    const r = await ctx.api.get('/api/inventory/lookup?code=CHASSIS-777').set(H());
    expect(r.status).toBe(200);
    expect(r.body.name).toContain('LBL Product');
    expect(r.body.unit).toMatchObject({ identifier: 'CHASSIS-777', status: 'in_stock' });
  });
});
