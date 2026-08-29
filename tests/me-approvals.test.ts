/** Request approvals + attendance corrections (/api/me/approvals, /api/me/time-corrections).
 *  Authorization: the filer's department head, or any hr.manage holder, may decide. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';
import { queryOne } from '../src/db';

let ctx: TestContext;
let adminToken: string;
const A = () => ({ Authorization: `Bearer ${adminToken}` });
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  ctx = await setupApp();
  adminToken = await login(ctx.api);
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
      .send({ form_def_id: leaveId, data: { employee_name: member.name, reason: 'trip' }, status: 'pending' });
    expect(filed.status).toBe(201);

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
      .send({ form_def_id: leaveId, data: { employee_name: filer.name }, status: 'pending' });

    // Filer is not an approver at all.
    expect((await ctx.api.post(`/api/me/approvals/requests/${filed.body.id}/decide`)
      .set(bearer(filer.token)).send({ decision: 'approved' })).status).toBe(403);

    const dec = await ctx.api.post(`/api/me/approvals/requests/${filed.body.id}/decide`)
      .set(bearer(hr.token)).send({ decision: 'rejected' });
    expect(dec.status).toBe(200);
    expect(dec.body.status).toBe('rejected');
  });

  it('lets the filer cancel their own still-pending request', async () => {
    const filer = await linkedEmployee({});
    const leaveId = await requestFormId('leave_request');
    const filed = await ctx.api.post('/api/form-records').set(bearer(filer.token))
      .send({ form_def_id: leaveId, data: {}, status: 'pending' });
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
    expect(filed.status).toBe(201);

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
