/** Time clock: rotating kiosk code, phone + kiosk punches, segment classification,
 *  de-dupe, and reconciliation into attendance_records. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';
import { currentKioskCode } from '../src/clock';
import { run, queryOne } from '../src/db';

let ctx: TestContext;
let adminToken: string;
const A = () => ({ Authorization: `Bearer ${adminToken}` });

beforeAll(async () => {
  ctx = await setupApp();
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

  it('kiosk punch needs a matching employee no. + name', async () => {
    const e = await linkedEmployee();
    const bad = await ctx.api.post('/api/hr/clock/kiosk-punch').set(A())
      .send({ code: code(), employee_no: e.employee_no, name: 'Someone Else' });
    expect(bad.status).toBe(400);

    const ok = await ctx.api.post('/api/hr/clock/kiosk-punch').set(A())
      .send({ code: code(), employee_no: e.employee_no, name: e.name });
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

  it('imports punches into a cutoff period\'s attendance rows', async () => {
    const e = await linkedEmployee();
    // a punch dated to a work day, then two more spread out for that day
    const day = '2026-08-10';
    run(
      "INSERT INTO time_punches (employee_id, work_date, ts, kind, segment, source) VALUES (?, ?, ?, 'in', 'morning_in', 'kiosk'), (?, ?, ?, 'out', 'afternoon_out', 'kiosk')",
      e.employeeId, day, `${day} 08:01:00`,
      e.employeeId, day, `${day} 17:05:00`
    );
    const period = await ctx.api.post('/api/hr/periods').set(A())
      .send({ label: 'Aug 1-15', start_date: '2026-08-01', end_date: '2026-08-15' });
    await ctx.api.post(`/api/hr/periods/${period.body.id}/employees/bulk`).set(A())
      .send({ employee_ids: [e.employeeId] });

    const imp = await ctx.api.post(`/api/hr/clock/import/${period.body.id}`).set(A());
    expect(imp.status).toBe(200);
    expect(imp.body.filled).toBeGreaterThanOrEqual(1);

    const row = queryOne<{ time_in: string; time_out: string }>(
      'SELECT time_in, time_out FROM attendance_records WHERE period_id = ? AND employee_id = ? AND work_date = ?',
      period.body.id, e.employeeId, day
    )!;
    expect(row.time_in).toBe('08:01');
    expect(row.time_out).toBe('17:05');
  });
});
