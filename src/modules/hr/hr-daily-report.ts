/** Pure classification for the HR "Daily Report" board (HR -> Time Keeping -> Daily Report) —
 *  a live, whole-company snapshot of who's present / late / absent / on leave for one
 *  calendar date, with a per-department breakdown.
 *
 *  Deliberately NOT src/hr-payroll-compute.ts: that engine only makes sense for a *complete*
 *  day (time_in AND time_out both known), run after a cutoff closes — a day with only a
 *  time_in (still clocked in, no time_out yet) falls into its "no usable time logged" branch
 *  and would misread as absent. This board has to make sense mid-shift, the moment someone
 *  has clocked in but not out yet, so "has a time_in at all" is enough to count as present/late
 *  here. No DB access here — the caller (src/routes/hr.routes.ts) resolves shift_id ->
 *  {start_time, end_time}, a linked leave_request form -> on_leave, the Company Holidays
 *  calendar / No Work Memo / rest-day pattern -> holiday/no_work/is_rest_day, exactly like
 *  hr-payroll-compute.ts's own caller does — so the two never disagree about what a holiday,
 *  a No Work Memo, or a rest day *is*, even though they disagree about what counts as "present".
 *  A half day is the exception: it comes straight from the payroll engine's own exported rule
 *  (detectHalfDaySession / halfDayArrival), with the same precedence payroll applies — a linked
 *  Half Day request, else HR's manual override, else auto-detected from the times on a day with
 *  no form linked — so the board and the payslip never disagree about who worked half a day.
 */
import {
  detectHalfDaySession, halfDayArrival, pastLunchReturn,
  type AttendanceDay, type HalfDaySession,
} from '../payroll/hr-payroll-compute';

export type DailyStatus = 'present' | 'late' | 'half_day' | 'absent' | 'leave' | 'reported' | 'not_scheduled' | 'pending';

export interface DailyStatusInput {
  /** "HH:MM" — the day's recorded time_in, or (when nothing's been reconciled/typed yet) the
   *  first raw time-clock punch of the day. Its mere presence means "showed up" here — unlike
   *  the payroll engine, a missing time_out never demotes this back to "no time logged". */
  time_in: string | null;
  /** "HH:MM" — the day's time_out, if any. Only consulted when there's no time_in: someone who
   *  forgot to time in but timed out was still at work, so they read present, not absent. */
  time_out?: string | null;
  shift: { start_time: string; end_time: string } | null;
  /** Whether an HR request form with slug 'leave_request' is linked to this day — regardless
   *  of its own with_pay field; unlike payroll (which only treats a *paid* leave specially),
   *  this board just needs to know someone is accounted for, not what it costs. */
  on_leave: boolean;
  /** Whether a 'reported_absence' form (chat/verbal, no time in) is linked to this day. Doesn't
   *  excuse the absence — payroll (hr-payroll-compute.ts) never reads this slug, so it's still
   *  unpaid like any other absence — it just tells this board the no-show was called in, not a
   *  silent no-call/no-show, so it shouldn't be lumped in with plain 'absent'. */
  reported: boolean;
  holiday: AttendanceDay['holiday'];
  no_work: 'paid' | 'unpaid' | null;
  is_rest_day: boolean;
  grace_minutes: number;
  /** "HH:MM" right now — only passed when the report date is today; null for any other date,
   *  which turns off the 'pending' bucket below (a past day with no time_in is just absent). */
  now: string | null;
  /** PayrollPolicy.lunch_break_minutes — places the shift's lunch gap, which splits its AM and
   *  PM halves exactly as payroll splits them. */
  lunch_minutes: number;
  /** "HH:MM" of a lunch-out with no return after it and no time_out — the payroll engine's
   *  "abandoned after lunch" case, read as this day's time-out once it can no longer be an
   *  ordinary lunch (a past date, or today past the lunch gap + tolerance — see pastLunchReturn). */
  left_at_lunch?: string | null;
  /** A linked Half Day Request — its own `session` field ('Morning (AM)' / 'Afternoon (PM)').
   *  null/omitted: none linked. */
  half_day_form?: { session: string | null } | null;
  /** attendance_records.half_day_override — HR's manual half-day call. */
  half_day_override?: 'am' | 'pm' | null;
  /** Whether ANY HR form is linked to the day. Payroll only auto-detects a half day from the
   *  times on a day with none — a day carrying an offset/OT/leave form keeps that form's rules. */
  has_linked_forms?: boolean;
}

