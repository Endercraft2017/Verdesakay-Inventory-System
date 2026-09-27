/** Sale-order releasing, warehouse side: approved SO → warehouse accepts → pick/release →
 *  release slip (numbered record of what left, with photos). Issuing the slip confirms the SO,
 *  which is when stock goes out — even with the general ledger off (no COGS then). */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, addSerializedUnits, type TestContext } from './helpers';

let ctx: TestContext;
let token: string;
const H = () => ({ Authorization: `Bearer ${token}` });
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const PNG = Buffer.from('fake-png-bytes');

beforeAll(async () => {
  ctx = await setupApp();
  token = await login(ctx.api);
});
afterAll(() => cleanup(ctx));

const mkItem = async (body: Record<string, unknown>) =>
  (await ctx.api.post('/api/inventory').set(H()).send(body)).body.id as number;
const onHand = async (id: number) =>
  (await ctx.api.get(`/api/inventory/${id}`).set(H())).body.quantity as number;
const saleOrder = async (lines: Array<Record<string, unknown>>, status = 'approved') =>
  (await ctx.api.post('/api/orders').set(H()).send({ type: 'sale', customer_name: 'ACME', status, items: lines })).body.id as number;
const getOrder = async (id: number) => (await ctx.api.get(`/api/orders/${id}`).set(H())).body;
const queue = async () => (await ctx.api.get('/api/release-slips/queue').set(H())).body as {
  to_accept: Array<{ id: number }>; releasing: Array<{ id: number; qty_ordered: number; qty_released: number }>;
};

/** A finished product with `qty` received, in-stock serialized units labelled PFX-SN-n. */
async function productWithUnits(prefix: string, qty: number) {
  const product = await mkItem({ name: `${prefix} Product`, unit_cost: 10 });
  const part = await mkItem({ name: `${prefix} Part`, quantity: 1000 });
  await ctx.api.put(`/api/finished-products/${product}`).set(H())
    .send({ components: [{ component_item_id: part, quantity: 1 }] });
  const mo = (await ctx.api.post('/api/job-orders').set(H())
    .send({ product_item_id: product, qty_ordered: qty, qc_stages: 1 })).body.id;
  await ctx.api.post(`/api/job-orders/${mo}/approve`).set(H());
  await ctx.api.post(`/api/job-orders/warehouse-accept`).set(H()).send({ job_order_ids: [mo] });
  await ctx.api.post(`/api/job-orders/prepare`).set(H()).send({ job_orders: [{ id: mo }] });
  await ctx.api.post(`/api/job-orders/${mo}/release`).set(H());
  await ctx.api.post(`/api/job-orders/${mo}/accept`).set(H());
  await addSerializedUnits(ctx.api, token, mo, qty, prefix);
  const pending = (await ctx.api.get(`/api/job-orders/${mo}/units`).set(H())).body as Array<{ id: number }>;
  const codes: string[] = [];
  for (let i = 0; i < pending.length; i++) {
    const code = `${prefix}-SN-${i + 1}`;
    await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(H())
      .send({ unit_ids: [pending[i]!.id], result: 'pass', identifier: code });
    codes.push(code);
  }
  const receivable = (await ctx.api.get(`/api/job-orders/${mo}/receivable`).set(H())).body;
  if (receivable.units?.length) {
    await ctx.api.post(`/api/job-orders/${mo}/products-in`).set(H())
      .send({ location_id: receivable.output_location_id, unit_ids: receivable.units.map((u: { id: number }) => u.id) });
  }
  return { product, codes };
}

