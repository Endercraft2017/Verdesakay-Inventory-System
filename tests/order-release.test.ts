/** Sale-order release / pick: a warehouse releaser scans QC-passed serialized units (or
 *  enters a quantity for bulk lines) against an approved SO. Records only — units go
 *  'reserved', stock is drawn down later on confirm (perpetual inventory / GL on). */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, addSerializedUnits, type TestContext } from './helpers';

let ctx: TestContext;
let token: string;
const H = () => ({ Authorization: `Bearer ${token}` });
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  ctx = await setupApp();
  token = await login(ctx.api);
});
afterAll(() => cleanup(ctx));

const mkItem = async (body: Record<string, unknown>) =>
  (await ctx.api.post('/api/inventory').set(H()).send(body)).body.id as number;
const onHand = async (id: number) =>
  (await ctx.api.get(`/api/inventory/${id}`).set(H())).body.quantity as number;

/** A finished product with `qty` QC-passed, Products-In-received serialized units (status
    'in_stock' — sellable/reservable), each labelled PFX-SN-n. */
async function productWithUnits(prefix: string, qty: number, unit_cost = 10) {
  const product = await mkItem({ name: `${prefix} Product`, unit_cost });
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
  // A QC pass only queues a unit for Products In (status 'passed') — receive it so it's
  // actually on hand and reservable, same as a real warehouse flow.
  const receivable = (await ctx.api.get(`/api/job-orders/${mo}/receivable`).set(H())).body;
  if (receivable.units?.length) {
    await ctx.api.post(`/api/job-orders/${mo}/products-in`).set(H())
      .send({ location_id: receivable.output_location_id, unit_ids: receivable.units.map((u: { id: number }) => u.id) });
  }
  return { product, codes };
}

/** An approved order is also warehouse-accepted, ready to pick (pass accept=false to skip). */
const saleOrder = async (lines: Array<Record<string, unknown>>, status = 'open', accept = true) => {
  const id = (await ctx.api.post('/api/orders').set(H()).send({ type: 'sale', customer_name: 'ACME', status, items: lines })).body.id as number;
  if (status === 'approved' && accept) await ctx.api.post(`/api/orders/${id}/accept-release`).set(H());
  return id;
};
const getOrder = async (id: number) => (await ctx.api.get(`/api/orders/${id}`).set(H())).body;

