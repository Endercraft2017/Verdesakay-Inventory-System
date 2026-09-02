/** Pure unit tests for src/hr-payroll-compute.ts — the late/OT/undertime/holiday/leave rules are
    exactly the kind of finicky business logic worth pinning down precisely, independent of any
    DB or HTTP concerns (the module itself takes plain data in, plain numbers out). */
import { describe, it, expect } from 'vitest';
import { computeAttendanceForEmployee, type AttendanceDay } from '../src/hr-payroll-compute';
import type { PayrollPolicy } from '../src/types';

const POLICY: PayrollPolicy = {
  grace_minutes: 10,
  late_unit: 'hour',
  ot_unit: '30min',
  ot_rate_percent: 125,
  night_diff_enabled: false,
  night_diff_percent: 10,
  night_start: '22:00',
  night_end: '06:00',
  monthly_rate_divisor: 26,
  pay_frequency: 'semi_monthly',
  auto_statutory: true,
  default_rest_days: [0, 6],
};
const DAILY_RATE = 800; // hourly = 100
const SHIFT = { start_time: '08:00', end_time: '17:00' };

function day(overrides: Partial<AttendanceDay>): AttendanceDay {
  return {
    work_date: '2026-08-01',
    time_in: null,
    time_out: null,
    shift: SHIFT,
    linkedForm: null,
    ...overrides,
  };
}

describe('computeAttendanceForEmployee — grace period boundary', () => {
  it('exactly at grace (10 min late) -> no deduction', () => {
    const r = computeAttendanceForEmployee([day({ time_in: '08:10', time_out: '17:00' })], DAILY_RATE, POLICY);
    expect(r.late_deduction).toBe(0);
    expect(r.days_worked).toBe(1);
  });

  it('1 minute past grace rounds the *remainder past grace* up to a full hour block, not the raw lateness', () => {
    const r = computeAttendanceForEmployee([day({ time_in: '08:11', time_out: '17:00' })], DAILY_RATE, POLICY);
    // 11 min raw, 1 min past grace -> rounds up to 1 hour -> 1 * 100
    expect(r.late_deduction).toBe(100);
  });

  it('70 min late, 10 min grace, 1-hour block -> 60 min past grace -> 1 hour deducted', () => {
    const r = computeAttendanceForEmployee([day({ time_in: '09:10', time_out: '17:00' })], DAILY_RATE, POLICY);
    expect(r.late_deduction).toBe(100);
  });

  it('125 min late, 10 min grace, 1-hour block -> 115 min past grace -> 2 hours deducted (not 3)', () => {
    const r = computeAttendanceForEmployee([day({ time_in: '10:05', time_out: '17:00' })], DAILY_RATE, POLICY);
    expect(r.late_deduction).toBe(200);
  });

  it('minute-unit rounding applies no blocking beyond the raw past-grace minutes', () => {
    const policy = { ...POLICY, late_unit: 'minute' as const };
    const r = computeAttendanceForEmployee([day({ time_in: '08:17', time_out: '17:00' })], DAILY_RATE, policy);
    // 17 min raw, 7 min past grace -> 7 min deducted
    expect(r.late_deduction).toBeCloseTo((7 / 60) * 100, 6);
  });
});

describe('computeAttendanceForEmployee — OT rounds up, requires a linked Overtime form', () => {
  it('20 min OT with a 30-min block rounds up to 30 min counted', () => {
    const r = computeAttendanceForEmployee(
      [day({ time_in: '08:00', time_out: '17:20', linkedForm: { slug: 'overtime_request', data: {} } })],
      DAILY_RATE, POLICY
    );
    expect(r.ot_hours).toBeCloseTo(0.5, 6);
    expect(r.overtime_pay).toBeCloseTo(0.5 * 100 * 1.25, 6);
  });

  it('50 min OT with a 30-min block rounds up to 60 min counted', () => {
    const r = computeAttendanceForEmployee(
      [day({ time_in: '08:00', time_out: '17:50', linkedForm: { slug: 'overtime_request', data: {} } })],
      DAILY_RATE, POLICY
    );
    expect(r.ot_hours).toBeCloseTo(1, 6);
    expect(r.overtime_pay).toBeCloseTo(1 * 100 * 1.25, 6);
  });

  it('leaving late with NO linked Overtime form earns no OT pay at all', () => {
    const r = computeAttendanceForEmployee([day({ time_in: '08:00', time_out: '18:00' })], DAILY_RATE, POLICY);
    expect(r.ot_hours).toBe(0);
    expect(r.overtime_pay).toBe(0);
  });
});

