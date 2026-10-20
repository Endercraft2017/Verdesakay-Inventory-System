import {beforeAll, afterAll, afterEach, it, expect} from 'vitest';
import {setupApp, cleanup, login, createEmployee, type TestContext} from './helpers';

let ctx: TestContext, token: string, accountant: string, clerk: string;
let db: typeof import('../src/shared/db');
let a: number, b: number, renamed: number, form: number, seq = 0;
const hdr = (t = token) => ({Authorization: `Bearer ${t}`});
beforeAll(async () => {
  ctx = await setupApp(); token = await login(ctx.api); db = await import('../src/shared/db');
  accountant = (await createEmployee(ctx.api, token, {role: 'accounting'})).token;
  clerk = (await createEmployee(ctx.api, token, {role: 'csr'})).token;
  function employee(no: string, name: string, tax: string, sss: string) {
    return Number(db.run('INSERT INTO employees(employee_no,name,tin_no,sss_no,philhealth_no,pagibig_no) VALUES(?,?,?,?,?,?)', no, name, tax, sss, 'PH-'+no, 'PI-'+no).lastInsertRowid);
  }
  a = employee('REPORT-A', 'Shared Report Name', 'TAX-A', 'SSS-A');
  b = employee('REPORT-B', 'Shared Report Name', 'TAX-B', 'SSS-B');
  renamed = employee('REPORT-C', 'Current Report Name', 'TAX-C', 'SSS-C');
  db.run("INSERT INTO employee_profile_changes(employee_id,field,old_value,new_value,source) VALUES(?,'name','Former Report Name','Current Report Name','hr_edit')", renamed);
  form = db.queryOne<{id: number}>("SELECT id FROM form_definitions WHERE slug='hr_payroll'")!.id;
});
afterEach(() => db.run("DELETE FROM form_records WHERE number LIKE 'REPORT-ID-%'"));
afterAll(() => cleanup(ctx));
function slip(extra: Record<string, unknown> = {}, period: string | null = null, raw?: string) {
  return Number(db.run("INSERT INTO form_records(form_def_id,number,data,status,period,created_by) VALUES(?,?,?,'paid',?,1)", form, 'REPORT-ID-'+(++seq), raw ?? JSON.stringify({employee_name: 'Shared Report Name', employee_id: a, pay_date: '2040-06-15', basic_salary: 12000, total_earnings: 12000, withholding_tax: 123, ...extra}), period).lastInsertRowid);
}
const get = (path: string, t = token) => ctx.api.get(path).set(hdr(t));
const routes = () => [
  '/api/accounting/bir-1601c?year=2040', '/api/accounting/bir-1604c?year=2040',
  '/api/accounting/bir-2316?year=2040', `/api/accounting/bir-2316/${a}?year=2040`,
  '/api/accounting/bir-alphalist?year=2040', '/api/accounting/contribution-schedule?month=2040-06',
  '/api/accounting/contribution-schedule?month=2040-06&format=csv',
  '/api/hr/thirteenth-month?year=2040', `/api/hr/final-pay/${a}?separation_date=2040-06-30`,
];
it('keeps same-name stamped employees separate in certificates, alphalist and headcount', async () => {
  slip(); slip({employee_id: String(b), basic_salary: 24000, total_earnings: 24000, withholding_tax: 456});
  const list = await get('/api/accounting/bir-2316?year=2040', accountant);
  expect(list.status).toBe(200); expect(list.body.rows).toHaveLength(2);
  expect(list.body.rows.find((r: any) => r.employee_id === a)).toMatchObject({tin_no: 'TAX-A', figures: {basic_salary: 12000, tax_withheld_present: 123, payslip_count: 1}});
  expect(list.body.rows.find((r: any) => r.employee_id === b)).toMatchObject({tin_no: 'TAX-B', figures: {basic_salary: 24000, tax_withheld_present: 456, payslip_count: 1}});
  const detail = await get(`/api/accounting/bir-2316/${b}?year=2040`, accountant);
  expect(detail.body.figures.basic_salary).toBe(24000);
  const al = await get('/api/accounting/bir-alphalist?year=2040');
  expect(al.body.rows.map((r: any) => r.tin).sort()).toEqual(['TAX-A', 'TAX-B']);
  const monthly = await get('/api/accounting/bir-1601c?year=2040');
  expect(monthly.body.months[5]).toMatchObject({employee_count: 2, gross_compensation: 36000, tax_withheld: 579});
  const annual = await get('/api/accounting/bir-1604c?year=2040');
  expect(annual.body.reconciliation.tax_withheld_per_alphalist).toBe(579);
});
it('keeps 13th-month and final-pay YTD amounts bound to employee ID', async () => {
  slip(); slip({employee_id: b, basic_salary: 24000, total_earnings: 24000});
  const t = await get('/api/hr/thirteenth-month?year=2040');
  expect(t.body.rows).toHaveLength(2);
  expect(t.body.rows.find((r: any) => r.employee_id === a)).toMatchObject({basic_total: 12000, amount: 1000, payslip_count: 1});
  const f = await get(`/api/hr/final-pay/${b}?separation_date=2040-06-30`);
  expect(f.body.inputs.ytd.basic_earned).toBe(24000);
});
it('keeps agency IDs and fund opt-outs attached to the right same-name employee', async () => {
  slip(); slip({employee_id: b, basic_salary: 24000, total_earnings: 24000});
  for (const [agency, ids] of [['sss', ['SSS-A', 'SSS-B']], ['philhealth', ['PH-REPORT-A', 'PH-REPORT-B']], ['pagibig', ['PI-REPORT-A', 'PI-REPORT-B']]] as const) {
    const r = await get(`/api/accounting/contribution-schedule?month=2040-06&agency=${agency}`);
    expect(r.body.rows.map((v: any) => v.id_number).sort()).toEqual([...ids]);
    expect(r.body.rows[0].basis).toBe(12000); expect(r.body.rows[1].basis).toBe(24000);
  }
  db.run('UPDATE employees SET deduct_sss=0 WHERE id=?', a);
  try {
    const r = await get('/api/accounting/contribution-schedule?month=2040-06&agency=sss&format=csv');
    expect(r.status).toBe(200); expect(r.text).toContain('SSS-B'); expect(r.text).not.toContain('SSS-A');
  } finally { db.run('UPDATE employees SET deduct_sss=1 WHERE id=?', a); }
});
it('combines unique legacy former names with stamped rows under the current employee identity', async () => {
  slip({employee_name: 'Former Report Name', employee_id: null});
  slip({employee_name: 'Arbitrary frozen display', employee_id: renamed});
  const r = await get('/api/accounting/bir-2316?year=2040');
  expect(r.status).toBe(200); expect(r.body.rows).toHaveLength(1);
  expect(r.body.rows[0]).toMatchObject({employee_id: renamed, employee_name: 'Current Report Name', tin_no: 'TAX-C', figures: {basic_salary: 24000, payslip_count: 2}});
});
it('blocks all affected reports and CSV instead of returning partial or guessed figures', async () => {
  slip(); const bad = slip({employee_id: null});
  for (const path of routes()) {
    const r = await get(path); expect(r.status, path).toBe(409);
    expect(r.headers['cache-control']).toContain('no-store');
    expect(r.type).toBe('application/json'); expect(r.body.error).toContain(String(bad));
    expect(r.body).not.toHaveProperty('rows'); expect(JSON.stringify(r.body)).not.toContain('TAX-A');
  }
});
it('blocks invalid or dangling authoritative stamps even if the display name is unique', async () => {
  for (const employee_id of ['broken', 999999, 0, {}, true, '01']) {
    const id = slip({employee_id, employee_name: 'Current Report Name'});
    const r = await get('/api/accounting/bir-2316?year=2040'); expect(r.status).toBe(409);
    db.run('DELETE FROM form_records WHERE id=?', id);
  }
});
it('does not block a known different pay year or cutoff month', async () => {
  slip(); slip({employee_id: null, pay_date: '2039-06-15'});
  expect((await get('/api/accounting/bir-2316?year=2040')).status).toBe(200);
  expect((await get('/api/accounting/contribution-schedule?month=2040-06')).status).toBe(200);
});
it('uses cutoff end for agency scope and pay date for annual scope', async () => {
  db.run("INSERT INTO attendance_periods(label,start_date,end_date) VALUES('REPORT-ID-CUTOFF','2039-12-16','2039-12-31')");
  try {
    slip({employee_id: null, pay_date: '2040-01-05'}, 'REPORT-ID-CUTOFF');
    expect((await get('/api/accounting/bir-2316?year=2040')).status).toBe(409);
    expect((await get('/api/accounting/contribution-schedule?month=2039-12')).status).toBe(409);
    expect((await get('/api/accounting/contribution-schedule?month=2040-01')).status).toBe(200);
  } finally { db.run("DELETE FROM attendance_periods WHERE label='REPORT-ID-CUTOFF'"); }
});
it('blocks unreadable data instead of skipping it or crashing', async () => {
  for (const raw of ['{broken', 'null', '[]', '7']) {
    const id = slip({}, null, raw);
    const r = await get('/api/accounting/bir-2316?year=2040'); expect(r.status).toBe(409);
    db.run('DELETE FROM form_records WHERE id=?', id);
  }
});
it('blocks referenced duplicate cutoff labels without multiplying contribution bases', async () => {
  for (let i = 0; i < 2; i++) db.run("INSERT INTO attendance_periods(label,start_date,end_date) VALUES('REPORT-ID-DUP','2040-06-01','2040-06-15')");
  try {
    slip({}, 'REPORT-ID-DUP');
    expect((await get('/api/accounting/contribution-schedule?month=2040-06')).status).toBe(409);
    expect((await get('/api/accounting/contribution-schedule?month=2040-07')).status).toBe(200);
    const annual = await get('/api/accounting/bir-2316?year=2040');
    expect(annual.status).toBe(200); expect(annual.body.rows[0].figures.basic_salary).toBe(12000);
    db.run("UPDATE attendance_periods SET end_date='2040-00-15' WHERE id=(SELECT MAX(id) FROM attendance_periods WHERE label='REPORT-ID-DUP')");
    expect((await get('/api/accounting/contribution-schedule?month=2040-07')).status).toBe(409);
  } finally { db.run("DELETE FROM attendance_periods WHERE label='REPORT-ID-DUP'"); }
});
it('blocks unknown names, missing ownership and unscopable dates without exposing raw values', async () => {
  for (const extra of [{employee_id: null, employee_name: 'PRIVATE UNKNOWN'}, {employee_id: null, employee_name: ''}, {employee_id: null, employee_name: {toString: 7}}, {pay_date: 'PRIVATE DATE'}]) {
    const id = slip(extra); const r = await get('/api/accounting/bir-2316?year=2040');
    expect(r.status).toBe(409); expect(r.body.error).toContain(String(id)); expect(r.text).not.toContain('PRIVATE');
    db.run('DELETE FROM form_records WHERE id=?', id);
  }
});
it('uses the last cutoff fixed basis per stable employee and preserves separate tax brackets', async () => {
  slip({basic_salary: 200000, total_earnings: 200000, statutory_basis: {basis: 'fixed', sss_compensation: 18000, pagibig_compensation: 8000, philhealth_monthly_basic: 18000}});
  slip({employee_id: b, basic_salary: 300000, total_earnings: 300000, statutory_basis: {basis: 'fixed', sss_compensation: 35000, pagibig_compensation: 10000, philhealth_monthly_basic: 35000}});
  const schedule = await get('/api/accounting/contribution-schedule?month=2040-06&agency=sss');
  expect(schedule.body.rows.map((v: any) => v.basis)).toEqual([18000,35000]);
  const list = await get('/api/accounting/bir-2316?year=2040');
  const annual = await get('/api/accounting/bir-1604c?year=2040');
  const due = list.body.rows.reduce((sum: number, v: any) => sum + v.figures.tax_due, 0);
  expect(annual.body.reconciliation.tax_due_per_alphalist).toBe(due);
  expect(due).toBeGreaterThan(0);
});
it('restores correct reports after the reviewed identity-only repair without changing money', async () => {
  slip(); const id = slip({employee_id: null});
  expect((await get('/api/accounting/bir-2316?year=2040')).status).toBe(409);
  (await import('../src/shared/step-up')).markFreshVerification(1, token);
  const revision = db.queryOne<{revision: number}>('SELECT revision FROM form_records WHERE id=?', id)!.revision;
  const review = await ctx.api.post(`/api/hr/payroll/${id}/identity/review`).set(hdr()).send({employee_id: b, expected_revision: revision, reason: 'Verified original employee documents', evidence_reference: 'REPORT-CASE-1', verified_records: true});
  expect(review.status).toBe(200);
  expect((await ctx.api.post(`/api/hr/payroll/${id}/identity/confirm`).set(hdr()).send({review_token: review.body.review_token})).status).toBe(200);
  const r = await get('/api/accounting/bir-2316?year=2040'); expect(r.status).toBe(200);
  expect(r.body.rows.map((v: any) => [v.employee_id, v.figures.basic_salary])).toEqual([[a,12000],[b,12000]]);
});
it('enforces permissions before revealing report blockers', async () => {
  slip({employee_id: null});
  for (const path of routes()) {
    expect((await ctx.api.get(path)).status).toBe(401);
    expect((await get(path, clerk)).status).toBe(403);
  }
});
