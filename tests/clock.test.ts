/** Time clock: rotating kiosk code, phone + kiosk punches, segment classification,
 *  de-dupe, and reconciliation into attendance_records. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';
// NOTE: `run`/`queryOne`/`currentKioskCode` are imported dynamically inside beforeAll,
// after setupApp() sets DB_PATH — a top-level `import ... from '../src/db'` (directly, or
// transitively via '../src/clock', which itself imports './db') would evaluate DB_PATH
// before it's set (real data.db, not the throwaway per-file one). See helpers.ts's own
// doc comment.
let run: typeof import('../src/db').run;
let queryOne: typeof import('../src/db').queryOne;
let currentKioskCode: typeof import('../src/clock').currentKioskCode;

let ctx: TestContext;
let adminToken: string;
const A = () => ({ Authorization: `Bearer ${adminToken}` });

beforeAll(async () => {
  ctx = await setupApp();
  ({ run, queryOne } = await import('../src/db'));
  ({ currentKioskCode } = await import('../src/clock'));
  adminToken = await login(ctx.api);
});
afterAll(() => cleanup(ctx));

const code = () => currentKioskCode().code;

/** Create an employee row linked to a fresh login account; returns both. */
async function linkedEmployee(overrides: Record<string, unknown> = {}) {
  const acc = await createEmployee(ctx.api, adminToken, { role: 'warehouse' });
  const employee_no = 'E' + Math.floor(Math.random() * 1e6);
  const name = acc.username.toUpperCase();
  const emp = await ctx.api.post('/api/hr/employees').set(A()).send({
    employee_no, name, user_id: acc.id, daily_rate: 500, rate_type: 'daily', status: 'regular', ...overrides,
  });
  if (emp.status !== 201) throw new Error('employee create failed: ' + JSON.stringify(emp.body));
  return { accountToken: acc.token, employeeId: emp.body.id as number, employee_no, name };
}