describe('sale-order release', () => {
  it('rejects release on an un-approved order, accepts it once approved', async () => {
    const { product, codes } = await productWithUnits('R1', 2);
    const so = await saleOrder([{ name: 'R1 Product', item_id: product, quantity: 2, unit_price: 50 }]);

    const early = await ctx.api.post(`/api/orders/${so}/release`).set(H()).send({ codes: [codes[0]!] });
    expect(early.status).toBe(409);
    expect(early.body.error).toMatch(/approve/i);

    await ctx.api.put(`/api/orders/${so}`).set(H()).send({
      customer_name: 'ACME', status: 'approved',
      items: [{ name: 'R1 Product', item_id: product, quantity: 2, unit_price: 50 }],
    });
    const unaccepted = await ctx.api.post(`/api/orders/${so}/release`).set(H()).send({ codes: [codes[0]!] });
    expect(unaccepted.status).toBe(409);
    expect(unaccepted.body.error).toMatch(/warehouse must accept/i);
    expect((await ctx.api.post(`/api/orders/${so}/accept-release`).set(H())).status).toBe(200);
    const ok = await ctx.api.post(`/api/orders/${so}/release`).set(H()).send({ codes: [codes[0]!] });
    expect(ok.status).toBe(200);
    expect(ok.body.reserved).toBe(1);
  });

  it('scanning units reserves them (no stock move) and auto-advances to "released" when covered', async () => {
    const { product, codes } = await productWithUnits('R2', 3);
    const before = await onHand(product);
    const so = await saleOrder(
      [{ name: 'R2 Product', item_id: product, quantity: 3, unit_price: 50 }], 'approved');

    let r = await ctx.api.post(`/api/orders/${so}/release`).set(H()).send({ codes: [codes[0]!, codes[1]!] });
    expect(r.body.order.status).toBe('approved');            // 2 of 3 → not yet
    expect(r.body.order.items[0].reserved_qty).toBe(2);
    expect(r.body.order.released_at).toBeTruthy();
    expect(await onHand(product)).toBe(before);              // records only — nothing left stock

    r = await ctx.api.post(`/api/orders/${so}/release`).set(H()).send({ codes: [codes[2]!] });
    expect(r.body.order.status).toBe('released');            // 3/3 → auto
    expect(await onHand(product)).toBe(before);

    // the units now read 'reserved' with this order stamped
    const units = (await ctx.api.get(`/api/finished-products/${product}/units?status=all`).set(H())).body;
    expect(units.every((u: { status: string; order_id: number }) => u.status === 'reserved' && u.order_id === so)).toBe(true);
    // and they're gone from the "available to ship" list
    expect((await ctx.api.get(`/api/finished-products/${product}/units`).set(H())).body).toHaveLength(0);
  });

  it('a bulk line takes a quantity, capped at ordered; over-release is refused', async () => {
    const raw = await mkItem({ name: 'R3 Widget', quantity: 100, unit_cost: 5 });
    const so = await saleOrder([{ name: 'R3 Widget', item_id: raw, quantity: 10, unit_price: 8 }], 'approved');

    const over = await ctx.api.post(`/api/orders/${so}/release`).set(H()).send({ bulk: [{ item_id: raw, quantity: 12 }] });
    expect(over.status).toBe(400);

    const r = await ctx.api.post(`/api/orders/${so}/release`).set(H()).send({ bulk: [{ item_id: raw, quantity: 10 }] });
    expect(r.body.order.items[0].released_qty).toBe(10);
    expect(r.body.order.status).toBe('released');
    expect(await onHand(raw)).toBe(100);                     // still records only
  });

  it('refuses allocation beyond warehouse stock or another approved sale commitment', async () => {
    const raw = await mkItem({ name: 'R3 Scarce Widget', quantity: 3 });
    const first = await saleOrder([{ name: 'R3 Scarce Widget', item_id: raw, quantity: 2, unit_price: 8 }], 'approved');
    const second = await saleOrder([{ name: 'R3 Scarce Widget', item_id: raw, quantity: 2, unit_price: 8 }]);
    await ctx.api.post(`/api/orders/${second}/status`).set(H()).send({ status: 'approved', force: true });
    await ctx.api.post(`/api/orders/${second}/accept-release`).set(H());
    expect((await ctx.api.post(`/api/orders/${second}/release`).set(H())
      .send({ bulk: [{ item_id: raw, quantity: 2 }] })).status).toBe(409);
    expect((await ctx.api.post(`/api/orders/${first}/release`).set(H())
      .send({ bulk: [{ item_id: raw, quantity: 1 }] })).status).toBe(200);
    expect((await ctx.api.post(`/api/orders/${second}/release`).set(H())
      .send({ bulk: [{ item_id: raw, quantity: 2 }] })).status).toBe(409);
    expect((await getOrder(second)).items[0].released_qty).toBe(0);
  });

  it('aggregates repeated bulk entries before validating stock and ordered quantity', async () => {
    const raw = await mkItem({ name: 'R3 Repeated Widget', quantity: 3 });
    const so = await saleOrder([{ name: 'R3 Repeated Widget', item_id: raw, quantity: 5, unit_price: 8 }]);
    await ctx.api.post(`/api/orders/${so}/status`).set(H()).send({ status: 'approved', force: true });
    await ctx.api.post(`/api/orders/${so}/accept-release`).set(H());
    const r = await ctx.api.post(`/api/orders/${so}/release`).set(H()).send({ bulk: [
      { item_id: raw, quantity: 2 }, { item_id: raw, quantity: 2 },
    ] });
    expect(r.status).toBe(409);
    expect((await getOrder(so)).items[0].released_qty).toBe(0);
  });

  it('requires scanning serialized stock rather than counting it as bulk', async () => {
    const { product, codes } = await productWithUnits('R3SER', 1);
    const so = await saleOrder([{ name: 'R3SER Product', item_id: product, quantity: 1, unit_price: 80 }], 'approved');
    const bulk = await ctx.api.post(`/api/orders/${so}/release`).set(H()).send({ bulk: [{ item_id: product, quantity: 1 }] });
    expect(bulk.status).toBe(409);
    expect((await ctx.api.post(`/api/orders/${so}/release`).set(H()).send({ codes })).status).toBe(200);
  });

  it('replays decimal allocation once without deducting stock and refuses a changed body on its key', async () => {
    const raw = await mkItem({ name: 'Measured replay goods', quantity: 10 });
    const so = await saleOrder([{ name: 'Measured replay goods', item_id: raw, quantity: 5, unit_price: 10 }], 'approved');
    const send = () => ctx.api.post(`/api/orders/${so}/release`).set(H()).set('Idempotency-Key','mobile-bulk-allocation-0001');
    const payload = { bulk: [{ item_id: raw, quantity: 2.5 }] };
    expect((await send().send(payload)).status).toBe(200); expect((await send().send(payload)).status).toBe(200);
    expect((await getOrder(so)).items[0].released_qty).toBe(2.5); expect(await onHand(raw)).toBe(10);
    expect((await send().send({ bulk: [{ item_id: raw, quantity: 3 }] })).status).toBe(409); expect((await getOrder(so)).items[0].released_qty).toBe(2.5);
  });

  it('allocates repeated SKU lines separately and requires the line on ambiguous legacy requests', async () => {
    const raw = await mkItem({ name: 'R3 Duplicate Widget', sku: 'R3-DUP-WIDGET', quantity: 10 });
    const created = await ctx.api.post('/api/orders').set(H()).send({ type: 'sale', customer_name: 'ACME', status: 'approved', items: [
      { name: 'R3 Duplicate Widget', item_id: raw, quantity: 1, unit_price: 8 },
      { name: 'R3 Duplicate Widget', item_id: raw, quantity: 2, unit_price: 9 },
    ] });
    expect(created.status).toBe(201);
    const lines = (await getOrder(created.body.id)).items;
    expect(lines.map((l: { unit_price: number }) => l.unit_price)).toEqual([8, 9]);
    const preview = await ctx.api.get(`/api/release-slips/orders/${created.body.id}/unit`).query({ code: 'R3-DUP-WIDGET' }).set(H());
    expect(preview.body.state).toBe('line_required');
    expect(preview.body.matching_lines.map((l: { order_item_id: number }) => l.order_item_id))
      .toEqual(lines.map((l: { id: number }) => l.id));
    await ctx.api.post(`/api/orders/${created.body.id}/accept-release`).set(H());
    const ambiguous = await ctx.api.post(`/api/orders/${created.body.id}/release`).set(H())
      .send({ bulk: [{ item_id: raw, quantity: 1 }] });
    expect(ambiguous.status).toBe(409);
    expect(ambiguous.body.code).toBe('line_required');
    const picked = await ctx.api.post(`/api/orders/${created.body.id}/release`).set(H()).send({ bulk: [
      { item_id: raw, order_item_id: lines[0].id, quantity: 1 },
      { item_id: raw, order_item_id: lines[1].id, quantity: 2 },
    ] });
    expect(picked.status).toBe(200);
    expect(picked.body.order.items.map((l: { released_qty: number }) => l.released_qty)).toEqual([1, 2]);
    expect((await ctx.api.post(`/api/orders/${created.body.id}/release/unreserve`).set(H()).send({ bulk: [
      { item_id: raw, order_item_id: lines[1].id, quantity: 1 },
    ] })).status).toBe(200);
    expect((await getOrder(created.body.id)).items.map((l: { released_qty: number }) => l.released_qty)).toEqual([1, 1]);
  });

  it('requires an exact sale line for serialized units sharing SKU and build state', async () => {
    const { product, codes } = await productWithUnits('R3SERLINES', 2);
    const so = await saleOrder([
      { name: 'R3SERLINES Product', item_id: product, quantity: 1, unit_price: 80 },
      { name: 'R3SERLINES Product', item_id: product, quantity: 1, unit_price: 95 },
    ], 'approved');
    const lines = (await getOrder(so)).items;
    const ambiguous = await ctx.api.post(`/api/orders/${so}/release`).set(H()).send({ codes: [codes[0]!] });
    expect(ambiguous.status).toBe(409);
    expect(ambiguous.body.code).toBe('line_required');
    for (let i = 0; i < 2; i++) {
      expect((await ctx.api.post(`/api/orders/${so}/release`).set(H())
        .send({ codes: [codes[i]!], order_item_id: lines[i].id })).status).toBe(200);
    }
    expect((await getOrder(so)).items.map((l: { reserved_qty: number }) => l.reserved_qty)).toEqual([1, 1]);
  });

  it('unreserve returns units to stock-available and drops status back from released', async () => {
    const { product, codes } = await productWithUnits('R4', 2);
    const so = await saleOrder([{ name: 'R4 Product', item_id: product, quantity: 2, unit_price: 50 }], 'approved');
    await ctx.api.post(`/api/orders/${so}/release`).set(H()).send({ codes });
    expect((await getOrder(so)).status).toBe('released');

    const units = (await ctx.api.get(`/api/finished-products/${product}/units?status=all`).set(H())).body;
    const un = await ctx.api.post(`/api/orders/${so}/release/unreserve`).set(H())
      .send({ unit_ids: [units[0].id] });
    expect(un.status).toBe(200);
    expect(un.body.order.status).toBe('approved');
    expect((await ctx.api.get(`/api/finished-products/${product}/units`).set(H())).body).toHaveLength(1);
  });

  it('refuses an undo that exceeds the allocation or names an unallocated unit', async () => {
    const raw = await mkItem({ name: 'Undo guard widget', quantity: 5 });
    const so = await saleOrder([{ name: 'Undo guard widget', item_id: raw, quantity: 3, unit_price: 10 }], 'approved');
    await ctx.api.post(`/api/orders/${so}/release`).set(H()).send({ bulk: [{ item_id: raw, quantity: 2 }] });
    const excessive = await ctx.api.post(`/api/orders/${so}/release/unreserve`).set(H()).send({ bulk: [
      { item_id: raw, quantity: 1.5 }, { item_id: raw, quantity: 1.5 },
    ] });
    expect(excessive.status).toBe(409);
    expect((await getOrder(so)).items[0].released_qty).toBe(2);
    const missing = await ctx.api.post(`/api/orders/${so}/release/unreserve`).set(H()).send({ unit_ids: [999999] });
    expect(missing.status).toBe(409);
    expect((await ctx.api.post(`/api/orders/${so}/release/unreserve`).set(H())
      .send({ bulk: [{ item_id: raw, quantity: 1 }] })).status).toBe(200);
    expect((await getOrder(so)).items[0].released_qty).toBe(1);
  });

  it("line items lock once the order is approved", async () => {
    const raw = await mkItem({ name: 'R5 Widget', quantity: 50 });
    const so = await saleOrder([{ name: 'R5 Widget', item_id: raw, quantity: 4, unit_price: 10 }], 'approved');
    const put = await ctx.api.put(`/api/orders/${so}`).set(H()).send({
      customer_name: 'ACME', status: 'approved',
      items: [{ name: 'R5 Widget', item_id: raw, quantity: 999, unit_price: 10 }],
    });
    expect(put.status).toBe(200); // header change accepted...
    expect((await getOrder(so)).items[0].quantity).toBe(4); // ...but the line is unchanged
  });

  it('a slipped order draws stock down and flips reserved units to sold (GL on)', async () => {
    await ctx.api.post('/api/accounting/ledger/setup').set(H()).send({ fiscal_year_start: '2026-01-01' });
    await ctx.api.put('/api/release-slips/policy').set(H()).send({ authorization_required: false });
    const { product, codes } = await productWithUnits('R6', 2, 25);
    const before = await onHand(product);
    const so = await saleOrder([{ name: 'R6 Product', item_id: product, quantity: 2, unit_price: 100 }], 'approved');
    await ctx.api.post(`/api/orders/${so}/release`).set(H()).send({ codes });
    expect(await onHand(product)).toBe(before);             // released, not yet shipped

    const bypass = await ctx.api.post(`/api/orders/${so}/status`).set(H()).send({ status: 'completed', force: true });
    expect(bypass.status).toBe(409);
    expect(bypass.body.code).toBe('release_required');
    expect((await ctx.api.post(`/api/orders/${so}/release-slip`).set(H())
      .send({ collected_by: 'Customer' })).status).toBe(201);
    expect(await onHand(product)).toBe(before - 2);         // stock out on slip
    const units = (await ctx.api.get(`/api/finished-products/${product}/units?status=all`).set(H())).body;
    expect(units.every((u: { status: string }) => u.status === 'sold')).toBe(true);

    const cancel = await ctx.api.put(`/api/orders/${so}`).set(H()).send({ status: 'cancelled' });
    expect(cancel.status).toBe(409);
    expect(await onHand(product)).toBe(before - 2);
  });
});

