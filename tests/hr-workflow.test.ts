/** Business workflow regressions: authority, one approval path, leave changes and payment locks. */
import { beforeAll, afterAll, it, expect } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';
let ctx: TestContext, token: string, leaveId: number;
let queryOne: typeof import('../src/shared/db').queryOne;
const hdr = (t = token) => ({ Authorization: `Bearer ${t}` });
let seq = 0;
beforeAll(async () => {
  ctx = await setupApp();
  token = await login(ctx.api);
  ({ queryOne } = await import('../src/shared/db'));
  const defs = await ctx.api.get('/api/form-definitions').set(hdr());
  const existing = defs.body.find((f: any) => f.slug === 'leave_request');
  if (existing) leaveId = existing.id;
  else {
    const r = await ctx.api.post('/api/form-definitions').set(hdr()).send({
      name: 'Leave Request',
      slug: 'leave_request',
      scope: 'hr',
      number_prefix: 'LV',
      icon: 'calendar',
      fields: [],
    });
    expect(r.status).toBe(201);
    leaveId = r.body.id;
  }
});
afterAll(() => cleanup(ctx));
async function member(departmentId: number | null = null, rate = 500) {
  const user = await createEmployee(ctx.api, token, { department_id: departmentId });
  const emp = await ctx.api
    .post('/api/hr/employees')
    .set(hdr())
    .send({
      employee_no: `WF-${++seq}`,
      name: user.username,
      user_id: user.id,
      department_id: departmentId,
      daily_rate: rate,
      rate_type: 'daily',
      status: 'regular',
      leave_days_per_year: 8,
      leave_days_used: 0,
    });
  expect(emp.status).toBe(201);
  return { ...user, employeeId: emp.body.id };
}
async function file(user: Awaited<ReturnType<typeof member>>, days = 2) {
  const r = await ctx.api
    .post('/api/form-records')
    .set(hdr(user.token))
    .send({
      form_def_id: leaveId,
      status: 'approved',
      data: { employee_name: user.username, with_pay: 'Yes', days },
    });
  expect(r.status).toBe(201);
  return r.body.id as number;
}
async function cutoff(user: Awaited<ReturnType<typeof member>>) {
  const label = `Workflow ${++seq}`;
  const p = await ctx.api
    .post('/api/hr/periods')
    .set(hdr())
    .send({ label, start_date: '2026-04-01', end_date: '2026-04-02' });
  expect(p.status).toBe(201);
  expect(
    (
      await ctx.api
        .post(`/api/hr/periods/${p.body.id}/employees`)
        .set(hdr())
        .send({ employee_id: user.employeeId })
    ).status,
  ).toBe(201);
  return p.body.id as number;
}
it('generic creation cannot approve leave, and generic editing cannot bypass balance accounting', async () => {
  const user = await member();
  const id = await file(user);
  expect(
    queryOne<{ status: string }>('SELECT status FROM form_records WHERE id = ?', id)?.status,
  ).toBe('pending');
  expect(
    (
      await ctx.api
        .put(`/api/form-records/${id}`)
        .set(hdr())
        .send({ status: 'approved', data: { with_pay: 'Yes', days: 2 } })
    ).status,
  ).toBe(400);
  expect(
    (
      await ctx.api
        .post(`/api/me/approvals/requests/${id}/decide`)
        .set(hdr())
        .send({ decision: 'approved', note: 'Verified' })
    ).status,
  ).toBe(200);
  expect(
    queryOne<{ leave_days_used: number }>(
      'SELECT leave_days_used FROM employees WHERE id = ?',
      user.employeeId,
    )?.leave_days_used,
  ).toBe(2);
  expect(
    (
      await ctx.api
        .put(`/api/form-records/${id}`)
        .set(hdr())
        .send({ status: 'pending', data: { days: 1 } })
    ).status,
  ).toBe(400);
  expect(
    (
      await ctx.api
        .post(`/api/me/approvals/requests/${id}/decide`)
        .set(hdr())
        .send({ decision: 'approved' })
    ).status,
  ).toBe(400);
});
it('a delegate approves only their department, and HR receives the decision without a second approval', async () => {
  const d = await ctx.api
    .post('/api/users/departments')
    .set(hdr())
    .send({ name: `Workflow Dept ${++seq}` });
  const delegate = await member(d.body.id),
    filer = await member(d.body.id),
    outsider = await member();
  expect(
    (
      await ctx.api
        .put(`/api/hr/approval-authorities/${d.body.id}`)
        .set(hdr())
        .send({ user_ids: [delegate.id] })
    ).status,
  ).toBe(200);
  expect((await ctx.api.get('/api/auth/me').set(hdr(delegate.token))).body.user.can_approve).toBe(true);
  const id = await file(filer),
    other = await file(outsider);
  const inbox = await ctx.api.get('/api/me/approvals').set(hdr(delegate.token));
  expect(inbox.body.requests.some((r: any) => r.id === id)).toBe(true);
  expect(inbox.body.requests.some((r: any) => r.id === other)).toBe(false);
  expect(
    (
      await ctx.api
        .post(`/api/me/approvals/requests/${other}/decide`)
        .set(hdr(delegate.token))
        .send({ decision: 'approved' })
    ).status,
  ).toBe(403);
  expect(
    (
      await ctx.api
        .post(`/api/me/approvals/requests/${id}/decide`)
        .set(hdr(delegate.token))
        .send({ decision: 'approved', note: 'Department verified' })
    ).status,
  ).toBe(200);
  expect(queryOne('SELECT id FROM notifications WHERE tag = ?', `hr-decision-${id}`)).toBeTruthy();
  const review = await ctx.api.get('/api/me/approvals').set(hdr());
  expect(
    review.body.history.find((r: any) => r.id === id && r.kind === 'request').data.decision_note,
  ).toBe('Department verified');
  expect(
    (
      await ctx.api
        .put(`/api/hr/approval-authorities/${d.body.id}`)
        .set(hdr(delegate.token))
        .send({ user_ids: [outsider.id] })
    ).status,
  ).toBe(403);
  expect(
    (
      await ctx.api
        .put(`/api/hr/approval-authorities/${d.body.id}`)
        .set(hdr())
        .send({ user_ids: [outsider.id] })
    ).status,
  ).toBe(400);
  expect(
    (
      await ctx.api
        .put(`/api/hr/approval-authorities/${d.body.id}`)
        .set(hdr())
        .send({ user_ids: [] })
    ).status,
  ).toBe(200);
  expect((await ctx.api.get('/api/auth/me').set(hdr(delegate.token))).body.user.can_approve).toBe(false);
  const next = await file(filer);
  expect(
    (
      await ctx.api
        .post(`/api/me/approvals/requests/${next}/decide`)
        .set(hdr(delegate.token))
        .send({ decision: 'approved' })
    ).status,
  ).toBe(403);
});
it('HR adds and deducts an individual leave bank with a recorded reason', async () => {
  const user = await member();
  const path = `/api/hr/employees/${user.employeeId}/leave-adjustments`;
  expect(
    (await ctx.api.post(path).set(hdr(user.token)).send({ days: 2, reason: 'Grant' })).status,
  ).toBe(403);
  const added = await ctx.api
    .post(path)
    .set(hdr())
    .send({ days: 2, reason: 'Individual additional entitlement' });
  expect(added.status).toBe(200);
  expect(added.body.remaining).toBe(10);
  const deducted = await ctx.api
    .post(path)
    .set(hdr())
    .send({ days: -1.5, reason: 'Correct opening bank' });
  expect(deducted.body.remaining).toBe(8.5);
  expect((await ctx.api.post(path).set(hdr()).send({ days: 1, reason: '' })).status).toBe(400);
  expect((await ctx.api.get(path).set(hdr())).body).toHaveLength(2);
});
it('warnings remain visible but do not block payroll, and custom labels retain cutoff identity', async () => {
  const user = await member(null, 0),
    p = await cutoff(user);
  await ctx.api
    .post('/api/me/time-corrections')
    .set(hdr(user.token))
    .send({ work_date: '2026-04-01', requested_in: '08:00', reason: 'Missed punch' });
  const roster = await ctx.api.get(`/api/hr/periods/${p}`).set(hdr());
  expect(roster.body.warnings.some((w: string) => w.includes('unset pay rate'))).toBe(true);
  expect(roster.body.warnings.some((w: string) => w.includes('pending approval'))).toBe(true);
  const generated = await ctx.api
    .post(`/api/hr/periods/${p}/generate-payslips`)
    .set(hdr())
    .send({ payroll_period: `Custom label ${p}` });
  expect(generated.status).toBe(201);
  expect(generated.body.warnings.length).toBeGreaterThan(0);
  const records = await ctx.api
    .get(
      `/api/form-definitions/${generated.body.form_id}/records?period=${encodeURIComponent(generated.body.period)}`,
    )
    .set(hdr());
  const slip = records.body[0];
  expect(slip.data.cutoff_id).toBe(p);
  const renamed = await ctx.api
    .post(`/api/hr/periods/${p}/generate-payslips`)
    .set(hdr())
    .send({ payroll_period: `Renamed custom ${p}` });
  expect(renamed.status).toBe(201);
  expect(renamed.body.created).toBe(0);
  expect(renamed.body.updated).toBe(1);
  expect((await ctx.api.get(`/api/hr/payroll/${slip.id}/detail`).set(hdr())).status).toBe(200);
});
it('payment freezes attendance, roster, import and corrections; explicit unmark reopens them', async () => {
  const user = await member(),
    p = await cutoff(user);
  const generated = await ctx.api
    .post(`/api/hr/periods/${p}/generate-payslips`)
    .set(hdr())
    .send({ payroll_period: `Paid custom ${p}` });
  const records = await ctx.api
    .get(
      `/api/form-definitions/${generated.body.form_id}/records?period=${encodeURIComponent(generated.body.period)}`,
    )
    .set(hdr());
  const slip = records.body[0];
  expect((await ctx.api.post(`/api/hr/payroll/${slip.id}/mark-paid`).set(hdr())).status).toBe(200);
  expect((await ctx.api.get(`/api/hr/periods/${p}`).set(hdr())).body.locked).toBe(true);
  const regenerated = await ctx.api
    .post(`/api/hr/periods/${p}/generate-payslips`)
    .set(hdr())
    .send({ payroll_period: `Another label after payment ${p}` });
  expect(regenerated.status).toBe(201);
  expect(regenerated.body.created).toBe(0);
  expect(regenerated.body.skipped_locked).toBe(1);
  expect(
    (
      await ctx.api
        .put(`/api/hr/periods/${p}/attendance`)
        .set(hdr())
        .send({ employee_id: user.employeeId, days: [] })
    ).status,
  ).toBe(423);
  expect(
    (await ctx.api.delete(`/api/hr/periods/${p}/employees/${user.employeeId}`).set(hdr())).status,
  ).toBe(423);
  expect((await ctx.api.delete(`/api/hr/periods/${p}`).set(hdr())).status).toBe(423);
  expect((await ctx.api.post(`/api/hr/clock/import/${p}`).set(hdr())).status).toBe(423);
  const tc = await ctx.api
    .post('/api/me/time-corrections')
    .set(hdr(user.token))
    .send({ work_date: '2026-04-01', requested_in: '08:00', reason: 'Correct punch' });
  expect(
    (
      await ctx.api
        .post(`/api/me/approvals/time-corrections/${tc.body.id}/decide`)
        .set(hdr())
        .send({ decision: 'approved' })
    ).status,
  ).toBe(423);
  expect(
    queryOne<{ status: string }>('SELECT status FROM time_corrections WHERE id = ?', tc.body.id)
      ?.status,
  ).toBe('pending');
  expect((await ctx.api.post(`/api/hr/payroll/${slip.id}/unmark-paid`).set(hdr())).status).toBe(
    200,
  );
  expect((await ctx.api.get(`/api/hr/periods/${p}`).set(hdr())).body.locked).toBe(false);
  expect(
    (
      await ctx.api
        .post(`/api/me/approvals/time-corrections/${tc.body.id}/decide`)
        .set(hdr())
        .send({ decision: 'approved' })
    ).status,
  ).toBe(200);
});
it('account creation links the saved employee atomically and refuses duplicate links', async () => {
  const employee = await ctx.api
    .post('/api/hr/employees')
    .set(hdr())
    .send({
      employee_no: `WF-${++seq}`,
      name: 'Needs account',
      daily_rate: 500,
      status: 'regular',
    });
  expect(employee.status).toBe(201);
  const body = {
    username: `wfaccount${++seq}`,
    full_name: 'Needs account',
    password: 'secret123',
    role: 'admin_staff',
    employee_id: employee.body.id,
  };
  const created = await ctx.api.post('/api/users').set(hdr()).send(body);
  expect(created.status).toBe(201);
  expect(
    queryOne<{ user_id: number }>('SELECT user_id FROM employees WHERE id = ?', employee.body.id)
      ?.user_id,
  ).toBe(created.body.id);
  expect(
    (
      await ctx.api
        .post('/api/users')
        .set(hdr())
        .send({ ...body, username: `wfaccount${++seq}` })
    ).status,
  ).toBe(409);
});

