/** src/hr-daily-report.ts (pure classifier) + GET /api/hr/daily-report (the route that
    resolves DB inputs for it). */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { classifyDailyStatus, type DailyStatusInput } from '../src/hr-daily-report';
import { setupApp, cleanup, login, type TestContext } from './helpers';

const SHIFT = { start_time: '08:00', end_time: '17:00' };
function input(overrides: Partial<DailyStatusInput>): DailyStatusInput {
  return {
    time_in: null, shift: SHIFT, on_leave: false, reported: false, holiday: null, no_work: null,
    is_rest_day: false, grace_minutes: 10, now: null,
    ...overrides,
  };
}

describe('classifyDailyStatus', () => {
  it('on time -> present', () => {
    const r = classifyDailyStatus(input({ time_in: '07:55' }));
    expect(r.status).toBe('present');
    expect(r.late_minutes).toBe(0);
  });

  it('exactly at grace -> still present (grace is inclusive, matches payroll)', () => {
    const r = classifyDailyStatus(input({ time_in: '08:10' })); // 10 min late, grace 10
    expect(r.status).toBe('present');
  });

  it('one minute past grace -> late, with minutes past grace reported', () => {
    const r = classifyDailyStatus(input({ time_in: '08:11' }));
    expect(r.status).toBe('late');
    expect(r.late_minutes).toBe(1);
  });

  it('has a time_in but no shift resolvable -> present, never late (nothing to judge against)', () => {
    const r = classifyDailyStatus(input({ time_in: '11:00', shift: null }));
    expect(r.status).toBe('present');
    expect(r.late_minutes).toBe(0);
  });

  it('no time_in, no time_out required — a still-clocked-in employee reads present/late, not absent', () => {
    // time_in present is enough; the payroll engine would need time_out too and would call
    // this "absent" instead — this board deliberately doesn't.
    const r = classifyDailyStatus(input({ time_in: '08:00' }));
    expect(r.status).toBe('present');
  });

  it('no time_in, linked leave form -> leave (beats absent, rest day, everything)', () => {
    const r = classifyDailyStatus(input({ on_leave: true, is_rest_day: true }));
    expect(r.status).toBe('leave');
  });

  it('no time_in, regular holiday -> not_scheduled', () => {
    const r = classifyDailyStatus(input({ holiday: 'regular' }));
    expect(r.status).toBe('not_scheduled');
    expect(r.note).toMatch(/Regular Holiday/);
  });

  it('no time_in, special working holiday -> still absent (it is an ordinary work day)', () => {
    const r = classifyDailyStatus(input({ holiday: 'special_working' }));
    expect(r.status).toBe('absent');
  });

  it('no time_in, company no-work memo -> not_scheduled', () => {
    const r = classifyDailyStatus(input({ no_work: 'paid' }));
    expect(r.status).toBe('not_scheduled');
    expect(r.note).toMatch(/no-work/i);
  });

  it('no time_in, rest day -> not_scheduled (never counted as absent)', () => {
    const r = classifyDailyStatus(input({ is_rest_day: true }));
    expect(r.status).toBe('not_scheduled');
  });

  it('no time_in, linked reported_absence form -> reported, not plain absent', () => {
    const r = classifyDailyStatus(input({ reported: true }));
    expect(r.status).toBe('reported');
  });

  it('reported beats pending/absent but loses to leave, holiday, no-work, and rest day', () => {
    expect(classifyDailyStatus(input({ reported: true, on_leave: true })).status).toBe('leave');
    expect(classifyDailyStatus(input({ reported: true, holiday: 'regular' })).status).toBe('not_scheduled');
    expect(classifyDailyStatus(input({ reported: true, no_work: 'paid' })).status).toBe('not_scheduled');
    expect(classifyDailyStatus(input({ reported: true, is_rest_day: true })).status).toBe('not_scheduled');
  });

  it('no time_in, viewing today, before shift start + grace -> pending, not absent', () => {
    const r = classifyDailyStatus(input({ now: '07:50' })); // shift starts 08:00, grace 10
    expect(r.status).toBe('pending');
  });

  it('no time_in, viewing today, past shift start + grace -> absent', () => {
    const r = classifyDailyStatus(input({ now: '08:11' }));
    expect(r.status).toBe('absent');
  });

  it('no time_in, viewing a past date (now is null) -> absent even "early" in the day', () => {
    const r = classifyDailyStatus(input({ now: null }));
    expect(r.status).toBe('absent');
  });

  it('nothing at all explains the day -> absent', () => {
    const r = classifyDailyStatus(input({}));
    expect(r.status).toBe('absent');
    expect(r.note).toBeTruthy();
  });
});

