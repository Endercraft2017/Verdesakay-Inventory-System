/** Per-employee "Always paid a whole day" (employees.always_whole_day): any day with both a
    time-in and a time-out earns the full daily basic whatever the times — no half day (guessed,
    HR-marked or filed), late, undertime or Undertime Day. OT, night differential and holiday /
    rest-day premiums keep their normal rules; a day missing a punch is handled as usual. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { computeAttendanceForEmployee, computeAttendanceMultiRate, type AttendanceDay } from '../src/modules/payroll/hr-payroll-compute';
import type { PayrollPolicy } from '../src/shared/types';
import { setupApp, cleanup, login, type TestContext } from './helpers';

const POLICY: PayrollPolicy = {
  grace_minutes: 0, late_unit: 'minute', ot_unit: 'hour', ot_rate_percent: 125, require_ot_form: true,
  night_diff_enabled: true, night_diff_percent: 10, night_start: '22:00', night_end: '06:00',
  monthly_rate_divisor: 26, pay_frequency: 'semi_monthly', auto_statutory: true, default_rest_days: [0],
  min_work_minutes: 0, lunch_break_minutes: 60, count_lunch_as_worked: false, count_lunch_late_as_late: true,
  hours_basis: 'fixed', hours_basis_unit: '30min', whole_day_min_minutes: 0, max_ot_hours: 2,
  special_holiday_premium_mode: 'flat', holiday_adjacency_requirement: 'none',
};
const DAILY_RATE = 800; // hourly 100
const SHIFT = { start_time: '08:00', end_time: '17:00' };

function day(overrides: Partial<AttendanceDay>): AttendanceDay {
  return { work_date: '2026-09-18', time_in: '08:00', time_out: '17:00', shift: SHIFT, linkedForm: null, ...overrides };
}
const whole = (d: AttendanceDay, policy: PayrollPolicy = POLICY) =>
  computeAttendanceForEmployee([d], DAILY_RATE, policy, false, false, true);

describe('always a whole day — compute', () => {
  it('late and early out on the same day: a full day, no late, no undertime', () => {
    const r = whole(day({ time_in: '08:18', time_out: '14:00' }));
    expect(r.days_worked).toBe(1);
    expect(r.days_half).toBe(0);
    expect(r.late_deduction).toBe(0);
    expect(r.undertime_pay).toBe(0);
    expect(r.days[0]!).toMatchObject({ status: 'worked', late_minutes: 0, undertime_minutes: 0, possible_half_day: false });
  });

  it('an afternoon-only day (would be a guessed half day) is a whole day', () => {
    const r = whole(day({ time_in: '13:30', time_out: '17:00' }));
    expect(r.days_worked).toBe(1);
    expect(r.days[0]!.possible_half_day).toBe(false);
    // Without the switch it's a half day — the switch is what changed it.
    expect(computeAttendanceForEmployee([day({ time_in: '13:30', time_out: '17:00' })], DAILY_RATE, POLICY).days_worked).toBe(0.5);
  });

  it('overrides a filed Half Day request and HR\'s manual half-day mark', () => {
    expect(whole(day({ time_out: '12:00', linkedForms: [{ slug: 'halfday_request', data: { session: 'Morning (AM)' } }] })).days_worked).toBe(1);
    expect(whole(day({ time_out: '12:00', halfDayOverride: 'am' })).days_worked).toBe(1);
  });

  it('no Undertime Day, per-hour proration or below-minimum denial', () => {
    expect(whole(day({ time_out: '10:00' }), { ...POLICY, whole_day_min_minutes: 420 }).days_worked).toBe(1);
    expect(whole(day({ time_out: '10:00' }), { ...POLICY, hours_basis: 'per_hour' }).days_worked).toBe(1);
    expect(whole(day({ time_out: '10:00', minHoursDecision: 'deny' }), { ...POLICY, min_work_minutes: 240 }).days_worked).toBe(1);
  });

  it('no lunch lateness either', () => {
    expect(whole(day({ lunch_out: '12:00', lunch_in: '13:45' })).late_deduction).toBe(0);
  });

  it('OT still follows the usual rules', () => {
    expect(whole(day({ time_out: '19:00', linkedForms: [{ slug: 'overtime_request', data: {} }] })).ot_hours).toBe(2);
    expect(whole(day({ time_out: '19:00' })).ot_hours).toBe(0); // no form, and the policy requires one
  });

  it('a day missing a punch is handled as usual', () => {
    expect(whole(day({ time_in: null, time_out: null })).days_absent).toBe(1);
    // Timed out for lunch and never came back — no real time-out, so the usual half day.
    expect(whole(day({ time_out: null, lunch_out: '12:00', lunch_in: null })).days_worked).toBe(0.5);
  });

  it('computeAttendanceMultiRate passes the switch through', () => {
    const { computed, basicSalary } = computeAttendanceMultiRate(
      [day({ time_in: '08:18', time_out: '14:00' })], () => DAILY_RATE, POLICY, false, false, true
    );
    expect(computed.days_worked).toBe(1);
    expect(basicSalary).toBe(DAILY_RATE);
  });
});

describe('always a whole day — employee record and payslips', () => {
  let ctx: TestContext;
  let token: string;
  let queryOne: typeof import('../src/shared/db').queryOne;
  const hdr = () => ({ Authorization: `Bearer ${token}` });
  beforeAll(async () => {
    ctx = await setupApp();
    ({ queryOne } = await import('../src/shared/db'));
    token = await login(ctx.api);
  });
  afterAll(() => cleanup(ctx));

  it('round-trips on the employee; an update that omits it keeps it', async () => {
    const base = { employee_no: 'TEST-WHOLE-1', name: 'Whole Day One', daily_rate: 800, rate_type: 'daily', status: 'regular' };
    const created = await ctx.api.post('/api/hr/employees').set(hdr()).send({ ...base, always_whole_day: true });
    expect(created.status).toBe(201);
    const flag = () => queryOne<{ always_whole_day: number }>('SELECT always_whole_day FROM employees WHERE id = ?', created.body.id)!.always_whole_day;
    expect(flag()).toBe(1);
    expect((await ctx.api.put(`/api/hr/employees/${created.body.id}`).set(hdr()).send(base)).status).toBe(200);
    expect(flag()).toBe(1);
    expect((await ctx.api.put(`/api/hr/employees/${created.body.id}`).set(hdr()).send({ ...base, always_whole_day: false })).status).toBe(200);
    expect(flag()).toBe(0);
  });

  it('generate-payslips pays a late, early-out day in full; the detail says why', async () => {
    const shift = await ctx.api.post('/api/hr/shifts').set(hdr())
      .send({ name: 'Whole Day Shift', start_time: '08:00', end_time: '17:00', is_default: false });
    const emp = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: 'TEST-WHOLE-2', name: 'Whole Day Two', daily_rate: 800, always_whole_day: true });
    const period = await ctx.api.post('/api/hr/periods').set(hdr())
      .send({ label: 'Whole Day Cutoff', start_date: '2026-09-18', end_date: '2026-09-18' });
    await ctx.api.post(`/api/hr/periods/${period.body.id}/employees`).set(hdr()).send({ employee_id: emp.body.id });
    await ctx.api.put(`/api/hr/periods/${period.body.id}/attendance`).set(hdr()).send({
      employee_id: emp.body.id,
      days: [{ work_date: '2026-09-18', time_in: '08:18', time_out: '14:00', notes: '', shift_id: shift.body.id }],
    });
    const gen = await ctx.api.post(`/api/hr/periods/${period.body.id}/generate-payslips`).set(hdr()).send({ payroll_period: 'Whole Day Cutoff' });
    expect(gen.status).toBe(201);
    const records = await ctx.api.get(`/api/form-definitions/${gen.body.form_id}/records`).query({ period: 'Whole Day Cutoff' }).set(hdr());
    const rec = records.body.find((r: { data: { employee_name: string } }) => r.data.employee_name === 'Whole Day Two');
    expect(rec.data.days_worked).toBe(1);
    expect(rec.data.basic_salary).toBe(800);
    expect(rec.data.late_absences).toBe(0);
    expect(rec.data.undertime_pay).toBe(0);
    expect(gen.body.possible_half_day_employees).toBe(0);

    const detail = await ctx.api.get(`/api/hr/payroll/${rec.id}/detail`).set(hdr());
    expect(detail.body.always_whole_day).toBe(true);
    expect(detail.body.days[0].status).toBe('worked');

    const roster = await ctx.api.get(`/api/hr/periods/${period.body.id}`).set(hdr());
    expect(roster.body.roster.find((r: { employee_id: number }) => r.employee_id === emp.body.id).always_whole_day).toBe(1);
  });
});
