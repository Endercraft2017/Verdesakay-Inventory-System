/** POST /api/job-orders/:id/units — add one serialized unit "off the line" with its
 *  identifier captured at creation (required). Complements jobOrderProgressSchema's bulk
 *  done_delta, which now refuses to run for serialized (qc_stages > 0) job orders — see
 *  job-orders.routes.ts. The required photo travels as a separate POST /api/attachments
 *  call (kind: 'qc_unit'); attachments.test.ts covers that route's own contract, the
 *  "full sequence" test below covers the two calls working together end to end. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';

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

const mkItem = async (name: string, quantity = 0) =>
  (await ctx.api.post('/api/inventory').set(H()).send({ name, quantity })).body.id as number;

/** A released job order for a fresh product with plenty of component stock. */
async function releasedMO(prefix: string, qty: number, qc_stages: number) {
  const product = await mkItem(`${prefix} Product`);
  const part = await mkItem(`${prefix} Part`, 1000);
  await ctx.api.put(`/api/finished-products/${product}`).set(H()).send({
    components: [{ component_item_id: part, quantity: 1 }],
  });
  const mo = (await ctx.api.post('/api/job-orders').set(H())
    .send({ product_item_id: product, qty_ordered: qty, qc_stages })).body.id;
  await ctx.api.post(`/api/job-orders/${mo}/approve`).set(H());
  await ctx.api.post(`/api/job-orders/warehouse-accept`).set(H()).send({ job_order_ids: [mo] });
  await ctx.api.post(`/api/job-orders/prepare`).set(H()).send({ job_orders: [{ id: mo }] });
  await ctx.api.post(`/api/job-orders/${mo}/release`).set(H());
  await ctx.api.post(`/api/job-orders/${mo}/accept`).set(H());
  return { mo, product };
}

