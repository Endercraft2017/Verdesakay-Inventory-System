// Rest-day resolution shared by payroll (attendanceDaysForEmployee), the Daily Time grid (GET
// /periods/:id/attendance) and the Daily Report, so all three agree on whether a date is a rest
// day for one employee. Precedence, most specific first:
//   1. attendance_records.rest_day 'yes'/'no' — HR's own per-day override on the grid
//   2. an APPROVED Change of Rest Day form (rest_day_change) linked to any of the employee's
//      attendance days — its original_rest_day becomes a working day, new_rest_day a rest day
//   3. the weekly pattern — employees.rest_days, else PayrollPolicy.default_rest_days
import { queryAll } from '../../shared/db';

/** Authorizes working a rest day. With PayrollPolicy.require_rest_day_form on, the rest-day
    premium is paid only when one of these is linked to the day AND approved. */
export const REST_DAY_WORK_SLUG = 'rest_day_work_request';
/** Moves a rest day: original_rest_day → working day, new_rest_day → rest day. */
export const REST_DAY_CHANGE_SLUG = 'rest_day_change';
/** Rest-day forms only take effect once approved; every other linked form keeps its
    link-means-applies behavior. */
export const REST_DAY_FORM_SLUGS = [REST_DAY_WORK_SLUG, REST_DAY_CHANGE_SLUG];

export type RestDaySwap = 'yes' | 'no';
/** One date's swap, plus the form that made it (the grid uses form_id to drop a swap whose
    form HR has just unlinked but not yet saved). */
export interface RestDaySwapEntry { rest_day: RestDaySwap; form_id: number }

/** Per-date rest-day overrides from one employee's approved, linked Change of Rest Day forms.
    Looks across ALL of the employee's attendance days (not one cutoff), because a swap can
    link on one date and move the rest day into the next cutoff. A later form wins a clash. */
export function restDaySwapsFor(employeeId: number): Map<string, RestDaySwapEntry> {
  const rows = queryAll<{ id: number; data: string }>(
    `SELECT fr.id, fr.data FROM form_records fr
     JOIN form_definitions fd ON fd.id = fr.form_def_id
     WHERE fd.slug = ? AND fr.status = 'approved' AND fr.id IN (
       SELECT je.value FROM attendance_records ar, json_each(ar.form_record_ids) je
        WHERE ar.employee_id = ? AND json_valid(ar.form_record_ids)
       UNION
       SELECT ar.form_record_id FROM attendance_records ar
        WHERE ar.employee_id = ? AND ar.form_record_id IS NOT NULL)
     ORDER BY fr.id`,
    REST_DAY_CHANGE_SLUG, employeeId, employeeId
  );
  const swaps = new Map<string, RestDaySwapEntry>();
  for (const r of rows) {
    let data: Record<string, unknown>;
    try { data = JSON.parse(r.data || '{}'); } catch { continue; }
    const from = typeof data.original_rest_day === 'string' ? data.original_rest_day : '';
    const to = typeof data.new_rest_day === 'string' ? data.new_rest_day : '';
    if (from) swaps.set(from, { rest_day: 'no', form_id: r.id });
    if (to) swaps.set(to, { rest_day: 'yes', form_id: r.id });
  }
  return swaps;
}

/** The three-layer rest-day decision described at the top of this file. */
export function resolveRestDay(
  manual: string | null | undefined,
  swap: RestDaySwapEntry | undefined,
  weeklyRestDay: boolean
): boolean {
  if (manual === 'yes') return true;
  if (manual === 'no') return false;
  if (swap) return swap.rest_day === 'yes';
  return weeklyRestDay;
}
