/** HR Time Keeping: employees master list, cutoff periods with a daily time-in/out
    roster, and generating payslips into the (auto-seeded) HR Payroll form. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';

let ctx: TestContext;
let token: string;
const hdr = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  ctx = await setupApp();
  token = await login(ctx.api);
});
afterAll(() => cleanup(ctx));

describe('hr', () => {
  it('requires authentication', async () => {
    expect((await ctx.api.get('/api/hr/employees')).status).toBe(401);
  });

  it('auto-seeds the HR Payroll form definition', async () => {
    const res = await ctx.api.get('/api/form-definitions').set(hdr());
    const hrPayroll = res.body.find((f: { slug: string }) => f.slug === 'hr_payroll');
    expect(hrPayroll).toBeDefined();
    expect(hrPayroll.fields.some((f: { key: string }) => f.key === 'employee_name')).toBe(true);
  });

  it('auto-seeds the No Work Memo form definition too (item 2 — was previously Quick-Add-only, no way to reach it without one first existing)', async () => {
    const res = await ctx.api.get('/api/form-definitions').set(hdr());
    const noWork = res.body.find((f: { slug: string }) => f.slug === 'no_work_memo');
    expect(noWork).toBeDefined();
    expect(noWork.fields.map((f: { key: string }) => f.key)).toEqual(['date_from', 'date_to', 'reason', 'paid']);
  });

  it('auto-seeds the Company Holidays calendar with reference PH holiday dates, editable/deletable like any form record', async () => {
    const defs = await ctx.api.get('/api/form-definitions').set(hdr());
    const holidayForm = defs.body.find((f: { slug: string }) => f.slug === 'company_holiday');
    expect(holidayForm).toBeDefined();
    expect(holidayForm.fields.map((f: { key: string }) => f.key)).toEqual(['date', 'name', 'type']);

    const records = await ctx.api.get(`/api/form-definitions/${holidayForm.id}/records`).set(hdr());
    expect(records.body.length).toBeGreaterThanOrEqual(10);
    const newYears = records.body.find((r: { data: { date: string } }) => r.data.date === '2026-01-01');
    expect(newYears.data.type).toBe('Regular Holiday');
    const chineseNewYear = records.body.find((r: { data: { date: string } }) => r.data.date === '2026-02-17');
    expect(chineseNewYear.data.type).toBe('Special Non-Working Holiday');

    // Admin can freely edit/delete the seeded reference data — no special protection.
    const del = await ctx.api.delete(`/api/form-records/${chineseNewYear.id}`).set(hdr());
    expect(del.status).toBe(200);
  });

  it('auto-seeds Overtime/Undertime/Offset/Holiday Work Request forms — previously hand-create-only, so an install that never got around to it had no way for employees to self-file OT (or for HR to link one) despite the compute engine and mobile REQUEST_SLUGS both already expecting them', async () => {
    const res = await ctx.api.get('/api/form-definitions').set(hdr());
    const bySlug = (slug: string) => res.body.find((f: { slug: string }) => f.slug === slug);

    const ot = bySlug('overtime_request');
    expect(ot).toBeDefined();
    expect(ot.fields.map((f: { key: string }) => f.key)).toEqual(['employee_name', 'work_date', 'hours_estimate', 'reason']);

    const ut = bySlug('undertime_request');
    expect(ut).toBeDefined();
    expect(ut.fields.map((f: { key: string }) => f.key)).toEqual(['employee_name', 'work_date', 'with_pay', 'reason']);

    const offset = bySlug('offset_form');
    expect(offset).toBeDefined();
    expect(offset.fields.map((f: { key: string }) => f.key)).toEqual(['employee_name', 'work_date', 'new_time_out', 'reason']);

    const hw = bySlug('holiday_work_request');
    expect(hw).toBeDefined();
    expect(hw.fields.map((f: { key: string }) => f.key)).toEqual(['employee_name', 'work_date', 'holiday_type', 'hours_worked', 'reason']);

    // All four are now offered on mobile's "New request" screen.
    const types = await ctx.api.get('/api/me/request-types').set(hdr());
    const slugs = types.body.map((t: { slug: string }) => t.slug);
    expect(slugs).toEqual(expect.arrayContaining(['overtime_request', 'undertime_request', 'offset_form', 'holiday_work_request']));
  });

  it('creates and lists an employee with a caller-supplied number, defaulting to probationary status', async () => {
    const res = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: 'TEST-JUAN', name: 'Juan Dela Cruz', position: 'Warehouseman', daily_rate: 610 });
    expect(res.status).toBe(201);
    const list = await ctx.api.get('/api/hr/employees').set(hdr());
    const created = list.body.find((e: { id: number }) => e.id === res.body.id);
    expect(created).toBeDefined();
    expect(created.employee_no).toBe('TEST-JUAN');
    expect(created.status).toBe('probationary');
  });

  it('default_shift_id round-trips through create/update and shows up on the period roster (a UI pre-fill for Daily Time, never enforced)', async () => {
    const shift = await ctx.api.post('/api/hr/shifts').set(hdr())
      .send({ name: 'Default Shift Test', start_time: '08:00', end_time: '17:00', is_default: false });
    const create = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: 'TEST-DEFSHIFT', name: 'Default Shift Employee', daily_rate: 500, default_shift_id: shift.body.id });
    expect(create.status).toBe(201);
    const list = await ctx.api.get('/api/hr/employees').set(hdr());
    const created = list.body.find((e: { id: number }) => e.id === create.body.id);
    expect(created.default_shift_id).toBe(shift.body.id);

    const period = await ctx.api.post('/api/hr/periods').set(hdr())
      .send({ label: 'Default Shift Roster Cutoff', start_date: '2026-08-05', end_date: '2026-08-05' });
    await ctx.api.post(`/api/hr/periods/${period.body.id}/employees`).set(hdr()).send({ employee_id: create.body.id });
    const roster = await ctx.api.get(`/api/hr/periods/${period.body.id}`).set(hdr());
    const rosterRow = roster.body.roster.find((r: { employee_id: number }) => r.employee_id === create.body.id);
    expect(rosterRow.default_shift_id).toBe(shift.body.id); // what dailyGridModal's pre-fill actually reads

    // Clearing it back to null (falls back to whichever shift is marked company-wide default).
    const update = await ctx.api.put(`/api/hr/employees/${create.body.id}`).set(hdr())
      .send({ employee_no: 'TEST-DEFSHIFT', name: 'Default Shift Employee', daily_rate: 500, default_shift_id: null });
    expect(update.status).toBe(200);
    const list2 = await ctx.api.get('/api/hr/employees').set(hdr());
    expect(list2.body.find((e: { id: number }) => e.id === create.body.id).default_shift_id).toBeNull();
  });

  it('rejects creating an employee with a number already in use, and rejects a blank number', async () => {
    const dup = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: 'TEST-JUAN', name: 'Someone Else' });
    expect(dup.status).toBe(409);

    const blank = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: '', name: 'No Number' });
    expect(blank.status).toBe(400);
  });

  it('allows editing an employee number, rejecting a collision with another employee', async () => {
    const a = await ctx.api.post('/api/hr/employees').set(hdr()).send({ employee_no: 'TEST-RENUM-A', name: 'Renumber A' });
    const b = await ctx.api.post('/api/hr/employees').set(hdr()).send({ employee_no: 'TEST-RENUM-B', name: 'Renumber B' });

    const collide = await ctx.api.put(`/api/hr/employees/${b.body.id}`).set(hdr())
      .send({ employee_no: 'TEST-RENUM-A', name: 'Renumber B' });
    expect(collide.status).toBe(409);

    const renamed = await ctx.api.put(`/api/hr/employees/${a.body.id}`).set(hdr())
      .send({ employee_no: 'TEST-RENUM-A2', name: 'Renumber A' });
    expect(renamed.status).toBe(200);
    const detail = (await ctx.api.get('/api/hr/employees').set(hdr())).body.find((e: { id: number }) => e.id === a.body.id);
    expect(detail.employee_no).toBe('TEST-RENUM-A2');
  });

  it('links an employee to a user account, rejects double-linking, allows unlinking, and reflects it on GET', async () => {
    const acct1 = await createEmployee(ctx.api, token, { username: 'link_acct_1' });
    const acct2 = await createEmployee(ctx.api, token, { username: 'link_acct_2' });

    const created = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: 'TEST-LINK-A', name: 'Link Test A', user_id: acct1.id });
    expect(created.status).toBe(201);
    let list = await ctx.api.get('/api/hr/employees').set(hdr());
    let a = list.body.find((e: { id: number }) => e.id === created.body.id);
    expect(a.user_id).toBe(acct1.id);
    expect(a.linked_username).toBe('link_acct_1');

    // A second employee can't claim the same account.
    const clash = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: 'TEST-LINK-B', name: 'Link Test B', user_id: acct1.id });
    expect(clash.status).toBe(409);

    // Linking to a nonexistent user is rejected.
    const missing = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: 'TEST-LINK-C', name: 'Link Test C', user_id: 999999 });
    expect(missing.status).toBe(409);

    // The second employee CAN link to a different, still-free account.
    const b = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: 'TEST-LINK-B', name: 'Link Test B', user_id: acct2.id });
    expect(b.status).toBe(201);

    // Re-saving employee A with its own existing link is fine (not a false self-collision).
    const resave = await ctx.api.put(`/api/hr/employees/${created.body.id}`).set(hdr())
      .send({ employee_no: 'TEST-LINK-A', name: 'Link Test A', user_id: acct1.id });
    expect(resave.status).toBe(200);

    // Employee A can't steal B's account either.
    const stealAttempt = await ctx.api.put(`/api/hr/employees/${created.body.id}`).set(hdr())
      .send({ employee_no: 'TEST-LINK-A', name: 'Link Test A', user_id: acct2.id });
    expect(stealAttempt.status).toBe(409);

    // Unlinking (user_id omitted / null) works.
    const unlink = await ctx.api.put(`/api/hr/employees/${created.body.id}`).set(hdr())
      .send({ employee_no: 'TEST-LINK-A', name: 'Link Test A' });
    expect(unlink.status).toBe(200);
    list = await ctx.api.get('/api/hr/employees').set(hdr());
    a = list.body.find((e: { id: number }) => e.id === created.body.id);
    expect(a.user_id).toBeNull();

    // Now that A is unlinked, acct1 is free again for B to switch to.
    const switchToFreed = await ctx.api.put(`/api/hr/employees/${b.body.id}`).set(hdr())
      .send({ employee_no: 'TEST-LINK-B', name: 'Link Test B', user_id: acct1.id });
    expect(switchToFreed.status).toBe(200);
  });

  it('suggests a sequential number by default, and a hire-date-based one with per-day suffixes once configured', async () => {
    const seq1 = await ctx.api.get('/api/hr/employees/suggest-number').set(hdr());
    expect(seq1.status).toBe(200);
    expect(seq1.body.employee_no).toMatch(/^EMP-\d{5}$/);

    await ctx.api.post('/api/hr/employees').set(hdr()).send({ employee_no: seq1.body.employee_no, name: 'Sequential Suggestion Taker' });
    const seq2 = await ctx.api.get('/api/hr/employees/suggest-number').set(hdr());
    expect(seq2.body.employee_no).not.toBe(seq1.body.employee_no);

    const policyRes = await ctx.api.put('/api/hr/employee-number-policy').set(hdr())
      .send({ prefix: 'HD', mode: 'hire_date', pad: 2, date_format: 'YYYYMMDD' });
    expect(policyRes.status).toBe(200);

    const first = await ctx.api.get('/api/hr/employees/suggest-number').query({ start_date: '2026-03-10' }).set(hdr());
    expect(first.body.employee_no).toBe('HD20260310-01');
    await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: first.body.employee_no, name: 'Hire Date Suggestion A', start_date: '2026-03-10' });

    const second = await ctx.api.get('/api/hr/employees/suggest-number').query({ start_date: '2026-03-10' }).set(hdr());
    expect(second.body.employee_no).toBe('HD20260310-02');

    const otherDay = await ctx.api.get('/api/hr/employees/suggest-number').query({ start_date: '2026-03-11' }).set(hdr());
    expect(otherDay.body.employee_no).toBe('HD20260311-01');

    // Restore the default policy so later tests in this file get their usual EMP-##### suggestions.
    await ctx.api.put('/api/hr/employee-number-policy').set(hdr())
      .send({ prefix: 'EMP', mode: 'sequential', pad: 5, date_format: 'YYYYMMDD' });
  });

  it('accepts the full 201-file field set and a photo data URI, rejects a non-image photo string', async () => {
    const ok = await ctx.api.post('/api/hr/employees').set(hdr()).send({
      employee_no: 'TEST-ROSA', name: 'Rosa Cruz', status: 'regular', start_date: '2020-01-15',
      sss_no: '01-2345678-9', philhealth_no: '12-345678901-2', pagibig_no: '1234-5678-9012', tin_no: '123-456-789-000',
      photo: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    });
    expect(ok.status).toBe(201);
    const detail = (await ctx.api.get('/api/hr/employees').set(hdr())).body.find((e: { id: number }) => e.id === ok.body.id);
    expect(detail.status).toBe('regular');
    expect(detail.sss_no).toBe('01-2345678-9');
    expect(detail.photo).toMatch(/^data:image\//);

    const bad = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: 'TEST-BADPHOTO', name: 'Bad Photo', photo: 'not-an-image' });
    expect(bad.status).toBe(400);
  });

  it('computes the effective daily_rate from a monthly rate using the policy divisor, and rejects a monthly type with no amount', async () => {
    const policy = await ctx.api.get('/api/hr/payroll-policy').set(hdr());
    const divisor = policy.body.monthly_rate_divisor;

    const created = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: 'TEST-MONTHLY', name: 'Monthly Rate Employee', rate_type: 'monthly', monthly_rate: 26000 });
    expect(created.status).toBe(201);
    const detail = (await ctx.api.get('/api/hr/employees').set(hdr())).body.find((e: { id: number }) => e.id === created.body.id);
    expect(detail.rate_type).toBe('monthly');
    expect(detail.monthly_rate).toBe(26000);
    expect(detail.daily_rate).toBeCloseTo(26000 / divisor, 2);

    const missingAmount = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: 'TEST-BADMONTHLY', name: 'Bad Monthly Employee', rate_type: 'monthly' });
    expect(missingAmount.status).toBe(400);

    // Switching an existing employee from monthly back to daily re-derives daily_rate from the plain input.
    const switched = await ctx.api.put(`/api/hr/employees/${created.body.id}`).set(hdr())
      .send({ employee_no: 'TEST-MONTHLY', name: 'Monthly Rate Employee', rate_type: 'daily', daily_rate: 900 });
    expect(switched.status).toBe(200);
    const detailAfter = (await ctx.api.get('/api/hr/employees').set(hdr())).body.find((e: { id: number }) => e.id === created.body.id);
    expect(detailAfter.rate_type).toBe('daily');
    expect(detailAfter.daily_rate).toBe(900);
    expect(detailAfter.monthly_rate).toBeNull();
  });

  it('filters employees by department and status', async () => {
    const dept = await ctx.api.post('/api/users/departments').set(hdr()).send({ name: 'Warehouse Ops' });
    await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: 'TEST-DEPTFILTER', name: 'Dept Filter Test', department_id: dept.body.id, status: 'terminated' });

    const byDept = await ctx.api.get('/api/hr/employees').query({ department_id: dept.body.id }).set(hdr());
    expect(byDept.body.every((e: { department_id: number }) => e.department_id === dept.body.id)).toBe(true);
    expect(byDept.body.length).toBeGreaterThan(0);

    const byStatus = await ctx.api.get('/api/hr/employees').query({ status: 'terminated' }).set(hdr());
    expect(byStatus.body.every((e: { status: string }) => e.status === 'terminated')).toBe(true);
    expect(byStatus.body.some((e: { department_id: number }) => e.department_id === dept.body.id)).toBe(true);
  });

  it('uploads, lists, downloads, and deletes a 201-file document for an employee', async () => {
    const emp = await ctx.api.post('/api/hr/employees').set(hdr()).send({ employee_no: 'TEST-DOCOWNER', name: 'Doc Owner' });

    const upload = await ctx.api.post(`/api/hr/employees/${emp.body.id}/documents`).set(hdr())
      .field('title', 'Employment Contract').attach('file', Buffer.from('dummy pdf bytes'), 'contract.pdf');
    expect(upload.status).toBe(201);

    const list = await ctx.api.get(`/api/hr/employees/${emp.body.id}/documents`).set(hdr());
    expect(list.body).toHaveLength(1);
    expect(list.body[0].title).toBe('Employment Contract');

    const dl = await ctx.api.get(`/api/hr/employees/${emp.body.id}/documents/${upload.body.id}/download`).set(hdr());
    expect(dl.status).toBe(200);
    expect(Buffer.from(dl.body).toString()).toBe('dummy pdf bytes');

    const del = await ctx.api.delete(`/api/hr/employees/${emp.body.id}/documents/${upload.body.id}`).set(hdr());
    expect(del.status).toBe(200);
    const listAfter = await ctx.api.get(`/api/hr/employees/${emp.body.id}/documents`).set(hdr());
    expect(listAfter.body).toHaveLength(0);
  });

  it('creates a cutoff, adds an employee, and pre-populates blank day rows for the range', async () => {
    const emp = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: 'TEST-MARIA', name: 'Maria Santos', daily_rate: 700 });
    const period = await ctx.api.post('/api/hr/periods').set(hdr())
      .send({ label: 'Aug 1-5, 2026', start_date: '2026-08-01', end_date: '2026-08-05' });
    expect(period.status).toBe(201);

    const add = await ctx.api.post(`/api/hr/periods/${period.body.id}/employees`).set(hdr())
      .send({ employee_id: emp.body.id });
    expect(add.status).toBe(201);

    const detail = await ctx.api.get(`/api/hr/periods/${period.body.id}`).set(hdr());
    expect(detail.body.roster).toHaveLength(1);
    expect(detail.body.roster[0].days_total).toBe(5); // Aug 1..5 inclusive

    const days = await ctx.api.get(`/api/hr/periods/${period.body.id}/attendance?employee_id=${emp.body.id}`).set(hdr());
    expect(days.body.map((d: { work_date: string }) => d.work_date)).toEqual([
      '2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05',
    ]);
    expect(days.body.every((d: { time_in: string | null }) => d.time_in === null)).toBe(true);
  });

  it('bulk-adds employees to a cutoff by explicit ids, and separately by department/status filter, idempotently', async () => {
    const dept = await ctx.api.post('/api/users/departments').set(hdr()).send({ name: 'Bulk Add Dept' });
    const a = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: 'TEST-BULK-A', name: 'Bulk A', department_id: dept.body.id, status: 'regular' });
    const b = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: 'TEST-BULK-B', name: 'Bulk B', department_id: dept.body.id, status: 'regular' });
    const c = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: 'TEST-BULK-C', name: 'Bulk C', department_id: dept.body.id, status: 'terminated' });
    const period = await ctx.api.post('/api/hr/periods').set(hdr())
      .send({ label: 'Bulk Add Cutoff', start_date: '2026-09-01', end_date: '2026-09-02' });

    // Explicit id list.
    const byIds = await ctx.api.post(`/api/hr/periods/${period.body.id}/employees/bulk`).set(hdr())
      .send({ employee_ids: [a.body.id, b.body.id] });
    expect(byIds.status).toBe(201);
    expect(byIds.body).toEqual({ added: 2, matched: 2 });

    // Re-adding the same two (plus a new one, c) by department filter — a/b are already on the
    // roster so only c should count as newly added, even though 3 employees match the filter.
    const byDept = await ctx.api.post(`/api/hr/periods/${period.body.id}/employees/bulk`).set(hdr())
      .send({ department_id: dept.body.id });
    expect(byDept.status).toBe(201);
    expect(byDept.body).toEqual({ added: 1, matched: 3 });

    const detail = await ctx.api.get(`/api/hr/periods/${period.body.id}`).set(hdr());
    expect(detail.body.roster).toHaveLength(3);
    expect(detail.body.roster.map((r: { name: string }) => r.name).sort()).toEqual(['Bulk A', 'Bulk B', 'Bulk C']);

    // Status filter narrows further: only the terminated one (c) is already on the roster.
    const period2 = await ctx.api.post('/api/hr/periods').set(hdr())
      .send({ label: 'Bulk Add Cutoff 2', start_date: '2026-09-03', end_date: '2026-09-03' });
    const byStatus = await ctx.api.post(`/api/hr/periods/${period2.body.id}/employees/bulk`).set(hdr())
      .send({ department_id: dept.body.id, status: 'terminated' });
    expect(byStatus.body).toEqual({ added: 1, matched: 1 });
  });

  it('saves daily time-in/out for an employee, replacing prior rows', async () => {
    const emp = await ctx.api.post('/api/hr/employees').set(hdr()).send({ employee_no: 'TEST-PEDRO', name: 'Pedro Reyes' });
    const period = await ctx.api.post('/api/hr/periods').set(hdr())
      .send({ label: 'Aug 6-7, 2026', start_date: '2026-08-06', end_date: '2026-08-07' });
    await ctx.api.post(`/api/hr/periods/${period.body.id}/employees`).set(hdr()).send({ employee_id: emp.body.id });

    const save = await ctx.api.put(`/api/hr/periods/${period.body.id}/attendance`).set(hdr()).send({
      employee_id: emp.body.id,
      days: [
        { work_date: '2026-08-06', time_in: '08:00', time_out: '17:00', notes: '' },
        { work_date: '2026-08-07', time_in: '08:15', time_out: '17:05', notes: 'late' },
      ],
    });
    expect(save.status).toBe(200);

    const days = await ctx.api.get(`/api/hr/periods/${period.body.id}/attendance?employee_id=${emp.body.id}`).set(hdr());
    expect(days.body).toHaveLength(2);
    expect(days.body[0].time_in).toBe('08:00');
    expect(days.body[1].notes).toBe('late');

    const detail = await ctx.api.get(`/api/hr/periods/${period.body.id}`).set(hdr());
    expect(detail.body.roster[0].days_logged).toBe(2);
  });

  it('generates payslips into the HR Payroll form, then updates on a second call instead of duplicating', async () => {
    const emp = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: 'TEST-ANALIM', name: 'Ana Lim', position: 'Clerk', daily_rate: 650 });
    const period = await ctx.api.post('/api/hr/periods').set(hdr())
      .send({ label: 'Aug 8-9, 2026', start_date: '2026-08-08', end_date: '2026-08-09' });
    await ctx.api.post(`/api/hr/periods/${period.body.id}/employees`).set(hdr()).send({ employee_id: emp.body.id });

    const gen1 = await ctx.api.post(`/api/hr/periods/${period.body.id}/generate-payslips`).set(hdr())
      .send({ payroll_period: 'Aug 8-9, 2026', pay_date: '2026-08-10' });
    expect(gen1.status).toBe(201);
    expect(gen1.body.created).toBe(1);
    expect(gen1.body.updated).toBe(0);

    const records = await ctx.api.get(`/api/form-definitions/${gen1.body.form_id}/records`).query({ period: 'Aug 8-9, 2026' }).set(hdr());
    expect(records.body).toHaveLength(1);
    expect(records.body[0].data.employee_name).toBe('Ana Lim');
    expect(records.body[0].data.daily_rate).toBe(650);
    expect(records.body[0].data.pay_date).toBe('2026-08-10');

    const gen2 = await ctx.api.post(`/api/hr/periods/${period.body.id}/generate-payslips`).set(hdr())
      .send({ payroll_period: 'Aug 8-9, 2026' });
    expect(gen2.body.created).toBe(0);
    expect(gen2.body.updated).toBe(1);

    const recordsAfter = await ctx.api.get(`/api/form-definitions/${gen1.body.form_id}/records`).query({ period: 'Aug 8-9, 2026' }).set(hdr());
    expect(recordsAfter.body).toHaveLength(1); // still one record, not duplicated
  });

  it('blocks deleting an employee with attendance history (409), deleting is fine otherwise', async () => {
    const emp = await ctx.api.post('/api/hr/employees').set(hdr()).send({ employee_no: 'TEST-HASHISTORY', name: 'Has History' });
    const period = await ctx.api.post('/api/hr/periods').set(hdr())
      .send({ label: 'Aug 20-21, 2026', start_date: '2026-08-20', end_date: '2026-08-21' });
    await ctx.api.post(`/api/hr/periods/${period.body.id}/employees`).set(hdr()).send({ employee_id: emp.body.id });

    const blocked = await ctx.api.delete(`/api/hr/employees/${emp.body.id}`).set(hdr());
    expect(blocked.status).toBe(409);

    const noHistory = await ctx.api.post('/api/hr/employees').set(hdr()).send({ employee_no: 'TEST-NOHISTORY', name: 'No History' });
    const ok = await ctx.api.delete(`/api/hr/employees/${noHistory.body.id}`).set(hdr());
    expect(ok.status).toBe(200);
  });

  it('rejects generating payslips for a cutoff with no roster', async () => {
    const period = await ctx.api.post('/api/hr/periods').set(hdr())
      .send({ label: 'Empty cutoff', start_date: '2026-09-01', end_date: '2026-09-02' });
    const res = await ctx.api.post(`/api/hr/periods/${period.body.id}/generate-payslips`).set(hdr())
      .send({ payroll_period: 'Empty cutoff' });
    expect(res.status).toBe(400);
  });

  it('enforces hr.manage on writes for a non-HR role, while hr.view allows reads', async () => {
    const csr = await createEmployee(ctx.api, token, { role: 'csr' });
    const readRes = await ctx.api.get('/api/hr/employees').set({ Authorization: `Bearer ${csr.token}` });
    expect(readRes.status).toBe(403); // csr has neither hr.view nor hr.manage by default

    const hrUser = await createEmployee(ctx.api, token, { role: 'hr' });
    const hrRead = await ctx.api.get('/api/hr/employees').set({ Authorization: `Bearer ${hrUser.token}` });
    expect(hrRead.status).toBe(200);
    const hrWrite = await ctx.api.post('/api/hr/employees').set({ Authorization: `Bearer ${hrUser.token}` })
      .send({ employee_no: 'TEST-HRROLE', name: 'Created by HR role' });
    expect(hrWrite.status).toBe(201);
  });
});

describe('shifts', () => {
  let shiftId: number;

  it('creates and lists a shift', async () => {
    const res = await ctx.api.post('/api/hr/shifts').set(hdr())
      .send({ name: 'Morning', start_time: '08:00', end_time: '17:00', is_default: true });
    expect(res.status).toBe(201);
    shiftId = res.body.id;
    const list = await ctx.api.get('/api/hr/shifts').set(hdr());
    const found = list.body.find((s: { id: number }) => s.id === shiftId);
    expect(found).toBeDefined();
    expect(found.is_default).toBe(true);
  });

  it('marking a second shift default un-defaults the first', async () => {
    const res = await ctx.api.post('/api/hr/shifts').set(hdr())
      .send({ name: 'Night', start_time: '22:00', end_time: '06:00', is_default: true });
    expect(res.status).toBe(201);
    const list = await ctx.api.get('/api/hr/shifts').set(hdr());
    const morning = list.body.find((s: { id: number }) => s.id === shiftId);
    const night = list.body.find((s: { id: number }) => s.id === res.body.id);
    expect(morning.is_default).toBe(false);
    expect(night.is_default).toBe(true);
  });

  it('updates and deletes a shift', async () => {
    const upd = await ctx.api.put(`/api/hr/shifts/${shiftId}`).set(hdr())
      .send({ name: 'Morning Updated', start_time: '07:00', end_time: '16:00', is_default: false });
    expect(upd.status).toBe(200);
    const del = await ctx.api.delete(`/api/hr/shifts/${shiftId}`).set(hdr());
    expect(del.status).toBe(200);
    const list = await ctx.api.get('/api/hr/shifts').set(hdr());
    expect(list.body.find((s: { id: number }) => s.id === shiftId)).toBeUndefined();
  });

  it('rejects an invalid time format', async () => {
    const res = await ctx.api.post('/api/hr/shifts').set(hdr())
      .send({ name: 'Bad', start_time: '25:00', end_time: '17:00' });
    expect(res.status).toBe(400);
  });

  it('requires hr.manage to write; hr.view is enough to read', async () => {
    const csr = await createEmployee(ctx.api, token, { role: 'csr' });
    const write = await ctx.api.post('/api/hr/shifts').set({ Authorization: `Bearer ${csr.token}` })
      .send({ name: 'X', start_time: '08:00', end_time: '17:00' });
    expect(write.status).toBe(403);
    const hrUser = await createEmployee(ctx.api, token, { role: 'hr' });
    const read = await ctx.api.get('/api/hr/shifts').set({ Authorization: `Bearer ${hrUser.token}` });
    expect(read.status).toBe(200);
  });
});

describe('payroll policy', () => {
  it('returns sensible defaults when unset', async () => {
    const res = await ctx.api.get('/api/hr/payroll-policy').set(hdr());
    expect(res.status).toBe(200);
    expect(res.body.grace_minutes).toBe(10);
    expect(res.body.ot_rate_percent).toBe(125);
    expect(res.body.monthly_rate_divisor).toBe(26);
  });

  it('admin can update the policy, reflected on GET', async () => {
    const res = await ctx.api.put('/api/hr/payroll-policy').set(hdr()).send({
      grace_minutes: 5, late_unit: 'minute', ot_unit: '30min', ot_rate_percent: 150,
      night_diff_enabled: true, night_diff_percent: 15, night_start: '21:00', night_end: '05:00',
      monthly_rate_divisor: 22,
    });
    expect(res.status).toBe(200);
    const detail = await ctx.api.get('/api/hr/payroll-policy').set(hdr());
    expect(detail.body.grace_minutes).toBe(5);
    expect(detail.body.ot_rate_percent).toBe(150);
    expect(detail.body.night_diff_enabled).toBe(true);
    expect(detail.body.monthly_rate_divisor).toBe(22);

    // A monthly-rate employee saved AFTER this policy change picks up the new divisor.
    const emp = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: 'TEST-DIVISOR', name: 'Divisor Test Employee', rate_type: 'monthly', monthly_rate: 22000 });
    const empDetail = (await ctx.api.get('/api/hr/employees').set(hdr())).body.find((e: { id: number }) => e.id === emp.body.id);
    expect(empDetail.daily_rate).toBeCloseTo(1000, 2); // 22000 / 22

    // Restore the default divisor so later tests in this file aren't affected.
    await ctx.api.put('/api/hr/payroll-policy').set(hdr()).send({
      grace_minutes: 5, late_unit: 'minute', ot_unit: '30min', ot_rate_percent: 150,
      night_diff_enabled: true, night_diff_percent: 15, night_start: '21:00', night_end: '05:00',
      monthly_rate_divisor: 26,
    });
  });

  it('requires hr.manage to write', async () => {
    const csr = await createEmployee(ctx.api, token, { role: 'csr' });
    const res = await ctx.api.put('/api/hr/payroll-policy').set({ Authorization: `Bearer ${csr.token}` }).send({});
    expect(res.status).toBe(403);
  });
});

describe('generate-payslips computes real numbers from attendance + linked forms', () => {
  let morningShiftId: number;
  let overtimeFormId: number;
  let leaveFormId: number;
  let noWorkFormId: number;

  // Self-contained known policy — doesn't rely on (or get affected by) whatever the
  // 'payroll policy' describe block above left the settings at.
  beforeAll(async () => {
    await ctx.api.put('/api/hr/payroll-policy').set(hdr()).send({
      grace_minutes: 10, late_unit: 'hour', ot_unit: 'hour', ot_rate_percent: 125,
      night_diff_enabled: false, night_diff_percent: 10, night_start: '22:00', night_end: '06:00',
      // No rest days here — several fixture dates below land on a real-calendar Sat/Sun and
      // these tests are about OT/late/leave, not rest-day pay (that's its own describe block).
      default_rest_days: [],
    });
    const shift = await ctx.api.post('/api/hr/shifts').set(hdr())
      .send({ name: 'Compute Test Shift', start_time: '08:00', end_time: '17:00', is_default: false });
    morningShiftId = shift.body.id;

    // Overtime Request is auto-seeded now (src/db.ts's seedHrRequestForms()), same as
    // hr_payroll/no_work_memo — just look it up instead of creating it.
    const otForms = await ctx.api.get('/api/form-definitions').set(hdr());
    overtimeFormId = otForms.body.find((f: { slug: string }) => f.slug === 'overtime_request').id;

    const leaveForm = await ctx.api.post('/api/form-definitions').set(hdr()).send({
      name: 'Leave Request', slug: 'leave_request', number_prefix: 'LV', icon: 'calendar', scope: 'hr',
      fields: [
        { key: 'employee_name', label: 'Employee Name', type: 'text', required: true, options: [], default: '' },
        { key: 'with_pay', label: 'With Pay?', type: 'select', required: true, options: ['Yes', 'No'], default: '' },
      ],
    });
    leaveFormId = leaveForm.body.id;

    // No Work Memo is auto-seeded now (item 2 — src/db.ts's seedNoWorkMemoForm(), same as
    // hr_payroll always has been) rather than created by hand like the other forms above, so
    // POST-ing one here would 500 on the slug's UNIQUE constraint — just look it up.
    const noWorkForm = (await ctx.api.get('/api/form-definitions').set(hdr()))
      .body.find((f: { slug: string }) => f.slug === 'no_work_memo');
    noWorkFormId = noWorkForm.id;
  });

  it('computes days worked, a late deduction, and authorized OT pay from attendance + a linked overtime form', async () => {
    const emp = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: 'TEST-COMPUTE', name: 'Compute Test Employee', daily_rate: 800 }); // hourly = 100
    const period = await ctx.api.post('/api/hr/periods').set(hdr())
      .send({ label: 'Compute Cutoff', start_date: '2026-08-01', end_date: '2026-08-02' });
    await ctx.api.post(`/api/hr/periods/${period.body.id}/employees`).set(hdr()).send({ employee_id: emp.body.id });

    const otRecord = await ctx.api.post('/api/form-records').set(hdr())
      .send({ form_def_id: overtimeFormId, data: { employee_name: 'Compute Test Employee' }, status: 'approved' });

    await ctx.api.put(`/api/hr/periods/${period.body.id}/attendance`).set(hdr()).send({
      employee_id: emp.body.id,
      days: [
        // 70 min late (shift 08:00-17:00, 10 min grace -> 60 min past grace -> 1-hour block)
        { work_date: '2026-08-01', time_in: '09:10', time_out: '17:00', notes: '', shift_id: morningShiftId, form_record_id: null },
        // On time, 1 hour of authorized OT
        { work_date: '2026-08-02', time_in: '08:00', time_out: '18:00', notes: '', shift_id: morningShiftId, form_record_id: otRecord.body.id },
      ],
    });

    const gen = await ctx.api.post(`/api/hr/periods/${period.body.id}/generate-payslips`).set(hdr())
      .send({ payroll_period: 'Compute Cutoff' });
    expect(gen.status).toBe(201);

    const records = await ctx.api.get(`/api/form-definitions/${gen.body.form_id}/records`).query({ period: 'Compute Cutoff' }).set(hdr());
    const rec = records.body.find((r: { data: { employee_name: string } }) => r.data.employee_name === 'Compute Test Employee');
    expect(rec.data.days_worked).toBe(2);
    expect(rec.data.late_absences).toBeCloseTo(100, 6); // 1 hour * 100/hr
    expect(rec.data.ot_hours).toBeCloseTo(1, 6);
    expect(rec.data.overtime_pay).toBeCloseTo(125, 6); // 1hr * 100 * 1.25
    expect(rec.data.ot_rate_hour).toBeCloseTo(125, 6); // auto-computed now: 100/hr * 125% — no more hand-typing it
    expect(rec.data.basic_salary).toBeCloseTo(1600, 6); // 800 * 2 days
    expect(rec.data.total_earnings).toBeCloseTo(1600 + 125, 6);
  });

  it('a day linked to a with-pay Leave form counts as a paid day despite no time logged', async () => {
    const emp = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: 'TEST-LEAVE', name: 'Leave Test Employee', daily_rate: 800 });
    const period = await ctx.api.post('/api/hr/periods').set(hdr())
      .send({ label: 'Leave Cutoff', start_date: '2026-08-03', end_date: '2026-08-03' });
    await ctx.api.post(`/api/hr/periods/${period.body.id}/employees`).set(hdr()).send({ employee_id: emp.body.id });

    const leaveRecord = await ctx.api.post('/api/form-records').set(hdr())
      .send({ form_def_id: leaveFormId, data: { employee_name: 'Leave Test Employee', with_pay: 'Yes' }, status: 'approved' });

    await ctx.api.put(`/api/hr/periods/${period.body.id}/attendance`).set(hdr()).send({
      employee_id: emp.body.id,
      days: [{ work_date: '2026-08-03', time_in: '', time_out: '', notes: '', form_record_id: leaveRecord.body.id }],
    });

    const gen = await ctx.api.post(`/api/hr/periods/${period.body.id}/generate-payslips`).set(hdr())
      .send({ payroll_period: 'Leave Cutoff' });
    const records = await ctx.api.get(`/api/form-definitions/${gen.body.form_id}/records`).query({ period: 'Leave Cutoff' }).set(hdr());
    const rec = records.body.find((r: { data: { employee_name: string } }) => r.data.employee_name === 'Leave Test Employee');
    expect(rec.data.days_worked).toBe(1);
    expect(rec.data.basic_salary).toBeCloseTo(800, 6);
  });

  it('a genuine unexplained absence shows up as days_absent, doesn\'t touch late_absences, and correctly lowers basic_salary via days_worked', async () => {
    const emp = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: 'TEST-ABSENT', name: 'Absent Test Employee', daily_rate: 800 });
    const period = await ctx.api.post('/api/hr/periods').set(hdr())
      .send({ label: 'Absent Cutoff', start_date: '2026-08-04', end_date: '2026-08-05' });
    await ctx.api.post(`/api/hr/periods/${period.body.id}/employees`).set(hdr()).send({ employee_id: emp.body.id });

    await ctx.api.put(`/api/hr/periods/${period.body.id}/attendance`).set(hdr()).send({
      employee_id: emp.body.id,
      days: [
        // Worked, on time.
        { work_date: '2026-08-04', time_in: '08:00', time_out: '17:00', notes: '', shift_id: morningShiftId, form_record_id: null },
        // No time logged, nothing linked -> a genuine absence.
        { work_date: '2026-08-05', time_in: '', time_out: '', notes: '', form_record_id: null },
      ],
    });

    const gen = await ctx.api.post(`/api/hr/periods/${period.body.id}/generate-payslips`).set(hdr())
      .send({ payroll_period: 'Absent Cutoff' });
    const records = await ctx.api.get(`/api/form-definitions/${gen.body.form_id}/records`).query({ period: 'Absent Cutoff' }).set(hdr());
    const rec = records.body.find((r: { data: { employee_name: string } }) => r.data.employee_name === 'Absent Test Employee');
    expect(rec.data.days_worked).toBe(1); // only the day actually worked
    expect(rec.data.days_absent).toBe(1); // the absence, now visible instead of silent
    expect(rec.data.late_absences).toBe(0); // no lateness that day — the absence itself isn't in this field
    expect(rec.data.basic_salary).toBeCloseTo(800, 6); // 1 paid day, not 2 — the absence already isn't paid
  });

  it('GET /periods/:id/attendance/export downloads the whole cutoff as CSV, one row per employee per day (item 1)', async () => {
    const emp = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: 'TEST-CSV-EXPORT', name: 'CSV Export Employee', daily_rate: 500 });
    const period = await ctx.api.post('/api/hr/periods').set(hdr())
      .send({ label: 'CSV Export Cutoff', start_date: '2026-08-06', end_date: '2026-08-06' });
    await ctx.api.post(`/api/hr/periods/${period.body.id}/employees`).set(hdr()).send({ employee_id: emp.body.id });
    await ctx.api.put(`/api/hr/periods/${period.body.id}/attendance`).set(hdr()).send({
      employee_id: emp.body.id,
      days: [{ work_date: '2026-08-06', time_in: '08:00', time_out: '', notes: 'forgot to clock out' }],
    });

    const res = await ctx.api.get(`/api/hr/periods/${period.body.id}/attendance/export`).set(hdr());
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(res.text).toContain('CSV Export Employee');
    expect(res.text).toContain('2026-08-06');
    expect(res.text).toContain('Incomplete'); // time_in with no time_out
    expect(res.text).toContain('forgot to clock out');

    expect((await ctx.api.get('/api/hr/periods/999999/attendance/export').set(hdr())).status).toBe(404);
  });

  it('regenerating refreshes computed fields (including rest-day OT, now attendance-derived) but preserves purely-manual ones (cash advance)', async () => {
    const emp = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: 'TEST-REGEN', name: 'Regen Test Employee', daily_rate: 800 });
    const period = await ctx.api.post('/api/hr/periods').set(hdr())
      .send({ label: 'Regen Cutoff', start_date: '2026-08-04', end_date: '2026-08-04' });
    await ctx.api.post(`/api/hr/periods/${period.body.id}/employees`).set(hdr()).send({ employee_id: emp.body.id });
    await ctx.api.put(`/api/hr/periods/${period.body.id}/attendance`).set(hdr()).send({
      employee_id: emp.body.id,
      days: [{ work_date: '2026-08-04', time_in: '08:00', time_out: '17:00', notes: '', shift_id: morningShiftId }],
    });

    const gen1 = await ctx.api.post(`/api/hr/periods/${period.body.id}/generate-payslips`).set(hdr())
      .send({ payroll_period: 'Regen Cutoff' });
    const records1 = await ctx.api.get(`/api/form-definitions/${gen1.body.form_id}/records`).query({ period: 'Regen Cutoff' }).set(hdr());
    const rec1 = records1.body.find((r: { data: { employee_name: string } }) => r.data.employee_name === 'Regen Test Employee');
    expect(rec1.data.rest_day_ot).toBe(0); // 2026-08-04 is a Tuesday and this describe block's policy has no rest days

    // cash_advance has no computed source, so it's still carried over untouched. rest_day_ot
    // DOES have a computed source now (attendance-derived, see hr-payroll-compute.ts) — a
    // manual edit to it is overwritten on the next regenerate, same as overtime_pay already was.
    await ctx.api.put(`/api/form-records/${rec1.id}`).set(hdr()).send({ data: { ...rec1.data, cash_advance: 500, rest_day_ot: 250 } });

    const gen2 = await ctx.api.post(`/api/hr/periods/${period.body.id}/generate-payslips`).set(hdr())
      .send({ payroll_period: 'Regen Cutoff' });
    expect(gen2.body.updated).toBe(1);
    const records2 = await ctx.api.get(`/api/form-definitions/${gen1.body.form_id}/records`).query({ period: 'Regen Cutoff' }).set(hdr());
    const rec2 = records2.body.find((r: { data: { employee_name: string } }) => r.data.employee_name === 'Regen Test Employee');
    expect(rec2.data.cash_advance).toBe(500);
    expect(rec2.data.rest_day_ot).toBe(0);
    expect(rec2.data.days_worked).toBe(1);
  });

  it('computes SSS / PhilHealth / Pag-IBIG / withholding tax; auto_statutory:false keeps them manual', async () => {
    const emp = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: 'TEST-STAT', name: 'Statutory Employee', daily_rate: 1000 }); // ~26k/mo
    const period = await ctx.api.post('/api/hr/periods').set(hdr())
      .send({ label: 'Stat Cutoff', start_date: '2026-08-04', end_date: '2026-08-04' });
    await ctx.api.post(`/api/hr/periods/${period.body.id}/employees`).set(hdr()).send({ employee_id: emp.body.id });
    await ctx.api.put(`/api/hr/periods/${period.body.id}/attendance`).set(hdr()).send({
      employee_id: emp.body.id,
      days: [{ work_date: '2026-08-04', time_in: '08:00', time_out: '17:00', notes: '', shift_id: morningShiftId }],
    });

    const gen = await ctx.api.post(`/api/hr/periods/${period.body.id}/generate-payslips`).set(hdr())
      .send({ payroll_period: 'Stat Cutoff', pay_date: '2026-08-10' });
    const recs = await ctx.api.get(`/api/form-definitions/${gen.body.form_id}/records`).query({ period: 'Stat Cutoff' }).set(hdr());
    const rec = recs.body.find((r: { data: { employee_name: string } }) => r.data.employee_name === 'Statutory Employee');

    // monthly comp = 1000 * 26 = 26,000 -> MSC 26,000; semi-monthly split (/2)
    expect(rec.data.sss).toBe(650);         // 26000*0.05 / 2
    expect(rec.data.philhealth).toBe(325);  // 26000*0.05*0.5 / 2
    expect(rec.data.pagibig).toBe(100);     // min(10000*0.02,200) / 2
    expect(rec.data.withholding_tax).toBeGreaterThanOrEqual(0);
    expect(rec.data.total_deductions).toBe(
      Math.round((rec.data.sss + rec.data.philhealth + rec.data.pagibig + rec.data.withholding_tax + rec.data.late_absences + 0) * 100) / 100
    );
    expect(rec.data.net_pay).toBe(Math.round((rec.data.total_earnings - rec.data.total_deductions) * 100) / 100);

    // Turn auto off, set a manual value, regenerate -> preserved.
    await ctx.api.put('/api/hr/payroll-policy').set(hdr()).send({ auto_statutory: false });
    await ctx.api.put(`/api/form-records/${rec.id}`).set(hdr()).send({ data: { ...rec.data, sss: 999, net_pay: 12345 } });
    await ctx.api.post(`/api/hr/periods/${period.body.id}/generate-payslips`).set(hdr()).send({ payroll_period: 'Stat Cutoff' });
    const recs2 = await ctx.api.get(`/api/form-definitions/${gen.body.form_id}/records`).query({ period: 'Stat Cutoff' }).set(hdr());
    const rec2 = recs2.body.find((r: { data: { employee_name: string } }) => r.data.employee_name === 'Statutory Employee');
    expect(rec2.data.sss).toBe(999);
    expect(rec2.data.net_pay).toBe(12345);
    await ctx.api.put('/api/hr/payroll-policy').set(hdr()).send({ auto_statutory: true }); // restore for other tests
  });

  it('per-employee statutory switch (Accounting) zeroes that deduction on the next payslip', async () => {
    const emp = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: 'TEST-SDFLAG', name: 'SD Flag Employee', daily_rate: 1000 });
    // Accounting turns SSS + withholding off for this employee, leaves PhilHealth/Pag-IBIG on.
    const put = await ctx.api.put('/api/accounting/statutory-deductions').set(hdr())
      .send({ updates: [{ employee_id: emp.body.id, deduct_sss: false, deduct_withholding_tax: false }] });
    expect(put.status).toBe(200);

    const period = await ctx.api.post('/api/hr/periods').set(hdr())
      .send({ label: 'SD Flag Cutoff', start_date: '2026-08-05', end_date: '2026-08-05' });
    await ctx.api.post(`/api/hr/periods/${period.body.id}/employees`).set(hdr()).send({ employee_id: emp.body.id });
    await ctx.api.put(`/api/hr/periods/${period.body.id}/attendance`).set(hdr()).send({
      employee_id: emp.body.id,
      days: [{ work_date: '2026-08-05', time_in: '08:00', time_out: '17:00', notes: '', shift_id: morningShiftId }],
    });
    const gen = await ctx.api.post(`/api/hr/periods/${period.body.id}/generate-payslips`).set(hdr())
      .send({ payroll_period: 'SD Flag Cutoff', pay_date: '2026-08-10' });
    const recs = await ctx.api.get(`/api/form-definitions/${gen.body.form_id}/records`).query({ period: 'SD Flag Cutoff' }).set(hdr());
    const rec = recs.body.find((r: { data: { employee_name: string } }) => r.data.employee_name === 'SD Flag Employee');

    expect(rec.data.sss).toBe(0);
    expect(rec.data.withholding_tax).toBe(0);
    expect(rec.data.philhealth).toBe(325);  // still deducted
    expect(rec.data.pagibig).toBe(100);
    expect(rec.data.total_deductions).toBe(
      Math.round((0 + rec.data.philhealth + rec.data.pagibig + 0 + rec.data.late_absences + 0) * 100) / 100
    );

    // ...and the SSS schedule for that month no longer lists this employee.
    const sched = await ctx.api.get('/api/accounting/contribution-schedule').query({ month: '2026-08', agency: 'sss' }).set(hdr());
    expect(sched.body.rows.some((x: { name: string }) => x.name === 'SD Flag Employee')).toBe(false);
    const phic = await ctx.api.get('/api/accounting/contribution-schedule').query({ month: '2026-08', agency: 'philhealth' }).set(hdr());
    expect(phic.body.rows.some((x: { name: string }) => x.name === 'SD Flag Employee')).toBe(true);
  });

  it('rotating shifts: the same employee can have a different shift on different days within one cutoff', async () => {
    const nightShift = await ctx.api.post('/api/hr/shifts').set(hdr())
      .send({ name: 'Rotate Night', start_time: '22:00', end_time: '06:00', is_default: false });
    const emp = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: 'TEST-ROTATE', name: 'Rotating Employee', daily_rate: 800 });
    const period = await ctx.api.post('/api/hr/periods').set(hdr())
      .send({ label: 'Rotate Cutoff', start_date: '2026-08-05', end_date: '2026-08-06' });
    await ctx.api.post(`/api/hr/periods/${period.body.id}/employees`).set(hdr()).send({ employee_id: emp.body.id });

    await ctx.api.put(`/api/hr/periods/${period.body.id}/attendance`).set(hdr()).send({
      employee_id: emp.body.id,
      days: [
        { work_date: '2026-08-05', time_in: '08:00', time_out: '17:00', notes: '', shift_id: morningShiftId },
        { work_date: '2026-08-06', time_in: '22:00', time_out: '06:00', notes: '', shift_id: nightShift.body.id },
      ],
    });

    const gen = await ctx.api.post(`/api/hr/periods/${period.body.id}/generate-payslips`).set(hdr())
      .send({ payroll_period: 'Rotate Cutoff' });
    const records = await ctx.api.get(`/api/form-definitions/${gen.body.form_id}/records`).query({ period: 'Rotate Cutoff' }).set(hdr());
    const rec = records.body.find((r: { data: { employee_name: string } }) => r.data.employee_name === 'Rotating Employee');
    expect(rec.data.days_worked).toBe(2);
    expect(rec.data.late_absences).toBe(0); // on time both days, per each day's own shift
  });

  it('a company-wide PAID No Work Memo excuses an absence automatically, with no per-employee linking', async () => {
    await ctx.api.post('/api/form-records').set(hdr()).send({
      form_def_id: noWorkFormId,
      data: { date_from: '2026-08-10', date_to: '2026-08-10', reason: 'Typhoon suspension', paid: 'Yes' },
      status: 'approved',
    });
    const emp = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: 'TEST-NOWORK', name: 'No Work Test Employee', daily_rate: 800 });
    const period = await ctx.api.post('/api/hr/periods').set(hdr())
      .send({ label: 'No Work Cutoff', start_date: '2026-08-10', end_date: '2026-08-10' });
    await ctx.api.post(`/api/hr/periods/${period.body.id}/employees`).set(hdr()).send({ employee_id: emp.body.id });
    // Nothing logged, no Leave form filed, no linking of any kind to the memo — should still be excused.
    await ctx.api.put(`/api/hr/periods/${period.body.id}/attendance`).set(hdr()).send({
      employee_id: emp.body.id,
      days: [{ work_date: '2026-08-10', time_in: '', time_out: '', notes: '' }],
    });

    const gen = await ctx.api.post(`/api/hr/periods/${period.body.id}/generate-payslips`).set(hdr())
      .send({ payroll_period: 'No Work Cutoff' });
    const records = await ctx.api.get(`/api/form-definitions/${gen.body.form_id}/records`).query({ period: 'No Work Cutoff' }).set(hdr());
    const rec = records.body.find((r: { data: { employee_name: string } }) => r.data.employee_name === 'No Work Test Employee');
    expect(rec.data.days_worked).toBe(1);
    expect(rec.data.basic_salary).toBeCloseTo(800, 6);
  });

  it('an UNPAID No Work Memo does not credit the day, but is still not a Leave-form-based absence', async () => {
    await ctx.api.post('/api/form-records').set(hdr()).send({
      form_def_id: noWorkFormId,
      data: { date_from: '2026-08-11', date_to: '2026-08-11', reason: 'Unpaid facility closure', paid: 'No' },
      status: 'approved',
    });
    const emp = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: 'TEST-UNPAIDNOWORK', name: 'Unpaid No Work Employee', daily_rate: 800 });
    const period = await ctx.api.post('/api/hr/periods').set(hdr())
      .send({ label: 'Unpaid No Work Cutoff', start_date: '2026-08-11', end_date: '2026-08-11' });
    await ctx.api.post(`/api/hr/periods/${period.body.id}/employees`).set(hdr()).send({ employee_id: emp.body.id });
    await ctx.api.put(`/api/hr/periods/${period.body.id}/attendance`).set(hdr()).send({
      employee_id: emp.body.id,
      days: [{ work_date: '2026-08-11', time_in: '', time_out: '', notes: '' }],
    });

    const gen = await ctx.api.post(`/api/hr/periods/${period.body.id}/generate-payslips`).set(hdr())
      .send({ payroll_period: 'Unpaid No Work Cutoff' });
    const records = await ctx.api.get(`/api/form-definitions/${gen.body.form_id}/records`).query({ period: 'Unpaid No Work Cutoff' }).set(hdr());
    const rec = records.body.find((r: { data: { employee_name: string } }) => r.data.employee_name === 'Unpaid No Work Employee');
    expect(rec.data.days_worked).toBe(0);
    expect(rec.data.basic_salary).toBeCloseTo(0, 6);
  });

  it('13th-month = total basic salary that year / 12, from the generated payslips', async () => {
    const emp = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: 'TEST-13TH', name: '13th Month Employee', daily_rate: 1000 });

    for (const [i, d] of [['2026-03-15', '2026-03-14'], ['2026-04-15', '2026-04-14']].entries()) {
      const [payDate, workDate] = d;
      const period = await ctx.api.post('/api/hr/periods').set(hdr())
        .send({ label: `13th P${i}`, start_date: workDate, end_date: workDate });
      await ctx.api.post(`/api/hr/periods/${period.body.id}/employees`).set(hdr()).send({ employee_id: emp.body.id });
      await ctx.api.put(`/api/hr/periods/${period.body.id}/attendance`).set(hdr()).send({
        employee_id: emp.body.id,
        days: [{ work_date: workDate, time_in: '08:00', time_out: '17:00', notes: '', shift_id: morningShiftId }],
      });
      await ctx.api.post(`/api/hr/periods/${period.body.id}/generate-payslips`).set(hdr())
        .send({ payroll_period: `13th P${i}`, pay_date: payDate });
    }

    const r = await ctx.api.get('/api/hr/thirteenth-month?year=2026').set(hdr());
    expect(r.status).toBe(200);
    const row = r.body.rows.find((x: { employee_name: string }) => x.employee_name === '13th Month Employee');
    expect(row.payslip_count).toBe(2);
    expect(row.basic_total).toBe(2000);       // 1000/day * 1 day * 2 periods
    expect(row.amount).toBe(166.67);          // 2000 / 12

    // A different year sees nothing.
    const other = await ctx.api.get('/api/hr/thirteenth-month?year=2025').set(hdr());
    expect(other.body.rows.find((x: { employee_name: string }) => x.employee_name === '13th Month Employee')).toBeUndefined();
  });

  it('BIR 2316: year-end figures per employee from the generated payslips', async () => {
    const emp = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: 'TEST-2316', name: '2316 Employee', daily_rate: 1000, tin_no: '123-456-789-000' });

    // work_date deliberately NOT a Sat/Sun (2026-06-14 is a Sunday) — this test is about BIR
    // 2316 aggregation, not rest-day pay, and shouldn't accidentally exercise that feature.
    for (const [i, [payDate, workDate]] of [['2026-06-15', '2026-06-16'], ['2026-07-15', '2026-07-14']].entries()) {
      const period = await ctx.api.post('/api/hr/periods').set(hdr())
        .send({ label: `2316 P${i}`, start_date: workDate, end_date: workDate });
      await ctx.api.post(`/api/hr/periods/${period.body.id}/employees`).set(hdr()).send({ employee_id: emp.body.id });
      await ctx.api.put(`/api/hr/periods/${period.body.id}/attendance`).set(hdr()).send({
        employee_id: emp.body.id,
        days: [{ work_date: workDate, time_in: '08:00', time_out: '17:00', notes: '', shift_id: morningShiftId }],
      });
      await ctx.api.post(`/api/hr/periods/${period.body.id}/generate-payslips`).set(hdr())
        .send({ payroll_period: `2316 P${i}`, pay_date: payDate });
    }

    const one = await ctx.api.get(`/api/accounting/bir-2316/${emp.body.id}?year=2026`).set(hdr());
    expect(one.status).toBe(200);
    expect(one.body.employee.name).toBe('2316 Employee');
    expect(one.body.employee.tin_no).toBe('123-456-789-000');
    const f = one.body.figures;
    expect(f.payslip_count).toBe(2);
    expect(f.basic_salary).toBe(2000);                       // 1000/day * 1 day * 2
    expect(f.thirteenth_month_and_other_benefits).toBe(166.67); // 2000 / 12
    expect(f.gross_compensation).toBe(2166.67);              // earnings 2000 + 13th month
    expect(f.sss_gsis_phic_pagibig_union).toBeGreaterThan(0);
    expect(f.taxable_compensation_present).toBe(0);          // tiny sample: statutory > gross
    expect(f.tax_due).toBe(0);                               // well under the 250k exemption
    expect(f.total_tax_withheld).toBe(f.tax_withheld_present);

    const list = await ctx.api.get('/api/accounting/bir-2316?year=2026').set(hdr());
    expect(list.body.rows.some((r: { employee_name: string }) => r.employee_name === '2316 Employee')).toBe(true);

    expect((await ctx.api.get('/api/accounting/bir-2316/99999?year=2026').set(hdr())).status).toBe(404);
  });

  it('BIR 1601-C: monthly withholding totals from the generated payslips', async () => {
    const emp = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: 'TEST-1601C', name: '1601C Employee', daily_rate: 1500 });
    const period = await ctx.api.post('/api/hr/periods').set(hdr())
      .send({ label: '1601C Cutoff', start_date: '2026-09-14', end_date: '2026-09-14' });
    await ctx.api.post(`/api/hr/periods/${period.body.id}/employees`).set(hdr()).send({ employee_id: emp.body.id });
    await ctx.api.put(`/api/hr/periods/${period.body.id}/attendance`).set(hdr()).send({
      employee_id: emp.body.id,
      days: [{ work_date: '2026-09-14', time_in: '08:00', time_out: '17:00', notes: '', shift_id: morningShiftId }],
    });
    const gen = await ctx.api.post(`/api/hr/periods/${period.body.id}/generate-payslips`).set(hdr())
      .send({ payroll_period: '1601C Cutoff', pay_date: '2026-09-25' });
    const recs = await ctx.api.get(`/api/form-definitions/${gen.body.form_id}/records`).query({ period: '1601C Cutoff' }).set(hdr());
    const rec = recs.body.find((r: { data: { employee_name: string } }) => r.data.employee_name === '1601C Employee');

    const r = await ctx.api.get('/api/accounting/bir-1601c?year=2026').set(hdr());
    expect(r.status).toBe(200);
    expect(r.body.months).toHaveLength(12);
    const sep = r.body.months.find((m: { month: number }) => m.month === 9);
    expect(sep.employee_count).toBeGreaterThanOrEqual(1);
    expect(sep.gross_compensation).toBeGreaterThanOrEqual(rec.data.total_earnings);
    expect(sep.tax_withheld).toBeGreaterThanOrEqual(rec.data.withholding_tax);
    expect(r.body.totals.tax_withheld).toBeGreaterThanOrEqual(sep.tax_withheld);
    // A month with no payrun is all zeros.
    expect(r.body.months.find((m: { month: number }) => m.month === 1)).toMatchObject({ employee_count: 0, gross_compensation: 0 });
  });

  it('BIR 1604-C Alphalist: one Schedule-1 row per employee, header/cell alignment', async () => {
    const emp = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: 'TEST-ALPHA', name: 'Alpha, Beta Gamma', daily_rate: 2000, tin_no: '111-222-333-000', status: 'regular' });
    const period = await ctx.api.post('/api/hr/periods').set(hdr())
      .send({ label: 'Alpha Cutoff', start_date: '2026-10-14', end_date: '2026-10-14' });
    await ctx.api.post(`/api/hr/periods/${period.body.id}/employees`).set(hdr()).send({ employee_id: emp.body.id });
    await ctx.api.put(`/api/hr/periods/${period.body.id}/attendance`).set(hdr()).send({
      employee_id: emp.body.id,
      days: [{ work_date: '2026-10-14', time_in: '08:00', time_out: '17:00', notes: '', shift_id: morningShiftId }],
    });
    await ctx.api.post(`/api/hr/periods/${period.body.id}/generate-payslips`).set(hdr())
      .send({ payroll_period: 'Alpha Cutoff', pay_date: '2026-10-25' });

    const r = await ctx.api.get('/api/accounting/bir-alphalist?year=2026').set(hdr());
    expect(r.status).toBe(200);
    expect(r.body.headers.length).toBeGreaterThan(20);
    expect(r.body.cells.every((c: unknown[]) => c.length === r.body.headers.length)).toBe(true);

    const row = r.body.rows.find((x: { last_name: string }) => x.last_name === 'Alpha');
    expect(row).toBeTruthy();
    expect(row.first_name).toBe('Beta');
    expect(row.middle_name).toBe('Gamma');
    expect(row.tin).toBe('111-222-333-000');
    expect(row.status).toBe('R');
    expect(row.nt_total).toBe(Math.round((row.nt_13th_month + row.nt_de_minimis + row.nt_statutory + row.nt_salaries_250k_below) * 100) / 100);
    expect(row.seq).toBe(r.body.rows.indexOf(row) + 1);
  });

  it('BIR 1604-C: annual return face + Alphalist reconciliation', async () => {
    const emp = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: 'TEST-1604C', name: '1604C Employee', daily_rate: 1800, status: 'regular' });
    const period = await ctx.api.post('/api/hr/periods').set(hdr())
      .send({ label: '1604C Cutoff', start_date: '2026-11-16', end_date: '2026-11-16' });
    await ctx.api.post(`/api/hr/periods/${period.body.id}/employees`).set(hdr()).send({ employee_id: emp.body.id });
    await ctx.api.put(`/api/hr/periods/${period.body.id}/attendance`).set(hdr()).send({
      employee_id: emp.body.id,
      days: [{ work_date: '2026-11-16', time_in: '08:00', time_out: '17:00', notes: '', shift_id: morningShiftId }],
    });
    await ctx.api.post(`/api/hr/periods/${period.body.id}/generate-payslips`).set(hdr())
      .send({ payroll_period: '1604C Cutoff', pay_date: '2026-11-25' });

    const r = await ctx.api.get('/api/accounting/bir-1604c?year=2026').set(hdr());
    expect(r.status).toBe(200);
    expect(r.body.months).toHaveLength(12);
    expect(r.body.reconciliation).toHaveProperty('tax_remitted_per_1601c');
    expect(r.body.reconciliation).toHaveProperty('tax_due_per_alphalist');
    // remitted − due split cleanly into over/under, one of them zero
    const { over_remittance, under_remittance } = r.body.reconciliation;
    expect(Math.min(over_remittance, under_remittance)).toBe(0);
  });

  it('final-pay worksheet: unpaid days + pro-rated 13th month + tax annualisation', async () => {
    const emp = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: 'TEST-FINAL', name: 'Leaver, Last', daily_rate: 1500, status: 'resigned' });
    const period = await ctx.api.post('/api/hr/periods').set(hdr())
      .send({ label: 'Final Cutoff', start_date: '2026-05-15', end_date: '2026-05-15' });
    await ctx.api.post(`/api/hr/periods/${period.body.id}/employees`).set(hdr()).send({ employee_id: emp.body.id });
    await ctx.api.put(`/api/hr/periods/${period.body.id}/attendance`).set(hdr()).send({
      employee_id: emp.body.id,
      days: [{ work_date: '2026-05-15', time_in: '08:00', time_out: '17:00', notes: '', shift_id: morningShiftId }],
    });
    await ctx.api.post(`/api/hr/periods/${period.body.id}/generate-payslips`).set(hdr())
      .send({ payroll_period: 'Final Cutoff', pay_date: '2026-05-20' });

    const r = await ctx.api.get(`/api/hr/final-pay/${emp.body.id}`)
      .query({ separation_date: '2026-05-31', unpaid_days: 10, unused_leave_days: 3, outstanding_advance: 2000 })
      .set(hdr());
    expect(r.status).toBe(200);
    expect(r.body.worksheet.earnings.unpaid_salary).toBe(15_000);      // 10 × 1500
    expect(r.body.worksheet.earnings.leave_conversion).toBe(4_500);    // 3 × 1500
    expect(r.body.worksheet.earnings.prorated_13th_month).toBeGreaterThan(0);
    expect(r.body.worksheet.deductions.outstanding_advance).toBe(2_000);
    expect(r.body.worksheet).toHaveProperty('net_final_pay');
    expect(Array.isArray(r.body.worksheet.notes)).toBe(true);
    expect((await ctx.api.get('/api/hr/final-pay/99999').set(hdr())).status).toBe(404);
  });

  it('final-pay worksheet: unused_leave_days defaults from the employee leave-day bank, overridable', async () => {
    const emp = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: 'TEST-FINAL-LEAVE', name: 'Leaver, Balance', daily_rate: 1000, status: 'resigned',
        leave_days_per_year: 5, leave_days_used: 1.5 });

    const noOverride = await ctx.api.get(`/api/hr/final-pay/${emp.body.id}`)
      .query({ separation_date: '2026-05-31' }).set(hdr());
    expect(noOverride.status).toBe(200);
    expect(noOverride.body.leave_days_remaining).toBe(3.5);
    expect(noOverride.body.inputs.unused_leave_days).toBe(3.5);
    expect(noOverride.body.worksheet.earnings.leave_conversion).toBe(3_500); // 3.5 × 1000

    const overridden = await ctx.api.get(`/api/hr/final-pay/${emp.body.id}`)
      .query({ separation_date: '2026-05-31', unused_leave_days: 1 }).set(hdr());
    expect(overridden.body.inputs.unused_leave_days).toBe(1);
    expect(overridden.body.worksheet.earnings.leave_conversion).toBe(1_000);
  });

  it('contribution schedule: SSS/PhilHealth/Pag-IBIG collection list + CSV', async () => {
    const emp = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: 'TEST-CONTRIB', name: 'Payer, Reg', daily_rate: 1600, sss_no: '34-9999999-9', philhealth_no: '11-222222222-3', pagibig_no: '1234-5678-9012' });
    const period = await ctx.api.post('/api/hr/periods').set(hdr())
      .send({ label: 'Contrib Cutoff', start_date: '2026-07-15', end_date: '2026-07-15' });
    await ctx.api.post(`/api/hr/periods/${period.body.id}/employees`).set(hdr()).send({ employee_id: emp.body.id });
    await ctx.api.put(`/api/hr/periods/${period.body.id}/attendance`).set(hdr()).send({
      employee_id: emp.body.id,
      days: [{ work_date: '2026-07-15', time_in: '08:00', time_out: '17:00', notes: '', shift_id: morningShiftId }],
    });
    await ctx.api.post(`/api/hr/periods/${period.body.id}/generate-payslips`).set(hdr())
      .send({ payroll_period: 'Contrib Cutoff', pay_date: '2026-07-25' });

    const sss = await ctx.api.get('/api/accounting/contribution-schedule').query({ month: '2026-07', agency: 'sss' }).set(hdr());
    expect(sss.status).toBe(200);
    expect(sss.body.agency).toBe('sss');
    expect(sss.body.headers).toContain('EC ER');
    const row = sss.body.rows.find((x: { name: string }) => x.name === 'Payer, Reg');
    expect(row.id_number).toBe('34-9999999-9');
    expect(row.total).toBeCloseTo(row.employee + row.employer + row.ec, 2);

    const phic = await ctx.api.get('/api/accounting/contribution-schedule').query({ month: '2026-07', agency: 'philhealth' }).set(hdr());
    expect(phic.body.rows.find((x: { name: string }) => x.name === 'Payer, Reg').id_number).toBe('11-222222222-3');

    const csv = await ctx.api.get('/api/accounting/contribution-schedule').query({ month: '2026-07', agency: 'pagibig', format: 'csv' }).set(hdr());
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('Pag-IBIG MID No.');
    expect(csv.text).toContain('1234-5678-9012');
  });

  it('marking a payslip Paid locks it: regenerate skips it, and the generic edit/delete routes 423', async () => {
    const emp = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: 'TEST-LOCK', name: 'Lock Test Employee', daily_rate: 800 });
    const period = await ctx.api.post('/api/hr/periods').set(hdr())
      .send({ label: 'Lock Cutoff', start_date: '2026-08-20', end_date: '2026-08-20' });
    await ctx.api.post(`/api/hr/periods/${period.body.id}/employees`).set(hdr()).send({ employee_id: emp.body.id });
    await ctx.api.put(`/api/hr/periods/${period.body.id}/attendance`).set(hdr()).send({
      employee_id: emp.body.id,
      days: [{ work_date: '2026-08-20', time_in: '08:00', time_out: '17:00', notes: '', shift_id: morningShiftId }],
    });
    const gen1 = await ctx.api.post(`/api/hr/periods/${period.body.id}/generate-payslips`).set(hdr())
      .send({ payroll_period: 'Lock Cutoff' });
    const recs1 = await ctx.api.get(`/api/form-definitions/${gen1.body.form_id}/records`).query({ period: 'Lock Cutoff' }).set(hdr());
    const recId = recs1.body.find((r: { data: { employee_name: string } }) => r.data.employee_name === 'Lock Test Employee').id;

    // Can't mark-paid twice, and unmark-paid on a not-paid one fails.
    expect((await ctx.api.post(`/api/hr/payroll/${recId}/unmark-paid`).set(hdr())).status).toBe(400);
    const mark = await ctx.api.post(`/api/hr/payroll/${recId}/mark-paid`).set(hdr());
    expect(mark.status).toBe(200);
    expect((await ctx.api.post(`/api/hr/payroll/${recId}/mark-paid`).set(hdr())).status).toBe(400);

    // Regenerate skips the locked record entirely.
    const gen2 = await ctx.api.post(`/api/hr/periods/${period.body.id}/generate-payslips`).set(hdr())
      .send({ payroll_period: 'Lock Cutoff' });
    expect(gen2.body.skipped_locked).toBe(1);
    expect(gen2.body.updated).toBe(0);

    // The generic form-records edit/delete routes refuse to touch it.
    const editAttempt = await ctx.api.put(`/api/form-records/${recId}`).set(hdr()).send({ data: { net_pay: 1 } });
    expect(editAttempt.status).toBe(423);
    const delAttempt = await ctx.api.delete(`/api/form-records/${recId}`).set(hdr());
    expect(delAttempt.status).toBe(423);
    // Nor can status be set to 'paid' directly through the generic route.
    const otherRec = recs1.body.find((r: { data: { employee_name: string } }) => r.data.employee_name !== 'Lock Test Employee');
    if (otherRec) {
      const sneaky = await ctx.api.put(`/api/form-records/${otherRec.id}`).set(hdr()).send({ data: otherRec.data, status: 'paid' });
      expect(sneaky.status).toBe(400);
    }

    // Unmark, then everything works normally again.
    const unmark = await ctx.api.post(`/api/hr/payroll/${recId}/unmark-paid`).set(hdr());
    expect(unmark.status).toBe(200);
    const editAfterUnmark = await ctx.api.put(`/api/form-records/${recId}`).set(hdr()).send({ data: recs1.body.find((r: { id: number }) => r.id === recId).data });
    expect(editAfterUnmark.status).toBe(200);
    const gen3 = await ctx.api.post(`/api/hr/periods/${period.body.id}/generate-payslips`).set(hdr())
      .send({ payroll_period: 'Lock Cutoff' });
    expect(gen3.body.skipped_locked).toBe(0);
    expect(gen3.body.updated).toBe(1);
  });

  it('emailing a payslip 400s when the employee has no linked account (or the linked account has no email)', async () => {
    const emp = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: 'TEST-EMAIL', name: 'Email Test Employee', daily_rate: 800 });
    const period = await ctx.api.post('/api/hr/periods').set(hdr())
      .send({ label: 'Email Cutoff', start_date: '2026-08-21', end_date: '2026-08-21' });
    await ctx.api.post(`/api/hr/periods/${period.body.id}/employees`).set(hdr()).send({ employee_id: emp.body.id });
    await ctx.api.put(`/api/hr/periods/${period.body.id}/attendance`).set(hdr()).send({
      employee_id: emp.body.id,
      days: [{ work_date: '2026-08-21', time_in: '08:00', time_out: '17:00', notes: '', shift_id: morningShiftId }],
    });
    const gen = await ctx.api.post(`/api/hr/periods/${period.body.id}/generate-payslips`).set(hdr())
      .send({ payroll_period: 'Email Cutoff' });
    const recs = await ctx.api.get(`/api/form-definitions/${gen.body.form_id}/records`).query({ period: 'Email Cutoff' }).set(hdr());
    const recId = recs.body.find((r: { data: { employee_name: string } }) => r.data.employee_name === 'Email Test Employee').id;

    const res = await ctx.api.post(`/api/hr/payroll/${recId}/email`).set(hdr());
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/linked user account/i);
  });

  it('the read-only payroll detail route returns a per-day breakdown that sums to the payslip\'s own totals', async () => {
    // Re-assert the same self-contained policy this describe block's beforeAll set — PUT
    // /payroll-policy is a full replace, not a merge (see e.g. the auto_statutory-only test
    // above), so an earlier test in this file that PUT a partial payload can have quietly reset
    // default_rest_days back to its schema default ([0,6]) by the time this test runs; 2026-08-02
    // (a Sunday) must NOT be treated as a rest day for the OT-rate assertions below to hold.
    await ctx.api.put('/api/hr/payroll-policy').set(hdr()).send({
      grace_minutes: 10, late_unit: 'hour', ot_unit: 'hour', ot_rate_percent: 125,
      night_diff_enabled: false, night_diff_percent: 10, night_start: '22:00', night_end: '06:00',
      default_rest_days: [],
    });
    const emp = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: 'TEST-DETAIL', name: 'Detail Test Employee', daily_rate: 800 }); // hourly = 100
    const period = await ctx.api.post('/api/hr/periods').set(hdr())
      .send({ label: 'Detail Cutoff', start_date: '2026-08-01', end_date: '2026-08-02' });
    await ctx.api.post(`/api/hr/periods/${period.body.id}/employees`).set(hdr()).send({ employee_id: emp.body.id });

    const otRecord = await ctx.api.post('/api/form-records').set(hdr())
      .send({ form_def_id: overtimeFormId, data: { employee_name: 'Detail Test Employee' }, status: 'approved' });

    await ctx.api.put(`/api/hr/periods/${period.body.id}/attendance`).set(hdr()).send({
      employee_id: emp.body.id,
      days: [
        // 70 min late (shift 08:00-17:00, 10 min grace -> 60 min past grace -> 1-hour block)
        { work_date: '2026-08-01', time_in: '09:10', time_out: '17:00', notes: '', shift_id: morningShiftId, form_record_id: null },
        // On time, 1 hour of authorized OT
        { work_date: '2026-08-02', time_in: '08:00', time_out: '18:00', notes: '', shift_id: morningShiftId, form_record_id: otRecord.body.id },
      ],
    });

    const gen = await ctx.api.post(`/api/hr/periods/${period.body.id}/generate-payslips`).set(hdr())
      .send({ payroll_period: 'Detail Cutoff' });
    expect(gen.status).toBe(201);
    const records = await ctx.api.get(`/api/form-definitions/${gen.body.form_id}/records`).query({ period: 'Detail Cutoff' }).set(hdr());
    const rec = records.body.find((r: { data: { employee_name: string } }) => r.data.employee_name === 'Detail Test Employee');

    const detail = await ctx.api.get(`/api/hr/payroll/${rec.id}/detail`).set(hdr());
    expect(detail.status).toBe(200);
    expect(detail.body.employee_name).toBe('Detail Test Employee');
    expect(detail.body.period_label).toBe('Detail Cutoff');
    expect(detail.body.days).toHaveLength(2);

    const lateDay = detail.body.days.find((d: { work_date: string }) => d.work_date === '2026-08-01');
    expect(lateDay.status).toBe('worked');
    expect(lateDay.late_minutes).toBe(60);
    expect(lateDay.late_pay).toBeCloseTo(100, 6);
    expect(lateDay.ot_hours).toBe(0);

    const otDay = detail.body.days.find((d: { work_date: string }) => d.work_date === '2026-08-02');
    expect(otDay.ot_hours).toBeCloseTo(1, 6);
    expect(otDay.ot_pay).toBeCloseTo(125, 6);
    expect(otDay.late_minutes).toBe(0);

    // Per-day figures sum to exactly what generate-payslips put on the payslip — same loop,
    // same numbers, never a separately-derived (and possibly drifting) copy.
    expect(detail.body.totals.late_deduction).toBeCloseTo(rec.data.late_absences, 6);
    expect(detail.body.totals.overtime_pay).toBeCloseTo(rec.data.overtime_pay, 6);
    expect(detail.body.days.reduce((s: number, d: { late_pay: number }) => s + d.late_pay, 0))
      .toBeCloseTo(detail.body.totals.late_deduction, 6);
    expect(detail.body.days.reduce((s: number, d: { ot_pay: number }) => s + d.ot_pay, 0))
      .toBeCloseTo(detail.body.totals.overtime_pay, 6);
  });

  it('the payroll detail route 404s when the employee or the period can\'t be resolved', async () => {
    const emp = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: 'TEST-DETAIL-404', name: 'Detail 404 Employee', daily_rate: 800 });
    const period = await ctx.api.post('/api/hr/periods').set(hdr())
      .send({ label: 'Detail 404 Cutoff', start_date: '2026-08-06', end_date: '2026-08-06' });
    await ctx.api.post(`/api/hr/periods/${period.body.id}/employees`).set(hdr()).send({ employee_id: emp.body.id });
    await ctx.api.put(`/api/hr/periods/${period.body.id}/attendance`).set(hdr()).send({
      employee_id: emp.body.id,
      days: [{ work_date: '2026-08-06', time_in: '08:00', time_out: '17:00', notes: '', shift_id: morningShiftId }],
    });
    const gen = await ctx.api.post(`/api/hr/periods/${period.body.id}/generate-payslips`).set(hdr())
      .send({ payroll_period: 'Detail 404 Cutoff' });
    const records = await ctx.api.get(`/api/form-definitions/${gen.body.form_id}/records`).query({ period: 'Detail 404 Cutoff' }).set(hdr());
    const recId = records.body.find((r: { data: { employee_name: string } }) => r.data.employee_name === 'Detail 404 Employee').id;

    // Renaming the employee breaks the free-text employee_name link the payroll record relies on.
    await ctx.api.put(`/api/hr/employees/${emp.body.id}`).set(hdr())
      .send({ employee_no: 'TEST-DETAIL-404', name: 'Renamed Employee', daily_rate: 800 });
    const noEmp = await ctx.api.get(`/api/hr/payroll/${recId}/detail`).set(hdr());
    expect(noEmp.status).toBe(404);
    expect(noEmp.body.error).toMatch(/no employee record/i);
    await ctx.api.put(`/api/hr/employees/${emp.body.id}`).set(hdr())
      .send({ employee_no: 'TEST-DETAIL-404', name: 'Detail 404 Employee', daily_rate: 800 }); // restore

    // Renaming the cutoff breaks the period-label link.
    await ctx.api.put(`/api/hr/periods/${period.body.id}`).set(hdr()).send({ label: 'Renamed Cutoff', start_date: '2026-08-06', end_date: '2026-08-06' });
    const noPeriod = await ctx.api.get(`/api/hr/payroll/${recId}/detail`).set(hdr());
    expect(noPeriod.status).toBe(404);
    expect(noPeriod.body.error).toMatch(/no cutoff found/i);
  });

  it('post-payroll-gl books an aggregate payroll journal entry when the ledger is on, 400s otherwise', async () => {
    // Ledger is off by default in this fresh test DB.
    const emp = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: 'TEST-GL', name: 'GL Test Employee', daily_rate: 800 });
    const period = await ctx.api.post('/api/hr/periods').set(hdr())
      .send({ label: 'GL Cutoff', start_date: '2026-08-22', end_date: '2026-08-22' });
    await ctx.api.post(`/api/hr/periods/${period.body.id}/employees`).set(hdr()).send({ employee_id: emp.body.id });
    await ctx.api.put(`/api/hr/periods/${period.body.id}/attendance`).set(hdr()).send({
      employee_id: emp.body.id,
      days: [{ work_date: '2026-08-22', time_in: '08:00', time_out: '17:00', notes: '', shift_id: morningShiftId }],
    });
    await ctx.api.post(`/api/hr/periods/${period.body.id}/generate-payslips`).set(hdr()).send({ payroll_period: 'GL Cutoff' });

    const offAttempt = await ctx.api.post(`/api/hr/periods/${period.body.id}/post-payroll-gl`).set(hdr()).send({ payroll_period: 'GL Cutoff' });
    expect(offAttempt.status).toBe(400);

    // Turn the ledger on — seeds posting rules from the default COA, including the payroll accounts.
    const setup = await ctx.api.post('/api/accounting/ledger/setup').set(hdr()).send({ fiscal_year_start: '2026-01-01' });
    expect(setup.status).toBe(201);

    const posted = await ctx.api.post(`/api/hr/periods/${period.body.id}/post-payroll-gl`).set(hdr()).send({ payroll_period: 'GL Cutoff' });
    expect(posted.status).toBe(201);
    expect(posted.body.posted).toBe(true);
    expect(posted.body.entry.number).toMatch(/^JV-/);

    const je = await ctx.api.get('/api/accounting/ledger/journal-entries').query({ source_type: 'payroll_run' }).set(hdr());
    const entry = je.body.find((e: { id: number; number: string }) => e.number === posted.body.entry.number);
    expect(entry.book).toBe('payroll');
    expect(entry.source_id).toBe(period.body.id);
    expect(entry.total_debit).toBeGreaterThan(0);
    // Debits must equal credits — auto_statutory defaults on, so this run's employer
    // contributions land in the total too, not just the bare daily_rate.
    const detail = await ctx.api.get(`/api/accounting/ledger/journal-entries/${entry.id}`).set(hdr());
    const debitSum = detail.body.lines.reduce((s: number, l: { debit: number }) => s + (l.debit || 0), 0);
    const creditSum = detail.body.lines.reduce((s: number, l: { credit: number }) => s + (l.credit || 0), 0);
    expect(debitSum).toBeCloseTo(creditSum, 2);

    // Re-posting (e.g. after a regenerate) reverses the old entry and posts a fresh one.
    const posted2 = await ctx.api.post(`/api/hr/periods/${period.body.id}/post-payroll-gl`).set(hdr()).send({ payroll_period: 'GL Cutoff' });
    expect(posted2.status).toBe(201);
    expect(posted2.body.entry.number).not.toBe(posted.body.entry.number);
    const reversedCheck = await ctx.api.get(`/api/accounting/ledger/journal-entries/${entry.id}`).set(hdr());
    expect(reversedCheck.body.reversed_by).toBeTruthy();
  });
});

// PH holiday pay + rest-day premium end to end: per-record override vs. the Company Holidays
// calendar, and per-employee rest-day override vs. the company-wide default. Own describe block
// (own policy/fixtures) so it doesn't collide with 'generate-payslips computes real numbers...'
// above, which deliberately sets default_rest_days: [] to stay unaffected by this feature.
describe('generate-payslips — HR-marked holidays + rest-day pay end to end', () => {
  let holidayShiftId: number;

  beforeAll(async () => {
    await ctx.api.put('/api/hr/payroll-policy').set(hdr()).send({
      grace_minutes: 10, late_unit: 'hour', ot_unit: 'hour', ot_rate_percent: 125,
      night_diff_enabled: false, night_diff_percent: 10, night_start: '22:00', night_end: '06:00',
      default_rest_days: [0, 6], // Sun, Sat
    });
    const shift = await ctx.api.post('/api/hr/shifts').set(hdr())
      .send({ name: 'Holiday Test Shift', start_time: '08:00', end_time: '17:00', is_default: false });
    holidayShiftId = shift.body.id;
  });

  async function genOne(periodId: number, label: string, employeeName: string) {
    const gen = await ctx.api.post(`/api/hr/periods/${periodId}/generate-payslips`).set(hdr()).send({ payroll_period: label });
    const records = await ctx.api.get(`/api/form-definitions/${gen.body.form_id}/records`).query({ period: label }).set(hdr());
    return records.body.find((r: { data: { employee_name: string } }) => r.data.employee_name === employeeName);
  }

  it('a per-record holiday_type override beats the Company Holidays calendar for that one day', async () => {
    const emp = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: 'TEST-HOL-OVERRIDE', name: 'Holiday Override Employee', daily_rate: 1000 });
    // 2026-01-01 is already seeded in the calendar as a Regular Holiday.
    const period = await ctx.api.post('/api/hr/periods').set(hdr())
      .send({ label: 'Holiday Override Cutoff', start_date: '2026-01-01', end_date: '2026-01-01' });
    await ctx.api.post(`/api/hr/periods/${period.body.id}/employees`).set(hdr()).send({ employee_id: emp.body.id });
    await ctx.api.put(`/api/hr/periods/${period.body.id}/attendance`).set(hdr()).send({
      employee_id: emp.body.id,
      days: [{
        work_date: '2026-01-01', time_in: '08:00', time_out: '17:00', notes: '', shift_id: holidayShiftId,
        holiday_type: 'none', // override the calendar off for this one employee
      }],
    });
    const rec = await genOne(period.body.id, 'Holiday Override Cutoff', 'Holiday Override Employee');
    expect(rec.data.holiday_pay).toBe(0); // override wins — not the calendar's 200% Regular Holiday rate
  });

  it('a Regular Holiday ALSO covered by a paid No Work Memo still routes to holiday_pay, is excluded from days_worked, and is not an absence — the statutory entitlement wins over the memo', async () => {
    const forms = await ctx.api.get('/api/form-definitions').set(hdr());
    const noWorkFormId = forms.body.find((f: { slug: string }) => f.slug === 'no_work_memo').id;
    await ctx.api.post('/api/form-records').set(hdr()).send({
      form_def_id: noWorkFormId,
      data: { date_from: '2026-01-01', date_to: '2026-01-01', reason: 'Suspension, Holiday', paid: 'Yes' },
      status: 'approved',
    });
    const emp = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: 'TEST-HOL-NOWORK', name: 'Holiday No Work Employee', daily_rate: 1000 });
    // 2026-01-01 is already seeded in the calendar as a Regular Holiday, AND now also covered
    // by the paid No Work Memo above — nobody logged any time (unworked, per the memo).
    const period = await ctx.api.post('/api/hr/periods').set(hdr())
      .send({ label: 'Holiday No Work Cutoff', start_date: '2026-01-01', end_date: '2026-01-01' });
    await ctx.api.post(`/api/hr/periods/${period.body.id}/employees`).set(hdr()).send({ employee_id: emp.body.id });
    await ctx.api.put(`/api/hr/periods/${period.body.id}/attendance`).set(hdr()).send({
      employee_id: emp.body.id,
      days: [{ work_date: '2026-01-01', time_in: '', time_out: '', notes: '' }],
    });
    const rec = await genOne(period.body.id, 'Holiday No Work Cutoff', 'Holiday No Work Employee');
    expect(rec.data.days_worked).toBe(0);
    expect(rec.data.days_absent).toBe(0);
    expect(rec.data.holiday_pay).toBe(1000);
    expect(rec.data.basic_salary).toBe(0); // the day's pay is in holiday_pay, not folded into basic salary
    expect(rec.data.total_earnings).toBe(1000); // same total money either way, just the right line
  });

  it('with no per-record override, the Company Holidays calendar applies automatically', async () => {
    const emp = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: 'TEST-HOL-CALENDAR', name: 'Holiday Calendar Employee', daily_rate: 1000 });
    const period = await ctx.api.post('/api/hr/periods').set(hdr())
      .send({ label: 'Holiday Calendar Cutoff', start_date: '2026-01-01', end_date: '2026-01-01' });
    await ctx.api.post(`/api/hr/periods/${period.body.id}/employees`).set(hdr()).send({ employee_id: emp.body.id });
    await ctx.api.put(`/api/hr/periods/${period.body.id}/attendance`).set(hdr()).send({
      employee_id: emp.body.id,
      days: [{ work_date: '2026-01-01', time_in: '08:00', time_out: '17:00', notes: '', shift_id: holidayShiftId }],
    });
    const rec = await genOne(period.body.id, 'Holiday Calendar Cutoff', 'Holiday Calendar Employee');
    // 2026-01-01 is a Thursday, not a rest day -> plain 200% Regular Holiday rate (+100% premium).
    expect(rec.data.holiday_pay).toBeCloseTo(1000, 6);
  });

  it("an employee's rest_days override wins over PayrollPolicy.default_rest_days", async () => {
    // Company default is Sun/Sat; give this one employee Mon/Tue off instead.
    const emp = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: 'TEST-RESTDAY-OVERRIDE', name: 'Rest Day Override Employee', daily_rate: 1000, rest_days: [1, 2] });
    // 2026-08-03 is a Monday (this employee's custom rest day; not the company default).
    const period = await ctx.api.post('/api/hr/periods').set(hdr())
      .send({ label: 'Rest Day Override Cutoff', start_date: '2026-08-03', end_date: '2026-08-03' });
    await ctx.api.post(`/api/hr/periods/${period.body.id}/employees`).set(hdr()).send({ employee_id: emp.body.id });
    await ctx.api.put(`/api/hr/periods/${period.body.id}/attendance`).set(hdr()).send({
      employee_id: emp.body.id,
      days: [{ work_date: '2026-08-03', time_in: '08:00', time_out: '17:00', notes: '', shift_id: holidayShiftId }],
    });
    const rec = await genOne(period.body.id, 'Rest Day Override Cutoff', 'Rest Day Override Employee');
    expect(rec.data.rest_day_ot).toBeCloseTo(300, 6); // +30% of 1000, credited because of the override, not the company default

    // Round-trips back out through GET too.
    const list = await ctx.api.get('/api/hr/employees').set(hdr());
    const fetched = list.body.find((e: { id: number }) => e.id === emp.body.id);
    expect(fetched.rest_days).toEqual([1, 2]);
  });

  it('company-wide default_rest_days applies when an employee has no override', async () => {
    const emp = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: 'TEST-RESTDAY-DEFAULT', name: 'Rest Day Default Employee', daily_rate: 1000 });
    // 2026-08-01 is a Saturday -> covered by the company default [0, 6].
    const period = await ctx.api.post('/api/hr/periods').set(hdr())
      .send({ label: 'Rest Day Default Cutoff', start_date: '2026-08-01', end_date: '2026-08-01' });
    await ctx.api.post(`/api/hr/periods/${period.body.id}/employees`).set(hdr()).send({ employee_id: emp.body.id });
    await ctx.api.put(`/api/hr/periods/${period.body.id}/attendance`).set(hdr()).send({
      employee_id: emp.body.id,
      days: [{ work_date: '2026-08-01', time_in: '08:00', time_out: '17:00', notes: '', shift_id: holidayShiftId }],
    });
    const rec = await genOne(period.body.id, 'Rest Day Default Cutoff', 'Rest Day Default Employee');
    expect(rec.data.rest_day_ot).toBeCloseTo(300, 6);
  });

  it("a per-record rest_day='yes' forces the premium on a weekday that isn't in the pattern", async () => {
    const emp = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: 'TEST-RESTDAY-PERDATE-ON', name: 'Rest Day Per Date On Employee', daily_rate: 1000 });
    // 2026-08-05 is a Wednesday — not a rest day under the company default [0, 6] or any
    // per-employee pattern here; the per-record override alone makes it one.
    const period = await ctx.api.post('/api/hr/periods').set(hdr())
      .send({ label: 'Rest Day Per Date On Cutoff', start_date: '2026-08-05', end_date: '2026-08-05' });
    await ctx.api.post(`/api/hr/periods/${period.body.id}/employees`).set(hdr()).send({ employee_id: emp.body.id });
    await ctx.api.put(`/api/hr/periods/${period.body.id}/attendance`).set(hdr()).send({
      employee_id: emp.body.id,
      days: [{ work_date: '2026-08-05', time_in: '08:00', time_out: '17:00', notes: '', shift_id: holidayShiftId, rest_day: 'yes' }],
    });
    const rec = await genOne(period.body.id, 'Rest Day Per Date On Cutoff', 'Rest Day Per Date On Employee');
    expect(rec.data.rest_day_ot).toBeCloseTo(300, 6);
  });

  it("a per-record rest_day='no' suppresses the premium on a weekday that is in the pattern", async () => {
    const emp = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: 'TEST-RESTDAY-PERDATE-OFF', name: 'Rest Day Per Date Off Employee', daily_rate: 1000 });
    // 2026-08-08 is a Saturday — a rest day under the company default [0, 6]; the per-record
    // override turns it back into an ordinary working day for this one date.
    const period = await ctx.api.post('/api/hr/periods').set(hdr())
      .send({ label: 'Rest Day Per Date Off Cutoff', start_date: '2026-08-08', end_date: '2026-08-08' });
    await ctx.api.post(`/api/hr/periods/${period.body.id}/employees`).set(hdr()).send({ employee_id: emp.body.id });
    await ctx.api.put(`/api/hr/periods/${period.body.id}/attendance`).set(hdr()).send({
      employee_id: emp.body.id,
      days: [{ work_date: '2026-08-08', time_in: '08:00', time_out: '17:00', notes: '', shift_id: holidayShiftId, rest_day: 'no' }],
    });
    const rec = await genOne(period.body.id, 'Rest Day Per Date Off Cutoff', 'Rest Day Per Date Off Employee');
    expect(rec.data.rest_day_ot).toBe(0);
  });
});

// Per-cutoff statutory deduction schedule: which of SSS/PhilHealth/Pag-IBIG/withholding tax
// lands in which cutoff of the month, instead of always splitting every deduction evenly.
// Own describe block + own policy so it doesn't collide with any other test's global policy
// state. Same daily_rate=1000 (~26k/mo comp) fixture the existing "computes SSS / PhilHealth
// / Pag-IBIG / withholding tax" test uses, so the monthly totals are already known: SSS
// employee share 1300/mo, PhilHealth 650/mo, Pag-IBIG 200/mo (capped) — evenly split across 2
// semi-monthly cutoffs that's 650/325/100 each; this schedule instead puts the *whole* monthly
// amount on whichever single cutoff has that key checked.
describe('generate-payslips — per-cutoff statutory deduction schedule', () => {
  let dedShiftId: number;

  async function setSchedule(schedule: unknown) {
    await ctx.api.put('/api/hr/payroll-policy').set(hdr()).send({
      pay_frequency: 'semi_monthly', auto_statutory: true, default_rest_days: [], deduction_schedule: schedule,
    });
  }

  beforeAll(async () => {
    const shift = await ctx.api.post('/api/hr/shifts').set(hdr())
      .send({ name: 'Ded Schedule Test Shift', start_time: '08:00', end_time: '17:00', is_default: false });
    dedShiftId = shift.body.id;
  });

  async function genFor(startDate: string, label: string, employeeName: string, dailyRate = 1000) {
    const emp = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: 'TEST-DED-' + Math.floor(Math.random() * 1e6), name: employeeName, daily_rate: dailyRate });
    const period = await ctx.api.post('/api/hr/periods').set(hdr())
      .send({ label, start_date: startDate, end_date: startDate });
    await ctx.api.post(`/api/hr/periods/${period.body.id}/employees`).set(hdr()).send({ employee_id: emp.body.id });
    await ctx.api.put(`/api/hr/periods/${period.body.id}/attendance`).set(hdr()).send({
      employee_id: emp.body.id,
      days: [{ work_date: startDate, time_in: '08:00', time_out: '17:00', notes: '', shift_id: dedShiftId }],
    });
    const gen = await ctx.api.post(`/api/hr/periods/${period.body.id}/generate-payslips`).set(hdr()).send({ payroll_period: label });
    const records = await ctx.api.get(`/api/form-definitions/${gen.body.form_id}/records`).query({ period: label }).set(hdr());
    return records.body.find((r: { data: { employee_name: string } }) => r.data.employee_name === employeeName);
  }

  it('1st-half cutoff (day <= 15) deducts only SSS, at the full monthly amount, when scheduled that way', async () => {
    await setSchedule([
      { sss: true, philhealth: false, pagibig: false, withholding_tax: false },
      { sss: false, philhealth: true, pagibig: true, withholding_tax: true },
    ]);
    const rec = await genFor('2026-08-05', 'Ded Sched 1st Cutoff', '1st Cutoff Ded Employee');
    expect(rec.data.sss).toBe(1300); // full monthly, not halved
    expect(rec.data.philhealth).toBe(0);
    expect(rec.data.pagibig).toBe(0);
    expect(rec.data.withholding_tax).toBe(0);
  });

  it('2nd-half cutoff (day > 15) deducts PhilHealth/Pag-IBIG/tax at the full monthly amount, SSS deferred to 0', async () => {
    await setSchedule([
      { sss: true, philhealth: false, pagibig: false, withholding_tax: false },
      { sss: false, philhealth: true, pagibig: true, withholding_tax: true },
    ]);
    const rec = await genFor('2026-08-20', 'Ded Sched 2nd Cutoff', '2nd Cutoff Ded Employee');
    expect(rec.data.sss).toBe(0);
    expect(rec.data.philhealth).toBe(650); // full monthly, not halved
    expect(rec.data.pagibig).toBe(200);    // full monthly, not halved
    expect(rec.data.withholding_tax).toBeGreaterThanOrEqual(0); // gated on, computed normally (not divided — never was)
  });

  it('an unset schedule still splits every deduction evenly across every cutoff — the pre-existing default behavior', async () => {
    await ctx.api.put('/api/hr/payroll-policy').set(hdr()).send({
      pay_frequency: 'semi_monthly', auto_statutory: true, default_rest_days: [],
    });
    const rec = await genFor('2026-08-05', 'Ded Sched Default', 'Default Ded Employee');
    expect(rec.data.sss).toBe(650);
    expect(rec.data.philhealth).toBe(325);
    expect(rec.data.pagibig).toBe(100);
  });

  it('a schedule left over from a different pay_frequency (wrong length) safely falls back to even-split rather than misbehaving', async () => {
    // A 4-slot (weekly) schedule under semi_monthly (2 slots) is a length mismatch.
    await setSchedule([
      { sss: true, philhealth: false, pagibig: false, withholding_tax: false },
      { sss: false, philhealth: true, pagibig: false, withholding_tax: false },
      { sss: false, philhealth: false, pagibig: true, withholding_tax: false },
      { sss: false, philhealth: false, pagibig: false, withholding_tax: true },
    ]);
    const rec = await genFor('2026-08-05', 'Ded Sched Mismatch', 'Mismatch Ded Employee');
    expect(rec.data.sss).toBe(650); // ignored the stale schedule, fell back to the even split
    expect(rec.data.philhealth).toBe(325);
    expect(rec.data.pagibig).toBe(100);
  });
});
