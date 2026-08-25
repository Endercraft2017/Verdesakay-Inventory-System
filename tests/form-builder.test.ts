/** Form builder: form definition CRUD, record CRUD, global variables, auth & permissions. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';

let ctx: TestContext;
let adminToken: string;
let empToken: string;
const hdr = (tok: string) => ({ Authorization: `Bearer ${tok}` });

const sampleForm = {
  name: 'Leave Request',
  slug: 'leave_request',
  number_prefix: 'LR',
  icon: 'file',
  fields: [
    { key: 'reason', label: 'Reason', type: 'text', required: true, options: [], default: '' },
    { key: 'days', label: 'Days', type: 'number', required: true, options: [], default: '1' },
    { key: 'leave_type', label: 'Type', type: 'select', required: false, options: ['Sick', 'Vacation'], default: '' },
  ],
};

beforeAll(async () => {
  ctx = await setupApp();
  adminToken = await login(ctx.api);
  const emp = await createEmployee(ctx.api, adminToken, { role: 'warehouse' });
  empToken = emp.token;
});
afterAll(() => cleanup(ctx));

// ─── Form Definitions ───────────────────────────────────────────────────────

describe('form definitions', () => {
  let formId: number;

  it('requires auth to list', async () => {
    expect((await ctx.api.get('/api/form-definitions')).status).toBe(401);
  });

  it('any user can list form definitions (empty at start)', async () => {
    const res = await ctx.api.get('/api/form-definitions').set(hdr(empToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('employee cannot create a form definition (403)', async () => {
    const res = await ctx.api.post('/api/form-definitions').set(hdr(empToken)).send(sampleForm);
    expect(res.status).toBe(403);
  });

  it('admin can create a form definition', async () => {
    const res = await ctx.api.post('/api/form-definitions').set(hdr(adminToken)).send(sampleForm);
    expect(res.status).toBe(201);
    formId = res.body.id;
    expect(typeof formId).toBe('number');
  });

  it('detail returns parsed fields array', async () => {
    const res = await ctx.api.get('/api/form-definitions/' + formId).set(hdr(empToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.fields)).toBe(true);
    expect(res.body.fields).toHaveLength(3);
    expect(res.body.fields[0].key).toBe('reason');
  });

  it('list includes record_count', async () => {
    const res = await ctx.api.get('/api/form-definitions').set(hdr(empToken));
    const form = res.body.find((f: { id: number }) => f.id === formId);
    expect(form).toBeDefined();
    expect(form.record_count).toBe(0);
  });

  it('rejects duplicate slug', async () => {
    const res = await ctx.api.post('/api/form-definitions').set(hdr(adminToken)).send(sampleForm);
    expect(res.status).toBe(500); // UNIQUE constraint
  });

  it('admin can update the form definition', async () => {
    const updated = { ...sampleForm, name: 'Leave Request v2' };
    const res = await ctx.api.put('/api/form-definitions/' + formId).set(hdr(adminToken)).send(updated);
    expect(res.status).toBe(200);
    const detail = await ctx.api.get('/api/form-definitions/' + formId).set(hdr(empToken));
    expect(detail.body.name).toBe('Leave Request v2');
  });

  it('employee cannot update a form definition (403)', async () => {
    const res = await ctx.api.put('/api/form-definitions/' + formId).set(hdr(empToken)).send(sampleForm);
    expect(res.status).toBe(403);
  });

  // Records + delete tests follow so we reuse formId.
  it('stores formId for later tests', () => { expect(formId).toBeGreaterThan(0); });
});

// ─── Form Records ────────────────────────────────────────────────────────────

describe('form records', () => {
  let formId: number;
  let recordId: number;

  beforeAll(async () => {
    // Create a fresh form for record tests.
    const res = await ctx.api.post('/api/form-definitions').set(hdr(adminToken)).send({
      name: 'Expense Report', slug: 'expense_report', number_prefix: 'ER', icon: 'file',
      fields: [
        { key: 'amount', label: 'Amount', type: 'number', required: true, options: [], default: '' },
        { key: 'description', label: 'Description', type: 'text', required: false, options: [], default: '' },
      ],
    });
    formId = res.body.id;
  });

  it('any user can create a record', async () => {
    const res = await ctx.api.post('/api/form-records').set(hdr(empToken)).send({
      form_def_id: formId,
      data: { amount: 500, description: 'Office supplies' },
      status: 'submitted',
    });
    expect(res.status).toBe(201);
    expect(res.body.number).toMatch(/^ER-\d{5}$/);
    recordId = res.body.id;
  });

  it('auto-numbers increment per form', async () => {
    const r2 = await ctx.api.post('/api/form-records').set(hdr(empToken)).send({
      form_def_id: formId,
      data: { amount: 100 },
    });
    const r3 = await ctx.api.post('/api/form-records').set(hdr(empToken)).send({
      form_def_id: formId,
      data: { amount: 200 },
    });
    const num2 = Number(r2.body.number.split('-')[1]);
    const num3 = Number(r3.body.number.split('-')[1]);
    expect(num3).toBe(num2 + 1);
  });

  it('GET /form-definitions/:id/records lists records for the form', async () => {
    const res = await ctx.api.get('/api/form-definitions/' + formId + '/records').set(hdr(empToken));
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    expect(res.body[0].data).toEqual(expect.objectContaining({ amount: expect.anything() }));
  });

  it('GET /form-records/:id returns parsed data', async () => {
    const res = await ctx.api.get('/api/form-records/' + recordId).set(hdr(empToken));
    expect(res.status).toBe(200);
    expect(res.body.data.amount).toBe(500);
    expect(res.body.data.description).toBe('Office supplies');
    expect(res.body.form_name).toBe('Expense Report');
  });

  it('can update a record (data + status)', async () => {
    const res = await ctx.api.put('/api/form-records/' + recordId).set(hdr(empToken))
      .send({ data: { amount: 750, description: 'Updated' }, status: 'approved' });
    expect(res.status).toBe(200);
    const detail = await ctx.api.get('/api/form-records/' + recordId).set(hdr(empToken));
    expect(detail.body.data.amount).toBe(750);
    expect(detail.body.status).toBe('approved');
  });

  it('rejects a record for a non-existent form', async () => {
    const res = await ctx.api.post('/api/form-records').set(hdr(empToken))
      .send({ form_def_id: 99999, data: {} });
    expect(res.status).toBe(404);
  });

  it('can delete a record', async () => {
    const res = await ctx.api.delete('/api/form-records/' + recordId).set(hdr(empToken));
    expect(res.status).toBe(200);
    expect((await ctx.api.get('/api/form-records/' + recordId).set(hdr(empToken))).status).toBe(404);
  });

  it('deleting a form cascades its records', async () => {
    const r = await ctx.api.post('/api/form-records').set(hdr(empToken))
      .send({ form_def_id: formId, data: { amount: 1 } });
    expect(r.status).toBe(201);
    await ctx.api.delete('/api/form-definitions/' + formId).set(hdr(adminToken));
    expect((await ctx.api.get('/api/form-records/' + r.body.id).set(hdr(empToken))).status).toBe(404);
  });
});

// ─── Global Variables ─────────────────────────────────────────────────────────

describe('global variables', () => {
  it('any user can list global variables', async () => {
    const res = await ctx.api.get('/api/global-variables').set(hdr(empToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('employee cannot upsert a global variable (403)', async () => {
    const res = await ctx.api.put('/api/global-variables/company_tin')
      .set(hdr(empToken)).send({ label: 'TIN', value: '123' });
    expect(res.status).toBe(403);
  });

  it('admin can create a global variable', async () => {
    const res = await ctx.api.put('/api/global-variables/company_tin')
      .set(hdr(adminToken)).send({ label: 'Company TIN', value: '123-456-789' });
    expect(res.status).toBe(200);
  });

  it('global variable appears in list', async () => {
    const res = await ctx.api.get('/api/global-variables').set(hdr(empToken));
    const v = res.body.find((x: { key: string }) => x.key === 'company_tin');
    expect(v).toBeDefined();
    expect(v.value).toBe('123-456-789');
  });

  it('admin can update a global variable value', async () => {
    await ctx.api.put('/api/global-variables/company_tin')
      .set(hdr(adminToken)).send({ label: 'Company TIN', value: '000-111-222' });
    const res = await ctx.api.get('/api/global-variables').set(hdr(empToken));
    const v = res.body.find((x: { key: string }) => x.key === 'company_tin');
    expect(v.value).toBe('000-111-222');
  });

  it('rejects a key with invalid characters', async () => {
    const res = await ctx.api.put('/api/global-variables/My%20Key')
      .set(hdr(adminToken)).send({ label: 'Bad', value: '' });
    expect(res.status).toBe(400);
  });

  it('admin can delete a global variable', async () => {
    await ctx.api.delete('/api/global-variables/company_tin').set(hdr(adminToken));
    const res = await ctx.api.get('/api/global-variables').set(hdr(empToken));
    expect(res.body.find((x: { key: string }) => x.key === 'company_tin')).toBeUndefined();
  });
});

// ─── HR Payroll CSV import ────────────────────────────────────────────────────

describe('hr payroll csv import', () => {
  let payrollFormId: number;

  // 46-column rows (matching the real "Summary" sheet's column count) built positionally
  // so the fixed offsets in src/hr-payroll-import.ts stay honest — see that test file's
  // row()/COL helpers for why this isn't hand-typed comma text.
  const COLS = 46;
  const COL = { no: 0, name: 1, totalDaysWork: 19, dailyRate: 24, hourlyRate: 25, otPay: 28, lateUndertimePay: 30, basicPay: 36, totalDeductions: 42, totalSalary: 43 };
  function csvRow(set: Record<number, string | number>): string {
    const cells = new Array(COLS).fill('');
    for (const [i, v] of Object.entries(set)) cells[Number(i)] = String(v);
    return cells.map((v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(',');
  }

  const SUMMARY_CSV = [
    'June 16-30  2026,,,SUMMARY JUNE 01 -15 2026',
    csvRow({ [COL.no]: 'No.', [COL.name]: 'Employee Name' }),
    csvRow({ [COL.no]: 'WAREHOUSE' }),
    csvRow({
      [COL.no]: 1, [COL.name]: 'Dela Cruz, Juan', [COL.totalDaysWork]: 13,
      [COL.dailyRate]: 600, [COL.hourlyRate]: 75, [COL.otPay]: 0, [COL.lateUndertimePay]: 3.3,
      [COL.basicPay]: 7800, [COL.totalDeductions]: 3.3, [COL.totalSalary]: 7796.7,
    }),
  ].join('\n');

  beforeAll(async () => {
    // The "HR Payroll" form is auto-seeded (src/db.ts seedHrPayrollForm()) rather than
    // hand-created, so it already exists — just look it up by slug.
    const forms = await ctx.api.get('/api/form-definitions').set(hdr(adminToken));
    payrollFormId = forms.body.find((f: { slug: string }) => f.slug === 'hr_payroll').id;
  });

  it('rejects import for a non-payroll form', async () => {
    const other = await ctx.api.post('/api/form-definitions').set(hdr(adminToken)).send(sampleForm2());
    const res = await ctx.api.post(`/api/form-definitions/${other.body.id}/import`)
      .set(hdr(adminToken)).attach('file', Buffer.from(SUMMARY_CSV), 'summary.csv');
    expect(res.status).toBe(400);
  });

  it('requires a file', async () => {
    const res = await ctx.api.post(`/api/form-definitions/${payrollFormId}/import`).set(hdr(adminToken));
    expect(res.status).toBe(400);
  });

  it('imports records from a summary CSV, stamping the given pay date', async () => {
    const res = await ctx.api.post(`/api/form-definitions/${payrollFormId}/import`)
      .set(hdr(adminToken)).field('pay_date', '2026-07-05').field('period', 'June 16-30 2026')
      .attach('file', Buffer.from(SUMMARY_CSV), 'summary.csv');
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(1);

    const records = await ctx.api
      .get(`/api/form-definitions/${payrollFormId}/records`)
      .set(hdr(empToken));
    expect(records.body).toHaveLength(1);
    expect(records.body[0].data.employee_name).toBe('Dela Cruz, Juan');
    expect(records.body[0].data.dept_position).toBe('WAREHOUSE');
    expect(records.body[0].data.daily_rate).toBe(600);
    expect(records.body[0].data.total_earnings).toBe(7800); // basic_salary from BASIC PAY column
    expect(records.body[0].data.net_pay).toBe(7796.7);
    expect(records.body[0].data.pay_date).toBe('2026-07-05');
    expect(records.body[0].status).toBe('completed');
    expect(records.body[0].number).toMatch(/^PAY-\d{5}$/);
  });

  it('404s for a non-existent form', async () => {
    const res = await ctx.api.post('/api/form-definitions/999999/import')
      .set(hdr(adminToken)).attach('file', Buffer.from(SUMMARY_CSV), 'summary.csv');
    expect(res.status).toBe(404);
  });

  function sampleForm2() {
    return {
      name: 'Overtime Request', slug: 'overtime_request', number_prefix: 'OT', icon: 'file',
      fields: [{ key: 'hours', label: 'Hours', type: 'number', required: true, options: [], default: '' }],
    };
  }
});
