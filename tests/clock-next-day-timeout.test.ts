/** A punch the next day, before the employee's time-in time, closes yesterday's still-open shift
 *  (records yesterday's time-out) instead of starting a new day — e.g. a driver who timed in at
 *  08:00 and comes back at 06:00 the next morning. "Their time-in time" is today's shift start
 *  (day's roster shift, else default shift, else the company default), else — no shift at all —
 *  the time they timed in yesterday. At/after that time it's today's time-in, as before.
 *  Only `Date` is faked; punch `ts` still comes from SQLite's own clock. */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';

let run: typeof import('../src/shared/db').run;
let queryOne: typeof import('../src/shared/db').queryOne;
let currentKioskCode: typeof import('../src/modules/hr/clock').currentKioskCode;

let ctx: TestContext;
let adminToken: string;
const A = () => ({ Authorization: `Bearer ${adminToken}` });

beforeAll(async () => {
  ctx = await setupApp();
  ({ run, queryOne } = await import('../src/shared/db'));
  ({ currentKioskCode } = await import('../src/modules/hr/clock'));
  adminToken = await login(ctx.api);
});
afterAll(() => cleanup(ctx));
afterEach(() => vi.useRealTimers());

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const base = new Date();
const TODAY = ymd(base);
const YESTERDAY = ymd(new Date(base.getFullYear(), base.getMonth(), base.getDate() - 1));
/** Fake "now" to HH:MM today (local). */
function at(hm: string) {
  const [h, m] = hm.split(':').map(Number);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, m));
}

let shiftSeq = 0;
function shift(start: string, end: string): number {
  return Number(run('INSERT INTO shifts (name, start_time, end_time) VALUES (?, ?, ?)', `T${++shiftSeq}`, start, end).lastInsertRowid);
}

async function employee(defaultShiftId: number | null) {
  const acc = await createEmployee(ctx.api, adminToken, { role: 'warehouse' });
  const employee_no = 'N' + Math.floor(Math.random() * 1e6);
  const emp = await ctx.api.post('/api/hr/employees').set(A()).send({
    employee_no, name: acc.username.toUpperCase(), user_id: acc.id, daily_rate: 800, status: 'regular',
    default_shift_id: defaultShiftId,
  });
  if (emp.status !== 201) throw new Error('employee create failed: ' + JSON.stringify(emp.body));
  return { id: emp.body.id as number, employee_no, token: acc.token };
}

function punchYesterday(empId: number, hm: string, kind = 'in', segment = 'morning_in') {
  run(
    "INSERT INTO time_punches (employee_id, work_date, ts, kind, segment, source) VALUES (?, ?, ?, ?, ?, 'kiosk')",
    empId, YESTERDAY, `${YESTERDAY} ${hm}:00`, kind, segment
  );
}

const kiosk = (employee_no: string) =>
  ctx.api.post('/api/hr/clock/kiosk-punch').set(A()).send({ code: currentKioskCode().code, employee_no });

