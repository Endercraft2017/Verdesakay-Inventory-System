/** Rest Day forms on the Daily Time grid (src/modules/hr/rest-day.ts): a Rest Day Work Request
    authorizes the rest-day premium when PayrollPolicy.require_rest_day_form is on, and a Change
    of Rest Day moves the rest day for both of its dates. Both count only once APPROVED. */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';

let ctx: TestContext;
let token: string;
let reviewerToken: string;
const hdr = () => ({ Authorization: `Bearer ${token}` });

// 2026-08-16 and 2026-08-23 are Sundays; 2026-08-19 is a Wednesday. Company rest day: Sunday.
const SUNDAY = '2026-08-16';
const WEDNESDAY = '2026-08-19';
const BASE_POLICY = { pay_frequency: 'semi_monthly', auto_statutory: true, default_rest_days: [0], require_ot_form: true };

beforeAll(async () => {
  ctx = await setupApp();
  token = await login(ctx.api);
  reviewerToken = (await createEmployee(ctx.api, token, { role: 'hr' })).token;
});
afterAll(() => cleanup(ctx));
afterEach(async () => {
  await ctx.api.put('/api/hr/payroll-policy').set(hdr()).send({ ...BASE_POLICY, default_rest_days: [0, 6] });
});

async function formId(slug: string): Promise<number> {
  const defs = await ctx.api.get('/api/form-definitions').set(hdr());
  const def = defs.body.find((f: { slug: string }) => f.slug === slug);
  if (!def) throw new Error(`form ${slug} not seeded`);
  return def.id;
}

async function fileForm(slug: string, data: Record<string, unknown>, status: 'approved' | 'pending') {
  const employees = (await ctx.api.get('/api/hr/employees').set(hdr())).body;
  if (!employees.some((e: any) => e.name === data.employee_name)) await ctx.api.post('/api/hr/employees').set(hdr()).send({ employee_no: 'RD-' + Math.floor(Math.random()*1e8), name: data.employee_name, daily_rate: 800, status: 'regular' });
  const res = await ctx.api.post('/api/form-records').set(hdr())
    .send({ form_def_id: await formId(slug), data, status });
  expect(res.status).toBe(201);
  if (status === 'approved') {
    const decision = await ctx.api.post(`/api/me/approvals/requests/${res.body.id}/decide`).set({ Authorization: `Bearer ${reviewerToken}` }).send({ decision: 'approved' });
    expect(decision.status).toBe(200);
  }
  return res.body.id as number;
}

/** One employee, one cutoff SUNDAY..WEDNESDAY: Sunday worked 08:00-17:00 with `sundayForms`
    linked, Mon/Tue worked, Wednesday left blank. Returns the generated payslip data and the
    Sunday/Wednesday grid rows. */
async function runCutoff(name: string, sundayForms: number[]) {
  const existing = (await ctx.api.get('/api/hr/employees').set(hdr())).body.find((e: any) => e.name === name);
  const emp = existing ? { status: 201, body: existing } : await ctx.api.post('/api/hr/employees').set(hdr())
    .send({ employee_no: 'RD-' + Math.floor(Math.random() * 1e6), name, daily_rate: 800, status: 'regular' });
  expect(emp.status).toBe(201);
  const period = await ctx.api.post('/api/hr/periods').set(hdr())
    .send({ label: name + ' Cutoff', start_date: SUNDAY, end_date: WEDNESDAY });
  await ctx.api.post(`/api/hr/periods/${period.body.id}/employees`).set(hdr()).send({ employee_id: emp.body.id });
  const put = await ctx.api.put(`/api/hr/periods/${period.body.id}/attendance`).set(hdr()).send({
    employee_id: emp.body.id,
    days: [
      { work_date: SUNDAY, time_in: '08:00', time_out: '17:00', notes: '', form_record_ids: sundayForms },
      // Mon/Tue worked so only Sunday and Wednesday are in question.
      { work_date: '2026-08-17', time_in: '08:00', time_out: '17:00', notes: '' },
      { work_date: '2026-08-18', time_in: '08:00', time_out: '17:00', notes: '' },
      { work_date: WEDNESDAY, time_in: '', time_out: '', notes: '' },
    ],
  });
  expect(put.status).toBe(200);
  const grid = await ctx.api.get(`/api/hr/periods/${period.body.id}/attendance`).query({ employee_id: emp.body.id }).set(hdr());
  const gen = await ctx.api.post(`/api/hr/periods/${period.body.id}/generate-payslips`).set(hdr())
    .send({ payroll_period: name + ' Cutoff' });
  expect(gen.status).toBe(201);
  const records = await ctx.api.get(`/api/form-definitions/${gen.body.form_id}/records`)
    .query({ period: name + ' Cutoff' }).set(hdr());
  const rec = records.body.find((r: { data: { employee_name: string } }) => r.data.employee_name === name);
  const byDate = (d: string) => grid.body.find((r: { work_date: string }) => r.work_date === d);
  return { data: rec.data, sunday: byDate(SUNDAY), wednesday: byDate(WEDNESDAY) };
}

