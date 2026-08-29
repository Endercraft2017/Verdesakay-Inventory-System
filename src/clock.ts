/**
 * Time-clock logic. Employees prove they're physically at the office by scanning a
 * QR that the office kiosk screen rotates every ROTATE_SECONDS — the code is an
 * HMAC of the time window, so it can't be produced off-site and a shared screenshot
 * is stale within ~2 minutes. Phone-less staff type their employee no. + name at the
 * same kiosk instead. There is NO device binding; a guard stationed at the kiosk
 * hears a distinct chime per punch (see the desktop kiosk view).
 */
import crypto from 'node:crypto';
import { getSetting, setSetting, queryOne, queryAll, run } from './db';

export const ROTATE_SECONDS = 60;
/** Codes for the current and previous window both validate (≈2 min grace). */
const GRACE_WINDOWS = 1;

function hmacKey(): string {
  let k = getSetting<string>('clock_hmac_key');
  if (!k) {
    k = crypto.randomBytes(32).toString('base64');
    setSetting('clock_hmac_key', k);
  }
  return k;
}

function windowNow(): number {
  return Math.floor(Date.now() / 1000 / ROTATE_SECONDS);
}

function codeFor(win: number): string {
  return crypto.createHmac('sha256', hmacKey()).update(String(win)).digest('base64url').slice(0, 10);
}

/** The code the kiosk should be showing right now, plus how long it's good for. */
export function currentKioskCode(): { code: string; window: number; seconds_left: number } {
  const win = windowNow();
  const elapsed = Math.floor(Date.now() / 1000) % ROTATE_SECONDS;
  return { code: codeFor(win), window: win, seconds_left: ROTATE_SECONDS - elapsed };
}

/** True if `code` matches the current or a recent window. */
export function isValidKioskCode(code: string): boolean {
  if (typeof code !== 'string' || code.length !== 10) return false;
  const got = Buffer.from(code);
  const win = windowNow();
  for (let i = 0; i <= GRACE_WINDOWS; i++) {
    const want = Buffer.from(codeFor(win - i));
    if (got.length === want.length && crypto.timingSafeEqual(got, want)) return true;
  }
  return false;
}

interface ClockPolicy {
  lunch_start: string; // "HH:MM"
  lunch_end: string;
}
function policy(): ClockPolicy {
  return { lunch_start: '11:00', lunch_end: '14:00', ...(getSetting<Partial<ClockPolicy>>('clock_policy') || {}) };
}

function localParts(): { date: string; hm: string; hour: number } {
  const d = new Date(); // the server runs on-site, so this is office-local time
  const p = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    hm: `${p(d.getHours())}:${p(d.getMinutes())}`,
    hour: d.getHours(),
  };
}

export interface PunchRow {
  id: number;
  employee_id: number;
  ts: string;
  work_date: string;
  kind: string;
  segment: string;
  source: string;
}

/** Classify what this punch means from the day's punches so far. */
function classify(priorToday: PunchRow[]): { kind: 'in' | 'out'; segment: string } {
  const { hm, hour } = localParts();
  const pol = policy();
  const prevPunch = priorToday[priorToday.length - 1];
  const kind: 'in' | 'out' = prevPunch && prevPunch.kind === 'in' ? 'out' : 'in';

  if (kind === 'in') {
    if (priorToday.length === 0) return { kind, segment: hour < 12 ? 'morning_in' : 'afternoon_in' };
    return { kind, segment: 'afternoon_in' }; // back from lunch / re-entry
  }
  // kind === 'out'
  const hadAfternoonIn = priorToday.some((p) => p.segment === 'afternoon_in');
  const inLunch = hm >= pol.lunch_start && hm <= pol.lunch_end;
  if (inLunch && !hadAfternoonIn) return { kind, segment: 'lunch_out' };
  return { kind, segment: 'afternoon_out' };
}

export interface PunchResult {
  ok: true;
  duplicate?: boolean;
  employee_id: number;
  employee_name: string;
  kind: 'in' | 'out';
  segment: string;
  at: string;          // "HH:MM"
  work_date: string;
  hours_today: number;  // paired in→out so far
  source: 'phone' | 'kiosk';
}

