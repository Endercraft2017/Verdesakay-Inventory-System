/** Pure payroll computation from one employee's attendance days + whatever HR forms (OT/Half
    Day/Leave/Undertime/Offset) are optionally linked to each day + any company-wide No Work
    Memo covering that date + the company's payroll policy. No DB access here — the caller
    (src/routes/hr.routes.ts) resolves shift_id -> {start_time, end_time}, form_record_id ->
    {slug, data}, and work_date -> a matching No Work Memo (if any) first, mirroring how
    src/hr-payroll-import.ts keeps its own parsing logic free of DB access so it stays
    independently unit-testable. */
import type { PayrollPolicy } from './types';

export interface AttendanceDay {
  work_date: string;
  time_in: string | null;  // "HH:MM"
  time_out: string | null; // "HH:MM"
  shift: { start_time: string; end_time: string } | null;
  linkedForm: { slug: string; data: Record<string, unknown> } | null;
  // Company-wide "No Work Memo" covering this date (unrelated to linkedForm — that's a form an
  // individual employee is linked to; this is a blanket declaration that applies automatically
  // to everyone, no per-employee linking needed). Omitted/null = no memo covers this date.
  noWork?: 'paid' | 'unpaid' | null;
  // This day's holiday type, already resolved by the caller as per-record override (attendance_
  // records.holiday_type) if set, else whatever the Company Holidays calendar says for this
  // work_date, else null. 'special_working' behaves like an ordinary day (informational only —
  // no premium, no unworked-pay change) so it's accepted here but never branched on below.
  // 'cancelled_paid'/'cancelled_unpaid' are a per-record, per-employee version of a No Work
  // Memo (equipment failure, sent home early, etc. — not a real holiday, no premium either
  // way) — always a per-record override, never sourced from the Company Holidays calendar.
  holiday?: 'regular' | 'special_non_working' | 'special_working' | 'cancelled_paid' | 'cancelled_unpaid' | null;
  // Whether this work_date falls on this employee's rest day — resolved by the caller from
  // employees.rest_days (if set) else PayrollPolicy.default_rest_days. Never stored; purely a
  // function of the date, so the caller recomputes it each time rather than persisting it.
  isRestDay?: boolean;
}

export interface AttendanceComputation {
  days_worked: number;
  /** Days with no usable time logged AND not paid another way (no paid Leave, no paid No
   *  Work Memo) — a genuine no-show, an unpaid Leave, or an unpaid No Work Memo, counted the
   *  same either way. Purely informational: an absent day already isn't in days_worked, so
   *  it already doesn't get paid via basic_salary = daily_rate * days_worked — this field
   *  doesn't subtract anything itself, it just makes that reduction visible on the payslip
   *  instead of silent (see the "Late / Absences" line, which — despite the name — has only
   *  ever held the late-arrival peso deduction; see hr.routes.ts generate-payslips). */
  days_absent: number;
  late_deduction: number;
  ot_hours: number;
  overtime_pay: number;
  undertime_pay: number; // negative — matches the existing "Undertime" earnings-line convention
  holiday_pay: number;
  special_holiday_30: number;
  /** Auto-computed rest-day-worked premium (30% for a plain rest day, folded into holiday_pay/
   *  special_holiday_30 instead when the day is ALSO a holiday — see the multiplier table in
   *  computeAttendanceForEmployee). Same "premium only, not the full day" convention as
   *  holiday_pay/special_holiday_30 — the day's base 100% is already in basic_salary via
   *  days_worked. Was a purely-manual payslip field before this; see hr.routes.ts. */
  rest_day_ot: number;
  /** Per-day breakdown, collected in the same loop that produces the aggregate above — so
   *  these always sum to it exactly, never a separately-derived (and possibly drifting) copy.
   *  For the "why does my payslip say X" read-only detail view (hr.routes.ts's payroll detail
   *  route); the aggregate fields above are what actually drive the payslip's money fields. */
  days: DayBreakdown[];
}

export interface DayBreakdown {
  work_date: string;
  time_in: string | null;
  time_out: string | null;
  holiday: AttendanceDay['holiday'] | null;
  no_work: 'paid' | 'unpaid' | null;
  is_rest_day: boolean;
  // Mirrors exactly which branch of the unworked-day precedence (see the comment above it)
  // fired, or 'worked' for a day with time logged — not a new aggregate-level distinction,
  // just makes an already-computed decision visible per day instead of only summed.
  status: 'worked' | 'paid_leave' | 'paid_no_work' | 'paid_holiday' | 'rest_day_off' | 'absent';
  late_minutes: number;
  late_pay: number;
  ot_hours: number;
  ot_pay: number;
  undertime_pay: number;
  day_premium_pay: number; // whichever of holiday_pay/special_holiday_30/rest_day_ot this day contributed
}

