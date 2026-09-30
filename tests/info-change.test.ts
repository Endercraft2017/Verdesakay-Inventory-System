/** Employee information-change requests (form slug `information_change`): filed through the
 *  universal request flow, validated + snapshotted server-side, decided only by hr.manage in
 *  /api/me/approvals, applied to the employee record atomically on approval. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';
// Dynamic import after setupApp() sets DB_PATH (see helpers.ts).
let queryOne: typeof import('../src/shared/db').queryOne;
let queryAll: typeof import('../src/shared/db').queryAll;
let run: typeof import('../src/shared/db').run;

let ctx: TestContext;
let adminToken: string;
let formId: number;
const A = () => ({ Authorization: `Bearer ${adminToken}` });
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

async function linkedEmployee(opts: { role?: string; departmentId?: number | null; name?: string } = {}) {
  const acc = await createEmployee(ctx.api, adminToken, { role: opts.role || 'csr', department_id: opts.departmentId ?? null });
  const name = opts.name || 'Emp ' + acc.username.toUpperCase();
  const emp = await ctx.api.post('/api/hr/employees').set(A()).send({
    employee_no: 'IC' + Math.floor(Math.random() * 1e6), name, user_id: acc.id,
    department_id: opts.departmentId ?? null, daily_rate: 500, sss_no: '1111111111',
  });
  if (emp.status !== 201) throw new Error(JSON.stringify(emp.body));
  return { ...acc, empId: emp.body.id as number, name };
}

const file = (token: string, data: Record<string, unknown>, status = 'pending') =>
  ctx.api.post('/api/form-records').set(bearer(token)).send({ form_def_id: formId, data, status });
const decide = (token: string, id: number, decision: string, note?: string) =>
  ctx.api.post(`/api/me/approvals/requests/${id}/decide`).set(bearer(token)).send({ decision, note });

beforeAll(async () => {
  ctx = await setupApp();
  ({ queryOne, queryAll, run } = await import('../src/shared/db'));
  adminToken = await login(ctx.api);
});
afterAll(() => cleanup(ctx));

describe('information_change request type', () => {
  it('is offered to every employee, with options matching the server rules', async () => {
    const emp = await linkedEmployee();
    const types = await ctx.api.get('/api/me/request-types').set(bearer(emp.token));
    const t = types.body.find((x: { slug: string }) => x.slug === 'information_change');
    expect(t).toBeTruthy();
    formId = t.id;
    const { INFO_CHANGE_FIELDS } = await import('../src/modules/hr/info-change');
    const select = t.fields.find((f: { key: string }) => f.key === 'field');
    expect(select.options).toEqual(Object.keys(INFO_CHANGE_FIELDS));
    // No keys the mobile form would auto-fill/hide from the employee's own record.
    expect(t.fields.map((f: { key: string }) => f.key)).not.toContain('position');
  });

  it('stores the filer as the subject and snapshots the current value, ignoring client claims', async () => {
    const emp = await linkedEmployee();
    const r = await file(emp.token, {
      employee_name: 'Somebody Else', employee_id: 1, current_value: 'forged',
      field: 'SSS number', requested_value: '34-1234567-8', reason: 'Typo on my record, see E-1 form',
    }, 'approved');
    expect(r.status).toBe(201);
    const rec = queryOne<{ status: string; data: string }>('SELECT status, data FROM form_records WHERE id = ?', r.body.id)!;
    expect(rec.status).toBe('pending');
    expect(JSON.parse(rec.data)).toMatchObject({
      employee_name: emp.name, employee_id: emp.empId, field: 'SSS number',
      requested_value: '34-1234567-8', current_value: '1111111111',
    });
    // Nothing on the record changes before approval.
    expect(queryOne<{ sss_no: string }>('SELECT sss_no FROM employees WHERE id = ?', emp.empId)!.sss_no).toBe('1111111111');
  });

  it('validates the request server-side', async () => {
    const emp = await linkedEmployee();
    const bad = [
      { field: 'Salary', requested_value: '1000000', reason: 'please' },
      { field: 'SSS number', requested_value: '12', reason: 'typo on record' },
      { field: 'SSS number', requested_value: '1111111111', reason: 'same as now' },
      { field: 'Legal name', requested_value: '', reason: 'typo on record' },
      { field: 'Legal name', requested_value: 'Ana Cruz', reason: '' },
    ];
    for (const data of bad) expect((await file(emp.token, data)).status).toBe(400);
    const unlinked = await createEmployee(ctx.api, adminToken, { role: 'csr' });
    expect((await file(unlinked.token, { field: 'TIN', requested_value: '123456789', reason: 'new TIN issued' })).status).toBe(403);
  });

  it('is decided only by hr.manage — not department heads, not the filer, not the generic record editor', async () => {
    const d = await ctx.api.post('/api/users/departments').set(A()).send({ name: 'IC Dept ' + Math.random() });
    const head = await linkedEmployee({ departmentId: d.body.id });
    await ctx.api.put('/api/users/departments/' + d.body.id).set(A()).send({ name: 'IC Dept ' + Math.random(), head_user_id: head.id });
    const member = await linkedEmployee({ departmentId: d.body.id });
    const hr = await linkedEmployee({ role: 'hr' });
    const r = await file(member.token, { field: 'TIN', requested_value: '123-456-789', reason: 'BIR issued a TIN' });

    const headQueue = await ctx.api.get('/api/me/approvals').set(bearer(head.token));
    expect(headQueue.body.requests.map((x: { id: number }) => x.id)).not.toContain(r.body.id);
    expect((await decide(head.token, r.body.id, 'approved')).status).toBe(403);
    expect((await decide(member.token, r.body.id, 'approved')).status).toBe(403);
    // HR's generic Data Forms edit can't approve (or rewrite) it either.
    const put = await ctx.api.put(`/api/form-records/${r.body.id}`).set(bearer(hr.token)).send({ data: { field: 'TIN', requested_value: '999999999' }, status: 'approved' });
    expect(put.status).toBe(400);
    expect(queryOne<{ status: string }>('SELECT status FROM form_records WHERE id = ?', r.body.id)!.status).toBe('pending');

    const hrQueue = await ctx.api.get('/api/me/approvals').set(bearer(hr.token));
    const item = hrQueue.body.requests.find((x: { id: number }) => x.id === r.body.id);
    expect(item.data).toMatchObject({ field: 'TIN', requested_value: '123-456-789' });

    const ok = await decide(hr.token, r.body.id, 'approved');
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'approved', applied: true });
    expect(queryOne<{ tin_no: string }>('SELECT tin_no FROM employees WHERE id = ?', member.empId)!.tin_no).toBe('123-456-789');
    expect(queryAll('SELECT id FROM employee_profile_changes WHERE employee_id = ? AND source = ?', member.empId, 'info_change')).toHaveLength(1);
    expect((await decide(hr.token, r.body.id, 'approved')).status).toBe(400); // no double apply
  });

  it('applies an approved legal-name change and keeps the older payslips visible', async () => {
    const emp = await linkedEmployee({ name: 'Maria Old-Name' });
    const hr = await linkedEmployee({ role: 'hr' });
    const payForm = queryOne<{ id: number }>("SELECT id FROM form_definitions WHERE slug = 'hr_payroll'")!;
    run("INSERT INTO form_records (form_def_id, number, data, status, period) VALUES (?, 'PAY-IC-1', ?, 'paid', 'Sep 1-15')",
      payForm.id, JSON.stringify({ employee_name: 'Maria Old-Name', payroll_period: 'Sep 1-15', net_pay: 5000 }));

    const r = await file(emp.token, { field: 'Legal name', requested_value: 'Maria  New-Name', reason: 'Married — PSA certificate attached to HR' });
    expect(r.status).toBe(201);
    const ok = await decide(hr.token, r.body.id, 'approved', 'Checked PSA copy');
    expect(ok.body.applied).toBe(true);
    expect(queryOne<{ name: string }>('SELECT name FROM employees WHERE id = ?', emp.empId)!.name).toBe('Maria New-Name');
    const slips = await ctx.api.get('/api/me/payslips').set(bearer(emp.token));
    expect(slips.body.map((s: { number: string }) => s.number)).toContain('PAY-IC-1');
    const mine = await ctx.api.get('/api/me/requests').set(bearer(emp.token));
    expect(mine.body.find((x: { id: number }) => x.id === r.body.id)).toMatchObject({ status: 'approved' });
  });

  it('refuses a name another employee already has, leaving the request pending', async () => {
    await linkedEmployee({ name: 'Taken Name' });
    const emp = await linkedEmployee();
    const hr = await linkedEmployee({ role: 'hr' });
    const r = await file(emp.token, { field: 'Legal name', requested_value: 'Taken Name', reason: 'Correct spelling' });
    expect((await decide(hr.token, r.body.id, 'approved')).status).toBe(409);
    expect(queryOne<{ status: string }>('SELECT status FROM form_records WHERE id = ?', r.body.id)!.status).toBe('pending');
    expect(queryOne<{ name: string }>('SELECT name FROM employees WHERE id = ?', emp.empId)!.name).toBe(emp.name);
  });

  it('applies an approved civil status and birth date to the employee record', async () => {
    const emp = await linkedEmployee();
    const hr = await linkedEmployee({ role: 'hr' });
    const cs = await file(emp.token, { field: 'Civil status', requested_value: '  legally   SEPARATED ', reason: 'Court decree issued' });
    expect(cs.status).toBe(201);
    expect(JSON.parse(queryOne<{ data: string }>('SELECT data FROM form_records WHERE id = ?', cs.body.id)!.data))
      .toMatchObject({ requested_value: 'Legally separated', current_value: null });
    expect(await decide(hr.token, cs.body.id, 'approved')).toMatchObject({ body: { applied: true, applied_note: null } });

    const bd = await file(emp.token, { field: 'Birth date', requested_value: '1990-02-28', reason: 'Per PSA birth certificate' });
    expect((await decide(hr.token, bd.body.id, 'approved')).body.applied).toBe(true);

    expect(queryOne('SELECT birth_date, civil_status FROM employees WHERE id = ?', emp.empId))
      .toEqual({ birth_date: '1990-02-28', civil_status: 'Legally separated' });
    const hist = queryAll<{ field: string; old_value: string | null; new_value: string }>(
      "SELECT field, old_value, new_value FROM employee_profile_changes WHERE employee_id = ? AND source = 'info_change' ORDER BY id", emp.empId
    );
    expect(hist).toEqual([
      { field: 'civil_status', old_value: null, new_value: 'Legally separated' },
      { field: 'birth_date', old_value: null, new_value: '1990-02-28' },
    ]);
    // A second request now snapshots the stored value, and "no change" is refused.
    expect((await file(emp.token, { field: 'Civil status', requested_value: 'Legally separated', reason: 'Same again' })).status).toBe(400);
  });

  it('validates civil status and birth date values', async () => {
    const emp = await linkedEmployee();
    const bad = [
      { field: 'Civil status', requested_value: 'Complicated', reason: 'It is complicated' },
      { field: 'Birth date', requested_value: '1990-02-30', reason: 'Per PSA certificate' },
      { field: 'Birth date', requested_value: '28/02/1990', reason: 'Per PSA certificate' },
      { field: 'Birth date', requested_value: new Date().toISOString().slice(0, 10), reason: 'Per PSA certificate' },
    ];
    for (const data of bad) expect((await file(emp.token, data)).status).toBe(400);
  });

  it('still leaves "Other official record" for HR to action by hand, and says so', async () => {
    const emp = await linkedEmployee();
    const hr = await linkedEmployee({ role: 'hr' });
    const r = await file(emp.token, { field: 'Other official record', requested_value: 'Blood type O+', reason: 'Company ID shows A+' });
    const ok = await decide(hr.token, r.body.id, 'approved');
    expect(ok.body).toMatchObject({ applied: false });
    expect(ok.body.applied_note).toMatch(/by hand/);
  });

  it('HR can set birth date / civil status on the employee form; omitting them leaves them unchanged', async () => {
    const emp = await linkedEmployee();
    const current = queryOne<Record<string, unknown>>('SELECT employee_no, name, user_id FROM employees WHERE id = ?', emp.empId)!;
    const put = (extra: Record<string, unknown>) => ctx.api.put(`/api/hr/employees/${emp.empId}`).set(A())
      .send({ employee_no: current.employee_no, name: current.name, user_id: current.user_id, daily_rate: 500, sss_no: '1111111111', ...extra });
    expect((await put({ birth_date: '1985-06-15', civil_status: 'Married' })).status).toBe(200);
    expect((await put({})).status).toBe(200); // e.g. an older client — must not wipe them
    expect(queryOne('SELECT birth_date, civil_status FROM employees WHERE id = ?', emp.empId))
      .toEqual({ birth_date: '1985-06-15', civil_status: 'Married' });
    expect((await put({ civil_status: 'Engaged' })).status).toBe(400);
    expect((await put({ birth_date: '2099-01-01' })).status).toBe(400);
    expect((await put({ birth_date: '', civil_status: '' })).status).toBe(200); // cleared on purpose
    expect(queryOne('SELECT birth_date, civil_status FROM employees WHERE id = ?', emp.empId))
      .toEqual({ birth_date: null, civil_status: null });
    const hist = queryAll<{ field: string }>(
      "SELECT field FROM employee_profile_changes WHERE employee_id = ? AND source = 'hr_edit' ORDER BY id", emp.empId
    ).map((h) => h.field);
    expect(hist).toEqual(['birth_date', 'civil_status', 'birth_date', 'civil_status']);
  });

  it('a rejection changes nothing, and the filer can still cancel a pending one', async () => {
    const emp = await linkedEmployee();
    const hr = await linkedEmployee({ role: 'hr' });
    const r1 = await file(emp.token, { field: 'SSS number', requested_value: '2222222222', reason: 'typo on record' });
    expect((await decide(hr.token, r1.body.id, 'rejected', 'Need the E-1 form')).body.status).toBe('rejected');
    expect(queryOne<{ sss_no: string }>('SELECT sss_no FROM employees WHERE id = ?', emp.empId)!.sss_no).toBe('1111111111');
    const r2 = await file(emp.token, { field: 'SSS number', requested_value: '3333333333', reason: 'typo on record' });
    expect((await ctx.api.post(`/api/me/requests/${r2.body.id}/cancel`).set(bearer(emp.token))).body.status).toBe('cancelled');
  });
});
