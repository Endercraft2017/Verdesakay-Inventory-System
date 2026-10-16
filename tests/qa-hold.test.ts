/** QA hold for review and phone evidence (QC/QA, Figma 69:* / 72:*): a final-pass unit QA holds
 *  is status 'hold' (not a repair), listed by GET /api/qc/holds and decided — pass, rectify or fail,
 *  with a reason — by any QA inspector or a production.qa_review holder (the Production Manager by
 *  default). A failing / held result from the phone app needs an evidence photo of its own. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, addSerializedUnits, type TestContext } from './helpers';

let ctx: TestContext;
let token: string;
let qc: { id: number; token: string };
let qa: { id: number; token: string };
let qa2: { id: number; token: string };
let pm: { id: number; token: string };
let jo: number;
let product: number;
let units: number[];
let __sentPush: typeof import('../src/shared/push').__sentPush;
const PNG = Buffer.from('fake-png-bytes');
const H = () => ({ Authorization: `Bearer ${token}` });
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const phone = (t: string) => ({ ...bearer(t), 'X-Client': 'mobile' });

beforeAll(async () => {
  ctx = await setupApp();
  token = await login(ctx.api);
  qc = await createEmployee(ctx.api, token, { role: 'qc_inspector' });
  qa = await createEmployee(ctx.api, token, { role: 'qa_inspector' });
  qa2 = await createEmployee(ctx.api, token, { role: 'qa_inspector' });
  pm = await createEmployee(ctx.api, token, { role: 'production_manager' });
  ({ __sentPush } = await import('../src/shared/push'));
  await ctx.api.post('/api/push/subscribe').set(bearer(pm.token))
    .send({ endpoint: 'https://fcm.googleapis.com/sub/pm-hold', keys: { p256dh: 'BAY'.padEnd(87, 'x'), auth: 'abc123def456' } }); // gitleaks:allow -- synthetic push fixture
  await ctx.api.post('/api/push/subscribe').set(bearer(qa.token))
    .send({ endpoint: 'https://fcm.googleapis.com/sub/qa-hold', keys: { p256dh: 'BAY'.padEnd(87, 'x'), auth: 'abc123def456' } }); // gitleaks:allow -- synthetic push fixture
  product = (await ctx.api.post('/api/inventory').set(H()).send({ name: 'E-Bike HOLD', quantity: 0 })).body.id;
  const part = (await ctx.api.post('/api/inventory').set(H()).send({ name: 'Frame HOLD', quantity: 100 })).body.id;
  await ctx.api.put(`/api/finished-products/${product}`).set(H()).send({ components: [{ component_item_id: part, quantity: 1 }] });
  const qaList = (await ctx.api.post('/api/qc/checklists').set(H()).send({ name: 'Hold QA', stage: 2, items: [
    { label: 'Finish clean', required: true }, { label: 'Voltage', required: true, measure: 'V' },
  ] })).body.id;
  await ctx.api.patch(`/api/finished-products/${product}/checklist`).set(H()).send({ stage: 2, checklist_id: qaList });
  jo = (await ctx.api.post('/api/job-orders').set(H()).send({ product_item_id: product, qty_ordered: 5, qc_stages: 2 })).body.id;
  await ctx.api.post(`/api/job-orders/${jo}/approve`).set(H());
  await ctx.api.post('/api/job-orders/warehouse-accept').set(H()).send({ job_order_ids: [jo] });
  await ctx.api.post('/api/job-orders/prepare').set(H()).send({ job_orders: [{ id: jo }] });
  await ctx.api.post(`/api/job-orders/${jo}/release`).set(H());
  await ctx.api.post(`/api/job-orders/${jo}/accept`).set(H()).send({});
  units = await addSerializedUnits(ctx.api, token, jo, 5, 'HLD');
});
afterAll(() => cleanup(ctx));

const inspect = (hdr: Record<string, string>, body: Record<string, unknown>) => ctx.api.post(`/api/job-orders/${jo}/units/inspect`).set(hdr).send(body);
const photo = async (t: string, unit: number) =>
  (await ctx.api.post('/api/attachments').set(phone(t)).field('kind', 'qc_unit').field('ref_id', String(unit)).attach('image', PNG, 'ev.png')).body.id as number;
const unit = async (id: number) => ((await ctx.api.get(`/api/job-orders/${jo}/units`).set(H())).body as Array<{ id: number; status: string }>).find((u) => u.id === id)!;
const decide = (t: string, u: number, body: Record<string, unknown>) =>
  ctx.api.post(`/api/job-orders/${jo}/units/${u}/hold-decision`).set(bearer(t)).send(body);

describe('phone evidence', () => {
  it('refuses a failing result from the phone without the inspector\'s own photo of that unit', async () => {
    const u = units[0]!;
    const body = { unit_ids: [u], result: 'fail', disposition: 'repair', remarks: 'Loose stem bolt' };
    const bare = await inspect(phone(qc.token), body);
    expect(bare.status).toBe(409);
    expect(bare.body.blocked).toBe('evidence');
    // Someone else's photo, or a photo of another unit, doesn't count.
    const others = await photo(qa.token, u);
    const wrongUnit = await photo(qc.token, units[1]!);
    expect((await inspect(phone(qc.token), { ...body, evidence_ids: [others, wrongUnit] })).body.blocked).toBe('evidence');
    expect((await unit(u)).status).toBe('pending');
    const mine = await photo(qc.token, u);
    expect((await inspect(phone(qc.token), { ...body, evidence_ids: [mine] })).status).toBe(200);
    expect((await unit(u)).status).toBe('rework');
  });

  it('holds the desktop app to the same rule; passes need no photo', async () => {
    const desk = { ...bearer(qc.token), 'X-Client': 'desktop' };
    const r = await inspect(desk, { unit_ids: [units[1]], result: 'fail', disposition: 'scrap', remarks: 'Bent frame' });
    expect(r.status).toBe(409);
    expect(r.body.blocked).toBe('evidence');
    expect((await inspect(desk, { unit_ids: [units[1]], result: 'pass' })).status).toBe(200);
    expect((await inspect(phone(qc.token), { unit_ids: [units[2], units[3], units[4]], result: 'pass' })).status).toBe(200);
  });
});

describe('QA hold for review', () => {
  it('only the final pass can hold', async () => {
    // units[0] is back in rework on its first (QC) pass.
    const res = await inspect(bearer(qc.token), { unit_ids: [units[0]], result: 'fail', disposition: 'hold', remarks: 'Unsure' });
    expect(res.status).toBe(400);
  });

  it('puts the unit on hold, lists it and pushes the deciders', async () => {
    const u = units[1]!;
    __sentPush.length = 0;
    const ev = await photo(qa.token, u);
    const res = await inspect(phone(qa.token), { unit_ids: [u], result: 'fail', disposition: 'hold', remarks: 'Paint shade differs from sample', evidence_ids: [ev] });
    expect(res.status).toBe(200);
    expect((await unit(u)).status).toBe('hold');
    const holds = (await ctx.api.get('/api/qc/holds').set(bearer(pm.token))).body;
    expect(holds.find((h: { id: number }) => h.id === u)).toMatchObject({ remarks: 'Paint shade differs from sample', evidence: 1 });
    const findings = (await ctx.api.get('/api/qc/records?result=hold').set(H())).body;
    expect(findings.rows.some((r: { unit_id: number }) => r.unit_id === u)).toBe(true);
    expect(findings.summary.hold).toBeGreaterThanOrEqual(1);
    expect(__sentPush.some((p) => p.userId === pm.id && /^QA hold/.test(p.payload.title))).toBe(true);
    expect(__sentPush.some((p) => p.userId === qa.id)).toBe(false); // not the one who held it
    // The job order can't complete with a unit on hold.
    expect((await ctx.api.get(`/api/job-orders/${jo}`).set(H())).body.units_summary.hold).toBe(1);
    // A QC inspector can't decide it; the Production Manager (production.qa_review) can.
    expect((await decide(qc.token, u, { outcome: 'pass', remarks: 'ok' })).status).toBe(403);
    expect((await decide(pm.token, u, { outcome: 'pass', remarks: 'x' })).status).toBe(400); // reason too short
    const incomplete = await decide(pm.token, u, { outcome: 'pass', remarks: 'Within the colour tolerance' });
    expect(incomplete.status).toBe(400);
    expect(incomplete.body.blocked).toBe('checklist');
    expect((await unit(u)).status).toBe('hold');
    const failedRequired = await decide(pm.token, u, { outcome: 'pass', remarks: 'Within the colour tolerance', checklist: [
      { label: 'Finish clean', ok: false, status: 'issue' }, { label: 'Voltage', ok: true, status: 'pass', value: '24.2' },
    ] });
    expect(failedRequired.status).toBe(400);
    expect((await unit(u)).status).toBe('hold');
    const noReading = await decide(pm.token, u, { outcome: 'pass', remarks: 'Within the colour tolerance', checklist: [
      { label: 'Finish clean', ok: true, status: 'pass' }, { label: 'Voltage', ok: true, status: 'pass' },
    ] });
    expect(noReading.status).toBe(400);
    expect((await unit(u)).status).toBe('hold');
    __sentPush.length = 0;
    const decisionKey = `qa-hold-${u}-decision`;
    const ok = await ctx.api.post(`/api/job-orders/${jo}/units/${u}/hold-decision`).set(bearer(pm.token)).set('Idempotency-Key', decisionKey)
      .send({ outcome: 'pass', remarks: 'Within the colour tolerance', checklist: [
        { label: 'Finish clean', ok: true, status: 'pass' }, { label: 'Voltage', ok: true, status: 'pass', value: '24.2' },
      ] });
    expect(ok.status).toBe(200);
    const changed = await ctx.api.post(`/api/job-orders/${jo}/units/${u}/hold-decision`).set(bearer(pm.token)).set('Idempotency-Key', decisionKey)
      .send({ outcome: 'fail', remarks: 'Changed after saving', disposition: 'scrap' });
    expect(changed.status).toBe(409);
    expect(changed.body.error).toMatch(/different request body/i);
    expect((await unit(u)).status).toBe('passed');
    const passRecord = (await ctx.api.get(`/api/job-orders/${jo}/qc`).set(H())).body.find((r: { unit_id: number; result: string; stage: number }) => r.unit_id === u && r.result === 'pass' && r.stage === 2);
    expect(passRecord.checklist).toMatchObject([{ label: 'Finish clean', status: 'pass' }, { label: 'Voltage', value: '24.2' }]);
    const receivable = await ctx.api.get(`/api/job-orders/${jo}/receivable`).set(H());
    expect(receivable.body.units.some((row: { id: number }) => row.id === u)).toBe(true);
    expect(__sentPush.some((p) => p.userId === qa.id && /^QA hold decided/.test(p.payload.title))).toBe(true);
    expect((await decide(pm.token, u, { outcome: 'pass', remarks: 'again' })).status).toBe(409);
  });

  it('binds a decision to the reviewed hold episode and exactly replays one outcome', async () => {
    const u = units[4]!;
    const ev = await photo(qa.token, u);
    expect((await inspect(phone(qa.token), { unit_ids: [u], result: 'fail', disposition: 'hold', remarks: 'First held finding', evidence_ids: [ev] })).status).toBe(200);
    const first = (await ctx.api.get('/api/qc/holds').set(bearer(pm.token))).body.find((h: { id: number }) => h.id === u);
    expect((await decide(pm.token, u, { outcome: 'rectify', remarks: 'Correct first finding', expected_hold_record_id: first.record_id })).status).toBe(200);
    const recheckPhoto = await photo(qa.token, u);
    const heldAgain = await inspect(phone(qa.token), { unit_ids: [u], result: 'fail', disposition: 'hold', remarks: 'New hold after correction', evidence_ids: [recheckPhoto] });
    expect(heldAgain.status, JSON.stringify(heldAgain.body)).toBe(200);
    const current = (await ctx.api.get('/api/qc/holds').set(bearer(pm.token))).body.find((h: { id: number }) => h.id === u);
    expect(current.checks).toMatchObject([{ label: 'Finish clean', required: true }, { label: 'Voltage', measure: 'V' }]);
    const stale = await decide(pm.token, u, { outcome: 'pass', remarks: 'Old held finding accepted', expected_hold_record_id: first.record_id });
    expect(stale.status).toBe(409); expect(stale.body.code).toBe('stale_hold'); expect((await unit(u)).status).toBe('hold');
    const before = (await ctx.api.get(`/api/job-orders/${jo}`).set(H())).body.qty_done;
    const send = () => ctx.api.post(`/api/job-orders/${jo}/units/${u}/hold-decision`).set(bearer(pm.token)).set('Idempotency-Key', 'hold-episode-retry-001').send({ outcome: 'pass', remarks: 'Current finding accepted', expected_hold_record_id: current.record_id, checklist: [{ label: 'Finish clean', ok: true, status: 'pass' }, { label: 'Voltage', ok: true, status: 'pass', value: '24.2' }] });
    const accepted = await send(), retry = await send();
    expect(accepted.status).toBe(200); expect(retry.body).toEqual(accepted.body); expect(retry.headers['idempotency-replayed']).toBe('true');
    expect((await ctx.api.get(`/api/job-orders/${jo}`).set(H())).body.qty_done).toBe(before + 1);
    expect((await unit(u)).status).toBe('passed');
  });

  it('another QA inspector can send a held unit to rectification or fail it', async () => {
    const photos = await Promise.all([photo(qa.token, units[2]!), photo(qa.token, units[3]!)]);
    await inspect(bearer(qa.token), { unit_ids: [units[2], units[3]], result: 'fail', disposition: 'hold', remarks: 'Scratch on the fender', evidence_ids: photos });
    const r = await decide(qa2.token, units[2]!, { outcome: 'rectify', remarks: 'Repaint the fender', repair: { station: 'Paint' } });
    expect(r.status).toBe(200);
    expect((await unit(units[2]!)).status).toBe('rework');
    const before = (await ctx.api.get(`/api/job-orders/${jo}`).set(H())).body.qty_scrapped;
    const f = await decide(qa2.token, units[3]!, { outcome: 'fail', disposition: 'recycle', remarks: 'Frame dent found on review' });
    expect(f.status).toBe(200);
    expect((await unit(units[3]!)).status).toBe('failed');
    expect((await ctx.api.get(`/api/job-orders/${jo}`).set(H())).body.qty_scrapped).toBe(before + 1);
    const log = (await ctx.api.get(`/api/job-orders/${jo}/qc`).set(H())).body as Array<{ unit_id: number; result: string }>;
    expect(log.filter((x) => x.unit_id === units[3]).map((x) => x.result).sort()).toEqual(['fail', 'hold', 'pass']);
  });
});

describe('Production Manager line decisions', () => {
  it('pauses and resumes with a reason, without inventory.adjust', async () => {
    expect((await ctx.api.post(`/api/job-orders/${jo}/pause`).set(bearer(pm.token)).send({})).status).toBe(400);
    expect((await ctx.api.post(`/api/job-orders/${jo}/pause`).set(bearer(pm.token)).send({ reason: 'Line changeover' })).status).toBe(200);
    expect((await ctx.api.post(`/api/job-orders/${jo}/resume`).set(bearer(pm.token)).send({ reason: 'Changeover done' })).status).toBe(200);
    const ev = (await ctx.api.get(`/api/job-orders/${jo}/events`).set(bearer(pm.token))).body;
    expect(ev.map((e: { action: string }) => e.action)).toEqual(['resume', 'pause']);
  });
});
