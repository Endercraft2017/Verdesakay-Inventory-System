/** src/hr-daily-report.ts (pure classifier) + GET /api/hr/daily-report (the route that
    resolves DB inputs for it). */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { classifyDailyStatus, type DailyStatusInput } from '../src/modules/hr/hr-daily-report';
import { computeAttendanceForEmployee } from '../src/modules/payroll/hr-payroll-compute';
import type { PayrollPolicy } from '../src/shared/types';
import { setupApp, cleanup, login, phonePunch, type TestContext } from './helpers';

// Same fixed-basis policy tests/hr-payroll-compute.test.ts uses (lunch 60, grace 10).
const PAYROLL_POLICY: PayrollPolicy = {
  grace_minutes: 10, late_unit: 'hour', ot_unit: '30min', ot_rate_percent: 125, require_ot_form: true,
  night_diff_enabled: false, night_diff_percent: 10, night_start: '22:00', night_end: '06:00',
  monthly_rate_divisor: 26, pay_frequency: 'semi_monthly', auto_statutory: true, default_rest_days: [0, 6],
  min_work_minutes: 0, lunch_break_minutes: 60, count_lunch_as_worked: false, count_lunch_late_as_late: false,
  hours_basis: 'fixed', hours_basis_unit: '30min', whole_day_min_minutes: 0, max_ot_hours: null,
  special_holiday_premium_mode: 'flat', holiday_adjacency_requirement: 'none',
};

