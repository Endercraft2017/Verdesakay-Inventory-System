import { beforeAll, afterAll, it, expect } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';
let ctx: TestContext, token: string, leaveId: number, seq = 0;
let queryOne: typeof import('../src/shared/db').queryOne, run: typeof import('../src/shared/db').run;
const hdr = (t = token) => ({ Authorization: `Bearer ${t}` });
beforeAll(async () => {
  ctx = await setupApp(); token = await login(ctx.api);
  ({ queryOne, run } = await import('../src/shared/db'));
  const defs = await ctx.api.get('/api/form-definitions').set(hdr());
  const leaveForm = await ctx.api.post('/api/form-definitions').set(hdr()).send({
    name: 'Leave Request', slug: 'leave_request', scope: 'hr', number_prefix: 'LV', icon: 'calendar',
    fields: [{ key: 'reason', label: 'Reason', type: 'textarea', required: true }] });
  expect(leaveForm.status).toBe(201); leaveId = leaveForm.body.id;
  if (!defs.body.find((f: any) => f.slug === 'hr_payroll')) {
    const payroll = await ctx.api.post('/api/form-definitions').set(hdr()).send({ name: 'Payroll',
      slug: 'hr_payroll', scope: 'hr', number_prefix: 'PAY', icon: 'calendar', fields: [] });
    expect(payroll.status).toBe(201);
  }
});
afterAll(() => cleanup(ctx));
async function member() {
  const user = await createEmployee(ctx.api, token);
  const input = { employee_no: `GAP-${++seq}`, name: user.username, user_id: user.id,
    daily_rate: 500, rate_type: 'daily', status: 'regular', leave_days_per_year: 8, leave_days_used: 0 };
  const emp = await ctx.api.post('/api/hr/employees').set(hdr()).send(input);
  expect(emp.status).toBe(201);
  return { ...user, employeeId: emp.body.id, input };
}
async function period(user: Awaited<ReturnType<typeof member>>) {
  const r = await ctx.api.post('/api/hr/periods').set(hdr()).send({ label: `Gap ${++seq}`,
    start_date: '2026-06-01', end_date: '2026-06-02' });
  expect(r.status).toBe(201);
  await ctx.api.post(`/api/hr/periods/${r.body.id}/employees`).set(hdr()).send({ employee_id: user.employeeId });
  return r.body.id;
}
async function leave(user: Awaited<ReturnType<typeof member>>, data: Record<string, unknown>) {
  return ctx.api.post('/api/form-records').set(hdr(user.token)).send({ form_def_id: leaveId, data });
}
it('regression: required configured leave fields are validated by the API', async () => {
  const user = await member();
  const r = await leave(user, { date_from: '2026-06-01', date_to: '2026-06-01' });
  expect(r.status).toBe(400); expect(r.body.error).toContain('Reason');
});
it('regression: submitted zero days cannot bypass the computed working-day charge', async () => {
  const user = await member();
  const r = await leave(user, { with_pay: 'Yes', days: 0, date_from: '2026-06-01', date_to: '2026-06-02', reason: 'Audit leave' });
  expect(r.status).toBe(201);
  expect((await ctx.api.post(`/api/me/approvals/requests/${r.body.id}/decide`).set(hdr()).send({ decision: 'approved' })).status).toBe(200);
  expect(queryOne<any>('SELECT leave_days_used FROM employees WHERE id = ?', user.employeeId).leave_days_used).toBe(2);
  const p = await period(user);
  expect((await ctx.api.put(`/api/hr/periods/${p}/attendance`).set(hdr()).send({ employee_id: user.employeeId,
    days: ['2026-06-01', '2026-06-02'].map(work_date => ({ work_date, form_record_ids: [r.body.id] })) })).status).toBe(200);
  expect((await ctx.api.post(`/api/hr/periods/${p}/generate-payslips`).set(hdr()).send({ payroll_period: `Gap ${seq}` })).status).toBe(201);
  const slip = queryOne<any>("SELECT fr.data FROM form_records fr JOIN form_definitions fd ON fd.id = fr.form_def_id WHERE fd.slug = 'hr_payroll' AND json_extract(fr.data,'$.cutoff_id') = ?", p);
  expect(Number(JSON.parse(slip.data).basic_salary)).toBe(1000);
});
it('regression: another employee cannot be paid using someone else’s approved leave', async () => {
  const owner = await member(), other = await member();
  const r = await leave(owner, { with_pay: 'Yes', days: 1, date_from: '2026-06-01', date_to: '2026-06-01', reason: 'Audit ownership' });
  await ctx.api.post(`/api/me/approvals/requests/${r.body.id}/decide`).set(hdr()).send({ decision: 'approved' });
  const p = await period(other);
  expect((await ctx.api.put(`/api/hr/periods/${p}/attendance`).set(hdr()).send({ employee_id: other.employeeId,
    days: [{ work_date: '2026-06-01', form_record_ids: [r.body.id] }] })).status).toBe(400);
  run('UPDATE attendance_records SET form_record_id = ? WHERE period_id = ? AND work_date = ?', r.body.id, p, '2026-06-01');
  expect((await ctx.api.post(`/api/hr/periods/${p}/generate-payslips`).set(hdr()).send({ payroll_period: `Gap ${seq}` })).status).toBe(201);
  const slip = queryOne<any>("SELECT fr.data FROM form_records fr JOIN form_definitions fd ON fd.id = fr.form_def_id WHERE fd.slug = 'hr_payroll' AND json_extract(fr.data,'$.cutoff_id') = ?", p);
  expect(Number(JSON.parse(slip.data).basic_salary)).toBe(0);
});
it('regression: attendance rejects out-of-cutoff dates and invalid times', async () => {
  const user = await member(), p = await period(user);
  expect((await ctx.api.put(`/api/hr/periods/${p}/attendance`).set(hdr()).send({ employee_id: user.employeeId,
    days: [{ work_date: '2030-01-01', time_in: 'banana', time_out: '99:99' }] })).status).toBe(400);
});
it('regression: employee editing preserves consumed leave even with a stale payload', async () => {
  const user = await member();
  const r = await leave(user, { with_pay: 'Yes', days: 2, date_from: '2026-06-01', date_to: '2026-06-02', reason: 'Audit consumption' });
  await ctx.api.post(`/api/me/approvals/requests/${r.body.id}/decide`).set(hdr()).send({ decision: 'approved' });
  expect(queryOne<any>('SELECT leave_days_used FROM employees WHERE id = ?', user.employeeId).leave_days_used).toBe(2);
  expect((await ctx.api.put(`/api/hr/employees/${user.employeeId}`).set(hdr()).send(user.input)).status).toBe(200);
  expect(queryOne<any>('SELECT leave_days_used FROM employees WHERE id = ?', user.employeeId).leave_days_used).toBe(2);
});
it('control: previously approved corrections are applied when a matching cutoff roster is created', async () => {
  const user = await member();
  const tc = await ctx.api.post('/api/me/time-corrections').set(hdr(user.token)).send({ work_date: '2040-01-01', requested_in: '08:00', requested_out: '17:00', reason: 'Audit missing cutoff' });
  const decision = await ctx.api.post(`/api/me/approvals/time-corrections/${tc.body.id}/decide`).set(hdr()).send({ decision: 'approved' });
  expect(decision.status).toBe(200); expect(decision.body.applied).toBe(false);
  const p = await ctx.api.post('/api/hr/periods').set(hdr()).send({ label: `Gap future ${++seq}`, start_date: '2040-01-01', end_date: '2040-01-01' });
  await ctx.api.post(`/api/hr/periods/${p.body.id}/employees`).set(hdr()).send({ employee_id: user.employeeId });
  expect(queryOne<any>('SELECT time_in FROM attendance_records WHERE period_id = ? AND employee_id = ?', p.body.id, user.employeeId).time_in).toBe('08:00');
});
it('regression: paid slip breakdown remains frozen after backdating a rate', async () => {
  const user = await member(), p = await period(user);
  const shift = await ctx.api.post('/api/hr/shifts').set(hdr()).send({ name: 'Audit shift', start_time: '08:00', end_time: '17:00' });
  expect(shift.status).toBe(201);
  await ctx.api.put(`/api/hr/periods/${p}/attendance`).set(hdr()).send({ employee_id: user.employeeId,
    days: [{ work_date: '2026-06-01', time_in: '09:00', time_out: '17:00', shift_id: shift.body.id }] });
  await ctx.api.post(`/api/hr/periods/${p}/generate-payslips`).set(hdr()).send({ payroll_period: `Gap ${seq}` });
  const slip = queryOne<any>("SELECT fr.id, fr.data FROM form_records fr JOIN form_definitions fd ON fd.id = fr.form_def_id WHERE fd.slug = 'hr_payroll' AND json_extract(fr.data,'$.cutoff_id') = ?", p);
  await ctx.api.post(`/api/hr/payroll/${slip.id}/mark-paid`).set(hdr());
  const before = await ctx.api.get(`/api/hr/payroll/${slip.id}/detail`).set(hdr());
  const rate = await ctx.api.post(`/api/hr/employees/${user.employeeId}/rate-change`).set(hdr()).send({ rate_type: 'daily', daily_rate: 1000, effective_date: '2026-06-01', note: 'Audit backdated rate' });
  expect(rate.status).toBe(200);
  const after = await ctx.api.get(`/api/hr/payroll/${slip.id}/detail`).set(hdr());
  expect(after.body.daily_rate).toBe(500); expect(before.body.daily_rate).toBe(500);
  expect(after.body.days).toEqual(before.body.days);
  expect(after.body.totals.late_deduction).toBe(before.body.totals.late_deduction);
  expect(queryOne<any>('SELECT data FROM form_records WHERE id = ?', slip.id).data).toBe(slip.data);
});
it('regression: overlapping approved leave requests do not consume the same date twice', async () => {
  const user = await member();
  for (let i = 0; i < 2; i++) {
    const r = await leave(user, { with_pay: 'Yes', days: 1, date_from: '2026-06-01', date_to: '2026-06-01', reason: 'Audit duplicate date' });
    expect((await ctx.api.post(`/api/me/approvals/requests/${r.body.id}/decide`).set(hdr()).send({ decision: 'approved' })).status).toBe(200);
  }
  expect(queryOne<any>('SELECT leave_days_used FROM employees WHERE id = ?', user.employeeId).leave_days_used).toBe(1);
});
it('regression: multi-day leave remains eligible and is linked to every covered day', async () => {
  const user = await member(), p = await period(user);
  const r = await leave(user, { with_pay: 'Yes', days: 2, date_from: '2026-06-01', date_to: '2026-06-02', reason: 'Audit date range' });
  expect((await ctx.api.post(`/api/me/approvals/requests/${r.body.id}/decide`).set(hdr()).send({ decision: 'approved' })).status).toBe(200);
  await ctx.api.put(`/api/hr/periods/${p}/attendance`).set(hdr()).send({ employee_id: user.employeeId,
    days: [{ work_date: '2026-06-01', form_record_ids: [r.body.id] }, { work_date: '2026-06-02' }] });
  const used = await ctx.api.get('/api/hr/linked-form-record-ids').set(hdr());
  expect(used.body).toContain(r.body.id);
  const eligible = await ctx.api.get('/api/hr/requests/eligible').query({ employee_id: user.employeeId, date: '2026-06-02' }).set(hdr());
  expect(eligible.body.some((record: any) => record.id === r.body.id)).toBe(true);
  await ctx.api.post(`/api/hr/periods/${p}/generate-payslips`).set(hdr()).send({ payroll_period: `Gap ${seq}` });
  const slip = queryOne<any>("SELECT fr.data FROM form_records fr JOIN form_definitions fd ON fd.id = fr.form_def_id WHERE fd.slug = 'hr_payroll' AND json_extract(fr.data,'$.cutoff_id') = ?", p);
  expect(Number(JSON.parse(slip.data).basic_salary)).toBe(1000);
  expect(queryOne<any>('SELECT leave_days_used FROM employees WHERE id = ?', user.employeeId).leave_days_used).toBe(2);
});