it('HR-filed leave follows the subject employee and never consumes the clerk’s own bank', async () => {
  const subject = await member();
  const clerk = await createEmployee(ctx.api, token, { role: 'hr' });
  const clerkEmp = await ctx.api
    .post('/api/hr/employees')
    .set(hdr())
    .send({
      employee_no: `WF-${++seq}`,
      name: 'HR Clerk',
      user_id: clerk.id,
      daily_rate: 500,
      leave_days_per_year: 12,
      leave_days_used: 0,
    });
  expect(clerkEmp.status).toBe(201);
  const request = await ctx.api
    .post('/api/form-records')
    .set(hdr(clerk.token))
    .send({
      form_def_id: leaveId,
      data: {
        employee_id: subject.employeeId,
        employee_name: subject.username,
        with_pay: 'Yes',
        days: 2,
      },
    });
  expect(request.status).toBe(201);
  const own = await ctx.api.get('/api/me/requests').set(hdr(subject.token));
  expect(own.body.some((r: any) => r.id === request.body.id)).toBe(true);
  expect(
    (
      await ctx.api
        .post(`/api/me/approvals/requests/${request.body.id}/decide`)
        .set(hdr())
        .send({ decision: 'approved' })
    ).status,
  ).toBe(200);
  expect(
    queryOne<{ leave_days_used: number }>(
      'SELECT leave_days_used FROM employees WHERE id = ?',
      subject.employeeId,
    )?.leave_days_used,
  ).toBe(2);
  expect(
    queryOne<{ leave_days_used: number }>(
      'SELECT leave_days_used FROM employees WHERE id = ?',
      clerkEmp.body.id,
    )?.leave_days_used,
  ).toBe(0);
});

