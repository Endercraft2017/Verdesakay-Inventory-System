/** Request approvals + attendance corrections (/api/me/approvals, /api/me/time-corrections).
 *  Authorization: the filer's department head, or any hr.manage holder, may decide. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';
// NOTE: `queryOne` is imported dynamically inside beforeAll, after setupApp() sets DB_PATH
// — a top-level `import ... from '../src/shared/db'` would evaluate DB_PATH before it's set (real
// data.db, not the throwaway per-file one). See helpers.ts's own doc comment.
let queryOne: typeof import('../src/shared/db').queryOne;

let ctx: TestContext;
let adminToken: string;
const A = () => ({ Authorization: `Bearer ${adminToken}` });
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  ctx = await setupApp();
  ({ queryOne } = await import('../src/shared/db'));
  adminToken = await login(ctx.api);
  // leave_request isn't auto-seeded (same as no_work_memo before it got a seed function —
  // real installs build it via Form Builder); create it here so this file's own throwaway
  // DB has it, matching what hr.test.ts sets up for its own isolated DB.
  await ctx.api.post('/api/form-definitions').set(A()).send({
    name: 'Leave Request', slug: 'leave_request', number_prefix: 'LV', icon: 'calendar', scope: 'hr',
    fields: [
      { key: 'employee_name', label: 'Employee Name', type: 'text', required: true, options: [], default: '' },
      { key: 'with_pay', label: 'With Pay?', type: 'select', required: true, options: ['Yes', 'No'], default: '' },
    ],
  });
});
afterAll(() => cleanup(ctx));

/** Create a department with a unique name and return { id, name } so callers can
 *  PUT it back without tripping the name-uniqueness check in a shared DB. */
async function dept(prefix: string): Promise<{ id: number; name: string }> {
  const name = `${prefix} ${Math.floor(Math.random() * 1e9)}`;
  const r = await ctx.api.post('/api/users/departments').set(A()).send({ name });
  return { id: r.body.id as number, name };
}

async function setHead(d: { id: number; name: string }, headUserId: number): Promise<void> {
  const r = await ctx.api.put('/api/users/departments/' + d.id).set(A())
    .send({ name: d.name, head_user_id: headUserId });
  if (r.status !== 200) throw new Error('setHead failed: ' + JSON.stringify(r.body));
}

async function linkedEmployee(opts: { role?: string; departmentId?: number | null } = {}) {
  const acc = await createEmployee(ctx.api, adminToken, {
    role: opts.role || 'admin_staff',
    department_id: opts.departmentId ?? null,
  });
  const name = acc.username.toUpperCase();
  const emp = await ctx.api.post('/api/hr/employees').set(A()).send({
    employee_no: 'E' + Math.floor(Math.random() * 1e6), name, user_id: acc.id,
    department_id: opts.departmentId ?? null, daily_rate: 500, rate_type: 'daily', status: 'regular',
  });
  return { ...acc, empId: emp.body.id as number, name };
}

async function requestFormId(slug: string): Promise<number> {
  const all = await ctx.api.get('/api/form-definitions').set(A());
  return all.body.find((x: { slug: string }) => x.slug === slug).id as number;
}