describe('computeAttendanceForEmployee — absences, leave-with-pay, half day', () => {
  it('plain absence (no time logged, nothing linked) contributes nothing but is counted as absent', () => {
    const r = computeAttendanceForEmployee([day({})], DAILY_RATE, POLICY);
    expect(r.days_worked).toBe(0);
    expect(r.days_absent).toBe(1);
  });

  it('absence linked to a Leave form WITHOUT pay is still an unpaid absence, and still counted', () => {
    const r = computeAttendanceForEmployee(
      [day({ linkedForm: { slug: 'leave_request', data: { with_pay: 'No' } } })],
      DAILY_RATE, POLICY
    );
    expect(r.days_worked).toBe(0);
    expect(r.days_absent).toBe(1);
  });

  it('absence linked to a Leave form WITH pay counts as a full paid day, NOT an absence', () => {
    const r = computeAttendanceForEmployee(
      [day({ linkedForm: { slug: 'leave_request', data: { with_pay: 'Yes' } } })],
      DAILY_RATE, POLICY
    );
    expect(r.days_worked).toBe(1);
    expect(r.days_absent).toBe(0);
    expect(r.late_deduction).toBe(0);
  });

  it('a day linked to a Half Day form counts as 0.5, not an absence (time was logged)', () => {
    const r = computeAttendanceForEmployee(
      [day({ time_in: '08:00', time_out: '12:00', linkedForm: { slug: 'halfday_request', data: {} } })],
      DAILY_RATE, POLICY
    );
    expect(r.days_worked).toBe(0.5);
    expect(r.days_absent).toBe(0);
  });

  it('days_absent sums across multiple days, mixing present/absent/paid-leave', () => {
    const r = computeAttendanceForEmployee(
      [
        day({ work_date: '2026-08-01', time_in: '08:00', time_out: '17:00' }), // present
        day({ work_date: '2026-08-02' }), // absent
        day({ work_date: '2026-08-03' }), // absent
        day({ work_date: '2026-08-04', linkedForm: { slug: 'leave_request', data: { with_pay: 'Yes' } } }), // paid, not absent
      ],
      DAILY_RATE, POLICY
    );
    expect(r.days_worked).toBe(2); // the worked day + the paid leave day
    expect(r.days_absent).toBe(2);
  });
});

describe('computeAttendanceForEmployee — company-wide No Work Memo (no per-employee linking needed)', () => {
  it('a PAID no-work day counts as a full paid day even with nothing logged and no Leave form', () => {
    const r = computeAttendanceForEmployee([day({ noWork: 'paid' })], DAILY_RATE, POLICY);
    expect(r.days_worked).toBe(1);
    expect(r.days_absent).toBe(0);
  });

  it('an UNPAID no-work day contributes nothing, same as a plain absence (but is not a Leave form) — still counted as absent', () => {
    const r = computeAttendanceForEmployee([day({ noWork: 'unpaid' })], DAILY_RATE, POLICY);
    expect(r.days_worked).toBe(0);
    expect(r.days_absent).toBe(1);
  });

  it('a linked, paid Leave form still takes precedence over a no-work memo on the same day', () => {
    const r = computeAttendanceForEmployee(
      [day({ noWork: 'unpaid', linkedForm: { slug: 'leave_request', data: { with_pay: 'Yes' } } })],
      DAILY_RATE, POLICY
    );
    expect(r.days_worked).toBe(1);
  });

  it('a no-work memo has no effect on a day where the employee actually logged time', () => {
    const r = computeAttendanceForEmployee([day({ time_in: '09:10', time_out: '17:00', noWork: 'paid' })], DAILY_RATE, POLICY);
    // still judged as a normal worked (and late) day — the memo only excuses an absence
    expect(r.days_worked).toBe(1);
    expect(r.late_deduction).toBeGreaterThan(0);
  });
});

