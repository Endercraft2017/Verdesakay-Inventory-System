/** Production accepts the released parts kit (POST /api/job-orders/:id/accept,
 *  SCHEMA_VERSION 45) — the handover sign-off between the warehouse's /release and the
 *  first recorded output. Recording (/progress, /units) is blocked until it's done;
 *  job orders that already have output recorded are exempt (needsAcceptance()). */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';

// `run` is imported dynamically in beforeAll, after setupApp() sets DB_PATH — a top-level
// import of '../src/shared/db' would bind to the real data.db (see clock.test.ts / helpers.ts).
let run: typeof import('../src/shared/db').run;
let ctx: TestContext;
let token: string;
const H = () => ({ Authorization: `Bearer ${token}` });
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  ctx = await setupApp();
  ({ run } = await import('../src/shared/db'));
  token = await login(ctx.api);
});
afterAll(() => cleanup(ctx));

const mkItem = async (name: string, quantity = 0) =>
  (await ctx.api.post('/api/inventory').set(H()).send({ name, quantity })).body.id as number;

async function draftMO(prefix: string, qty: number, qc_stages: number) {
  const product = await mkItem(`${prefix} Product`);
  const part = await mkItem(`${prefix} Part`, 1000);
  await ctx.api.put(`/api/finished-products/${product}`).set(H()).send({
    components: [{ component_item_id: part, quantity: 1 }],
  });
  return (await ctx.api.post('/api/job-orders').set(H())
    .send({ product_item_id: product, qty_ordered: qty, qc_stages })).body.id as number;
}

