/** Payslips carry the employee's name as it was when generated. After a rename (HR edit or an
 *  approved information change) payroll must still treat the old payslips as the same person:
 *  regenerating a cutoff updates instead of duplicating, and year-end reports (13th month,
 *  BIR 2316) show one row. See src/modules/payroll/payslip-owner.ts. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';
// Dynamic import after setupApp() sets DB_PATH (see helpers.ts).
let queryAll: typeof import('../src/shared/db').queryAll;
let queryOne: typeof import('../src/shared/db').queryOne;
let run: typeof import('../src/shared/db').run;

let ctx: TestContext;
let adminToken: string;
const A = () => ({ Authorization: `Bearer ${adminToken}` });

beforeAll(async () => {
  ctx = await setupApp();
  ({ queryAll, queryOne, run } = await import('../src/shared/db'));
  adminToken = await login(ctx.api);
});
afterAll(() => cleanup(ctx));

// PUT replaces every field, so pass the linked account through or the rename would unlink it.
async function rename(id: number, employee_no: string, name: string, user_id: number | null = null) {
  const r = await ctx.api.put(`/api/hr/employees/${id}`).set(A()).send({ employee_no, name, daily_rate: 600, user_id });
  expect(r.status).toBe(200);
}

describe('payslip ownership across renames', () => {
  it('keeps one payslip per cutoff and one year-end row after an HR rename', async () => {
    const acct = await createEmployee(ctx.api, adminToken, { role: 'csr' });
    const emp = await ctx.api.post('/api/hr/employees').set(A())
      .send({ employee_no: 'RN-1', name: 'Rosa Old', daily_rate: 600, user_id: acct.id });
    const id = emp.body.id as number;
    const payForm = queryOne<{ id: number }>("SELECT id FROM form_definitions WHERE slug = 'hr_payroll'")!.id;

    // A legacy payslip (generated before employee_id was stamped) for an earlier cutoff.
    run("INSERT INTO form_records (form_def_id, number, data, status, period) VALUES (?, 'PAY-LEG-1', ?, 'paid', 'Jan 1-15, 2026')",
      payForm, JSON.stringify({ employee_name: 'Rosa Old', payroll_period: 'Jan 1-15, 2026', pay_date: '2026-01-15',
        basic_salary: 6000, total_earnings: 6000, net_pay: 5500 }));

    // Generate a fresh cutoff under the old name — now stamped with employee_id.
    const period = await ctx.api.post('/api/hr/periods').set(A()).send({ label: 'Feb 1-2, 2026', start_date: '2026-02-01', end_date: '2026-02-02' });
    await ctx.api.post(`/api/hr/periods/${period.body.id}/employees`).set(A()).send({ employee_id: id });
    const gen1 = await ctx.api.post(`/api/hr/periods/${period.body.id}/generate-payslips`).set(A()).send({ payroll_period: 'Feb 1-2, 2026', pay_date: '2026-02-02' });
    expect(gen1.body.created).toBe(1);
    const stamped = queryOne<{ data: string }>("SELECT data FROM form_records WHERE period = 'Feb 1-2, 2026'")!;
    expect(JSON.parse(stamped.data).employee_id).toBe(id);

    await rename(id, 'RN-1', 'Rosa New', acct.id);
    expect(queryAll("SELECT id FROM employee_profile_changes WHERE employee_id = ? AND field = 'name' AND source = 'hr_edit'", id)).toHaveLength(1);

    // Regenerating after the rename updates the existing payslip; it doesn't add a second one.
    const gen2 = await ctx.api.post(`/api/hr/periods/${period.body.id}/generate-payslips`).set(A()).send({ payroll_period: 'Feb 1-2, 2026' });
    expect(gen2.body).toMatchObject({ created: 0, updated: 1 });
    expect(queryAll("SELECT id FROM form_records WHERE period = 'Feb 1-2, 2026'")).toHaveLength(1);

    // Year-end reports: one person, under the current name, counting both payslips.
    const thirteenth = await ctx.api.get('/api/hr/thirteenth-month?year=2026').set(A());
    const rows = thirteenth.body.rows.filter((r: { employee_name: string }) => r.employee_name.startsWith('Rosa'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ employee_name: 'Rosa New', payslip_count: 2 });
    const b2316 = await ctx.api.get('/api/accounting/bir-2316?year=2026').set(A());
    const lines = b2316.body.rows.filter((r: { employee_name: string }) => r.employee_name.startsWith('Rosa'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ employee_name: 'Rosa New', employee_id: id });

    // The legacy payslip's detail view still finds the employee, and the employee still sees it.
    const legacy = queryOne<{ id: number }>("SELECT id FROM form_records WHERE number = 'PAY-LEG-1'")!;
    const detail = await ctx.api.get(`/api/hr/payroll/${legacy.id}/detail`).set(A());
    // Resolves the renamed employee (it now fails only because this fixture's cutoff doesn't exist).
    expect(detail.body.error ?? '').not.toMatch(/No employee record/);
    const mine = await ctx.api.get('/api/me/payslips').set({ Authorization: `Bearer ${acct.token}` });
    expect(mine.body.map((p: { number: string }) => p.number).sort()).toContain('PAY-LEG-1');
    expect(mine.body).toHaveLength(2); // paid history and the regenerated draft remain visible
    expect(mine.body.find((p: { id: number }) => p.id === legacy.id)).toMatchObject({
      status: 'paid', finalized: true, download_url: `/me/payslips/${legacy.id}/pdf`,
    });
    expect(mine.body.find((p: { period: string }) => p.period === 'Feb 1-2, 2026')).toMatchObject({
      status: 'draft', finalized: false, finalized_at: null, download_url: null,
    });
  });

  it("does not guess ownership when a former name is reused by a different employee", async () => {
    const a = await ctx.api.post('/api/hr/employees').set(A()).send({ employee_no: 'RN-A', name: 'Sam Cruz', daily_rate: 600 });
    await rename(a.body.id, 'RN-A', 'Samuel Cruz');
    const b = await ctx.api.post('/api/hr/employees').set(A()).send({ employee_no: 'RN-B', name: 'Sam Cruz', daily_rate: 600 });
    const { payslipOwnerResolver } = await import('../src/modules/payroll/payslip-owner');
    const owner = payslipOwnerResolver();
    expect(owner.idOf({ employee_name: 'Sam Cruz' })).toBeNull(); // either employee may own a legacy slip
    expect(owner.idOf({ employee_name: 'Sam Cruz', employee_id: a.body.id })).toBe(a.body.id); // stamped id wins
    expect(owner.idOf({ employee_name: 'Sam Cruz', employee_id: b.body.id })).toBe(b.body.id);
    expect(owner.nameOf({ employee_name: 'Unknown Person' })).toBe('Unknown Person');
  });
});
