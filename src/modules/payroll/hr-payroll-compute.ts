/** Pure payroll computation from one employee's attendance days + whatever HR forms (OT/Half
    Day/Leave/Undertime/Offset) are optionally linked to each day + any company-wide No Work
    Memo covering that date + the company's payroll policy. No DB access here — the caller
    (src/routes/hr.routes.ts) resolves shift_id -> {start_time, end_time}, form_record_id ->
    {slug, data}, and work_date -> a matching No Work Memo (if any) first, mirroring how
    src/hr-payroll-import.ts keeps its own parsing logic free of DB access so it stays
    independently unit-testable. */
import type { PayrollPolicy } from '../../shared/types';

export interface AttendanceDay {
  work_date: string;
  time_in: string | null;  // "HH:MM"
  time_out: string | null; // "HH:MM"
  /** Lunch-break bracket, same "HH:MM" shape. Optional/omittable — undefined behaves exactly
      like null, so every existing caller/test that never set these is unaffected. Used for the
      abandoned-after-lunch half-day substitution and PayrollPolicy.count_lunch_late_as_late —
      see their comments below. */
  lunch_out?: string | null;
  lunch_in?: string | null;
  shift: { start_time: string; end_time: string } | null;
  /** All HR request forms linked to this day (OT / Half Day / Leave / Undertime / Offset /
      Holiday Work). A day can carry more than one — they're applied by concern, not first-wins:
      a Half Day sets the 0.5 credit + AM/PM window, an Offset shifts that window's end, an
      Overtime authorises time past it, an Undertime-with-pay waives a shortfall, etc. */
  linkedForms?: Array<{ slug: string; data: Record<string, unknown> }> | null;
  /** @deprecated Legacy single link. Still accepted — normalised to a one-element linkedForms
      at the top of the loop, so existing callers/tests keep working unchanged. */
  linkedForm?: { slug: string; data: Record<string, unknown> } | null;
  // Company-wide "No Work Memo" covering this date (unrelated to linked forms — those are forms
  // an individual employee is linked to; this is a blanket declaration that applies
  // automatically to everyone, no per-employee linking needed). Omitted/null = no memo covers it.
  noWork?: 'paid' | 'unpaid' | null;
  // This day's holiday type, already resolved by the caller as per-record override (attendance_
  // records.holiday_type) if set, else whatever the Company Holidays calendar says for this
  // work_date, else null. 'special_working' behaves like an ordinary day (informational only —
  // no premium, no unworked-pay change) so it's accepted here but never branched on below.
  // 'cancelled_paid'/'cancelled_unpaid' are a per-record, per-employee version of a No Work
  // Memo (equipment failure, sent home early, etc. — not a real holiday, no premium either
  // way) — always a per-record override, never sourced from the Company Holidays calendar.
  holiday?: 'regular' | 'special_non_working' | 'special_working' | 'cancelled_paid' | 'cancelled_unpaid' | null;
  // Whether this work_date falls on this employee's rest day — resolved by the caller (per-day
  // override, then an approved Change of Rest Day form, then employees.rest_days else
  // PayrollPolicy.default_rest_days — see src/modules/hr/rest-day.ts). Never stored; the caller
  // recomputes it each time rather than persisting it.
  isRestDay?: boolean;
  // HR's explicit allow/deny decision on a day under PayrollPolicy.min_work_minutes — see
  // attendance_records.min_hours_decision. null/omitted behaves exactly like 'allow' (pays for
  // actual hours/fraction worked); only an explicit 'deny' zeroes the day's credit.
  minHoursDecision?: 'allow' | 'deny' | null;
  // Whether this day satisfies PayrollPolicy.holiday_adjacency_requirement, already resolved by
  // the caller (holidayAdjacencyOk in hr.routes.ts — needs a period-independent DB lookup on the
  // adjacent date, which this DB-free module can't do itself). Only meaningful when `holiday` is
  // 'regular' or 'special_non_working'; ignored otherwise. undefined/true: eligible (also true
  // when the policy requirement is 'none'). false: this day's holiday pay/premium is withheld —
  // see the holiday branches below.
  holidayEligible?: boolean;
  // HR's explicit "credit this day as a half day anyway" call (attendance_records.
  // half_day_override) — 'am'/'pm' force the same 0.5-day credit + half-window late/undertime
  // judgement a linked Half Day request or the automatic possible_half_day heuristic would, for
  // a day that's neither (e.g. the raw punch times don't happen to land near the shift's own
  // lunch gap, or one side of the day's punches is missing entirely). Ignored whenever a real
  // halfday_request IS linked — that always takes precedence. null/undefined: no override.
  halfDayOverride?: 'am' | 'pm' | null;
}

