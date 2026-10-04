/** A time-out earlier than the time-in is the NEXT morning, whatever the shift — a driver on an
    08:00-17:00 shift who clocks in at 08:00 and out at 06:00 the next day worked ~22 hours, not
    "left 11 hours early". Before this, only an overnight SHIFT (end before start) put a time-out
    on the next day, so a day-shift employee who stayed past midnight was docked as undertime. */
import { describe, it, expect } from 'vitest';
import { computeAttendanceForEmployee, unrecordedOtMinutes, type AttendanceDay } from '../src/modules/payroll/hr-payroll-compute';
import type { PayrollPolicy } from '../src/shared/types';

const POLICY: PayrollPolicy = {
  grace_minutes: 10, late_unit: 'hour', ot_unit: '30min', ot_rate_percent: 125, require_ot_form: true,
  night_diff_enabled: false, night_diff_percent: 10, night_start: '22:00', night_end: '06:00',
  monthly_rate_divisor: 26, pay_frequency: 'semi_monthly', auto_statutory: true, default_rest_days: [0, 6],
  min_work_minutes: 0, lunch_break_minutes: 60, count_lunch_as_worked: false, count_lunch_late_as_late: false,
  hours_basis: 'fixed', hours_basis_unit: '30min', whole_day_min_minutes: 0, max_ot_hours: null,
  special_holiday_premium_mode: 'flat', holiday_adjacency_requirement: 'none',
};
const DAILY_RATE = 800; // hourly = 100
const SHIFT = { start_time: '08:00', end_time: '17:00' };
const OT_FORM = { slug: 'overtime_request', data: {} };

function day(overrides: Partial<AttendanceDay>): AttendanceDay {
  return { work_date: '2026-09-20', time_in: '08:00', time_out: '06:00', shift: SHIFT, linkedForm: null, ...overrides };
}

describe('time-out on the next morning, day shift', () => {
  it('is a full day with no undertime (OT still needs its form)', () => {
    const r = computeAttendanceForEmployee([day({})], DAILY_RATE, POLICY);
    expect(r.days_worked).toBe(1);
    expect(r.days_absent).toBe(0);
    expect(r.undertime_pay).toBe(0);
    expect(r.late_deduction).toBe(0);
    expect(r.overtime_pay).toBe(0);
  });

  it('pays the hours past the shift end as OT once an Overtime form is linked', () => {
    const r = computeAttendanceForEmployee([day({ linkedForm: OT_FORM })], DAILY_RATE, POLICY);
    expect(r.ot_hours).toBe(13); // 17:00 -> 06:00
    expect(r.overtime_pay).toBeCloseTo(13 * 100 * 1.25, 6);
  });

  it('auto-pays that OT when the policy does not require a form', () => {
    const r = computeAttendanceForEmployee([day({})], DAILY_RATE, { ...POLICY, require_ot_form: false });
    expect(r.ot_hours).toBe(13);
  });

  it('flags the unfiled OT for HR', () => {
    expect(unrecordedOtMinutes(day({}), POLICY)).toBe(13 * 60);
  });

  it('pays night differential only for paid time: none without the OT form, 22:00-06:00 with it', () => {
    const nd = { ...POLICY, night_diff_enabled: true };
    expect(computeAttendanceForEmployee([day({})], DAILY_RATE, nd).night_diff_pay).toBe(0);
    expect(computeAttendanceForEmployee([day({ linkedForm: OT_FORM })], DAILY_RATE, nd).night_diff_pay)
      .toBeCloseTo(8 * 100 * 0.10, 6);
  });

  it('pays the prorated special-holiday premium for the hours actually worked (capped at 8)', () => {
    const r = computeAttendanceForEmployee(
      [day({ holiday: 'special_non_working' })], DAILY_RATE, { ...POLICY, special_holiday_premium_mode: 'prorated' }
    );
    expect(r.special_holiday_30).toBeCloseTo(8 * 100 * 0.3, 6);
  });

  it('per-hour basis pays the full shift, not zero minutes', () => {
    const r = computeAttendanceForEmployee([day({})], DAILY_RATE, { ...POLICY, hours_basis: 'per_hour' });
    expect(r.days_worked).toBe(1);
    expect(r.undertime_pay).toBe(0);
  });

  it('leaves a normal same-day shift unchanged', () => {
    const r = computeAttendanceForEmployee([day({ time_out: '15:00' })], DAILY_RATE, POLICY);
    expect(r.undertime_pay).toBeCloseTo(-200, 6); // left 2h early
  });
});
