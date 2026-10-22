/** Manufacturing job orders (Phase B): BOM snapshot, release consumption,
    progress, auto-complete, close/cancel returns, pause/resume, delete, RBAC. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';

let ctx: TestContext;
let token: string;
const authHdr = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  ctx = await setupApp();
  token = await login(ctx.api);
});
afterAll(() => cleanup(ctx));

const mkItem = async (name: string, quantity = 0) =>
  (await ctx.api.post('/api/inventory').set(authHdr()).send({ name, quantity })).body.id as number;

const onHand = async (id: number) =>
  (await ctx.api.get(`/api/inventory/${id}`).set(authHdr())).body.quantity as number;

/** Receive everything currently awaiting Products In on a job order (see
    job-orders.routes.ts POST /:id/receivable + /:id/products-in) — production no longer
    lands in stock on its own; this is the step that posts it. */
async function receiveAll(moId: number): Promise<void> {
  const rec = (await ctx.api.get(`/api/job-orders/${moId}/receivable`).set(authHdr())).body;
  const location_id = rec.output_location_id;
  if (rec.units?.length) {
    const r = await ctx.api.post(`/api/job-orders/${moId}/products-in`).set(authHdr())
      .send({ location_id, unit_ids: rec.units.map((u: { id: number }) => u.id) });
    if (r.status !== 201) throw new Error(`receive units failed: ${JSON.stringify(r.body)}`);
  }
  for (const b of rec.batches ?? []) {
    const r = await ctx.api.post(`/api/job-orders/${moId}/products-in`).set(authHdr())
      .send({ location_id, batch_id: b.id, quantity: b.remaining_qty });
    if (r.status !== 201) throw new Error(`receive batch failed: ${JSON.stringify(r.body)}`);
  }
}

/** A finished product built from 2 bolts + 3 panels, with plenty of stock. */
async function setupProduct(prefix: string, boltStock = 100, panelStock = 100) {
  const product = await mkItem(`${prefix} Product`);
  const bolt = await mkItem(`${prefix} Bolt`, boltStock);
  const panel = await mkItem(`${prefix} Panel`, panelStock);
  await ctx.api.put(`/api/finished-products/${product}`).set(authHdr()).send({
    components: [
      { component_item_id: bolt, quantity: 2 },
      { component_item_id: panel, quantity: 3 },
    ],
  });
  return { product, bolt, panel };
}

const createMO = (body: Record<string, unknown>) =>
  ctx.api.post('/api/job-orders').set(authHdr()).send(body);

