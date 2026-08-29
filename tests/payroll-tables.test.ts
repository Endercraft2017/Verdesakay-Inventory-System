/** Versioned PH statutory rate tables: seeding, effective-date resolution, RBAC. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';

let ctx: TestContext;
let token: string;
const authHdr = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  ctx = await setupApp();
  token = await login(ctx.api);
});
afterAll(() => cleanup(ctx));

describe('GET /api/hr/payroll-tables', () => {
  it('a fresh install is seeded with the 2026 schedule', async () => {
    const r = await ctx.api.get('/api/hr/payroll-tables').set(authHdr());
    expect(r.status).toBe(200);
    const kinds = r.body.rows.map((x: { kind: string }) => x.kind).sort();
    expect(kinds).toEqual(['pagibig', 'philhealth', 'rwt', 'sss']);
    expect(r.body.effective.sss.employee_share).toBe(0.05);
    expect(r.body.effective.philhealth.ceiling).toBe(100_000);
    expect(r.body.effective.pagibig.max_each).toBe(200);
    expect(r.body.effective.rwt.monthly.length).toBeGreaterThan(3);
  });
});

describe('adding a future version', () => {
  it('resolves by effective date', async () => {
    const future = {
      kind: 'sss',
      effective_from: '2027-01-01',
      data: { ...{
        employee_share: 0.055, employer_share: 0.11, msc_min: 5000, msc_max: 40000,
        msc_step: 500, ec_employer: 30, ec_employer_low: 10, ec_low_msc_max: 14500,
      } },
      note: 'Hypothetical 2027 hike',
    };
    const post = await ctx.api.post('/api/hr/payroll-tables').set(authHdr()).send(future);
    expect(post.status).toBe(201);

    const y2026 = await ctx.api.get('/api/hr/payroll-tables?date=2026-06-30').set(authHdr());
    expect(y2026.body.effective.sss.employee_share).toBe(0.05); // still the seed

    const y2027 = await ctx.api.get('/api/hr/payroll-tables?date=2027-06-30').set(authHdr());
    expect(y2027.body.effective.sss.employee_share).toBe(0.055); // the new one
    expect(y2027.body.effective.sss.msc_max).toBe(40_000);
  });

  it('re-posting the same kind+date replaces it', async () => {
    await ctx.api.post('/api/hr/payroll-tables').set(authHdr())
      .send({ kind: 'pagibig', effective_from: '2027-01-01', data: { employee_rate: 0.03, employer_rate: 0.02, employee_rate_low: 0.01, low_threshold: 1500, comp_ceiling: 10000, max_each: 300 } });
    await ctx.api.post('/api/hr/payroll-tables').set(authHdr())
      .send({ kind: 'pagibig', effective_from: '2027-01-01', data: { employee_rate: 0.02, employer_rate: 0.02, employee_rate_low: 0.01, low_threshold: 1500, comp_ceiling: 10000, max_each: 250 } });
    const r = await ctx.api.get('/api/hr/payroll-tables?date=2027-02-01').set(authHdr());
    expect(r.body.effective.pagibig.max_each).toBe(250);
    const pagibigRows = r.body.rows.filter((x: { kind: string; effective_from: string }) => x.kind === 'pagibig' && x.effective_from === '2027-01-01');
    expect(pagibigRows.length).toBe(1);
  });

  it('rejects a bad effective_from and an empty data blob', async () => {
    expect((await ctx.api.post('/api/hr/payroll-tables').set(authHdr())
      .send({ kind: 'sss', effective_from: '01/01/2027', data: { x: 1 } })).status).toBe(400);
    expect((await ctx.api.post('/api/hr/payroll-tables').set(authHdr())
      .send({ kind: 'sss', effective_from: '2027-01-01', data: {} })).status).toBe(400);
  });
});

describe('RBAC', () => {
  it('hr.view can read but not write; unrelated roles get nothing', async () => {
    const hrView = await createEmployee(ctx.api, token, { role: 'accounting' }); // no hr.*
    expect((await ctx.api.get('/api/hr/payroll-tables').set('Authorization', `Bearer ${hrView.token}`)).status).toBe(403);

    const hr = await createEmployee(ctx.api, token, { role: 'hr' }); // hr.view + hr.manage
    expect((await ctx.api.get('/api/hr/payroll-tables').set('Authorization', `Bearer ${hr.token}`)).status).toBe(200);
  });
});
