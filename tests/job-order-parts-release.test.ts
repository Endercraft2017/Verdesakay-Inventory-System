/** Job-order parts release, warehouse side (SCHEMA_VERSION 50): approve → warehouse-accept
 *  → prepare (one kit or several at once, with a consolidated pick list) → release, which
 *  issues the parts release slip (PRS-#####) and is when stock leaves. Plus the line lead's
 *  floor tools: pause with a reason (production.pause) and production issue reports. */
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
const qtyOf = async (id: number) => (await ctx.api.get(`/api/inventory/${id}`).set(H())).body.quantity as number;

/** An approved draft building `qty` of a product that uses 2 × `part` each. */
async function approvedMO(product: number, qty: number, qc_stages = 0) {
  const mo = (await ctx.api.post('/api/job-orders').set(H())
    .send({ product_item_id: product, qty_ordered: qty, qc_stages })).body.id as number;
  await ctx.api.post(`/api/job-orders/${mo}/approve`).set(H());
  return mo;
}
async function productWithPart(prefix: string, partStock: number) {
  const product = await mkItem(`${prefix} Product`);
  const part = await mkItem(`${prefix} Part`, partStock);
  await ctx.api.put(`/api/finished-products/${product}`).set(H()).send({ components: [{ component_item_id: part, quantity: 2 }] });
  return { product, part };
}

