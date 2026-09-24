/** Products In — the Purchasing Goods Receipt pattern mirrored for production output.
 *  A unit that passes final QC (or, with no QC stages, a batch once progress is recorded)
 *  sits "receivable" until POST /:id/products-in confirms it into a chosen location — that
 *  is the only point stock (and the material-only GL "produce" entry) actually posts.
 *  See src/routes/job-orders.routes.ts GET /:id/receivable, POST /:id/products-in,
 *  GET /production-receipts[/:id], hasReceivable(). */
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

/** A released MO for a fresh product with plenty of a single component. */
async function releasedMO(prefix: string, qty: number, qc_stages: number) {
  const product = await mkItem({ name: `${prefix} Product` });
  const part = await mkItem({ name: `${prefix} Part`, quantity: 1000 });
  await ctx.api.put(`/api/finished-products/${product}`).set(H())
    .send({ components: [{ component_item_id: part, quantity: 1 }] });
  const mo = (await ctx.api.post('/api/job-orders').set(H())
    .send({ product_item_id: product, qty_ordered: qty, qc_stages })).body.id as number;
  await ctx.api.post(`/api/job-orders/${mo}/release`).set(H());
  return { mo, product, part };
}

const extraLocation = async (name: string) =>
  (await ctx.api.post('/api/locations').set(H()).send({ name, type: 'warehouse' })).body.id as number;

describe('serialized (QC-gated) job orders', () => {
  it('a unit is not receivable until it passes final QC, then is, then is received', async () => {
    const { mo, product } = await releasedMO('PR1', 1, 1);
    await addSerializedUnits(ctx.api, token, mo, 1, 'PR1');
    const units = (await ctx.api.get(`/api/job-orders/${mo}/units`).set(H())).body as Array<{ id: number }>;

    let rec = (await ctx.api.get(`/api/job-orders/${mo}/receivable`).set(H())).body;
    expect(rec.units).toHaveLength(0);
    expect(rec.batches).toHaveLength(0);

    await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(H())
      .send({ unit_ids: [units[0]!.id], result: 'pass' });

    rec = (await ctx.api.get(`/api/job-orders/${mo}/receivable`).set(H())).body;
    expect(rec.units).toHaveLength(1);
    expect(rec.units[0].id).toBe(units[0]!.id);
    expect(await onHand(product)).toBe(0);

    const recv = await ctx.api.post(`/api/job-orders/${mo}/products-in`).set(H())
      .send({ location_id: rec.output_location_id, unit_ids: [units[0]!.id] });
    expect(recv.status).toBe(201);
    expect(recv.body.number).toMatch(/^PI-\d{5}$/);
    expect(await onHand(product)).toBe(1);

    const unitAfter = (await ctx.api.get(`/api/job-orders/${mo}/units`).set(H())).body[0];
    expect(unitAfter.status).toBe('in_stock');

    // nothing left to receive
    rec = (await ctx.api.get(`/api/job-orders/${mo}/receivable`).set(H())).body;
    expect(rec.units).toHaveLength(0);
  });

  it('rejects receiving a unit that has not passed (still pending)', async () => {
    const { mo } = await releasedMO('PR2', 1, 1);
    await addSerializedUnits(ctx.api, token, mo, 1, 'PR2');
    const units = (await ctx.api.get(`/api/job-orders/${mo}/units`).set(H())).body as Array<{ id: number }>;
    const r = await ctx.api.post(`/api/job-orders/${mo}/products-in`).set(H())
      .send({ location_id: 1, unit_ids: [units[0]!.id] });
    expect(r.status).toBe(409);
  });

  it('choosing a different location than the job order default is how a warehouse transfer happens', async () => {
    const { mo, product } = await releasedMO('PR3', 1, 1);
    await addSerializedUnits(ctx.api, token, mo, 1, 'PR3');
    const units = (await ctx.api.get(`/api/job-orders/${mo}/units`).set(H())).body as Array<{ id: number }>;
    await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(H())
      .send({ unit_ids: [units[0]!.id], result: 'pass' });

    const branch = await extraLocation('PR3 Branch');
    await ctx.api.post(`/api/job-orders/${mo}/products-in`).set(H())
      .send({ location_id: branch, unit_ids: [units[0]!.id] });

    const unitAfter = (await ctx.api.get(`/api/job-orders/${mo}/units`).set(H())).body[0];
    expect(unitAfter.location_id).toBe(branch);
    expect(await onHand(product)).toBe(1); // still 1 total, just at a different location
  });

  it('a unit only becomes sellable/reservable once received, not merely passed', async () => {
    const { mo, product } = await releasedMO('PR4', 1, 1);
    await addSerializedUnits(ctx.api, token, mo, 1, 'PR4');
    const units = (await ctx.api.get(`/api/job-orders/${mo}/units`).set(H())).body as Array<{ id: number }>;
    await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(H())
      .send({ unit_ids: [units[0]!.id], result: 'pass' });

    const so = (await ctx.api.post('/api/orders').set(H()).send({
      type: 'sale', customer_name: 'ACME', items: [{ name: 'x', item_id: product, quantity: 1, unit_price: 10 }],
    })).body.id;
    const early = await ctx.api.post(`/api/finished-products/${product}/units/allocate`).set(H())
      .send({ action: 'sell', unit_ids: [units[0]!.id], order_id: so });
    expect(early.status).toBe(409); // not 'in_stock' yet

    const rec = (await ctx.api.get(`/api/job-orders/${mo}/receivable`).set(H())).body;
    await ctx.api.post(`/api/job-orders/${mo}/products-in`).set(H())
      .send({ location_id: rec.output_location_id, unit_ids: [units[0]!.id] });

    const now = await ctx.api.post(`/api/finished-products/${product}/units/allocate`).set(H())
      .send({ action: 'sell', unit_ids: [units[0]!.id], order_id: so });
    expect(now.status).toBe(200);
  });
});