export interface DailyStatusResult {
  status: DailyStatus;
  late_minutes: number;
  note: string;
  /** Set when status is 'half_day'. */
  half_day_session?: HalfDaySession;
}

type HalfDaySource = 'form' | 'manual' | 'auto';
const HALF_DAY_SOURCE_NOTE: Record<HalfDaySource, string> = {
  form: 'Half Day form filed',
  manual: 'marked a half day by HR',
  auto: 'no Half Day form filed',
};
const shortSession = (s: HalfDaySession) => (s === 'Afternoon (PM)' ? 'PM' : 'AM');

function toMinutes(hm: string | null | undefined): number | null {
  if (!hm) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(hm);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

const HOLIDAY_LABEL: Partial<Record<NonNullable<AttendanceDay['holiday']>, string>> = {
  regular: 'Regular Holiday',
  special_non_working: 'Special Non-Working Holiday',
  cancelled_paid: 'Work cancelled (paid)',
  cancelled_unpaid: 'Work cancelled (unpaid)',
};
// Which holiday codes mean "not expected to show up" for this board. 'special_working' is an
// ordinary working day (informational only, same stance hr-payroll-compute.ts takes) so it's
// deliberately excluded — someone absent on a Special Working Holiday still just reads absent.
const NOT_SCHEDULED_HOLIDAYS = new Set<AttendanceDay['holiday']>(['regular', 'special_non_working', 'cancelled_paid', 'cancelled_unpaid']);

export function classifyDailyStatus(input: DailyStatusInput): DailyStatusResult {
  const shiftStart = toMinutes(input.shift?.start_time);

  // Explicit half days, in payroll's own precedence: a linked request (its session, defaulting
  // to AM like payroll's halfDayWindow) beats HR's override.
  const explicitHalf: { session: HalfDaySession; source: HalfDaySource } | null = input.half_day_form
    ? { session: input.half_day_form.session === 'Afternoon (PM)' ? 'Afternoon (PM)' : 'Morning (AM)', source: 'form' }
    : input.half_day_override
      ? { session: input.half_day_override === 'pm' ? 'Afternoon (PM)' : 'Morning (AM)', source: 'manual' }
      : null;

  if (input.time_in) {
    // Gone at lunch and never back counts as the time-out — but only once it can't still be lunch.
    const leftAtLunch = input.left_at_lunch && (input.now == null || pastLunchReturn(input.shift, input.lunch_minutes, input.now))
      ? input.left_at_lunch : null;
    const effectiveOut = input.time_out || leftAtLunch;
    const autoSession = !explicitHalf && !input.has_linked_forms
      ? detectHalfDaySession(input.shift, input.lunch_minutes, input.time_in, effectiveOut ?? null)
      : null;
    const half = explicitHalf ?? (autoSession ? { session: autoSession, source: 'auto' as const } : null);
    if (half) {
      // Late is judged against the half's own start — the shift start for AM, the end of the
      // lunch gap for PM — with the same past-grace convention as a whole day below.
      const lateRaw = halfDayArrival(input.shift, input.lunch_minutes, half.session, input.time_in)?.late_raw ?? 0;
      const lateMinutes = lateRaw > input.grace_minutes ? lateRaw : 0; // past grace: the whole lateness, as payroll
      const parts = [`arrived ${input.time_in}${lateMinutes > 0 ? ` — ${lateRaw}m late` : ''}`];
      if (effectiveOut) parts.push(`${leftAtLunch && !input.time_out ? 'left at lunch' : 'left'} ${effectiveOut}`);
      return {
        status: 'half_day', late_minutes: lateMinutes, half_day_session: half.session,
        note: `Half day (${shortSession(half.session)}) — ${parts.join(', ')} · ${HALF_DAY_SOURCE_NOTE[half.source]}`,
      };
    }

    const timeIn = toMinutes(input.time_in);
    let lateMinutes = 0;
    let lateRaw = 0;
    // No shift resolvable -> nothing to judge lateness against (same "can't fault them without
    // a known shift" stance as the payroll engine) — always reads as present, never late.
    // late_minutes is minutes PAST grace (matches hr-payroll-compute.ts's own convention, so
    // this board's numbers always agree with what payroll would show); the note instead quotes
    // the full clock-relative lateness, which reads more naturally to a supervisor at a glance.
    if (timeIn != null && shiftStart != null) {
      lateRaw = timeIn - shiftStart;
      if (lateRaw > input.grace_minutes) lateMinutes = lateRaw; // past grace: the whole lateness, as payroll
    }
    return lateMinutes > 0
      ? { status: 'late', late_minutes: lateMinutes, note: `Arrived ${input.time_in} — ${lateRaw}m late` }
      : { status: 'present', late_minutes: 0, note: `Arrived ${input.time_in}` };
  }

  // HR marked it a half day without a usable in/out pair — payroll credits that flatly, so does this.
  if (explicitHalf?.source === 'manual') {
    return {
      status: 'half_day', late_minutes: 0, half_day_session: explicitHalf.session,
      note: `Half day (${shortSession(explicitHalf.session)}) — ${HALF_DAY_SOURCE_NOTE.manual}, no time-in recorded`,
    };
  }

  if (input.time_out) {
    return { status: 'present', late_minutes: 0, note: `Timed out ${input.time_out} — no time-in recorded` };
  }

  // No time_in at all. In order of precedence (mirrors hr-payroll-compute.ts's own unworked-day
  // ordering, minus the paid/unpaid money distinctions this board doesn't need):
  if (input.on_leave) return { status: 'leave', late_minutes: 0, note: 'On leave' };
  if (input.holiday && NOT_SCHEDULED_HOLIDAYS.has(input.holiday)) {
    return { status: 'not_scheduled', late_minutes: 0, note: HOLIDAY_LABEL[input.holiday] ?? 'Holiday' };
  }
  if (input.no_work) {
    return {
      status: 'not_scheduled', late_minutes: 0,
      note: input.no_work === 'paid' ? 'Company no-work day (paid)' : 'Company no-work day (unpaid)',
    };
  }
  if (input.is_rest_day) return { status: 'not_scheduled', late_minutes: 0, note: 'Rest day' };
  if (input.reported) return { status: 'reported', late_minutes: 0, note: 'Reported (chat/verbal) — no time recorded' };

  // Live-only: viewing today, before this person's shift has even started (+ grace) yet — not
  // an absence, just hasn't happened. A past date (input.now === null) skips this entirely. An
  // afternoon Half Day request moves "due in" to the PM half's own start.
  if (input.now != null && shiftStart != null) {
    const nowMin = toMinutes(input.now);
    const pmStart = explicitHalf?.session === 'Afternoon (PM)'
      ? halfDayArrival(input.shift, input.lunch_minutes, explicitHalf.session, null)?.start ?? null
      : null;
    const dueAt = pmStart ?? input.shift!.start_time;
    const dueMin = toMinutes(dueAt);
    if (nowMin != null && dueMin != null && nowMin < dueMin + input.grace_minutes) {
      return {
        status: 'pending', late_minutes: 0,
        note: pmStart ? `Not yet due in (half day PM starts ${pmStart})` : `Not yet due in (shift starts ${dueAt})`,
      };
    }
  }

  return { status: 'absent', late_minutes: 0, note: 'No time recorded' };
}
