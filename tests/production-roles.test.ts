/** Narrow shop-floor roles (parts_clerk / production_lead / qc_inspector / qa_inspector /
 *  receiving_clerk — src/shared/permissions.ts) — each should be able to do exactly its
 *  one production.* task via requireAnyPermission(['inventory.adjust', 'production.xxx'])
 *  and nothing else that still needs plain inventory.adjust (job-order lifecycle: create,
 *  release, pause, cancel, team/batch admin). admin/warehouse/admin_staff/releasing keep
 *  working throughout via their existing inventory.adjust — covered already by every
 *  other manufacturing test file; this file is specifically about the new narrow roles.
 *  qc_inspector (production.inspect_qc) and qa_inspector (production.inspect_qa) are
 *  deliberately separate — see job-orders.routes.ts /:id/units/inspect's stage-aware
 *  check: a single-stage job order's one combined pass accepts either; a two-stage one
 *  strictly requires QC for the first pass and QA for the final one. */
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

const mkItem = async (name: string, quantity = 0) =>
  (await ctx.api.post('/api/inventory').set(H()).send({ name, quantity })).body.id as number;

async function releasedMO(prefix: string, qty: number, qc_stages: number) {
  const product = await mkItem(`${prefix} Product`);
  const part = await mkItem(`${prefix} Part`, 1000);
  await ctx.api.put(`/api/finished-products/${product}`).set(H()).send({
    components: [{ component_item_id: part, quantity: 1 }],
  });
  const mo = (await ctx.api.post('/api/job-orders').set(H())
    .send({ product_item_id: product, qty_ordered: qty, qc_stages })).body.id;
  await ctx.api.post(`/api/job-orders/${mo}/release`).set(H());
  await ctx.api.post(`/api/job-orders/${mo}/accept`).set(H());
  return { mo, product };
}

describe('production_lead role', () => {
  it('can add a unit and record scrap, but cannot release/pause/cancel a job order', async () => {
    const lead = await createEmployee(ctx.api, token, { role: 'production_lead' });
    const { mo } = await releasedMO('LeadRole', 3, 1);

    const add = await ctx.api.post(`/api/job-orders/${mo}/units`).set(bearer(lead.token)).send({ identifier: 'LEAD-1' });
    expect(add.status).toBe(201);
    const scrap = await ctx.api.post(`/api/job-orders/${mo}/progress`).set(bearer(lead.token)).send({ scrapped_delta: 1 });
    expect(scrap.status).toBe(200);

    expect((await ctx.api.post(`/api/job-orders/${mo}/pause`).set(bearer(lead.token))).status).toBe(403);
    expect((await ctx.api.post(`/api/job-orders/${mo}/cancel`).set(bearer(lead.token))).status).toBe(403);
    const draftAttempt = await ctx.api.post('/api/job-orders').set(bearer(lead.token))
      .send({ product_item_id: 1, qty_ordered: 1 });
    expect(draftAttempt.status).toBe(403);
  });

  it('cannot inspect or receive', async () => {
    const lead = await createEmployee(ctx.api, token, { role: 'production_lead' });
    const { mo } = await releasedMO('LeadRole2', 2, 1);
    const units = await addSerializedUnits(ctx.api, token, mo, 1, 'LR2');
    expect((await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(bearer(lead.token))
      .send({ unit_ids: units, result: 'pass' })).status).toBe(403);
    expect((await ctx.api.post(`/api/job-orders/${mo}/products-in`).set(bearer(lead.token))
      .send({ location_id: 1, unit_ids: units })).status).toBe(403);
  });
});

describe('qc_inspector role', () => {
  it('can pass/fail units and request repair parts, but cannot record production or receive', async () => {
    const qc = await createEmployee(ctx.api, token, { role: 'qc_inspector' });
    const { mo } = await releasedMO('QcRole', 3, 1);
    const units = await addSerializedUnits(ctx.api, token, mo, 2, 'QCR');

    const pass = await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(bearer(qc.token))
      .send({ unit_ids: [units[0]], result: 'pass' });
    expect(pass.status).toBe(200);

    const fail = await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(bearer(qc.token))
      .send({ unit_ids: [units[1]], result: 'fail', disposition: 'repair', remarks: 'bent frame' });
    expect(fail.status).toBe(200);
    const part = await mkItem('QcRole spare part', 10);
    const rpr = await ctx.api.post(`/api/production/units/${units[1]}/repairs`).set(bearer(qc.token))
      .send({ kind: 'add', component_item_id: part, quantity: 1 });
    expect(rpr.status).toBe(201);

    expect((await ctx.api.post(`/api/job-orders/${mo}/units`).set(bearer(qc.token))
      .send({ identifier: 'QCR-X' })).status).toBe(403);
    const receivable = (await ctx.api.get(`/api/job-orders/${mo}/receivable`).set(H())).body;
    expect((await ctx.api.post(`/api/job-orders/${mo}/products-in`).set(bearer(qc.token))
      .send({ location_id: receivable.output_location_id, unit_ids: [units[0]] })).status).toBe(403);
  });

  it('cannot accept/reject a parts request (that is the parts clerk)', async () => {
    const qc = await createEmployee(ctx.api, token, { role: 'qc_inspector' });
    const { mo } = await releasedMO('QcRole2', 1, 1);
    const [unit] = await addSerializedUnits(ctx.api, token, mo, 1, 'QCR2');
    await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(H())
      .send({ unit_ids: [unit], result: 'fail', disposition: 'repair', remarks: 'x' });
    const part = await mkItem('QcRole2 part', 10);
    const rpr = await ctx.api.post(`/api/production/units/${unit}/repairs`).set(H())
      .send({ kind: 'add', component_item_id: part, quantity: 1 });
    expect((await ctx.api.post(`/api/production/repairs/${rpr.body.id}/accept`).set(bearer(qc.token)).send({})).status).toBe(403);
  });
});

