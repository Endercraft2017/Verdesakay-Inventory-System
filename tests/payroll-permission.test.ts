/** Pay split from HR records (src/modules/payroll/pay-access.ts): hr.view / hr.manage cover
    employees and timekeeping; payroll.view / payroll.manage are needed to see or change pay. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';

let ctx: TestContext;
let admin: string;
let clerk: string;         // timekeeping clerk: HR records, no pay
let payViewer: string;     // payroll.view only (no HR records, no forms.manage.hr)
let empId: number;
let payrollFormId: number;
let payslipId: number;
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  ctx = await setupApp();
  admin = await login(ctx.api);
  await ctx.api.post('/api/roles').set(auth(admin))
    .send({ key:'hr_clerk_test', label: 'HR Clerk Test', permissions: ['mobile.access', 'hr.view', 'hr.manage', 'forms.view', 'forms.manage.hr'] });
  await ctx.api.post('/api/roles').set(auth(admin))
    .send({ label: 'Pay Viewer', permissions: ['mobile.access', 'payroll.view'] });
  clerk = (await createEmployee(ctx.api, admin, { username: 'tk.clerk', role: 'hr_clerk_test' })).token;
  payViewer = (await createEmployee(ctx.api, admin, { username: 'pay.viewer', role: 'pay_viewer' })).token;

  const emp = await ctx.api.post('/api/hr/employees').set(auth(admin))
    .send({ employee_no: 'PAY-1', name: 'Rate Person', rate_type: 'daily', daily_rate: 750 });
  expect(emp.status).toBe(201);
  empId = Number(emp.body.id);

  const forms = await ctx.api.get('/api/form-definitions').set(auth(admin));
  payrollFormId = forms.body.find((f: { slug: string }) => f.slug === 'hr_payroll').id;
  const slip = await ctx.api.post('/api/form-records').set(auth(admin))
    .send({ form_def_id: payrollFormId, data: { employee_name: 'Rate Person', net_pay: 5000 }, status: 'completed' });
  expect(slip.status).toBe(201);
  payslipId = slip.body.id;
});
afterAll(() => cleanup(ctx));

describe('HR records without pay', () => {
  it('lists employees without rates or pay settings', async () => {
    const res = await ctx.api.get('/api/hr/employees').set(auth(clerk));
    expect(res.status).toBe(200);
    const row = res.body.find((e: { id: number }) => e.id === empId);
    expect(row.name).toBe('Rate Person');
    expect(row.pay_hidden).toBe(true);
    for (const f of ['daily_rate', 'monthly_rate', 'rate_type', 'deduct_sss', 'sss_override', 'contribution_basis']) {
      expect(row, f).not.toHaveProperty(f);
    }
    const mine = await ctx.api.get('/api/hr/employees').set(auth(admin));
    expect(mine.body.find((e: { id: number }) => e.id === empId).daily_rate).toBe(750);
  });

  it('exports the 201 file without the rate columns', async () => {
    const res = await ctx.api.get('/api/hr/employees/export').set(auth(clerk));
    expect(res.status).toBe(200);
    const header = res.text.split(/\r?\n/)[0];
    expect(header).toContain('employee_no');
    expect(header).not.toContain('daily_rate');
  });

  it('saving an employee keeps the stored pay, whatever the form sends', async () => {
    const res = await ctx.api.put(`/api/hr/employees/${empId}`).set(auth(clerk))
      .send({ employee_no: 'PAY-1', name: 'Rate Person', position: 'Welder', rate_type: 'daily', daily_rate: 1 });
    expect(res.status).toBe(200);
    const row = (await ctx.api.get('/api/hr/employees').set(auth(admin))).body.find((e: { id: number }) => e.id === empId);
    expect(row.position).toBe('Welder');
    expect(row.daily_rate).toBe(750);
    const history = await ctx.api.get(`/api/hr/employees/${empId}/rate-history`).set(auth(admin));
    expect(history.body.length).toBe(1); // no rate change logged from the clerk's save
  });

  it('a new employee from the clerk starts with no pay set', async () => {
    const res = await ctx.api.post('/api/hr/employees').set(auth(clerk))
      .send({ employee_no: 'PAY-2', name: 'New Hire', rate_type: 'daily', daily_rate: 999 });
    expect(res.status).toBe(201);
    const row = (await ctx.api.get('/api/hr/employees').set(auth(admin))).body.find((e: { id: number }) => e.id === Number(res.body.id));
    expect(row.daily_rate).toBe(0);
  });

  it('refuses pay screens and payroll runs', async () => {
    const h = auth(clerk);
    expect((await ctx.api.get('/api/hr/payroll-tables').set(h)).status).toBe(403);
    expect((await ctx.api.get('/api/hr/thirteenth-month?year=2026').set(h)).status).toBe(403);
    expect((await ctx.api.get(`/api/hr/employees/${empId}/rate-history`).set(h)).status).toBe(403);
    expect((await ctx.api.put('/api/hr/payroll-policy').set(h).send({ grace_minutes: 5 })).status).toBe(403);
    expect((await ctx.api.post(`/api/hr/payroll/${payslipId}/mark-paid`).set(h)).status).toBe(403);
    // Timekeeping itself still works.
    expect((await ctx.api.get('/api/hr/payroll-policy').set(h)).status).toBe(200);
    expect((await ctx.api.get('/api/hr/periods').set(h)).status).toBe(200);
  });

  it("can't read payslips through Data Forms, even with the HR form section", async () => {
    expect((await ctx.api.get(`/api/form-definitions/${payrollFormId}/records`).set(auth(clerk))).status).toBe(403);
    expect((await ctx.api.get(`/api/form-records/${payslipId}`).set(auth(clerk))).status).toBe(403);
    expect((await ctx.api.post('/api/form-records').set(auth(clerk))
      .send({ form_def_id: payrollFormId, data: { employee_name: 'X' } })).status).toBe(403);
  });

  it('gets no payroll section on the dashboards', async () => {
    const res = await ctx.api.get('/api/analytics/overview').set(auth(clerk));
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('payroll');
  });
});

describe('payroll.view without HR records', () => {
  it('reads payslips but cannot change them', async () => {
    const list = await ctx.api.get(`/api/form-definitions/${payrollFormId}/records`).set(auth(payViewer));
    expect(list.status).toBe(200);
    expect(list.body.map((r: { id: number }) => r.id)).toContain(payslipId);
    expect((await ctx.api.get(`/api/form-records/${payslipId}`).set(auth(payViewer))).status).toBe(200);
    expect((await ctx.api.put(`/api/form-records/${payslipId}`).set(auth(payViewer))
      .send({ data: { employee_name: 'Rate Person', net_pay: 1 } })).status).toBe(403);
    expect((await ctx.api.delete(`/api/form-records/${payslipId}`).set(auth(payViewer))).status).toBe(403);
  });
});

describe('HR and payroll roles are separate', () => {
  it('HR accounts cannot see or run pay', async () => {
    const hr = (await createEmployee(ctx.api, admin, { username: 'hr.full', role: 'hr' })).token;
    const me = await ctx.api.get('/api/auth/me').set(auth(hr));
    expect(me.body.user.permissions).not.toContain('payroll.view');
    expect(me.body.user.permissions).not.toContain('payroll.manage');
    expect((await ctx.api.get('/api/hr/payroll-tables').set(auth(hr))).status).toBe(403);
  });

  it('the upgrade gives existing HR access the pay permissions once, and only once', async () => {
    const db = await import('../src/shared/db');
    const legacyHr = (await createEmployee(ctx.api, admin, { username: 'legacy.hr', role: 'warehouse' }));
    // A workspace from before the split: a role and a per-account grant with HR but no payroll.
    db.run(`INSERT INTO roles (key, label, permissions) VALUES ('old_hr', 'Old HR', ?)`, JSON.stringify(['hr.view', 'hr.manage']));
    db.run('UPDATE users SET permission_overrides = ? WHERE id = ?', JSON.stringify({ 'hr.view': true }), legacyHr.id);
    db.run("DELETE FROM settings WHERE key = 'migrated_payroll_permission_split'");
    db.forceMigrate(db.DEFAULT_TENANT);

    const role = db.queryOne<{ permissions: string }>("SELECT permissions FROM roles WHERE key = 'old_hr'")!;
    expect(JSON.parse(role.permissions)).toEqual(expect.arrayContaining(['payroll.view', 'payroll.manage']));
    const u = db.queryOne<{ permission_overrides: string }>('SELECT permission_overrides FROM users WHERE id = ?', legacyHr.id)!;
    expect(JSON.parse(u.permission_overrides)).toEqual({ 'hr.view': true, 'payroll.view': true });

    // An admin then takes pay away from the role; a later upgrade must not hand it back.
    db.run(`UPDATE roles SET permissions = ? WHERE key = 'old_hr'`, JSON.stringify(['hr.view', 'hr.manage']));
    db.forceMigrate(db.DEFAULT_TENANT);
    const after = db.queryOne<{ permissions: string }>("SELECT permissions FROM roles WHERE key = 'old_hr'")!;
    expect(JSON.parse(after.permissions)).toEqual(['hr.view', 'hr.manage']);
  });
});