export interface AttendanceComputation {
  days_worked: number;
  /** Days with no usable time logged AND not paid another way (no paid Leave, no paid No
   *  Work Memo) — a genuine no-show, an unpaid Leave, or an unpaid No Work Memo, counted the
   *  same either way. Purely informational: an absent day already isn't in days_worked, so
   *  it already doesn't get paid via basic_salary = daily_rate * days_worked — this field
   *  doesn't subtract anything itself, it just makes that reduction visible on the payslip
   *  instead of silent (see the "Late / Absences" line, which — despite the name — has only
   *  ever held the late-arrival peso deduction, now also folding in PayrollPolicy.
   *  count_lunch_late_as_late's lunch-return lateness when that's on; see hr.routes.ts
   *  generate-payslips). */
  days_absent: number;
  /** Count of days credited as a half day — a linked Half Day request, OR an "undocumented
   *  half day" (no linked form, but the raw times match one of the shift's own AM/PM half
   *  windows — see unlinkedHalfDaySession). Already folded into days_worked at 0.5 each; this
   *  surfaces the count itself so the payslip can show "Half Days: 2" instead of it only being
   *  visible as a fractional days_worked total. */
  days_half: number;
  /** Count of "Undertime Days" — present, but under PayrollPolicy.whole_day_min_minutes, with
   *  no linked Half Day request — see undertime_day_pay for the pay these earn. Contributes 0
   *  to days_worked (that's the whole point: days_worked only counts whole days actually
   *  worked, not merely "present at all" — see whole_day_min_minutes). Always 0 when the
   *  policy's check is off (whole_day_min_minutes: 0). */
  days_undertime: number;
  late_deduction: number;
  ot_hours: number;
  overtime_pay: number;
  undertime_pay: number; // negative — matches the existing "Undertime" earnings-line convention
  /** Proportional pay for Undertime Days (days_undertime above) — hourly rate x actual net
   *  minutes present, rounded down to hours_basis_unit. Positive, its own earnings line (not
   *  folded into basic_salary, which stays daily_rate x days_worked exactly as always) — unlike
   *  undertime_pay above, this isn't a deduction FROM a flat day, it's the day's entire pay. */
  undertime_day_pay: number;
  /** Night shift differential — DOLE Labor Code Art. 86: not less than 10% of the regular wage
   *  for each hour actually worked between night_start and night_end (default 22:00-06:00),
   *  additive on top of OT/holiday/rest-day premiums. Covers the ENTIRE clocked span (regular
   *  hours AND any OT together, computed once per day) when night_diff_enabled — before this
   *  field existed, night diff was only ever computed for the OT portion of a day, so a
   *  straight night-shift worker with no OT got none at all despite the law requiring it for
   *  every night hour worked, not just OT ones. */
  night_diff_pay: number;
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
  // fired, or 'worked'/'half_day'/'undertime' for a day with time logged — not a new
  // aggregate-level distinction, just makes an already-computed decision visible per day
  // instead of only summed.
  status: 'worked' | 'half_day' | 'undertime' | 'paid_leave' | 'paid_no_work' | 'paid_holiday'
    | 'unpaid_no_work' | 'rest_day_off' | 'absent'
    | 'below_minimum_denied' // HR clicked "Deny" on a day under PayrollPolicy.min_work_minutes — 0 credit, not an absence
    | 'holiday_ineligible'; // an otherwise-unworked Regular Holiday, but policy.holiday_adjacency_requirement failed — 0 credit, not an absence either (the employee just isn't entitled to this specific day's holiday pay)
  late_minutes: number;
  late_pay: number;
  ot_hours: number;
  ot_pay: number;
  // Minutes charged as undertime (left before the expected end, lunch excluded, after rounding)
  // — the minutes behind undertime_pay. 0 when nothing was charged, including a day covered by
  // a with_pay=Yes Undertime Request.
  undertime_minutes: number;
  undertime_pay: number;
  undertime_day_pay: number; // this day's proportional pay, only nonzero when status === 'undertime'
  night_diff_pay: number;
  day_premium_pay: number; // whichever of holiday_pay/special_holiday_30/rest_day_ot this day contributed
  // Whether this day's actual worked minutes fell under PayrollPolicy.min_work_minutes —
  // informational, independent of whether it was ultimately allowed or denied (status above),
  // so the Daily Time grid / detail view can flag it either way. Always false when the policy's
  // check is off (min_work_minutes: 0) or no shift is assigned (nothing to measure against).
  below_minimum: boolean;
  // Whether this day's raw times resemble a half day (see unlinkedHalfDaySession) with no form
  // linked at all — always false for a day linked to any form (Half Day, Undertime, OT, leave,
  // offset…: HR already documented the day), manually overridden (see half_day_manual below),
  // or with no shift assigned. Still set even when the
  // day was auto-paid as a half day off this signal (an "undocumented half day": no linked form
  // at all — status is then 'half_day' too), so HR is still nudged to file the actual request
  // for the record.
  possible_half_day: boolean;
  // Whether this day's half-day credit (status 'half_day') came from HR's manual override
  // (AttendanceDay.halfDayOverride) rather than a linked Half Day request or the automatic
  // possible_half_day heuristic — so the payslip detail / Daily Time grid can label it
  // distinctly ("recorded, no request") instead of looking identical to either of those. Always
  // false when status isn't 'half_day', and false whenever a real halfday_request is linked
  // (that always wins over the override — see halfDayOverrideSession below).
  half_day_manual: boolean;
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

/** Round `minutes` UP to the nearest `unitMinutes` block — for late arrivals and undertime: any
    partial block past grace still counts as a full block against the employee. 0 or negative
    stays 0. */
function roundUpToUnit(minutes: number, unitMinutes: number): number {
  if (minutes <= 0) return 0;
  return Math.ceil(minutes / unitMinutes) * unitMinutes;
}

/** Round `minutes` DOWN to the nearest `unitMinutes` block — for OT specifically: only a fully
    completed block is credited (2h12m of raw OT on an hour block credits 2 hours, not 3) — the
    opposite direction from late/undertime's roundUpToUnit, since crediting a partial block in
    the employee's favor would let a handful of minutes of ordinary lateness masquerade as a
    full paid OT hour. 0 or negative stays 0. */
function roundDownToUnit(minutes: number, unitMinutes: number): number {
  if (minutes <= 0) return 0;
  return Math.floor(minutes / unitMinutes) * unitMinutes;
}

/** OT minutes credited for `rawMinutes` worked past the shift end (or before its start, for
    early OT), before any daily cap: nothing until policy.ot_min_minutes is reached, then whole
    policy.ot_unit steps from there (rounded down). Short of the next step — the minimum, or the
    next whole block — by no more than policy.ot_grace_minutes counts as reaching it, one step at
    most. Examples on a 17:00 end: hour steps + 5 min grace, out 17:56 → 60; a 60-min minimum
    + 30-min steps, out 18:30 → 90 and out 17:30 → 0. Grace never adds minutes in per-minute
    steps past the minimum (there is no step to reach). Both settings absent/0 = the plain
    round-down to ot_unit this always did. */
export function otCreditMinutes(rawMinutes: number, policy: PayrollPolicy): number {
  if (rawMinutes <= 0) return 0;
  const unit = unitMinutesFor(policy.ot_unit);
  const minimum = Math.max(0, policy.ot_min_minutes ?? 0);
  const grace = Math.max(0, policy.ot_grace_minutes ?? 0);
  const credited = rawMinutes < minimum ? 0 : minimum + roundDownToUnit(rawMinutes - minimum, unit);
  if (grace === 0 || (unit === 1 && rawMinutes >= minimum)) return credited;
  const next = rawMinutes < minimum ? minimum : credited + unit;
  return rawMinutes + grace >= next ? next : credited;
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

/** Plain overlap (in minutes) between two spans on the same continuous (already shift-relative)
    timeline — unlike nightOverlapMinutes this doesn't wrap, both spans are already normalized. */
function overlapMinutes(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

/** The shift's own structural lunch gap — the unpaid break assumed to sit in the middle of the
    shift's span, splitting it into two equal halves (before subtracting `lunchMinutes` itself).
    E.g. an 08:00-17:00 shift (540 min span) with a 60-min lunch splits into a 240-min (4h) AM
    half, a 60-min lunch, and a 240-min (4h) PM half — lunch sits at 12:00-13:00. Both
    computeAttendanceForEmployee's per-hours-basis pay and halfDayWindow below derive from this
    same gap, so a half-day's own boundary and the lunch subtracted from a per-hour day can never
    disagree on where lunch actually falls. `shiftStart`/`shiftEnd` are already on the same
    continuous (possibly >1440, overnight-normalized) timeline the caller resolved. */
function lunchWindow(shiftStart: number, shiftEnd: number, lunchMinutes: number): { start: number; end: number } {
  const workSpan = Math.max(0, shiftEnd - shiftStart - lunchMinutes);
  const half = workSpan / 2;
  return { start: shiftStart + half, end: shiftStart + half + lunchMinutes };
}

/** A time-out that lands before the time-in on the same timeline is the next morning — whatever
    the shift. Overnight SHIFTS are already put on one timeline by their own relTo; this covers a
    day-shift employee who stayed past midnight (e.g. a driver: 08:00 in, 06:00 out next day),
    who would otherwise read as leaving 11 hours early. */
function nextDayIfBefore(timeOutRel: number, timeInRel: number): number {
  return timeOutRel < timeInRel ? timeOutRel + DAY_MIN : timeOutRel;
}

/** Early OT — time before the shift start — needs a time-in at least this far ahead of it
    (mirrored by the Daily Time grid's Overtime form, which only offers the Early OT tick then). */
export const EARLY_OT_MIN_MINUTES = 60;

/** The Overtime form's Early OT tick: true from the desktop checkbox, 'Yes' from the phone. */
function earlyOtTicked(v: unknown): boolean {
  return v === true || v === 'Yes' || v === 'true' || v === 1 || v === '1';
}

/** Raw minutes actually present on a day, lunch excluded when applicable — for
    PayrollPolicy.special_holiday_premium_mode: 'prorated', which needs this BEFORE the main
    per-day timeline below (shiftStart/shiftEnd/overnight normalization, effShiftStart, etc.) is
    computed — holiday premiums must still apply with no shift assigned at all (see the comment
    on the holiday/rest-day premium block), so this can't reuse those later variables. Falls back
    to the plain clocked span (no lunch subtracted, since there's no shift to place a lunch
    window against) when there's no usable shift. `timeIn`/`timeOut` are plain minutes-since-
    midnight (toMinutes of the raw HH:MM), not yet relative to any shift. */
function rawPresentMinutes(
  timeIn: number, timeOut: number, shift: AttendanceDay['shift'], lunchBreakMinutes: number, countLunchAsWorked: boolean
): number {
  const plainSpan = Math.max(0, timeOut >= timeIn ? timeOut - timeIn : (DAY_MIN - timeIn) + timeOut);
  const sStart = shift ? toMinutes(shift.start_time) : null;
  const sEnd0 = shift ? toMinutes(shift.end_time) : null;
  if (sStart == null || sEnd0 == null) return plainSpan;
  const overnight = sEnd0 < sStart;
  const sEnd = overnight ? sEnd0 + DAY_MIN : sEnd0;
  const relTo = (min: number) => (overnight && min < sStart ? min + DAY_MIN : min);
  const tInRel = relTo(timeIn);
  const tOutRel = nextDayIfBefore(relTo(timeOut), tInRel);
  const raw = Math.max(0, tOutRel - tInRel);
  const lunch = lunchWindow(sStart, sEnd, lunchBreakMinutes);
  const lunchOverlap = countLunchAsWorked ? 0 : overlapMinutes(tInRel, tOutRel, lunch.start, lunch.end);
  return Math.max(0, raw - lunchOverlap);
}

/** A linked Half Day request's own effective start/end — AM runs shift-start to the lunch gap,
    PM runs from the end of the lunch gap to shift-end (see lunchWindow) — e.g. 08:00-12:00 or
    13:00-17:00 for the same 08:00-17:00/60-min-lunch shift above, matching a plain "half of an
    8-hour day" expectation exactly. Unrecognized/missing session defaults to AM (the more
    common case, and the safer of the two — misjudging an actual PM half-day as AM would flag it
    "late" instead of silently accepting it as on-time, so it fails toward visibility not
    silence). */
function halfDayWindow(
  shiftStart: number, shiftEnd: number, lunchMinutes: number, session: string | undefined
): { start: number; end: number } {
  const lunch = lunchWindow(shiftStart, shiftEnd, lunchMinutes);
  if (session === 'Afternoon (PM)') return { start: lunch.end, end: shiftEnd };
  return { start: shiftStart, end: lunch.start };
}

/** The inferred half-day session ('Morning (AM)' when the day ends near the lunch gap,
    'Afternoon (PM)' when it starts after it — see halfDayWindow) if this day's raw clock times
    resemble one of the shift's own AM/PM half-day windows even though no Half Day request is
    linked, else null. A real, live bug found this way: HR types the raw times straight into the
    Daily Time grid without also filing+linking a Half Day request, so the day would otherwise be
    judged as a full day arriving hours "late" (or leaving hours "early") against the WHOLE shift
    instead of correctly being a half day, docking real pesos in late/undertime deductions that a
    linked Half Day request would have avoided entirely.
    A non-null result now also drives pay (see the fixed-basis branch: 0.5 credit, half-window
    late/undertime judgement — same as a linked Half Day request) — reversing the original
    "flag only, never touch pay" call: per the customer, a suspected half day should be *paid*
    as a half day, not as a whole day it plainly wasn't, with DayBreakdown.possible_half_day
    still set so HR knows to file the actual request for the record.
    Afternoon (per the customer, 2026-10-03): a first time-in at or after the lunch gap's start
    — the whole morning was missed — however late in the afternoon and however long they then
    stayed (time past the shift end is OT's concern, not this). No tolerance before lunch: 11:59
    on an 08:00 shift is a late whole day, 12:01 a PM half day (on time — the PM half starts at
    the end of the lunch gap; 13:30 is a PM half day 30 minutes late). Needs no time-out, so the
    live Daily Report can call it the moment someone arrives.
    Morning: left near the lunch gap (`tolerance`, 60 min either side, allows for leaving a bit
    early or late) having worked under 3/4 of the day. */
function unlinkedHalfDaySession(
  shiftStart: number, shiftEnd: number, lunchMinutes: number, timeInRel: number, timeOutRel: number | null
): HalfDaySession | null {
  const lunch = lunchWindow(shiftStart, shiftEnd, lunchMinutes);
  if (timeInRel >= lunch.start && timeInRel < shiftEnd) return 'Afternoon (PM)';
  if (timeOutRel == null) return null;
  const workSpan = Math.max(0, shiftEnd - shiftStart - lunchMinutes);
  const rawMinutes = Math.max(0, timeOutRel - timeInRel);
  if (rawMinutes <= 0 || rawMinutes >= workSpan * 0.75) return null; // most of a full day -> not a half day
  const tolerance = HALF_DAY_TOLERANCE_MIN;
  return timeOutRel >= lunch.start - tolerance && timeOutRel <= lunch.end + tolerance ? 'Morning (AM)' : null;
}

export type HalfDaySession = 'Morning (AM)' | 'Afternoon (PM)';
const HALF_DAY_TOLERANCE_MIN = 60;

/** A shift on one continuous timeline (an overnight end pushed past 24:00) plus the mapper that
    puts a raw "HH:MM" reading on it — the same normalization computeAttendanceForEmployee does
    inline. null when the shift is missing or unparseable. */
function shiftTimeline(shift: AttendanceDay['shift']) {
  const start = shift ? toMinutes(shift.start_time) : null;
  const end0 = shift ? toMinutes(shift.end_time) : null;
  if (start == null || end0 == null) return null;
  const overnight = end0 < start;
  const rel = (hm: string | null | undefined): number | null => {
    const m = toMinutes(hm);
    return m == null ? null : overnight && m < start ? m + DAY_MIN : m;
  };
  return { start, end: overnight ? end0 + DAY_MIN : end0, rel };
}

/* "HH:MM" wrappers over the half-day rules above, for the HR Daily Report (src/modules/hr/
   hr-daily-report.ts) — so the board and payroll call the same day a half day, with the same
   session and the same lateness, instead of keeping a second copy of the rule. */

/** The auto-detected half-day session for these raw times (see unlinkedHalfDaySession), or null.
    `timeOut` may be null (still clocked in) — only an afternoon half day is detectable then. */
export function detectHalfDaySession(
  shift: AttendanceDay['shift'], lunchMinutes: number, timeIn: string, timeOut: string | null
): HalfDaySession | null {
  const tl = shiftTimeline(shift);
  const inRel = tl?.rel(timeIn);
  if (!tl || inRel == null) return null;
  return unlinkedHalfDaySession(tl.start, tl.end, lunchMinutes, inRel, tl.rel(timeOut));
}

/** The half window's own start ("HH:MM", wall clock) and the raw minutes `timeIn` (if given)
    arrived after it — negative = early. Grace is the caller's to apply, as payroll does. */
export function halfDayArrival(
  shift: AttendanceDay['shift'], lunchMinutes: number, session: string | undefined, timeIn: string | null
): { start: string; late_raw: number | null } | null {
  const tl = shiftTimeline(shift);
  if (!tl) return null;
  const win = halfDayWindow(tl.start, tl.end, lunchMinutes, session);
  const wall = Math.round(win.start) % DAY_MIN;
  const start = `${String(Math.floor(wall / 60)).padStart(2, '0')}:${String(wall % 60).padStart(2, '0')}`;
  const inRel = tl.rel(timeIn);
  return { start, late_raw: inRel == null ? null : inRel - win.start };
}

/** Whether `now` ("HH:MM") is past the latest time a lunch-out can still be a normal lunch —
    the lunch gap's end plus the same tolerance the morning half-day pattern allows. Before
    then, a lunch-out with no return yet is just someone at lunch, not someone who left. */
export function pastLunchReturn(shift: AttendanceDay['shift'], lunchMinutes: number, now: string): boolean {
  const tl = shiftTimeline(shift);
  const nowRel = tl?.rel(now);
  if (!tl || nowRel == null) return false;
  return nowRel > lunchWindow(tl.start, tl.end, lunchMinutes).end + HALF_DAY_TOLERANCE_MIN;
}

const ZERO: AttendanceComputation = {
  days_worked: 0, days_absent: 0, days_half: 0, days_undertime: 0, late_deduction: 0, ot_hours: 0,
  overtime_pay: 0, undertime_pay: 0, undertime_day_pay: 0, night_diff_pay: 0,
  holiday_pay: 0, special_holiday_30: 0, rest_day_ot: 0, days: [],
};

/** Night-window overlap (minutes) for a span starting at `startRel` (on the same continuous —
    possibly >1440, overnight-normalized — timeline the caller resolved) and lasting
    `durationMin` minutes. Reduces to wall-clock via a single mod at the start, then adds the
    raw duration un-modded — nightOverlapMinutes checks both the window's "today" and "tomorrow"
    instance, so this stays correct even when startRel + durationMin lands past 1440. */
function nightMinutesRel(startRel: number, durationMin: number, nightStart: number, nightEnd: number): number {
  if (durationMin <= 0) return 0;
  const wallStart = startRel % DAY_MIN;
  return nightOverlapMinutes(wallStart, wallStart + durationMin, nightStart, nightEnd);
}

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
  policy: PayrollPolicy,
  // Per-employee "exempt from late deductions" (employees.late_exempt — e.g. the company
  // president, or anyone else whose actual clock-in time HR doesn't want penalized). Deliberately
  // a plain parameter, not folded into `policy`, since policy is one shared object for every
  // employee in a generate-payslips run while this varies per employee. late_minutes still
  // reports the real lateness either way — this only zeroes the peso deduction, so HR can still
  // see the pattern without it costing the employee anything.
  exemptLate = false,
  // Per-employee "exempt from overtime pay" (employees.ot_exempt) — same shape/reasoning as
  // exemptLate above, for salaried staff never entitled to OT regardless of hours worked past
  // their shift. ot_hours still reports the real time worked either way; only overtime_pay is
  // zeroed, in both hours_basis modes.
  exemptOt = false,
  // Per-employee "always a whole day" (employees.always_whole_day): a day with both a real
  // time-in and time-out pays the full daily basic whatever the times — no half day (guessed,
  // HR-marked or filed), late, undertime, Undertime Day, per-hour proration or below-minimum
  // denial. OT, night differential and holiday/rest-day premiums still follow the normal
  // rules, and so does a day missing either punch.
  alwaysWholeDay = false
): AttendanceComputation {
  const hourlyRate = dailyRate / 8;
  // Not { ...ZERO } for `days` specifically — a shallow spread would copy ZERO's own array
  // *reference*, so every call would push into (and pollute) the exact same shared array.
  const out: AttendanceComputation = { ...ZERO, days: [] };
  const nightStart = toMinutes(policy.night_start) ?? 0;
  const nightEnd = toMinutes(policy.night_end) ?? 0;

  for (const day of days) {
    // A day can link more than one HR request form now (linkedForms). The legacy single
    // linkedForm is normalised in as a one-element list, so every existing caller/test that
    // still passes linkedForm keeps working unchanged. Each concern below checks for the form
    // it cares about independently rather than switching on one "primary" slug — so a Half Day
    // AM + an Overtime for the afternoon both take effect on the same day.
    const forms = day.linkedForms && day.linkedForms.length
      ? day.linkedForms
      : day.linkedForm ? [day.linkedForm] : [];
    const hasForm = (s: string) => forms.some((f) => f.slug === s);
    const formData = (s: string): Record<string, unknown> | undefined => forms.find((f) => f.slug === s)?.data;
    // Whether this day's rest-day status earns its premium (the +30%, and the rest-day part of a
    // holiday-on-rest-day or OT multiplier). policy.require_rest_day_form on: only with a linked
    // Rest Day Work Request (the caller passes rest-day forms only once approved); otherwise a
    // worked rest day pays like an ordinary working day. Off (default): automatic, as before.
    // An UNWORKED rest day is still just a day off either way — see day.isRestDay below.
    const restDayPremium = !!day.isRestDay && (!policy.require_rest_day_form || hasForm('rest_day_work_request'));
    // A linked Overtime Request can carry an explicit approved_hours — set by whoever approved
    // it, e.g. "policy caps OT at 2h/day, but the boss okayed 4h today" — which RAISES
    // policy.max_ot_hours for THIS day only (never lowers it, and never introduces a cap where
    // policy has none — a blank/0/non-numeric value, or no policy cap to begin with, just falls
    // back to the policy's own behavior, same as before this field existed).
    const approvedOtHours = Number(formData('overtime_request')?.approved_hours);
    const dayMaxOtMin = policy.max_ot_hours == null ? null
      : Math.max(policy.max_ot_hours * 60, approvedOtHours > 0 ? approvedOtHours * 60 : 0);
    const timeIn = toMinutes(day.time_in);
    const rawTimeOut = toMinutes(day.time_out);
    const lunchOutMin = toMinutes(day.lunch_out ?? null);
    const lunchInMin = toMinutes(day.lunch_in ?? null);
    // Timed out for lunch and never punched again (no lunch_in, no time_out) — treated as if the
    // lunch-out punch were this day's effective time-out, so it flows through the existing
    // unlinked-half-day detection below (unlinkedHalfDaySession) instead of falling to a flat
    // absence for the whole day. Per the customer: someone who worked the morning and vanished
    // after lunch should be auto-credited a half day (or, if the times don't happen to resemble
    // one of the shift's own AM/PM windows, at least an Undertime Day paid for the actual
    // minutes present) — either beats being zeroed out entirely as a no-show.
    const abandonedAfterLunch = rawTimeOut == null && lunchOutMin != null && lunchInMin == null;
    const timeOut = abandonedAfterLunch ? lunchOutMin : rawTimeOut;
    const wholeDay = alwaysWholeDay && timeIn != null && rawTimeOut != null;
    // Per-day mirror of whatever the aggregate below adds — pushed to out.days at every exit
    // point of this iteration (there are several `continue`s), so it always reflects exactly
    // what happened to this specific day, never a separately-derived guess.
    let lateMin = 0, latePay = 0, otHours = 0, otPay = 0, undertimePay = 0, dayPremium = 0;
    let undertimeDayPay = 0, nightDiffPay = 0, undertimeMin = 0;
    let status: DayBreakdown['status'] = 'worked';
    let belowMin = false;
    let possibleHalfDay = false;
    let halfDayManual = false;
    let unlinkedHalfSession: HalfDaySession | null = null;
    // HR's manual "credit this as a half day anyway" call — ignored whenever a real
    // halfday_request is linked (that always wins), same gate undocumentedHalfDay uses below.
    const halfDayOverrideSession: 'Morning (AM)' | 'Afternoon (PM)' | null =
      !wholeDay && !hasForm('halfday_request') && (day.halfDayOverride === 'am' || day.halfDayOverride === 'pm')
        ? (day.halfDayOverride === 'pm' ? 'Afternoon (PM)' : 'Morning (AM)')
        : null;
    const pushDay = () => out.days.push({
      work_date: day.work_date, time_in: day.time_in, time_out: day.time_out,
      holiday: day.holiday ?? null, no_work: day.noWork ?? null, is_rest_day: !!day.isRestDay,
      status, late_minutes: lateMin, late_pay: latePay, ot_hours: otHours, ot_pay: otPay,
      undertime_minutes: undertimeMin, undertime_pay: undertimePay, undertime_day_pay: undertimeDayPay,
      night_diff_pay: nightDiffPay, day_premium_pay: dayPremium, below_minimum: belowMin, possible_half_day: possibleHalfDay,
      half_day_manual: halfDayManual,
    });

    if (halfDayOverrideSession && (timeIn == null || timeOut == null)) {
      // HR manually marked this day a half day even though the punch data doesn't resolve into
      // a normal in/out pair (e.g. one side is missing entirely, with nothing to substitute the
      // way abandonedAfterLunch does for a missing time_out) — not enough real time data to
      // judge late/OT/undertime against the half window, so it's credited flatly at 0.5 day with
      // none of those computed. half_day_manual distinguishes it on the payslip/grid from an
      // actual linked request or the auto-detected possible_half_day kind.
      out.days_worked += 0.5;
      out.days_half += 1;
      status = 'half_day';
      halfDayManual = true;
      pushDay();
      continue;
    }

    if (timeIn == null || timeOut == null) {
      // No usable time logged. In order of precedence: a linked, paid Leave form makes it a
      // full paid day; otherwise an unworked Regular Holiday is *always* paid by law (Labor
      // Code Art. 94) — 100%, same as a paid Leave day; simplified vs. DOLE's stricter
      // "present/on paid leave the day immediately before" eligibility check, which this
      // per-day loop doesn't look back for. Unlike a paid Leave/No Work/cancellation day, its
      // 100% is booked straight into holiday_pay instead of days_worked/basic_salary — keeping
      // it OUT of "Days Worked" so that field only ever counts days the employee was actually
      // present or on ordinary paid leave, and the payslip's Holiday Pay line shows this day's
      // money instead of it being silently absorbed into Basic Salary where it reads as an
      // extra day worked. Checked BEFORE the No Work Memo below (even though a memo can
      // independently cover the same date, e.g. "Suspension, Holiday" declared for a Regular
      // Holiday the office is closed for) — the statutory Holiday Pay entitlement takes
      // precedence over a discretionary company no-work declaration landing on the same day,
      // not the other way around; a memo can't downgrade a Regular Holiday to an ordinary paid
      // no-work day (or, if marked unpaid, strip the pay the law requires).
      // A company-wide "No Work Memo" covering this date (management declared no work — a
      // typhoon suspension, equipment failure, health break, etc.) is automatically *not* an
      // absence either way, paid or not: it was management's call, not the employee's, so it's
      // never the employee's fault or choice the way an unexplained no-show is. Paid credits a
      // full day (days_worked); unpaid contributes no pay but is still explicitly its own
      // status ('unpaid_no_work') — distinct from a genuine absence, which is reserved for a day
      // nothing here explains at all. An unworked Special Non-Working (or Special Working)
      // holiday with no memo covering it is plain "no work, no pay" and — unlike a memo day —
      // *does* fall to the genuine-absence bucket below, since it has no company declaration or
      // statutory entitlement backing it the way Regular Holiday or a No Work Memo day does. A
      // per-record "Work Cancellation" (equipment failure, sent home early, etc. — not a real
      // holiday) is the same idea as a No Work Memo at per-employee granularity instead of
      // company-wide: paid credits a full day, unpaid gets the same non-absence
      // 'unpaid_no_work' treatment.
      // An unworked rest day is neither paid nor an absence — it was never a scheduled workday
      // to begin with, so it contributes to neither days_worked nor days_absent — but only when
      // nothing else already explains the day; an explicit no-work/cancellation marking (paid or
      // unpaid) still shows its own distinct status even on a rest day, since that's a more
      // specific, deliberately-recorded classification, not silence.
      // Otherwise — nothing here explains the day at all — it's a genuine unpaid absence.
      if (hasForm('leave_request') && formData('leave_request')?.with_pay === 'Yes') {
        out.days_worked += 1;
        status = 'paid_leave';
      } else if (day.holiday === 'regular') {
        // policy.holiday_adjacency_requirement: withheld entirely (not reduced) when the
        // employee failed the required adjacent-day check — see AttendanceDay.holidayEligible.
        if (day.holidayEligible !== false) {
          out.holiday_pay += dailyRate;
          dayPremium = dailyRate;
          status = 'paid_holiday';
        } else {
          status = 'holiday_ineligible';
        }
      } else if (day.noWork === 'paid' || day.holiday === 'cancelled_paid') {
        out.days_worked += 1;
        status = day.holiday === 'cancelled_paid' ? 'paid_holiday' : 'paid_no_work';
      } else if (day.noWork === 'unpaid' || day.holiday === 'cancelled_unpaid') {
        // Company-declared no-work, unpaid — excused and documented, just not on the clock.
        // Contributes to neither days_worked nor days_absent; distinct from rest_day_off below
        // so a reader can tell "explicitly excused" apart from "wasn't scheduled at all".
        status = 'unpaid_no_work';
      } else if (day.isRestDay && !day.holiday) {
        status = 'rest_day_off';
      } else {
        out.days_absent += 1;
        status = 'absent';
      }
      pushDay();
      continue;
    }

    // Holiday/rest-day premiums first, before the shift-required guard below — unlike late/OT/
    // undertime (which need a shift's start/end time to judge against), these depend only on
    // the day's own type, not on a shift being assigned at all. Was previously stuck after that
    // guard, so a worked day with no shift set silently got 0 holiday/rest-day pay regardless of
    // day.holiday/isRestDay — a real bug, not a "no shift, nothing to compute" case like late is.
    if (hasForm('holiday_work_request')) {
      const hours = Number(formData('holiday_work_request')?.hours_worked) || 0;
      const isRegular = formData('holiday_work_request')?.holiday_type === 'Regular Holiday';
      // policy.holiday_adjacency_requirement applies here too — same withhold-entirely rule as
      // the unworked-Regular-Holiday branch above.
      if (day.holidayEligible !== false) {
        // PH convention: the linked form's hours already earned basic pay via days_worked/basic_
        // salary above — this is just the *additional* premium on top (100% for Regular Holiday,
        // 30% for Special Non-Working — the latter is why the field is literally named "...30").
        // Regular Holiday's premium is always the full statutory rate per hour reported, never
        // prorated by policy.special_holiday_premium_mode (that setting is Special-Holiday-only)
        // — but Special Non-Working's is capped at 8 hours' worth either way: 'flat' pays the
        // full 30% as long as ANY hours were reported (matches the direct-marking branch's flat
        // mode below), 'prorated' scales with the reported hours, capped at 8.
        let premium: number;
        if (isRegular) {
          premium = hours * hourlyRate * 1.0;
          out.holiday_pay += premium;
        } else {
          const effHours = policy.special_holiday_premium_mode === 'prorated' ? Math.min(hours, 8) : (hours > 0 ? 8 : 0);
          premium = effHours * hourlyRate * 0.3;
          out.special_holiday_30 += premium;
        }
        dayPremium = premium;
      }
    } else if (day.holiday === 'regular' || day.holiday === 'special_non_working' || restDayPremium) {
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
      const premiumPct = dayRateMultiplier(day.holiday, restDayPremium) - 1.0;
      // policy.holiday_adjacency_requirement gates both holiday branches below (never the plain
      // rest-day branch — a rest day isn't a holiday, so it's not subject to this at all).
      const eligible = day.holidayEligible !== false;
      if (day.holiday === 'regular') {
        if (eligible) {
          out.holiday_pay += dailyRate * premiumPct;
          dayPremium = dailyRate * premiumPct;
        }
      } else if (day.holiday === 'special_non_working') {
        if (eligible) {
          // policy.special_holiday_premium_mode: 'flat' (default) keeps the pre-2026-09 behavior
          // — the full premiumPct of the whole day's rate regardless of hours actually present.
          // 'prorated' scales it by actual hours present that day (lunch excluded), capped at 8
          // hours' worth — a half-day worked on a special holiday earns roughly half the premium
          // a full day would, instead of the same full amount either way.
          const premium = policy.special_holiday_premium_mode === 'prorated'
            ? Math.min(rawPresentMinutes(timeIn, timeOut, day.shift, policy.lunch_break_minutes, policy.count_lunch_as_worked) / 60, 8) * hourlyRate * premiumPct
            : dailyRate * premiumPct;
          out.special_holiday_30 += premium;
          dayPremium = premium;
        }
      } else if (restDayPremium) {
        out.rest_day_ot += dailyRate * premiumPct;
        dayPremium = dailyRate * premiumPct;
      }
    }

    // No shift assigned, or the assigned shift has unparseable times: nothing to judge late/OT/
    // undertime/minimum-hours/per-hours-basis against — flat credit only, same as fixed-basis
    // mode always used (a per-hours-basis day needs a shift to know how many hours it SHOULD
    // have been, so this is also its fallback).
    const shiftStart = day.shift ? toMinutes(day.shift.start_time) : null;
    let shiftEnd = day.shift ? toMinutes(day.shift.end_time) : null;
    if (shiftStart == null || shiftEnd == null) {
      if (!wholeDay && (hasForm('halfday_request') || halfDayOverrideSession)) {
        out.days_worked += 0.5;
        out.days_half += 1;
        status = 'half_day';
        halfDayManual = !hasForm('halfday_request');
      } else {
        out.days_worked += 1;
      }
      pushDay(); continue;
    }
    const overnight = shiftEnd < shiftStart;
    if (overnight) shiftEnd += DAY_MIN; // e.g. 22:00-06:00 -> end normalized to 30:00

    // Put every clock reading on the SAME continuous timeline as shiftStart, so a shift that
    // wraps midnight doesn't break the arithmetic below — a raw reading earlier than shiftStart
    // is treated as having happened after midnight, i.e. "later" on this timeline, not earlier.
    const relTo = (min: number) => (overnight && min < shiftStart ? min + DAY_MIN : min);
    const timeInRel = relTo(timeIn);
    const timeOutRel = nextDayIfBefore(relTo(timeOut), timeInRel);

    // Minimum allowable time for the day (policy.min_work_minutes, 0 = off): flags a short day
    // (below_minimum, surfaced per-day for the Daily Time grid's allow/deny button and the
    // payroll detail view) but never withholds pay on its own — by default a short day still
    // pays for the actual hours/fraction worked below, same as any other day. Only an explicit
    // per-record 'deny' decision (attendance_records.min_hours_decision) zeroes it entirely —
    // not an absence, just excused/undetermined, distinct from a genuine no-show.
    const rawWorkedMinutes = Math.max(0, timeOutRel - timeInRel);
    belowMin = policy.min_work_minutes > 0 && rawWorkedMinutes < policy.min_work_minutes;
    if (belowMin && day.minHoursDecision === 'deny' && !wholeDay) {
      status = 'below_minimum_denied';
      pushDay(); continue;
    }

    // --- Lunch-break lateness (PayrollPolicy.count_lunch_late_as_late, default false) ---
    // Computed once here (needs shiftStart/shiftEnd/relTo, just resolved above) and folded into
    // every branch below, right before that branch's own pushDay() — independent of hours_basis
    // mode. This is deliberately NOT self-correcting the way ordinary arrival/departure lateness
    // is under 'per_hour' mode or an Undertime Day: both of those only exclude the shift's own
    // STRUCTURAL lunch window from worked minutes (lunchOverlap below), never however long the
    // employee's OWN recorded lunch actually ran — so a long lunch would otherwise go completely
    // unpenalized even there. Skipped entirely for an abandoned-after-lunch day (lunchInMin is
    // null by definition — nothing to judge a "return" against).
    let lunchLateMin = 0, lunchLatePay = 0;
    if (!wholeDay && policy.count_lunch_late_as_late && lunchOutMin != null && lunchInMin != null) {
      const lunchOutRel = relTo(lunchOutMin);
      let lunchInRel = relTo(lunchInMin);
      if (lunchInRel < lunchOutRel) lunchInRel += DAY_MIN; // returned after midnight relative to leaving
      // A linked Lunch/Break Offset Request authorizes a shifted lunch window for this specific
      // day (its own new_lunch_out; new_lunch_in defaults to new_lunch_out + the policy's own
      // lunch duration when left blank) — judged against THAT window instead of the shift's
      // structural one, e.g. an approved 1:00-2:00 lunch (structural window still 12-1) isn't
      // itself late, even though it's an hour later than the shift's own midpoint gap.
      let expectedBackRel: number;
      if (hasForm('lunch_offset_form')) {
        const newOutRaw = toMinutes(formData('lunch_offset_form')?.new_lunch_out as string | undefined);
        const newInRaw = toMinutes(formData('lunch_offset_form')?.new_lunch_in as string | undefined);
        const approvedOutRel = newOutRaw != null ? relTo(newOutRaw) : lunchOutRel;
        expectedBackRel = newInRaw != null ? relTo(newInRaw) : approvedOutRel + policy.lunch_break_minutes;
      } else {
        expectedBackRel = lunchWindow(shiftStart, shiftEnd, policy.lunch_break_minutes).end;
      }
      const lunchLateRaw = lunchInRel - expectedBackRel;
      if (lunchLateRaw > policy.grace_minutes) {
        lunchLateMin = roundUpToUnit(lunchLateRaw, unitMinutesFor(policy.late_unit));
        lunchLatePay = exemptLate ? 0 : (lunchLateMin / 60) * hourlyRate;
      }
    }

    // See unlinkedHalfDaySession's own comment — detects a day that LOOKS like a half day by
    // its times but isn't actually linked to one, regardless of hours_basis mode. In fixed mode
    // an unlinked half day (one with NO linked form at all) is now also paid as a half day
    // below — per-hour mode already self-corrects on pay, so there it stays flag-only. A day
    // linked to ANY form (a Half Day request, or offset/OT/leave/undertime) is neither
    // reclassified nor flagged: HR already documented what the day was — e.g. an unpaid
    // Undertime Request is a whole day less the time left early, not a half day — so a "Half
    // Day (unlinked)" badge there would contradict its own pay. Skipped too when HR already
    // resolved the day via halfDayOverrideSession — they already made the call.
    if (forms.length === 0 && !halfDayOverrideSession && !wholeDay) {
      unlinkedHalfSession = unlinkedHalfDaySession(shiftStart, shiftEnd, policy.lunch_break_minutes, timeInRel, timeOutRel);
      possibleHalfDay = unlinkedHalfSession != null;
    }

    if (policy.hours_basis === 'per_hour' && !wholeDay) {
      // Basic pay prorated directly from actual worked minutes (lunch excluded unless
      // count_lunch_as_worked), rounded DOWN to hours_basis_unit — e.g. clocking 08:00-14:00 on
      // an 08:00-17:00 shift (60-min lunch) pays exactly 5 hours, not a flat full/half day
      // credit. Late arrival and leaving early are inherently self-correcting here (already
      // only paid for hours actually present), so — unlike fixed-basis mode below — this never
      // ALSO layers a separate undertime peso deduction on top of the already-reduced hours;
      // that would double-penalize the same shortfall. A linked Half Day request doesn't need
      // special handling either — someone who only worked their half naturally computes to
      // ~4 hours of pay without needing to know a form was involved.
      const lunch = lunchWindow(shiftStart, shiftEnd, policy.lunch_break_minutes);
      const lunchOverlapStart = Math.max(timeInRel, lunch.start);
      const lunchOverlapEnd = Math.min(timeOutRel, lunch.end);
      const lunchOverlap = policy.count_lunch_as_worked ? 0 : Math.max(0, lunchOverlapEnd - lunchOverlapStart);
      const workedRaw = Math.max(0, rawWorkedMinutes - lunchOverlap);
      const normalSpan = Math.max(0, (shiftEnd - shiftStart) - (policy.count_lunch_as_worked ? 0 : policy.lunch_break_minutes));

      const regularRaw = Math.min(workedRaw, normalSpan);
      const regularBlocked = roundDownToUnit(regularRaw, unitMinutesFor(policy.hours_basis_unit));
      out.days_worked += (regularBlocked / 60) / 8;

      // Still reported for reference (same grace/rounding as fixed-basis mode) even though it
      // never costs pay here — HR can see the pattern without it being double-counted against
      // an employee already paid only for the hours they were actually present.
      const lateRaw = timeInRel - shiftStart;
      if (lateRaw > policy.grace_minutes) {
        lateMin = roundUpToUnit(lateRaw, unitMinutesFor(policy.late_unit));
      }

      // Hours worked beyond the shift's own normal span — same authorization gate OT already
      // uses (require_ot_form), same OT%/holiday-scaled rate, just measured from actual worked
      // minutes instead of a fixed clock-out-vs-shift-end comparison. dayMaxOtMin (policy cap,
      // or a linked Overtime Request's own approved_hours override — see above; null = no cap)
      // caps how much of it is actually PAID — same as unauthorized OT, hours worked past the
      // cap are simply uncompensated presence, not converted into undertime.
      let otBlocked = 0;
      const otRaw = workedRaw - normalSpan;
      if (otRaw > 0 && (hasForm('overtime_request') || !policy.require_ot_form)) {
        const otBlockedRaw = roundDownToUnit(otRaw, unitMinutesFor(policy.hours_basis_unit));
        otBlocked = dayMaxOtMin != null ? Math.min(otBlockedRaw, dayMaxOtMin) : otBlockedRaw;
        if (otBlocked > 0) {
          otHours = otBlocked / 60;
          out.ot_hours += otHours;
          const dayMult = dayRateMultiplier(day.holiday, restDayPremium);
          const pay = exemptOt ? 0 : otHours * hourlyRate * dayMult * (policy.ot_rate_percent / 100);
          otPay = pay;
          out.overtime_pay += pay;
        }
      }

      // Night differential over the entire physically-present, lunch-excluded span (regular +
      // OT together, computed once — not just the OT portion, which is all this used to cover:
      // a straight night-shift worker with no OT got zero night diff despite the law requiring
      // it for every night hour worked). Capped to the minutes actually PAID (regularBlocked +
      // otBlocked) so a rounding-down tail or an OT-cap-truncated tail never earns night diff it
      // wasn't paid for.
      if (policy.night_diff_enabled) {
        const rawNightMin = nightMinutesRel(timeInRel, timeOutRel - timeInRel, nightStart, nightEnd)
          - (lunchOverlap > 0 ? nightMinutesRel(lunchOverlapStart, lunchOverlap, nightStart, nightEnd) : 0);
        const paidNightMin = Math.max(0, Math.min(rawNightMin, regularBlocked + otBlocked));
        if (paidNightMin > 0) {
          nightDiffPay = (paidNightMin / 60) * hourlyRate * (policy.night_diff_percent / 100);
          out.night_diff_pay += nightDiffPay;
        }
      }

      // Unlike ordinary arrival lateness a few lines up, lunch lateness DOES cost real pesos
      // here even in per_hour mode — see the block's own comment above for why it isn't already
      // self-correcting the way the rest of this branch's pay is.
      lateMin += lunchLateMin;
      latePay += lunchLatePay;
      out.late_deduction += lunchLatePay;

      pushDay();
      continue;
    }

    // --- fixed-basis mode (the original, unchanged-by-default behavior) ---
    // An "undocumented half day": no linked form at all, but the raw times match one of the
    // shift's own AM/PM half windows (unlinkedHalfSession, set above). Treated exactly like a
    // linked Half Day request from here on — 0.5 day credit, late/undertime judged against the
    // half window, not the full shift — so a half day HR forgot to file a request for is still
    // paid as a half day instead of a whole day it wasn't. Gated on there being NO other linked
    // form, so a day linked to an offset/OT/leave/undertime form keeps that form's handling.
    // halfDayOverrideSession (HR's manual call) takes priority over the auto-detected kind when
    // both would otherwise apply — an explicit HR decision beats a guess, even a correct one.
    const undocumentedHalfDay = forms.length === 0 && unlinkedHalfSession != null;
    const isHalfDay = !wholeDay && (hasForm('halfday_request') || undocumentedHalfDay || !!halfDayOverrideSession);
    const halfDaySession = halfDayOverrideSession
      ?? (undocumentedHalfDay
        ? unlinkedHalfSession ?? undefined
        : (formData('halfday_request')?.session as string | undefined));
    if (halfDayOverrideSession) halfDayManual = true;

    // A Half Day judges late/undertime against just its own AM/PM window (derived from the
    // shift + lunch — see halfDayWindow), not the full shift's start/end — previously a whole
    // day was compared against the full shift, so an afternoon half-day showed as hours "late"
    // and a morning half-day showed as "undertime" for correctly leaving at lunchtime.
    // The shift's unpaid lunch gap, taken before the Half Day window below narrows shiftEnd —
    // late arrival and undertime never charge minutes inside it (arriving 13:30 on an 08:00-17:00
    // shift misses 4.5 working hours, not 5.5; leaving at 11:00 misses 5, not 6).
    const unpaidLunch = policy.count_lunch_as_worked ? null : lunchWindow(shiftStart, shiftEnd, policy.lunch_break_minutes);
    const unpaidLunchIn = (from: number, to: number) => (unpaidLunch ? overlapMinutes(from, to, unpaidLunch.start, unpaidLunch.end) : 0);
    let effShiftStart = shiftStart;
    if (isHalfDay) {
      const win = halfDayWindow(shiftStart, shiftEnd, policy.lunch_break_minutes, halfDaySession);
      effShiftStart = win.start;
      shiftEnd = win.end;
    }

    // An Offset form shifts this day's expected time-out (e.g. arrived late, agreed to leave
    // later instead) — the effective end used for both the OT and undertime checks below. When
    // a New Time In is ALSO given, the whole day's window shifts (e.g. an 8-5 shift offset to
    // 10-7): the arrival below is then judged against this new start too, not the original
    // shift start, and the 5-7pm stretch stays ordinary hours (still within effectiveEnd), not
    // OT. Left blank (old behavior, and still how records filed before this field existed
    // read), only the end-of-day threshold moves — arrival is still judged against the real
    // shift start.
    let effectiveEnd = shiftEnd;
    if (hasForm('offset_form')) {
      const offsetEndRaw = toMinutes(formData('offset_form')?.new_time_out as string | undefined);
      const offsetStartRaw = toMinutes(formData('offset_form')?.new_time_in as string | undefined);
      if (offsetEndRaw != null) effectiveEnd = relTo(offsetEndRaw);
      if (offsetStartRaw != null && offsetEndRaw != null) effShiftStart = relTo(offsetStartRaw);
    }

    // A company-authorized, PAID early release (a linked Undertime Request with with_pay =
    // 'Yes') — full day's pay regardless of hours actually present, no make-up owed. Hoisted up
    // here so it also exempts the day from the whole-day/Undertime-Day hours classification
    // right below, not just the peso undertime deduction further down — the whole point of
    // with_pay=Yes is that it's treated as if the day had been worked in full.
    const authorizedPaid = hasForm('undertime_request') && formData('undertime_request')?.with_pay === 'Yes';

    // Whole day vs. "Undertime Day" (policy.whole_day_min_minutes, e.g. 420 = 7 hours —
    // deliberately a bit under a full 8-hour shift so up to an hour late still reads as a whole
    // day; 0 disables this check entirely). A Half Day request is always its own fixed 0.5,
    // never judged by this; a with_pay=Yes Undertime Request is always a full day, also never
    // judged by this. Everything else is classified by actual NET minutes present (lunch
    // excluded, same rule per-hours-basis pay already uses, against the original shift's own
    // lunch window — shiftStart/shiftEnd haven't been touched by the Half Day branch above since
    // we're in the !isHalfDay case here) — below the threshold, this is no longer "the number of
    // days present" inflating days_worked, it's its own Undertime Day: 0 credit toward
    // days_worked, paid proportionally for the hours actually present instead of the flat daily
    // rate (self-correcting, same reasoning as hours_basis: 'per_hour' above — no separate late/
    // undertime peso deduction layered on top of pay already reduced to match).
    if (!isHalfDay && !authorizedPaid && !wholeDay && policy.whole_day_min_minutes > 0) {
      const lunch = lunchWindow(shiftStart, shiftEnd, policy.lunch_break_minutes);
      const lunchOverlap = policy.count_lunch_as_worked ? 0 : overlapMinutes(timeInRel, timeOutRel, lunch.start, lunch.end);
      const netWorkedMinutes = Math.max(0, rawWorkedMinutes - lunchOverlap);
      if (netWorkedMinutes < policy.whole_day_min_minutes) {
        status = 'undertime';
        out.days_undertime += 1;
        const paidMinutes = roundDownToUnit(netWorkedMinutes, unitMinutesFor(policy.hours_basis_unit));
        undertimeDayPay = (paidMinutes / 60) * hourlyRate;
        out.undertime_day_pay += undertimeDayPay;
        // Still reported for reference, same as hours_basis: 'per_hour' — informational only,
        // doesn't cost pay here since pay is already reduced to match actual hours present.
        const lateRaw = timeInRel - effShiftStart;
        if (lateRaw > policy.grace_minutes) {
          lateMin = roundUpToUnit(lateRaw, unitMinutesFor(policy.late_unit));
        }
        if (policy.night_diff_enabled) {
          const nightMin = nightMinutesRel(timeInRel, timeOutRel - timeInRel, nightStart, nightEnd)
            - (lunchOverlap > 0 ? nightMinutesRel(Math.max(timeInRel, lunch.start), lunchOverlap, nightStart, nightEnd) : 0);
          const paidNightMin = Math.max(0, Math.min(nightMin, paidMinutes));
          if (paidNightMin > 0) {
            nightDiffPay = (paidNightMin / 60) * hourlyRate * (policy.night_diff_percent / 100);
            out.night_diff_pay += nightDiffPay;
          }
        }
        // Unlike this branch's own arrival lateness a few lines up, lunch lateness DOES cost
        // real pesos here — same reasoning as the per_hour branch's own fold-in: an Undertime
        // Day's pay is only reduced by the shift's STRUCTURAL lunch window, never however long
        // the actual recorded lunch ran, so it isn't otherwise reflected at all.
        lateMin += lunchLateMin;
        latePay += lunchLatePay;
        out.late_deduction += lunchLatePay;
        pushDay();
        continue;
      }
    }

    // Whole day (or Half Day, or an authorized-paid Undertime Request) — unchanged existing
    // credit + late/OT/undertime-deduction behavior.
    out.days_worked += isHalfDay ? 0.5 : 1;
    if (isHalfDay) { out.days_half += 1; status = 'half_day'; }

    // Late arrival: grace is a threshold, never a later start — within it costs nothing; past
    // it, the WHOLE lateness from the shift start counts, rounded up to late_unit (per the
    // customer, 2026-10-05: 6 min late with a 5 min grace is 6 minutes, not 1; 125 min late
    // with a 10 min grace and hour blocks is 3 hours). Lunch lateness follows the same rule.
    const lateRaw = timeInRel - effShiftStart - unpaidLunchIn(effShiftStart, timeInRel);
    if (lateRaw > policy.grace_minutes && !wholeDay) {
      const lateBlocked = roundUpToUnit(lateRaw, unitMinutesFor(policy.late_unit));
      lateMin = lateBlocked; // still reported even when exempt — HR can see the pattern, it just costs nothing
      latePay = exemptLate ? 0 : (lateBlocked / 60) * hourlyRate;
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
    // How many minutes of this day are actually paid presence — the clocked span up to the
    // expected end (an early time-out ends it sooner); paid OT below extends it past the end.
    // Time past the end that isn't paid as OT (no Overtime form while one is required, or the
    // tail past an OT cap) isn't paid presence. Used only to scope the unified night-diff pass
    // further down so it never covers time that wasn't actually paid for.
    let paidSpanEnd = Math.min(timeOutRel, effectiveEnd);

    // Early OT: time before the (effective) shift start, paid only when the linked Overtime form
    // has Early OT ticked and the time-in was at least EARLY_OT_MIN_MINUTES early — never
    // automatic, even when the policy doesn't require an OT form. It takes the daily cap first;
    // the after-shift OT below gets what's left (2 h cap, 1 h early → at most 1 h after).
    let earlyBlocked = 0;
    const earlyRaw = effShiftStart - timeInRel;
    if (hasForm('overtime_request') && earlyOtTicked(formData('overtime_request')?.early_ot) && earlyRaw >= EARLY_OT_MIN_MINUTES) {
      const earlyBlockedRaw = otCreditMinutes(earlyRaw, policy);
      earlyBlocked = dayMaxOtMin != null ? Math.min(earlyBlockedRaw, dayMaxOtMin) : earlyBlockedRaw;
    }
    // Where paid presence starts: the shift start, or earlier by any paid early OT (a late
    // arrival starts it at the time-in). Unpaid early time doesn't count — see night diff below.
    const paidSpanStart = Math.max(timeInRel, effShiftStart - earlyBlocked);

    if (hasForm('overtime_request') || (!policy.require_ot_form && timeOutRel > effectiveEnd)) {
      const otRaw = Math.max(0, timeOutRel - effectiveEnd);
      if (otRaw > 0 || earlyBlocked > 0) {
        const otBlockedRaw = otCreditMinutes(otRaw, policy);
        // dayMaxOtMin (policy cap, or a linked Overtime Request's own approved_hours override —
        // see above; null = no cap) caps how much of it is actually PAID, early OT included —
        // same as unauthorized OT, hours worked past the cap are simply uncompensated presence,
        // not converted into undertime.
        const otBlocked = dayMaxOtMin != null ? Math.min(otBlockedRaw, Math.max(0, dayMaxOtMin - earlyBlocked)) : otBlockedRaw;
        if (otBlocked > 0) paidSpanEnd = Math.min(timeOutRel, effectiveEnd + otBlocked);
        if (otBlocked + earlyBlocked > 0) {
          otHours = (otBlocked + earlyBlocked) / 60;
          out.ot_hours += otHours;
          // OT pay scales with the day's own rate multiplier too — OT worked on a Regular
          // Holiday isn't paid at the same rate as OT on an ordinary day (DOLE: hourly rate x
          // 200% x 130% for a Regular Holiday, not just x 125%). Rather than hardcoding DOLE's
          // own OT sub-rates (169%/195%/260%/338% for each combination) as separate magic
          // numbers, this reuses the exact same dayRateMultiplier the base-day premium above is
          // built from, scaled by the admin's configured OT%: ordinary-day OT is unaffected
          // (multiplier 1.0, same result as before this existed), and every holiday/rest-day
          // combination scales consistently with whatever OT% the company has configured,
          // instead of a second hardcoded rate.
          const dayMult = dayRateMultiplier(day.holiday, restDayPremium);
          const pay = exemptOt ? 0 : otHours * hourlyRate * dayMult * (policy.ot_rate_percent / 100);
          otPay = pay;
          out.overtime_pay += pay;
        }
      }
    } else if (timeOutRel < effectiveEnd) {
      // Left before the expected end. Deducted by default — unlike OT, a short day doesn't
      // need anyone's authorization to be a deduction. The one exception: a linked Undertime
      // Request form with with_pay = 'Yes' (authorizedPaid, hoisted above) — a company-
      // authorized, PAID early release (e.g. a documented emergency) waives the deduction
      // outright, no make-up owed. That's different from an Offset form, which defers the
      // obligation (make up the time later) rather than waiving it — hence effectiveEnd is
      // still computed from Offset above, not this.
      if (!authorizedPaid && !wholeDay) {
        const shortRaw = effectiveEnd - timeOutRel - unpaidLunchIn(timeOutRel, effectiveEnd);
        const shortBlocked = roundUpToUnit(shortRaw, unitMinutesFor(policy.late_unit));
        undertimeMin = shortBlocked;
        undertimePay = -(shortBlocked / 60) * hourlyRate;
        out.undertime_pay += undertimePay;
      }
    }

    // Night differential over the entire PAID clocked span (regular + OT together, computed
    // once — not just the OT portion, which is all this used to cover: a straight night-shift
    // worker with no OT got zero night diff despite the law requiring it for every night hour
    // actually worked). Runs from paidSpanStart (the real clock-in for a late arrival; for an
    // early one, the shift start less any paid early OT — unpaid early time earns none) to
    // paidSpanEnd (shrinks for undertime, extends for any paid OT, capped either way).
    if (policy.night_diff_enabled) {
      const nightMin = nightMinutesRel(paidSpanStart, Math.max(0, paidSpanEnd - paidSpanStart), nightStart, nightEnd);
      if (nightMin > 0) {
        nightDiffPay = (nightMin / 60) * hourlyRate * (policy.night_diff_percent / 100);
        out.night_diff_pay += nightDiffPay;
      }
    }

    // Lunch-break lateness folds into the same late_minutes/late_deduction totals as ordinary
    // arrival lateness here — both are real peso deductions in this branch, so unlike the
    // per_hour/Undertime-Day fold-ins above there's no self-correction reasoning to spell out.
    lateMin += lunchLateMin;
    latePay += lunchLatePay;
    out.late_deduction += lunchLatePay;

    pushDay();
  }

  return out;
}

function mergeAttendanceComputations(a: AttendanceComputation, b: AttendanceComputation): AttendanceComputation {
  return {
    days_worked: a.days_worked + b.days_worked,
    days_absent: a.days_absent + b.days_absent,
    days_half: a.days_half + b.days_half,
    days_undertime: a.days_undertime + b.days_undertime,
    late_deduction: a.late_deduction + b.late_deduction,
    ot_hours: a.ot_hours + b.ot_hours,
    overtime_pay: a.overtime_pay + b.overtime_pay,
    undertime_pay: a.undertime_pay + b.undertime_pay,
    undertime_day_pay: a.undertime_day_pay + b.undertime_day_pay,
    night_diff_pay: a.night_diff_pay + b.night_diff_pay,
    holiday_pay: a.holiday_pay + b.holiday_pay,
    special_holiday_30: a.special_holiday_30 + b.special_holiday_30,
    rest_day_ot: a.rest_day_ot + b.rest_day_ot,
    days: [...a.days, ...b.days],
  };
}

/** Same as computeAttendanceForEmployee, but resolves each day's own daily rate via
 *  `rateForDate` instead of applying one flat rate to the whole run — so a mid-cutoff raise
 *  (e.g. ₱600/day through Jun 8, ₱650/day from Jun 9) pays each day at the rate that actually
 *  applied that day. Splits `days` into consecutive same-rate runs (in the order given — the
 *  caller passes them in date order), computes each run separately with
 *  computeAttendanceForEmployee, and sums the results — so every per-day figure (OT,
 *  holiday/rest-day/night-diff premiums, late deduction, …) still uses that day's own rate
 *  throughout, exactly as a single-rate run always has. `rateForDate` is a plain callback (not
 *  a DB call itself) so this stays as DB-free/unit-testable as computeAttendanceForEmployee —
 *  see src/routes/hr.routes.ts for the caller that resolves it from employee_rate_history. */
export function computeAttendanceMultiRate(
  days: AttendanceDay[],
  rateForDate: (workDate: string) => number,
  policy: PayrollPolicy,
  exemptLate = false,
  exemptOt = false,
  alwaysWholeDay = false
): { computed: AttendanceComputation; basicSalary: number } {
  let merged: AttendanceComputation = { ...ZERO, days: [] };
  let basicSalary = 0;
  let i = 0;
  while (i < days.length) {
    const rate = rateForDate(days[i]!.work_date);
    const run: AttendanceDay[] = [days[i]!];
    i++;
    while (i < days.length && rateForDate(days[i]!.work_date) === rate) { run.push(days[i]!); i++; }
    const c = computeAttendanceForEmployee(run, rate, policy, exemptLate, exemptOt, alwaysWholeDay);
    basicSalary += rate * c.days_worked;
    merged = mergeAttendanceComputations(merged, c);
  }
  return { computed: merged, basicSalary };
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
  const forms = day.linkedForms && day.linkedForms.length
    ? day.linkedForms
    : day.linkedForm ? [day.linkedForm] : [];
  if (forms.some((f) => f.slug === 'overtime_request')) return 0; // already authorized
  const timeIn = toMinutes(day.time_in);
  const timeOut = toMinutes(day.time_out);
  if (timeIn == null || timeOut == null || !day.shift) return 0;
  const shiftStart = toMinutes(day.shift.start_time);
  let shiftEnd = toMinutes(day.shift.end_time);
  if (shiftStart == null || shiftEnd == null) return 0;
  const overnight = shiftEnd < shiftStart;
  if (overnight) shiftEnd += DAY_MIN;
  const relTo = (min: number) => (overnight && min < shiftStart ? min + DAY_MIN : min);
  const timeInRel = relTo(timeIn);
  const timeOutRel = nextDayIfBefore(relTo(timeOut), timeInRel);

  let effectiveEnd = shiftEnd;
  let effectiveStart = shiftStart;
  const offset = forms.find((f) => f.slug === 'offset_form');
  if (offset) {
    const offsetEndRaw = toMinutes(offset.data?.new_time_out as string | undefined);
    const offsetStartRaw = toMinutes(offset.data?.new_time_in as string | undefined);
    if (offsetEndRaw != null) effectiveEnd = relTo(offsetEndRaw);
    if (offsetStartRaw != null && offsetEndRaw != null) effectiveStart = relTo(offsetStartRaw);
  }

  const otRaw = timeOutRel - effectiveEnd;
  // Possible early OT too (time-in EARLY_OT_MIN_MINUTES+ before the start) — it's paid only via
  // an Overtime form with Early OT ticked, so it's equally "worked but not yet filed".
  const earlyRaw = effectiveStart - timeInRel;
  return otCreditMinutes(otRaw, policy)
    + (earlyRaw >= EARLY_OT_MIN_MINUTES ? otCreditMinutes(earlyRaw, policy) : 0);
}
