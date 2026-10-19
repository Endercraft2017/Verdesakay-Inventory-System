import { beforeAll, afterAll, expect, it } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';

let ctx: TestContext;
let run: typeof import('../src/shared/db').run;
let queryOne: typeof import('../src/shared/db').queryOne;
let admin: string;
beforeAll(async () => {
  ctx = await setupApp();
  ({ run, queryOne } = await import('../src/shared/db'));
  admin = await login(ctx.api);
});
afterAll(() => cleanup(ctx));

it('never exposes a legacy name-only payslip when two employees have used that name', async () => {
  const first = await createEmployee(ctx.api, admin, { role: 'csr' });
  const second = await createEmployee(ctx.api, admin, { role: 'csr' });
  const auth = { Authorization: `Bearer ${admin}` };
  const a = await ctx.api.post('/api/hr/employees').set(auth).send({ employee_no: 'AMB-1', name: 'Shared Name', daily_rate: 600, user_id: first.id });
  const b = await ctx.api.post('/api/hr/employees').set(auth).send({ employee_no: 'AMB-2', name: 'Shared Name', daily_rate: 700, user_id: second.id });
  expect(a.status).toBe(201);
  expect(b.status).toBe(201);
  const form = queryOne<{ id: number }>("SELECT id FROM form_definitions WHERE slug = 'hr_payroll'")!;
  const insert = (number: string, data: object) => Number(run(
    "INSERT INTO form_records (form_def_id, number, data, status, period) VALUES (?, ?, ?, 'paid', 'October 2026')",
    form.id, number, JSON.stringify(data)
  ).lastInsertRowid);
  const ambiguous = insert('PAY-AMBIGUOUS', { employee_name: 'Shared Name', net_pay: 7000, basic_salary: 7000 });
  const stamped = insert('PAY-OWN', { employee_id: a.body.id, employee_name: 'Shared Name', net_pay: 8000, basic_salary: 8000 });
  insert('PAY-OTHER', { employee_id: b.body.id, employee_name: 'Shared Name', net_pay: 9000, basic_salary: 9000 });
  for (const account of [first, second]) {
    const bearer = { Authorization: `Bearer ${account.token}` };
    const list = await ctx.api.get('/api/me/payslips').set(bearer);
    expect(list.status).toBe(200);
    expect(list.body.map((row: { id: number }) => row.id)).not.toContain(ambiguous);
    expect((await ctx.api.get(`/api/me/payslips/${ambiguous}/timekeeping`).set(bearer)).status).toBe(404);
    expect((await ctx.api.get(`/api/me/payslips/${ambiguous}/pdf`).set(bearer)).status).toBe(404);
  }
  expect((await ctx.api.get('/api/me/payslips').set({ Authorization: `Bearer ${first.token}` })).body.map((row: { id: number }) => row.id)).toContain(stamped);
  expect((await ctx.api.get('/api/me/payslips').set({ Authorization: `Bearer ${second.token}` })).body.map((row: { id: number }) => row.id)).not.toContain(stamped);
  const thirteenth = await ctx.api.get('/api/hr/thirteenth-month?year=2026').set(auth);
  expect(thirteenth.status).toBe(200);
  expect(thirteenth.body.rows.filter((row: { employee_name: string }) => row.employee_name === 'Shared Name'))
    .toEqual(expect.arrayContaining([
      expect.objectContaining({ employee_id: a.body.id, basic_total: 8000 }),
      expect.objectContaining({ employee_id: b.body.id, basic_total: 9000 }),
      expect.objectContaining({ employee_id: null, basic_total: 7000 }),
    ]));
  const bir = await ctx.api.get('/api/accounting/bir-2316?year=2026').set(auth);
  expect(bir.status).toBe(200);
  expect(bir.body.rows.filter((row: { employee_name: string }) => row.employee_name === 'Shared Name').map((row: { employee_id: number | null }) => row.employee_id).sort())
    .toEqual([null, a.body.id, b.body.id].sort());
  expect(bir.body.rows.find((row: { employee_id: number }) => row.employee_id === a.body.id).figures.basic_salary).toBe(8000);
  expect(bir.body.rows.find((row: { employee_id: number }) => row.employee_id === b.body.id).figures.basic_salary).toBe(9000);
  const individual = await ctx.api.get(`/api/accounting/bir-2316/${a.body.id}?year=2026`).set(auth);
  expect(individual.body.figures.basic_salary).toBe(8000);
  const withholding = await ctx.api.get('/api/accounting/bir-1601c?year=2026').set(auth);
  expect(withholding.body.months[9].employee_count).toBe(3); // two identified employees and one unresolved legacy slip
});
