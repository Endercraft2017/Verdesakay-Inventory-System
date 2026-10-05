/** OT grace and "OT counts after" (PayrollPolicy.ot_grace_minutes / ot_min_minutes,
    otCreditMinutes in hr-payroll-compute.ts). Grace: short of the next OT step by no more than
    the grace counts as reaching it (17:56 on a 17:00 end, hour steps, 5 min → 1 h). Minimum: no OT
    until it's reached, then ot_unit steps (60 + 30-minute steps: 18:30 → 1.5 h, 17:30 → 0).
    Both 0 = the plain round-down to ot_unit, unchanged. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { computeAttendanceForEmployee, otCreditMinutes, unrecordedOtMinutes, type AttendanceDay } from '../src/modules/payroll/hr-payroll-compute';
import type { PayrollPolicy } from '../src/shared/types';
import { setupApp, cleanup, login, type TestContext } from './helpers';

const POLICY: PayrollPolicy = {
  grace_minutes: 0, late_unit: 'minute', ot_unit: 'hour', ot_rate_percent: 125, require_ot_form: true,
  night_diff_enabled: true, night_diff_percent: 10, night_start: '22:00', night_end: '06:00',
  monthly_rate_divisor: 26, pay_frequency: 'semi_monthly', auto_statutory: true, default_rest_days: [0],
  min_work_minutes: 0, lunch_break_minutes: 60, count_lunch_as_worked: false, count_lunch_late_as_late: false,
  hours_basis: 'fixed', hours_basis_unit: '30min', whole_day_min_minutes: 0, max_ot_hours: null,
  special_holiday_premium_mode: 'flat', holiday_adjacency_requirement: 'none',
};
const DAILY_RATE = 800; // hourly 100, OT hour 125
const SHIFT = { start_time: '08:00', end_time: '17:00' };
const OT = [{ slug: 'overtime_request', data: {} }];
const day = (time_out: string, extra: Partial<AttendanceDay> = {}): AttendanceDay =>
  ({ work_date: '2026-09-16', time_in: '08:00', time_out, shift: SHIFT, linkedForm: null, linkedForms: OT, ...extra });
const otHours = (time_out: string, policy: PayrollPolicy, extra: Partial<AttendanceDay> = {}) =>
  computeAttendanceForEmployee([day(time_out, extra)], DAILY_RATE, policy).ot_hours;

describe('otCreditMinutes', () => {
  it('both off: the plain round-down to ot_unit', () => {
    expect(otCreditMinutes(56, POLICY)).toBe(0);
    expect(otCreditMinutes(113, POLICY)).toBe(60);
    expect(otCreditMinutes(113, { ...POLICY, ot_unit: '30min' })).toBe(90);
    expect(otCreditMinutes(113, { ...POLICY, ot_unit: 'minute' })).toBe(113);
    expect(otCreditMinutes(0, POLICY)).toBe(0);
    expect(otCreditMinutes(-20, POLICY)).toBe(0);
  });

  it('grace reaches the next step when that close, one step at most', () => {
    const p = { ...POLICY, ot_grace_minutes: 5 };
    expect(otCreditMinutes(56, p)).toBe(60);   // 4 short of the hour
    expect(otCreditMinutes(55, p)).toBe(60);   // exactly 5 short
    expect(otCreditMinutes(54, p)).toBe(0);    // 6 short
    expect(otCreditMinutes(116, p)).toBe(120);
    expect(otCreditMinutes(113, p)).toBe(60);  // 7 short of 2 h
    expect(otCreditMinutes(26, { ...p, ot_unit: '30min', ot_grace_minutes: 59 })).toBe(30); // never two steps
  });

  it('grace adds nothing in per-minute steps (no step to reach)', () => {
    expect(otCreditMinutes(56, { ...POLICY, ot_unit: 'minute', ot_grace_minutes: 5 })).toBe(56);
  });

  it('minimum first, then steps: 60 + 30-minute steps', () => {
    const p = { ...POLICY, ot_unit: '30min' as const, ot_min_minutes: 60 };
    expect(otCreditMinutes(30, p)).toBe(0);   // 17:30 — not OT
    expect(otCreditMinutes(59, p)).toBe(0);
    expect(otCreditMinutes(60, p)).toBe(60);
    expect(otCreditMinutes(89, p)).toBe(60);
    expect(otCreditMinutes(90, p)).toBe(90);  // 18:30 — 1.5 h
    expect(otCreditMinutes(113, p)).toBe(90);
  });

  it('minimum with per-minute steps, and grace on reaching the minimum', () => {
    expect(otCreditMinutes(75, { ...POLICY, ot_unit: 'minute', ot_min_minutes: 60 })).toBe(75);
    expect(otCreditMinutes(45, { ...POLICY, ot_unit: 'minute', ot_min_minutes: 60 })).toBe(0);
    expect(otCreditMinutes(56, { ...POLICY, ot_unit: 'minute', ot_min_minutes: 60, ot_grace_minutes: 5 })).toBe(60);
    expect(otCreditMinutes(86, { ...POLICY, ot_unit: '30min', ot_min_minutes: 60, ot_grace_minutes: 5 })).toBe(90);
  });
});

describe('OT rules in payroll', () => {
  it('the 17:56 example: 1 h with a 5-minute grace, 0 without', () => {
    expect(otHours('17:56', POLICY)).toBe(0);
    expect(otHours('17:56', { ...POLICY, ot_grace_minutes: 5 })).toBe(1);
  });

  it('the per-30-minutes-after-the-first-hour example', () => {
    const p = { ...POLICY, ot_unit: '30min' as const, ot_min_minutes: 60 };
    expect(otHours('18:30', p)).toBe(1.5);
    expect(otHours('17:30', p)).toBe(0);
    expect(otHours('18:53', p)).toBe(1.5);
    expect(otHours('18:53', POLICY)).toBe(1); // the old hour-only rule
  });

  it('still needs the OT form, and still respects the daily cap', () => {
    const p = { ...POLICY, ot_grace_minutes: 5 };
    expect(otHours('17:56', p, { linkedForms: [] })).toBe(0);
    expect(otHours('19:58', { ...p, max_ot_hours: 2 })).toBe(2);
    expect(otHours('20:56', { ...p, max_ot_hours: 2 })).toBe(2);
  });

  it('grace-credited minutes past the time-out earn no night differential', () => {
    const night = { start_time: '14:00', end_time: '21:56' };
    const g = computeAttendanceForEmployee(
      [{ work_date: '2026-09-16', time_in: '14:00', time_out: '22:52', shift: night, linkedForm: null, linkedForms: OT }],
      DAILY_RATE, { ...POLICY, ot_grace_minutes: 5 }
    );
    expect(g.ot_hours).toBe(1); // 56 min, credited as 1 h by the grace
    // Night differential covers 22:00-22:52 actually present, not the credited 22:56.
    expect(g.night_diff_pay).toBeCloseTo((52 / 60) * 100 * 0.1, 6);
  });

  it('early OT and the unrecorded-OT prompt use the same rule', () => {
    const p = { ...POLICY, ot_unit: '30min' as const, ot_min_minutes: 60 };
    const early = computeAttendanceForEmployee(
      [day('17:00', { time_in: '06:30', linkedForms: [{ slug: 'overtime_request', data: { early_ot: true } }] })], DAILY_RATE, p
    );
    expect(early.ot_hours).toBe(1.5);
    expect(unrecordedOtMinutes(day('18:30', { linkedForms: [] }), p)).toBe(90);
    expect(unrecordedOtMinutes(day('17:30', { linkedForms: [] }), p)).toBe(0);
  });
});

describe('OT rules — Policy Settings', () => {
  let ctx: TestContext;
  let token: string;
  const hdr = () => ({ Authorization: `Bearer ${token}` });
  beforeAll(async () => { ctx = await setupApp(); token = await login(ctx.api); });
  afterAll(() => cleanup(ctx));

  it('default to 0 (off) and round-trip when saved', async () => {
    const before = await ctx.api.get('/api/hr/payroll-policy').set(hdr());
    expect(before.body.ot_grace_minutes ?? 0).toBe(0);
    expect(before.body.ot_min_minutes ?? 0).toBe(0);
    const saved = await ctx.api.put('/api/hr/payroll-policy').set(hdr())
      .send({ ...before.body, ot_unit: '30min', ot_grace_minutes: 5, ot_min_minutes: 60 });
    expect(saved.status).toBe(200);
    const after = await ctx.api.get('/api/hr/payroll-policy').set(hdr());
    expect(after.body).toMatchObject({ ot_unit: '30min', ot_grace_minutes: 5, ot_min_minutes: 60 });
  });

  it('rejects a grace of an hour or more', async () => {
    const before = await ctx.api.get('/api/hr/payroll-policy').set(hdr());
    const bad = await ctx.api.put('/api/hr/payroll-policy').set(hdr()).send({ ...before.body, ot_grace_minutes: 60 });
    expect(bad.status).toBe(400);
  });
});