describe('warehouse acceptance', () => {
  it('an approved SO waits in "to accept", then moves to "releasing" once accepted', async () => {
    const raw = await mkItem({ name: 'A1 Widget', quantity: 20 });
    const so = await saleOrder([{ name: 'A1 Widget', item_id: raw, quantity: 5, unit_price: 10 }]);
    expect((await queue()).to_accept.some((o) => o.id === so)).toBe(true);

    const acc = await ctx.api.post(`/api/orders/${so}/accept-release`).set(H());
    expect(acc.status).toBe(200);
    expect(acc.body.order.warehouse_accepted_at).toBeTruthy();
    const q = await queue();
    expect(q.to_accept.some((o) => o.id === so)).toBe(false);
    const row = q.releasing.find((o) => o.id === so)!;
    expect(row.qty_ordered).toBe(5);
    expect(row.qty_released).toBe(0);
    expect((await getOrder(so)).warehouse_accepted_by_name).toBeTruthy();
  });

  it('refuses to accept an order that is not approved yet', async () => {
    const raw = await mkItem({ name: 'A2 Widget', quantity: 20 });
    const so = await saleOrder([{ name: 'A2 Widget', item_id: raw, quantity: 1, unit_price: 10 }], 'open');
    const r = await ctx.api.post(`/api/orders/${so}/accept-release`).set(H());
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/approved/i);
  });

  it('re-opening an order clears the acceptance', async () => {
    const raw = await mkItem({ name: 'A3 Widget', quantity: 20 });
    const so = await saleOrder([{ name: 'A3 Widget', item_id: raw, quantity: 1, unit_price: 10 }]);
    await ctx.api.post(`/api/orders/${so}/accept-release`).set(H());
    await ctx.api.post(`/api/orders/${so}/status`).set(H()).send({ status: 'open' });
    expect((await getOrder(so)).warehouse_accepted_at).toBeNull();
  });
});