describe('job orders', () => {
  it('suggests a separate controller build for a parent BOM and requires acceptance', async () => {
    const board = await mkItem('Nested board');
    const chip = await mkItem('Nested chip', 4);
    const bike = await mkItem('Nested bike');
    expect((await ctx.api.put(`/api/finished-products/${board}`).set(authHdr()).send({
      components: [{ component_item_id: chip, quantity: 2 }],
    })).status).toBe(200);
    expect((await ctx.api.put(`/api/finished-products/${bike}`).set(authHdr()).send({
      components: [{ component_item_id: board, quantity: 1 }],
    })).status).toBe(200);
    const parent = await createMO({ product_item_id: bike, qty_ordered: 2 });
    expect(parent.status).toBe(201);
    let suggestions = (await ctx.api.get(`/api/job-orders/${parent.body.id}/subassembly-suggestions`).set(authHdr())).body;
    expect(suggestions).toEqual([expect.objectContaining({ component_item_id: board, short: 2, suggested_qty: 2, buildable_now: 2 })]);
    expect((await ctx.api.get(`/api/job-orders/${parent.body.id}`).set(authHdr())).body.components)
      .toEqual([expect.objectContaining({ component_item_id: board, qty_planned: 2 })]);
    expect((await ctx.api.post(`/api/job-orders/${parent.body.id}/subassembly-jobs`).set(authHdr())
      .send({ component_item_id: board, quantity: 3 })).status).toBe(409);
    const child = await ctx.api.post(`/api/job-orders/${parent.body.id}/subassembly-jobs`).set(authHdr())
      .send({ component_item_id: board, quantity: 2 });
    expect(child.status).toBe(201);
    expect(child.body.parent_job_order_id).toBe(parent.body.id);
    expect((await ctx.api.get(`/api/job-orders/${child.body.id}`).set(authHdr())).body.components)
      .toEqual([expect.objectContaining({ component_item_id: chip, qty_planned: 4 })]);
    suggestions = (await ctx.api.get(`/api/job-orders/${parent.body.id}/subassembly-suggestions`).set(authHdr())).body;
    expect(suggestions[0]).toEqual(expect.objectContaining({ planned: 2, uncovered: 0, suggested_qty: 0 }));
  });

  it('creates a draft that snapshots the BOM (planned = per-unit * qty)', async () => {
    const { product } = await setupProduct('Draft');
    const res = await createMO({ product_item_id: product, qty_ordered: 10 });
    expect(res.status).toBe(201);

    const jo = (await ctx.api.get(`/api/job-orders/${res.body.id}`).set(authHdr())).body;
    expect(jo.status).toBe('draft');
    expect(jo.number).toMatch(/^MO-\d{5}$/);
    const bolt = jo.components.find((c: { component_name: string }) => /Bolt/.test(c.component_name));
    expect(bolt.qty_per_unit).toBe(2);
    expect(bolt.qty_planned).toBe(20);
    expect(bolt.qty_consumed).toBe(0);
  });

  it('rejects a product that is not flagged as a finished product', async () => {
    const plain = await mkItem('Just An Item', 5);
    expect((await createMO({ product_item_id: plain, qty_ordered: 1 })).status).toBe(400);
  });

  it('builds a finished product that has no BOM — reserves and consumes nothing', async () => {
    const product = await mkItem('Bare Product');
    await ctx.api.put(`/api/finished-products/${product}`).set(authHdr()).send({ components: [] });

    const mo = await createMO({ product_item_id: product, qty_ordered: 3 });
    expect(mo.status).toBe(201);
    const jo = (await ctx.api.get(`/api/job-orders/${mo.body.id}`).set(authHdr())).body;
    expect(jo.components).toEqual([]);

    await ctx.api.post(`/api/job-orders/${mo.body.id}/approve`).set(authHdr());
    await ctx.api.post(`/api/job-orders/warehouse-accept`).set(authHdr()).send({ job_order_ids: [mo.body.id] });
    await ctx.api.post(`/api/job-orders/prepare`).set(authHdr()).send({ job_orders: [{ id: mo.body.id }] });
    const rel = await ctx.api.post(`/api/job-orders/${mo.body.id}/release`).set(authHdr());
    await ctx.api.post(`/api/job-orders/${mo.body.id}/accept`).set(authHdr());
    expect(rel.status).toBe(200);
    expect(rel.body.job_order.status).toBe('released');

    const r = await ctx.api.post(`/api/job-orders/${mo.body.id}/progress`).set(authHdr()).send({ done_delta: 3 });
    expect(r.body.job_order.status).toBe('completed');
    expect(await onHand(product)).toBe(0); // produced, but not yet received — Products In posts it
    await receiveAll(mo.body.id);
    expect(await onHand(product)).toBe(3);
  });

  it('a draft can add a component that is not on the product BOM', async () => {
    const { product } = await setupProduct('AdHoc');
    const extra = await mkItem('AdHoc Extra Part', 50);
    const { body } = await createMO({ product_item_id: product, qty_ordered: 4 });

    const upd = await ctx.api.put(`/api/job-orders/${body.id}/components`).set(authHdr())
      .send({ components: [{ component_item_id: extra, qty_planned: 8 }] });
    expect(upd.status).toBe(200);
    const jo = (await ctx.api.get(`/api/job-orders/${body.id}`).set(authHdr())).body;
    const line = jo.components.find((c: { component_item_id: number }) => c.component_item_id === extra);
    expect(line).toBeTruthy();
    expect(line.qty_planned).toBe(8);
    expect(line.qty_per_unit).toBe(2); // 8 / 4 ordered

    await ctx.api.post(`/api/job-orders/${body.id}/approve`).set(authHdr());
    await ctx.api.post(`/api/job-orders/warehouse-accept`).set(authHdr()).send({ job_order_ids: [body.id] });
    await ctx.api.post(`/api/job-orders/prepare`).set(authHdr()).send({ job_orders: [{ id: body.id }] });
    await ctx.api.post(`/api/job-orders/${body.id}/release`).set(authHdr());
    await ctx.api.post(`/api/job-orders/${body.id}/accept`).set(authHdr());
    expect(await onHand(extra)).toBe(42); // 50 − 8 reserved
  });

  it('lets a draft override planned quantities, but not after release', async () => {
    const { product, bolt } = await setupProduct('Override');
    const { body } = await createMO({ product_item_id: product, qty_ordered: 5 }); // bolt planned = 10

    const upd = await ctx.api.put(`/api/job-orders/${body.id}/components`).set(authHdr())
      .send({ components: [{ component_item_id: bolt, qty_planned: 14 }] });
    expect(upd.status).toBe(200);
    const jo = (await ctx.api.get(`/api/job-orders/${body.id}`).set(authHdr())).body;
    expect(jo.components.find((c: { component_item_id: number }) => c.component_item_id === bolt).qty_planned).toBe(14);

    await ctx.api.post(`/api/job-orders/${body.id}/approve`).set(authHdr());
    await ctx.api.post(`/api/job-orders/warehouse-accept`).set(authHdr()).send({ job_order_ids: [body.id] });
    await ctx.api.post(`/api/job-orders/prepare`).set(authHdr()).send({ job_orders: [{ id: body.id }] });
    await ctx.api.post(`/api/job-orders/${body.id}/release`).set(authHdr());
    await ctx.api.post(`/api/job-orders/${body.id}/accept`).set(authHdr());
    const after = await ctx.api.put(`/api/job-orders/${body.id}/components`).set(authHdr())
      .send({ components: [{ component_item_id: bolt, qty_planned: 2 }] });
    expect(after.status).toBe(409);
  });

  it('release deducts planned components from the source location', async () => {
    const { product, bolt, panel } = await setupProduct('Release', 50, 50);
    const { body } = await createMO({ product_item_id: product, qty_ordered: 10 }); // 20 bolts, 30 panels

    await ctx.api.post(`/api/job-orders/${body.id}/approve`).set(authHdr());
    await ctx.api.post(`/api/job-orders/warehouse-accept`).set(authHdr()).send({ job_order_ids: [body.id] });
    await ctx.api.post(`/api/job-orders/prepare`).set(authHdr()).send({ job_orders: [{ id: body.id }] });
    const rel = await ctx.api.post(`/api/job-orders/${body.id}/release`).set(authHdr());
    await ctx.api.post(`/api/job-orders/${body.id}/accept`).set(authHdr());
    expect(rel.status).toBe(200);
    expect(rel.body.job_order.status).toBe('released');
    expect(await onHand(bolt)).toBe(30);
    expect(await onHand(panel)).toBe(20);
  });

  it('a short component stops the pick, so the kit is never released (no stock change)', async () => {
    const { product, bolt } = await setupProduct('Short', 5, 100); // only 5 bolts, need 20
    const { body } = await createMO({ product_item_id: product, qty_ordered: 10 });
    await ctx.api.post(`/api/job-orders/${body.id}/approve`).set(authHdr());
    await ctx.api.post(`/api/job-orders/warehouse-accept`).set(authHdr()).send({ job_order_ids: [body.id] });
    const prep = await ctx.api.post(`/api/job-orders/prepare`).set(authHdr()).send({ job_orders: [{ id: body.id }] });
    expect(prep.status).toBe(400);
    expect(prep.body.shortfalls.length).toBeGreaterThan(0);
    const rel = await ctx.api.post(`/api/job-orders/${body.id}/release`).set(authHdr());
    expect(rel.status).toBe(409);
    expect(rel.body.needs_prepare).toBe(true);
    expect(await onHand(bolt)).toBe(5); // untouched
  });

  it('progress consumes components, adds finished stock, and auto-completes', async () => {
    const { product, bolt, panel } = await setupProduct('Progress', 100, 100);
    const { body } = await createMO({ product_item_id: product, qty_ordered: 4 }); // 8 bolts, 12 panels
    await ctx.api.post(`/api/job-orders/${body.id}/approve`).set(authHdr());
    await ctx.api.post(`/api/job-orders/warehouse-accept`).set(authHdr()).send({ job_order_ids: [body.id] });
    await ctx.api.post(`/api/job-orders/prepare`).set(authHdr()).send({ job_orders: [{ id: body.id }] });
    await ctx.api.post(`/api/job-orders/${body.id}/release`).set(authHdr());
    await ctx.api.post(`/api/job-orders/${body.id}/accept`).set(authHdr());

    let r = await ctx.api.post(`/api/job-orders/${body.id}/progress`).set(authHdr()).send({ done_delta: 3 });
    expect(r.status).toBe(200);
    expect(r.body.job_order.status).toBe('in_progress');
    expect(r.body.job_order.qty_done).toBe(3);
    expect(await onHand(product)).toBe(0); // produced, but awaiting Products In
    await receiveAll(body.id);
    expect(await onHand(product)).toBe(3); // 3 finished units in stock

    r = await ctx.api.post(`/api/job-orders/${body.id}/progress`).set(authHdr()).send({ done_delta: 1 });
    expect(r.body.job_order.status).toBe('completed'); // 4/4 accounted
    await receiveAll(body.id);
    expect(await onHand(product)).toBe(4);
    // all reserved components consumed, none left to return
    expect(await onHand(bolt)).toBe(92);
    expect(await onHand(panel)).toBe(88);
  });

  it('rejects progress beyond the ordered quantity', async () => {
    const { product } = await setupProduct('Over');
    const { body } = await createMO({ product_item_id: product, qty_ordered: 2 });
    await ctx.api.post(`/api/job-orders/${body.id}/approve`).set(authHdr());
    await ctx.api.post(`/api/job-orders/warehouse-accept`).set(authHdr()).send({ job_order_ids: [body.id] });
    await ctx.api.post(`/api/job-orders/prepare`).set(authHdr()).send({ job_orders: [{ id: body.id }] });
    await ctx.api.post(`/api/job-orders/${body.id}/release`).set(authHdr());
    await ctx.api.post(`/api/job-orders/${body.id}/accept`).set(authHdr());
    const r = await ctx.api.post(`/api/job-orders/${body.id}/progress`).set(authHdr()).send({ done_delta: 3 });
    expect(r.status).toBe(400);
  });

  it('close (finish early) returns the unconsumed components', async () => {
    const { product, bolt, panel } = await setupProduct('Close', 100, 100);
    const { body } = await createMO({ product_item_id: product, qty_ordered: 10 }); // 20 bolts / 30 panels reserved
    await ctx.api.post(`/api/job-orders/${body.id}/approve`).set(authHdr());
    await ctx.api.post(`/api/job-orders/warehouse-accept`).set(authHdr()).send({ job_order_ids: [body.id] });
    await ctx.api.post(`/api/job-orders/prepare`).set(authHdr()).send({ job_orders: [{ id: body.id }] });
    await ctx.api.post(`/api/job-orders/${body.id}/release`).set(authHdr());
    await ctx.api.post(`/api/job-orders/${body.id}/accept`).set(authHdr());
    expect(await onHand(bolt)).toBe(80);

    await ctx.api.post(`/api/job-orders/${body.id}/progress`).set(authHdr()).send({ done_delta: 3 }); // uses 6 bolts / 9 panels
    const r = await ctx.api.post(`/api/job-orders/${body.id}/close`).set(authHdr());
    expect(r.body.job_order.status).toBe('completed');
    expect(await onHand(bolt)).toBe(94);   // 100 - 6 actually used
    expect(await onHand(panel)).toBe(91);  // 100 - 9
    await receiveAll(body.id); // closing early doesn't un-produce the 3 already built
    expect(await onHand(product)).toBe(3);
  });

  it('cancel after release returns everything not yet consumed', async () => {
    const { product, bolt } = await setupProduct('Cancel', 100, 100);
    const { body } = await createMO({ product_item_id: product, qty_ordered: 5 });
    await ctx.api.post(`/api/job-orders/${body.id}/approve`).set(authHdr());
    await ctx.api.post(`/api/job-orders/warehouse-accept`).set(authHdr()).send({ job_order_ids: [body.id] });
    await ctx.api.post(`/api/job-orders/prepare`).set(authHdr()).send({ job_orders: [{ id: body.id }] });
    await ctx.api.post(`/api/job-orders/${body.id}/release`).set(authHdr()); // -10 bolts
    await ctx.api.post(`/api/job-orders/${body.id}/accept`).set(authHdr());
    expect(await onHand(bolt)).toBe(90);

    const r = await ctx.api.post(`/api/job-orders/${body.id}/cancel`).set(authHdr());
    expect(r.body.job_order.status).toBe('cancelled');
    expect(await onHand(bolt)).toBe(100); // fully returned
  });

  it('pause / resume toggle status with no stock movement', async () => {
    const { product, bolt } = await setupProduct('Pause');
    const { body } = await createMO({ product_item_id: product, qty_ordered: 2 });
    await ctx.api.post(`/api/job-orders/${body.id}/approve`).set(authHdr());
    await ctx.api.post(`/api/job-orders/warehouse-accept`).set(authHdr()).send({ job_order_ids: [body.id] });
    await ctx.api.post(`/api/job-orders/prepare`).set(authHdr()).send({ job_orders: [{ id: body.id }] });
    await ctx.api.post(`/api/job-orders/${body.id}/release`).set(authHdr());
    await ctx.api.post(`/api/job-orders/${body.id}/accept`).set(authHdr());
    const before = await onHand(bolt);

    expect((await ctx.api.post(`/api/job-orders/${body.id}/pause`).set(authHdr())).body.job_order.status).toBe('paused');
    expect((await ctx.api.post(`/api/job-orders/${body.id}/resume`).set(authHdr())).body.job_order.status).toBe('in_progress');
    expect(await onHand(bolt)).toBe(before);
  });

  it('deletes a draft but not a released job order', async () => {
    const { product } = await setupProduct('Del');
    const a = await createMO({ product_item_id: product, qty_ordered: 1 });
    expect((await ctx.api.delete(`/api/job-orders/${a.body.id}`).set(authHdr())).status).toBe(200);

    const b = await createMO({ product_item_id: product, qty_ordered: 1 });
    await ctx.api.post(`/api/job-orders/${b.body.id}/approve`).set(authHdr());
    await ctx.api.post(`/api/job-orders/warehouse-accept`).set(authHdr()).send({ job_order_ids: [b.body.id] });
    await ctx.api.post(`/api/job-orders/prepare`).set(authHdr()).send({ job_orders: [{ id: b.body.id }] });
    await ctx.api.post(`/api/job-orders/${b.body.id}/release`).set(authHdr());
    await ctx.api.post(`/api/job-orders/${b.body.id}/accept`).set(authHdr());
    expect((await ctx.api.delete(`/api/job-orders/${b.body.id}`).set(authHdr())).status).toBe(409);
  });

  it('requires inventory.adjust to create a job order', async () => {
    const { product } = await setupProduct('RBAC');
    const acct = await createEmployee(ctx.api, token, { role: 'accounting', username: 'jo_acct' }); // no inventory.adjust
    const res = await ctx.api.post('/api/job-orders').set('Authorization', `Bearer ${acct.token}`)
      .send({ product_item_id: product, qty_ordered: 1 });
    expect(res.status).toBe(403);
  });
});

