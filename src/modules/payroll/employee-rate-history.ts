/**
 * DB access for the versioned per-employee rate table (`employee_rate_history`) — the same
 * "latest row on or before a date wins" pattern src/payroll-tables.ts uses for the PH statutory
 * tables, applied per employee instead of company-wide. Lets a mid-cutoff raise pay each day at
 * whichever rate actually applied that day, instead of one flat rate for the whole cutoff.
 */
import { queryAll, queryOne, run } from '../../shared/db';

export interface RateHistoryRow {
  id: number;
  employee_id: number;
  effective_from: string; // YYYY-MM-DD
  rate_type: 'daily' | 'monthly';
  daily_rate: number;
  monthly_rate: number | null;
  note: string | null;
  created_by: number | null;
  created_at: string;
}

/** Every logged rate change for this employee, newest first — for the read-only history list
    on the Edit Employee form. */
export function listRateHistory(employeeId: number): RateHistoryRow[] {
  return queryAll<RateHistoryRow>(
    'SELECT * FROM employee_rate_history WHERE employee_id = ? ORDER BY effective_from DESC, id DESC',
    employeeId
  );
}

/** The daily_rate in force for this employee on `onDate` (YYYY-MM-DD): the latest logged row
    whose effective_from is on or before it, else `fallback` — the employee's current
    daily_rate, correct for any date before the earliest logged change (including every date
    for an employee with no history rows at all, e.g. one created before this feature shipped). */
export function effectiveDailyRateOn(employeeId: number, onDate: string, fallback: number): number {
  const row = queryOne<{ daily_rate: number }>(
    `SELECT daily_rate FROM employee_rate_history
      WHERE employee_id = ? AND effective_from <= ?
      ORDER BY effective_from DESC LIMIT 1`,
    employeeId, onDate
  );
  return row ? row.daily_rate : fallback;
}

/** The whole logged rate (type, daily, monthly) in force on `onDate`, or undefined when no row
    covers it — what employees.daily_rate/rate_type/monthly_rate should hold once a rate change
    is logged, since a backdated change can land behind a later one that still wins today. */
export function rateInForceOn(
  employeeId: number, onDate: string
): { rate_type: 'daily' | 'monthly'; daily_rate: number; monthly_rate: number | null } | undefined {
  return queryOne<{ rate_type: 'daily' | 'monthly'; daily_rate: number; monthly_rate: number | null }>(
    `SELECT rate_type, daily_rate, monthly_rate FROM employee_rate_history
      WHERE employee_id = ? AND effective_from <= ?
      ORDER BY effective_from DESC LIMIT 1`,
    employeeId, onDate
  );
}

function insertRow(
  employeeId: number, effectiveFrom: string,
  rate: { rate_type: 'daily' | 'monthly'; daily_rate: number; monthly_rate: number | null },
  note: string | null, userId: number | null
): void {
  run(
    `INSERT INTO employee_rate_history (employee_id, effective_from, rate_type, daily_rate, monthly_rate, note, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(employee_id, effective_from) DO UPDATE SET
       rate_type = excluded.rate_type, daily_rate = excluded.daily_rate, monthly_rate = excluded.monthly_rate,
       note = excluded.note, created_by = excluded.created_by, created_at = datetime('now')`,
    employeeId, effectiveFrom, rate.rate_type, rate.daily_rate, rate.monthly_rate, note, userId
  );
}

/** Seed the first history row for a brand-new employee, dated at their start date — or, if
    none was given, a "since forever" sentinel (same one recordRateChange's own backfill below
    uses), NOT today: defaulting to today would let this seed row outrank a legitimately
    backdated correction logged later (e.g. "actually the raise was effective back in June"),
    since the resolver always picks whichever row has the latest effective_from on or before
    the date being asked about. Every employee created from here on has at least one row, so
    recordRateChange's own backfill only ever has to cover pre-existing employees. */
export function seedInitialRate(
  employeeId: number, startDate: string | null,
  rate: { rate_type: 'daily' | 'monthly'; daily_rate: number; monthly_rate: number | null },
  userId: number | null
): void {
  insertRow(employeeId, startDate || '2000-01-01', rate, 'Starting rate', userId);
}

/** Log a rate change effective on or before today (see hr.routes.ts POST
    /employees/:id/rate-change — future-dated changes aren't supported yet). `prev` is only used the first time this particular employee gets a
    logged change (an employee that predates this feature, so seedInitialRate never ran for
    them): it backfills one row for whatever their rate was immediately before this edit, dated
    at their start date, so work dates before today still resolve to the old rate instead of
    silently picking up the new one. Returns the earliest affected date, including any
    previously unset rates filled in, so callers refresh all affected payslips. */
export function recordRateChange(
  employeeId: number, effectiveFrom: string,
  next: { rate_type: 'daily' | 'monthly'; daily_rate: number; monthly_rate: number | null },
  prev: { rate_type: 'daily' | 'monthly'; daily_rate: number; monthly_rate: number | null; start_date: string | null },
  note: string | null, userId: number | null
): string {
  const hasHistory = queryOne('SELECT 1 FROM employee_rate_history WHERE employee_id = ?', employeeId);
  if (!hasHistory) {
    insertRow(
      employeeId, prev.start_date || '2000-01-01',
      { rate_type: prev.rate_type, daily_rate: prev.daily_rate, monthly_rate: prev.monthly_rate },
      'Backfilled — rate prior to the first logged change', userId
    );
  }
  insertRow(employeeId, effectiveFrom, next, note, userId);
  const filledFrom = next.daily_rate > 0 ? fillUnsetRate(employeeId, next) : null;
  return filledFrom && filledFrom < effectiveFrom ? filledFrom : effectiveFrom;
}

/** A ₱0 rate means "not set yet" (employee created or imported without one), never a rate anyone
    was actually paid at. So once a real rate is entered, the ₱0 rows that precede every real rate
    take it too — otherwise every cutoff day before the (default: today) effective date would
    still pay ₱0. Zero rows dated after an earlier real rate are left alone. Same repair as the
    SCHEMA_VERSION 56 migration step in src/shared/db.ts, for one employee. */
function fillUnsetRate(
  employeeId: number,
  rate: { rate_type: 'daily' | 'monthly'; daily_rate: number; monthly_rate: number | null }
): string | null {
  const filled = queryAll<{ effective_from: string }>(
    `UPDATE employee_rate_history SET rate_type = ?, daily_rate = ?, monthly_rate = ?
      WHERE employee_id = ? AND daily_rate = 0
        AND NOT EXISTS (SELECT 1 FROM employee_rate_history p
                         WHERE p.employee_id = employee_rate_history.employee_id
                           AND p.daily_rate > 0 AND p.effective_from < employee_rate_history.effective_from)
      RETURNING effective_from`,
    rate.rate_type, rate.daily_rate, rate.monthly_rate, employeeId
  );
  return filled.reduce<string | null>((earliest, row) =>
    earliest == null || row.effective_from < earliest ? row.effective_from : earliest, null);
}