describe('warehouse accept → prepare → release slip', () => {
  it('walks one job order through and issues a slip that deducts stock', async () => {
    const { product, part } = await productWithPart('PRS1', 50);
    const mo = await approvedMO(product, 5); // needs 10 parts

    let r = await ctx.api.post(`/api/job-orders/${mo}/release`).set(H());
    expect(r.status).toBe(409);
    expect(r.body.needs_warehouse_accept).toBe(true);

    // Can't prepare before accepting.
    expect((await ctx.api.post('/api/job-orders/prepare').set(H()).send({ job_orders: [{ id: mo }] })).status).toBe(409);

    r = await ctx.api.post('/api/job-orders/warehouse-accept').set(H()).send({ job_order_ids: [mo] });
    expect(r.status).toBe(200);
    expect(r.body.job_orders[0].warehouse_accepted_at).toBeTruthy();

    r = await ctx.api.post(`/api/job-orders/${mo}/release`).set(H());
    expect(r.body.needs_prepare).toBe(true);

    // Partial pick: saved, but not prepared yet.
    r = await ctx.api.post('/api/job-orders/prepare').set(H())
      .send({ job_orders: [{ id: mo, lines: [{ component_item_id: part, qty_picked: 6 }] }] });
    expect(r.status).toBe(200);
    expect(r.body.job_orders[0].prepared_at).toBeNull();
    expect(r.body.job_orders[0].components[0].qty_picked).toBe(6);
    expect(await qtyOf(part)).toBe(50); // picking doesn't move stock

    r = await ctx.api.post('/api/job-orders/prepare').set(H()).send({ job_orders: [{ id: mo }] });
    expect(r.body.job_orders[0].prepared_at).toBeTruthy();

    r = await ctx.api.post(`/api/job-orders/${mo}/release`).set(H()).send({ received_by: 'Line 2 lead', notes: 'kit in blue bin' });
    expect(r.status).toBe(200);
    expect(r.body.slip.number).toMatch(/^PRS-\d+/);
    expect(r.body.job_order.status).toBe('released');
    expect(r.body.job_order.parts_slip_number).toBe(r.body.slip.number);
    expect(await qtyOf(part)).toBe(40);

    const slip = (await ctx.api.get(`/api/parts-slips/${r.body.slip.id}`).set(H())).body;
    expect(slip).toMatchObject({ job_order_id: mo, received_by: 'Line 2 lead', notes: 'kit in blue bin' });
    expect(slip.items).toEqual([expect.objectContaining({ component_item_id: part, quantity: 10 })]);

    const list = (await ctx.api.get(`/api/parts-slips?job_order_id=${mo}`).set(H())).body;
    expect(list).toHaveLength(1);

    const print = await ctx.api.get(`/api/parts-slips/${r.body.slip.id}/print`).set(H());
    expect(print.status).toBe(200);
    expect(print.headers['content-type']).toMatch(/html/);
    expect(print.text).toContain(r.body.slip.number);

    // Kit photo on the slip.
    const photo = await ctx.api.post('/api/attachments').set(H())
      .field('kind', 'parts_release').field('ref_id', String(r.body.slip.id)).attach('image', Buffer.from('kit'), 'kit.png');
    expect(photo.status).toBe(201);
  });

  it('prepares several job orders at once, with a consolidated pick list', async () => {
    const { product, part } = await productWithPart('PRSMulti', 100);
    const a = await approvedMO(product, 3); // 6 parts
    const b = await approvedMO(product, 4); // 8 parts
    await ctx.api.post('/api/job-orders/warehouse-accept').set(H()).send({ job_order_ids: [a, b] });

    const pl = (await ctx.api.get(`/api/job-orders/pick-list?ids=${a},${b}`).set(H())).body;
    expect(pl.job_orders).toHaveLength(2);
    expect(pl.lines).toHaveLength(1);
    expect(pl.lines[0]).toMatchObject({ component_item_id: part, need: 14, picked: 0, on_hand: 100 });
    expect(pl.lines[0].job_orders).toHaveLength(2);
    const html = await ctx.api.get(`/api/job-orders/pick-list?ids=${a},${b}&format=html`).set(H());
    expect(html.headers['content-type']).toMatch(/html/);

    const r = await ctx.api.post('/api/job-orders/prepare').set(H()).send({ job_orders: [{ id: a }, { id: b }] });
    expect(r.status).toBe(200);
    expect(r.body.job_orders.every((j: { prepared_at: string | null }) => !!j.prepared_at)).toBe(true);

    const ready = (await ctx.api.get('/api/job-orders?stage=ready_to_release').set(H())).body.map((j: { id: number }) => j.id);
    expect(ready).toEqual(expect.arrayContaining([a, b]));
  });

  it("refuses to pick stock that another kit has already set aside", async () => {
    const { product } = await productWithPart('PRSClash', 10);
    const a = await approvedMO(product, 4); // 8 of 10
    const b = await approvedMO(product, 2); // 4 more — only 2 left
    await ctx.api.post('/api/job-orders/warehouse-accept').set(H()).send({ job_order_ids: [a, b] });
    expect((await ctx.api.post('/api/job-orders/prepare').set(H()).send({ job_orders: [{ id: a }] })).status).toBe(200);
    const r = await ctx.api.post('/api/job-orders/prepare').set(H()).send({ job_orders: [{ id: b }] });
    expect(r.status).toBe(400);
    expect(r.body.shortfalls[0]).toMatchObject({ picking: 4, available: 2 });
  });

  it('editing the draft sends it back through approval and clears the picks', async () => {
    const { product } = await productWithPart('PRSReset', 100);
    const mo = await approvedMO(product, 2);
    await ctx.api.post('/api/job-orders/warehouse-accept').set(H()).send({ job_order_ids: [mo] });
    await ctx.api.post('/api/job-orders/prepare').set(H()).send({ job_orders: [{ id: mo }] });
    await ctx.api.put(`/api/job-orders/${mo}`).set(H()).send({ qty_ordered: 3 });
    const jo = (await ctx.api.get(`/api/job-orders/${mo}`).set(H())).body;
    expect(jo).toMatchObject({ approved_at: null, warehouse_accepted_at: null, prepared_at: null });
    expect(jo.components[0].qty_picked).toBe(0);
  });

  it('refuses to accept an unapproved draft', async () => {
    const { product } = await productWithPart('PRSNoApv', 10);
    const mo = (await ctx.api.post('/api/job-orders').set(H()).send({ product_item_id: product, qty_ordered: 1 })).body.id;
    const r = await ctx.api.post('/api/job-orders/warehouse-accept').set(H()).send({ job_order_ids: [mo] });
    expect(r.status).toBe(409);
  });
});

describe('pause / resume', () => {
  async function runningMO(prefix: string) {
    const { product } = await productWithPart(prefix, 100);
    const mo = await approvedMO(product, 2);
    await ctx.api.post('/api/job-orders/warehouse-accept').set(H()).send({ job_order_ids: [mo] });
    await ctx.api.post('/api/job-orders/prepare').set(H()).send({ job_orders: [{ id: mo }] });
    await ctx.api.post(`/api/job-orders/${mo}/release`).set(H());
    return mo;
  }

  it('records who paused and why, and clears it on resume', async () => {
    const mo = await runningMO('Pause1');
    let r = await ctx.api.post(`/api/job-orders/${mo}/pause`).set(H()).send({ reason: 'Rush order JO for Client X first' });
    expect(r.status).toBe(200);
    expect(r.body.job_order).toMatchObject({ status: 'paused', pause_reason: 'Rush order JO for Client X first' });
    expect(r.body.job_order.paused_by_name).toBeTruthy();
    r = await ctx.api.post(`/api/job-orders/${mo}/resume`).set(H());
    expect(r.body.job_order).toMatchObject({ status: 'in_progress', pause_reason: null, paused_at: null });
  });

  it('a line lead needs production.pause to hold the line', async () => {
    const mo = await runningMO('Pause2');
    const lead = await createEmployee(ctx.api, token, { role: 'production_lead' });
    expect((await ctx.api.post(`/api/job-orders/${mo}/pause`).set(bearer(lead.token))).status).toBe(403);
    await ctx.api.put(`/api/users/${lead.id}/permissions`).set(H()).send({ overrides: { 'production.pause': true } });
    expect((await ctx.api.post(`/api/job-orders/${mo}/pause`).set(bearer(lead.token))).status).toBe(200);
    expect((await ctx.api.post(`/api/job-orders/${mo}/resume`).set(bearer(lead.token))).status).toBe(200);
  });
});