describe('next-day punch closes an open shift from yesterday', () => {
  it('before today\'s shift start: records yesterday\'s time-out', async () => {
    const e = await employee(shift('08:00', '17:00'));
    punchYesterday(e.id, '08:00');
    at('06:00');
    const r = await kiosk(e.employee_no);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ work_date: YESTERDAY, kind: 'out', segment: 'afternoon_out' });
    expect(queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM time_punches WHERE employee_id = ? AND work_date = ?', e.id, TODAY)!.n).toBe(0);
  });

  it('fills yesterday\'s attendance row time-out when they\'re on the roster', async () => {
    const e = await employee(shift('08:00', '17:00'));
    const period = await ctx.api.post('/api/hr/periods').set(A()).send({ label: 'Next day ' + e.employee_no, start_date: YESTERDAY, end_date: TODAY });
    await ctx.api.post(`/api/hr/periods/${period.body.id}/employees`).set(A()).send({ employee_id: e.id });
    run('UPDATE attendance_records SET time_in = ? WHERE employee_id = ? AND work_date = ?', '08:00', e.id, YESTERDAY);
    at('05:30');
    const r = await kiosk(e.employee_no); // no punches yesterday — HR typed the time-in
    expect(r.body.work_date).toBe(YESTERDAY);
    const row = queryOne<{ time_in: string; time_out: string | null }>(
      'SELECT time_in, time_out FROM attendance_records WHERE employee_id = ? AND work_date = ?', e.id, YESTERDAY
    )!;
    expect(row.time_in).toBe('08:00');
    expect(row.time_out).toMatch(/^\d\d:\d\d$/);
  });

  it('a double tap right after is a duplicate, not a new time-in for today', async () => {
    const e = await employee(shift('08:00', '17:00'));
    punchYesterday(e.id, '08:00');
    at('06:00');
    const first = await kiosk(e.employee_no);
    // ts comes from SQLite's real clock; line it up with the faked "now" the dedupe compares to.
    run('UPDATE time_punches SET ts = ? WHERE id = ?', `${TODAY} 06:00:00`, first.body.id);
    const again = await kiosk(e.employee_no);
    expect(again.body).toMatchObject({ duplicate: true, work_date: YESTERDAY });
    expect(queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM time_punches WHERE employee_id = ? AND work_date = ?', e.id, TODAY)!.n).toBe(0);
  });

  it('the phone shows them as still clocked in (yesterday\'s shift) until then', async () => {
    const e = await employee(shift('08:00', '17:00'));
    punchYesterday(e.id, '08:00');
    at('06:00');
    const st = await ctx.api.get('/api/hr/clock/my-status').set({ Authorization: `Bearer ${e.token}` });
    expect(st.body).toMatchObject({ clocked_in: true, since: '08:00', work_date: YESTERDAY });
  });

  it('overnight shift: the morning punch closes last night\'s shift', async () => {
    const e = await employee(shift('22:00', '06:00'));
    punchYesterday(e.id, '22:00', 'in', 'afternoon_in');
    at('06:10');
    const r = await kiosk(e.employee_no);
    expect(r.body).toMatchObject({ work_date: YESTERDAY, kind: 'out', segment: 'afternoon_out' });
  });

  it('no shift at all: judged against yesterday\'s own time-in time', async () => {
    const e = await employee(null);
    run('UPDATE shifts SET is_default = 0');
    punchYesterday(e.id, '09:00');
    at('08:30');
    expect((await kiosk(e.employee_no)).body.work_date).toBe(YESTERDAY);

    const f = await employee(null);
    punchYesterday(f.id, '09:00');
    at('09:30');
    expect((await kiosk(f.employee_no)).body).toMatchObject({ work_date: TODAY, kind: 'in' });
  });
});

describe('stays a time-in for today', () => {
  it('at/after today\'s shift start', async () => {
    const e = await employee(shift('08:00', '17:00'));
    punchYesterday(e.id, '08:00');
    at('08:00');
    expect((await kiosk(e.employee_no)).body).toMatchObject({ work_date: TODAY, kind: 'in' });
  });

  it('when yesterday was already timed out', async () => {
    const e = await employee(shift('08:00', '17:00'));
    punchYesterday(e.id, '08:00');
    punchYesterday(e.id, '17:00', 'out', 'afternoon_out');
    at('06:00');
    expect((await kiosk(e.employee_no)).body).toMatchObject({ work_date: TODAY, kind: 'in' });
  });

  it('when today already has a punch', async () => {
    const e = await employee(shift('08:00', '17:00'));
    punchYesterday(e.id, '08:00');
    run(
      "INSERT INTO time_punches (employee_id, work_date, ts, kind, segment, source) VALUES (?, ?, ?, 'in', 'morning_in', 'kiosk')",
      e.id, TODAY, `${TODAY} 05:00:00`
    );
    at('06:00');
    const r = await kiosk(e.employee_no);
    expect(r.body).toMatchObject({ work_date: TODAY, kind: 'out' });
  });
});
