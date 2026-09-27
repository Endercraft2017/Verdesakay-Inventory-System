/** First-class production batches / lots. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, addSerializedUnits, type TestContext } from './helpers';

let ctx: TestContext;
let token: string;
const H = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  ctx = await setupApp();
  token = await login(ctx.api);
});
afterAll(() => cleanup(ctx));

const mkItem = async (name: string, quantity = 0) =>
  (await ctx.api.post('/api/inventory').set(H()).send({ name, quantity })).body.id as number;

async function releasedMO(prefix: string, qty: number, qc_stages: number) {
  const product = await mkItem(`${prefix} Product`);
  const part = await mkItem(`${prefix} Part`, 1000);
  await ctx.api.put(`/api/finished-products/${product}`).set(H())
    .send({ components: [{ component_item_id: part, quantity: 1 }] });
  const mo = (await ctx.api.post('/api/job-orders').set(H())
    .send({ product_item_id: product, qty_ordered: qty, qc_stages })).body.id;
  await ctx.api.post(`/api/job-orders/${mo}/approve`).set(H());
  await ctx.api.post(`/api/job-orders/warehouse-accept`).set(H()).send({ job_order_ids: [mo] });
  await ctx.api.post(`/api/job-orders/prepare`).set(H()).send({ job_orders: [{ id: mo }] });
  await ctx.api.post(`/api/job-orders/${mo}/release`).set(H());
  await ctx.api.post(`/api/job-orders/${mo}/accept`).set(H());
  return { mo, product, part };
}

const batchesFor = async (mo: number) =>
  (await ctx.api.get('/api/production/batches?job_order=' + mo).set(H())).body as Array<{ id: number; number: string; qty: number; status: string; identifier: string | null; unit_count: number }>;

describe('production batches', () => {
  it('a non-serialized job order records one batch per progress entry', async () => {
    const { mo, product } = await releasedMO('B1', 5, 0);
    await ctx.api.post(`/api/job-orders/${mo}/progress`).set(H()).send({ done_delta: 3 });
    await ctx.api.post(`/api/job-orders/${mo}/progress`).set(H()).send({ done_delta: 2, batch_label: 'LOT-A' });

    const b = await batchesFor(mo);
    expect(b.length).toBe(2);
    expect(b.map((x) => x.qty).sort()).toEqual([2, 3]);
    expect(b.every((x) => /^BATCH-\d{5}$/.test(x.number))).toBe(true);
    expect(b.find((x) => x.qty === 2)!.identifier).toBe('LOT-A');
    // 'open' until Products In receives it — the batch's own status is a separate,
    // optional QA sign-off flag (production.routes.ts POST /batches/:id/inspect).
    expect(b.every((x) => x.status === 'open')).toBe(true);
    // scanning the batch number resolves it
    const look = await ctx.api.get('/api/inventory/lookup?code=' + b[0]!.number).set(H());
    expect(look.status).toBe(200);
    expect(look.body.batch.number).toBe(b[0]!.number);
    expect(look.body.id).toBe(product); // the product came along too
  });

  it('a serialized job order batches a progress entry only when given a label', async () => {
    const { mo } = await releasedMO('B2', 4, 1);
    await addSerializedUnits(ctx.api, token, mo, 2, 'B2');                       // no batch
    await addSerializedUnits(ctx.api, token, mo, 2, 'B2run', 'RUN-7'); // batched

    const b = await batchesFor(mo);
    expect(b.length).toBe(1);
    expect(b[0]!.identifier).toBe('RUN-7');
    expect(b[0]!.qty).toBe(2);
    expect(b[0]!.status).toBe('open');

    const units = (await ctx.api.get(`/api/job-orders/${mo}/units`).set(H())).body as Array<{ id: number; batch_id: number | null }>;
    expect(units.filter((u) => u.batch_id === b[0]!.id).length).toBe(2);
    expect(units.filter((u) => u.batch_id === null).length).toBe(2);
  });

  it('a serialized batch auto-closes once all its units reach a terminal state', async () => {
    const { mo } = await releasedMO('B4', 2, 1);
    await addSerializedUnits(ctx.api, token, mo, 2, 'B4', 'RUN-9');
    const statusNow = async () => (await batchesFor(mo))[0]!.status;
    expect(await statusNow()).toBe('open');

    const units = (await ctx.api.get(`/api/job-orders/${mo}/units`).set(H())).body as Array<{ id: number }>;
    await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(H())
      .send({ unit_ids: [units[0]!.id], result: 'pass' });
    expect(await statusNow()).toBe('open'); // one unit still pending

    await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(H())
      .send({ unit_ids: [units[1]!.id], result: 'fail', disposition: 'scrap', remarks: 'bad' });
    expect(await statusNow()).toBe('closed'); // both terminal now
  });

  it('records a batch-level QA/QC sign-off and enforces required checks', async () => {
    await ctx.api.post('/api/qc/checklists').set(H())
      .send({ name: 'Batch default', is_default: true, items: [{ label: 'Paint even', required: true, stage: 0 }] });
    const { mo } = await releasedMO('B3', 3, 0);
    await ctx.api.post(`/api/job-orders/${mo}/progress`).set(H()).send({ done_delta: 3 });
    const [batch] = await batchesFor(mo);

    // pass blocked until the required check is ticked
    const blocked = await ctx.api.post(`/api/production/batches/${batch!.id}/inspect`).set(H())
      .send({ result: 'pass' });
    expect(blocked.status).toBe(400);

    const ok = await ctx.api.post(`/api/production/batches/${batch!.id}/inspect`).set(H())
      .send({ result: 'pass', checklist: [{ label: 'Paint even', ok: true }], remarks: 'looks good' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('closed');

    const detail = (await ctx.api.get(`/api/production/batches/${batch!.id}`).set(H())).body;
    expect(detail.qc.length).toBe(1);
    expect(detail.qc[0].result).toBe('pass');
    expect(detail.qc[0].inspector_name).toBeTruthy();

    // a fail needs a disposition
    const noDisp = await ctx.api.post(`/api/production/batches/${batch!.id}/inspect`).set(H())
      .send({ result: 'fail' });
    expect(noDisp.status).toBe(400);
  });
});
