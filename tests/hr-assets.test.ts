/** Company asset register (GET /api/hr/assets) + readable activity-log rows for asset
    issue / return / delete — the delete row keeps a snapshot of the erased form. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';

let ctx: TestContext;
let token: string;
const hdr = () => ({ Authorization: `Bearer ${token}` });
/** The audit INSERT runs in the response 'finish' handler — let it settle. */
const tick = () => new Promise((r) => setTimeout(r, 30));

let activeEmp: number;
let leaverEmp: number;
let issuanceId: number;
let issuanceNo: string;

beforeAll(async () => {
  ctx = await setupApp();
  token = await login(ctx.api);
  activeEmp = (await ctx.api.post('/api/hr/employees').set(hdr())
    .send({ employee_no: 'TEST-ASSET-A', name: 'Active Holder' })).body.id;
  leaverEmp = (await ctx.api.post('/api/hr/employees').set(hdr())
    .send({ employee_no: 'TEST-ASSET-B', name: 'Former Holder' })).body.id;

  const a = await ctx.api.post(`/api/hr/employees/${activeEmp}/assets`).set(hdr()).send({
    issued_date: '2026-09-01',
    items: [
      { asset_name: 'Laptop - ThinkPad', category: 'Laptop', asset_tag: 'LAP-777' },
      { asset_name: 'Safety Boots', quantity: 2 },
    ],
  });
  expect(a.status).toBe(201);
  issuanceId = a.body.id;
  issuanceNo = a.body.number;
  const b = await ctx.api.post(`/api/hr/employees/${leaverEmp}/assets`).set(hdr()).send({
    issued_date: '2026-08-01',
    items: [{ asset_name: 'Drill', asset_tag: 'TOOL-9' }],
  });
  expect(b.status).toBe(201);
  const sep = await ctx.api.put(`/api/hr/employees/${leaverEmp}`).set(hdr())
    .send({ employee_no: 'TEST-ASSET-B', name: 'Former Holder', status: 'resigned' });
  expect(sep.status).toBe(200);
});
afterAll(() => cleanup(ctx));

describe('company asset register', () => {
  it('lists every still-out line across employees with holder + form, and company-wide counts', async () => {
    const res = await ctx.api.get('/api/hr/assets').set(hdr());
    expect(res.status).toBe(200);
    const names = res.body.rows.map((r: { asset_name: string }) => r.asset_name);
    expect(names).toEqual(expect.arrayContaining(['Laptop - ThinkPad', 'Safety Boots', 'Drill']));
    const laptop = res.body.rows.find((r: { asset_tag: string }) => r.asset_tag === 'LAP-777');
    expect(laptop).toMatchObject({ employee_name: 'Active Holder', issuance_number: issuanceNo, status: 'issued' });
    expect(res.body.counts.issued).toBeGreaterThanOrEqual(3);
    expect(res.body.held_by_separated).toBeGreaterThanOrEqual(1);
  });

  it('filters: search, people who have left, and status', async () => {
    const q = await ctx.api.get('/api/hr/assets?q=LAP-777').set(hdr());
    expect(q.body.rows).toHaveLength(1);

    const sep = await ctx.api.get('/api/hr/assets?separated=1').set(hdr());
    expect(sep.body.rows.every((r: { employee_status: string }) => ['resigned', 'terminated'].includes(r.employee_status))).toBe(true);
    expect(sep.body.rows.some((r: { asset_name: string }) => r.asset_name === 'Drill')).toBe(true);

    expect((await ctx.api.get('/api/hr/assets?status=bogus').set(hdr())).status).toBe(400);
  });

  it('exports CSV', async () => {
    const res = await ctx.api.get('/api/hr/assets?format=csv&q=LAP-777').set(hdr());
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain('Form No.');
    expect(res.text).toContain('LAP-777');
  });

  it('requires hr.view', async () => {
    const outsider = await createEmployee(ctx.api, token, { role: 'warehouse' });
    expect((await ctx.api.get('/api/hr/assets').set({ Authorization: `Bearer ${outsider.token}` })).status).toBe(403);
  });
});

describe('asset activity log', () => {
  const activity = async (action: string) =>
    (await ctx.api.get(`/api/activity?action=${action}`).set(hdr())).body.rows as
      { summary: string; meta: string | null; entity_id: string }[];

  it('records the issue with the form number, employee and items', async () => {
    const rows = await activity('asset-issue');
    const row = rows.find((r) => r.summary.includes(issuanceNo));
    expect(row?.summary).toBe(`Issued ${issuanceNo} to Active Holder: Laptop - ThinkPad (LAP-777), Safety Boots ×2`);
  });

  it('records a return as a readable line, and a re-save keeps the earlier details', async () => {
    const detail = await ctx.api.get(`/api/hr/assets/${issuanceId}`).set(hdr());
    const boots = detail.body.items.find((it: { asset_name: string }) => it.asset_name === 'Safety Boots');
    await ctx.api.post(`/api/hr/assets/${issuanceId}/items/${boots.id}/return`).set(hdr())
      .send({ status: 'damaged', returned_date: '2026-09-20', condition_on_return: 'Sole torn' });
    await tick();
    const dmg = (await activity('asset-damaged')).find((r) => r.summary.includes(issuanceNo));
    expect(dmg?.summary).toBe(`Marked damaged: Safety Boots ×2 on ${issuanceNo} (Active Holder)`);

    await ctx.api.post(`/api/hr/assets/${issuanceId}/items/${boots.id}/return`).set(hdr())
      .send({ status: 'returned', returned_date: '2026-09-21' });
    await tick();
    const ret = (await activity('asset-returned')).find((r) => r.summary.includes(issuanceNo));
    expect(ret?.summary).toContain('— was damaged');
    expect(JSON.parse(ret!.meta!).snapshot.previous).toMatchObject({ status: 'damaged', condition_on_return: 'Sole torn' });
  });

  it('keeps a snapshot of a deleted form, since the rows themselves are gone', async () => {
    const del = await ctx.api.delete(`/api/hr/assets/${issuanceId}`).set(hdr());
    expect(del.status).toBe(200);
    await tick();
    const row = (await activity('asset-issuance-delete')).find((r) => r.summary.includes(issuanceNo));
    expect(row?.summary).toBe(`Deleted ${issuanceNo} (Active Holder): Laptop - ThinkPad (LAP-777) [issued], Safety Boots ×2 [returned]`);
    const snap = JSON.parse(row!.meta!).snapshot.issuance;
    expect(snap.number).toBe(issuanceNo);
    expect(snap.items).toHaveLength(2);
    expect((await ctx.api.get(`/api/hr/assets?q=${issuanceNo}&status=all`).set(hdr())).body.rows).toHaveLength(0);
  });
});
