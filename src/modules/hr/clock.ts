/**
 * Time-clock logic. Employees prove they're physically at the office by scanning a
 * QR that the office kiosk screen rotates every ROTATE_SECONDS — the code is an
 * HMAC of the time window, so it can't be produced off-site and a shared screenshot
 * is stale within ~2 minutes. Phone-less staff type their employee no. + name at the
 * same kiosk instead. There is NO device binding; a guard stationed at the kiosk
 * hears a distinct chime per punch (see the desktop kiosk view).
 */
import crypto from 'node:crypto';
import { getSetting, setSetting, queryOne, queryAll, run } from '../../shared/db';
import type { PunchGeo } from './clock-geofence';

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
/** Why an employee with this status may not punch (office or field clock), or null if they may.
    Separated employees are inactive; a suspended one is still employed but off the clock until
    HR lifts the suspension. `who` picks the phrasing: the kiosk names "that employee", the
    phone speaks to the employee themselves. */
export function punchBlockedReason(status: string, who: 'kiosk' | 'self'): string | null {
  if (status === 'resigned' || status === 'terminated') {
    return who === 'self' ? 'Your employee record is inactive.' : 'That employee record is inactive.';
  }
  if (status === 'suspended') {
    return who === 'self'
      ? 'You are suspended and cannot clock in. Contact HR.'
      : 'That employee is suspended and cannot clock in.';
  }
  return null;
}

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
  /** "HH:MM" — when no shift resolves at all (not even a company default), a first punch of the
   *  day at/after this is a time-out (forgot to time in), not a time-in. "24:00" = never. */
  first_punch_out_after: string;
}
function policy(): ClockPolicy {
  return { lunch_start: '11:00', lunch_end: '14:00', first_punch_out_after: '17:00', ...(getSetting<Partial<ClockPolicy>>('clock_policy') || {}) };
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

/** From what time ("HH:MM") a first punch of the day on `date` counts as a time-out rather than
 *  a time-in: the end of the shift the employee is working — that day's attendance_records shift
 *  if HR set one, else their own default shift, else the company default shift
 *  (shifts.is_default) — or, with no shift at all, clock_policy.first_punch_out_after. null for
 *  an overnight shift (end before start): there a wall-clock time can't tell an arrival from a
 *  departure, so the first punch is always an in. */
function firstPunchOutAfter(employeeId: number, date: string): string | null {
  const s = queryOne<{ start_time: string | null; end_time: string | null }>(
    `SELECT s.start_time, s.end_time FROM shifts s
     WHERE s.id = COALESCE(
       (SELECT ar.shift_id FROM attendance_records ar
         WHERE ar.employee_id = ? AND ar.work_date = ? AND ar.shift_id IS NOT NULL
         ORDER BY ar.id DESC LIMIT 1),
       (SELECT e.default_shift_id FROM employees e WHERE e.id = ?),
       (SELECT id FROM shifts WHERE is_default = 1 ORDER BY id LIMIT 1))`,
    employeeId, date, employeeId
  );
  if (!s?.start_time || !s.end_time) return policy().first_punch_out_after;
  if (s.end_time <= s.start_time) return null;
  return s.end_time.slice(0, 5);
}

/** When the employee has no real punches yet today, stand-ins for the brackets HR already typed
 *  into that day's attendance_records (time_in / lunch_out / lunch_in) -- so a manually entered
 *  time-in makes the next kiosk/phone punch a time-out instead of a second "first in" that
 *  applyPunchToAttendance would then discard. time_out is deliberately not mirrored: a pre-filled
 *  out shouldn't block the employee's real punch. Only fed to classify(), never stored or used
 *  for hours. */
function manualBracketsAsPunches(employeeId: number, date: string): PunchRow[] {
  const r = queryOne<{ time_in: string | null; lunch_out: string | null; lunch_in: string | null }>(
    `SELECT time_in, lunch_out, lunch_in FROM attendance_records
     WHERE employee_id = ? AND work_date = ? AND time_in IS NOT NULL AND time_in <> ''
     ORDER BY id DESC LIMIT 1`,
    employeeId, date
  );
  if (!r) return [];
  const mk = (kind: string, segment: string, hm: string): PunchRow =>
    ({ id: 0, employee_id: employeeId, ts: `${date} ${hm}:00`, work_date: date, kind, segment, source: 'manual' });
  const out = [mk('in', r.time_in! < '12:00' ? 'morning_in' : 'afternoon_in', r.time_in!)];
  if (r.lunch_out) {
    out.push(mk('out', 'lunch_out', r.lunch_out));
    if (r.lunch_in) out.push(mk('in', 'afternoon_in', r.lunch_in));
  }
  return out;
}

/** The in-side brackets the day's attendance_records row currently holds -- punch-derived or typed
 *  by HR -- for the kiosk card, which otherwise only sees punches and would show a manual time-in
 *  as blank. null when the employee isn't on a roster for that date. */
export function recordedBrackets(employeeId: number, date: string): { in: string | null; lunchOut: string | null; lunchIn: string | null } | null {
  const r = queryOne<{ time_in: string | null; lunch_out: string | null; lunch_in: string | null }>(
    'SELECT time_in, lunch_out, lunch_in FROM attendance_records WHERE employee_id = ? AND work_date = ? ORDER BY id DESC LIMIT 1',
    employeeId, date
  );
  return r ? { in: r.time_in || null, lunchOut: r.lunch_out || null, lunchIn: r.lunch_in || null } : null;
}

/** Classify what this punch means from the day's punches so far. The very first punch of the
 *  day is normally an in — except at/after `outAfter` (see firstPunchOutAfter): that's someone
 *  who forgot to time in and is now leaving, so it's recorded as the day's time-out, leaving
 *  time-in blank for HR to follow up. */
function classify(priorToday: PunchRow[], outAfter: string | null): { kind: 'in' | 'out'; segment: string } {
  const { hm, hour } = localParts();
  const pol = policy();
  const prevPunch = priorToday[priorToday.length - 1];
  if (!prevPunch && outAfter != null && hm >= outAfter) return { kind: 'out', segment: 'afternoon_out' };
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
  id: number;
  employee_id: number;
  employee_name: string;
  kind: 'in' | 'out';
  segment: string;
  at: string;          // "HH:MM"
  work_date: string;
  hours_today: number;  // paired in→out so far
  source: 'phone' | 'kiosk' | 'remote';
  /** See recordedBrackets -- set on recordPunch results so the kiosk card can show HR-typed times. */
  recorded?: ReturnType<typeof recordedBrackets>;
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

/** Thrown by recordPunch once the day's final out has already happened -- the central error
 *  handler (src/app.ts) turns this into the given HTTP status automatically. */
export class AlreadyClockedOutError extends Error {
  status = 409;
  constructor(message: string) {
    super(message);
    this.name = 'AlreadyClockedOutError';
  }
}

/** Which device a phone punch came from (src/shared/device.ts). `flag` marks a punch HR may
 *  want to look at: 'borrowed' = signed in with the borrowed-phone option; 'other_user' = the
 *  device is one another account usually signs in on. Recorded, never blocked — a forgotten
 *  phone is a legitimate reason. `usual_user_id` is that device's usual account, if known. */
export interface PunchDevice {
  device_id: string | null;
  flag: 'borrowed' | 'other_user' | null;
  usual_user_id: number | null;
}

/** Record a punch for an employee. Caller has already validated the kiosk code
 *  and resolved the employee. De-dupes a repeat within 45s. Once the day's final
 *  ('afternoon_out') punch has happened, refuses to start a new in/out cycle -- e.g. an
 *  employee called back for overtime doesn't get a fresh "morning in" here; the kiosk's
 *  click-to-correct flow (see correctPunch) is the only way to log more time that day. */
export function recordPunch(
  employee: { id: number; name: string },
  source: 'phone' | 'kiosk' | 'remote',
  userId: number | null,
  geo: PunchGeo | null = null,
  device: PunchDevice | null = null
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
        ok: true, duplicate: true, id: last.id, employee_id: employee.id, employee_name: employee.name,
        kind: last.kind as 'in' | 'out', segment: last.segment, at: last.ts.slice(11, 16),
        work_date: date, hours_today: hoursToday(prior), source,
      };
    }
  }

  if (prior.some((p) => p.segment === 'afternoon_out')) {
    throw new AlreadyClockedOutError(
      'Already timed out for today. To log more time (e.g. overtime), use the kiosk\'s Out slot and confirm with your employee number.'
    );
  }

  const context = prior.length ? prior : manualBracketsAsPunches(employee.id, date);
  const { kind, segment } = classify(context, firstPunchOutAfter(employee.id, date));
  const info = run(
    `INSERT INTO time_punches (employee_id, user_id, work_date, kind, segment, source, lat, lng, accuracy_m, distance_m, geo_site,
                               device_id, device_flag, device_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    employee.id, userId, date, kind, segment, source,
    geo?.lat ?? null, geo?.lng ?? null, geo?.accuracy_m ?? null, geo?.distance_m ?? null, geo?.site ?? null,
    device?.device_id ?? null, device?.flag ?? null, device?.usual_user_id ?? null
  );
  const row = queryOne<PunchRow>('SELECT * FROM time_punches WHERE id = ?', Number(info.lastInsertRowid))!;
  applyPunchToAttendance(employee.id, date);
  return {
    ok: true, id: row.id, employee_id: employee.id, employee_name: employee.name,
    kind, segment, at: row.ts.slice(11, 16), work_date: date,
    hours_today: hoursToday([...prior, row]), source,
    recorded: recordedBrackets(employee.id, date),
  };
}

/** The four brackets the kiosk screen shows per day, and the attendance_records column each
 *  one feeds. Matches deriveDayColumns's own vocabulary below. */
export type CorrectionSlot = 'in' | 'lunchOut' | 'lunchIn' | 'out';
const SLOT_COLUMN: Record<CorrectionSlot, 'time_in' | 'lunch_out' | 'lunch_in' | 'time_out'> = {
  in: 'time_in', lunchOut: 'lunch_out', lunchIn: 'lunch_in', out: 'time_out',
};

/** Whichever existing punch currently fills this slot, using the exact same rules
 *  deriveDayColumns uses to derive it -- so correcting it can't disagree with the display. */
function findSlotPunch(punches: PunchRow[], slot: CorrectionSlot): PunchRow | null {
  if (slot === 'in') return punches.find((p) => p.kind === 'in') ?? null;
  const lunchOutPunch = punches.find((p) => p.segment === 'lunch_out') ?? null;
  if (slot === 'lunchOut') return lunchOutPunch;
  if (slot === 'lunchIn') return lunchOutPunch ? punches.find((p) => p.kind === 'in' && p.id > lunchOutPunch.id) ?? null : null;
  return [...punches].reverse().find((p) => p.kind === 'out') ?? null; // 'out'
}

/** For each of `workDates`, which time_punches.id (if any) currently fills each of the day's
 *  four slots -- one query for the whole range, not one per day. Used by the HR timekeeping
 *  grid to know which cells have a kiosk photo worth showing (see GET /periods/:id/attendance
 *  in hr.routes.ts) without guessing: this reuses the exact same findSlotPunch rule the kiosk's
 *  own correction flow and deriveDayColumns use, so it can never point at the wrong punch. */
export function slotPunchIdsForDates(employeeId: number, workDates: string[]): Map<string, Record<CorrectionSlot, number | null>> {
  const result = new Map<string, Record<CorrectionSlot, number | null>>();
  if (!workDates.length) return result;
  const placeholders = workDates.map(() => '?').join(',');
  const punches = queryAll<PunchRow>(
    `SELECT * FROM time_punches WHERE employee_id = ? AND work_date IN (${placeholders}) ORDER BY id`,
    employeeId, ...workDates
  );
  const byDate = new Map<string, PunchRow[]>();
  for (const p of punches) {
    if (!byDate.has(p.work_date)) byDate.set(p.work_date, []);
    byDate.get(p.work_date)!.push(p);
  }
  for (const date of workDates) {
    const dayPunches = byDate.get(date) ?? [];
    result.set(date, {
      in: findSlotPunch(dayPunches, 'in')?.id ?? null,
      lunchOut: findSlotPunch(dayPunches, 'lunchOut')?.id ?? null,
      lunchIn: findSlotPunch(dayPunches, 'lunchIn')?.id ?? null,
      out: findSlotPunch(dayPunches, 'out')?.id ?? null,
    });
  }
  return result;
}

function segmentAndKindFor(slot: CorrectionSlot, hour: number): { kind: 'in' | 'out'; segment: string } {
  if (slot === 'in') return { kind: 'in', segment: hour < 12 ? 'morning_in' : 'afternoon_in' };
  if (slot === 'lunchOut') return { kind: 'out', segment: 'lunch_out' };
  if (slot === 'lunchIn') return { kind: 'in', segment: 'afternoon_in' };
  return { kind: 'out', segment: 'afternoon_out' }; // 'out'
}

/** Manually set one of the day's four slots to "now" -- the kiosk's click-to-fix flow for when
 *  the system (or the employee) got a punch wrong, or a slot never got punched at all. Whoever
 *  is at the kiosk taps the slot, then the actual employee re-enters their own number to confirm
 *  it's them (checked by the caller against which row was tapped -- see the kiosk view) before
 *  this runs. Updates the existing punch for that slot if there is one, so it can't disagree with
 *  findSlotPunch/deriveDayColumns by landing at a different position in id order; inserts a new
 *  one otherwise. This is also the only way to log a further "time out" once the day's final one
 *  has already happened (see recordPunch's AlreadyClockedOutError) -- e.g. called back for OT,
 *  tap Out again and it just advances the recorded time.
 *
 *  Unlike applyPunchToAttendance (which only fills attendance_records columns that are still
 *  empty, so it never clobbers a manual HR edit), this is a deliberate, explicit fix and always
 *  overwrites the corresponding column -- otherwise the "correction" would be cosmetic only and
 *  the wrong value would silently stay on the payroll side. */
export function correctPunch(
  employee: { id: number; name: string },
  slot: CorrectionSlot,
  source: 'kiosk'
): PunchResult {
  const { date, hour } = localParts();
  const prior = queryAll<PunchRow>(
    'SELECT * FROM time_punches WHERE employee_id = ? AND work_date = ? ORDER BY id',
    employee.id, date
  );
  const { kind, segment } = segmentAndKindFor(slot, hour);
  const existing = findSlotPunch(prior, slot);

  let row: PunchRow;
  let finalPunches: PunchRow[];
  if (existing) {
    run("UPDATE time_punches SET ts = datetime('now','localtime'), segment = ? WHERE id = ?", segment, existing.id);
    row = queryOne<PunchRow>('SELECT * FROM time_punches WHERE id = ?', existing.id)!;
    finalPunches = prior.map((p) => (p.id === existing.id ? row : p));
  } else {
    const info = run(
      'INSERT INTO time_punches (employee_id, user_id, work_date, kind, segment, source) VALUES (?, NULL, ?, ?, ?, ?)',
      employee.id, date, kind, segment, source
    );
    row = queryOne<PunchRow>('SELECT * FROM time_punches WHERE id = ?', Number(info.lastInsertRowid))!;
    finalPunches = [...prior, row];
  }

  run(
    `UPDATE attendance_records SET ${SLOT_COLUMN[slot]} = ?, updated_at = datetime('now')
     WHERE employee_id = ? AND work_date = ?`,
    row.ts.slice(11, 16), employee.id, date
  );

  return {
    ok: true, id: row.id, employee_id: employee.id, employee_name: employee.name,
    kind: row.kind as 'in' | 'out', segment: row.segment, at: row.ts.slice(11, 16),
    work_date: date, hours_today: hoursToday(finalPunches), source,
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
  // No punches yet but HR typed a time-in → already clocked in (same rule recordPunch uses).
  const last = rows[rows.length - 1] ?? manualBracketsAsPunches(employeeId, date).pop();
  return {
    work_date: date,
    punches: rows.map((r) => ({ at: r.ts.slice(11, 16), kind: r.kind, segment: r.segment, source: r.source })),
    clocked_in: !!last && last.kind === 'in',
    since: last && last.kind === 'in' ? last.ts.slice(11, 16) : null,
    hours_today: hoursToday(rows),
  };
}

interface DayColumns { time_in: string | null; lunch_out: string | null; lunch_in: string | null; time_out: string | null }

/** Split one day's raw punches into the four brackets classify() already tags them with:
 *  first in → time_in, the lunch_out punch → lunch_out, the first in after it → lunch_in (back
 *  from lunch), last out → time_out. lunch_out/lunch_in are display-only (payroll still uses
 *  PayrollPolicy.lunch_break_minutes). Shared by importPunchesForPeriod (a whole period, on
 *  demand) and applyPunchToAttendance (one day, live on every punch) so the two can never
 *  derive these columns differently. `punches` must be non-empty. */
function deriveDayColumns(punches: PunchRow[]): DayColumns {
  const hm = (p: PunchRow) => p.ts.slice(11, 16);
  // First actual in-punch → time_in. None (the employee forgot to time in and only timed out)
  // → time_in stays blank, so the day reads as a missing time-in rather than a bogus arrival.
  const firstIn = punches.find((p) => p.kind === 'in') ?? null;
  // Lunch bracket: the lunch_out punch, then the first in-punch that follows it (afternoon_in
  // = "back from lunch"). No lunch_out punch → no lunch bracket, exactly as before this existed.
  const lunchOutPunch = punches.find((p) => p.segment === 'lunch_out') ?? null;
  const lunchInPunch = lunchOutPunch
    ? punches.find((p) => p.kind === 'in' && p.id > lunchOutPunch.id) ?? null
    : null;
  // Last out-punch → time_out (a lone time-in has no out-punch, so it never gets one).
  const lastOut = [...punches].reverse().find((p) => p.kind === 'out') ?? null;
  return {
    time_in: firstIn ? hm(firstIn) : null,
    lunch_out: lunchOutPunch ? hm(lunchOutPunch) : null,
    lunch_in: lunchInPunch ? hm(lunchInPunch) : null,
    time_out: lastOut ? hm(lastOut) : null,
  };
}

/** Fill this employee+date's attendance_records row(s) from whatever's in time_punches so far —
 *  only columns that don't already hold a manual value, same rule as importPunchesForPeriod.
 *  Called live on every punch (see recordPunch) so HR doesn't have to click Import while a
 *  period is still open; a no-op if the employee isn't on any period's roster for this date yet
 *  (nothing lost — Import (or adding them to the roster) still picks these punches up later). */
function applyPunchToAttendance(employeeId: number, workDate: string): void {
  const rows = queryAll<{
    period_id: number; time_in: string | null; lunch_out: string | null; lunch_in: string | null; time_out: string | null;
  }>(
    'SELECT period_id, time_in, lunch_out, lunch_in, time_out FROM attendance_records WHERE employee_id = ? AND work_date = ?',
    employeeId, workDate
  );
  if (!rows.length) return;
  const punches = queryAll<PunchRow>(
    'SELECT * FROM time_punches WHERE employee_id = ? AND work_date = ? ORDER BY id',
    employeeId, workDate
  );
  if (!punches.length) return;
  const cols = deriveDayColumns(punches);
  for (const r of rows) {
    const timeIn = r.time_in || cols.time_in;
    const lunchOut = r.lunch_out || cols.lunch_out;
    const lunchIn = r.lunch_in || cols.lunch_in;
    const timeOut = r.time_out || cols.time_out;
    if (timeIn === r.time_in && lunchOut === r.lunch_out && lunchIn === r.lunch_in && timeOut === r.time_out) continue;
    run(
      `UPDATE attendance_records SET time_in = ?, lunch_out = ?, lunch_in = ?, time_out = ?,
         updated_at = datetime('now')
       WHERE period_id = ? AND employee_id = ? AND work_date = ?`,
      timeIn ?? null, lunchOut ?? null, lunchIn ?? null, timeOut ?? null, r.period_id, employeeId, workDate
    );
  }
}

/** Reconcile punches into attendance_records for a cutoff period — a catch-up/backfill pass for
 *  whatever applyPunchToAttendance's live per-punch fill couldn't cover: punches recorded before
 *  the employee was added to this period's roster. Only touches roster columns that don't
 *  already have a manual value set. Returns how many rows were filled. */
export function importPunchesForPeriod(periodId: number): { filled: number; dates: number } {
  const roster = queryAll<{
    employee_id: number; work_date: string;
    time_in: string | null; lunch_out: string | null; lunch_in: string | null; time_out: string | null;
  }>(
    'SELECT employee_id, work_date, time_in, lunch_out, lunch_in, time_out FROM attendance_records WHERE period_id = ?',
    periodId
  );
  let filled = 0;
  const seen = new Set<string>();
  for (const r of roster) {
    const punches = queryAll<PunchRow>(
      'SELECT * FROM time_punches WHERE employee_id = ? AND work_date = ? ORDER BY id',
      r.employee_id, r.work_date
    );
    if (!punches.length) continue;
    const cols = deriveDayColumns(punches);

    const timeIn = r.time_in || cols.time_in;
    const lunchOut = r.lunch_out || cols.lunch_out;
    const lunchIn = r.lunch_in || cols.lunch_in;
    const timeOut = r.time_out || cols.time_out;

    if (
      timeIn === r.time_in && lunchOut === r.lunch_out
      && lunchIn === r.lunch_in && timeOut === r.time_out
    ) continue;
    run(
      `UPDATE attendance_records SET time_in = ?, lunch_out = ?, lunch_in = ?, time_out = ?,
         updated_at = datetime('now')
       WHERE period_id = ? AND employee_id = ? AND work_date = ?`,
      timeIn ?? null, lunchOut ?? null, lunchIn ?? null, timeOut ?? null, periodId, r.employee_id, r.work_date
    );
    filled++;
    seen.add(r.work_date);
  }
  return { filled, dates: seen.size };
}
