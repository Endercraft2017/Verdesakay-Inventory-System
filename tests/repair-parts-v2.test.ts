/** Parts clerk repair-parts rules (mobile, Figma 83:*): request context, approved sources only,
 *  the exact-request rule (scanned SKU + picked quantity), live shortage, formal revisions that
 *  the proposing clerk can't approve, and the searchable history. Refusals move no stock. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, addSerializedUnits, type TestContext } from './helpers';

let ctx: TestContext;
let token: string;
let clerk: { id: number; token: string };
let qc: { id: number; token: string };
let jo: number;
let unit: number;
let part: number;
let alt: number;
let truck: number;
let wh: number;
const H = () => ({ Authorization: `Bearer ${token}` });
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const stockOf = async (item: number) => (await ctx.api.get(`/api/inventory/${item}`).set(H())).body.quantity as number;

beforeAll(async () => {
  ctx = await setupApp();
  token = await login(ctx.api);
  clerk = await createEmployee(ctx.api, token, { role: 'parts_clerk' });
  qc = await createEmployee(ctx.api, token, { role: 'qc_inspector' });
  wh = (await ctx.api.post('/api/locations').set(H()).send({ name: 'Parts Warehouse A-12', type: 'warehouse' })).body.id;
  truck = (await ctx.api.post('/api/locations').set(H()).send({ name: 'Van 3', type: 'truck' })).body.id;
  const product = (await ctx.api.post('/api/inventory').set(H()).send({ name: 'Bike RP', quantity: 0 })).body.id;
  const frame = (await ctx.api.post('/api/inventory').set(H()).send({ name: 'Frame RP', quantity: 100 })).body.id;
  part = (await ctx.api.post('/api/inventory').set(H()).send({ name: 'Left signal assembly', sku: 'SIG-L-60V-K4', quantity: 0 })).body.id;
  alt = (await ctx.api.post('/api/inventory').set(H()).send({ name: 'Left signal assembly B', sku: 'SIG-L-60V-K4B', quantity: 0 })).body.id;
  await ctx.api.post(`/api/inventory/${part}/adjust`).set(H()).send({ change: 6, location_id: wh, reason: 'stock' });
  await ctx.api.post(`/api/inventory/${part}/adjust`).set(H()).send({ change: 2, location_id: truck, reason: 'stock' });
  await ctx.api.put(`/api/finished-products/${product}`).set(H()).send({ components: [{ component_item_id: frame, quantity: 1 }] });
  jo = (await ctx.api.post('/api/job-orders').set(H()).send({ product_item_id: product, qty_ordered: 2, qc_stages: 1 })).body.id;
  await ctx.api.post(`/api/job-orders/${jo}/approve`).set(H());
  await ctx.api.post('/api/job-orders/warehouse-accept').set(H()).send({ job_order_ids: [jo] });
  await ctx.api.post('/api/job-orders/prepare').set(H()).send({ job_orders: [{ id: jo }] });
  await ctx.api.post(`/api/job-orders/${jo}/release`).set(H());
  await ctx.api.post(`/api/job-orders/${jo}/accept`).set(H()).send({});
  [unit] = await addSerializedUnits(ctx.api, token, jo, 1, 'RP');
  await ctx.api.post(`/api/job-orders/${jo}/units/inspect`).set(H()).send({ unit_ids: [unit], result: 'fail', disposition: 'repair',
    remarks: 'Intermittent signal failure', repair: { category: 'Electrical · signal system', station: 'Wiring', priority: 'Urgent' } });
});
afterAll(() => cleanup(ctx));

const raise = async (quantity = 1, item = part) =>
  (await ctx.api.post(`/api/production/units/${unit}/repairs`).set(bearer(qc.token)).send({ kind: 'replace', component_item_id: item, quantity, fault: 'production' })).body.id as number;

describe('repair request context and issue rules', () => {
  it('shows the source inspection, duplicates and stock per approved source', async () => {
    const a = await raise();
    const b = await raise();
    const c = await ctx.api.get(`/api/production/repairs/${b}/context`).set(bearer(clerk.token));
    expect(c.status).toBe(200);
    expect(c.body.inspection).toMatchObject({ station: 'Wiring', priority: 'Urgent', remarks: 'Intermittent signal failure' });
    expect(c.body.duplicates.map((d: { id: number }) => d.id)).toEqual([a]);
    expect(c.body.sources.find((x: { id: number }) => x.id === wh)).toMatchObject({ available: 6, approved: true });
    expect(c.body.sources.find((x: { id: number }) => x.id === truck)).toMatchObject({ available: 2, approved: false });
    expect(c.body.shortage).toBe(false);
    await ctx.api.post(`/api/production/repairs/${b}/reject`).set(bearer(clerk.token)).send({ warehouse_remarks: 'Duplicate / invalid request — another request covers it' });
    // a stays open for the issue test below
    const before = await stockOf(part);
    const fromTruck = await ctx.api.post(`/api/production/repairs/${a}/accept`).set(bearer(clerk.token)).send({ from_location_id: truck });
    expect(fromTruck.body.blocked).toBe('source');
    const wrongSku = await ctx.api.post(`/api/production/repairs/${a}/accept`).set(bearer(clerk.token)).send({ from_location_id: wh, scanned_code: 'SIG-L-60V-K4B', picked_quantity: 1 });
    expect(wrongSku.body.blocked).toBe('sku');
    const tooMany = await ctx.api.post(`/api/production/repairs/${a}/accept`).set(bearer(clerk.token)).send({ from_location_id: wh, scanned_code: 'sig-l-60v-k4', picked_quantity: 2 });
    expect(tooMany.body.blocked).toBe('quantity');
    expect(await stockOf(part)).toBe(before);
    const ok = await ctx.api.post(`/api/production/repairs/${a}/accept`).set(bearer(clerk.token)).send({ from_location_id: wh, scanned_code: 'SIG-L-60V-K4', picked_quantity: 1 });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('accepted');
    expect(await stockOf(part)).toBe(before - 1);
  });

  it('flags a live shortage and records the escalation without moving stock', async () => {
    const id = await raise(9);
    const c = await ctx.api.get(`/api/production/repairs/${id}/context`).set(bearer(clerk.token));
    expect(c.body.shortage).toBe(true);
    expect((await ctx.api.post(`/api/production/repairs/${id}/shortage`).set(bearer(clerk.token)).send({ note: 'Wait for replenishment' })).status).toBe(201);
    const after = await ctx.api.get(`/api/production/repairs/${id}/context`).set(bearer(clerk.token));
    expect(after.body.events.map((e: { kind: string }) => e.kind)).toEqual(['shortage']);
    const hist = await ctx.api.get('/api/production/repair-history?state=blocked').set(bearer(clerk.token));
    expect(hist.body.rows.map((r: { id: number }) => r.id)).toContain(id);
    expect(hist.body.counts.issued).toBeGreaterThanOrEqual(1);
    await ctx.api.post(`/api/production/repairs/${id}/reject`).set(bearer(clerk.token)).send({ warehouse_remarks: 'cleanup' });
  });

  it('needs someone other than the proposing clerk to approve a revision, and blocks issue meanwhile', async () => {
    const id = await raise(1);
    const rev = await ctx.api.post(`/api/production/repairs/${id}/revision`).set(bearer(clerk.token))
      .send({ component_item_id: alt, quantity: 1, reason: 'Original SKU unavailable; compatible revision proposed' });
    expect(rev.status).toBe(201);
    expect((await ctx.api.post(`/api/production/repairs/${id}/accept`).set(bearer(clerk.token)).send({ from_location_id: wh })).body.blocked).toBe('revision');
    expect((await ctx.api.post(`/api/production/repairs/${id}/revision/decide`).set(bearer(clerk.token)).send({ approve: true })).status).toBe(403);
    const ok = await ctx.api.post(`/api/production/repairs/${id}/revision/decide`).set(bearer(qc.token)).send({ approve: true, note: 'OK' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ component_item_id: alt, component_name: 'Left signal assembly B' });
  });
});