describe('production issue reports', () => {
  it('files per job order or per unit, edits while open, resolves and re-opens', async () => {
    const { product } = await productWithPart('Issue1', 100);
    const mo = await approvedMO(product, 2, 1);
    await ctx.api.post('/api/job-orders/warehouse-accept').set(H()).send({ job_order_ids: [mo] });
    await ctx.api.post('/api/job-orders/prepare').set(H()).send({ job_orders: [{ id: mo }] });
    await ctx.api.post(`/api/job-orders/${mo}/release`).set(H());
    await ctx.api.post(`/api/job-orders/${mo}/accept`).set(H());
    const unit = (await ctx.api.post(`/api/job-orders/${mo}/units`).set(H())
      .field('identifier', 'ISS-U1').attach('image', Buffer.from('p'), 'u.png')).body.id;

    const lead = await createEmployee(ctx.api, token, { role: 'production_lead' });
    const whole = await ctx.api.post('/api/production-issues').set(bearer(lead.token))
      .send({ job_order_id: mo, category: 'Machine / equipment', severity: 'high', description: 'Press 2 jammed' });
    expect(whole.status).toBe(201);
    expect(whole.body).toMatchObject({ job_order_id: mo, unit_id: null, status: 'open', severity: 'high' });

    const perUnit = await ctx.api.post('/api/production-issues').set(bearer(lead.token))
      .send({ job_order_id: mo, unit_id: unit, category: 'Defect', description: 'Scratch on housing' });
    expect(perUnit.body.unit_identifier).toBe('ISS-U1');

    const edited = await ctx.api.put(`/api/production-issues/${whole.body.id}`).set(bearer(lead.token))
      .send({ description: 'Press 2 jammed — tech on the way', severity: 'critical' });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ description: 'Press 2 jammed — tech on the way', severity: 'critical' });

    // Another floor worker can't edit the lead's report.
    const qc = await createEmployee(ctx.api, token, { role: 'qc_inspector' });
    expect((await ctx.api.put(`/api/production-issues/${whole.body.id}`).set(bearer(qc.token)).send({ description: 'x' })).status).toBe(403);

    const jo = (await ctx.api.get(`/api/job-orders/${mo}`).set(H())).body;
    expect(jo.open_issues).toBe(2);

    const res = await ctx.api.post(`/api/production-issues/${whole.body.id}/resolve`).set(bearer(lead.token)).send({ resolution: 'Fixed' });
    expect(res.body).toMatchObject({ status: 'resolved', resolution: 'Fixed' });
    expect((await ctx.api.put(`/api/production-issues/${whole.body.id}`).set(bearer(lead.token)).send({ description: 'y' })).status).toBe(409);
    expect((await ctx.api.post(`/api/production-issues/${whole.body.id}/reopen`).set(H())).body.status).toBe('open');

    const forUnit = (await ctx.api.get(`/api/production-issues?unit_id=${unit}`).set(H())).body;
    expect(forUnit).toHaveLength(1);

    const photo = await ctx.api.post('/api/attachments').set(bearer(lead.token))
      .field('kind', 'production_issue').field('ref_id', String(perUnit.body.id)).attach('image', Buffer.from('p'), 'i.png');
    expect(photo.status).toBe(201);
  });

  it("rejects a unit from a different job order", async () => {
    const { product } = await productWithPart('Issue2', 100);
    const mo = await approvedMO(product, 1);
    const r = await ctx.api.post('/api/production-issues').set(H())
      .send({ job_order_id: mo, unit_id: 999999, category: 'Other', description: 'x' });
    expect(r.status).toBe(400);
  });
});