/** Narrow releasing_clerk role (src/shared/permissions.ts) — a mobile-only account scoped
 *  to just POST /:id/release[/unreserve] via orders.release, same narrowing as the
 *  production-side roles in production-roles.test.ts, but without the broad inventory.adjust
 *  that also lets an account adjust arbitrary stock. */
describe('releasing_clerk role', () => {
  it('can release and unreserve a sale order, but cannot adjust inventory directly', async () => {
    const clerk = await createEmployee(ctx.api, token, { role: 'releasing_clerk' });
    const { product, codes } = await productWithUnits('RelClerk', 1);
    const so = await saleOrder([{ name: 'RelClerk Product', item_id: product, quantity: 1, unit_price: 50 }], 'approved');

    const release = await ctx.api.post(`/api/orders/${so}/release`).set(bearer(clerk.token))
      .send({ codes: [codes[0]!] });
    expect(release.status).toBe(200);

    const units = (await ctx.api.get(`/api/finished-products/${product}/units?status=all`).set(H())).body;
    const un = await ctx.api.post(`/api/orders/${so}/release/unreserve`).set(bearer(clerk.token))
      .send({ unit_ids: [units[0].id] });
    expect(un.status).toBe(200);

    const adjust = await ctx.api.post('/api/inventory').set(bearer(clerk.token))
      .send({ name: 'Should not be creatable', quantity: 1 });
    expect(adjust.status).toBe(403);
  });
});

