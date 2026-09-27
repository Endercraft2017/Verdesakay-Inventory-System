/** Employee payslip download — GET /api/me/payslips (finalized/download_url contract) and
 *  GET /api/me/payslips/:id/pdf (own payslip only, finalized = marked Paid, re-checked at
 *  download time, every download logged). */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';
// Dynamic import after setupApp() sets DB_PATH (see helpers.ts).
let queryOne: typeof import('../src/shared/db').queryOne;
let queryAll: typeof import('../src/shared/db').queryAll;
let run: typeof import('../src/shared/db').run;

let ctx: TestContext;
let adminToken: string;
let mine: { id: number; token: string };
let other: { id: number; token: string };
let unlinked: { id: number; token: string };
let draftId: number;
let paidId: number;
let othersPaidId: number;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

/** Binary-safe supertest GET. */
function getPdf(url: string, token: string) {
  return ctx.api.get(url).set(bearer(token)).buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
}

function slip(employee: string, period: string, status: string, number: string): number {
  const form = queryOne<{ id: number }>("SELECT id FROM form_definitions WHERE slug = 'hr_payroll'")!;
  const data = {
    employee_name: employee, dept_position: 'Assembly / Assembler', payroll_period: period, pay_date: '2026-09-30',
    daily_rate: 700, days_worked: 11, ot_hours: 3, basic_salary: 7700, overtime_pay: 328.13, total_earnings: 8028.13,
    sss: 350, philhealth: 192.5, pagibig: 100, withholding_tax: 0, late_absences: 45,
    other_deductions: [{ label: 'Uniform', amount: 150 }], total_deductions: 837.5, net_pay: 7190.63,
  };
  const info = run(
    'INSERT INTO form_records (form_def_id, number, data, status, period, created_by) VALUES (?, ?, ?, ?, ?, 1)',
    form.id, number, JSON.stringify(data), 'draft', period
  );
  const id = Number(info.lastInsertRowid);
  if (status === 'paid') run("UPDATE form_records SET status = 'paid' WHERE id = ?", id);
  return id;
}

beforeAll(async () => {
  ctx = await setupApp();
  ({ queryOne, queryAll, run } = await import('../src/shared/db'));
  adminToken = await login(ctx.api);
  mine = await createEmployee(ctx.api, adminToken, { role: 'csr' });
  other = await createEmployee(ctx.api, adminToken, { role: 'csr' });
  unlinked = await createEmployee(ctx.api, adminToken, { role: 'csr' });
  for (const [no, name, user] of [['PS-1', 'Pay Tester', mine.id], ['PS-2', 'Other Person', other.id]] as const) {
    const r = await ctx.api.post('/api/hr/employees').set(bearer(adminToken)).send({ employee_no: no, name, user_id: user, daily_rate: 700 });
    expect(r.status).toBe(201);
  }
  draftId = slip('Pay Tester', 'Sep 16-30, 2026', 'draft', 'PAY-T-2');
  paidId = slip('Pay Tester', 'Sep 1-15, 2026', 'draft', 'PAY-T-1');
  // Finalize through the real HR action, not a direct status write.
  expect((await ctx.api.post(`/api/hr/payroll/${paidId}/mark-paid`).set(bearer(adminToken))).status).toBe(200);
  othersPaidId = slip('Other Person', 'Sep 1-15, 2026', 'paid', 'PAY-O-1');
});
afterAll(() => cleanup(ctx));

describe('payslip list contract', () => {
  it('marks only Paid payslips finalized and gives only those a download_url', async () => {
    const r = await ctx.api.get('/api/me/payslips').set(bearer(mine.token));
    expect(r.status).toBe(200);
    const byId = Object.fromEntries(r.body.map((p: { id: number }) => [p.id, p]));
    expect(byId[draftId]).toMatchObject({ finalized: false, finalized_at: null, download_url: null });
    expect(byId[paidId]).toMatchObject({ finalized: true, download_url: `/me/payslips/${paidId}/pdf` });
    expect(byId[paidId].finalized_at).toBeTruthy();
    expect(byId[othersPaidId]).toBeUndefined();
  });
});

describe('payslip PDF download', () => {
  it('serves a well-formed PDF of your finalized payslip and logs the download', async () => {
    const r = await getPdf(`/api/me/payslips/${paidId}/pdf`, mine.token);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/pdf');
    expect(r.headers['content-disposition']).toContain('Payslip-PAY-T-1.pdf');
    expect(r.headers['cache-control']).toContain('no-store');
    const pdf = r.body as Buffer;
    const text = pdf.toString('latin1');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain('(Pay Tester)');
    expect(text).toContain('(NET PAY)');
    expect(text).toContain('(PHP 7,190.63)');
    expect(text).toContain('(Uniform)');
    // xref offsets point at their objects.
    const startxref = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(startxref, startxref + 4)).toBe('xref');
    const offsets = [...text.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    offsets.forEach((o, i) => expect(text.slice(o, o + String(i + 1).length + 6)).toBe(`${i + 1} 0 obj`));

    const log = queryAll<{ user_id: number; action: string; entity_id: string }>(
      "SELECT user_id, action, entity_id FROM activity_log WHERE action = 'payslip-download'"
    );
    expect(log).toContainEqual({ user_id: mine.id, action: 'payslip-download', entity_id: String(paidId) });
  });

  it('refuses a draft (not finalized) payslip', async () => {
    const r = await ctx.api.get(`/api/me/payslips/${draftId}/pdf`).set(bearer(mine.token));
    expect(r.status).toBe(409);
  });

  it("answers another employee's payslip exactly like a missing one", async () => {
    const theirs = await ctx.api.get(`/api/me/payslips/${othersPaidId}/pdf`).set(bearer(mine.token));
    const missing = await ctx.api.get('/api/me/payslips/999999/pdf').set(bearer(mine.token));
    expect(theirs.status).toBe(404);
    expect(theirs.body).toEqual(missing.body);
    expect((await getPdf(`/api/me/payslips/${othersPaidId}/pdf`, other.token)).status).toBe(200);
  });

  it('re-checks finalization at download time (un-marking Paid blocks it again)', async () => {
    expect((await ctx.api.post(`/api/hr/payroll/${paidId}/unmark-paid`).set(bearer(adminToken))).status).toBe(200);
    expect((await ctx.api.get(`/api/me/payslips/${paidId}/pdf`).set(bearer(mine.token))).status).toBe(409);
    const list = await ctx.api.get('/api/me/payslips').set(bearer(mine.token));
    expect(list.body.find((p: { id: number }) => p.id === paidId)).toMatchObject({ finalized: false, download_url: null });
    await ctx.api.post(`/api/hr/payroll/${paidId}/mark-paid`).set(bearer(adminToken));
  });

  it('requires a signed-in account linked to an employee', async () => {
    expect((await ctx.api.get(`/api/me/payslips/${paidId}/pdf`)).status).toBe(401);
    expect((await ctx.api.get(`/api/me/payslips/${paidId}/pdf`).set(bearer(unlinked.token))).status).toBe(403);
  });
});
