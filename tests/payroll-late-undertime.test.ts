/** Late + undertime on a whole day, and the "Half Day (unlinked)" guess. Modelled on a real
    payslip (2nd cutoff September 2026): 08:18-14:00 on an 08:00-17:00 shift with an unpaid
    Undertime Request linked is a whole day less 18 min late and 180 min undertime — exactly the
    282 working minutes present — and must not be badged as a half day.
    Late and undertime never charge the unpaid lunch hour. */
import { describe, it, expect } from 'vitest';
import { computeAttendanceForEmployee, type AttendanceDay } from '../src/modules/payroll/hr-payroll-compute';
import type { PayrollPolicy } from '../src/shared/types';

const POLICY: PayrollPolicy = {
  grace_minutes: 0, late_unit: 'minute', ot_unit: 'hour', ot_rate_percent: 125, require_ot_form: true,
  night_diff_enabled: true, night_diff_percent: 10, night_start: '22:00', night_end: '06:00',
  monthly_rate_divisor: 26, pay_frequency: 'semi_monthly', auto_statutory: true, default_rest_days: [0],
  min_work_minutes: 0, lunch_break_minutes: 60, count_lunch_as_worked: false, count_lunch_late_as_late: false,
  hours_basis: 'fixed', hours_basis_unit: '30min', whole_day_min_minutes: 0, max_ot_hours: 2,
  special_holiday_premium_mode: 'flat', holiday_adjacency_requirement: 'none',
};
const DAILY_RATE = 750; // hourly 93.75, 1.5625 a minute
const PER_MIN = DAILY_RATE / 8 / 60;
const SHIFT = { start_time: '08:00', end_time: '17:00' };
const unpaidUndertime = [{ slug: 'undertime_request', data: { with_pay: 'No' } }];

function day(overrides: Partial<AttendanceDay>): AttendanceDay {
  return { work_date: '2026-09-18', time_in: '08:00', time_out: '17:00', shift: SHIFT, linkedForm: null, ...overrides };
}
const run = (d: AttendanceDay, policy: PayrollPolicy = POLICY) => computeAttendanceForEmployee([d], DAILY_RATE, policy);

describe('late + undertime on a whole day', () => {
  it('an unpaid Undertime Request day: whole day less late and undertime, not flagged a half day', () => {
    const r = run(day({ time_in: '08:18', time_out: '14:00', linkedForms: unpaidUndertime }));
    const d = r.days[0]!;
    expect(d.status).toBe('worked');
    expect(d.possible_half_day).toBe(false);
    expect(r.days_worked).toBe(1);
    expect(d.late_minutes).toBe(18);
    expect(d.undertime_minutes).toBe(180);
    expect(r.late_deduction).toBeCloseTo(18 * PER_MIN, 6);   // 28.13
    expect(r.undertime_pay).toBeCloseTo(-180 * PER_MIN, 6);  // -281.25
    // Net pay for the day = exactly the 282 working minutes present (08:18-12:00 + 13:00-14:00).
    expect(DAILY_RATE - r.late_deduction + r.undertime_pay).toBeCloseTo(282 * PER_MIN, 6);
  });

  it('the same times with no form at all are still paid (and flagged) as a morning half day', () => {
    const d = run(day({ time_in: '08:18', time_out: '14:00' })).days[0]!;
    expect(d.status).toBe('half_day');
    expect(d.possible_half_day).toBe(true);
  });

  it('no Half Day guess on a day linked to any other form', () => {
    const d = run(day({ time_in: '12:45', time_out: '17:04', linkedForms: [{ slug: 'overtime_request', data: {} }] })).days[0]!;
    expect(d.possible_half_day).toBe(false);
    expect(d.status).toBe('worked');
  });

  it('a with-pay Undertime Request charges no undertime minutes', () => {
    const d = run(day({ time_out: '14:00', linkedForms: [{ slug: 'undertime_request', data: { with_pay: 'Yes' } }] })).days[0]!;
    expect(d.undertime_minutes).toBe(0);
    expect(d.undertime_pay).toBe(0);
  });

  it('leaving during the morning doesn\'t charge the lunch hour as undertime', () => {
    const d = run(day({ time_out: '11:00', linkedForms: unpaidUndertime })).days[0]!;
    expect(d.undertime_minutes).toBe(300); // 11:00-12:00 + 13:00-17:00, not 360
  });

  it('leaving during lunch charges only the afternoon', () => {
    const d = run(day({ time_out: '12:30', linkedForms: unpaidUndertime })).days[0]!;
    expect(d.undertime_minutes).toBe(240);
  });

  it('arriving after lunch doesn\'t charge the lunch hour as late', () => {
    const d = run(day({ time_in: '13:30', linkedForms: unpaidUndertime })).days[0]!;
    expect(d.late_minutes).toBe(270); // 08:00-12:00 + 13:00-13:30, not 330
  });

  it('grace is a threshold, not a later start: 6 min late with a 5 min grace is 6 minutes', () => {
    const graced = { ...POLICY, grace_minutes: 5 };
    expect(run(day({ time_in: '08:05' }), graced).days[0]!.late_minutes).toBe(0); // within grace
    const late = run(day({ time_in: '08:06' }), graced);
    expect(late.days[0]!.late_minutes).toBe(6);
    expect(late.late_deduction).toBeCloseTo(6 * PER_MIN, 6);
  });

  it('counts lunch when the policy pays it as worked time', () => {
    const d = run(day({ time_out: '11:00', linkedForms: unpaidUndertime }), { ...POLICY, count_lunch_as_worked: true }).days[0]!;
    expect(d.undertime_minutes).toBe(360);
  });
});
