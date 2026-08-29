/** Multiple named QA/QC checklists: a library of checklists, one attachable per
 *  finished product (with an `is_default` fallback), filled by the inspector and
 *  enforced on a pass. Plus: every inspection + the warehouse release are stamped
 *  with the acting account. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';
import { ALL_PERMISSIONS, roleDefaults } from '../src/permissions';

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

async function makeChecklist(name: string, items: unknown[], is_default = false): Promise<number> {
  const r = await ctx.api.post('/api/qc/checklists').set(H()).send({ name, items, is_default });
  return r.body.id as number;
}

/** A released MO for a fresh product; optionally attach a checklist to that product. */
async function releasedMO(prefix: string, qty: number, qc_stages: number, checklistId?: number) {
  const product = await mkItem(`${prefix} Product`);
  const part = await mkItem(`${prefix} Part`, 1000);
  await ctx.api.put(`/api/finished-products/${product}`).set(H()).send({
    components: [{ component_item_id: part, quantity: 1 }],
    ...(checklistId !== undefined ? { qc_checklist_id: checklistId } : {}),
  });
  const mo = (await ctx.api.post('/api/job-orders').set(H())
    .send({ product_item_id: product, qty_ordered: qty, qc_stages })).body.id;
  await ctx.api.post(`/api/job-orders/${mo}/release`).set(H());
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
      { label: 'Weld sound', required: true, stage: 0 },
      { label: 'Final finish', required: false, stage: 2 },
    ]);
    const one = (await ctx.api.get('/api/qc/checklists/' + id).set(H())).body;
    expect(one.name).toBe('Frame QC');
    expect(one.items).toHaveLength(2);
    expect(one.items[0]).toMatchObject({ label: 'Weld sound', required: true, stage: 0 });

    await ctx.api.put('/api/qc/checklists/' + id).set(H())
      .send({ name: 'Frame QC v2', items: [{ label: 'X', required: false, stage: 1 }] });
    expect((await ctx.api.get('/api/qc/checklists/' + id).set(H())).body.name).toBe('Frame QC v2');

    expect((await ctx.api.del('/api/qc/checklists/' + id).set(H())).status).toBe(200);
    expect((await ctx.api.get('/api/qc/checklists/' + id).set(H())).status).toBe(404);
  });

  it('needs qc.configure to write; only one checklist stays default', async () => {
    const wh = await createEmployee(ctx.api, token, { role: 'warehouse' });
    expect((await ctx.api.post('/api/qc/checklists').set(bearer(wh.token)).send({ name: 'x', items: [] })).status).toBe(403);

    const a = await makeChecklist('Default A', [], true);
    const b = await makeChecklist('Default B', [], true);
    const rows = (await ctx.api.get('/api/qc/checklists').set(H())).body as Array<{ id: number; is_default: number }>;
    expect(rows.find((r) => r.id === a)!.is_default).toBe(0);
    expect(rows.find((r) => r.id === b)!.is_default).toBe(1);
    await ctx.api.del('/api/qc/checklists/' + a).set(H());
    await ctx.api.del('/api/qc/checklists/' + b).set(H());
  });
});

describe('per-product resolution + enforcement', () => {
  it('falls back to the default checklist when the product has none attached', async () => {
    const def = await makeChecklist('Company default', [{ label: 'Serial number legible', required: true, stage: 0 }], true);
    const { mo } = await releasedMO('QDEF', 2, 1); // no checklist attached to the product
    const jo = (await ctx.api.get(`/api/job-orders/${mo}`).set(H())).body;
    expect(jo.qc_checklist.id).toBe(def);
    expect(jo.qc_checklist.name).toBe('Company default');

    await ctx.api.post(`/api/job-orders/${mo}/progress`).set(H()).send({ done_delta: 2 });
    const units = await pendingUnits(mo);
    expect((await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(H())
      .send({ unit_ids: [units[0]!.id], result: 'pass' })).status).toBe(400);
    const ok = await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(H())
      .send({ unit_ids: [units[0]!.id], result: 'pass', checklist: [{ label: 'Serial number legible', ok: true }] });
    expect(ok.status).toBe(200);
    await ctx.api.del('/api/qc/checklists/' + def).set(H());
  });

  it('uses the product-attached checklist over the default, and stores the snapshot + inspector', async () => {
    await makeChecklist('Generic default', [{ label: 'Generic check', required: true, stage: 0 }], true);
    const special = await makeChecklist('Engine line', [
      { label: 'Torque to spec', required: true, stage: 0 },
      { label: 'Leak test', required: true, stage: 2 },
    ]);
    const { mo } = await releasedMO('QATT', 2, 1, special);
    const jo = (await ctx.api.get(`/api/job-orders/${mo}`).set(H())).body;
    expect(jo.qc_checklist.name).toBe('Engine line');

    await ctx.api.post(`/api/job-orders/${mo}/progress`).set(H()).send({ done_delta: 1 });
    const units = await pendingUnits(mo);
    const bad = await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(H())
      .send({ unit_ids: [units[0]!.id], result: 'pass', checklist: [{ label: 'Torque to spec', ok: true }] });
    expect(bad.status).toBe(400); // single-stage MO → "Leak test" (stage 2) is also required

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
    await makeChecklist('D', [{ label: 'Q', required: true, stage: 0 }], true);
    const { mo } = await releasedMO('QF', 2, 1);
    await ctx.api.post(`/api/job-orders/${mo}/progress`).set(H()).send({ done_delta: 2 });
    const units = await pendingUnits(mo);
    const r = await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(H())
      .send({ unit_ids: [units[0]!.id], result: 'fail', remarks: 'cracked' });
    expect(r.status).toBe(200);
    expect(r.body.job_order.qty_scrapped).toBe(1);
  });
});

describe('BOM checklist attach + who released', () => {
  it('rejects an unknown checklist id on the BOM save', async () => {
    const product = await mkItem('BadCl Product');
    const part = await mkItem('BadCl Part', 10);
    const r = await ctx.api.put(`/api/finished-products/${product}`).set(H())
      .send({ components: [{ component_item_id: part, quantity: 1 }], qc_checklist_id: 999999 });
    expect(r.status).toBe(400);
  });

  it('records released_by on release', async () => {
    const admin = (await ctx.api.get('/api/auth/me').set(H())).body.user;
    const { mo } = await releasedMO('REL', 2, 0);
    const jo = (await ctx.api.get(`/api/job-orders/${mo}`).set(H())).body;
    expect(jo.released_by).toBe(admin.id);
    expect(jo.released_by_name).toBeTruthy();
  });
});
