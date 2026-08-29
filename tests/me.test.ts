/** Employee self-service (/api/me): payslips, schedule, request types/list — all
 *  scoped to the caller's linked employee. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';
import { run } from '../src/db';

let ctx: TestContext;
let adminToken: string;
const A = () => ({ Authorization: `Bearer ${adminToken}` });

beforeAll(async () => {
  ctx = await setupApp();
  adminToken = await login(ctx.api);
});
afterAll(() => cleanup(ctx));

async function linked() {
  const acc = await createEmployee(ctx.api, adminToken, { role: 'warehouse' });
  const name = acc.username.toUpperCase();
  const emp = await ctx.api.post('/api/hr/employees').set(A()).send({
    employee_no: 'M' + Math.floor(Math.random() * 1e6), name, user_id: acc.id,
    daily_rate: 500, rate_type: 'daily', status: 'regular',
  });
  return { token: acc.token, id: emp.body.id as number, name };
}

/** Find a seeded/existing form definition by slug (they're auto-seeded on init). */
async function formBySlug(slug: string): Promise<number> {
  const all = await ctx.api.get('/api/form-definitions').set(A());
  const f = all.body.find((x: { slug: string }) => x.slug === slug);
  if (!f) throw new Error(`form "${slug}" not seeded`);
  return f.id as number;
}

describe('employee self-service', () => {
  it('403s an account with no linked employee', async () => {
    const acc = await createEmployee(ctx.api, adminToken, { role: 'warehouse' });
    const res = await ctx.api.get('/api/me/payslips').set({ Authorization: `Bearer ${acc.token}` });
    expect(res.status).toBe(403);
  });

  it('returns only this employee\'s payslips', async () => {
    const a = await linked();
    const b = await linked();
    const formId = await formBySlug('hr_payroll');
    await ctx.api.post('/api/form-records').set(A()).send({ form_def_id: formId, data: { employee_name: a.name, net_pay: 9000 } });
    await ctx.api.post('/api/form-records').set(A()).send({ form_def_id: formId, data: { employee_name: b.name, net_pay: 7000 } });

    const mine = await ctx.api.get('/api/me/payslips').set({ Authorization: `Bearer ${a.token}` });
    expect(mine.status).toBe(200);
    expect(mine.body).toHaveLength(1);
    expect(mine.body[0].data.employee_name).toBe(a.name);
    expect(mine.body[0].data.net_pay).toBe(9000);
  });

  it('lists request types and only the caller\'s own request records', async () => {
    const a = await linked();
    const b = await linked();
    const leaveId = await formBySlug('leave_request');

    const types = await ctx.api.get('/api/me/request-types').set({ Authorization: `Bearer ${a.token}` });
    expect(types.body.some((t: { slug: string }) => t.slug === 'leave_request')).toBe(true);

    await ctx.api.post('/api/form-records').set({ Authorization: `Bearer ${a.token}` })
      .send({ form_def_id: leaveId, data: { employee_name: a.name, reason: 'trip' } });
    await ctx.api.post('/api/form-records').set({ Authorization: `Bearer ${b.token}` })
      .send({ form_def_id: leaveId, data: { employee_name: b.name, reason: 'sick' } });

    const mine = await ctx.api.get('/api/me/requests').set({ Authorization: `Bearer ${a.token}` });
    expect(mine.body).toHaveLength(1);
    expect(mine.body[0].data.reason).toBe('trip');
  });

  it('schedule returns the current cutoff\'s roster days', async () => {
    const a = await linked();
    const d = (offset: number) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
    const p = await ctx.api.post('/api/hr/periods').set(A())
      .send({ label: 'Current cutoff', start_date: d(-7), end_date: d(7) });
    run('INSERT INTO attendance_records (period_id, employee_id, work_date, time_in) VALUES (?, ?, ?, ?)',
      p.body.id, a.id, d(0), '08:00');

    const res = await ctx.api.get('/api/me/schedule').set({ Authorization: `Bearer ${a.token}` });
    expect(res.status).toBe(200);
    expect(res.body.days.length).toBeGreaterThan(0);
    expect(res.body.days[0].work_date).toBe(d(0));
    expect(res.body.days[0].period_label).toBe('Current cutoff');
  });
});

describe('task scheduling', () => {
  it('accepts due_date / remind_at / notes and re-arms the reminder on change', async () => {
    const acc = await createEmployee(ctx.api, adminToken, { role: 'warehouse' });
    const h = { Authorization: `Bearer ${acc.token}` };
    const c = await ctx.api.post('/api/tasks').set(h).send({
      title: 'Ship pallet', due_date: '2026-09-01 08:00', remind_at: '2026-09-01 07:30', notes: 'dock 2',
    });
    expect(c.status).toBe(201);
    const id = c.body.id;

    // mark reminder sent, then change the time → remind_sent resets to 0
    run('UPDATE tasks SET remind_sent = 1 WHERE id = ?', id);
    await ctx.api.put(`/api/tasks/${id}`).set(h).send({ remind_at: '2026-09-01 07:00' });
    const rows = await ctx.api.get('/api/tasks').set(h);
    const t = rows.body.find((x: { id: number }) => x.id === id);
    expect(t.remind_at).toBe('2026-09-01 07:00');
    expect(t.remind_sent).toBe(0);
    expect(t.notes).toBe('dock 2');
  });
});