describe('POST /api/job-orders/:id/accept', () => {
  it('blocks recording output until production accepts the kit', async () => {
    const mo = await draftMO('AccGate', 3, 0);
    await ctx.api.post(`/api/job-orders/${mo}/approve`).set(H());
    await ctx.api.post(`/api/job-orders/warehouse-accept`).set(H()).send({ job_order_ids: [mo] });
    await ctx.api.post(`/api/job-orders/prepare`).set(H()).send({ job_orders: [{ id: mo }] });
    await ctx.api.post(`/api/job-orders/${mo}/release`).set(H());

    const early = await ctx.api.post(`/api/job-orders/${mo}/progress`).set(H()).send({ done_delta: 1 });
    expect(early.status).toBe(409);
    expect(early.body.needs_acceptance).toBe(true);

    const acc = await ctx.api.post(`/api/job-orders/${mo}/accept`).set(H()).send({ notes: 'kit complete' });
    expect(acc.status).toBe(200);
    expect(acc.body.job_order.accepted_at).toBeTruthy();
    expect(acc.body.job_order.accepted_by_name).toBeTruthy();
    expect(acc.body.job_order.accept_notes).toBe('kit complete');
    expect(acc.body.job_order.status).toBe('released'); // no status change, no stock move

    const ok = await ctx.api.post(`/api/job-orders/${mo}/progress`).set(H()).send({ done_delta: 1 });
    expect(ok.status).toBe(200);
  });

  it('blocks adding a serialized unit until accepted', async () => {
    const mo = await draftMO('AccUnit', 2, 1);
    await ctx.api.post(`/api/job-orders/${mo}/approve`).set(H());
    await ctx.api.post(`/api/job-orders/warehouse-accept`).set(H()).send({ job_order_ids: [mo] });
    await ctx.api.post(`/api/job-orders/prepare`).set(H()).send({ job_orders: [{ id: mo }] });
    await ctx.api.post(`/api/job-orders/${mo}/release`).set(H());
    const early = await ctx.api.post(`/api/job-orders/${mo}/units`).set(H()).field('identifier', 'ACC-1').attach('image', Buffer.from('unit-photo'), 'unit.png');
    expect(early.status).toBe(409);
    await ctx.api.post(`/api/job-orders/${mo}/accept`).set(H());
    const ok = await ctx.api.post(`/api/job-orders/${mo}/units`).set(H()).field('identifier', 'ACC-1').attach('image', Buffer.from('unit-photo'), 'unit.png');
    expect(ok.status).toBe(201);
  });

  it('refuses a draft, a second accept, and a closed job order', async () => {
    const mo = await draftMO('AccState', 2, 0);
    expect((await ctx.api.post(`/api/job-orders/${mo}/accept`).set(H())).status).toBe(409); // draft
    await ctx.api.post(`/api/job-orders/${mo}/approve`).set(H());
    await ctx.api.post(`/api/job-orders/warehouse-accept`).set(H()).send({ job_order_ids: [mo] });
    await ctx.api.post(`/api/job-orders/prepare`).set(H()).send({ job_orders: [{ id: mo }] });
    await ctx.api.post(`/api/job-orders/${mo}/release`).set(H());
    expect((await ctx.api.post(`/api/job-orders/${mo}/accept`).set(H())).status).toBe(200);
    expect((await ctx.api.post(`/api/job-orders/${mo}/accept`).set(H())).status).toBe(409); // again

    const mo2 = await draftMO('AccCancel', 2, 0);
    await ctx.api.post(`/api/job-orders/${mo2}/approve`).set(H());
    await ctx.api.post(`/api/job-orders/warehouse-accept`).set(H()).send({ job_order_ids: [mo2] });
    await ctx.api.post(`/api/job-orders/prepare`).set(H()).send({ job_orders: [{ id: mo2 }] });
    await ctx.api.post(`/api/job-orders/${mo2}/release`).set(H());
    await ctx.api.post(`/api/job-orders/${mo2}/cancel`).set(H());
    expect((await ctx.api.post(`/api/job-orders/${mo2}/accept`).set(H())).status).toBe(409);
  });

  it('a production_lead can accept; a qc_inspector cannot', async () => {
    const lead = await createEmployee(ctx.api, token, { role: 'production_lead' });
    const qc = await createEmployee(ctx.api, token, { role: 'qc_inspector' });
    const mo = await draftMO('AccRole', 2, 1);
    await ctx.api.post(`/api/job-orders/${mo}/approve`).set(H());
    await ctx.api.post(`/api/job-orders/warehouse-accept`).set(H()).send({ job_order_ids: [mo] });
    await ctx.api.post(`/api/job-orders/prepare`).set(H()).send({ job_orders: [{ id: mo }] });
    await ctx.api.post(`/api/job-orders/${mo}/release`).set(H());
    expect((await ctx.api.post(`/api/job-orders/${mo}/accept`).set(bearer(qc.token))).status).toBe(403);
    const acc = await ctx.api.post(`/api/job-orders/${mo}/accept`).set(bearer(lead.token));
    expect(acc.status).toBe(200);
    expect(acc.body.job_order.accepted_by).toBe(lead.id);
  });

  it('exempts a job order that already has output recorded (pre-accept-step data)', async () => {
    const mo = await draftMO('AccLegacy', 3, 0);
    await ctx.api.post(`/api/job-orders/${mo}/approve`).set(H());
    await ctx.api.post(`/api/job-orders/warehouse-accept`).set(H()).send({ job_order_ids: [mo] });
    await ctx.api.post(`/api/job-orders/prepare`).set(H()).send({ job_orders: [{ id: mo }] });
    await ctx.api.post(`/api/job-orders/${mo}/release`).set(H());
    // Simulate a job order built before the accept step existed: output, no acceptance.
    run("UPDATE job_orders SET qty_scrapped = 1, status = 'in_progress' WHERE id = ?", mo);
    const r = await ctx.api.post(`/api/job-orders/${mo}/progress`).set(H()).send({ done_delta: 1 });
    expect(r.status).toBe(200);
  });

  it('shows who accepted on the production record dossier', async () => {
    const mo = await draftMO('AccDossier', 1, 1);
    await ctx.api.post(`/api/job-orders/${mo}/approve`).set(H());
    await ctx.api.post(`/api/job-orders/warehouse-accept`).set(H()).send({ job_order_ids: [mo] });
    await ctx.api.post(`/api/job-orders/prepare`).set(H()).send({ job_orders: [{ id: mo }] });
    await ctx.api.post(`/api/job-orders/${mo}/release`).set(H());
    await ctx.api.post(`/api/job-orders/${mo}/accept`).set(H());
    const unit = (await ctx.api.post(`/api/job-orders/${mo}/units`).set(H()).field('identifier', 'ACC-DOS-1').attach('image', Buffer.from('unit-photo'), 'unit.png')).body.id;
    const rec = await ctx.api.get(`/api/production/record?unit=${unit}`).set(H());
    expect(rec.status).toBe(200);
    expect(rec.body.job_order.accepted_by_name).toBeTruthy();
    expect(rec.body.job_order.accepted_at).toBeTruthy();
  });
});
