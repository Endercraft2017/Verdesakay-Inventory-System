/** Mobile V2 inspection support (Figma 69:* QC, 72:* QA): the per-inspector unit queue
 *  (GET /api/qc/queue), per-item Pass/Issue/N/A + measured values, checklist groups/measures,
 *  and structured repair details on a 'repair' result. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, addSerializedUnits, type TestContext } from './helpers';

let ctx: TestContext;
let token: string;
let qc: { id: number; token: string };
let qa: { id: number; token: string };
let jo: number;
let units: number[];
let product: number;
const H = () => ({ Authorization: `Bearer ${token}` });
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  ctx = await setupApp();
  token = await login(ctx.api);
  qc = await createEmployee(ctx.api, token, { role: 'qc_inspector' });
  qa = await createEmployee(ctx.api, token, { role: 'qa_inspector' });
  product = (await ctx.api.post('/api/inventory').set(H()).send({ name: 'E-Bike QCV2', quantity: 0 })).body.id;
  const part = (await ctx.api.post('/api/inventory').set(H()).send({ name: 'Frame QCV2', quantity: 100 })).body.id;
  await ctx.api.put(`/api/finished-products/${product}`).set(H()).send({ components: [{ component_item_id: part, quantity: 1 }] });
  // A QC checklist with two groups, a measurement and a required item.
  const cl = await ctx.api.post('/api/qc/checklists').set(H()).send({
    name: 'E-bike technical', stage: 1, items: [
      { label: 'Frame and fasteners', required: true, group: 'Safety and mechanical', hint: 'No looseness or crack' },
      { label: 'Battery voltage', required: false, group: 'Electrical and function', measure: 'V' },
    ],
  });
  expect(cl.status).toBe(201);
  await ctx.api.patch(`/api/finished-products/${product}/checklist`).set(H()).send({ stage: 1, checklist_id: cl.body.id });
  jo = (await ctx.api.post('/api/job-orders').set(H()).send({ product_item_id: product, qty_ordered: 5, qc_stages: 2 })).body.id;
  await ctx.api.post(`/api/job-orders/${jo}/approve`).set(H());
  await ctx.api.post('/api/job-orders/warehouse-accept').set(H()).send({ job_order_ids: [jo] });
  await ctx.api.post('/api/job-orders/prepare').set(H()).send({ job_orders: [{ id: jo }] });
  await ctx.api.post(`/api/job-orders/${jo}/release`).set(H());
  await ctx.api.post(`/api/job-orders/${jo}/accept`).set(H()).send({});
  units = await addSerializedUnits(ctx.api, token, jo, 3, 'QV2');
});
afterAll(() => cleanup(ctx));

const inspect = (t: string, body: Record<string, unknown>) => ctx.api.post(`/api/job-orders/${jo}/units/inspect`).set(bearer(t)).send(body);

describe('checklist items', () => {
  it('keeps group, measure and hint on saved checklist items', async () => {
    const got = await ctx.api.get(`/api/job-orders/${jo}`).set(H());
    expect(got.body.qc_checklist_qc.items[0]).toMatchObject({ group: 'Safety and mechanical', hint: 'No looseness or crack', required: true });
    expect(got.body.qc_checklist_qc.items[1]).toMatchObject({ measure: 'V' });
  });
});

describe('GET /api/qc/queue', () => {
  it('gives a QC inspector the first-pass units and a QA inspector nothing yet', async () => {
    const q = await ctx.api.get('/api/qc/queue').set(bearer(qc.token));
    expect(q.status).toBe(200);
    expect(q.body.role).toBe('qc');
    expect(q.body.units.map((u: { id: number }) => u.id).sort()).toEqual([...units].sort());
    expect(q.body.units[0]).toMatchObject({ job_order_id: jo, product_name: 'E-Bike QCV2', qc_stages: 2, last_fail: null });
    const a = await ctx.api.get('/api/qc/queue').set(bearer(qa.token));
    expect(a.body.role).toBe('qa');
    expect(a.body.units).toHaveLength(0);
  });

  it('rejects a pass when a required item is only N/A, accepts Pass with a reading, and moves the unit to QA', async () => {
    const na = await inspect(qc.token, { unit_ids: [units[0]], result: 'pass', checklist: [
      { label: 'Frame and fasteners', ok: true, status: 'na' },
      { label: 'Battery voltage', ok: true, status: 'pass', value: '67.4' },
    ] });
    expect(na.status).toBe(400);
    const ok = await inspect(qc.token, { unit_ids: [units[0]], result: 'pass', remarks: 'No technical defects', checklist: [
      { label: 'Frame and fasteners', ok: true, status: 'pass' },
      { label: 'Battery voltage', ok: true, status: 'pass', value: '67.4' },
    ] });
    expect(ok.status).toBe(200);
    const a = await ctx.api.get('/api/qc/queue').set(bearer(qa.token));
    expect(a.body.units.map((u: { id: number }) => u.id)).toEqual([units[0]]);
    expect(a.body.units[0].last_pass).toMatchObject({ stage: 1, items: 2 });
    const done = await ctx.api.get('/api/qc/queue?role=qc').set(bearer(qc.token));
    expect(done.body.completed.map((r: { unit_id: number }) => r.unit_id)).toContain(units[0]);
  });

  it('stores repair details on a repair result and shows them on the reinspection unit', async () => {
    const r = await inspect(qc.token, {
      unit_ids: [units[1]], result: 'fail', disposition: 'repair', remarks: 'Check left signal wiring; retest after correction',
      checklist: [{ label: 'Frame and fasteners', ok: true, status: 'pass' }, { label: 'Battery voltage', ok: false, status: 'issue', value: '41.0', note: 'Low' }],
      repair: { category: 'Electrical · signal system', station: 'Wiring', priority: 'Normal' },
    });
    expect(r.status).toBe(200);
    const q = await ctx.api.get('/api/qc/queue').set(bearer(qc.token));
    const unit = q.body.units.find((u: { id: number }) => u.id === units[1]);
    expect(unit.status).toBe('rework');
    expect(unit.last_fail).toMatchObject({ repair_station: 'Wiring', repair_category: 'Electrical · signal system', repair_priority: 'Normal' });
    expect(unit.last_fail.checklist.find((c: { label: string }) => c.label === 'Battery voltage')).toMatchObject({ status: 'issue', value: '41.0' });
    const hist = await ctx.api.get(`/api/job-orders/${jo}/qc`).set(H());
    expect(hist.body.find((h: { unit_id: number }) => h.unit_id === units[1])).toMatchObject({ repair_station: 'Wiring' });
  });

  it('is refused to accounts without an inspection permission', async () => {
    const lead = await createEmployee(ctx.api, token, { role: 'production_lead' });
    expect((await ctx.api.get('/api/qc/queue').set(bearer(lead.token))).status).toBe(403);
  });
});
