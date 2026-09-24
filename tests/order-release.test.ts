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

const saleOrder = async (lines: Array<Record<string, unknown>>, status = 'open') =>
  (await ctx.api.post('/api/orders').set(H()).send({ type: 'sale', customer_name: 'ACME', status, items: lines })).body.id as number;
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

  it('confirming the order draws stock down and flips reserved units to sold (GL on)', async () => {
    await ctx.api.post('/api/accounting/ledger/setup').set(H()).send({ fiscal_year_start: '2026-01-01' });
    const { product, codes } = await productWithUnits('R6', 2, 25);
    const before = await onHand(product);
    const so = await saleOrder([{ name: 'R6 Product', item_id: product, quantity: 2, unit_price: 100 }], 'approved');
    await ctx.api.post(`/api/orders/${so}/release`).set(H()).send({ codes });
    expect(await onHand(product)).toBe(before);             // released, not yet shipped

    await ctx.api.put(`/api/orders/${so}`).set(H()).send({
      customer_name: 'ACME', status: 'completed',
      items: [{ name: 'R6 Product', item_id: product, quantity: 2, unit_price: 100 }],
    });
    expect(await onHand(product)).toBe(before - 2);         // stock out on confirm
    const units = (await ctx.api.get(`/api/finished-products/${product}/units?status=all`).set(H())).body;
    expect(units.every((u: { status: string }) => u.status === 'sold')).toBe(true);

    // cancelling brings it all back
    await ctx.api.put(`/api/orders/${so}`).set(H()).send({
      customer_name: 'ACME', status: 'cancelled',
      items: [{ name: 'R6 Product', item_id: product, quantity: 2, unit_price: 100 }],
    });
    expect(await onHand(product)).toBe(before);
    const back = (await ctx.api.get(`/api/finished-products/${product}/units?status=all`).set(H())).body;
    expect(back.every((u: { status: string; order_id: number | null }) => u.status === 'in_stock' && u.order_id === null)).toBe(true);
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