it('uses immutable unit QR IDs when human-readable serials are duplicated',async()=>{
 const {product,codes}=await productWithUnits('QR-ID',2);const {queryAll,run}=await import('../src/shared/db');
 const units=queryAll<{id:number}>('SELECT id FROM job_order_units WHERE product_item_id=? ORDER BY id',product);
 run('UPDATE job_order_units SET identifier=? WHERE id=?',codes[0],units[1]!.id);
 const so=await saleOrder([{item_id:product,name:'QR identity product',quantity:1,unit_price:10}],'approved');
 expect((await ctx.api.get(`/api/release-slips/orders/${so}/unit`).query({code:codes[0]}).set(H())).status).toBe(409);
 expect((await ctx.api.post(`/api/orders/${so}/release`).set(H()).send({codes:[codes[0]]})).status).toBe(409);
 const code='VDS:UNIT:'+units[0]!.id;
 expect((await ctx.api.get('/api/inventory/lookup').query({code}).set(H())).body.unit.id).toBe(units[0]!.id);
 expect((await ctx.api.get(`/api/release-slips/orders/${so}/unit`).query({code}).set(H())).body.unit.id).toBe(units[0]!.id);
 expect((await ctx.api.post(`/api/orders/${so}/release`).set(H()).send({codes:[code]})).status).toBe(200);
 const state=queryAll<{id:number;status:string}>('SELECT id,status FROM job_order_units WHERE product_item_id=? ORDER BY id',product);
 expect(state).toEqual([{id:units[0]!.id,status:'reserved'},{id:units[1]!.id,status:'in_stock'}]);
});