describe('request approvals', () => {
  it('routes a pending request to the department head, who can approve it', async () => {
    const d = await dept('Ops');
    const head = await linkedEmployee({ departmentId: d.id });
    const member = await linkedEmployee({ departmentId: d.id });
    const outsider = await linkedEmployee({});
    await setHead(d, head.id);

    const leaveId = await requestFormId('leave_request');
    const filed = await ctx.api.post('/api/form-records').set(bearer(member.token))
      .send({ form_def_id: leaveId, data: { reason: 'Family trip', leave_dates: '2026-11-09', employee_name: member.name }, status: 'pending' });
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);

    // Head sees it; an unrelated employee sees nothing.
    const headInbox = await ctx.api.get('/api/me/approvals').set(bearer(head.token));
    expect(headInbox.body.requests.map((r: { id: number }) => r.id)).toContain(filed.body.id);
    const outInbox = await ctx.api.get('/api/me/approvals').set(bearer(outsider.token));
    expect(outInbox.body.requests).toHaveLength(0);

    // Approve.
    const dec = await ctx.api.post(`/api/me/approvals/requests/${filed.body.id}/decide`)
      .set(bearer(head.token)).send({ decision: 'approved', note: 'ok' });
    expect(dec.status).toBe(200);
    expect(dec.body.status).toBe('approved');

    const mine = await ctx.api.get('/api/me/requests').set(bearer(member.token));
    expect(mine.body[0].status).toBe('approved');
    expect(mine.body[0].data.decision_note).toBe('ok');

    // No longer pending → second decide fails.
    expect((await ctx.api.post(`/api/me/approvals/requests/${filed.body.id}/decide`)
      .set(bearer(head.token)).send({ decision: 'rejected' })).status).toBe(400);
  });

  it('an hr.manage holder can decide any department\'s request; you cannot decide your own', async () => {
    const hr = await createEmployee(ctx.api, adminToken, { role: 'hr' });
    const filer = await linkedEmployee({});
    const leaveId = await requestFormId('leave_request');
    const filed = await ctx.api.post('/api/form-records').set(bearer(filer.token))
      .send({ form_def_id: leaveId, data: { reason: 'Family trip', leave_dates: '2026-11-09', employee_name: filer.name }, status: 'pending' });

    // Filer is not an approver at all.
    expect((await ctx.api.post(`/api/me/approvals/requests/${filed.body.id}/decide`)
      .set(bearer(filer.token)).send({ decision: 'approved' })).status).toBe(403);

    const dec = await ctx.api.post(`/api/me/approvals/requests/${filed.body.id}/decide`)
      .set(bearer(hr.token)).send({ decision: 'rejected' });
    expect(dec.status).toBe(200);
    expect(dec.body.status).toBe('rejected');
  });

  it('approving a paid Leave request consumes the fixed leave-day bank, blocked past the balance unless overridden', async () => {
    const hr = await createEmployee(ctx.api, adminToken, { role: 'hr' });
    const filer = await linkedEmployee({});
    const leaveId = await requestFormId('leave_request');

    // Default bank is 5 days/year (src/db.ts migration default) — confirm before consuming it.
    const empBefore = (await ctx.api.get('/api/hr/employees').set(A())).body.find((e: { id: number }) => e.id === filer.empId);
    expect(empBefore.leave_days_per_year).toBe(5);
    expect(empBefore.leave_days_remaining).toBe(5);

    const filed = await ctx.api.post('/api/form-records').set(bearer(filer.token))
      .send({ form_def_id: leaveId, data: { reason: 'Family trip', employee_name: filer.name, with_pay: 'Yes', days: 3, leave_dates: '2026-11-09,2026-11-10,2026-11-11' }, status: 'pending' });
    const dec = await ctx.api.post(`/api/me/approvals/requests/${filed.body.id}/decide`)
      .set(bearer(hr.token)).send({ decision: 'approved' });
    expect(dec.status).toBe(200);

    const empAfter = (await ctx.api.get('/api/hr/employees').set(A())).body.find((e: { id: number }) => e.id === filer.empId);
    expect(empAfter.leave_days_used).toBe(3);
    expect(empAfter.leave_days_remaining).toBe(2);

    // Requesting more than the 2 remaining is blocked...
    const filed2 = await ctx.api.post('/api/form-records').set(bearer(filer.token))
      .send({ form_def_id: leaveId, data: { reason: 'Family trip', employee_name: filer.name, with_pay: 'Yes', days: 4, leave_dates: '2026-11-16,2026-11-17,2026-11-18,2026-11-19' }, status: 'pending' });
    const blocked = await ctx.api.post(`/api/me/approvals/requests/${filed2.body.id}/decide`)
      .set(bearer(hr.token)).send({ decision: 'approved' });
    expect(blocked.status).toBe(400);
    const stillTwo = (await ctx.api.get('/api/hr/employees').set(A())).body.find((e: { id: number }) => e.id === filer.empId);
    expect(stillTwo.leave_days_used).toBe(3); // untouched by the rejected-for-balance attempt

    // ...unless the approver explicitly overrides.
    const overridden = await ctx.api.post(`/api/me/approvals/requests/${filed2.body.id}/decide`)
      .set(bearer(hr.token)).send({ decision: 'approved', override_balance: true });
    expect(overridden.status).toBe(200);
    const empFinal = (await ctx.api.get('/api/hr/employees').set(A())).body.find((e: { id: number }) => e.id === filer.empId);
    expect(empFinal.leave_days_used).toBe(7);
    expect(empFinal.leave_days_remaining).toBe(-2); // allowed to go negative once overridden
  });

  it('an unpaid Leave request, or a rejected one, never touches the leave-day bank', async () => {
    const hr = await createEmployee(ctx.api, adminToken, { role: 'hr' });
    const filer = await linkedEmployee({});
    const leaveId = await requestFormId('leave_request');

    const unpaid = await ctx.api.post('/api/form-records').set(bearer(filer.token))
      .send({ form_def_id: leaveId, data: { reason: 'Family trip', leave_dates: '2026-11-09', employee_name: filer.name, with_pay: 'No', days: 2 }, status: 'pending' });
    await ctx.api.post(`/api/me/approvals/requests/${unpaid.body.id}/decide`).set(bearer(hr.token)).send({ decision: 'approved' });

    const paidButRejected = await ctx.api.post('/api/form-records').set(bearer(filer.token))
      .send({ form_def_id: leaveId, data: { reason: 'Family trip', leave_dates: '2026-11-09', employee_name: filer.name, with_pay: 'Yes', days: 2 }, status: 'pending' });
    await ctx.api.post(`/api/me/approvals/requests/${paidButRejected.body.id}/decide`).set(bearer(hr.token)).send({ decision: 'rejected' });

    const emp = (await ctx.api.get('/api/hr/employees').set(A())).body.find((e: { id: number }) => e.id === filer.empId);
    expect(emp.leave_days_used).toBe(0);
  });

  it('lets the filer cancel their own still-pending request', async () => {
    const filer = await linkedEmployee({});
    const leaveId = await requestFormId('leave_request');
    const filed = await ctx.api.post('/api/form-records').set(bearer(filer.token))
      .send({ form_def_id: leaveId, data: { reason: 'Family trip', leave_dates: '2026-11-09' }, status: 'pending' });
    const c = await ctx.api.post(`/api/me/requests/${filed.body.id}/cancel`).set(bearer(filer.token));
    expect(c.status).toBe(200);
    expect((await ctx.api.get('/api/me/requests').set(bearer(filer.token))).body[0].status).toBe('cancelled');
    // Can't cancel again.
    expect((await ctx.api.post(`/api/me/requests/${filed.body.id}/cancel`).set(bearer(filer.token))).status).toBe(400);
  });
});