describe('non-serialized (0 QC stages) job orders', () => {
  it('progress does not post stock; a batch can be received partially then fully', async () => {
    const { mo, product } = await releasedMO('PR5', 5, 0);
    await ctx.api.post(`/api/job-orders/${mo}/progress`).set(H()).send({ done_delta: 5 });
    expect(await onHand(product)).toBe(0);

    let rec = (await ctx.api.get(`/api/job-orders/${mo}/receivable`).set(H())).body;
    expect(rec.batches).toHaveLength(1);
    const batchId = rec.batches[0].id;
    expect(rec.batches[0].remaining_qty).toBe(5);

    const partial = await ctx.api.post(`/api/job-orders/${mo}/products-in`).set(H())
      .send({ location_id: rec.output_location_id, batch_id: batchId, quantity: 3 });
    expect(partial.status).toBe(201);
    expect(await onHand(product)).toBe(3);

    rec = (await ctx.api.get(`/api/job-orders/${mo}/receivable`).set(H())).body;
    expect(rec.batches[0].remaining_qty).toBe(2);

    const over = await ctx.api.post(`/api/job-orders/${mo}/products-in`).set(H())
      .send({ location_id: rec.output_location_id, batch_id: batchId, quantity: 10 });
    expect(over.status).toBe(400); // more than what remains

    const rest = await ctx.api.post(`/api/job-orders/${mo}/products-in`).set(H())
      .send({ location_id: rec.output_location_id, batch_id: batchId, quantity: 2 });
    expect(rest.status).toBe(201);
    expect(await onHand(product)).toBe(5);

    rec = (await ctx.api.get(`/api/job-orders/${mo}/receivable`).set(H())).body;
    expect(rec.batches).toHaveLength(0);
  });

  it("the batch's own QA sign-off status is untouched by receiving (separate concern)", async () => {
    const { mo } = await releasedMO('PR6', 2, 0);
    await ctx.api.post(`/api/job-orders/${mo}/progress`).set(H()).send({ done_delta: 2 });
    const [batch] = (await ctx.api.get('/api/production/batches?job_order=' + mo).set(H())).body;
    expect(batch.status).toBe('open');

    const rec = (await ctx.api.get(`/api/job-orders/${mo}/receivable`).set(H())).body;
    await ctx.api.post(`/api/job-orders/${mo}/products-in`).set(H())
      .send({ location_id: rec.output_location_id, batch_id: batch.id, quantity: 2 });

    const batchAfter = (await ctx.api.get('/api/production/batches?job_order=' + mo).set(H())).body[0];
    expect(batchAfter.status).toBe('open'); // receiving doesn't touch it; the optional QA sign-off does
  });
});