const DAY_MIN = 24 * 60;

/** "HH:MM" -> minutes since 00:00. Anything unparseable is treated as absent/unknown. */
function toMinutes(t: string | null | undefined): number | null {
  if (!t) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h > 23 || mm > 59) return null;
  return h * 60 + mm;
}

function unitMinutesFor(unit: 'minute' | '30min' | 'hour'): number {
  return unit === 'hour' ? 60 : unit === '30min' ? 30 : 1;
}

/** Round `minutes` UP to the nearest `unitMinutes` block — confirmed convention: any partial
    block counts as a full block, in both directions (against the employee for lateness/
    undertime, in their favor for OT). 0 or negative stays 0. */
function roundUpToUnit(minutes: number, unitMinutes: number): number {
  if (minutes <= 0) return 0;
  return Math.ceil(minutes / unitMinutes) * unitMinutes;
}

/** Overlap (in minutes) between the span [fromMin, toMin) — wall-clock minutes, `toMin` may
    exceed 1440 if the span crosses midnight — and the night-differential window [nightStart,
    nightEnd), which may itself wrap midnight (e.g. 22:00-06:00). Checks both the window's
    "today" and "tomorrow" instance so a span crossing midnight is still caught. */
function nightOverlapMinutes(fromMin: number, toMin: number, nightStart: number, nightEnd: number): number {
  if (toMin <= fromMin) return 0;
  const base: Array<[number, number]> = nightStart <= nightEnd
    ? [[nightStart, nightEnd]]
    : [[nightStart, DAY_MIN], [0, nightEnd]];
  const windows = [...base, ...base.map(([s, e]): [number, number] => [s + DAY_MIN, e + DAY_MIN])];
  let total = 0;
  for (const [ws, we] of windows) {
    const overlap = Math.min(toMin, we) - Math.max(fromMin, ws);
    if (overlap > 0) total += overlap;
  }
  return total;
}

const ZERO: AttendanceComputation = {
  days_worked: 0, days_absent: 0, late_deduction: 0, ot_hours: 0, overtime_pay: 0,
  undertime_pay: 0, holiday_pay: 0, special_holiday_30: 0, rest_day_ot: 0, days: [],
};

/** DOLE Labor Advisory No. 12-25 total pay multiplier for a worked day, by holiday type +
    rest-day combination — the single source of truth both the base-day premium below AND the
    OT-rate scaling in the overtime_request branch derive from, so the two can never drift
    apart. 1.0 = ordinary day (no premium). */
function dayRateMultiplier(holiday: AttendanceDay['holiday'], isRestDay: boolean | undefined): number {
  if (holiday === 'regular') return isRestDay ? 2.6 : 2.0;
  if (holiday === 'special_non_working') return isRestDay ? 1.5 : 1.3;
  if (isRestDay) return 1.3;
  return 1.0;
}

