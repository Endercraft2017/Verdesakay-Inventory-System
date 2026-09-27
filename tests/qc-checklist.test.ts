/** Multiple named QC/QA checklists: a library of checklists, each belonging to one
 *  stage as a whole (QC = first pass, QA = final pass), one attachable per stage per
 *  finished product (with a per-stage `is_default` fallback), filled by the inspector
 *  and enforced on a pass. Plus: every inspection + the warehouse release are stamped
 *  with the acting account. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, addSerializedUnits, type TestContext } from './helpers';
import { ALL_PERMISSIONS, roleDefaults } from '../src/shared/permissions';

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

async function makeChecklist(name: string, items: unknown[], opts: { is_default?: boolean; stage?: 1 | 2 } = {}): Promise<number> {
  const r = await ctx.api.post('/api/qc/checklists').set(H())
    .send({ name, items, is_default: opts.is_default ?? false, stage: opts.stage ?? 1 });
  return r.body.id as number;
}

/** A released MO for a fresh product; optionally attach QA / QC checklists to that product. */
async function releasedMO(prefix: string, qty: number, qc_stages: number, checklists?: { qa?: number; qc?: number }) {
  const product = await mkItem(`${prefix} Product`);
  const part = await mkItem(`${prefix} Part`, 1000);
  await ctx.api.put(`/api/finished-products/${product}`).set(H()).send({
    components: [{ component_item_id: part, quantity: 1 }],
    ...(checklists?.qa !== undefined ? { qc_checklist_qa_id: checklists.qa } : {}),
    ...(checklists?.qc !== undefined ? { qc_checklist_qc_id: checklists.qc } : {}),
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
const pendingUnits = async (mo: number) =>
  ((await ctx.api.get(`/api/job-orders/${mo}/units`).set(H())).body as Array<{ id: number; status: string }>)
    .filter((u) => u.status === 'pending');

describe('qc.configure permission', () => {
  it('is in the catalog and admin-only by default', () => {
    expect(ALL_PERMISSIONS).toContain('qc.configure');
    expect(roleDefaults('admin')).toContain('qc.configure');
    expect(roleDefaults('warehouse')).not.toContain('qc.configure');
  });
});

describe('checklist library CRUD', () => {
  it('starts empty and round-trips a checklist', async () => {
    expect((await ctx.api.get('/api/qc/checklists').set(H())).body).toEqual([]);
    const id = await makeChecklist('Frame QC', [
      { label: 'Weld sound', required: true },
      { label: 'Final finish', required: false },
    ], { stage: 2 });
    const one = (await ctx.api.get('/api/qc/checklists/' + id).set(H())).body;
    expect(one.name).toBe('Frame QC');
    expect(one.stage).toBe(2);
    expect(one.items).toHaveLength(2);
    expect(one.items[0]).toMatchObject({ label: 'Weld sound', required: true });

    await ctx.api.put('/api/qc/checklists/' + id).set(H())
      .send({ name: 'Frame QC v2', stage: 2, items: [{ label: 'X', required: false }] });
    expect((await ctx.api.get('/api/qc/checklists/' + id).set(H())).body.name).toBe('Frame QC v2');

    expect((await ctx.api.del('/api/qc/checklists/' + id).set(H())).status).toBe(200);
    expect((await ctx.api.get('/api/qc/checklists/' + id).set(H())).status).toBe(404);
  });

  it('needs qc.configure to write; only one checklist per stage stays default', async () => {
    const wh = await createEmployee(ctx.api, token, { role: 'warehouse' });
    expect((await ctx.api.post('/api/qc/checklists').set(bearer(wh.token)).send({ name: 'x', items: [] })).status).toBe(403);

    const a = await makeChecklist('Default A', [], { is_default: true, stage: 1 });
    const b = await makeChecklist('Default B', [], { is_default: true, stage: 1 });
    // A QC-stage default is a separate slot — making it default doesn't touch the QA one.
    const c = await makeChecklist('Default C (QC)', [], { is_default: true, stage: 2 });
    const rows = (await ctx.api.get('/api/qc/checklists').set(H())).body as Array<{ id: number; stage: number; is_default: number }>;
    expect(rows.find((r) => r.id === a)!.is_default).toBe(0);
    expect(rows.find((r) => r.id === b)!.is_default).toBe(1);
    expect(rows.find((r) => r.id === c)!.is_default).toBe(1);
    await ctx.api.del('/api/qc/checklists/' + a).set(H());
    await ctx.api.del('/api/qc/checklists/' + b).set(H());
    await ctx.api.del('/api/qc/checklists/' + c).set(H());
  });
});

describe('per-product resolution + enforcement', () => {
  it('falls back to the default checklist when the product has none attached', async () => {
    const def = await makeChecklist('Company default', [{ label: 'Serial number legible', required: true }], { is_default: true, stage: 1 });
    const { mo } = await releasedMO('QDEF', 2, 1); // no checklist attached to the product
    const jo = (await ctx.api.get(`/api/job-orders/${mo}`).set(H())).body;
    expect(jo.qc_checklist_qc.id).toBe(def);
    expect(jo.qc_checklist_qc.name).toBe('Company default');
    expect(jo.qc_checklist_qa).toBeNull();

    await addSerializedUnits(ctx.api, token, mo, 2, 'QDEF');
    const units = await pendingUnits(mo);
    expect((await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(H())
      .send({ unit_ids: [units[0]!.id], result: 'pass' })).status).toBe(400);
    const ok = await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(H())
      .send({ unit_ids: [units[0]!.id], result: 'pass', checklist: [{ label: 'Serial number legible', ok: true }] });
    expect(ok.status).toBe(200);
    await ctx.api.del('/api/qc/checklists/' + def).set(H());
  });

  it('uses the product-attached checklists over the defaults, and stores the snapshot + inspector', async () => {
    await makeChecklist('Generic QC default', [{ label: 'Generic QC check', required: true }], { is_default: true, stage: 1 });
    await makeChecklist('Generic QA default', [{ label: 'Generic QA check', required: true }], { is_default: true, stage: 2 });
    const qc = await makeChecklist('Engine line QC', [{ label: 'Torque to spec', required: true }], { stage: 1 });
    const qa = await makeChecklist('Engine line QA', [{ label: 'Leak test', required: true }], { stage: 2 });
    const { mo } = await releasedMO('QATT', 2, 1, { qa, qc });
    const jo = (await ctx.api.get(`/api/job-orders/${mo}`).set(H())).body;
    expect(jo.qc_checklist_qc.name).toBe('Engine line QC');
    expect(jo.qc_checklist_qa.name).toBe('Engine line QA');

    await addSerializedUnits(ctx.api, token, mo, 1, 'QATT');
    const units = await pendingUnits(mo);
    const bad = await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(H())
      .send({ unit_ids: [units[0]!.id], result: 'pass', checklist: [{ label: 'Torque to spec', ok: true }] });
    expect(bad.status).toBe(400); // single-stage MO → both the QC and QA checklists apply together, "Leak test" is also required

    const ok = await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(H()).send({
      unit_ids: [units[0]!.id], result: 'pass', remarks: 'ok',
      checklist: [{ label: 'Torque to spec', ok: true, note: '90Nm' }, { label: 'Leak test', ok: true }],
    });
    expect(ok.status).toBe(200);
    const log = (await ctx.api.get(`/api/job-orders/${mo}/qc`).set(H())).body;
    const pass = log.find((q: { result: string }) => q.result === 'pass');
    expect(pass.inspector_name).toBeTruthy();
    expect(pass.checklist[0]).toMatchObject({ label: 'Torque to spec', ok: true, note: '90Nm' });
  });

  it('a fail needs no checklist', async () => {
    await makeChecklist('D', [{ label: 'Q', required: true }], { is_default: true, stage: 1 });
    const { mo } = await releasedMO('QF', 2, 1);
    await addSerializedUnits(ctx.api, token, mo, 2, 'QF');
    const units = await pendingUnits(mo);
    const r = await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(H())
      .send({ unit_ids: [units[0]!.id], result: 'fail', disposition: 'scrap', remarks: 'cracked' });
    expect(r.status).toBe(200);
    expect(r.body.job_order.qty_scrapped).toBe(1);
  });
});

describe('BOM checklist attach + who released', () => {
  it('rejects an unknown checklist id on the BOM save', async () => {
    const product = await mkItem('BadCl Product');
    const part = await mkItem('BadCl Part', 10);
    const r = await ctx.api.put(`/api/finished-products/${product}`).set(H())
      .send({ components: [{ component_item_id: part, quantity: 1 }], qc_checklist_qa_id: 999999 });
    expect(r.status).toBe(400);
  });

  it('rejects a first-pass-stage checklist in the QA (final-pass) slot', async () => {
    const product = await mkItem('MismatchCl Product');
    const part = await mkItem('MismatchCl Part', 10);
    const qc = await makeChecklist('QC-only', [], { stage: 1 });
    const r = await ctx.api.put(`/api/finished-products/${product}`).set(H())
      .send({ components: [{ component_item_id: part, quantity: 1 }], qc_checklist_qa_id: qc });
    expect(r.status).toBe(400);
    await ctx.api.del('/api/qc/checklists/' + qc).set(H());
  });

  it('records released_by on release', async () => {
    const admin = (await ctx.api.get('/api/auth/me').set(H())).body.user;
    const { mo } = await releasedMO('REL', 2, 0);
    const jo = (await ctx.api.get(`/api/job-orders/${mo}`).set(H())).body;
    expect(jo.released_by).toBe(admin.id);
    expect(jo.released_by_name).toBeTruthy();
  });
});

describe('PATCH /api/finished-products/:id/checklist — assign one stage without touching the BOM', () => {
  it('assigns then clears a stage checklist, leaving components untouched', async () => {
    const product = await mkItem('PatchCl Product');
    const part = await mkItem('PatchCl Part', 10);
    await ctx.api.put(`/api/finished-products/${product}`).set(H())
      .send({ components: [{ component_item_id: part, quantity: 2 }] });
    const qc = await makeChecklist('Patch QC', [{ label: 'Check A', required: true }], { stage: 1 });

    const r = await ctx.api.patch(`/api/finished-products/${product}/checklist`).set(H())
      .send({ stage: 1, checklist_id: qc });
    expect(r.status).toBe(200);
    let full = (await ctx.api.get(`/api/finished-products/${product}`).set(H())).body;
    expect(full.qc_checklist_qc_id).toBe(qc);
    expect(full.bom).toHaveLength(1);
    expect(full.bom[0].quantity).toBe(2);

    const cleared = await ctx.api.patch(`/api/finished-products/${product}/checklist`).set(H())
      .send({ stage: 1, checklist_id: null });
    expect(cleared.status).toBe(200);
    full = (await ctx.api.get(`/api/finished-products/${product}`).set(H())).body;
    expect(full.qc_checklist_qc_id).toBeNull();
    expect(full.bom).toHaveLength(1); // still untouched
  });

  it('rejects a stage mismatch, an unknown checklist, and an unknown product', async () => {
    const product = await mkItem('PatchCl2 Product');
    const qa = await makeChecklist('Patch QA', [], { stage: 2 });
    expect((await ctx.api.patch(`/api/finished-products/${product}/checklist`).set(H())
      .send({ stage: 1, checklist_id: qa })).status).toBe(400);
    expect((await ctx.api.patch(`/api/finished-products/${product}/checklist`).set(H())
      .send({ stage: 1, checklist_id: 999999 })).status).toBe(400);
    expect((await ctx.api.patch('/api/finished-products/999999/checklist').set(H())
      .send({ stage: 1, checklist_id: null })).status).toBe(404);
  });

  it('needs qc.configure — inventory.edit alone (e.g. warehouse) is not enough', async () => {
    const product = await mkItem('PatchCl3 Product');
    const qc = await makeChecklist('Patch QC 3', [], { stage: 1 });
    const wh = await createEmployee(ctx.api, token, { role: 'warehouse' });
    expect((await ctx.api.patch(`/api/finished-products/${product}/checklist`).set(bearer(wh.token))
      .send({ stage: 1, checklist_id: qc })).status).toBe(403);
  });
});

describe('GET /api/qc/records — cross-job-order findings feed', () => {
  it('aggregates pass/fail records from multiple job orders with job order + inspector context', async () => {
    // Empty QC + QA checklists (no required checks) so pass/fail here doesn't depend on
    // whatever default checklist earlier tests in this file left behind.
    const noReqsQc = await makeChecklist('QREC no-op QC', [], { stage: 1 });
    const noReqsQa = await makeChecklist('QREC no-op QA', [], { stage: 2 });
    const noReqs = { qa: noReqsQa, qc: noReqsQc };

    const { mo: mo1 } = await releasedMO('QREC1', 2, 1, noReqs);
    await addSerializedUnits(ctx.api, token, mo1, 2, 'QREC1');
    const units1 = await pendingUnits(mo1);
    const r1 = await ctx.api.post(`/api/job-orders/${mo1}/units/inspect`).set(H())
      .send({ unit_ids: [units1[0]!.id], result: 'pass' });
    expect(r1.status).toBe(200);
    const r2 = await ctx.api.post(`/api/job-orders/${mo1}/units/inspect`).set(H())
      .send({ unit_ids: [units1[1]!.id], result: 'fail', disposition: 'scrap', remarks: 'cracked case' });
    expect(r2.status).toBe(200);

    const { mo: mo2 } = await releasedMO('QREC2', 1, 1, noReqs);
    await addSerializedUnits(ctx.api, token, mo2, 1, 'QREC2');
    const units2 = await pendingUnits(mo2);
    const r3 = await ctx.api.post(`/api/job-orders/${mo2}/units/inspect`).set(H())
      .send({ unit_ids: [units2[0]!.id], result: 'pass' });
    expect(r3.status).toBe(200);

    const all = (await ctx.api.get('/api/qc/records').set(H())).body;
    expect(all.total).toBeGreaterThanOrEqual(3);
    expect(all.summary.pass).toBeGreaterThanOrEqual(2);
    expect(all.summary.fail).toBeGreaterThanOrEqual(1);
    const mine = all.rows.filter((r: { job_order_id: number }) => r.job_order_id === mo1);
    expect(mine).toHaveLength(2);
    expect(mine[0]).toMatchObject({ job_order_number: expect.stringContaining('') });
    expect(mine.every((r: { inspector_name: string | null }) => r.inspector_name)).toBe(true);

    const failOnly = (await ctx.api.get('/api/qc/records?result=fail').set(H())).body;
    expect(failOnly.rows.every((r: { result: string }) => r.result === 'fail')).toBe(true);
    expect(failOnly.rows.some((r: { remarks: string }) => r.remarks === 'cracked case')).toBe(true);

    const searched = (await ctx.api.get('/api/qc/records?q=QREC2').set(H())).body;
    expect(searched.rows.length).toBeGreaterThanOrEqual(1);
    expect(searched.rows.every((r: { job_order_id: number }) => r.job_order_id === mo2)).toBe(true);
  });

  it('needs inventory.view to read', async () => {
    const outsider = await createEmployee(ctx.api, token, { role: 'hr' });
    expect((await ctx.api.get('/api/qc/records').set(bearer(outsider.token))).status).toBe(403);
  });
});
