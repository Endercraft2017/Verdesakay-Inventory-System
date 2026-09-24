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
  await ctx.api.post(`/api/job-orders/${mo}/release`).set(H());
  return { mo, product };
}

describe('POST /api/job-orders/:id/units', () => {
  it('adds one unit with its identifier, consumes components, and counts toward the ordered qty', async () => {
    const { mo } = await releasedMO('AddUnit', 3, 1);
    const r = await ctx.api.post(`/api/job-orders/${mo}/units`).set(H()).send({ identifier: 'MTR-0001' });
    expect(r.status).toBe(201);
    expect(r.body.job_order.status).toBe('in_progress');

    const units = (await ctx.api.get(`/api/job-orders/${mo}/units`).set(H())).body;
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ identifier: 'MTR-0001', status: 'pending' });

    const jo = (await ctx.api.get(`/api/job-orders/${mo}`).set(H())).body;
    expect(jo.components[0].qty_consumed).toBe(1);
  });

  it('requires a non-empty identifier', async () => {
    const { mo } = await releasedMO('AddUnitNoId', 2, 1);
    const r = await ctx.api.post(`/api/job-orders/${mo}/units`).set(H()).send({ identifier: '  ' });
    expect(r.status).toBe(400);
  });

  it('refuses on a non-serialized (qc_stages = 0) job order', async () => {
    const { mo } = await releasedMO('AddUnitBatch', 2, 0);
    const r = await ctx.api.post(`/api/job-orders/${mo}/units`).set(H()).send({ identifier: 'X' });
    expect(r.status).toBe(400);
  });

  it('refuses once every ordered unit is accounted for', async () => {
    const { mo } = await releasedMO('AddUnitCap', 1, 1);
    const ok = await ctx.api.post(`/api/job-orders/${mo}/units`).set(H()).send({ identifier: 'CAP-1' });
    expect(ok.status).toBe(201);
    const over = await ctx.api.post(`/api/job-orders/${mo}/units`).set(H()).send({ identifier: 'CAP-2' });
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
    const r = await ctx.api.post(`/api/job-orders/${mo}/units`).set(bearer(viewer.token)).send({ identifier: 'X' });
    expect(r.status).toBe(403);
  });

  it('groups units under a shared batch_label, one call per unit', async () => {
    const { mo } = await releasedMO('AddUnitBatchLabel', 3, 1);
    const a = await ctx.api.post(`/api/job-orders/${mo}/units`).set(H()).send({ identifier: 'RUN-A', batch_label: 'RUN-7' });
    const b = await ctx.api.post(`/api/job-orders/${mo}/units`).set(H()).send({ identifier: 'RUN-B', batch_label: 'RUN-7' });
    const c = await ctx.api.post(`/api/job-orders/${mo}/units`).set(H()).send({ identifier: 'RUN-C' }); // no label
    expect([a.status, b.status, c.status]).toEqual([201, 201, 201]);

    const batches = (await ctx.api.get(`/api/production/batches?job_order=${mo}`).set(H())).body;
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ identifier: 'RUN-7', qty: 2, status: 'open' });

    const units = (await ctx.api.get(`/api/job-orders/${mo}/units`).set(H())).body as Array<{ identifier: string; batch_id: number | null }>;
    expect(units.filter((u) => u.batch_id === batches[0].id)).toHaveLength(2);
    expect(units.find((u) => u.identifier === 'RUN-C')!.batch_id).toBeNull();
  });

  it('full sequence: add a unit, then attach its required photo via /attachments (kind: qc_unit)', async () => {
    const { mo } = await releasedMO('AddUnitPhoto', 1, 1);
    const added = await ctx.api.post(`/api/job-orders/${mo}/units`).set(H()).send({ identifier: 'PHOTO-1' });
    expect(added.status).toBe(201);
    const unitId = added.body.id;

    const photo = await ctx.api.post('/api/attachments').set(H())
      .field('kind', 'qc_unit').field('ref_id', String(unitId))
      .attach('image', PNG, 'unit.png');
    expect(photo.status).toBe(201);

    const list = (await ctx.api.get(`/api/attachments?kind=qc_unit&ref_id=${unitId}`).set(H())).body;
    expect(list).toHaveLength(1);
    expect(list[0].url).toBe(photo.body.url);
  });
});