it('self-filers cannot substitute another employee identity, and employees can withdraw HR-filed pending requests', async () => {
  const filer = await member(),
    other = await member();
  const spoofed = await ctx.api
    .post('/api/form-records')
    .set(hdr(filer.token))
    .send({
      form_def_id: leaveId,
      data: { employee_id: other.employeeId, employee_name: other.username, days: 1 },
    });
  expect(spoofed.status).toBe(201);
  expect(
    JSON.parse(
      queryOne<{ data: string }>('SELECT data FROM form_records WHERE id = ?', spoofed.body.id)!
        .data,
    ).employee_id,
  ).toBe(filer.employeeId);
  const behalf = await ctx.api
    .post('/api/form-records')
    .set(hdr())
    .send({
      form_def_id: leaveId,
      data: { employee_id: other.employeeId, employee_name: other.username, days: 1 },
    });
  expect(
    (await ctx.api.post(`/api/me/requests/${behalf.body.id}/cancel`).set(hdr(other.token))).status,
  ).toBe(200);
  expect(
    (await ctx.api.post(`/api/me/requests/${behalf.body.id}/cancel`).set(hdr(filer.token))).status,
  ).toBe(404);
});
it('self-file request types omit approval fields and employees cannot inject overtime approval', async () => {
  const user = await member();
  const definitions = await ctx.api.get('/api/form-definitions').set(hdr());
  const overtime = definitions.body.find((f: any) => f.slug === 'overtime_request');
  const created = await (overtime ? ctx.api.put('/api/form-definitions/' + overtime.id) : ctx.api.post('/api/form-definitions')).set(hdr()).send({
    name: 'Workflow Overtime', slug: 'overtime_request', scope: 'hr', number_prefix: 'WOT', icon: 'clock',
    fields: [{ key: 'reason', label: 'Reason', type: 'textarea', required: true }, { key: 'approved_hours', label: 'Approved hours', type: 'number' }, { key: 'approved_by', label: 'Approved by', type: 'text' }],
  });
  expect(created.status).toBe(overtime ? 200 : 201);
  const formId = overtime?.id || created.body.id;
  const types = await ctx.api.get('/api/me/request-types').set(hdr(user.token));
  const fields = types.body.find((f: any) => f.id === formId).fields;
  expect(fields.map((f: any) => f.key)).toEqual(['reason']);
  const request = await ctx.api.post('/api/form-records').set(hdr(user.token)).send({ form_def_id: formId, data: { employee_name: user.username, work_date: '2026-04-01', reason: 'Extra work', approved_hours: 99, approved_by: 'HR', decided_by: 'HR', decision_note: 'Pretend approved' } });
  expect(request.status).toBe(201);
  const stored = JSON.parse(queryOne<{ data: string }>('SELECT data FROM form_records WHERE id = ?', request.body.id)!.data);
  expect(stored.reason).toBe('Extra work');
  expect(stored.approved_hours).toBeUndefined();
  expect(stored.approved_by).toBeUndefined();
  expect(stored.decision_note).toBeUndefined();
});
it.each(['pending', 'rejected', 'cancelled'])('a linked %s leave request does not authorize pay', async status => {
  const user = await member(), p = await cutoff(user), id = await file(user, 1);
  if (status === 'rejected') await ctx.api.post(`/api/me/approvals/requests/${id}/decide`).set(hdr()).send({ decision: 'rejected' });
  if (status === 'cancelled') await ctx.api.post(`/api/me/requests/${id}/cancel`).set(hdr(user.token));
  await ctx.api.put(`/api/hr/periods/${p}/attendance`).set(hdr()).send({ employee_id: user.employeeId, days: [{ work_date: '2026-04-01', form_record_id: id }] });
  const gen = await ctx.api.post(`/api/hr/periods/${p}/generate-payslips`).set(hdr()).send({ payroll_period: `Approval check ${p}` });
  expect(gen.status).toBe(201);
  const rows = await ctx.api.get(`/api/form-definitions/${gen.body.form_id}/records`).query({ period: gen.body.period }).set(hdr());
  expect(rows.body[0].data.basic_salary).toBe(0);
  if (status === 'pending') {
    expect((await ctx.api.post(`/api/me/approvals/requests/${id}/decide`).set(hdr()).send({ decision: 'approved' })).status).toBe(200);
    await ctx.api.post(`/api/hr/periods/${p}/generate-payslips`).set(hdr()).send({ payroll_period: gen.body.period });
    const approved = await ctx.api.get(`/api/form-definitions/${gen.body.form_id}/records`).query({ period: gen.body.period }).set(hdr());
    expect(approved.body[0].data.basic_salary).toBe(500);
  }
});