/** Sum paired in/out intervals for a day (open 'in' counts up to now). */
function hoursToday(punches: PunchRow[]): number {
  let total = 0;
  let openAt: number | null = null;
  for (const p of punches) {
    const t = new Date(p.ts.replace(' ', 'T')).getTime();
    if (p.kind === 'in') openAt = t;
    else if (openAt != null) { total += t - openAt; openAt = null; }
  }
  if (openAt != null) total += Date.now() - openAt;
  return Math.round((total / 3_600_000) * 100) / 100;
}

/** Record a punch for an employee. Caller has already validated the kiosk code
 *  and resolved the employee. De-dupes a repeat within 45s. */
export function recordPunch(
  employee: { id: number; name: string },
  source: 'phone' | 'kiosk',
  userId: number | null
): PunchResult {
  const { date } = localParts();
  const prior = queryAll<PunchRow>(
    'SELECT * FROM time_punches WHERE employee_id = ? AND work_date = ? ORDER BY id',
    employee.id,
    date
  );

  const last = prior[prior.length - 1];
  if (last) {
    const gap = Date.now() - new Date(last.ts.replace(' ', 'T')).getTime();
    if (gap >= 0 && gap < 45_000) {
      return {
        ok: true, duplicate: true, employee_id: employee.id, employee_name: employee.name,
        kind: last.kind as 'in' | 'out', segment: last.segment, at: last.ts.slice(11, 16),
        work_date: date, hours_today: hoursToday(prior), source,
      };
    }
  }

  const { kind, segment } = classify(prior);
  const info = run(
    `INSERT INTO time_punches (employee_id, user_id, work_date, kind, segment, source)
     VALUES (?, ?, ?, ?, ?, ?)`,
    employee.id, userId, date, kind, segment, source
  );
  const row = queryOne<PunchRow>('SELECT * FROM time_punches WHERE id = ?', Number(info.lastInsertRowid))!;
  return {
    ok: true, employee_id: employee.id, employee_name: employee.name,
    kind, segment, at: row.ts.slice(11, 16), work_date: date,
    hours_today: hoursToday([...prior, row]), source,
  };
}

/** The employee's clock state today — for the mobile "my clock" screen. */
export function myClockStatus(employeeId: number): {
  work_date: string; punches: Array<{ at: string; kind: string; segment: string; source: string }>;
  clocked_in: boolean; since: string | null; hours_today: number;
} {
  const { date } = localParts();
  const rows = queryAll<PunchRow>(
    'SELECT * FROM time_punches WHERE employee_id = ? AND work_date = ? ORDER BY id',
    employeeId, date
  );
  const last = rows[rows.length - 1];
  return {
    work_date: date,
    punches: rows.map((r) => ({ at: r.ts.slice(11, 16), kind: r.kind, segment: r.segment, source: r.source })),
    clocked_in: !!last && last.kind === 'in',
    since: last && last.kind === 'in' ? last.ts.slice(11, 16) : null,
    hours_today: hoursToday(rows),
  };
}

/** Reconcile punches into attendance_records for a cutoff period:
 *  first punch of a work_date → time_in, last → time_out. Only touches roster
 *  rows that don't already have a manual time set. Returns how many were filled. */
export function importPunchesForPeriod(periodId: number): { filled: number; dates: number } {
  const roster = queryAll<{ employee_id: number; work_date: string; time_in: string | null; time_out: string | null }>(
    'SELECT employee_id, work_date, time_in, time_out FROM attendance_records WHERE period_id = ?',
    periodId
  );
  let filled = 0;
  const seen = new Set<string>();
  for (const r of roster) {
    const agg = queryOne<{ first: string; last: string; n: number }>(
      `SELECT MIN(ts) AS first, MAX(ts) AS last, COUNT(*) AS n
       FROM time_punches WHERE employee_id = ? AND work_date = ?`,
      r.employee_id, r.work_date
    );
    if (!agg || !agg.n) continue;
    const timeIn = r.time_in || agg.first.slice(11, 16);
    const timeOut = r.time_out || (agg.n > 1 ? agg.last.slice(11, 16) : r.time_out);
    if (timeIn === r.time_in && timeOut === r.time_out) continue;
    run(
      "UPDATE attendance_records SET time_in = ?, time_out = ?, updated_at = datetime('now') WHERE period_id = ? AND employee_id = ? AND work_date = ?",
      timeIn, timeOut ?? null, periodId, r.employee_id, r.work_date
    );
    filled++;
    seen.add(r.work_date);
  }
  return { filled, dates: seen.size };
}