it('range leave is attached across all existing attendance days and future cutoff rosters', async () => {
  const user = await member(), p = await period(user);
  const r = await leave(user, { with_pay: 'Yes', leave_dates: '2026-06-01,2026-06-02,2026-07-01', reason: 'Cross-month leave' });
  expect(r.status).toBe(201);
  for (const date of ['2026-06-01','2026-06-02']) expect(queryOne<any>('SELECT form_record_ids FROM attendance_records WHERE period_id = ? AND employee_id = ? AND work_date = ?', p, user.employeeId, date).form_record_ids).toContain(String(r.body.id));
  const next = await ctx.api.post('/api/hr/periods').set(hdr()).send({ label: `Next ${++seq}`, start_date: '2026-07-01', end_date: '2026-07-02' });
  await ctx.api.post(`/api/hr/periods/${next.body.id}/employees`).set(hdr()).send({ employee_id: user.employeeId });
  expect(queryOne<any>('SELECT form_record_ids FROM attendance_records WHERE period_id = ? AND employee_id = ? AND work_date = ?', next.body.id, user.employeeId, '2026-07-01').form_record_ids).toContain(String(r.body.id));
  expect(queryOne<any>('SELECT form_record_ids FROM attendance_records WHERE period_id = ? AND employee_id = ? AND work_date = ?', next.body.id, user.employeeId, '2026-07-02').form_record_ids).toBeNull();
});
it('only scheduled working days consume leave, while all selected dates remain covered', async () => {
  const user = await member();
  const r = await leave(user, { with_pay: 'Yes', date_from: '2026-06-10', date_to: '2026-06-14', reason: 'Includes holiday and weekend' });
  expect(r.status).toBe(201);
  const data = JSON.parse(queryOne<any>('SELECT data FROM form_records WHERE id = ?', r.body.id).data);
  expect(data.days).toBe(2); expect(data.leave_dates.split(',')).toHaveLength(5);
  const approved = await ctx.api.post(`/api/me/approvals/requests/${r.body.id}/decide`).set(hdr()).send({ decision: 'approved' });
  expect(approved.status).toBe(200); expect(approved.body.leave_days_charged).toBe(2);
  expect(approved.body.warnings.join(' ')).toContain('do not consume');
  const p = await ctx.api.post('/api/hr/periods').set(hdr()).send({ label: `Nonworking leave ${++seq}`, start_date: '2026-06-10', end_date: '2026-06-14' });
  await ctx.api.post(`/api/hr/periods/${p.body.id}/employees`).set(hdr()).send({ employee_id: user.employeeId });
  await ctx.api.post(`/api/hr/periods/${p.body.id}/generate-payslips`).set(hdr()).send({ payroll_period: `Nonworking leave ${seq}` });
  const slip = queryOne<any>("SELECT data FROM form_records WHERE json_extract(data,'$.cutoff_id') = ?", p.body.id);
  const snapshot = JSON.parse(JSON.parse(slip.data)._calculation_snapshot);
  expect(snapshot.totals.basic_salary).toBe(1000);
  expect(snapshot.days.filter((d: any) => d.status === 'rest_day_off')).toHaveLength(2);
});
it('separate selected dates across months are canonical, and dates between them are not covered', async () => {
  const user = await member();
  const r = await leave(user, { leave_dates: '2026-10-05,2026-09-04,2026-09-05,2026-09-07,2026-09-08,2026-09-10,2026-10-03,2026-09-04', reason: 'Selected days' });
  expect(r.status).toBe(201);
  const data = JSON.parse(queryOne<any>('SELECT data FROM form_records WHERE id = ?', r.body.id).data);
  expect(data.leave_dates).toBe('2026-09-04,2026-09-05,2026-09-07,2026-09-08,2026-09-10,2026-10-03,2026-10-05');
  expect(data.days).toBe(5);
  const { requestMatchesDay } = await import('../src/modules/hr/request-data');
  expect(requestMatchesDay('leave_request', data, user.employeeId, '2026-09-06')).toBe(false);
});
it.each([{ work_date: '2026-06-01', time_in: '99:99' }, { work_date: '2030-01-01', time_in: '08:00' }, { work_date: '2026-02-30', time_in: '08:00' }])('invalid attendance is rejected without replacing existing rows: $work_date $time_in', async day => {
  const user = await member(), p = await period(user);
  const before = queryOne<any>('SELECT COUNT(*) AS n FROM attendance_records WHERE period_id = ?', p).n;
  expect((await ctx.api.put(`/api/hr/periods/${p}/attendance`).set(hdr()).send({ employee_id: user.employeeId, days: [day] })).status).toBe(400);
  expect(queryOne<any>('SELECT COUNT(*) AS n FROM attendance_records WHERE period_id = ?', p).n).toBe(before);
});
it('required custom fields, invalid choices and malformed selected dates cannot bypass server validation', async () => {
  const user = await member();
  const definition = await ctx.api.get('/api/form-definitions/' + leaveId).set(hdr());
  await ctx.api.put('/api/form-definitions/' + leaveId).set(hdr()).send({ ...definition.body, fields: [
    { key: 'reason', label: 'Reason', type: 'textarea', required: true },
    { key: 'contact', label: 'Contact', type: 'text', required: true },
    { key: 'leave_type', label: 'Leave type', type: 'select', options: ['Sick','Vacation'], required: true } ] });
  const base = { leave_dates: '2026-06-01', reason: 'Medical', leave_type: 'Sick' };
  expect((await leave(user, base)).status).toBe(400);
  expect((await leave(user, { ...base, contact: 'HR', leave_type: 'Fake' })).status).toBe(400);
  expect((await leave(user, { ...base, contact: 'HR', leave_dates: '2026-02-30' })).status).toBe(400);
  expect((await leave(user, { ...base, contact: 'HR' })).status).toBe(201);
  await ctx.api.put('/api/form-definitions/' + leaveId).set(hdr()).send(definition.body);
});
it('pending edits relink their new dates without altering paid cutoffs', async () => {
  const user = await member(), p = await period(user);
  const r = await leave(user, { leave_dates: '2026-06-01', reason: 'Initial date' });
  const edit = await ctx.api.put('/api/form-records/' + r.body.id).set(hdr()).send({ data: { employee_id: user.employeeId, leave_dates: '2026-06-02', reason: 'Changed date' } });
  expect(edit.status).toBe(200);
  expect(queryOne<any>('SELECT form_record_ids FROM attendance_records WHERE period_id = ? AND work_date = ?', p, '2026-06-01').form_record_ids).toBeNull();
  expect(queryOne<any>('SELECT form_record_ids FROM attendance_records WHERE period_id = ? AND work_date = ?', p, '2026-06-02').form_record_ids).toContain(String(r.body.id));
  const gen = await ctx.api.post(`/api/hr/periods/${p}/generate-payslips`).set(hdr()).send({ payroll_period: `Lock ${p}` });
  const slip = queryOne<any>("SELECT id FROM form_records WHERE json_extract(data,'$.cutoff_id') = ?", p);
  expect(gen.status).toBe(201);
  await ctx.api.post(`/api/hr/payroll/${slip.id}/mark-paid`).set(hdr());
  const before = queryOne<any>('SELECT form_record_ids FROM attendance_records WHERE period_id = ? AND work_date = ?', p, '2026-06-02').form_record_ids;
  const link = await ctx.api.post(`/api/hr/requests/${r.body.id}/link-attendance`).set(hdr());
  expect(link.status).toBe(200);
  expect(queryOne<any>('SELECT form_record_ids FROM attendance_records WHERE period_id = ? AND work_date = ?', p, '2026-06-02').form_record_ids).toBe(before);
});
it('a legacy HR-filed request resolves its beneficiary by a unique name, not the clerk account', async () => {
  const subject = await member(), clerk = await member();
  const id = Number(run("INSERT INTO form_records (form_def_id,number,data,status,created_by) VALUES (?,? ,?,'pending',?)", leaveId, `Legacy-${++seq}`,
    JSON.stringify({ employee_name: subject.username, date_from: '2026-06-01', date_to: '2026-06-01', with_pay: 'Yes', reason: 'Legacy leave' }), clerk.id).lastInsertRowid);
  const own = await ctx.api.get('/api/me/requests').set(hdr(subject.token)); expect(own.body.some((r: any) => r.id === id)).toBe(true);
  const approved = await ctx.api.post(`/api/me/approvals/requests/${id}/decide`).set(hdr()).send({ decision: 'approved' });
  expect(approved.status).toBe(200);
  expect(queryOne<any>('SELECT leave_days_used FROM employees WHERE id = ?', subject.employeeId).leave_days_used).toBe(1);
  expect(queryOne<any>('SELECT leave_days_used FROM employees WHERE id = ?', clerk.employeeId).leave_days_used).toBe(0);
});
it('manual schedule overrides affect the working-day count without losing date coverage', async () => {
  const user = await member();
  const p = await ctx.api.post('/api/hr/periods').set(hdr()).send({ label: `Schedule ${++seq}`, start_date: '2026-06-13', end_date: '2026-06-13' });
  await ctx.api.post(`/api/hr/periods/${p.body.id}/employees`).set(hdr()).send({ employee_id: user.employeeId });
  let preview = await ctx.api.post('/api/me/leave-preview').set(hdr(user.token)).send({ leave_dates: '2026-06-13' });
  expect(preview.body.days).toBe(0);
  await ctx.api.put(`/api/hr/periods/${p.body.id}/attendance`).set(hdr()).send({ employee_id: user.employeeId, days: [{ work_date: '2026-06-13', rest_day: 'no' }] });
  preview = await ctx.api.post('/api/me/leave-preview').set(hdr(user.token)).send({ leave_dates: '2026-06-13' });
  expect(preview.body.days).toBe(1);
});