describe('release slip', () => {
  it('is refused until every line is released', async () => {
    const raw = await mkItem({ name: 'S1 Widget', quantity: 20 });
    const so = await saleOrder([{ name: 'S1 Widget', item_id: raw, quantity: 5, unit_price: 10 }]);
    await ctx.api.post(`/api/orders/${so}/accept-release`).set(H());
    await ctx.api.post(`/api/orders/${so}/release`).set(H()).send({ bulk: [{ item_id: raw, quantity: 3 }] });
    const r = await ctx.api.post(`/api/orders/${so}/release-slip`).set(H()).send({ collected_by: 'Juan' });
    expect(r.status).toBe(409);
  });

  it('records what left, confirms the order and draws stock down with the ledger off', async () => {
    const { product, codes } = await productWithUnits('S2', 2);
    const bulk = await mkItem({ name: 'S2 Cable', quantity: 40 });
    const productBefore = await onHand(product);
    const so = await saleOrder([
      { name: 'S2 Product', item_id: product, quantity: 2, unit_price: 100 },
      { name: 'S2 Cable', item_id: bulk, quantity: 6, unit_price: 5 },
      { name: 'Installation', quantity: 1, unit_price: 500 },   // free-text: nothing physical
    ]);
    await ctx.api.post(`/api/orders/${so}/accept-release`).set(H());
    await ctx.api.post(`/api/orders/${so}/release`).set(H()).send({ codes, bulk: [{ item_id: bulk, quantity: 6 }] });
    expect((await getOrder(so)).status).toBe('released');
    expect(await onHand(bulk)).toBe(40);                         // release alone moves nothing

    const noName = await ctx.api.post(`/api/orders/${so}/release-slip`).set(H()).send({});
    expect(noName.status).toBe(400);

    const r = await ctx.api.post(`/api/orders/${so}/release-slip`).set(H())
      .send({ collected_by: 'Juan Dela Cruz', vehicle_plate: 'ABC 1234', notes: 'Gate 2' });
    expect(r.status).toBe(201);
    expect(r.body.order.status).toBe('confirmed');
    expect(await onHand(bulk)).toBe(34);                         // stock out at the slip
    expect(await onHand(product)).toBe(productBefore - 2);
    const units = (await ctx.api.get(`/api/finished-products/${product}/units?status=all`).set(H())).body;
    expect(units.every((u: { status: string }) => u.status === 'sold')).toBe(true);

    const slip = (await ctx.api.get(`/api/release-slips/${r.body.id}`).set(H())).body;
    expect(slip.number).toMatch(/^RS-/);
    expect(slip.collected_by).toBe('Juan Dela Cruz');
    expect(slip.items).toHaveLength(2);                          // the free-text line is left off
    const unitLine = slip.items.find((i: { item_id: number }) => i.item_id === product);
    expect(unitLine.unit_identifiers).toBe(`${codes[0]}, ${codes[1]}`);
    expect((await getOrder(so)).release_slip_number).toBe(slip.number);

    // one slip per order, no un-picking after the goods left, and off the queue
    expect((await ctx.api.post(`/api/orders/${so}/release-slip`).set(H()).send({ collected_by: 'X' })).status).toBe(409);
    expect((await ctx.api.post(`/api/orders/${so}/release/unreserve`).set(H())
      .send({ bulk: [{ item_id: bulk, quantity: 1 }] })).status).toBe(409);
    const q = await queue();
    expect([...q.to_accept, ...q.releasing].some((o) => o.id === so)).toBe(false);
    const list = (await ctx.api.get('/api/release-slips?q=Juan').set(H())).body;
    expect(list.some((s: { id: number }) => s.id === r.body.id)).toBe(true);
  });

  it('cancelling a slipped order puts the stock back (ledger off)', async () => {
    const raw = await mkItem({ name: 'S3 Widget', quantity: 10 });
    const so = await saleOrder([{ name: 'S3 Widget', item_id: raw, quantity: 4, unit_price: 10 }]);
    await ctx.api.post(`/api/orders/${so}/accept-release`).set(H());
    await ctx.api.post(`/api/orders/${so}/release`).set(H()).send({ bulk: [{ item_id: raw, quantity: 4 }] });
    await ctx.api.post(`/api/orders/${so}/release-slip`).set(H()).send({ collected_by: 'Pedro' });
    expect(await onHand(raw)).toBe(6);
    await ctx.api.post(`/api/orders/${so}/status`).set(H()).send({ status: 'cancelled' });
    expect(await onHand(raw)).toBe(10);
  });

  it('a confirmed sale with no slip still leaves stock alone while the ledger is off', async () => {
    const raw = await mkItem({ name: 'S4 Widget', quantity: 10 });
    const so = await saleOrder([{ name: 'S4 Widget', item_id: raw, quantity: 3, unit_price: 10 }]);
    await ctx.api.post(`/api/orders/${so}/status`).set(H()).send({ status: 'confirmed' });
    expect(await onHand(raw)).toBe(10);
  });
});

describe('releasing_clerk on the slip flow', () => {
  it('can accept, release, issue the slip and attach photos', async () => {
    const clerk = await createEmployee(ctx.api, token, { role: 'releasing_clerk' });
    const raw = await mkItem({ name: 'C1 Widget', quantity: 10 });
    const so = await saleOrder([{ name: 'C1 Widget', item_id: raw, quantity: 2, unit_price: 10 }]);
    const C = bearer(clerk.token);

    expect((await ctx.api.post(`/api/orders/${so}/accept-release`).set(C)).status).toBe(200);
    expect((await ctx.api.post(`/api/orders/${so}/release`).set(C).send({ bulk: [{ item_id: raw, quantity: 2 }] })).status).toBe(200);
    const slip = await ctx.api.post(`/api/orders/${so}/release-slip`).set(C).send({ collected_by: 'Driver' });
    expect(slip.status).toBe(201);

    const up = await ctx.api.post('/api/attachments').set(C)
      .field('kind', 'release').field('ref_id', String(slip.body.id)).attach('image', PNG, 'out.png');
    expect(up.status).toBe(201);
    const photos = (await ctx.api.get(`/api/attachments?kind=release&ref_id=${slip.body.id}`).set(H())).body;
    expect(photos).toHaveLength(1);
    expect((await ctx.api.get(`/api/release-slips/${slip.body.id}`).set(C)).body.photo_count).toBe(1);
  });
});
