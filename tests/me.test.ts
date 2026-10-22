/** Employee self-service (/api/me): payslips, schedule, request types/list — all
 *  scoped to the caller's linked employee. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';
// NOTE: `run` is imported dynamically inside beforeAll, after setupApp() sets DB_PATH — a
// top-level `import ... from '../src/shared/db'` would evaluate DB_PATH before it's set (real
// data.db, not the throwaway per-file one). See helpers.ts's own doc comment.
let run: typeof import('../src/shared/db').run;
let __sentPush: typeof import('../src/shared/push').__sentPush;

let ctx: TestContext;
let adminToken: string;
const A = () => ({ Authorization: `Bearer ${adminToken}` });

beforeAll(async () => {
  ctx = await setupApp();
  ({ run } = await import('../src/shared/db'));
  ({ __sentPush } = await import('../src/shared/push'));
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
    const own = await ctx.api.post('/api/form-records').set(A()).send({ form_def_id: formId, data: { employee_name: a.name, net_pay: 9000 } });
    const theirs = await ctx.api.post('/api/form-records').set(A()).send({ form_def_id: formId, data: { employee_name: b.name, net_pay: 7000 } });
    await ctx.api.post(`/api/hr/payroll/${own.body.id}/mark-paid`).set(A());
    await ctx.api.post(`/api/hr/payroll/${theirs.body.id}/mark-paid`).set(A());

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
      .send({ form_def_id: leaveId, data: { employee_name: a.name, reason: 'trip', date_from: '2026-06-01', date_to: '2026-06-01' } });
    await ctx.api.post('/api/form-records').set({ Authorization: `Bearer ${b.token}` })
      .send({ form_def_id: leaveId, data: { employee_name: b.name, reason: 'sick', date_from: '2026-06-01', date_to: '2026-06-01' } });

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

describe('GET /api/me/today', () => {
  it('returns a greeting + a ranked stack, high-urgency first', async () => {
    const a = await linked();
    const h = { Authorization: `Bearer ${a.token}` };
    // an overdue task -> high; a pending request -> medium
    await ctx.api.post('/api/tasks').set(h).send({ title: 'Overdue thing', due_date: '2000-01-01' });
    const leaveId = await formBySlug('leave_request');
    await ctx.api.post('/api/form-records').set(h)
      .send({ form_def_id: leaveId, data: { employee_name: a.name, date_from: '2026-06-01', date_to: '2026-06-01', reason: 'Pending leave' }, status: 'pending' });

    const res = await ctx.api.get('/api/me/today').set(h);
    expect(res.status).toBe(200);
    expect(res.body.greeting).toHaveProperty('part_of_day');
    expect(Array.isArray(res.body.stack)).toBe(true);
    const kinds = res.body.stack.map((s: { kind: string }) => s.kind);
    expect(kinds).toContain('task');
    expect(kinds).toContain('request');
    // not clocked in -> a high-urgency punch item leads the stack
    expect(res.body.stack[0].urgency).toBe('high');
    expect(res.body.clock).toMatchObject({ linked: true, clocked_in: false });
  });

  it('works for a non-employee account (no clock, still lists tasks)', async () => {
    const acc = await createEmployee(ctx.api, adminToken, { role: 'warehouse' });
    const h = { Authorization: `Bearer ${acc.token}` };
    await ctx.api.post('/api/tasks').set(h).send({ title: 'Due today', due_date: new Date().toISOString().slice(0, 10) });
    const res = await ctx.api.get('/api/me/today').set(h);
    expect(res.status).toBe(200);
    expect(res.body.clock).toBeNull();
    expect(res.body.stack.some((s: { kind: string }) => s.kind === 'task')).toBe(true);
  });
});

describe('unrecorded OT (mobile prompt + Home reminder)', () => {
  async function shiftEndingAt(endTime: string) {
    const s = await ctx.api.post('/api/hr/shifts').set(A())
      .send({ name: 'OT Test Shift ' + endTime, start_time: '08:00', end_time: endTime, is_default: false });
    return s.body.id as number;
  }
  function today() { return new Date().toISOString().slice(0, 10); }

  it('flags a day with a block-worthy clock-out past the shift end and no OT form linked', async () => {
    const a = await linked();
    const shiftId = await shiftEndingAt('17:00');
    const p = await ctx.api.post('/api/hr/periods').set(A())
      .send({ label: 'OT Detect Cutoff', start_date: today(), end_date: today() });
    run(
      'INSERT INTO attendance_records (period_id, employee_id, work_date, time_in, time_out, shift_id) VALUES (?, ?, ?, ?, ?, ?)',
      p.body.id, a.id, today(), '08:00', '19:00', shiftId
    );

    const res = await ctx.api.get('/api/me/unrecorded-ot').set({ Authorization: `Bearer ${a.token}` });
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].work_date).toBe(today());
    expect(res.body[0].ot_minutes).toBeGreaterThan(0);
  });

  it('does not flag a day already linked to an Overtime Request form', async () => {
    const a = await linked();
    const shiftId = await shiftEndingAt('17:00');
    const otFormId = await formBySlug('overtime_request');
    const otRecord = await ctx.api.post('/api/form-records').set(A())
      .send({ form_def_id: otFormId, data: { employee_name: a.name, work_date: today(), reason: 'Overtime coverage' }, status: 'approved' });
    const p = await ctx.api.post('/api/hr/periods').set(A())
      .send({ label: 'OT Linked Cutoff', start_date: today(), end_date: today() });
    run(
      'INSERT INTO attendance_records (period_id, employee_id, work_date, time_in, time_out, shift_id, form_record_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      p.body.id, a.id, today(), '08:00', '19:00', shiftId, otRecord.body.id
    );

    const res = await ctx.api.get('/api/me/unrecorded-ot').set({ Authorization: `Bearer ${a.token}` });
    expect(res.body).toHaveLength(0);
  });

  it('stops flagging a day once the employee has filed an Overtime Request for it, even before HR links it', async () => {
    const a = await linked();
    const shiftId = await shiftEndingAt('17:00');
    const p = await ctx.api.post('/api/hr/periods').set(A())
      .send({ label: 'OT Filed Cutoff', start_date: today(), end_date: today() });
    run(
      'INSERT INTO attendance_records (period_id, employee_id, work_date, time_in, time_out, shift_id) VALUES (?, ?, ?, ?, ?, ?)',
      p.body.id, a.id, today(), '08:00', '19:00', shiftId
    );
    // Flagged before filing…
    let res = await ctx.api.get('/api/me/unrecorded-ot').set({ Authorization: `Bearer ${a.token}` });
    expect(res.body).toHaveLength(1);
    // …the employee self-files an OT request (lands as 'pending', not linked to the day)…
    const otFormId = await formBySlug('overtime_request');
    await ctx.api.post('/api/form-records').set({ Authorization: `Bearer ${a.token}` })
      .send({ form_def_id: otFormId, data: { employee_name: a.name, work_date: today(), reason: 'stayed late' }, status: 'pending' });
    // …and the nudge goes away.
    res = await ctx.api.get('/api/me/unrecorded-ot').set({ Authorization: `Bearer ${a.token}` });
    expect(res.body).toHaveLength(0);
  });

  it('a day left on time is never flagged', async () => {
    const a = await linked();
    const shiftId = await shiftEndingAt('17:00');
    const p = await ctx.api.post('/api/hr/periods').set(A())
      .send({ label: 'OT None Cutoff', start_date: today(), end_date: today() });
    run(
      'INSERT INTO attendance_records (period_id, employee_id, work_date, time_in, time_out, shift_id) VALUES (?, ?, ?, ?, ?, ?)',
      p.body.id, a.id, today(), '08:00', '17:00', shiftId
    );

    const res = await ctx.api.get('/api/me/unrecorded-ot').set({ Authorization: `Bearer ${a.token}` });
    expect(res.body).toHaveLength(0);
  });

  it('surfaces as an "ot" item in the /me/today stack, with the flagged date in params', async () => {
    const a = await linked();
    const h = { Authorization: `Bearer ${a.token}` };
    const shiftId = await shiftEndingAt('17:00');
    const p = await ctx.api.post('/api/hr/periods').set(A())
      .send({ label: 'OT Stack Cutoff', start_date: today(), end_date: today() });
    run(
      'INSERT INTO attendance_records (period_id, employee_id, work_date, time_in, time_out, shift_id) VALUES (?, ?, ?, ?, ?, ?)',
      p.body.id, a.id, today(), '08:00', '19:00', shiftId
    );

    const res = await ctx.api.get('/api/me/today').set(h);
    const otItem = res.body.stack.find((s: { kind: string }) => s.kind === 'ot');
    expect(otItem).toBeDefined();
    expect(otItem.route).toBe('requests');
    expect(otItem.params).toMatchObject({ type: 'overtime_request', date: today() });
  });

  it('PUT /hr/periods/:id/attendance pushes a notification to the employee when the saved day shows unrecorded OT', async () => {
    const a = await linked();
    await ctx.api.post('/api/push/subscribe').set({ Authorization: `Bearer ${a.token}` })
      .send({ endpoint: 'https://push.example.com/sub/ot-' + a.id, keys: { p256dh: 'BAY'.padEnd(87, 'x'), auth: 'abc123def456' } });
    const shiftId = await shiftEndingAt('17:00');
    const p = await ctx.api.post('/api/hr/periods').set(A())
      .send({ label: 'OT Notify Cutoff', start_date: today(), end_date: today() });
    await ctx.api.post(`/api/hr/periods/${p.body.id}/employees`).set(A()).send({ employee_id: a.id });

    __sentPush.length = 0;
    const res = await ctx.api.put(`/api/hr/periods/${p.body.id}/attendance`).set(A()).send({
      employee_id: a.id,
      days: [{ work_date: today(), time_in: '08:00', time_out: '19:00', notes: '', shift_id: shiftId }],
    });
    expect(res.status).toBe(200);
    // The notify call is fire-and-forget after the response — give its microtask a tick.
    await new Promise((r) => setTimeout(r, 50));
    expect(__sentPush.some((x) => /Unrecorded overtime/.test(x.payload.title))).toBe(true);
  });

  it('PUT /hr/periods/:id/attendance does NOT notify when the day is linked to an Overtime Request form', async () => {
    const a = await linked();
    await ctx.api.post('/api/push/subscribe').set({ Authorization: `Bearer ${a.token}` })
      .send({ endpoint: 'https://push.example.com/sub/ot-linked-' + a.id, keys: { p256dh: 'BAY'.padEnd(87, 'x'), auth: 'abc123def456' } });
    const shiftId = await shiftEndingAt('17:00');
    const otFormId = await formBySlug('overtime_request');
    const otRecord = await ctx.api.post('/api/form-records').set(A())
      .send({ form_def_id: otFormId, data: { employee_name: a.name, work_date: today(), reason: 'Overtime coverage' }, status: 'approved' });
    const p = await ctx.api.post('/api/hr/periods').set(A())
      .send({ label: 'OT No-Notify Cutoff', start_date: today(), end_date: today() });
    await ctx.api.post(`/api/hr/periods/${p.body.id}/employees`).set(A()).send({ employee_id: a.id });

    __sentPush.length = 0;
    await ctx.api.put(`/api/hr/periods/${p.body.id}/attendance`).set(A()).send({
      employee_id: a.id,
      days: [{ work_date: today(), time_in: '08:00', time_out: '19:00', notes: '', shift_id: shiftId, form_record_id: otRecord.body.id }],
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(__sentPush.some((x) => /Unrecorded overtime/.test(x.payload.title))).toBe(false);
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
