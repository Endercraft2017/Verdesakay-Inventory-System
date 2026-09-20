/** Field-work log: kiosk out/in toggle, separate from the payroll time clock. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';
// See clock.test.ts's doc comment for why these are imported dynamically inside beforeAll.
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

const code = () => currentKioskCode().code;

async function employee(overrides: Record<string, unknown> = {}) {
  const acc = await createEmployee(ctx.api, adminToken, { role: 'warehouse' });
  const employee_no = 'E' + Math.floor(Math.random() * 1e6);
  const name = acc.username.toUpperCase();
  const emp = await ctx.api.post('/api/hr/employees').set(A()).send({
    employee_no, name, user_id: acc.id, daily_rate: 500, rate_type: 'daily', status: 'regular', ...overrides,
  });
  if (emp.status !== 201) throw new Error('employee create failed: ' + JSON.stringify(emp.body));
  return { employeeId: emp.body.id as number, employee_no, name };
}

describe('field-work log', () => {
  it('a kiosk-punch alternates out/in, starting with out', async () => {
    const e = await employee();
    const out = await ctx.api.post('/api/hr/field/kiosk-punch').set(A())
      .send({ code: code(), employee_no: e.employee_no });
    expect(out.status).toBe(200);
    expect(out.body.kind).toBe('out');
    expect(out.body.source).toBe('kiosk');

    run("UPDATE field_punches SET ts = datetime(ts, '-10 minutes') WHERE employee_id = ?", e.employeeId);

    const back = await ctx.api.post('/api/hr/field/kiosk-punch').set(A())
      .send({ code: code(), employee_no: e.employee_no });
    expect(back.status).toBe(200);
    expect(back.body.kind).toBe('in');
  });

  it('de-dupes a repeat within 45s', async () => {
    const e = await employee();
    const a = await ctx.api.post('/api/hr/field/kiosk-punch').set(A())
      .send({ code: code(), employee_no: e.employee_no });
    const b = await ctx.api.post('/api/hr/field/kiosk-punch').set(A())
      .send({ code: code(), employee_no: e.employee_no });
    expect(b.body.duplicate).toBe(true);
    expect(b.body.kind).toBe(a.body.kind);
    const n = queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM field_punches WHERE employee_id = ?', e.employeeId)!.n;
    expect(n).toBe(1);
  });

  it('rejects a stale / wrong code', async () => {
    const e = await employee();
    const staleCode = await ctx.api.post('/api/hr/field/kiosk-punch').set(A())
      .send({ code: 'AAAAAAAAAA', employee_no: e.employee_no });
    expect(staleCode.status).toBe(400);
  });

  it('recent feed lists field punches newest-first with id filtering, separate from time_punches', async () => {
    const e = await employee();
    await ctx.api.post('/api/hr/field/kiosk-punch').set(A())
      .send({ code: code(), employee_no: e.employee_no });
    const all = await ctx.api.get('/api/hr/field/recent?since_id=0').set(A());
    expect(all.body.length).toBeGreaterThan(0);
    expect(all.body[0].kind).toBe('out');
    const top = all.body[0].id;
    const none = await ctx.api.get('/api/hr/field/recent?since_id=' + top).set(A());
    expect(none.body.length).toBe(0);

    // A field trip never lands in time_punches / attendance_records.
    const n = queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM time_punches WHERE employee_id = ?', e.employeeId)!.n;
    expect(n).toBe(0);
  });

  it('rejects an unknown employee number', async () => {
    const res = await ctx.api.post('/api/hr/field/kiosk-punch').set(A())
      .send({ code: code(), employee_no: 'NOSUCH123' });
    expect(res.status).toBe(404);
  });
});