describe('attendance corrections', () => {
  it('files a fix, routes it to HR, and on approval fills the attendance record', async () => {
    const emp = await linkedEmployee({});
    const hr = await createEmployee(ctx.api, adminToken, { role: 'hr' });
    const wd = new Date().toISOString().slice(0, 10);
    const d = (o: number) => new Date(Date.now() + o * 864e5).toISOString().slice(0, 10);
    const period = await ctx.api.post('/api/hr/periods').set(A())
      .send({ label: 'Cutoff', start_date: d(-3), end_date: d(3) });

    const filed = await ctx.api.post('/api/me/time-corrections').set(bearer(emp.token))
      .send({ work_date: wd, requested_in: '08:05', requested_out: '17:00', reason: 'forgot to scan' });
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);

    // Shows in the employee's own list, and in HR's approvals.
    expect((await ctx.api.get('/api/me/time-corrections').set(bearer(emp.token))).body[0].status).toBe('pending');
    const inbox = await ctx.api.get('/api/me/approvals').set(bearer(hr.token));
    expect(inbox.body.time_corrections.map((r: { id: number }) => r.id)).toContain(filed.body.id);

    const dec = await ctx.api.post(`/api/me/approvals/time-corrections/${filed.body.id}/decide`)
      .set(bearer(hr.token)).send({ decision: 'approved' });
    expect(dec.status).toBe(200);
    expect(dec.body.applied).toBe(true);

    const ar = queryOne<{ time_in: string; time_out: string }>(
      'SELECT time_in, time_out FROM attendance_records WHERE period_id = ? AND employee_id = ? AND work_date = ?',
      period.body.id, emp.empId, wd
    );
    expect(ar?.time_in).toBe('08:05');
    expect(ar?.time_out).toBe('17:00');
  });

  it('rejects an invalid fix (no times) and lets the employee cancel a pending one', async () => {
    const emp = await linkedEmployee({});
    expect((await ctx.api.post('/api/me/time-corrections').set(bearer(emp.token))
      .send({ work_date: '2026-08-01', reason: 'nothing' })).status).toBe(400);

    const ok = await ctx.api.post('/api/me/time-corrections').set(bearer(emp.token))
      .send({ work_date: '2026-08-01', requested_in: '09:00', reason: 'late scan' });
    const c = await ctx.api.post(`/api/me/time-corrections/${ok.body.id}/cancel`).set(bearer(emp.token));
    expect(c.status).toBe(200);
    expect((await ctx.api.get('/api/me/time-corrections').set(bearer(emp.token))).body[0].status).toBe('cancelled');
  });
});

describe('auth/me can_approve flag', () => {
  it('is true for hr.manage holders and department heads, false otherwise', async () => {
    const plain = await createEmployee(ctx.api, adminToken, { role: 'warehouse' });
    const hr = await createEmployee(ctx.api, adminToken, { role: 'hr' });
    const head = await createEmployee(ctx.api, adminToken, { role: 'warehouse' });
    const d = await dept('Warehouse');
    await setHead(d, head.id);

    expect((await ctx.api.get('/api/auth/me').set(bearer(plain.token))).body.user.can_approve).toBe(false);
    expect((await ctx.api.get('/api/auth/me').set(bearer(hr.token))).body.user.can_approve).toBe(true);
    expect((await ctx.api.get('/api/auth/me').set(bearer(head.token))).body.user.can_approve).toBe(true);
  });
});