describe('GL: the "produce" entry posts at receiving, not before', () => {
  const acctBalance = async (code: string): Promise<number> => {
    const tb = (await ctx.api.get('/api/accounting/ledger/reports/trial-balance').set(H())).body;
    const row = tb.rows.find((r: { code: string }) => r.code === code);
    return row ? Math.round((row.debit - row.credit) * 100) / 100 : 0;
  };
  const joEntries = async (joId: number) => {
    const list = (await ctx.api.get('/api/accounting/ledger/journal-entries')
      .query({ source_type: 'job_order', source_id: joId }).set(H())).body;
    const out = [];
    for (const e of list) out.push((await ctx.api.get(`/api/accounting/ledger/journal-entries/${e.id}`).set(H())).body);
    return out;
  };
  async function costedMO(prefix: string, qty: number) {
    const product = (await ctx.api.post('/api/inventory').set(H()).send({ name: `${prefix} Product` })).body.id;
    const part = (await ctx.api.post('/api/inventory').set(H())
      .send({ name: `${prefix} Part`, quantity: 1000, unit_cost: 4 })).body.id;
    await ctx.api.put(`/api/finished-products/${product}`).set(H())
      .send({ components: [{ component_item_id: part, quantity: 1 }] });
    const mo = (await ctx.api.post('/api/job-orders').set(H())
      .send({ product_item_id: product, qty_ordered: qty, qc_stages: 0 })).body.id;
    await ctx.api.post(`/api/job-orders/${mo}/release`).set(H());
    return { mo, product };
  }

  it('WIP stays charged until Products In posts; settleJobOrderGl waits for it', async () => {
    await ctx.api.post('/api/accounting/ledger/setup').set(H()).send({ fiscal_year_start: '2026-01-01' });
    const wipBefore = await acctBalance('1152');
    const { mo, product } = await costedMO('PRGL', 3); // released ₱12 (3 × ₱4)
    await ctx.api.post(`/api/job-orders/${mo}/progress`).set(H()).send({ done_delta: 3 });
    const jo = (await ctx.api.get(`/api/job-orders/${mo}`).set(H())).body;
    expect(jo.status).toBe('completed'); // production-complete, independent of receiving

    // no 'produce' entry yet — WIP still holds the released value
    let entries = await joEntries(mo);
    expect(entries.some((e) => /finished goods/i.test(e.memo))).toBe(false);
    expect(await acctBalance('1152')).toBe(Math.round((wipBefore + 12) * 100) / 100);

    const rec = (await ctx.api.get(`/api/job-orders/${mo}/receivable`).set(H())).body;
    await ctx.api.post(`/api/job-orders/${mo}/products-in`).set(H())
      .send({ location_id: rec.output_location_id, batch_id: rec.batches[0].id, quantity: 3 });

    entries = await joEntries(mo);
    const produce = entries.find((e) => /finished goods/i.test(e.memo));
    expect(produce).toBeTruthy();
    const byCode = Object.fromEntries(produce.lines.map((l: { account_code: string; debit: number; credit: number }) => [l.account_code, l]));
    expect(byCode['1150'].debit).toBe(12);  // Inventory (finished goods)
    expect(byCode['1152'].credit).toBe(12); // Work in Process
    expect(await acctBalance('1152')).toBe(wipBefore); // WIP flat again — settle ran after receiving
    expect(await onHand(product)).toBe(3);
  });
});

describe('receipt history', () => {
  it('lists past receipts and reads one back with its lines', async () => {
    const { mo, product } = await releasedMO('PR7', 2, 1);
    await addSerializedUnits(ctx.api, token, mo, 2, 'PR7');
    const units = (await ctx.api.get(`/api/job-orders/${mo}/units`).set(H())).body as Array<{ id: number }>;
    await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(H())
      .send({ unit_ids: units.map((u) => u.id), result: 'pass', identifier: 'PR7-SN' });
    const rec = (await ctx.api.get(`/api/job-orders/${mo}/receivable`).set(H())).body;
    const posted = await ctx.api.post(`/api/job-orders/${mo}/products-in`).set(H())
      .send({ location_id: rec.output_location_id, unit_ids: rec.units.map((u: { id: number }) => u.id), notes: 'count ok' });

    const list = (await ctx.api.get('/api/job-orders/production-receipts?job_order_id=' + mo).set(H())).body;
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(posted.body.id);
    expect(list[0].line_count).toBe(2);
    expect(list[0].product_name).toContain('PR7 Product');

    const one = (await ctx.api.get('/api/job-orders/production-receipts/' + posted.body.id).set(H())).body;
    expect(one.notes).toBe('count ok');
    expect(one.items).toHaveLength(2);
    expect(one.items[0].unit_identifier).toBe('PR7-SN');
  });
});

describe('permissions', () => {
  it('needs inventory.adjust to post a receipt, inventory.view to read', async () => {
    const { mo } = await releasedMO('PR8', 1, 1);
    await addSerializedUnits(ctx.api, token, mo, 1, 'PR8');
    const units = (await ctx.api.get(`/api/job-orders/${mo}/units`).set(H())).body as Array<{ id: number }>;
    await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(H())
      .send({ unit_ids: [units[0]!.id], result: 'pass' });

    const outsider = await createEmployee(ctx.api, token, { role: 'hr' });
    expect((await ctx.api.get(`/api/job-orders/${mo}/receivable`).set(bearer(outsider.token))).status).toBe(403);
    expect((await ctx.api.post(`/api/job-orders/${mo}/products-in`).set(bearer(outsider.token))
      .send({ location_id: 1, unit_ids: [units[0]!.id] })).status).toBe(403);

    const accountant = await createEmployee(ctx.api, token, { role: 'accounting' }); // inventory.view, no .adjust
    expect((await ctx.api.get(`/api/job-orders/${mo}/receivable`).set(bearer(accountant.token))).status).toBe(200);
    expect((await ctx.api.post(`/api/job-orders/${mo}/products-in`).set(bearer(accountant.token))
      .send({ location_id: 1, unit_ids: [units[0]!.id] })).status).toBe(403);
  });
});
