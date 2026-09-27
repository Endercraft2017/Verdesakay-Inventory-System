/** Job-order approval + pre-release stock check (SCHEMA_VERSION 49). A production.approve
 *  holder signs off the draft (POST /:id/approve) before the warehouse may /release its parts;
 *  editing the draft clears the approval. GET /:id/availability is the stock check. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';

let ctx: TestContext;
let token: string;
const H = () => ({ Authorization: `Bearer ${token}` });
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  ctx = await setupApp();
  token = await login(ctx.api);
});
afterAll(() => cleanup(ctx));

const mkItem = async (name: string, quantity = 0) =>
  (await ctx.api.post('/api/inventory').set(H()).send({ name, quantity })).body.id as number;

async function draftMO(prefix: string, qty: number, partStock: number) {
  const product = await mkItem(`${prefix} Product`);
  const part = await mkItem(`${prefix} Part`, partStock);
  await ctx.api.put(`/api/finished-products/${product}`).set(H()).send({
    components: [{ component_item_id: part, quantity: 2 }],
  });
  const mo = (await ctx.api.post('/api/job-orders').set(H())
    .send({ product_item_id: product, qty_ordered: qty })).body.id as number;
  return { mo, part };
}

describe('job-order approval', () => {
  it('refuses release until approved, then releases', async () => {
    const { mo } = await draftMO('Apv', 3, 100);
    const early = await ctx.api.post(`/api/job-orders/${mo}/release`).set(H());
    expect(early.status).toBe(409);
    expect(early.body.needs_approval).toBe(true);

    const apv = await ctx.api.post(`/api/job-orders/${mo}/approve`).set(H()).send({ notes: 'go' });
    expect(apv.status).toBe(200);
    expect(apv.body.job_order.approved_at).toBeTruthy();
    expect(apv.body.job_order.approved_by_name).toBeTruthy();
    expect(apv.body.job_order.approve_notes).toBe('go');
    expect(apv.body.job_order.status).toBe('draft');
    expect(apv.body.shortfalls).toEqual([]);

    expect((await ctx.api.post(`/api/job-orders/${mo}/approve`).set(H())).status).toBe(409);
    await ctx.api.post('/api/job-orders/warehouse-accept').set(H()).send({ job_order_ids: [mo] });
    await ctx.api.post('/api/job-orders/prepare').set(H()).send({ job_orders: [{ id: mo }] });
    expect((await ctx.api.post(`/api/job-orders/${mo}/release`).set(H())).status).toBe(200);
    // Past draft: can't approve or withdraw any more.
    expect((await ctx.api.post(`/api/job-orders/${mo}/unapprove`).set(H())).status).toBe(409);
  });

  it('clears the approval when the draft or its components are edited', async () => {
    const { mo, part } = await draftMO('ApvEdit', 2, 100);
    await ctx.api.post(`/api/job-orders/${mo}/approve`).set(H());
    await ctx.api.put(`/api/job-orders/${mo}`).set(H()).send({ qty_ordered: 4 });
    let jo = (await ctx.api.get(`/api/job-orders/${mo}`).set(H())).body;
    expect(jo.approved_at).toBeNull();

    await ctx.api.post(`/api/job-orders/${mo}/approve`).set(H());
    await ctx.api.put(`/api/job-orders/${mo}/components`).set(H())
      .send({ components: [{ component_item_id: part, qty_planned: 9 }] });
    jo = (await ctx.api.get(`/api/job-orders/${mo}`).set(H())).body;
    expect(jo.approved_at).toBeNull();
  });

  it('withdraws an approval', async () => {
    const { mo } = await draftMO('ApvUndo', 1, 100);
    await ctx.api.post(`/api/job-orders/${mo}/approve`).set(H());
    const un = await ctx.api.post(`/api/job-orders/${mo}/unapprove`).set(H());
    expect(un.status).toBe(200);
    expect(un.body.job_order.approved_at).toBeNull();
    expect((await ctx.api.post(`/api/job-orders/${mo}/release`).set(H())).status).toBe(409);
  });

  it('is its own permission — inventory.adjust (warehouse) cannot approve', async () => {
    const { mo } = await draftMO('ApvPerm', 1, 100);
    const wh = await createEmployee(ctx.api, token, { role: 'warehouse' });
    expect((await ctx.api.post(`/api/job-orders/${mo}/approve`).set(bearer(wh.token))).status).toBe(403);
    // ...but the warehouse releases once a manager has approved.
    await ctx.api.post(`/api/job-orders/${mo}/approve`).set(H());
    await ctx.api.post('/api/job-orders/warehouse-accept').set(bearer(wh.token)).send({ job_order_ids: [mo] });
    await ctx.api.post('/api/job-orders/prepare').set(bearer(wh.token)).send({ job_orders: [{ id: mo }] });
    expect((await ctx.api.post(`/api/job-orders/${mo}/release`).set(bearer(wh.token))).status).toBe(200);
  });

  it('lists the approval and release queues', async () => {
    const { mo: waiting } = await draftMO('ApvQ1', 1, 100);
    const { mo: ready } = await draftMO('ApvQ2', 1, 100);
    await ctx.api.post(`/api/job-orders/${ready}/approve`).set(H());
    const a = (await ctx.api.get('/api/job-orders?stage=awaiting_approval').set(H())).body as { id: number }[];
    const r = (await ctx.api.get('/api/job-orders?stage=awaiting_release').set(H())).body as { id: number }[];
    expect(a.map((x) => x.id)).toContain(waiting);
    expect(a.map((x) => x.id)).not.toContain(ready);
    expect(r.map((x) => x.id)).toContain(ready);
    expect(r.map((x) => x.id)).not.toContain(waiting);
  });
});

describe('GET /api/job-orders/:id/availability', () => {
  it('reports each component need vs on-hand and whether it can be released', async () => {
    const { mo, part } = await draftMO('Avail', 5, 6); // needs 10, has 6
    let av = (await ctx.api.get(`/api/job-orders/${mo}/availability`).set(H())).body;
    expect(av.lines).toEqual([expect.objectContaining({ component_item_id: part, need: 10, have: 6, short: 4 })]);
    expect(av.shortfalls).toHaveLength(1);
    expect(av.in_stock).toBe(false);
    expect(av.approved).toBe(false);
    expect(av.releasable).toBe(false);

    // Short stock doesn't block approval — it comes back as a warning.
    const apv = await ctx.api.post(`/api/job-orders/${mo}/approve`).set(H());
    expect(apv.status).toBe(200);
    expect(apv.body.shortfalls).toHaveLength(1);

    await ctx.api.post(`/api/inventory/${part}/adjust`).set(H()).send({ change: 4, reason: 'restock' });
    av = (await ctx.api.get(`/api/job-orders/${mo}/availability`).set(H())).body;
    expect(av.in_stock).toBe(true);
    expect(av.releasable).toBe(false); // warehouse hasn't accepted / picked yet
    await ctx.api.post('/api/job-orders/warehouse-accept').set(H()).send({ job_order_ids: [mo] });
    await ctx.api.post('/api/job-orders/prepare').set(H()).send({ job_orders: [{ id: mo }] });
    av = (await ctx.api.get(`/api/job-orders/${mo}/availability`).set(H())).body;
    expect(av).toMatchObject({ warehouse_accepted: true, prepared: true, releasable: true });
  });

  it('404s for an unknown job order', async () => {
    expect((await ctx.api.get('/api/job-orders/999999/availability').set(H())).status).toBe(404);
  });
});