describe('GET /api/hr/daily-report', () => {
  let ctx: TestContext;
  let adminToken: string;
  const hdr = () => ({ Authorization: `Bearer ${adminToken}` });

  beforeAll(async () => {
    ctx = await setupApp();
    adminToken = await login(ctx.api);
  });
  afterAll(() => cleanup(ctx));

  it('requires auth', async () => {
    expect((await ctx.api.get('/api/hr/daily-report')).status).toBe(401);
  });

  it('defaults to today, includes every active employee grouped with totals that add up', async () => {
    const dept = await ctx.api.post('/api/users/departments').set(hdr()).send({ name: 'DR Dept' });
    const emp = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: 'DR-1', name: 'Daily Report Testee', department_id: dept.body.id, rest_days: [] });
    expect(emp.status).toBe(201);

    const res = await ctx.api.get('/api/hr/daily-report').set(hdr());
    expect(res.status).toBe(200);
    expect(res.body.is_today).toBe(true);
    expect(typeof res.body.date).toBe('string');

    const row = res.body.employees.find((e: { id: number }) => e.id === emp.body.id);
    expect(row).toBeTruthy();
    expect(row.department_name).toBe('DR Dept');
    // No shift, no punches, no cutoff at all yet -> plain absent (or pending, but this
    // employee has no default_shift_id so "not yet due" can't apply -> absent).
    expect(row.status).toBe('absent');

    const sum = ['present', 'late', 'absent', 'leave', 'reported', 'not_scheduled', 'pending']
      .reduce((s, k) => s + res.body.totals[k], 0);
    expect(sum).toBe(res.body.totals.total);
    expect(res.body.totals.total).toBe(res.body.employees.length);

    const deptRow = res.body.by_department.find((d: { department_name: string }) => d.department_name === 'DR Dept');
    expect(deptRow.total).toBe(1);
    expect(deptRow.absent).toBe(1);
  });

  it('excludes resigned/terminated employees', async () => {
    const emp = await ctx.api.post('/api/hr/employees').set(hdr()).send({ employee_no: 'DR-2', name: 'Resigned Person' });
    await ctx.api.put(`/api/hr/employees/${emp.body.id}`).set(hdr())
      .send({ employee_no: 'DR-2', name: 'Resigned Person', status: 'resigned' });
    const res = await ctx.api.get('/api/hr/daily-report').set(hdr());
    expect(res.body.employees.some((e: { id: number }) => e.id === emp.body.id)).toBe(false);
  });

  it('a time-clock punch with no attendance_records row yet still counts as present', async () => {
    const emp = await ctx.api.post('/api/hr/employees').set(hdr()).send({ employee_no: 'DR-3', name: 'Puncher Only' });
    // Link a login so we can punch in via the mobile clock endpoint.
    const acct = await ctx.api.post('/api/users').set(hdr())
      .send({ username: 'dr_puncher', full_name: 'Puncher Only', password: 'secret1', role: 'admin_staff' });
    await ctx.api.put(`/api/hr/employees/${emp.body.id}`).set(hdr())
      .send({ employee_no: 'DR-3', name: 'Puncher Only', user_id: acct.body.id });
    const punchToken = await login(ctx.api, 'dr_puncher', 'secret1');
    const { code } = (await ctx.api.get('/api/hr/clock/code').set(hdr())).body;
    const punch = await ctx.api.post('/api/hr/clock/punch').set({ Authorization: `Bearer ${punchToken}` }).send({ code });
    expect(punch.status).toBe(200);

    const res = await ctx.api.get('/api/hr/daily-report').set(hdr());
    const row = res.body.employees.find((e: { id: number }) => e.id === emp.body.id);
    expect(row.status).toBe('present');
    expect(row.time_in).toBeTruthy();
  });

  it('an explicit past date with no data at all is absent, not pending', async () => {
    const res = await ctx.api.get('/api/hr/daily-report').query({ date: '2020-01-06' }).set(hdr()); // a Monday
    expect(res.status).toBe(200);
    expect(res.body.is_today).toBe(false);
    expect(res.body.employees.every((e: { status: string }) => e.status !== 'pending')).toBe(true);
  });

  it('rejects a malformed date by silently falling back to today rather than 500ing', async () => {
    const res = await ctx.api.get('/api/hr/daily-report').query({ date: 'not-a-date' }).set(hdr());
    expect(res.status).toBe(200);
    expect(res.body.is_today).toBe(true);
  });

  it('a day linked to a reported_absence form reads "reported", not plain absent', async () => {
    const todayStr = (() => {
      const d = new Date();
      const p = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    })();
    const dept = await ctx.api.post('/api/users/departments').set(hdr()).send({ name: 'DR Reported Dept' });
    const emp = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: 'DR-5', name: 'Reported Person', department_id: dept.body.id, rest_days: [] });
    const period = await ctx.api.post('/api/hr/periods').set(hdr())
      .send({ label: 'DR Reported Cutoff', start_date: todayStr, end_date: todayStr });

    const defs = (await ctx.api.get('/api/form-definitions').set(hdr())).body;
    const reportedDef = defs.find((f: { slug: string }) => f.slug === 'reported_absence');
    expect(reportedDef).toBeTruthy();
    const record = await ctx.api.post('/api/form-records').set(hdr()).send({
      form_def_id: reportedDef.id, status: 'approved',
      data: { employee_name: 'Reported Person', work_date: todayStr, reason: 'Sick, messaged the group chat' },
    });
    expect(record.status).toBe(201);

    const save = await ctx.api.put(`/api/hr/periods/${period.body.id}/attendance`).set(hdr()).send({
      employee_id: emp.body.id, days: [{ work_date: todayStr, form_record_ids: [record.body.id] }],
    });
    expect(save.status).toBe(200);

    const res = await ctx.api.get('/api/hr/daily-report').set(hdr());
    const row = res.body.employees.find((e: { id: number }) => e.id === emp.body.id);
    expect(row.status).toBe('reported');

    const deptRow = res.body.by_department.find((d: { department_name: string }) => d.department_name === 'DR Reported Dept');
    expect(deptRow.reported).toBe(1);
    expect(deptRow.absent).toBe(0);
  });
});