describe('Rest Day Work Request + require_rest_day_form', () => {
  it('seeds both rest-day forms, self-fileable from mobile', async () => {
    const types = await ctx.api.get('/api/me/request-types').set(hdr());
    const slugs = types.body.map((t: { slug: string }) => t.slug);
    expect(slugs).toEqual(expect.arrayContaining(['rest_day_work_request', 'rest_day_change']));
    const change = types.body.find((t: { slug: string }) => t.slug === 'rest_day_change');
    expect(change.fields.map((f: { key: string }) => f.key)).toEqual(['employee_name', 'original_rest_day', 'new_rest_day', 'reason']);
  });

  it('policy off (default): a worked rest day pays +30% with no form', async () => {
    await ctx.api.put('/api/hr/payroll-policy').set(hdr()).send(BASE_POLICY);
    const { data } = await runCutoff('RD Off Employee', []);
    expect(data.rest_day_ot).toBeCloseTo(800 * 0.3, 2);
  });

  it('policy on: no premium without a form, none with a PENDING form, paid with an APPROVED one', async () => {
    await ctx.api.put('/api/hr/payroll-policy').set(hdr()).send({ ...BASE_POLICY, require_rest_day_form: true });
    const policy = await ctx.api.get('/api/hr/payroll-policy').set(hdr());
    expect(policy.body.require_rest_day_form).toBe(true);

    const none = await runCutoff('RD None Employee', []);
    expect(none.data.rest_day_ot).toBe(0);
    expect(none.data.days_worked).toBe(3); // still a paid working day, just no premium

    const pendingId = await fileForm('rest_day_work_request', { employee_name: 'RD Pending Employee', work_date: SUNDAY, reason: 'Rush order' }, 'pending');
    const pending = await runCutoff('RD Pending Employee', [pendingId]);
    expect(pending.data.rest_day_ot).toBe(0);

    const approvedId = await fileForm('rest_day_work_request', { employee_name: 'RD Approved Employee', work_date: SUNDAY, reason: 'Rush order' }, 'approved');
    const approved = await runCutoff('RD Approved Employee', [approvedId]);
    expect(approved.data.rest_day_ot).toBeCloseTo(800 * 0.3, 2);
  });
});

describe('Change of Rest Day', () => {
  it('approved + linked: Sunday becomes a working day (no premium) and Wednesday the rest day (not an absence)', async () => {
    await ctx.api.put('/api/hr/payroll-policy').set(hdr()).send(BASE_POLICY);
    const id = await fileForm('rest_day_change', {
      employee_name: 'RD Swap Employee', original_rest_day: SUNDAY, new_rest_day: WEDNESDAY, reason: 'Inventory count',
    }, 'approved');
    const { data, sunday, wednesday } = await runCutoff('RD Swap Employee', [id]);
    expect(sunday.rest_day_swap).toBe('no');
    expect(sunday.rest_day_swap_form_id).toBe(id);
    expect(wednesday.rest_day_swap).toBe('yes');
    expect(data.rest_day_ot).toBe(0);
    expect(data.days_worked).toBe(3);
    expect(data.days_absent).toBe(0); // Wednesday is now the rest day
  });

  it('pending: changes nothing — Sunday still pays the premium, Wednesday is still an absence', async () => {
    await ctx.api.put('/api/hr/payroll-policy').set(hdr()).send(BASE_POLICY);
    const id = await fileForm('rest_day_change', {
      employee_name: 'RD Swap Pending Employee', original_rest_day: SUNDAY, new_rest_day: WEDNESDAY, reason: 'Inventory count',
    }, 'pending');
    const { data, sunday, wednesday } = await runCutoff('RD Swap Pending Employee', [id]);
    expect(sunday.rest_day_swap).toBeNull();
    expect(wednesday.rest_day_swap).toBeNull();
    expect(data.rest_day_ot).toBeCloseTo(800 * 0.3, 2);
    expect(data.days_absent).toBe(1);
  });

  it("HR's per-day Rest Day dropdown still overrides an approved swap", async () => {
    await ctx.api.put('/api/hr/payroll-policy').set(hdr()).send(BASE_POLICY);
    const id = await fileForm('rest_day_change', {
      employee_name: 'RD Swap Override Employee', original_rest_day: SUNDAY, new_rest_day: WEDNESDAY, reason: 'x',
    }, 'approved');
    const emp = { body: (await ctx.api.get('/api/hr/employees').set(hdr())).body.find((e: any) => e.name === 'RD Swap Override Employee') };
    const period = await ctx.api.post('/api/hr/periods').set(hdr())
      .send({ label: 'RD Override Cutoff', start_date: SUNDAY, end_date: SUNDAY });
    await ctx.api.post(`/api/hr/periods/${period.body.id}/employees`).set(hdr()).send({ employee_id: emp.body.id });
    await ctx.api.put(`/api/hr/periods/${period.body.id}/attendance`).set(hdr()).send({
      employee_id: emp.body.id,
      days: [{ work_date: SUNDAY, time_in: '08:00', time_out: '17:00', notes: '', form_record_ids: [id], rest_day: 'yes' }],
    });
    const gen = await ctx.api.post(`/api/hr/periods/${period.body.id}/generate-payslips`).set(hdr())
      .send({ payroll_period: 'RD Override Cutoff' });
    const records = await ctx.api.get(`/api/form-definitions/${gen.body.form_id}/records`)
      .query({ period: 'RD Override Cutoff' }).set(hdr());
    const rec = records.body.find((r: { data: { employee_name: string } }) => r.data.employee_name === 'RD Swap Override Employee');
    expect(rec.data.rest_day_ot).toBeCloseTo(800 * 0.3, 2);
  });
});
