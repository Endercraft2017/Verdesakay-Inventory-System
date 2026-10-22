/** GET /api/hr/pending-requests — org-wide pending-request summary that feeds the HR Overview
 *  page's "Pending Requests" panel: counts per request-form type (leave, OT, ...) plus pending
 *  attendance/time-correction fixes, unscoped (unlike /me/approvals, which only shows what the
 *  caller may personally decide). */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';

let ctx: TestContext;
let adminToken: string;
const A = () => ({ Authorization: `Bearer ${adminToken}` });

async function formIdBySlug(slug: string): Promise<number> {
  const all = await ctx.api.get('/api/form-definitions').set(A());
  return all.body.find((f: { slug: string }) => f.slug === slug).id as number;
}

beforeAll(async () => {
  ctx = await setupApp();
  adminToken = await login(ctx.api);
  // leave_request isn't auto-seeded (real installs build it via Form Builder) — create it here,
  // same as tests/me-approvals.test.ts does for its own throwaway DB.
  await ctx.api.post('/api/form-definitions').set(A()).send({
    name: 'Leave Request', slug: 'leave_request', number_prefix: 'LV', icon: 'calendar', scope: 'hr',
    fields: [
      { key: 'employee_name', label: 'Employee Name', type: 'text', required: true, options: [], default: '' },
      { key: 'with_pay', label: 'With Pay?', type: 'select', required: true, options: ['Yes', 'No'], default: '' },
    ],
  });
});
afterAll(() => cleanup(ctx));

describe('GET /api/hr/pending-requests', () => {
  it('requires auth', async () => {
    expect((await ctx.api.get('/api/hr/pending-requests')).status).toBe(401);
  });

  it('counts only pending records, grouped by form type, and lists them in recent', async () => {
    for (const name of ['Ana Cruz','Ben Reyes','Cy Santos']) await ctx.api.post('/api/hr/employees').set(A()).send({ employee_no: name.replaceAll(' ','-'), name });
    const leaveId = await formIdBySlug('leave_request');
    const otId = await formIdBySlug('overtime_request'); // auto-seeded by src/db.ts

    const leave = await ctx.api.post('/api/form-records').set(A())
      .send({ form_def_id: leaveId, data: { employee_name: 'Ana Cruz', date_from: '2026-06-01', date_to: '2026-06-01', reason: 'Pending leave', with_pay: 'Yes' }, status: 'pending' });
    expect(leave.status).toBe(201);
    // Already decided — must not be counted as pending.
    const decided = await ctx.api.post('/api/form-records').set(A())
      .send({ form_def_id: leaveId, data: { employee_name: 'Ben Reyes', date_from: '2026-06-01', date_to: '2026-06-01', reason: 'Decided leave', with_pay: 'Yes' }, status: 'pending' });
    const reviewer = await createEmployee(ctx.api, adminToken, { role: 'hr' });
    expect((await ctx.api.post(`/api/me/approvals/requests/${decided.body.id}/decide`).set({ Authorization: `Bearer ${reviewer.token}` }).send({ decision: 'approved' })).status).toBe(200);
    await ctx.api.post('/api/form-records').set(A())
      .send({ form_def_id: otId, data: { employee_name: 'Cy Santos', work_date: '2026-06-01', reason: 'Pending overtime' }, status: 'pending' });

    const res = await ctx.api.get('/api/hr/pending-requests').set(A());
    expect(res.status).toBe(200);

    const leaveType = res.body.by_type.find((t: { slug: string }) => t.slug === 'leave_request');
    const otType = res.body.by_type.find((t: { slug: string }) => t.slug === 'overtime_request');
    expect(leaveType.count).toBe(1);
    expect(otType.count).toBe(1);
    expect(res.body.total).toBeGreaterThanOrEqual(2);

    expect(res.body.recent.some((r: { employee_name: string }) => r.employee_name === 'Ana Cruz')).toBe(true);
    expect(res.body.recent.some((r: { employee_name: string }) => r.employee_name === 'Ben Reyes')).toBe(false);
  });

  it('adds pending time_corrections to the total, separately from by_type', async () => {
    const acc = await createEmployee(ctx.api, adminToken, { role: 'admin_staff' });
    const emp = await ctx.api.post('/api/hr/employees').set(A())
      .send({ employee_no: 'PR-1', name: 'Correction Filer', user_id: acc.id });
    expect(emp.status).toBe(201);

    const before = await ctx.api.get('/api/hr/pending-requests').set(A());
    const filed = await ctx.api.post('/api/me/time-corrections').set({ Authorization: `Bearer ${acc.token}` })
      .send({ work_date: '2026-01-05', requested_in: '08:00', requested_out: '17:00', reason: 'forgot to punch' });
    expect(filed.status).toBe(201);

    const after = await ctx.api.get('/api/hr/pending-requests').set(A());
    expect(after.body.time_corrections).toBe(before.body.time_corrections + 1);
    expect(after.body.total).toBe(before.body.total + 1);
    expect(after.body.recent.some((r: { employee_name: string }) => r.employee_name === 'Correction Filer')).toBe(true);
  });
});
