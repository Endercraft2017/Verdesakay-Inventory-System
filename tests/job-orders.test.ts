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

  it('rejects a product that is not a finished product / has no BOM', async () => {
    const plain = await mkItem('Just An Item', 5);
    expect((await createMO({ product_item_id: plain, qty_ordered: 1 })).status).toBe(400);
  });

  it('lets a draft override planned quantities, but not after release', async () => {
    const { product, bolt } = await setupProduct('Override');
    const { body } = await createMO({ product_item_id: product, qty_ordered: 5 }); // bolt planned = 10

    const upd = await ctx.api.put(`/api/job-orders/${body.id}/components`).set(authHdr())
      .send({ components: [{ component_item_id: bolt, qty_planned: 14 }] });
    expect(upd.status).toBe(200);
    const jo = (await ctx.api.get(`/api/job-orders/${body.id}`).set(authHdr())).body;
    expect(jo.components.find((c: { component_item_id: number }) => c.component_item_id === bolt).qty_planned).toBe(14);

    await ctx.api.post(`/api/job-orders/${body.id}/release`).set(authHdr());
    const after = await ctx.api.put(`/api/job-orders/${body.id}/components`).set(authHdr())
      .send({ components: [{ component_item_id: bolt, qty_planned: 2 }] });
    expect(after.status).toBe(409);
  });

  it('release deducts planned components from the source location', async () => {
    const { product, bolt, panel } = await setupProduct('Release', 50, 50);
    const { body } = await createMO({ product_item_id: product, qty_ordered: 10 }); // 20 bolts, 30 panels

    const rel = await ctx.api.post(`/api/job-orders/${body.id}/release`).set(authHdr());
    expect(rel.status).toBe(200);
    expect(rel.body.job_order.status).toBe('released');
    expect(await onHand(bolt)).toBe(30);
    expect(await onHand(panel)).toBe(20);
  });

  it('release fails (no stock change) when a component is short', async () => {
    const { product, bolt } = await setupProduct('Short', 5, 100); // only 5 bolts, need 20
    const { body } = await createMO({ product_item_id: product, qty_ordered: 10 });
    const rel = await ctx.api.post(`/api/job-orders/${body.id}/release`).set(authHdr());
    expect(rel.status).toBe(400);
    expect(await onHand(bolt)).toBe(5); // untouched
  });

  it('progress consumes components, adds finished stock, and auto-completes', async () => {
    const { product, bolt, panel } = await setupProduct('Progress', 100, 100);
    const { body } = await createMO({ product_item_id: product, qty_ordered: 4 }); // 8 bolts, 12 panels
    await ctx.api.post(`/api/job-orders/${body.id}/release`).set(authHdr());

    let r = await ctx.api.post(`/api/job-orders/${body.id}/progress`).set(authHdr()).send({ done_delta: 3 });
    expect(r.status).toBe(200);
    expect(r.body.job_order.status).toBe('in_progress');
    expect(r.body.job_order.qty_done).toBe(3);
    expect(await onHand(product)).toBe(3); // 3 finished units in stock

    r = await ctx.api.post(`/api/job-orders/${body.id}/progress`).set(authHdr()).send({ done_delta: 1 });
    expect(r.body.job_order.status).toBe('completed'); // 4/4 accounted
    expect(await onHand(product)).toBe(4);
    // all reserved components consumed, none left to return
    expect(await onHand(bolt)).toBe(92);
    expect(await onHand(panel)).toBe(88);
  });

  it('rejects progress beyond the ordered quantity', async () => {
    const { product } = await setupProduct('Over');
    const { body } = await createMO({ product_item_id: product, qty_ordered: 2 });
    await ctx.api.post(`/api/job-orders/${body.id}/release`).set(authHdr());
    const r = await ctx.api.post(`/api/job-orders/${body.id}/progress`).set(authHdr()).send({ done_delta: 3 });
    expect(r.status).toBe(400);
  });

  it('close (finish early) returns the unconsumed components', async () => {
    const { product, bolt, panel } = await setupProduct('Close', 100, 100);
    const { body } = await createMO({ product_item_id: product, qty_ordered: 10 }); // 20 bolts / 30 panels reserved
    await ctx.api.post(`/api/job-orders/${body.id}/release`).set(authHdr());
    expect(await onHand(bolt)).toBe(80);

    await ctx.api.post(`/api/job-orders/${body.id}/progress`).set(authHdr()).send({ done_delta: 3 }); // uses 6 bolts / 9 panels
    const r = await ctx.api.post(`/api/job-orders/${body.id}/close`).set(authHdr());
    expect(r.body.job_order.status).toBe('completed');
    expect(await onHand(bolt)).toBe(94);   // 100 - 6 actually used
    expect(await onHand(panel)).toBe(91);  // 100 - 9
    expect(await onHand(product)).toBe(3);
  });

  it('cancel after release returns everything not yet consumed', async () => {
    const { product, bolt } = await setupProduct('Cancel', 100, 100);
    const { body } = await createMO({ product_item_id: product, qty_ordered: 5 });
    await ctx.api.post(`/api/job-orders/${body.id}/release`).set(authHdr()); // -10 bolts
    expect(await onHand(bolt)).toBe(90);

    const r = await ctx.api.post(`/api/job-orders/${body.id}/cancel`).set(authHdr());
    expect(r.body.job_order.status).toBe('cancelled');
    expect(await onHand(bolt)).toBe(100); // fully returned
  });

  it('pause / resume toggle status with no stock movement', async () => {
    const { product, bolt } = await setupProduct('Pause');
    const { body } = await createMO({ product_item_id: product, qty_ordered: 2 });
    await ctx.api.post(`/api/job-orders/${body.id}/release`).set(authHdr());
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
    await ctx.api.post(`/api/job-orders/${b.body.id}/release`).set(authHdr());
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