describe('computeAttendanceForEmployee — Offset form shifts the expected time-out', () => {
  it('arriving late but leaving exactly at the offset time-out incurs no undertime/OT', () => {
    const r = computeAttendanceForEmployee(
      [day({ time_in: '09:30', time_out: '19:00', linkedForm: { slug: 'offset_form', data: { new_time_out: '19:00' } } })],
      DAILY_RATE, POLICY
    );
    expect(r.overtime_pay).toBe(0);
    expect(r.undertime_pay).toBe(0);
    // the arrival lateness itself is untouched by the offset (offset only moves the end time)
    expect(r.late_deduction).toBeGreaterThan(0);
  });

  it('leaving before the offset time-out is undertime against the SHIFTED target, not the original shift end', () => {
    const r = computeAttendanceForEmployee(
      [day({ time_in: '09:30', time_out: '18:30', linkedForm: { slug: 'offset_form', data: { new_time_out: '19:00' } } })],
      DAILY_RATE, POLICY
    );
    // 18:30 is *after* the original 17:00 shift end but *before* the offset 19:00 target
    expect(r.undertime_pay).toBeLessThan(0);
  });
});

describe('computeAttendanceForEmployee — Undertime Request with_pay override', () => {
  it('leaving early with NO linked form deducts, same as always', () => {
    const r = computeAttendanceForEmployee([day({ time_in: '08:00', time_out: '16:00' })], DAILY_RATE, POLICY);
    expect(r.undertime_pay).toBeLessThan(0);
  });

  it('a linked Undertime Request with with_pay=No still deducts (documentation only)', () => {
    const r = computeAttendanceForEmployee(
      [day({ time_in: '08:00', time_out: '16:00', linkedForm: { slug: 'undertime_request', data: { with_pay: 'No' } } })],
      DAILY_RATE, POLICY
    );
    expect(r.undertime_pay).toBeLessThan(0);
  });

  it('a linked Undertime Request with with_pay=Yes waives the deduction entirely', () => {
    const r = computeAttendanceForEmployee(
      [day({ time_in: '08:00', time_out: '16:00', linkedForm: { slug: 'undertime_request', data: { with_pay: 'Yes' } } })],
      DAILY_RATE, POLICY
    );
    expect(r.undertime_pay).toBe(0);
  });
});

describe('computeAttendanceForEmployee — Holiday Work premiums', () => {
  it('Regular Holiday adds a 100% premium on top into holiday_pay', () => {
    const r = computeAttendanceForEmployee(
      [day({ time_in: '08:00', time_out: '17:00', linkedForm: { slug: 'holiday_work_request', data: { hours_worked: 8, holiday_type: 'Regular Holiday' } } })],
      DAILY_RATE, POLICY
    );
    expect(r.holiday_pay).toBeCloseTo(8 * 100 * 1.0, 6);
    expect(r.special_holiday_30).toBe(0);
  });

  it('Special Non-Working Holiday adds a 30% premium into special_holiday_30', () => {
    const r = computeAttendanceForEmployee(
      [day({ time_in: '08:00', time_out: '17:00', linkedForm: { slug: 'holiday_work_request', data: { hours_worked: 8, holiday_type: 'Special Non-Working Holiday' } } })],
      DAILY_RATE, POLICY
    );
    expect(r.special_holiday_30).toBeCloseTo(8 * 100 * 0.3, 6);
    expect(r.holiday_pay).toBe(0);
  });
});

