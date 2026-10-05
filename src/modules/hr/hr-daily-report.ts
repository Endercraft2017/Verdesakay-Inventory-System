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
 */
import type { AttendanceDay } from '../payroll/hr-payroll-compute';

export type DailyStatus = 'present' | 'late' | 'absent' | 'leave' | 'reported' | 'not_scheduled' | 'pending';

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
}

export interface DailyStatusResult {
  status: DailyStatus;
  late_minutes: number;
  note: string;
}

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

  if (input.time_in) {
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
  // an absence, just hasn't happened. A past date (input.now === null) skips this entirely.
  if (input.now != null && shiftStart != null) {
    const nowMin = toMinutes(input.now);
    if (nowMin != null && nowMin < shiftStart + input.grace_minutes) {
      return { status: 'pending', late_minutes: 0, note: `Not yet due in (shift starts ${input.shift!.start_time})` };
    }
  }

  return { status: 'absent', late_minutes: 0, note: 'No time recorded' };
}
