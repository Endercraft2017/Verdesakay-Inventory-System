/** Pure unit tests for src/hr-payroll-compute.ts — the late/OT/undertime/holiday/leave rules are
    exactly the kind of finicky business logic worth pinning down precisely, independent of any
    DB or HTTP concerns (the module itself takes plain data in, plain numbers out). */
import { describe, it, expect } from 'vitest';
import { computeAttendanceForEmployee, unrecordedOtMinutes, type AttendanceDay } from '../src/hr-payroll-compute';
import type { PayrollPolicy } from '../src/types';

const POLICY: PayrollPolicy = {
  grace_minutes: 10,
  late_unit: 'hour',
  ot_unit: '30min',
  ot_rate_percent: 125,
  require_ot_form: true,
  night_diff_enabled: false,
  night_diff_percent: 10,
  night_start: '22:00',
  night_end: '06:00',
  monthly_rate_divisor: 26,
  pay_frequency: 'semi_monthly',
  auto_statutory: true,
  default_rest_days: [0, 6],
  min_work_minutes: 0,
  lunch_break_minutes: 60,
  count_lunch_as_worked: false,
  hours_basis: 'fixed',
  hours_basis_unit: '30min',
  whole_day_min_minutes: 0,
  max_ot_hours: null,
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

describe('computeAttendanceForEmployee — exemptLate (e.g. the company president)', () => {
  it('an exempt employee has no late_deduction despite being late — the 5th (exemptLate) parameter', () => {
    const r = computeAttendanceForEmployee(
      [day({ time_in: '09:10', time_out: '17:00' })], // 70 min late -> would normally deduct 1hr
      DAILY_RATE, POLICY, true
    );
    expect(r.late_deduction).toBe(0);
  });

  it('late_minutes is still reported per-day even when exempt — HR can see the pattern, it just costs nothing', () => {
    const r = computeAttendanceForEmployee([day({ time_in: '09:10', time_out: '17:00' })], DAILY_RATE, POLICY, true);
    expect(r.days[0]!.late_minutes).toBe(60);
    expect(r.days[0]!.late_pay).toBe(0);
  });

  it('exemptLate defaults to false when omitted — every existing non-exempt call site is unaffected', () => {
    const r = computeAttendanceForEmployee([day({ time_in: '09:10', time_out: '17:00' })], DAILY_RATE, POLICY);
    expect(r.late_deduction).toBe(100);
  });

  it('exemptLate only affects late — OT, undertime, and holiday/rest-day premiums still compute normally', () => {
    const policy = { ...POLICY, ot_unit: 'minute' as const };
    const r = computeAttendanceForEmployee(
      [day({
        time_in: '09:10', time_out: '18:00', holiday: 'regular',
        linkedForm: { slug: 'overtime_request', data: {} },
      })],
      DAILY_RATE, policy, true
    );
    expect(r.late_deduction).toBe(0); // exempt
    expect(r.ot_hours).toBeGreaterThan(0); // unaffected
    expect(r.holiday_pay).toBeGreaterThan(0); // unaffected
  });
});

describe('computeAttendanceForEmployee — OT rounds DOWN to completed blocks, requires a linked Overtime form', () => {
  it('20 min OT with a 30-min block is not a completed block yet -> 0 counted', () => {
    const r = computeAttendanceForEmployee(
      [day({ time_in: '08:00', time_out: '17:20', linkedForm: { slug: 'overtime_request', data: {} } })],
      DAILY_RATE, POLICY
    );
    expect(r.ot_hours).toBe(0);
    expect(r.overtime_pay).toBe(0);
  });

  it('50 min OT with a 30-min block credits only the one completed block (30 min), not the partial second one', () => {
    const r = computeAttendanceForEmployee(
      [day({ time_in: '08:00', time_out: '17:50', linkedForm: { slug: 'overtime_request', data: {} } })],
      DAILY_RATE, POLICY
    );
    expect(r.ot_hours).toBeCloseTo(0.5, 6);
    expect(r.overtime_pay).toBeCloseTo(0.5 * 100 * 1.25, 6);
  });

  it('60 min OT with a 30-min block credits both completed blocks exactly, no partial-block loss', () => {
    const r = computeAttendanceForEmployee(
      [day({ time_in: '08:00', time_out: '18:00', linkedForm: { slug: 'overtime_request', data: {} } })],
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

  it('real case: 2h12m raw OT on an hour block credits 2 hours, not 3', () => {
    const policy = { ...POLICY, ot_unit: 'hour' as const };
    const r = computeAttendanceForEmployee(
      [day({ time_in: '07:50', time_out: '19:12', linkedForm: { slug: 'overtime_request', data: {} } })],
      DAILY_RATE, policy
    );
    expect(r.ot_hours).toBe(2);
  });

  it('real case: 1h11m raw OT on an hour block credits 1 hour, not 2', () => {
    const policy = { ...POLICY, ot_unit: 'hour' as const };
    const r = computeAttendanceForEmployee(
      [day({ time_in: '07:54', time_out: '18:11', linkedForm: { slug: 'overtime_request', data: {} } })],
      DAILY_RATE, policy
    );
    expect(r.ot_hours).toBe(1);
  });
});

describe('computeAttendanceForEmployee — require_ot_form: false auto-pays OT with no linked form needed', () => {
  it('a raw late clock-out with NO linked form still pays OT once require_ot_form is off', () => {
    const policy = { ...POLICY, require_ot_form: false, ot_unit: 'minute' as const };
    const r = computeAttendanceForEmployee([day({ time_in: '08:00', time_out: '18:00' })], DAILY_RATE, policy);
    expect(r.ot_hours).toBeCloseTo(1, 6);
    expect(r.overtime_pay).toBeCloseTo(1 * 100 * 1.25, 6);
  });

  it('a linked Overtime Request form still works the same way when require_ot_form is off (not disabled by the setting)', () => {
    const policy = { ...POLICY, require_ot_form: false, ot_unit: 'minute' as const };
    const r = computeAttendanceForEmployee(
      [day({ time_in: '08:00', time_out: '18:00', linkedForm: { slug: 'overtime_request', data: {} } })],
      DAILY_RATE, policy
    );
    expect(r.ot_hours).toBeCloseTo(1, 6);
    expect(r.overtime_pay).toBeCloseTo(1 * 100 * 1.25, 6);
  });

  it('leaving exactly on time or early still isn\'t OT even with require_ot_form off — undertime still applies normally', () => {
    const policy = { ...POLICY, require_ot_form: false };
    const r = computeAttendanceForEmployee([day({ time_in: '08:00', time_out: '16:00' })], DAILY_RATE, policy);
    expect(r.ot_hours).toBe(0);
    expect(r.overtime_pay).toBe(0);
    expect(r.undertime_pay).toBeLessThan(0);
  });

  it('the default (require_ot_form left unset -> true via policy schema default) still requires a form — this test\'s POLICY fixture is explicit for clarity', () => {
    const r = computeAttendanceForEmployee([day({ time_in: '08:00', time_out: '18:00' })], DAILY_RATE, POLICY);
    expect(POLICY.require_ot_form).toBe(true);
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

  it('an UNPAID no-work day contributes no pay but is NOT an absence — it was management\'s call, not an unexplained no-show', () => {
    const r = computeAttendanceForEmployee([day({ noWork: 'unpaid' })], DAILY_RATE, POLICY);
    expect(r.days_worked).toBe(0);
    expect(r.days_absent).toBe(0);
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

  describe('New Time In (optional) shifts the whole day\'s window, not just the end', () => {
    const OFFSET_POLICY: PayrollPolicy = { ...POLICY, require_ot_form: false };

    it('a full 8-5 -> 10-7 offset (New Time In + New Time Out both given): no late deduction for the shifted arrival, and the 5-7pm stretch is NOT overtime — still the same 8-hour day, just shifted', () => {
      const r = computeAttendanceForEmployee(
        [day({ time_in: '10:00', time_out: '19:00', linkedForm: { slug: 'offset_form', data: { new_time_in: '10:00', new_time_out: '19:00' } } })],
        DAILY_RATE, OFFSET_POLICY
      );
      expect(r.late_deduction).toBe(0);
      expect(r.overtime_pay).toBe(0);
      expect(r.undertime_pay).toBe(0);
      expect(r.days_worked).toBe(1);
    });

    it('arriving later than the shifted New Time In still counts as late — against the SHIFTED start, not the original 08:00', () => {
      const r = computeAttendanceForEmployee(
        [day({ time_in: '10:30', time_out: '19:00', linkedForm: { slug: 'offset_form', data: { new_time_in: '10:00', new_time_out: '19:00' } } })],
        DAILY_RATE, POLICY
      );
      expect(r.late_deduction).toBeGreaterThan(0); // 30 min past the 10:00 shifted start (past the 10-min grace)
    });

    it('New Time Out alone (no New Time In) keeps the old behavior: arrival is still judged against the original shift start', () => {
      const r = computeAttendanceForEmployee(
        [day({ time_in: '10:00', time_out: '19:00', linkedForm: { slug: 'offset_form', data: { new_time_out: '19:00' } } })],
        DAILY_RATE, OFFSET_POLICY
      );
      expect(r.late_deduction).toBeGreaterThan(0); // no new_time_in -> still judged against 08:00
      expect(r.overtime_pay).toBe(0); // end-of-day is still protected by new_time_out alone
    });
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
  it('unworked Regular Holiday is paid 100% via holiday_pay, kept OUT of days_worked so it reads as its own line, not an extra day worked', () => {
    const r = computeAttendanceForEmployee([day({ holiday: 'regular' })], DAILY_RATE, POLICY);
    expect(r.days_worked).toBe(0);
    expect(r.days_absent).toBe(0);
    expect(r.holiday_pay).toBe(DAILY_RATE); // the full day's pay, not just a premium — this IS the pay for the unworked day
  });

  it('unworked Special Non-Working Holiday is "no work, no pay" — same bucket as a plain absence', () => {
    const r = computeAttendanceForEmployee([day({ holiday: 'special_non_working' })], DAILY_RATE, POLICY);
    expect(r.days_worked).toBe(0);
    expect(r.days_absent).toBe(1);
  });

  it('an unworked rest day is neither days_worked nor days_absent — it was never a scheduled workday', () => {
    const r = computeAttendanceForEmployee([day({ isRestDay: true })], DAILY_RATE, POLICY);
    expect(r.days_worked).toBe(0);
    expect(r.days_absent).toBe(0);
  });

  it('unworked Regular Holiday that also falls on a rest day is still fully paid (rest-day-ness never reduces the holiday entitlement)', () => {
    const r = computeAttendanceForEmployee([day({ holiday: 'regular', isRestDay: true })], DAILY_RATE, POLICY);
    expect(r.days_worked).toBe(0);
    expect(r.days_absent).toBe(0);
    expect(r.holiday_pay).toBe(DAILY_RATE);
  });

  it('a Regular Holiday ALSO covered by a paid No Work Memo (e.g. "Suspension, Holiday") still routes to holiday_pay, not days_worked — the statutory entitlement wins over the discretionary memo', () => {
    const r = computeAttendanceForEmployee([day({ holiday: 'regular', noWork: 'paid' })], DAILY_RATE, POLICY);
    expect(r.days_worked).toBe(0);
    expect(r.days_absent).toBe(0);
    expect(r.holiday_pay).toBe(DAILY_RATE);
  });

  it('a Regular Holiday covered by an UNPAID No Work Memo is still fully paid — a memo can\'t strip the statutory Regular Holiday entitlement', () => {
    const r = computeAttendanceForEmployee([day({ holiday: 'regular', noWork: 'unpaid' })], DAILY_RATE, POLICY);
    expect(r.days_worked).toBe(0);
    expect(r.days_absent).toBe(0);
    expect(r.holiday_pay).toBe(DAILY_RATE);
  });

  it('unworked "Work Cancellation (Paid)" credits a full paid day, same as a paid Leave day', () => {
    const r = computeAttendanceForEmployee([day({ holiday: 'cancelled_paid' })], DAILY_RATE, POLICY);
    expect(r.days_worked).toBe(1);
    expect(r.days_absent).toBe(0);
  });

  it('unworked "Work Cancellation (Unpaid)" is not an absence either — same non-absence treatment as an unpaid No Work Memo day', () => {
    const r = computeAttendanceForEmployee([day({ holiday: 'cancelled_unpaid' })], DAILY_RATE, POLICY);
    expect(r.days_worked).toBe(0);
    expect(r.days_absent).toBe(0);
  });

  it('an unpaid cancellation on a rest day is still its own explicit status, not silenced by rest-day-ness — but still not an absence', () => {
    const r = computeAttendanceForEmployee([day({ holiday: 'cancelled_unpaid', isRestDay: true })], DAILY_RATE, POLICY);
    expect(r.days_absent).toBe(0);
    expect(r.days_worked).toBe(0);
    expect(r.days[0]!.status).toBe('unpaid_no_work');
  });

  it('a paid cancellation on a rest day is still a full paid day', () => {
    const r = computeAttendanceForEmployee([day({ holiday: 'cancelled_paid', isRestDay: true })], DAILY_RATE, POLICY);
    expect(r.days_worked).toBe(1);
    expect(r.days_absent).toBe(0);
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

  // Regression: holiday/rest-day premiums used to sit after `if (!day.shift) continue`, so a
  // worked day with no shift assigned (shift: null — every other test in this file supplies
  // SHIFT, which is exactly why nothing caught this) silently paid 0 premium regardless of
  // day.holiday/isRestDay. Late/OT/undertime genuinely need a shift's start/end time and stay
  // gated behind that check; these don't.
  it('holiday premium still applies to a worked day with no shift assigned', () => {
    const r = computeAttendanceForEmployee(
      [day({ time_in: '08:00', time_out: '17:00', shift: null, holiday: 'regular' })], DAILY_RATE, POLICY
    );
    expect(r.days_worked).toBe(1);
    expect(r.holiday_pay).toBeCloseTo(DAILY_RATE * 1.0, 6);
  });

  it('rest-day premium still applies to a worked day with no shift assigned', () => {
    const r = computeAttendanceForEmployee(
      [day({ time_in: '08:00', time_out: '17:00', shift: null, isRestDay: true })], DAILY_RATE, POLICY
    );
    expect(r.rest_day_ot).toBeCloseTo(DAILY_RATE * 0.3, 6);
  });

  it('a self-filed holiday_work_request premium still applies with no shift assigned', () => {
    const r = computeAttendanceForEmployee(
      [day({
        time_in: '08:00', time_out: '17:00', shift: null,
        linkedForm: { slug: 'holiday_work_request', data: { hours_worked: 8, holiday_type: 'Regular Holiday' } },
      })],
      DAILY_RATE, POLICY
    );
    expect(r.holiday_pay).toBeCloseTo(8 * 100 * 1.0, 6);
  });

  it('late/OT/undertime stay correctly skipped with no shift assigned (unlike holiday/rest-day pay)', () => {
    const r = computeAttendanceForEmployee(
      [day({ time_in: '09:30', time_out: '17:00', shift: null, holiday: 'regular' })], DAILY_RATE, POLICY
    );
    expect(r.late_deduction).toBe(0); // nothing to judge lateness against without a shift
    expect(r.holiday_pay).toBeCloseTo(DAILY_RATE * 1.0, 6); // but the holiday premium still lands
  });

  it('authorized OT on a Regular Holiday is paid at the holiday-scaled rate (200% x OT%), not the ordinary-day OT rate', () => {
    // Shift 08:00-17:00; worked 08:00-19:00 -> 2hrs OT (POLICY.ot_unit is '30min', so this rounds exactly).
    const r = computeAttendanceForEmployee(
      [day({
        time_in: '08:00', time_out: '19:00', holiday: 'regular',
        linkedForm: { slug: 'overtime_request', data: {} },
      })],
      DAILY_RATE, POLICY
    );
    expect(r.ot_hours).toBeCloseTo(2, 6);
    // 2hrs * 100/hr * 2.0 (Regular Holiday multiplier) * 1.25 (POLICY.ot_rate_percent) = 500,
    // not the ordinary 2 * 100 * 1.25 = 250 an unscaled OT rate would give.
    expect(r.overtime_pay).toBeCloseTo(2 * 100 * 2.0 * 1.25, 6);
    // The regular (within-shift) hours still separately earn the base-day holiday premium —
    // OT scaling and the base-day premium are for disjoint hour ranges, both apply.
    expect(r.holiday_pay).toBeCloseTo(DAILY_RATE * 1.0, 6);
  });

  it('authorized OT on an ordinary day is unaffected by the holiday-scaling change (multiplier 1.0, same as before)', () => {
    const r = computeAttendanceForEmployee(
      [day({ time_in: '08:00', time_out: '19:00', linkedForm: { slug: 'overtime_request', data: {} } })],
      DAILY_RATE, POLICY
    );
    expect(r.overtime_pay).toBeCloseTo(2 * 100 * 1.25, 6);
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
    // 60 min OT (22:00-23:00), entirely inside the 22:00-06:00 night window; the regular
    // 14:00-22:00 span doesn't touch the night window at all (ends exactly at 22:00).
    expect(r.ot_hours).toBeCloseTo(1, 6);
    expect(r.overtime_pay).toBeCloseTo(1 * 100 * 1.25, 6); // night diff is its own line, not folded in
    expect(r.night_diff_pay).toBeCloseTo(1 * 100 * 0.10, 6);
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
    // 2 hours OT (05:00-07:00). Night diff now covers the WHOLE paid clocked span (21:00-07:00,
    // 10 hours), not just the OT portion — the entire 22:00-06:00 night window (8 hours) sits
    // inside that span, so all 8 hours (both regular and OT) earn the night premium, not just
    // the 1 OT hour that used to be the only thing checked.
    expect(r.ot_hours).toBeCloseTo(2, 6);
    expect(r.overtime_pay).toBeCloseTo(2 * 100 * 1.25, 6); // night diff is its own line, not folded in
    expect(r.night_diff_pay).toBeCloseTo(8 * 100 * 0.10, 6);
  });

  it('covers REGULAR (non-OT) night hours too — a straight night-shift worker with no OT still earns the differential for every night hour actually worked', () => {
    const policy: PayrollPolicy = { ...POLICY, night_diff_enabled: true, night_diff_percent: 10 };
    const nightShift = { start_time: '22:00', end_time: '06:00' }; // wraps midnight, entirely the night window
    const r = computeAttendanceForEmployee(
      [day({ time_in: '22:00', time_out: '06:00', shift: nightShift })],
      DAILY_RATE, policy
    );
    expect(r.ot_hours).toBe(0);
    expect(r.overtime_pay).toBe(0);
    // Full 8-hour shift, entirely inside 22:00-06:00 -> full night differential, no OT involved.
    expect(r.night_diff_pay).toBeCloseTo(8 * 100 * 0.10, 6);
  });

  it('disabled (night_diff_enabled: false) pays no differential at all, regular or OT', () => {
    const nightShift = { start_time: '22:00', end_time: '06:00' };
    const r = computeAttendanceForEmployee(
      [day({ time_in: '22:00', time_out: '06:00', shift: nightShift })],
      DAILY_RATE, POLICY // night_diff_enabled: false
    );
    expect(r.night_diff_pay).toBe(0);
  });
});

describe('computeAttendanceForEmployee — per-day breakdown (days[]), for the read-only payroll detail view', () => {
  it('always returns exactly one DayBreakdown per input day, in the same order, regardless of which branch each day takes', () => {
    const r = computeAttendanceForEmployee(
      [
        day({ work_date: '2026-08-01', time_in: '08:00', time_out: '17:00' }),
        day({ work_date: '2026-08-02', time_in: null, time_out: null }),
        day({ work_date: '2026-08-03', shift: null, time_in: '08:00', time_out: '17:00' }),
      ],
      DAILY_RATE, POLICY
    );
    expect(r.days.map((d) => d.work_date)).toEqual(['2026-08-01', '2026-08-02', '2026-08-03']);
  });

  it('a late day\'s late_minutes/late_pay land on that exact day, summing to the aggregate late_deduction', () => {
    const r = computeAttendanceForEmployee(
      [day({ work_date: '2026-08-01', time_in: '09:10', time_out: '17:00' })], // 70 min late -> 1hr block
      DAILY_RATE, POLICY
    );
    expect(r.days[0]!.status).toBe('worked');
    expect(r.days[0]!.late_minutes).toBe(60);
    expect(r.days[0]!.late_pay).toBeCloseTo(100, 6);
    expect(r.days[0]!.late_pay).toBeCloseTo(r.late_deduction, 6);
  });

  it('an authorized OT day\'s ot_hours/ot_pay land on that exact day, summing to the aggregate overtime_pay', () => {
    const policy = { ...POLICY, ot_unit: 'minute' as const };
    const r = computeAttendanceForEmployee(
      [day({ work_date: '2026-08-01', time_in: '08:00', time_out: '18:00', linkedForm: { slug: 'overtime_request', data: {} } })],
      DAILY_RATE, policy
    );
    expect(r.days[0]!.ot_hours).toBeCloseTo(1, 6);
    expect(r.days[0]!.ot_pay).toBeCloseTo(125, 6);
    expect(r.days[0]!.ot_pay).toBeCloseTo(r.overtime_pay, 6);
    expect(r.days[0]!.late_minutes).toBe(0); // no bleed into unrelated fields
  });

  it('an unauthorized undertime day\'s undertime_pay (negative) lands on that exact day, summing to the aggregate', () => {
    const r = computeAttendanceForEmployee(
      [day({ work_date: '2026-08-01', time_in: '08:00', time_out: '16:00' })], // left 1hr early
      DAILY_RATE, POLICY
    );
    expect(r.days[0]!.undertime_pay).toBeCloseTo(-100, 6);
    expect(r.days[0]!.undertime_pay).toBeCloseTo(r.undertime_pay, 6);
  });

  it('an absent day is tagged status "absent" with all money fields at zero', () => {
    const r = computeAttendanceForEmployee(
      [day({ work_date: '2026-08-01', time_in: null, time_out: null })],
      DAILY_RATE, POLICY
    );
    expect(r.days[0]!.status).toBe('absent');
    expect(r.days[0]!.late_pay).toBe(0);
    expect(r.days[0]!.ot_pay).toBe(0);
    expect(r.days[0]!.undertime_pay).toBe(0);
    expect(r.days[0]!.day_premium_pay).toBe(0);
  });

  it('real case: an unpaid No Work Memo day (e.g. "Health Break") is tagged "unpaid_no_work", not "absent" — days_absent stays 0', () => {
    const r = computeAttendanceForEmployee(
      [day({ work_date: '2026-08-18', time_in: null, time_out: null, noWork: 'unpaid' })],
      DAILY_RATE, POLICY
    );
    expect(r.days[0]!.status).toBe('unpaid_no_work');
    expect(r.days_absent).toBe(0);
    expect(r.days_worked).toBe(0);
  });

  it('a paid Leave day is tagged status "paid_leave"; a paid No Work Memo day is tagged "paid_no_work"', () => {
    const r = computeAttendanceForEmployee(
      [
        day({ work_date: '2026-08-01', time_in: null, time_out: null, linkedForm: { slug: 'leave_request', data: { with_pay: 'Yes' } } }),
        day({ work_date: '2026-08-02', time_in: null, time_out: null, noWork: 'paid' }),
      ],
      DAILY_RATE, POLICY
    );
    expect(r.days[0]!.status).toBe('paid_leave');
    expect(r.days[1]!.status).toBe('paid_no_work');
  });

  it('a worked Regular Holiday day carries its holiday_pay premium in day_premium_pay, still status "worked"', () => {
    const r = computeAttendanceForEmployee(
      [day({ work_date: '2026-08-01', time_in: '08:00', time_out: '17:00', holiday: 'regular' })],
      DAILY_RATE, POLICY
    );
    expect(r.days[0]!.status).toBe('worked');
    expect(r.days[0]!.holiday).toBe('regular');
    expect(r.days[0]!.day_premium_pay).toBeCloseTo(DAILY_RATE * 1.0, 6); // +100% premium
    expect(r.days[0]!.day_premium_pay).toBeCloseTo(r.holiday_pay, 6);
  });

  it('an unworked Regular Holiday is tagged status "paid_holiday" (a full paid day despite no time logged)', () => {
    const r = computeAttendanceForEmployee(
      [day({ work_date: '2026-08-01', time_in: null, time_out: null, holiday: 'regular' })],
      DAILY_RATE, POLICY
    );
    expect(r.days[0]!.status).toBe('paid_holiday');
    expect(r.days[0]!.day_premium_pay).toBe(DAILY_RATE); // full day's pay, routed through holiday_pay not days_worked
  });

  it('an unworked plain rest day (no holiday) is tagged status "rest_day_off"', () => {
    const r = computeAttendanceForEmployee(
      [day({ work_date: '2026-08-01', time_in: null, time_out: null, isRestDay: true })],
      DAILY_RATE, POLICY
    );
    expect(r.days[0]!.status).toBe('rest_day_off');
  });

  it('is a fresh array per call — computing twice never lets one result\'s days bleed into the other\'s', () => {
    const days = [day({ work_date: '2026-08-01', time_in: '08:00', time_out: '17:00' })];
    const r1 = computeAttendanceForEmployee(days, DAILY_RATE, POLICY);
    const r2 = computeAttendanceForEmployee(
      [day({ work_date: '2026-08-01', time_in: '10:05', time_out: '17:00' })], // late
      DAILY_RATE, POLICY
    );
    expect(r1.days).toHaveLength(1);
    expect(r2.days).toHaveLength(1);
    expect(r1.days[0]!.late_pay).toBe(0);
    expect(r2.days[0]!.late_pay).toBeGreaterThan(0);
  });
});

describe('computeAttendanceForEmployee — Half Day request judges late/undertime against its OWN AM/PM window, not the full shift (real bug fix)', () => {
  // Shift 08:00-17:00, default lunch_break_minutes: 60 -> AM window 08:00-12:00, PM window
  // 13:00-17:00 (matches "8-12 or 1-5 for 4hrs" exactly — see lunchWindow/halfDayWindow).
  it('AM half-day, present the whole window (08:00-12:00): no late, no undertime, still 0.5 days_worked', () => {
    const r = computeAttendanceForEmployee(
      [day({ time_in: '08:00', time_out: '12:00', linkedForm: { slug: 'halfday_request', data: { session: 'Morning (AM)' } } })],
      DAILY_RATE, POLICY
    );
    expect(r.days_worked).toBe(0.5);
    expect(r.late_deduction).toBe(0);
    expect(r.undertime_pay).toBe(0);
  });

  it('PM half-day, present the whole window (13:00-17:00): no late (previously ~5hrs "late" against the 08:00 shift start), no undertime', () => {
    const r = computeAttendanceForEmployee(
      [day({ time_in: '13:00', time_out: '17:00', linkedForm: { slug: 'halfday_request', data: { session: 'Afternoon (PM)' } } })],
      DAILY_RATE, POLICY
    );
    expect(r.days_worked).toBe(0.5);
    expect(r.late_deduction).toBe(0); // was wrongly ~500 (5hrs * 100/hr) before the fix
    expect(r.undertime_pay).toBe(0);
  });

  it('AM half-day leaving right at noon is NOT undertime (previously compared against the full shift\'s 17:00 end)', () => {
    const r = computeAttendanceForEmployee(
      [day({ time_in: '08:00', time_out: '12:00', linkedForm: { slug: 'halfday_request', data: { session: 'Morning (AM)' } } })],
      DAILY_RATE, POLICY
    );
    expect(r.undertime_pay).toBe(0); // was wrongly -500 (5hrs short vs 17:00) before the fix
  });

  it('PM half-day arriving right at 13:00 is NOT late (previously compared against the full shift\'s 08:00 start)', () => {
    const r = computeAttendanceForEmployee(
      [day({ time_in: '13:00', time_out: '17:00', linkedForm: { slug: 'halfday_request', data: { session: 'Afternoon (PM)' } } })],
      DAILY_RATE, POLICY
    );
    expect(r.late_deduction).toBe(0);
  });

  it('AM half-day arriving 30 min late is judged against the AM window\'s own 08:00 start, not the full shift', () => {
    const r = computeAttendanceForEmployee(
      [day({ time_in: '08:30', time_out: '12:00', linkedForm: { slug: 'halfday_request', data: { session: 'Morning (AM)' } } })],
      DAILY_RATE, POLICY
    );
    // 30 min raw, 10 min grace -> 20 min past grace -> 1-hour block (late_unit: 'hour')
    expect(r.late_deduction).toBe(100);
  });

  it('PM half-day leaving 1 hour early (16:00) is undertime against the PM window\'s own 17:00 end, not the full shift', () => {
    const r = computeAttendanceForEmployee(
      [day({ time_in: '13:00', time_out: '16:00', linkedForm: { slug: 'halfday_request', data: { session: 'Afternoon (PM)' } } })],
      DAILY_RATE, POLICY
    );
    expect(r.undertime_pay).toBeCloseTo(-100, 6); // 1 hour short * 100/hr
  });

  it('missing/unrecognized session defaults to the AM window', () => {
    const r = computeAttendanceForEmployee(
      [day({ time_in: '08:00', time_out: '12:00', linkedForm: { slug: 'halfday_request', data: {} } })],
      DAILY_RATE, POLICY
    );
    expect(r.late_deduction).toBe(0);
    expect(r.undertime_pay).toBe(0);
  });

  it('a custom lunch_break_minutes shifts the half-day windows accordingly (30-min lunch -> AM 08:00-12:30, PM 13:00-17:00)', () => {
    const policy = { ...POLICY, lunch_break_minutes: 30 };
    const r = computeAttendanceForEmployee(
      [day({ time_in: '08:00', time_out: '12:30', linkedForm: { slug: 'halfday_request', data: { session: 'Morning (AM)' } } })],
      DAILY_RATE, policy
    );
    expect(r.undertime_pay).toBe(0);
  });
});

describe('computeAttendanceForEmployee — hours_basis: per_hour (prorated pay from actual worked minutes)', () => {
  // Shift 08:00-17:00, lunch_break_minutes: 60 -> normal span 8 hours.
  const PER_HOUR = { ...POLICY, hours_basis: 'per_hour' as const, hours_basis_unit: '30min' as const };

  it('the exact example: 08:00-14:00 (crosses the 12:00-13:00 lunch) is a 5-hour day, not a flat full/half day', () => {
    const r = computeAttendanceForEmployee([day({ time_in: '08:00', time_out: '14:00' })], DAILY_RATE, PER_HOUR);
    expect(r.days_worked).toBeCloseTo(5 / 8, 6);
    expect(r.days[0]!.status).toBe('worked');
  });

  it('working 13:00-17:00 (entirely after lunch) pays the full 4 hours, no lunch deducted since the span never touches it', () => {
    const r = computeAttendanceForEmployee([day({ time_in: '13:00', time_out: '17:00' })], DAILY_RATE, PER_HOUR);
    expect(r.days_worked).toBeCloseTo(4 / 8, 6);
  });

  it('working 08:00-11:00 (entirely before lunch) pays the full 3 hours, no lunch deducted', () => {
    const r = computeAttendanceForEmployee([day({ time_in: '08:00', time_out: '11:00' })], DAILY_RATE, PER_HOUR);
    expect(r.days_worked).toBeCloseTo(3 / 8, 6);
  });

  it('count_lunch_as_worked: true pays the full raw span, lunch included', () => {
    const policy = { ...PER_HOUR, count_lunch_as_worked: true };
    const r = computeAttendanceForEmployee([day({ time_in: '08:00', time_out: '14:00' })], DAILY_RATE, policy);
    expect(r.days_worked).toBeCloseTo(6 / 8, 6); // full 6-hour raw span, no lunch subtracted
  });

  it('a full day (08:00-17:00) still pays exactly 8 hours = 1.0 days_worked, same as fixed-basis would credit', () => {
    const r = computeAttendanceForEmployee([day({ time_in: '08:00', time_out: '17:00' })], DAILY_RATE, PER_HOUR);
    expect(r.days_worked).toBeCloseTo(1, 6);
    expect(r.ot_hours).toBe(0);
  });

  it('rounds DOWN to the configured block — 08:00-14:20 (6h20m raw, 5h20m after lunch) on a 30-min block pays only 5 hours, not 5h20m or 5.5h', () => {
    const r = computeAttendanceForEmployee([day({ time_in: '08:00', time_out: '14:20' })], DAILY_RATE, PER_HOUR);
    expect(r.days_worked).toBeCloseTo(5 / 8, 6);
  });

  it('no separate late/undertime peso deduction on top — the reduced hours ARE the correction, so late_deduction and undertime_pay stay 0 even for a short/late day', () => {
    const r = computeAttendanceForEmployee([day({ time_in: '10:00', time_out: '14:00' })], DAILY_RATE, PER_HOUR);
    expect(r.late_deduction).toBe(0);
    expect(r.undertime_pay).toBe(0);
    expect(r.days[0]!.late_minutes).toBeGreaterThan(0); // still reported for reference
    expect(r.days[0]!.late_pay).toBe(0);
  });

  it('hours worked beyond the shift\'s normal span are OT-eligible, same authorization gate and holiday-scaled rate as fixed-basis mode', () => {
    const r = computeAttendanceForEmployee(
      [day({ time_in: '08:00', time_out: '19:00', linkedForm: { slug: 'overtime_request', data: {} } })], // 10 worked hrs after lunch
      DAILY_RATE, PER_HOUR
    );
    expect(r.days_worked).toBeCloseTo(1, 6); // the normal 8 hours
    expect(r.ot_hours).toBeCloseTo(2, 6); // the 2 hours beyond it
    expect(r.overtime_pay).toBeCloseTo(2 * 100 * 1.25, 6);
  });

  it('excess hours are NOT auto-paid as OT when require_ot_form is on and nothing is linked', () => {
    const r = computeAttendanceForEmployee([day({ time_in: '08:00', time_out: '19:00' })], DAILY_RATE, PER_HOUR);
    expect(r.days_worked).toBeCloseTo(1, 6);
    expect(r.ot_hours).toBe(0);
    expect(r.overtime_pay).toBe(0);
  });
});

describe('computeAttendanceForEmployee — minimum allowable work time (policy.min_work_minutes)', () => {
  it('off (0, the default) never flags or denies anything, however short the day', () => {
    const r = computeAttendanceForEmployee([day({ time_in: '08:00', time_out: '09:00' })], DAILY_RATE, POLICY);
    expect(r.days[0]!.below_minimum).toBe(false);
    expect(r.days[0]!.status).toBe('worked');
  });

  it('below the minimum with NO decision yet still pays for actual time (fixed-basis: still a full flat day) — flagged, not withheld', () => {
    const policy = { ...POLICY, min_work_minutes: 240 }; // 4 hours
    const r = computeAttendanceForEmployee([day({ time_in: '08:00', time_out: '09:00' })], DAILY_RATE, policy); // 1 hour worked
    expect(r.days[0]!.below_minimum).toBe(true);
    expect(r.days[0]!.status).toBe('worked'); // not denied -> normal computation still applies
    expect(r.days_worked).toBe(1); // fixed-basis: still a flat full day unless explicitly denied
  });

  it('below the minimum with an explicit "deny" decision zeroes the day\'s credit — not an absence, a distinct status', () => {
    const policy = { ...POLICY, min_work_minutes: 240 };
    const r = computeAttendanceForEmployee(
      [day({ time_in: '08:00', time_out: '09:00', minHoursDecision: 'deny' })],
      DAILY_RATE, policy
    );
    expect(r.days_worked).toBe(0);
    expect(r.days_absent).toBe(0); // explicitly NOT an absence
    expect(r.days[0]!.status).toBe('below_minimum_denied');
    expect(r.days[0]!.below_minimum).toBe(true);
  });

  it('an explicit "allow" decision behaves exactly like no decision at all', () => {
    const policy = { ...POLICY, min_work_minutes: 240 };
    const r = computeAttendanceForEmployee(
      [day({ time_in: '08:00', time_out: '09:00', minHoursDecision: 'allow' })],
      DAILY_RATE, policy
    );
    expect(r.days_worked).toBe(1);
    expect(r.days[0]!.status).toBe('worked');
  });

  it('a day that meets the minimum is never flagged, decision or not', () => {
    const policy = { ...POLICY, min_work_minutes: 240 };
    const r = computeAttendanceForEmployee([day({ time_in: '08:00', time_out: '17:00' })], DAILY_RATE, policy);
    expect(r.days[0]!.below_minimum).toBe(false);
  });

  it('interacts with per_hour basis: a denied short day pays 0 hours instead of the prorated amount', () => {
    const policy = { ...POLICY, hours_basis: 'per_hour' as const, min_work_minutes: 240 };
    const r = computeAttendanceForEmployee(
      [day({ time_in: '08:00', time_out: '09:00', minHoursDecision: 'deny' })],
      DAILY_RATE, policy
    );
    expect(r.days_worked).toBe(0);
    expect(r.days[0]!.status).toBe('below_minimum_denied');
  });
});

describe('unrecordedOtMinutes — flags a block-worthy clock-out past shift end with no OT form', () => {
  it('a raw late clock-out with no linked form is flagged', () => {
    const policy = { ...POLICY, ot_unit: 'minute' as const };
    const mins = unrecordedOtMinutes(day({ time_in: '08:00', time_out: '18:00' }), policy);
    expect(mins).toBe(60);
  });

  it('already linked to an Overtime Request form -> not flagged (already authorized)', () => {
    const mins = unrecordedOtMinutes(
      day({ time_in: '08:00', time_out: '18:00', linkedForm: { slug: 'overtime_request', data: {} } }),
      POLICY
    );
    expect(mins).toBe(0);
  });

  it('an Offset form still counts as "no OT form" — flagged if the clock-out is past the SHIFTED end', () => {
    const policy = { ...POLICY, ot_unit: 'minute' as const };
    const mins = unrecordedOtMinutes(
      day({ time_in: '08:00', time_out: '19:00', linkedForm: { slug: 'offset_form', data: { new_time_out: '18:00' } } }),
      policy
    );
    expect(mins).toBe(60); // 1hr past the offset's own new end, not the original shift end
  });

  it('leaving on time or early is never flagged', () => {
    expect(unrecordedOtMinutes(day({ time_in: '08:00', time_out: '17:00' }), POLICY)).toBe(0);
    expect(unrecordedOtMinutes(day({ time_in: '08:00', time_out: '16:00' }), POLICY)).toBe(0);
  });

  it('no shift assigned -> never flagged (nothing to judge against)', () => {
    const mins = unrecordedOtMinutes(day({ time_in: '08:00', time_out: '20:00', shift: null }), POLICY);
    expect(mins).toBe(0);
  });

  it('no time logged -> never flagged', () => {
    expect(unrecordedOtMinutes(day({ time_in: null, time_out: null }), POLICY)).toBe(0);
  });

  it('rounds DOWN to completed blocks, same as the real OT calc — 71 raw minutes on an hour block flags only 60, not 120', () => {
    const policy = { ...POLICY, ot_unit: 'hour' as const };
    const mins = unrecordedOtMinutes(day({ time_in: '08:00', time_out: '18:11' }), policy);
    expect(mins).toBe(60);
  });

  it('agrees with computeAttendanceForEmployee\'s own OT minutes when require_ot_form is off, on the same day — the two must never independently drift', () => {
    const policy = { ...POLICY, ot_unit: 'minute' as const, require_ot_form: false };
    const d = day({ time_in: '08:00', time_out: '18:37' });
    const flagged = unrecordedOtMinutes(d, policy);
    const computed = computeAttendanceForEmployee([d], DAILY_RATE, policy);
    expect(flagged).toBe(Math.round(computed.days[0]!.ot_hours * 60));
  });
});

describe('computeAttendanceForEmployee — whole_day_min_minutes ("Undertime Days" vs whole days)', () => {
  const WHOLE = { ...POLICY, whole_day_min_minutes: 420 }; // 7 hours

  it('off by default (0): any presence at all is still a flat whole day, unchanged old behavior', () => {
    const r = computeAttendanceForEmployee([day({ time_in: '08:00', time_out: '10:00' })], DAILY_RATE, POLICY);
    expect(r.days_worked).toBe(1);
    expect(r.days_undertime).toBe(0);
    expect(r.days[0]!.status).toBe('worked');
  });

  it('exactly at the threshold (7h net) counts as a whole day', () => {
    // 08:00-16:00 raw = 8h, minus 1h lunch = 7h net -> meets the 420-min threshold exactly.
    const r = computeAttendanceForEmployee([day({ time_in: '08:00', time_out: '16:00' })], DAILY_RATE, WHOLE);
    expect(r.days_worked).toBe(1);
    expect(r.days_undertime).toBe(0);
    expect(r.days[0]!.status).toBe('worked');
  });

  it('just under the threshold becomes an "Undertime Day": 0 credit toward days_worked, paid proportionally, no late/undertime peso deduction layered on top', () => {
    // 08:00-15:30 raw = 7.5h, minus 1h lunch = 6.5h net -> under 7h.
    const r = computeAttendanceForEmployee([day({ time_in: '08:00', time_out: '15:30' })], DAILY_RATE, WHOLE);
    expect(r.days_worked).toBe(0);
    expect(r.days_undertime).toBe(1);
    expect(r.late_deduction).toBe(0);
    expect(r.undertime_pay).toBe(0);
    expect(r.undertime_day_pay).toBeCloseTo(6.5 * 100, 6); // 6.5 net hours x hourly rate
    expect(r.days[0]!.status).toBe('undertime');
    expect(r.days[0]!.undertime_day_pay).toBeCloseTo(6.5 * 100, 6);
  });

  it('raw presence alone is not enough if lunch pushes net hours under the threshold — 7.5h raw but only 6.5h net still counts as Undertime, not whole', () => {
    const r = computeAttendanceForEmployee([day({ time_in: '08:30', time_out: '16:00' })], DAILY_RATE, WHOLE);
    // 08:30-16:00 raw = 7.5h, minus 1h lunch = 6.5h net -> Undertime Day.
    expect(r.days_worked).toBe(0);
    expect(r.days_undertime).toBe(1);
  });

  it('a linked Half Day request is always its own fixed 0.5, never judged by whole_day_min_minutes even at 4 net hours', () => {
    const r = computeAttendanceForEmployee(
      [day({ time_in: '08:00', time_out: '12:00', linkedForm: { slug: 'halfday_request', data: { session: 'Morning (AM)' } } })],
      DAILY_RATE, WHOLE
    );
    expect(r.days_worked).toBe(0.5);
    expect(r.days_half).toBe(1);
    expect(r.days_undertime).toBe(0);
    expect(r.days[0]!.status).toBe('half_day');
  });

  it('a linked Undertime Request with with_pay=Yes is always a full day, never judged by whole_day_min_minutes even when hours present are short', () => {
    const r = computeAttendanceForEmployee(
      [day({ time_in: '08:00', time_out: '13:00', linkedForm: { slug: 'undertime_request', data: { with_pay: 'Yes' } } })],
      DAILY_RATE, WHOLE
    );
    expect(r.days_worked).toBe(1);
    expect(r.days_undertime).toBe(0);
    expect(r.days[0]!.status).toBe('worked');
  });

  it('an Undertime Request with with_pay=No is still judged by whole_day_min_minutes like any other short day', () => {
    const r = computeAttendanceForEmployee(
      [day({ time_in: '08:00', time_out: '13:00', linkedForm: { slug: 'undertime_request', data: { with_pay: 'No' } } })],
      DAILY_RATE, WHOLE
    );
    expect(r.days_worked).toBe(0);
    expect(r.days_undertime).toBe(1);
  });

  it('late arrival is still reported (informationally) on an Undertime Day, just never costs pay', () => {
    const r = computeAttendanceForEmployee([day({ time_in: '09:30', time_out: '15:00' })], DAILY_RATE, WHOLE);
    expect(r.days[0]!.status).toBe('undertime');
    expect(r.days[0]!.late_minutes).toBeGreaterThan(0);
    expect(r.days[0]!.late_pay).toBe(0);
    expect(r.late_deduction).toBe(0);
  });

  it('an explicit min_work_minutes "deny" still takes precedence over the whole-day/Undertime-Day classification', () => {
    const r = computeAttendanceForEmployee(
      [day({ time_in: '08:00', time_out: '09:00', minHoursDecision: 'deny' })],
      DAILY_RATE, { ...WHOLE, min_work_minutes: 240 }
    );
    expect(r.days[0]!.status).toBe('below_minimum_denied');
    expect(r.days_undertime).toBe(0);
    expect(r.days_worked).toBe(0);
  });
});

describe('computeAttendanceForEmployee — max_ot_hours (policy.max_ot_hours, null = no cap)', () => {
  it('null (default): no cap, unchanged old behavior', () => {
    const policy = { ...POLICY, require_ot_form: false, max_ot_hours: null };
    const r = computeAttendanceForEmployee([day({ time_in: '08:00', time_out: '21:00' })], DAILY_RATE, policy); // 4h raw OT
    expect(r.ot_hours).toBeCloseTo(4, 6);
  });

  it('caps OT hours credited/paid at the configured maximum — the excess is simply unpaid presence, not converted to anything else', () => {
    const policy = { ...POLICY, require_ot_form: false, ot_unit: 'minute' as const, max_ot_hours: 2 };
    const r = computeAttendanceForEmployee([day({ time_in: '08:00', time_out: '21:00' })], DAILY_RATE, policy); // 4h raw OT
    expect(r.ot_hours).toBeCloseTo(2, 6);
    expect(r.overtime_pay).toBeCloseTo(2 * 100 * 1.25, 6);
  });

  it('0 is a meaningful cap (no OT paid at all), distinct from null', () => {
    const policy = { ...POLICY, require_ot_form: false, max_ot_hours: 0 };
    const r = computeAttendanceForEmployee([day({ time_in: '08:00', time_out: '21:00' })], DAILY_RATE, policy);
    expect(r.ot_hours).toBe(0);
    expect(r.overtime_pay).toBe(0);
  });

  it('under the cap is unaffected', () => {
    const policy = { ...POLICY, require_ot_form: false, max_ot_hours: 5 };
    const r = computeAttendanceForEmployee([day({ time_in: '08:00', time_out: '19:00' })], DAILY_RATE, policy); // 2h raw OT
    expect(r.ot_hours).toBeCloseTo(2, 6);
  });

  it('also caps OT under hours_basis: per_hour', () => {
    const policy = { ...POLICY, hours_basis: 'per_hour' as const, require_ot_form: false, max_ot_hours: 1 };
    const r = computeAttendanceForEmployee([day({ time_in: '08:00', time_out: '20:00' })], DAILY_RATE, policy); // ~4h raw OT
    expect(r.ot_hours).toBeCloseTo(1, 6);
  });

  it('a capped OT tail earns no night differential for the uncompensated excess', () => {
    const policy = { ...POLICY, require_ot_form: false, night_diff_enabled: true, night_diff_percent: 10, ot_unit: 'minute' as const, max_ot_hours: 0.5 };
    const afternoon = { start_time: '14:00', end_time: '22:00' }; // regular hours never touch the 22:00-06:00 window
    // Raw OT would be 22:00-23:00 (1h), all inside the night window, but capped to 0.5h (22:00-22:30).
    const r = computeAttendanceForEmployee(
      [day({ time_in: '14:00', time_out: '23:00', shift: afternoon })],
      DAILY_RATE, policy
    );
    expect(r.ot_hours).toBeCloseTo(0.5, 6);
    expect(r.night_diff_pay).toBeCloseTo(0.5 * 100 * 0.10, 6); // only the 0.5 paid OT hour, not the full 1
  });
});

describe('computeAttendanceForEmployee — possible_half_day (a day that LOOKS like a half day but has no linked Half Day request)', () => {
  it('a real live case: 12:45-17:04 on an 08:00-17:00 shift (no linked form) is flagged, and — this is the actual bug — still gets docked a huge peso late deduction for "arriving 4h45m late" against the whole shift', () => {
    const r = computeAttendanceForEmployee([day({ time_in: '12:45', time_out: '17:04' })], DAILY_RATE, POLICY);
    expect(r.days[0]!.possible_half_day).toBe(true);
    expect(r.days[0]!.status).toBe('worked'); // NOT reclassified — the flag never changes pay on its own
    expect(r.late_deduction).toBeGreaterThan(0); // this is the actual damage the flag exists to catch
  });

  it('leaving early, AM pattern: 08:00-12:10 is also flagged', () => {
    const r = computeAttendanceForEmployee([day({ time_in: '08:00', time_out: '12:10' })], DAILY_RATE, POLICY);
    expect(r.days[0]!.possible_half_day).toBe(true);
  });

  it('a linked Half Day request is never flagged (already correctly handled)', () => {
    const r = computeAttendanceForEmployee(
      [day({ time_in: '12:45', time_out: '17:04', linkedForm: { slug: 'halfday_request', data: { session: 'Afternoon (PM)' } } })],
      DAILY_RATE, POLICY
    );
    expect(r.days[0]!.possible_half_day).toBe(false);
  });

  it('an ordinary whole day (arrived a bit late, worked most of the day) is not flagged', () => {
    const r = computeAttendanceForEmployee([day({ time_in: '08:30', time_out: '17:00' })], DAILY_RATE, POLICY);
    expect(r.days[0]!.possible_half_day).toBe(false);
  });

  it('a genuine, ordinary undertime day (left at 15:00, not lunch-adjacent) is not flagged', () => {
    const r = computeAttendanceForEmployee([day({ time_in: '08:00', time_out: '15:00' })], DAILY_RATE, POLICY);
    expect(r.days[0]!.possible_half_day).toBe(false);
  });

  it('no shift assigned -> never flagged (nothing to judge the pattern against)', () => {
    const r = computeAttendanceForEmployee([day({ time_in: '12:45', time_out: '17:04', shift: null })], DAILY_RATE, POLICY);
    expect(r.days[0]!.possible_half_day).toBe(false);
  });

  it('still flagged under hours_basis: per_hour (informational there too, even though pay already self-corrects)', () => {
    const r = computeAttendanceForEmployee(
      [day({ time_in: '12:45', time_out: '17:04' })], DAILY_RATE, { ...POLICY, hours_basis: 'per_hour' }
    );
    expect(r.days[0]!.possible_half_day).toBe(true);
  });
});