// Per-record holiday marking (attendance_records.holiday_type, or the Company Holidays
// calendar, both resolved into day.holiday by the caller — see hr.routes.ts) + rest-day pay
// (day.isRestDay, resolved from employees.rest_days / PayrollPolicy.default_rest_days). Full
// DOLE Labor Advisory No. 12-25 combo table — one test per row.
describe('computeAttendanceForEmployee — HR-marked holidays + rest-day pay (DOLE combo rates)', () => {
  it('unworked Regular Holiday is paid 100% (a full days_worked day) despite no time logged', () => {
    const r = computeAttendanceForEmployee([day({ holiday: 'regular' })], DAILY_RATE, POLICY);
    expect(r.days_worked).toBe(1);
    expect(r.days_absent).toBe(0);
    expect(r.holiday_pay).toBe(0); // the 100% already landed in days_worked/basic_salary, no separate premium for an unworked day
  });

  it('unworked Special Non-Working Holiday is "no work, no pay" — same bucket as a plain absence', () => {
    const r = computeAttendanceForEmployee([day({ holiday: 'special_non_working' })], DAILY_RATE, POLICY);
    expect(r.days_worked).toBe(0);
    expect(r.days_absent).toBe(1);
  });

  it('worked, no holiday, not a rest day: no premium (the ordinary case)', () => {
    const r = computeAttendanceForEmployee(
      [day({ time_in: '08:00', time_out: '17:00' })], DAILY_RATE, POLICY
    );
    expect(r.holiday_pay).toBe(0);
    expect(r.special_holiday_30).toBe(0);
    expect(r.rest_day_ot).toBe(0);
  });

  it('worked, plain rest day (no holiday): 130% total -> +30% into rest_day_ot', () => {
    const r = computeAttendanceForEmployee(
      [day({ time_in: '08:00', time_out: '17:00', isRestDay: true })], DAILY_RATE, POLICY
    );
    expect(r.rest_day_ot).toBeCloseTo(DAILY_RATE * 0.3, 6);
    expect(r.holiday_pay).toBe(0);
    expect(r.special_holiday_30).toBe(0);
  });

  it('worked Regular Holiday, not a rest day: 200% total -> +100% into holiday_pay', () => {
    const r = computeAttendanceForEmployee(
      [day({ time_in: '08:00', time_out: '17:00', holiday: 'regular' })], DAILY_RATE, POLICY
    );
    expect(r.holiday_pay).toBeCloseTo(DAILY_RATE * 1.0, 6);
    expect(r.rest_day_ot).toBe(0);
  });

  it('worked Regular Holiday AND rest day: 260% total -> +160% into holiday_pay (not +130%)', () => {
    const r = computeAttendanceForEmployee(
      [day({ time_in: '08:00', time_out: '17:00', holiday: 'regular', isRestDay: true })], DAILY_RATE, POLICY
    );
    expect(r.holiday_pay).toBeCloseTo(DAILY_RATE * 1.6, 6);
    expect(r.rest_day_ot).toBe(0); // folded into holiday_pay, not double-counted separately
  });

  it('worked Special Non-Working, not a rest day: 130% total -> +30% into special_holiday_30', () => {
    const r = computeAttendanceForEmployee(
      [day({ time_in: '08:00', time_out: '17:00', holiday: 'special_non_working' })], DAILY_RATE, POLICY
    );
    expect(r.special_holiday_30).toBeCloseTo(DAILY_RATE * 0.3, 6);
    expect(r.rest_day_ot).toBe(0);
  });

  it('worked Special Non-Working AND rest day: 150% total -> +50% into special_holiday_30 (not +60%)', () => {
    const r = computeAttendanceForEmployee(
      [day({ time_in: '08:00', time_out: '17:00', holiday: 'special_non_working', isRestDay: true })], DAILY_RATE, POLICY
    );
    expect(r.special_holiday_30).toBeCloseTo(DAILY_RATE * 0.5, 6);
    expect(r.rest_day_ot).toBe(0);
  });

  it('Special Working Holiday behaves like an ordinary day — no premium worked or not', () => {
    const worked = computeAttendanceForEmployee(
      [day({ time_in: '08:00', time_out: '17:00', holiday: 'special_working', isRestDay: true })], DAILY_RATE, POLICY
    );
    // still gets the plain rest-day premium (the holiday type itself adds nothing) since it IS a rest day
    expect(worked.holiday_pay).toBe(0);
    expect(worked.special_holiday_30).toBe(0);
    expect(worked.rest_day_ot).toBeCloseTo(DAILY_RATE * 0.3, 6);

    const unworked = computeAttendanceForEmployee([day({ holiday: 'special_working' })], DAILY_RATE, POLICY);
    expect(unworked.days_absent).toBe(1); // no time logged, no special pay rule — ordinary absence
  });

  it('a linked holiday_work_request form takes precedence over calendar/override marking (no double premium)', () => {
    const r = computeAttendanceForEmployee(
      [day({
        time_in: '08:00', time_out: '17:00', holiday: 'regular', isRestDay: true,
        linkedForm: { slug: 'holiday_work_request', data: { hours_worked: 8, holiday_type: 'Special Non-Working Holiday' } },
      })],
      DAILY_RATE, POLICY
    );
    // The linked form's own (unrelated) numbers won, not the day.holiday/isRestDay combo rate.
    expect(r.special_holiday_30).toBeCloseTo(8 * 100 * 0.3, 6);
    expect(r.holiday_pay).toBe(0);
    expect(r.rest_day_ot).toBe(0);
  });
});

describe('computeAttendanceForEmployee — no shift assigned', () => {
  it('a day with time logged but no shift still counts as worked, with no late/OT/undertime judgment possible', () => {
    const r = computeAttendanceForEmployee([day({ time_in: '08:00', time_out: '17:00', shift: null })], DAILY_RATE, POLICY);
    expect(r.days_worked).toBe(1);
    expect(r.late_deduction).toBe(0);
    expect(r.overtime_pay).toBe(0);
    expect(r.undertime_pay).toBe(0);
  });
});