describe('qa_inspector role', () => {
  it('can pass/fail units on a single-stage job order, but cannot record production or receive', async () => {
    const qa = await createEmployee(ctx.api, token, { role: 'qa_inspector' });
    const { mo } = await releasedMO('QaRole', 2, 1);
    const units = await addSerializedUnits(ctx.api, token, mo, 2, 'QAR');

    const pass = await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(bearer(qa.token))
      .send({ unit_ids: [units[0]], result: 'pass' });
    expect(pass.status).toBe(200);

    expect((await ctx.api.post(`/api/job-orders/${mo}/units`).set(bearer(qa.token))
      .send({ identifier: 'QAR-X' })).status).toBe(403);
    const receivable = (await ctx.api.get(`/api/job-orders/${mo}/receivable`).set(H())).body;
    expect((await ctx.api.post(`/api/job-orders/${mo}/products-in`).set(bearer(qa.token))
      .send({ location_id: receivable.output_location_id, unit_ids: [units[0]] })).status).toBe(403);
  });

  it('cannot accept/reject a parts request (that is the parts clerk)', async () => {
    const qa = await createEmployee(ctx.api, token, { role: 'qa_inspector' });
    const { mo } = await releasedMO('QaRole2', 1, 1);
    const [unit] = await addSerializedUnits(ctx.api, token, mo, 1, 'QAR2');
    await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(H())
      .send({ unit_ids: [unit], result: 'fail', disposition: 'repair', remarks: 'x' });
    const part = await mkItem('QaRole2 part', 10);
    const rpr = await ctx.api.post(`/api/production/units/${unit}/repairs`).set(H())
      .send({ kind: 'add', component_item_id: part, quantity: 1 });
    expect((await ctx.api.post(`/api/production/repairs/${rpr.body.id}/accept`).set(bearer(qa.token)).send({})).status).toBe(403);
  });
});

describe('qc_inspector vs qa_inspector on a two-stage job order', () => {
  it('qc_inspector may only do the first pass, qa_inspector only the final pass', async () => {
    const qc = await createEmployee(ctx.api, token, { role: 'qc_inspector' });
    const qa = await createEmployee(ctx.api, token, { role: 'qa_inspector' });
    const { mo } = await releasedMO('TwoStage', 1, 2);
    const [unit] = await addSerializedUnits(ctx.api, token, mo, 1, 'TS2');

    // qa_inspector is blocked from the first (QC) pass.
    expect((await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(bearer(qa.token))
      .send({ unit_ids: [unit], result: 'pass' })).status).toBe(403);

    // qc_inspector performs the first pass.
    const firstPass = await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(bearer(qc.token))
      .send({ unit_ids: [unit], result: 'pass' });
    expect(firstPass.status).toBe(200);

    // qc_inspector is now blocked from the final (QA) pass.
    expect((await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(bearer(qc.token))
      .send({ unit_ids: [unit], result: 'pass' })).status).toBe(403);

    // qa_inspector performs the final pass.
    const finalPass = await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(bearer(qa.token))
      .send({ unit_ids: [unit], result: 'pass' });
    expect(finalPass.status).toBe(200);
  });
});

describe('receiving_clerk role', () => {
  it('can receive passed units, but cannot record or inspect', async () => {
    const clerk = await createEmployee(ctx.api, token, { role: 'receiving_clerk' });
    const { mo } = await releasedMO('RecvRole', 1, 1);
    const [unit] = await addSerializedUnits(ctx.api, token, mo, 1, 'RECV');
    await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(H()).send({ unit_ids: [unit], result: 'pass' });

    const receivable = (await ctx.api.get(`/api/job-orders/${mo}/receivable`).set(bearer(clerk.token))).body;
    const recv = await ctx.api.post(`/api/job-orders/${mo}/products-in`).set(bearer(clerk.token))
      .send({ location_id: receivable.output_location_id, unit_ids: [unit] });
    expect(recv.status).toBe(201);

    expect((await ctx.api.post(`/api/job-orders/${mo}/units`).set(bearer(clerk.token))
      .send({ identifier: 'RECV-X' })).status).toBe(403);
  });
});

describe('parts_clerk role', () => {
  it('can accept/reject parts requests, but cannot inspect or record', async () => {
    const clerk = await createEmployee(ctx.api, token, { role: 'parts_clerk' });
    const { mo } = await releasedMO('PartsRole', 1, 1);
    const [unit] = await addSerializedUnits(ctx.api, token, mo, 1, 'PC');
    await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(H())
      .send({ unit_ids: [unit], result: 'fail', disposition: 'repair', remarks: 'x' });
    const part = await mkItem('PartsRole part', 10);
    const rpr = await ctx.api.post(`/api/production/units/${unit}/repairs`).set(H())
      .send({ kind: 'add', component_item_id: part, quantity: 1 });

    const accept = await ctx.api.post(`/api/production/repairs/${rpr.body.id}/accept`).set(bearer(clerk.token)).send({});
    expect(accept.status).toBe(200);

    expect((await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(bearer(clerk.token))
      .send({ unit_ids: [unit], result: 'pass' })).status).toBe(403);
  });
});