describe('POST /api/job-orders/:id/units', () => {
  it('adds one unit with its identifier, consumes components, and counts toward the ordered qty', async () => {
    const { mo } = await releasedMO('AddUnit', 3, 1);
    const r = await ctx.api.post(`/api/job-orders/${mo}/units`).set(H()).field('identifier', 'MTR-0001').attach('image', Buffer.from('unit-photo'), 'unit.png');
    expect(r.status).toBe(201);
    expect(r.body.job_order.status).toBe('in_progress');

    const units = (await ctx.api.get(`/api/job-orders/${mo}/units`).set(H())).body;
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ identifier: 'MTR-0001', status: 'pending' });

    const jo = (await ctx.api.get(`/api/job-orders/${mo}`).set(H())).body;
    expect(jo.components[0].qty_consumed).toBe(1);
  });

  it('replays an uncertain unit upload without creating a second unit, photo, or component use', async () => {
    const { mo } = await releasedMO('AddUnitRetry', 3, 1);
    const path = `/api/job-orders/${mo}/units`;
    const key = 'production-unit-retry-001';
    const first = await ctx.api.post(path).set({ ...H(), 'Idempotency-Key': key })
      .field('identifier', 'RETRY-1').attach('image', PNG, 'unit.png');
    expect(first.status).toBe(201);
    const replay = await ctx.api.post(path).set({ ...H(), 'Idempotency-Key': key })
      .field('identifier', 'RETRY-1').attach('image', PNG, 'unit.png');
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.body.id).toBe(first.body.id);
    expect((await ctx.api.get(`${path}`).set(H())).body).toHaveLength(1);
    expect((await ctx.api.get(`/api/attachments?kind=qc_unit&ref_id=${first.body.id}`).set(H())).body).toHaveLength(1);
    expect((await ctx.api.get(`/api/job-orders/${mo}`).set(H())).body.components[0].qty_consumed).toBe(1);
  });

  it('requires a non-empty identifier', async () => {
    const { mo } = await releasedMO('AddUnitNoId', 2, 1);
    const r = await ctx.api.post(`/api/job-orders/${mo}/units`).set(H()).field('identifier', '  ').attach('image', Buffer.from('unit-photo'), 'unit.png');
    expect(r.status).toBe(400);
  });

  it('refuses on a non-serialized (qc_stages = 0) job order', async () => {
    const { mo } = await releasedMO('AddUnitBatch', 2, 0);
    const r = await ctx.api.post(`/api/job-orders/${mo}/units`).set(H()).field('identifier', 'X').attach('image', Buffer.from('unit-photo'), 'unit.png');
    expect(r.status).toBe(400);
  });

  it('refuses once every ordered unit is accounted for', async () => {
    const { mo } = await releasedMO('AddUnitCap', 1, 1);
    const ok = await ctx.api.post(`/api/job-orders/${mo}/units`).set(H()).field('identifier', 'CAP-1').attach('image', Buffer.from('unit-photo'), 'unit.png');
    expect(ok.status).toBe(201);
    const over = await ctx.api.post(`/api/job-orders/${mo}/units`).set(H()).field('identifier', 'CAP-2').attach('image', Buffer.from('unit-photo'), 'unit.png');
    expect(over.status).toBe(400);
  });

  it("bulk done_delta on /progress now refuses for a serialized job order, pointing at /units instead", async () => {
    const { mo } = await releasedMO('AddUnitBulkBlock', 3, 1);
    const r = await ctx.api.post(`/api/job-orders/${mo}/progress`).set(H()).send({ done_delta: 2 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Add unit/);
  });

  it('needs inventory.adjust, not just inventory.view', async () => {
    const { mo } = await releasedMO('AddUnitPerm', 2, 1);
    const viewer = await createEmployee(ctx.api, token, { role: 'csr' });
    const r = await ctx.api.post(`/api/job-orders/${mo}/units`).set(bearer(viewer.token)).field('identifier', 'X').attach('image', Buffer.from('unit-photo'), 'unit.png');
    expect(r.status).toBe(403);
  });

  it('groups units under a shared batch_label, one call per unit', async () => {
    const { mo } = await releasedMO('AddUnitBatchLabel', 3, 1);
    const a = await ctx.api.post(`/api/job-orders/${mo}/units`).set(H()).field('identifier', 'RUN-A').field('batch_label', 'RUN-7').attach('image', Buffer.from('unit-photo'), 'unit.png');
    const b = await ctx.api.post(`/api/job-orders/${mo}/units`).set(H()).field('identifier', 'RUN-B').field('batch_label', 'RUN-7').attach('image', Buffer.from('unit-photo'), 'unit.png');
    const c = await ctx.api.post(`/api/job-orders/${mo}/units`).set(H()).field('identifier', 'RUN-C').attach('image', Buffer.from('unit-photo'), 'unit.png'); // no label
    expect([a.status, b.status, c.status]).toEqual([201, 201, 201]);

    const batches = (await ctx.api.get(`/api/production/batches?job_order=${mo}`).set(H())).body;
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ identifier: 'RUN-7', qty: 2, status: 'open' });

    const units = (await ctx.api.get(`/api/job-orders/${mo}/units`).set(H())).body as Array<{ identifier: string; batch_id: number | null }>;
    expect(units.filter((u) => u.batch_id === batches[0].id)).toHaveLength(2);
    expect(units.find((u) => u.identifier === 'RUN-C')!.batch_id).toBeNull();
  });

  it('saves the photo with the unit in the same request (kind: qc_unit)', async () => {
    const { mo } = await releasedMO('AddUnitPhoto', 1, 1);
    const added = await ctx.api.post(`/api/job-orders/${mo}/units`).set(H()).field('identifier', 'PHOTO-1').attach('image', PNG, 'unit.png');
    expect(added.status).toBe(201);
    const list = (await ctx.api.get(`/api/attachments?kind=qc_unit&ref_id=${added.body.id}`).set(H())).body;
    expect(list).toHaveLength(1);
  });

  it('refuses a unit without a photo, and creates nothing', async () => {
    const { mo } = await releasedMO('AddUnitNoPhoto', 2, 1);
    const r = await ctx.api.post(`/api/job-orders/${mo}/units`).set(H()).send({ identifier: 'NOPHOTO-1' });
    expect(r.status).toBe(400);
    expect(r.body.needs_photo).toBe(true);
    expect((await ctx.api.get(`/api/job-orders/${mo}/units`).set(H())).body).toHaveLength(0);
    const jo = (await ctx.api.get(`/api/job-orders/${mo}`).set(H())).body;
    expect(jo.components[0].qty_consumed).toBe(0);
  });

  it('lets a production lead (no inventory.adjust) add a unit with its photo, and inspectors add defect photos', async () => {
    const { mo } = await releasedMO('AddUnitLeadPhoto', 1, 1);
    const lead = await createEmployee(ctx.api, token, { role: 'production_lead' });
    await ctx.api.put(`/api/job-orders/${mo}/assignees`).set(H()).send({user_ids:[lead.id]});
    const r = await ctx.api.post(`/api/job-orders/${mo}/units`).set(bearer(lead.token))
      .field('identifier', 'LEADPH-1').attach('image', PNG, 'unit.png');
    expect(r.status).toBe(201);
    const qc = await createEmployee(ctx.api, token, { role: 'qc_inspector' });
    const defect = await ctx.api.post('/api/attachments').set(bearer(qc.token))
      .field('kind', 'qc_unit').field('ref_id', String(r.body.id)).attach('image', PNG, 'defect.png');
    expect(defect.status).toBe(201);
  });
});