const SHIFT = { start_time: '08:00', end_time: '17:00' };
function input(overrides: Partial<DailyStatusInput>): DailyStatusInput {
  return {
    time_in: null, shift: SHIFT, on_leave: false, reported: false, holiday: null, no_work: null,
    is_rest_day: false, grace_minutes: 10, now: null, lunch_minutes: 60,
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

  it('one minute past grace -> late, with the whole lateness reported (same as payroll)', () => {
    const r = classifyDailyStatus(input({ time_in: '08:11' }));
    expect(r.status).toBe('late');
    expect(r.late_minutes).toBe(11);
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

  it('no time_in but a time_out (forgot to time in) -> present, not absent', () => {
    const r = classifyDailyStatus(input({ time_out: '17:06' }));
    expect(r.status).toBe('present');
    expect(r.note).toMatch(/no time-in/i);
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

// 08:00-17:00 with a 60-min lunch -> lunch gap 12:00-13:00; the PM half starts 13:00. Grace 10.
describe('classifyDailyStatus — half days', () => {
  it('first time-in just after lunch starts (12:01) -> PM half day, not late, even still clocked in', () => {
    const r = classifyDailyStatus(input({ time_in: '12:01' }));
    expect(r.status).toBe('half_day');
    expect(r.half_day_session).toBe('Afternoon (PM)');
    expect(r.late_minutes).toBe(0);
    expect(r.note).toMatch(/no Half Day form filed/);
  });

  it('13:30 -> PM half day, late against the PM half\'s 13:00 start (past grace)', () => {
    const r = classifyDailyStatus(input({ time_in: '13:30' }));
    expect(r.status).toBe('half_day');
    expect(r.late_minutes).toBe(30);
    expect(r.note).toMatch(/30m late/);
  });

  it('11:59 is before lunch -> an ordinary late whole day, not a half day', () => {
    const r = classifyDailyStatus(input({ time_in: '11:59' }));
    expect(r.status).toBe('late');
  });

  it('came in the morning and left at lunch, no form -> AM half day (flagged: no form filed)', () => {
    const r = classifyDailyStatus(input({ time_in: '08:00', time_out: '12:05' }));
    expect(r.status).toBe('half_day');
    expect(r.half_day_session).toBe('Morning (AM)');
    expect(r.note).toMatch(/no Half Day form filed/);
  });

  it('a late morning arrival on an AM half day is still late against the shift start', () => {
    const r = classifyDailyStatus(input({ time_in: '08:40', time_out: '12:00' }));
    expect(r.status).toBe('half_day');
    expect(r.late_minutes).toBe(40);
  });

  it('out for lunch and not back: still lunch until the lunch gap + 60 min has passed', () => {
    const base = { time_in: '08:00', left_at_lunch: '12:00' };
    expect(classifyDailyStatus(input({ ...base, now: '12:30' })).status).toBe('present');
    expect(classifyDailyStatus(input({ ...base, now: '14:00' })).status).toBe('present');
    const gone = classifyDailyStatus(input({ ...base, now: '14:01' }));
    expect(gone.status).toBe('half_day');
    expect(gone.note).toMatch(/left at lunch 12:00/);
    expect(classifyDailyStatus(input({ ...base, now: null })).status).toBe('half_day'); // a past date
  });

  it('a linked Half Day form counts from the moment they arrive, with its own session', () => {
    const am = classifyDailyStatus(input({ time_in: '08:00', half_day_form: { session: 'Morning (AM)' }, has_linked_forms: true }));
    expect(am.status).toBe('half_day');
    expect(am.note).toMatch(/Half Day form filed/);
    const pm = classifyDailyStatus(input({ time_in: '13:05', half_day_form: { session: 'Afternoon (PM)' }, has_linked_forms: true }));
    expect(pm.half_day_session).toBe('Afternoon (PM)');
    expect(pm.late_minutes).toBe(0);
  });

  it('a PM Half Day form moves "not yet due in" to the PM start', () => {
    const form = { half_day_form: { session: 'Afternoon (PM)' }, has_linked_forms: true };
    const waiting = classifyDailyStatus(input({ ...form, now: '12:30' }));
    expect(waiting.status).toBe('pending');
    expect(waiting.note).toMatch(/13:00/);
    expect(classifyDailyStatus(input({ ...form, now: '13:20' })).status).toBe('absent');
  });

  it('HR\'s manual half-day override counts even with no times (payroll credits it flatly too)', () => {
    const r = classifyDailyStatus(input({ half_day_override: 'am' }));
    expect(r.status).toBe('half_day');
    expect(r.note).toMatch(/by HR/);
  });

  it('a day carrying some other form (offset) is not auto-classified — same as payroll', () => {
    const r = classifyDailyStatus(input({ time_in: '13:30', has_linked_forms: true }));
    expect(r.status).toBe('late');
  });

  it('matches the payroll engine day for day', () => {
    const cases: Array<{ time_in: string; time_out: string | null; lunch_out?: string }> = [
      { time_in: '12:01', time_out: '17:00' },
      { time_in: '13:30', time_out: '17:00' },
      { time_in: '12:30', time_out: '20:00' },
      { time_in: '11:30', time_out: '17:00' },
      { time_in: '08:00', time_out: '12:05' },
      { time_in: '08:00', time_out: '13:45' },
      { time_in: '08:00', time_out: null, lunch_out: '12:00' },
      { time_in: '08:00', time_out: '17:00' },
      { time_in: '08:00', time_out: '15:00' },
    ];
    for (const c of cases) {
      const report = classifyDailyStatus(input({ time_in: c.time_in, time_out: c.time_out, left_at_lunch: c.lunch_out ?? null }));
      const payroll = computeAttendanceForEmployee(
        [{ work_date: '2026-08-03', time_in: c.time_in, time_out: c.time_out, lunch_out: c.lunch_out ?? null, shift: SHIFT, linkedForms: [] }],
        800, { ...PAYROLL_POLICY, lunch_break_minutes: 60, grace_minutes: 10 }
      ).days[0]!;
      expect({ case: c, half: report.status === 'half_day' }).toEqual({ case: c, half: payroll.status === 'half_day' });
      expect({ case: c, late: report.late_minutes > 0 }).toEqual({ case: c, late: payroll.late_minutes > 0 });
    }
  });
});

describe('GET /api/hr/daily-report', () => {
  let ctx: TestContext;
  let adminToken: string;
  let cutoffId: number;
  const hdr = () => ({ Authorization: `Bearer ${adminToken}` });
  const todayStr = (() => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  })();
  const addToRoster = async (employeeId: number) => {
    const r = await ctx.api.post(`/api/hr/periods/${cutoffId}/employees`).set(hdr()).send({ employee_id: employeeId });
    expect(r.status).toBe(201);
  };

  beforeAll(async () => {
    ctx = await setupApp();
    adminToken = await login(ctx.api);
  });
  afterAll(() => cleanup(ctx));

  it('requires auth', async () => {
    expect((await ctx.api.get('/api/hr/daily-report')).status).toBe(401);
  });

  it('with no cutoff covering the date, the board is empty', async () => {
    await ctx.api.post('/api/hr/employees').set(hdr()).send({ employee_no: 'DR-0', name: 'No Cutoff Yet', rest_days: [] });
    const res = await ctx.api.get('/api/hr/daily-report').set(hdr());
    expect(res.status).toBe(200);
    expect(res.body.periods).toEqual([]);
    expect(res.body.employees).toEqual([]);
    expect(res.body.totals.total).toBe(0);

    const cutoff = await ctx.api.post('/api/hr/periods').set(hdr())
      .send({ label: 'DR Today Cutoff', start_date: todayStr, end_date: todayStr });
    expect(cutoff.status).toBe(201);
    cutoffId = cutoff.body.id;
  });

  it('defaults to today, includes every rostered active employee grouped with totals that add up', async () => {
    const dept = await ctx.api.post('/api/users/departments').set(hdr()).send({ name: 'DR Dept' });
    const emp = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: 'DR-1', name: 'Daily Report Testee', department_id: dept.body.id, rest_days: [] });
    expect(emp.status).toBe(201);
    await addToRoster(emp.body.id);

    const res = await ctx.api.get('/api/hr/daily-report').set(hdr());
    expect(res.status).toBe(200);
    expect(res.body.is_today).toBe(true);
    expect(typeof res.body.date).toBe('string');

    const row = res.body.employees.find((e: { id: number }) => e.id === emp.body.id);
    expect(row).toBeTruthy();
    expect(row.department_name).toBe('DR Dept');
    // No shift, no punches, empty cutoff day -> plain absent (or pending, but this
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
    await addToRoster(emp.body.id);
    const res = await ctx.api.get('/api/hr/daily-report').set(hdr());
    expect(res.body.employees.some((e: { id: number }) => e.id === emp.body.id)).toBe(false);
  });

  it('a time-clock punch with no attendance_records row yet still counts as present', async () => {
    const emp = await ctx.api.post('/api/hr/employees').set(hdr()).send({ employee_no: 'DR-3', name: 'Puncher Only' });
    // Link a login so we can punch in via the mobile clock endpoint.
    const acct = await ctx.api.post('/api/users').set(hdr())
      .send({ username: 'dr_puncher', full_name: 'Puncher Only', password: 'secret123', role: 'admin_staff' });
    await ctx.api.put(`/api/hr/employees/${emp.body.id}`).set(hdr())
      .send({ employee_no: 'DR-3', name: 'Puncher Only', user_id: acct.body.id });
    await addToRoster(emp.body.id);
    const punchToken = await login(ctx.api, 'dr_puncher', 'secret123');
    const { code } = (await ctx.api.get('/api/hr/clock/code').set(hdr())).body;
    const punch = await phonePunch(ctx.api, { Authorization: `Bearer ${punchToken}` }, { code });
    expect(punch.status).toBe(200);

    const res = await ctx.api.get('/api/hr/daily-report').set(hdr());
    const row = res.body.employees.find((e: { id: number }) => e.id === emp.body.id);
    expect(row.status).toBe('present');
    expect(row.time_in).toBeTruthy();
  });

  it('an explicit past date on a cutoff with no data at all is absent, not pending', async () => {
    const past = await ctx.api.post('/api/hr/periods').set(hdr())
      .send({ label: 'DR Past Cutoff', start_date: '2020-01-06', end_date: '2020-01-06' }); // a Monday
    const emp = await ctx.api.post('/api/hr/employees').set(hdr()).send({ employee_no: 'DR-4', name: 'Past Person', rest_days: [] });
    await ctx.api.post(`/api/hr/periods/${past.body.id}/employees`).set(hdr()).send({ employee_id: emp.body.id });

    const res = await ctx.api.get('/api/hr/daily-report').query({ date: '2020-01-06' }).set(hdr());
    expect(res.status).toBe(200);
    expect(res.body.is_today).toBe(false);
    expect(res.body.employees.map((e: { id: number }) => e.id)).toEqual([emp.body.id]);
    expect(res.body.employees.every((e: { status: string }) => e.status !== 'pending')).toBe(true);
  });

  it('rejects a malformed date by silently falling back to today rather than 500ing', async () => {
    const res = await ctx.api.get('/api/hr/daily-report').query({ date: 'not-a-date' }).set(hdr());
    expect(res.status).toBe(200);
    expect(res.body.is_today).toBe(true);
  });

  it('a day linked to a reported_absence form reads "reported", not plain absent', async () => {
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

  it('once a cutoff covers the date, only that cutoff\'s roster is reported', async () => {
    // Two cutoffs cover today by now (DR Today Cutoff + DR Reported Cutoff): the roster is their union.
    const offRoster = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: 'DR-6', name: 'Not On Cutoff', rest_days: [] });
    expect(offRoster.status).toBe(201);

    const res = await ctx.api.get('/api/hr/daily-report').set(hdr());
    expect(res.body.periods.map((p: { label: string }) => p.label).sort()).toEqual(['DR Reported Cutoff', 'DR Today Cutoff']);
    const ids = res.body.employees.map((e: { id: number }) => e.id);
    expect(ids).not.toContain(offRoster.body.id);
    expect(ids).not.toContain((await ctx.api.get('/api/hr/employees').set(hdr())).body
      .find((e: { employee_no: string }) => e.employee_no === 'DR-0')?.id);
    const names = res.body.employees.map((e: { name: string }) => e.name);
    expect(names).toEqual(expect.arrayContaining(['Daily Report Testee', 'Puncher Only', 'Reported Person']));
    expect(res.body.totals.total).toBe(res.body.employees.length);
  });

  it('half days: after-lunch arrival (late or not) and left-at-lunch, tallied in their own bucket', async () => {
    const date = '2020-01-07'; // a past Tuesday -> no live "still at lunch" window
    const period = await ctx.api.post('/api/hr/periods').set(hdr()).send({ label: 'DR Half Day Cutoff', start_date: date, end_date: date });
    const shift = await ctx.api.post('/api/hr/shifts').set(hdr()).send({ name: 'DR 8-5', start_time: '08:00', end_time: '17:00' });
    const dept = await ctx.api.post('/api/users/departments').set(hdr()).send({ name: 'DR Half Dept' });
    const days: Record<string, Record<string, string>> = {
      'DR-H1': { time_in: '12:01', time_out: '17:00' },
      'DR-H2': { time_in: '13:30', time_out: '17:00' },
      'DR-H3': { time_in: '08:00', lunch_out: '12:00' },
      'DR-H4': { time_in: '11:30', time_out: '17:00' },
    };
    const ids: Record<string, number> = {};
    for (const [no, times] of Object.entries(days)) {
      const emp = await ctx.api.post('/api/hr/employees').set(hdr())
        .send({ employee_no: no, name: `Half ${no}`, department_id: dept.body.id, rest_days: [] });
      ids[no] = emp.body.id;
      const save = await ctx.api.put(`/api/hr/periods/${period.body.id}/attendance`).set(hdr())
        .send({ employee_id: emp.body.id, days: [{ work_date: date, shift_id: shift.body.id, ...times }] });
      expect(save.status).toBe(200);
    }

    const res = await ctx.api.get('/api/hr/daily-report').query({ date }).set(hdr());
    const row = (no: string) => res.body.employees.find((e: { id: number }) => e.id === ids[no]);
    expect(row('DR-H1')).toMatchObject({ status: 'half_day', half_day_session: 'Afternoon (PM)', late_minutes: 0 });
    expect(row('DR-H2').status).toBe('half_day');
    expect(row('DR-H2').late_minutes).toBeGreaterThan(0);
    expect(row('DR-H3')).toMatchObject({ status: 'half_day', half_day_session: 'Morning (AM)', time_out: '12:00' });
    expect(row('DR-H4').status).toBe('late');

    const deptRow = res.body.by_department.find((d: { department_name: string }) => d.department_name === 'DR Half Dept');
    expect(deptRow).toMatchObject({ half_day: 3, late: 1, total: 4 });
  });
});