export function computeAttendanceForEmployee(
  days: AttendanceDay[],
  dailyRate: number,
  policy: PayrollPolicy
): AttendanceComputation {
  const hourlyRate = dailyRate / 8;
  // Not { ...ZERO } for `days` specifically — a shallow spread would copy ZERO's own array
  // *reference*, so every call would push into (and pollute) the exact same shared array.
  const out: AttendanceComputation = { ...ZERO, days: [] };
  const nightStart = toMinutes(policy.night_start) ?? 0;
  const nightEnd = toMinutes(policy.night_end) ?? 0;

  for (const day of days) {
    const slug = day.linkedForm?.slug;
    const timeIn = toMinutes(day.time_in);
    const timeOut = toMinutes(day.time_out);
    // Per-day mirror of whatever the aggregate below adds — pushed to out.days at every exit
    // point of this iteration (there are several `continue`s), so it always reflects exactly
    // what happened to this specific day, never a separately-derived guess.
    let lateMin = 0, latePay = 0, otHours = 0, otPay = 0, undertimePay = 0, dayPremium = 0;
    let status: DayBreakdown['status'] = 'worked';
    const pushDay = () => out.days.push({
      work_date: day.work_date, time_in: day.time_in, time_out: day.time_out,
      holiday: day.holiday ?? null, no_work: day.noWork ?? null, is_rest_day: !!day.isRestDay,
      status, late_minutes: lateMin, late_pay: latePay, ot_hours: otHours, ot_pay: otPay,
      undertime_pay: undertimePay, day_premium_pay: dayPremium,
    });

    if (timeIn == null || timeOut == null) {
      // No usable time logged. In order of precedence: a linked, paid Leave form makes it a
      // full paid day; otherwise a company-wide "No Work Memo" covering this date (management
      // declared no work — a typhoon suspension, equipment failure, etc.) means it's automatically
      // *not* counted as an absence at all, regardless of whether the employee filed anything —
      // paid if the memo says so, contributing nothing either way if unpaid (same as a plain
      // absence numerically, but distinguished here for anyone reading/extending this later:
      // it was an excused, management-declared non-workday, not an unexplained no-show).
      // An unworked Regular Holiday is *always* paid by law (Labor Code Art. 94) — 100%, same
      // as a paid Leave day; simplified vs. DOLE's stricter "present/on paid leave the day
      // immediately before" eligibility check, which this per-day loop doesn't look back for.
      // Unlike a paid Leave/No Work/cancellation day, its 100% is booked straight into
      // holiday_pay instead of days_worked/basic_salary — keeping it OUT of "Days Worked" so
      // that field only ever counts days the employee was actually present or on ordinary paid
      // leave, and the payslip's Holiday Pay line shows this day's money instead of it being
      // silently absorbed into Basic Salary where it reads as an extra day worked.
      // An unworked Special Non-Working (or Special Working) day is plain "no work, no pay" —
      // same bucket as an unpaid No Work Memo day, not specially distinguished. A per-record
      // "Work Cancellation" (equipment failure, sent home early, etc. — not a real holiday) is
      // the same idea at per-employee granularity instead of company-wide: paid credits a full
      // day same as a paid Leave/No Work Memo day, unpaid falls to the same bucket as those.
      // An unworked rest day is neither paid nor an absence — it was never a scheduled workday
      // to begin with, so it contributes to neither days_worked nor days_absent (unlike the
      // above cases, which are all still "supposed to work, but excused" one way or another) —
      // but only when nothing else already explains the day; an explicit unpaid/excused marking
      // (special_non_working, cancelled_unpaid) still shows up in days_absent even on a rest
      // day, since that's a more specific, deliberately-recorded classification, not silence.
      // Otherwise it's a genuine unpaid absence and contributes nothing.
      if (slug === 'leave_request' && day.linkedForm?.data?.with_pay === 'Yes') {
        out.days_worked += 1;
        status = 'paid_leave';
      } else if (day.noWork === 'paid') {
        out.days_worked += 1;
        status = 'paid_no_work';
      } else if (day.holiday === 'regular') {
        out.holiday_pay += dailyRate;
        dayPremium = dailyRate;
        status = 'paid_holiday';
      } else if (day.holiday === 'cancelled_paid') {
        out.days_worked += 1;
        status = 'paid_holiday';
      } else if (day.isRestDay && !day.holiday) {
        // intentionally silent — see comment above
        status = 'rest_day_off';
      } else {
        out.days_absent += 1;
        status = 'absent';
      }
      pushDay();
      continue;
    }

    out.days_worked += slug === 'halfday_request' ? 0.5 : 1;

    // Holiday/rest-day premiums first, before the shift-required guard below — unlike late/OT/
    // undertime (which need a shift's start/end time to judge against), these depend only on
    // the day's own type, not on a shift being assigned at all. Was previously stuck after that
    // guard, so a worked day with no shift set silently got 0 holiday/rest-day pay regardless of
    // day.holiday/isRestDay — a real bug, not a "no shift, nothing to compute" case like late is.
    if (slug === 'holiday_work_request') {
      const hours = Number(day.linkedForm?.data?.hours_worked) || 0;
      const isRegular = day.linkedForm?.data?.holiday_type === 'Regular Holiday';
      // PH convention: the linked form's hours already earned basic pay via days_worked/basic_
      // salary above — this is just the *additional* premium on top (100% for Regular Holiday,
      // 30% for Special Non-Working — the latter is why the field is literally named "...30").
      const premium = hours * hourlyRate * (isRegular ? 1.0 : 0.3);
      if (isRegular) out.holiday_pay += premium;
      else out.special_holiday_30 += premium;
      dayPremium = premium;
    } else if (day.holiday === 'regular' || day.holiday === 'special_non_working' || day.isRestDay) {
      // Same premium-only convention as the holiday_work_request branch above (the day's base
      // 100% is already counted via days_worked/basic_salary), but driven by HR directly marking
      // the day (per-record override, or the Company Holidays calendar) instead of an employee
      // self-filing a Holiday Work Request — so it's gated on that branch NOT having fired for
      // this day, to avoid paying the premium twice. Uses the whole day's rate as the premium
      // base (not actual hours worked) — simplest correct behavior for the common case; doesn't
      // specially prorate a half-day (halfday_request) that also happens to be a holiday/rest
      // day, an intentionally rare combination not worth the extra complexity.
      // DOLE Labor Advisory No. 12-25 combo rates, via the same dayRateMultiplier the OT branch
      // below uses: a rest day doesn't just add 30% on top of whatever else applies — Regular
      // Holiday + rest day is a flat 260% (multiplier 2.6, i.e. +30% of the 200% regular-holiday
      // rate), while Special Non-Working + rest day is a flat 150% (multiplier 1.5, not +30% of
      // the already-130% special rate) — subtracting 1.0 (the day's base 100%, already counted
      // via days_worked/basic_salary above) leaves just the premium this field stores.
      const premiumPct = dayRateMultiplier(day.holiday, day.isRestDay) - 1.0;
      if (day.holiday === 'regular') {
        out.holiday_pay += dailyRate * premiumPct;
        dayPremium = dailyRate * premiumPct;
      } else if (day.holiday === 'special_non_working') {
        out.special_holiday_30 += dailyRate * premiumPct;
        dayPremium = dailyRate * premiumPct;
      } else if (day.isRestDay) {
        out.rest_day_ot += dailyRate * premiumPct;
        dayPremium = dailyRate * premiumPct;
      }
    }

    if (!day.shift) { pushDay(); continue; } // no shift assigned -> nothing to judge late/OT/undertime against

    const shiftStart = toMinutes(day.shift.start_time);
    let shiftEnd = toMinutes(day.shift.end_time);
    if (shiftStart == null || shiftEnd == null) { pushDay(); continue; }
    const overnight = shiftEnd < shiftStart;
    if (overnight) shiftEnd += DAY_MIN; // e.g. 22:00-06:00 -> end normalized to 30:00

    // Put every clock reading on the SAME continuous timeline as shiftStart, so a shift that
    // wraps midnight doesn't break the arithmetic below — a raw reading earlier than shiftStart
    // is treated as having happened after midnight, i.e. "later" on this timeline, not earlier.
    const relTo = (min: number) => (overnight && min < shiftStart ? min + DAY_MIN : min);
    const timeInRel = relTo(timeIn);
    const timeOutRel = relTo(timeOut);

    // An Offset form shifts this day's expected time-out (e.g. arrived late, agreed to leave
    // later instead) — the effective end used for both the OT and undertime checks below.
    let effectiveEnd = shiftEnd;
    if (slug === 'offset_form') {
      const offsetEndRaw = toMinutes(day.linkedForm?.data?.new_time_out as string | undefined);
      if (offsetEndRaw != null) effectiveEnd = relTo(offsetEndRaw);
    }

    // Late arrival: grace is a threshold, not a subtracted buffer while under it — but once
    // exceeded, only the minutes *past* grace are rounded to a block (confirmed: 125 min late
    // with a 10 min grace and a 1-hour block -> 115 min past grace -> rounds up to 2 hours, not
    // 3 — rounding the full 125 raw minutes would over-penalize).
    const lateRaw = timeInRel - shiftStart;
    if (lateRaw > policy.grace_minutes) {
      const pastGrace = lateRaw - policy.grace_minutes;
      const lateBlocked = roundUpToUnit(pastGrace, unitMinutesFor(policy.late_unit));
      lateMin = lateBlocked;
      latePay = (lateBlocked / 60) * hourlyRate;
      out.late_deduction += latePay;
    }

    // policy.require_ot_form (default true, the original behavior): OT is only credited when
    // authorized by a linked Overtime form — a raw late clock-out by itself isn't auto-paid
    // overtime. Turned off, any clock-out past the shift's expected end auto-pays OT with no
    // form needed, same as late/undertime already need no authorization to apply — some
    // companies don't require employees to file anything for OT, so this makes that opt-in
    // rather than mandatory. A linked Overtime form (when present) still always routes here
    // regardless of this setting, preserving the exact old behavior for that case: an
    // authorized-but-early day still books no undertime (mirrors the pre-existing rule that an
    // overtime_request-linked day is judged only for OT, never undertime, even if otRaw <= 0).
    if (slug === 'overtime_request' || (!policy.require_ot_form && timeOutRel > effectiveEnd)) {
      const otRaw = timeOutRel - effectiveEnd;
      if (otRaw > 0) {
        const otBlocked = roundUpToUnit(otRaw, unitMinutesFor(policy.ot_unit));
        otHours = otBlocked / 60;
        out.ot_hours += otHours;
        // OT pay scales with the day's own rate multiplier too — OT worked on a Regular Holiday
        // isn't paid at the same rate as OT on an ordinary day (DOLE: hourly rate x 200% x 130%
        // for a Regular Holiday, not just x 125%). Rather than hardcoding DOLE's own OT sub-rates
        // (169%/195%/260%/338% for each combination) as separate magic numbers, this reuses the
        // exact same dayRateMultiplier the base-day premium above is built from, scaled by the
        // admin's configured OT%: ordinary-day OT is unaffected (multiplier 1.0, same result as
        // before this existed), and every holiday/rest-day combination scales consistently with
        // whatever OT% the company has configured, instead of a second hardcoded rate.
        const dayMult = dayRateMultiplier(day.holiday, day.isRestDay);
        let pay = otHours * hourlyRate * dayMult * (policy.ot_rate_percent / 100);
        if (policy.night_diff_enabled) {
          // Convert back to wall-clock (mod 24h) for the night-window check — effectiveEnd/
          // timeOutRel may be on the shift's extended "past midnight" timeline.
          const wallStart = effectiveEnd % DAY_MIN;
          const nightMin = nightOverlapMinutes(wallStart, wallStart + otRaw, nightStart, nightEnd);
          pay += (nightMin / 60) * hourlyRate * (policy.night_diff_percent / 100);
        }
        otPay = pay;
        out.overtime_pay += pay;
      }
    } else if (timeOutRel < effectiveEnd) {
      // Left before the expected end. Deducted by default — unlike OT, a short day doesn't
      // need anyone's authorization to be a deduction. The one exception: a linked Undertime
      // Request form with with_pay = 'Yes' — a company-authorized, PAID early release (e.g. a
      // documented emergency) waives the deduction outright, no make-up owed. That's different
      // from an Offset form, which defers the obligation (make up the time later) rather than
      // waiving it — hence effectiveEnd is still computed from Offset above, not this.
      const authorizedPaid = slug === 'undertime_request' && day.linkedForm?.data?.with_pay === 'Yes';
      if (!authorizedPaid) {
        const shortRaw = effectiveEnd - timeOutRel;
        const shortBlocked = roundUpToUnit(shortRaw, unitMinutesFor(policy.late_unit));
        undertimePay = -(shortBlocked / 60) * hourlyRate;
        out.undertime_pay += undertimePay;
      }
    }

    pushDay();
  }

  return out;
}