describe('time clock', () => {
  it('the kiosk code endpoint returns a rotating code', async () => {
    const res = await ctx.api.get('/api/hr/clock/code').set(A());
    expect(res.status).toBe(200);
    expect(res.body.code).toHaveLength(10);
    expect(res.body.rotate_seconds).toBe(60);
    expect(res.body.seconds_left).toBeGreaterThan(0);
  });

  it('a linked employee can punch from the phone; alternates in/out', async () => {
    const e = await linkedEmployee();
    const h = { Authorization: `Bearer ${e.accountToken}` };

    const inn = await ctx.api.post('/api/hr/clock/punch').set(h).send({ code: code() });
    expect(inn.status).toBe(200);
    expect(inn.body.kind).toBe('in');
    expect(inn.body.hours_today).toBe(0);

    // force a gap so the 45s de-dupe doesn't swallow the next punch
    run("UPDATE time_punches SET ts = datetime(ts, '-10 minutes') WHERE employee_id = ?", e.employeeId);

    const out = await ctx.api.post('/api/hr/clock/punch').set(h).send({ code: code() });
    expect(out.body.kind).toBe('out');
    expect(out.body.hours_today).toBeGreaterThan(0);
  });

  it('rejects a stale / wrong code', async () => {
    const e = await linkedEmployee();
    const res = await ctx.api.post('/api/hr/clock/punch')
      .set({ Authorization: `Bearer ${e.accountToken}` })
      .send({ code: 'AAAAAAAAAA' });
    expect(res.status).toBe(400);
  });

  it('rejects an account with no linked employee', async () => {
    const acc = await createEmployee(ctx.api, adminToken, { role: 'warehouse' });
    const res = await ctx.api.post('/api/hr/clock/punch')
      .set({ Authorization: `Bearer ${acc.token}` })
      .send({ code: code() });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not linked/i);
  });

  it('de-dupes a repeat punch within 45s', async () => {
    const e = await linkedEmployee();
    const h = { Authorization: `Bearer ${e.accountToken}` };
    const a = await ctx.api.post('/api/hr/clock/punch').set(h).send({ code: code() });
    const b = await ctx.api.post('/api/hr/clock/punch').set(h).send({ code: code() });
    expect(b.body.duplicate).toBe(true);
    expect(b.body.kind).toBe(a.body.kind);
    const n = queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM time_punches WHERE employee_id = ?', e.employeeId)!.n;
    expect(n).toBe(1);
  });

  it('kiosk punch needs just a matching employee no. — no name required', async () => {
    const e = await linkedEmployee();
    const unknown = await ctx.api.post('/api/hr/clock/kiosk-punch').set(A())
      .send({ code: code(), employee_no: 'NOSUCH123' });
    expect(unknown.status).toBe(404);

    const ok = await ctx.api.post('/api/hr/clock/kiosk-punch').set(A())
      .send({ code: code(), employee_no: e.employee_no });
    expect(ok.status).toBe(200);
    expect(ok.body.source).toBe('kiosk');
  });

  it('recent feed lists punches newest-first with id filtering', async () => {
    const e = await linkedEmployee();
    await ctx.api.post('/api/hr/clock/punch')
      .set({ Authorization: `Bearer ${e.accountToken}` }).send({ code: code() });
    const all = await ctx.api.get('/api/hr/clock/recent?since_id=0').set(A());
    expect(all.body.length).toBeGreaterThan(0);
    const top = all.body[0].id;
    const none = await ctx.api.get('/api/hr/clock/recent?since_id=' + top).set(A());
    expect(none.body.length).toBe(0);
  });

  it('fills the attendance row live on punch, with no Import step, when already on the roster', async () => {
    const e = await linkedEmployee();
    const h = { Authorization: `Bearer ${e.accountToken}` };
    const todayStr = new Date().toISOString().slice(0, 10);
    const period = await ctx.api.post('/api/hr/periods').set(A())
      .send({ label: 'Live fill', start_date: todayStr, end_date: todayStr });
    await ctx.api.post(`/api/hr/periods/${period.body.id}/employees/bulk`).set(A())
      .send({ employee_ids: [e.employeeId] });

    const punch = await ctx.api.post('/api/hr/clock/punch').set(h).send({ code: code() });
    expect(punch.status).toBe(200);
    const today = punch.body.work_date as string;

    const row = queryOne<{ time_in: string | null }>(
      'SELECT time_in FROM attendance_records WHERE period_id = ? AND employee_id = ? AND work_date = ?',
      period.body.id, e.employeeId, today
    )!;
    expect(row.time_in).toBe(punch.body.at);
  });

  it('a punch before the employee is added to any roster waits for Import, unaffected', async () => {
    const e = await linkedEmployee();
    const day = '2026-08-12';
    run(
      "INSERT INTO time_punches (employee_id, work_date, ts, kind, segment, source) VALUES (?, ?, ?, 'in', 'morning_in', 'kiosk')",
      e.employeeId, day, `${day} 08:00:00`
    );
    const period = await ctx.api.post('/api/hr/periods').set(A())
      .send({ label: 'Late add', start_date: '2026-08-01', end_date: '2026-08-15' });
    // Added to the roster AFTER the punch already happened — live fill had nothing to write to.
    await ctx.api.post(`/api/hr/periods/${period.body.id}/employees/bulk`).set(A())
      .send({ employee_ids: [e.employeeId] });

    const before = queryOne<{ time_in: string | null }>(
      'SELECT time_in FROM attendance_records WHERE period_id = ? AND employee_id = ? AND work_date = ?',
      period.body.id, e.employeeId, day
    )!;
    expect(before.time_in).toBeNull();

    await ctx.api.post(`/api/hr/clock/import/${period.body.id}`).set(A());
    const after = queryOne<{ time_in: string | null }>(
      'SELECT time_in FROM attendance_records WHERE period_id = ? AND employee_id = ? AND work_date = ?',
      period.body.id, e.employeeId, day
    )!;
    expect(after.time_in).toBe('08:00');
  });

  it('imports punches into a cutoff period\'s attendance rows, splitting the lunch bracket', async () => {
    const e = await linkedEmployee();
    // A full day: morning in, out for lunch, back from lunch, out for the day.
    const day = '2026-08-10';
    run(
      `INSERT INTO time_punches (employee_id, work_date, ts, kind, segment, source) VALUES
         (?, ?, ?, 'in',  'morning_in',    'kiosk'),
         (?, ?, ?, 'out', 'lunch_out',     'kiosk'),
         (?, ?, ?, 'in',  'afternoon_in',  'kiosk'),
         (?, ?, ?, 'out', 'afternoon_out', 'kiosk')`,
      e.employeeId, day, `${day} 08:01:00`,
      e.employeeId, day, `${day} 12:00:00`,
      e.employeeId, day, `${day} 12:58:00`,
      e.employeeId, day, `${day} 17:05:00`
    );
    const period = await ctx.api.post('/api/hr/periods').set(A())
      .send({ label: 'Aug 1-15', start_date: '2026-08-01', end_date: '2026-08-15' });
    await ctx.api.post(`/api/hr/periods/${period.body.id}/employees/bulk`).set(A())
      .send({ employee_ids: [e.employeeId] });

    const imp = await ctx.api.post(`/api/hr/clock/import/${period.body.id}`).set(A());
    expect(imp.status).toBe(200);
    expect(imp.body.filled).toBeGreaterThanOrEqual(1);

    const row = queryOne<{ time_in: string; lunch_out: string; lunch_in: string; time_out: string }>(
      'SELECT time_in, lunch_out, lunch_in, time_out FROM attendance_records WHERE period_id = ? AND employee_id = ? AND work_date = ?',
      period.body.id, e.employeeId, day
    )!;
    expect(row.time_in).toBe('08:01');
    expect(row.lunch_out).toBe('12:00');
    expect(row.lunch_in).toBe('12:58');
    expect(row.time_out).toBe('17:05');
  });

  it('imports a day with no lunch punches unchanged — lunch columns stay null', async () => {
    const e = await linkedEmployee();
    const day = '2026-08-11';
    run(
      "INSERT INTO time_punches (employee_id, work_date, ts, kind, segment, source) VALUES (?, ?, ?, 'in', 'morning_in', 'kiosk'), (?, ?, ?, 'out', 'afternoon_out', 'kiosk')",
      e.employeeId, day, `${day} 07:58:00`,
      e.employeeId, day, `${day} 16:59:00`
    );
    const period = await ctx.api.post('/api/hr/periods').set(A())
      .send({ label: 'Aug 1-15 b', start_date: '2026-08-01', end_date: '2026-08-15' });
    await ctx.api.post(`/api/hr/periods/${period.body.id}/employees/bulk`).set(A())
      .send({ employee_ids: [e.employeeId] });

    await ctx.api.post(`/api/hr/clock/import/${period.body.id}`).set(A());

    const row = queryOne<{ time_in: string; lunch_out: string | null; lunch_in: string | null; time_out: string }>(
      'SELECT time_in, lunch_out, lunch_in, time_out FROM attendance_records WHERE period_id = ? AND employee_id = ? AND work_date = ?',
      period.body.id, e.employeeId, day
    )!;
    expect(row.time_in).toBe('07:58');
    expect(row.time_out).toBe('16:59');
    expect(row.lunch_out).toBeNull();
    expect(row.lunch_in).toBeNull();
  });

  it('refuses another auto punch once the day\'s final out has already happened', async () => {
    const e = await linkedEmployee();
    const h = { Authorization: `Bearer ${e.accountToken}` };
    const first = await ctx.api.post('/api/hr/clock/punch').set(h).send({ code: code() });
    const day = first.body.work_date as string;
    run(
      "INSERT INTO time_punches (employee_id, work_date, ts, kind, segment, source) VALUES (?, ?, datetime('now','localtime'), 'out', 'afternoon_out', 'kiosk')",
      e.employeeId, day
    );
    run("UPDATE time_punches SET ts = datetime(ts, '-10 minutes') WHERE employee_id = ?", e.employeeId); // clear the 45s de-dupe window

    const res = await ctx.api.post('/api/hr/clock/punch').set(h).send({ code: code() });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already timed out/i);
  });

  describe('kiosk slot correction (/correct)', () => {
    it('fills an empty slot by inserting a new punch, and writes it straight into attendance_records', async () => {
      const e = await linkedEmployee();
      const todayStr = new Date().toISOString().slice(0, 10);
      const period = await ctx.api.post('/api/hr/periods').set(A())
        .send({ label: 'Correction A', start_date: todayStr, end_date: todayStr });
      await ctx.api.post(`/api/hr/periods/${period.body.id}/employees/bulk`).set(A())
        .send({ employee_ids: [e.employeeId] });

      const res = await ctx.api.post('/api/hr/clock/correct').set(A())
        .send({ code: code(), employee_no: e.employee_no, slot: 'lunchOut' });
      expect(res.status).toBe(200);
      expect(res.body.segment).toBe('lunch_out');
      expect(res.body.kind).toBe('out');
      const today = res.body.work_date as string;

      const row = queryOne<{ lunch_out: string | null }>(
        'SELECT lunch_out FROM attendance_records WHERE period_id = ? AND employee_id = ? AND work_date = ?',
        period.body.id, e.employeeId, today
      )!;
      expect(row.lunch_out).toBe(res.body.at);
    });

    it('updates the existing punch for that slot in place instead of inserting a duplicate', async () => {
      const e = await linkedEmployee();
      const h = { Authorization: `Bearer ${e.accountToken}` };
      const inn = await ctx.api.post('/api/hr/clock/punch').set(h).send({ code: code() });
      expect(inn.body.segment).toMatch(/_in$/);

      const corrected = await ctx.api.post('/api/hr/clock/correct').set(A())
        .send({ code: code(), employee_no: e.employee_no, slot: 'in' });
      expect(corrected.status).toBe(200);
      expect(corrected.body.id).toBe(inn.body.id); // same row, not a new one

      const n = queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM time_punches WHERE employee_id = ?', e.employeeId)!.n;
      expect(n).toBe(1);
    });

    it('is the only way to log more time once already timed out for the day (e.g. OT)', async () => {
      const e = await linkedEmployee();
      const h = { Authorization: `Bearer ${e.accountToken}` };
      const first = await ctx.api.post('/api/hr/clock/punch').set(h).send({ code: code() });
      const day = first.body.work_date as string;
      run(
        "INSERT INTO time_punches (employee_id, work_date, ts, kind, segment, source) VALUES (?, ?, datetime('now','localtime'), 'out', 'afternoon_out', 'kiosk')",
        e.employeeId, day
      );
      run("UPDATE time_punches SET ts = datetime(ts, '-10 minutes') WHERE employee_id = ?", e.employeeId);

      const blocked = await ctx.api.post('/api/hr/clock/punch').set(h).send({ code: code() });
      expect(blocked.status).toBe(409);

      const ot = await ctx.api.post('/api/hr/clock/correct').set(A())
        .send({ code: code(), employee_no: e.employee_no, slot: 'out' });
      expect(ot.status).toBe(200);
      expect(ot.body.kind).toBe('out');
      // Updated the existing final-out row rather than adding a third punch.
      const n = queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM time_punches WHERE employee_id = ?', e.employeeId)!.n;
      expect(n).toBe(2);
    });
  });
});