describe('computeAttendanceForEmployee — rotating shifts (different shift per day)', () => {
  const NIGHT = { start_time: '22:00', end_time: '06:00' }; // wraps midnight

  it('the same employee can be on-time for a morning shift one day and a night shift the next', () => {
    const morning = { start_time: '06:00', end_time: '14:00' };
    const r = computeAttendanceForEmployee(
      [
        day({ work_date: '2026-08-01', time_in: '06:00', time_out: '14:00', shift: morning }),
        day({ work_date: '2026-08-02', time_in: '22:00', time_out: '07:00', shift: NIGHT, linkedForm: { slug: 'overtime_request', data: {} } }),
      ],
      DAILY_RATE, POLICY
    );
    expect(r.days_worked).toBe(2);
    expect(r.late_deduction).toBe(0);
    expect(r.ot_hours).toBeCloseTo(1, 6); // 60 min OT past the 06:00 (next-day) shift end
  });

  it('arriving just after midnight on a night shift is still correctly judged late, not "early"', () => {
    // Shift starts 22:00; arriving 00:30 is 2.5 hours (150 min) into the shift, not "before" it.
    const r = computeAttendanceForEmployee(
      [day({ time_in: '00:30', time_out: '06:00', shift: NIGHT })],
      DAILY_RATE, POLICY
    );
    // 150 min raw - 10 min grace = 140 min past grace -> rounds up to 3 hours (1-hour block)
    expect(r.late_deduction).toBeCloseTo(3 * 100, 6);
  });

  it('leaving well before an overnight shift ends is undertime, not silently ignored', () => {
    // Shift 22:00-06:00; clocking out at 23:00 is only 1 hour in, nowhere near the 06:00 end.
    const r = computeAttendanceForEmployee(
      [day({ time_in: '22:00', time_out: '23:00', shift: NIGHT })],
      DAILY_RATE, POLICY
    );
    expect(r.undertime_pay).toBeLessThan(0);
  });
});

describe('computeAttendanceForEmployee — night differential', () => {
  it('adds a percentage premium only for the portion of OT that falls in the night window (wraps midnight)', () => {
    const policy: PayrollPolicy = { ...POLICY, ot_unit: 'minute', night_diff_enabled: true, night_diff_percent: 10 };
    const afternoon = { start_time: '14:00', end_time: '22:00' };
    const r = computeAttendanceForEmployee(
      [day({ time_in: '14:00', time_out: '23:00', shift: afternoon, linkedForm: { slug: 'overtime_request', data: {} } })],
      DAILY_RATE, policy
    );
    // 60 min OT (22:00-23:00), entirely inside the 22:00-06:00 night window
    expect(r.ot_hours).toBeCloseTo(1, 6);
    const basePay = 1 * 100 * 1.25;
    const nightBonus = 1 * 100 * 0.10;
    expect(r.overtime_pay).toBeCloseTo(basePay + nightBonus, 6);
  });

  it('no night bonus when the OT falls entirely outside the night window', () => {
    const policy: PayrollPolicy = { ...POLICY, ot_unit: 'minute', night_diff_enabled: true, night_diff_percent: 10 };
    const r = computeAttendanceForEmployee(
      [day({ time_in: '08:00', time_out: '18:00', linkedForm: { slug: 'overtime_request', data: {} } })],
      DAILY_RATE, policy
    );
    expect(r.overtime_pay).toBeCloseTo(1 * 100 * 1.25, 6);
  });

  it('splits correctly when OT itself straddles the night window boundary (crossing 06:00)', () => {
    const policy: PayrollPolicy = { ...POLICY, ot_unit: 'minute', night_diff_enabled: true, night_diff_percent: 10 };
    const earlyNight = { start_time: '21:00', end_time: '05:00' }; // wraps midnight, ends at 5am
    const r = computeAttendanceForEmployee(
      [day({ time_in: '21:00', time_out: '07:00', shift: earlyNight, linkedForm: { slug: 'overtime_request', data: {} } })],
      DAILY_RATE, policy
    );
    // 2 hours OT (05:00-07:00): the 05:00-06:00 hour is inside the 22:00-06:00 night window,
    // the 06:00-07:00 hour is not.
    expect(r.ot_hours).toBeCloseTo(2, 6);
    const basePay = 2 * 100 * 1.25;
    const nightBonus = 1 * 100 * 0.10; // only 1 of the 2 OT hours gets the night premium
    expect(r.overtime_pay).toBeCloseTo(basePay + nightBonus, 6);
  });
});
