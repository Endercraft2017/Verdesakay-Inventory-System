/** Early OT: time before the shift start counts as overtime when the day's Overtime form has
    Early OT ticked and the time-in was at least 1 hour before the shift start. Early and
    after-shift OT share one daily cap (early first): with a 2 h cap, 1 h early leaves at most
    1 h for the afternoon. The form's approved_hours still raises the cap for that day. */
import { describe, it, expect } from 'vitest';
import { computeAttendanceForEmployee, unrecordedOtMinutes, type AttendanceDay } from '../src/modules/payroll/hr-payroll-compute';
import type { PayrollPolicy } from '../src/shared/types';

const POLICY: PayrollPolicy = {
  grace_minutes: 0, late_unit: 'minute', ot_unit: 'hour', ot_rate_percent: 125, require_ot_form: true,
  night_diff_enabled: true, night_diff_percent: 10, night_start: '22:00', night_end: '06:00',
  monthly_rate_divisor: 26, pay_frequency: 'semi_monthly', auto_statutory: true, default_rest_days: [0],
  min_work_minutes: 0, lunch_break_minutes: 60, count_lunch_as_worked: false, count_lunch_late_as_late: false,
  hours_basis: 'fixed', hours_basis_unit: '30min', whole_day_min_minutes: 0, max_ot_hours: null,
  special_holiday_premium_mode: 'flat', holiday_adjacency_requirement: 'none',
};
const DAILY_RATE = 800; // hourly = 100, OT hour = 125
const SHIFT = { start_time: '09:00', end_time: '18:00' };
const ot = (data: Record<string, unknown> = {}) => [{ slug: 'overtime_request', data }];

function day(overrides: Partial<AttendanceDay>): AttendanceDay {
  return { work_date: '2026-10-05', time_in: '06:00', time_out: '19:00', shift: SHIFT, linkedForm: null, ...overrides };
}
const run = (d: AttendanceDay, policy: PayrollPolicy = POLICY) => computeAttendanceForEmployee([d], DAILY_RATE, policy);

describe('early OT', () => {
  it('pays the time before the shift start when the form has Early OT ticked', () => {
    const r = run(day({ linkedForms: ot({ early_ot: true }) }));
    expect(r.ot_hours).toBe(4); // 06:00-09:00 early + 18:00-19:00 after
    expect(r.overtime_pay).toBeCloseTo(4 * 125, 6);
    expect(r.late_deduction).toBe(0);
  });

  it('accepts the phone form\'s "Yes" as ticked', () => {
    expect(run(day({ linkedForms: ot({ early_ot: 'Yes' }) })).ot_hours).toBe(4);
  });

  it('without the tick, only the after-shift OT is paid', () => {
    expect(run(day({ linkedForms: ot({}) })).ot_hours).toBe(1);
    expect(run(day({ linkedForms: ot({ early_ot: false }) })).ot_hours).toBe(1);
    expect(run(day({ linkedForms: ot({ early_ot: 'No' }) })).ot_hours).toBe(1);
  });

  it('needs a time-in at least 1 hour before the shift start', () => {
    const minuteUnit = { ...POLICY, ot_unit: 'minute' as const };
    const r = run(day({ time_in: '08:15', time_out: '18:00', linkedForms: ot({ early_ot: true }) }), minuteUnit);
    expect(r.ot_hours).toBe(0);
  });

  it('is never automatic, even when the policy doesn\'t require an OT form', () => {
    expect(run(day({}), { ...POLICY, require_ot_form: false }).ot_hours).toBe(1);
  });

  it('early OT uses the daily cap first: 1 h early leaves 1 h for the afternoon under a 2 h cap', () => {
    const capped = { ...POLICY, max_ot_hours: 2 };
    const r = run(day({ time_in: '08:00', time_out: '21:00', linkedForms: ot({ early_ot: true }) }), capped);
    expect(r.ot_hours).toBe(2); // 1 early + 1 of the 3 after-shift hours
    expect(r.overtime_pay).toBeCloseTo(2 * 125, 6);
  });

  it('early OT alone can fill the cap, leaving nothing for the afternoon', () => {
    const r = run(day({ linkedForms: ot({ early_ot: true }) }), { ...POLICY, max_ot_hours: 2 });
    expect(r.ot_hours).toBe(2);
  });

  it('approved_hours raises the shared cap for that day', () => {
    const r = run(day({ linkedForms: ot({ early_ot: true, approved_hours: 4 }) }), { ...POLICY, max_ot_hours: 2 });
    expect(r.ot_hours).toBe(4);
  });

  it('night differential covers paid early OT inside the night window, not unpaid early time', () => {
    const early = day({ time_in: '05:00', time_out: '18:00' });
    expect(run({ ...early, linkedForms: ot({ early_ot: true }) }).night_diff_pay).toBeCloseTo(1 * 100 * 0.10, 6); // 05:00-06:00
    expect(run({ ...early, linkedForms: ot({}) }).night_diff_pay).toBe(0);
    expect(run(early).night_diff_pay).toBe(0);
  });

  it('a day without early time is unchanged', () => {
    const r = run(day({ time_in: '09:00', time_out: '18:00', linkedForms: ot({ early_ot: true }) }));
    expect(r.ot_hours).toBe(0);
    expect(r.days_worked).toBe(1);
  });
});

describe('unrecorded OT includes possible early OT', () => {
  it('flags early (1 h+) and after-shift time when no OT form is linked', () => {
    expect(unrecordedOtMinutes(day({}), POLICY)).toBe(4 * 60);
  });
  it('ignores early time under 1 hour', () => {
    expect(unrecordedOtMinutes(day({ time_in: '08:15', time_out: '18:00' }), { ...POLICY, ot_unit: 'minute' })).toBe(0);
  });
});