describe('job orders → manufacturing WIP in the GL (Phase 3b)', () => {
  const acctBalance = async (code: string): Promise<number> => {
    const tb = (await ctx.api.get('/api/accounting/ledger/reports/trial-balance').set(authHdr())).body;
    const row = tb.rows.find((r: { code: string }) => r.code === code);
    return row ? Math.round((row.debit - row.credit) * 100) / 100 : 0;
  };
  const joEntries = async (joId: number) => {
    const list = (await ctx.api.get('/api/accounting/ledger/journal-entries')
      .query({ source_type: 'job_order', source_id: joId }).set(authHdr())).body;
    const out = [];
    for (const e of list) out.push((await ctx.api.get(`/api/accounting/ledger/journal-entries/${e.id}`).set(authHdr())).body);
    return out;
  };
  /** A product: 2 bolts @ ₱5 + 3 panels @ ₱10 ⇒ ₱40 material cost per finished unit. */
  async function costedProduct(prefix: string) {
    const product = (await ctx.api.post('/api/inventory').set(authHdr()).send({ name: `${prefix} Product` })).body.id;
    const bolt = (await ctx.api.post('/api/inventory').set(authHdr()).send({ name: `${prefix} Bolt`, quantity: 200, unit_cost: 5 })).body.id;
    const panel = (await ctx.api.post('/api/inventory').set(authHdr()).send({ name: `${prefix} Panel`, quantity: 200, unit_cost: 10 })).body.id;
    await ctx.api.put(`/api/finished-products/${product}`).set(authHdr()).send({
      components: [{ component_item_id: bolt, quantity: 2 }, { component_item_id: panel, quantity: 3 }],
    });
    return { product, bolt, panel };
  }

  it('sets up the ledger and stores unit_cost on items', async () => {
    const s = await ctx.api.post('/api/accounting/ledger/setup').set(authHdr()).send({ fiscal_year_start: '2026-01-01' });
    expect(s.status).toBe(201);
    const it = (await ctx.api.post('/api/inventory').set(authHdr()).send({ name: 'Costed Widget', unit_cost: 12.5 })).body.id;
    expect((await ctx.api.get(`/api/inventory/${it}`).set(authHdr())).body.unit_cost).toBe(12.5);
  });

  it('release moves component cost from Inventory into Work in Process', async () => {
    const { product } = await costedProduct('WIP-A');
    const mo = await createMO({ product_item_id: product, qty_ordered: 10 }); // 20 bolts (₱100) + 30 panels (₱300) = ₱400
    await ctx.api.post(`/api/job-orders/${mo.body.id}/approve`).set(authHdr());
    await ctx.api.post(`/api/job-orders/warehouse-accept`).set(authHdr()).send({ job_order_ids: [mo.body.id] });
    await ctx.api.post(`/api/job-orders/prepare`).set(authHdr()).send({ job_orders: [{ id: mo.body.id }] });
    await ctx.api.post(`/api/job-orders/${mo.body.id}/release`).set(authHdr());
    await ctx.api.post(`/api/job-orders/${mo.body.id}/accept`).set(authHdr());

    const [entry] = await joEntries(mo.body.id);
    const byCode = Object.fromEntries(entry.lines.map((l: { account_code: string; debit: number; credit: number }) => [l.account_code, l]));
    expect(byCode['1152'].debit).toBe(400);  // Work in Process
    expect(byCode['1150'].credit).toBe(400); // Inventory
    const tb = (await ctx.api.get('/api/accounting/ledger/reports/trial-balance').set(authHdr())).body;
    expect(tb.balanced).toBe(true);
  });

  it('a fully-built job order relieves WIP into finished goods and leaves WIP flat', async () => {
    const wipBefore = await acctBalance('1152');
    const { product } = await costedProduct('WIP-B');
    const mo = await createMO({ product_item_id: product, qty_ordered: 5 }); // released value ₱200
    await ctx.api.post(`/api/job-orders/${mo.body.id}/approve`).set(authHdr());
    await ctx.api.post(`/api/job-orders/warehouse-accept`).set(authHdr()).send({ job_order_ids: [mo.body.id] });
    await ctx.api.post(`/api/job-orders/prepare`).set(authHdr()).send({ job_orders: [{ id: mo.body.id }] });
    await ctx.api.post(`/api/job-orders/${mo.body.id}/release`).set(authHdr());
    await ctx.api.post(`/api/job-orders/${mo.body.id}/accept`).set(authHdr());
    const done = await ctx.api.post(`/api/job-orders/${mo.body.id}/progress`).set(authHdr())
      .send({ done_delta: 5, scrapped_delta: 0 });
    expect(done.body.job_order.status).toBe('completed');
    await receiveAll(mo.body.id); // Products In is what actually posts the 'produce' GL entry now

    const entries = await joEntries(mo.body.id);
    const produce = entries.find((e) => /finished goods/i.test(e.memo));
    const pByCode = Object.fromEntries(produce.lines.map((l: { account_code: string; debit: number; credit: number }) => [l.account_code, l]));
    expect(pByCode['1150'].debit).toBe(200);  // Inventory (finished goods)
    expect(pByCode['1152'].credit).toBe(200); // Work in Process
    expect(await acctBalance('1152')).toBe(wipBefore); // WIP nets back to where it started
  });

  it('scrapped units settle their material cost to Manufacturing Variance', async () => {
    const varBefore = await acctBalance('5150');
    const { product } = await costedProduct('WIP-C');
    const mo = await createMO({ product_item_id: product, qty_ordered: 10 }); // released ₱400, ₱40/unit
    await ctx.api.post(`/api/job-orders/${mo.body.id}/approve`).set(authHdr());
    await ctx.api.post(`/api/job-orders/warehouse-accept`).set(authHdr()).send({ job_order_ids: [mo.body.id] });
    await ctx.api.post(`/api/job-orders/prepare`).set(authHdr()).send({ job_orders: [{ id: mo.body.id }] });
    await ctx.api.post(`/api/job-orders/${mo.body.id}/release`).set(authHdr());
    await ctx.api.post(`/api/job-orders/${mo.body.id}/accept`).set(authHdr());
    const r = await ctx.api.post(`/api/job-orders/${mo.body.id}/progress`).set(authHdr())
      .send({ done_delta: 8, scrapped_delta: 2 }); // 8 good (₱320), 2 scrapped (₱80)
    expect(r.body.job_order.status).toBe('completed');
    await receiveAll(mo.body.id); // settleJobOrderGl waits for this while the 8 good units are unreceived

    expect(await acctBalance('5150')).toBe(Math.round((varBefore + 80) * 100) / 100);
    const tb = (await ctx.api.get('/api/accounting/ledger/reports/trial-balance').set(authHdr())).body;
    expect(tb.balanced).toBe(true);
  });

  it('cancelling a released job order returns the whole WIP charge to Inventory', async () => {
    const { product } = await costedProduct('WIP-D');
    const mo = await createMO({ product_item_id: product, qty_ordered: 4 }); // released ₱160
    await ctx.api.post(`/api/job-orders/${mo.body.id}/approve`).set(authHdr());
    await ctx.api.post(`/api/job-orders/warehouse-accept`).set(authHdr()).send({ job_order_ids: [mo.body.id] });
    await ctx.api.post(`/api/job-orders/prepare`).set(authHdr()).send({ job_orders: [{ id: mo.body.id }] });
    await ctx.api.post(`/api/job-orders/${mo.body.id}/release`).set(authHdr());
    await ctx.api.post(`/api/job-orders/${mo.body.id}/accept`).set(authHdr());
    await ctx.api.post(`/api/job-orders/${mo.body.id}/cancel`).set(authHdr());

    const settle = (await joEntries(mo.body.id)).find((e) => /settled/i.test(e.memo));
    const byCode = Object.fromEntries(settle.lines.map((l: { account_code: string; debit: number; credit: number }) => [l.account_code, l]));
    expect(byCode['1150'].debit).toBe(160);  // back to Inventory
    expect(byCode['1152'].credit).toBe(160); // WIP cleared
  });
});