/** Whether `day` shows unrecorded OT — a block-worthy clock-out past the shift's expected end
 *  (respecting an Offset form's shifted end time, same as the real OT calculation) — with no
 *  linked Overtime Request form to authorize it. For src/routes/me.routes.ts's mobile "you have
 *  unrecorded OT" prompt: independent of policy.require_ot_form (that setting controls whether
 *  unauthorized OT gets PAID, not whether it's worth flagging to the employee to go file for),
 *  and an Offset form still counts as "no OT form" — Offset only defers the obligation, it
 *  doesn't authorize OT pay. Returns the block-rounded OT minutes if unrecorded, else 0.
 *  Deliberately re-derives the same shift-timeline resolution computeAttendanceForEmployee's
 *  main loop does (not a shared helper) — the two are pinned against the same fixtures in tests
 *  so they can't silently drift on what counts as "worked past the shift". */
export function unrecordedOtMinutes(day: AttendanceDay, policy: PayrollPolicy): number {
  if (day.linkedForm?.slug === 'overtime_request') return 0; // already authorized
  const timeIn = toMinutes(day.time_in);
  const timeOut = toMinutes(day.time_out);
  if (timeIn == null || timeOut == null || !day.shift) return 0;
  const shiftStart = toMinutes(day.shift.start_time);
  let shiftEnd = toMinutes(day.shift.end_time);
  if (shiftStart == null || shiftEnd == null) return 0;
  const overnight = shiftEnd < shiftStart;
  if (overnight) shiftEnd += DAY_MIN;
  const relTo = (min: number) => (overnight && min < shiftStart ? min + DAY_MIN : min);
  const timeOutRel = relTo(timeOut);

  let effectiveEnd = shiftEnd;
  if (day.linkedForm?.slug === 'offset_form') {
    const offsetEndRaw = toMinutes(day.linkedForm?.data?.new_time_out as string | undefined);
    if (offsetEndRaw != null) effectiveEnd = relTo(offsetEndRaw);
  }

  const otRaw = timeOutRel - effectiveEnd;
  if (otRaw <= 0) return 0;
  return roundUpToUnit(otRaw, unitMinutesFor(policy.ot_unit));
}
