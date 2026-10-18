import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';

let ctx: TestContext;
let admin: string;
let employee: { token: string; id: number; empId: number; name: string };
let head: { token: string };
let formId: number;
let firstShift: number;
let secondShift: number;
let workDate: string;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  ctx = await setupApp();
  admin = await login(ctx.api);
  const account = await createEmployee(ctx.api, admin, { role: 'csr' });
  const reviewer = await createEmployee(ctx.api, admin, { role: 'hr' });
  head = reviewer;
  const name = 'Schedule Employee';
  const emp = await ctx.api.post('/api/hr/employees').set(auth(admin)).send({ employee_no: 'SCH-1', name, user_id: account.id, daily_rate: 600 });
  employee = { token: account.token, id: account.id, empId: emp.body.id, name };
  const shift1 = await ctx.api.post('/api/hr/shifts').set(auth(admin)).send({ name: 'Morning', start_time: '08:00', end_time: '17:00' });
  const shift2 = await ctx.api.post('/api/hr/shifts').set(auth(admin)).send({ name: 'Late', start_time: '10:00', end_time: '19:00' });
  expect(shift1.status).toBe(201);
  expect(shift2.status).toBe(201);
  firstShift = shift1.body.id;
  secondShift = shift2.body.id;
  workDate = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
  const period = await ctx.api.post('/api/hr/periods').set(auth(admin)).send({ label: 'Schedule change test', start_date: workDate, end_date: workDate });
  expect(period.status).toBe(201);
  await ctx.api.post(`/api/hr/periods/${period.body.id}/employees`).set(auth(admin)).send({ employee_id: employee.empId });
  const roster = await ctx.api.put(`/api/hr/periods/${period.body.id}/attendance`).set(auth(admin)).send({
    employee_id: employee.empId, // Explicit working-day roster: independent of the execution date's weekend/holiday.
    days: [{ work_date: workDate, shift_id: firstShift, rest_day: 'no', holiday_type: 'none', time_in: '', time_out: '', notes: '' }],
  });
  expect(roster.status).toBe(200);
  const types = await ctx.api.get('/api/me/request-types').set(auth(employee.token));
  const type = types.body.find((row: { slug: string }) => row.slug === 'schedule_change');
  expect(type).toBeTruthy();
  formId = type.id;
  expect(type.fields.find((f: { key: string }) => f.key === 'requested_shift_id').options).toEqual(expect.arrayContaining([
    expect.objectContaining({ value: String(secondShift) }),
  ]));
});
afterAll(() => cleanup(ctx));

async function file(date = workDate, shiftId = secondShift) {
  return ctx.api.post('/api/form-records').set(auth(employee.token)).send({ form_def_id: formId, data: {
    employee_name: employee.name, work_date: date, requested_shift_id: String(shiftId), reason: 'School pickup',
  } });
}

describe('mobile schedule-change request', () => {
  it('requires a future published roster date and a valid shift', async () => {
    expect((await file('2020-01-01')).status).toBe(400);
    expect((await file(workDate, 999999)).status).toBe(400);
  });

  it('changes the published shift only after approval; stale approvals cannot overwrite it', async () => {
    const first = await file();
    const stale = await file();
    expect(first.status,JSON.stringify(first.body)).toBe(201);
    expect(stale.status).toBe(201);
    const before = await ctx.api.get('/api/me/schedule').set(auth(employee.token));
    expect(before.body.days.find((d: { work_date: string }) => d.work_date === workDate).shift_name).toBe('Morning');
    const review = await ctx.api.get('/api/me/approvals').set(auth(head.token));
    expect(review.body.requests.find((r: { id: number }) => r.id === first.body.id).display_data).toMatchObject({
      'Current shift': 'Morning · 08:00–17:00', 'Requested shift': 'Late · 10:00–19:00',
    });
    const approve = (id: number) => ctx.api.post(`/api/me/approvals/requests/${id}/decide`).set(auth(head.token)).send({ decision: 'approved' });
    expect((await approve(first.body.id)).status).toBe(200);
    const after = await ctx.api.get('/api/me/schedule').set(auth(employee.token));
    expect(after.body.days.find((d: { work_date: string }) => d.work_date === workDate).shift_name).toBe('Late');
    expect((await approve(stale.body.id)).status).toBe(409);
  });
});