describe('job-type order <-> job_orders backlink', () => {
  it('GET /orders and /orders/:id surface the job_orders row "Start production" spawned', async () => {
    const { product } = await setupProduct('Backlink');
    const order = await ctx.api.post('/api/orders').set(authHdr())
      .send({ type: 'job', items: [{ name: 'Custom build', quantity: 1, unit_price: 500 }] });
    expect(order.body.number).toMatch(/^JO-\d{5}$/); // the order's own JO- number, distinct from the job_orders one below

    // Before "Start production": no backlink yet.
    const before = await ctx.api.get('/api/orders/' + order.body.id).set(authHdr());
    expect(before.body.job_order_id).toBeFalsy();

    const mo = await createMO({ product_item_id: product, qty_ordered: 3, order_id: order.body.id });
    expect(mo.status).toBe(201);

    const after = await ctx.api.get('/api/orders/' + order.body.id).set(authHdr());
    expect(after.body.job_order_id).toBe(mo.body.id);
    expect(after.body.job_order_number).toBe(mo.body.number);
    expect(after.body.job_order_status).toBe('draft');

    const list = await ctx.api.get('/api/orders?type=job').set(authHdr());
    const row = list.body.find((o: { id: number }) => o.id === order.body.id);
    expect(row.job_order_id).toBe(mo.body.id);

    // The reverse direction already worked before this change: job_orders itself carries
    // order_number back to the originating order.
    const joDetail = await ctx.api.get('/api/job-orders/' + mo.body.id).set(authHdr());
    expect(joDetail.body.order_number).toBe(order.body.number);
  });

  it('a job-type order with no production started yet has a null backlink', async () => {
    const order = await ctx.api.post('/api/orders').set(authHdr())
      .send({ type: 'job', items: [{ name: 'Not started', quantity: 1, unit_price: 100 }] });
    const detail = await ctx.api.get('/api/orders/' + order.body.id).set(authHdr());
    expect(detail.body.job_order_id).toBeFalsy();
    expect(detail.body.job_order_number).toBeFalsy();
  });
});
