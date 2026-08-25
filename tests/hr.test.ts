/** HR Time Keeping: employees master list, cutoff periods with a daily time-in/out
    roster, and generating payslips into the (auto-seeded) HR Payroll form. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';

let ctx: TestContext;
let token: string;
const hdr = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  ctx = await setupApp();
  token = await login(ctx.api);
});
afterAll(() => cleanup(ctx));

describe('hr', () => {
  it('requires authentication', async () => {
    expect((await ctx.api.get('/api/hr/employees')).status).toBe(401);
  });

  it('auto-seeds the HR Payroll form definition', async () => {
    const res = await ctx.api.get('/api/form-definitions').set(hdr());
    const hrPayroll = res.body.find((f: { slug: string }) => f.slug === 'hr_payroll');
    expect(hrPayroll).toBeDefined();
    expect(hrPayroll.fields.some((f: { key: string }) => f.key === 'employee_name')).toBe(true);
  });

  it('creates and lists an employee, auto-numbered with a default probationary status', async () => {
    const res = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ name: 'Juan Dela Cruz', position: 'Warehouseman', daily_rate: 610 });
    expect(res.status).toBe(201);
    const list = await ctx.api.get('/api/hr/employees').set(hdr());
    const created = list.body.find((e: { id: number }) => e.id === res.body.id);
    expect(created).toBeDefined();
    expect(created.employee_no).toMatch(/^EMP-\d{5}$/);
    expect(created.status).toBe('probationary');
  });

  it('accepts the full 201-file field set and a photo data URI, rejects a non-image photo string', async () => {
    const ok = await ctx.api.post('/api/hr/employees').set(hdr()).send({
      name: 'Rosa Cruz', status: 'regular', start_date: '2020-01-15',
      sss_no: '01-2345678-9', philhealth_no: '12-345678901-2', pagibig_no: '1234-5678-9012', tin_no: '123-456-789-000',
      photo: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    });
    expect(ok.status).toBe(201);
    const detail = (await ctx.api.get('/api/hr/employees').set(hdr())).body.find((e: { id: number }) => e.id === ok.body.id);
    expect(detail.status).toBe('regular');
    expect(detail.sss_no).toBe('01-2345678-9');
    expect(detail.photo).toMatch(/^data:image\//);

    const bad = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ name: 'Bad Photo', photo: 'not-an-image' });
    expect(bad.status).toBe(400);
  });

  it('filters employees by department and status', async () => {
    const dept = await ctx.api.post('/api/users/departments').set(hdr()).send({ name: 'Warehouse Ops' });
    await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ name: 'Dept Filter Test', department_id: dept.body.id, status: 'terminated' });

    const byDept = await ctx.api.get('/api/hr/employees').query({ department_id: dept.body.id }).set(hdr());
    expect(byDept.body.every((e: { department_id: number }) => e.department_id === dept.body.id)).toBe(true);
    expect(byDept.body.length).toBeGreaterThan(0);

    const byStatus = await ctx.api.get('/api/hr/employees').query({ status: 'terminated' }).set(hdr());
    expect(byStatus.body.every((e: { status: string }) => e.status === 'terminated')).toBe(true);
    expect(byStatus.body.some((e: { department_id: number }) => e.department_id === dept.body.id)).toBe(true);
  });

  it('uploads, lists, downloads, and deletes a 201-file document for an employee', async () => {
    const emp = await ctx.api.post('/api/hr/employees').set(hdr()).send({ name: 'Doc Owner' });

    const upload = await ctx.api.post(`/api/hr/employees/${emp.body.id}/documents`).set(hdr())
      .field('title', 'Employment Contract').attach('file', Buffer.from('dummy pdf bytes'), 'contract.pdf');
    expect(upload.status).toBe(201);

    const list = await ctx.api.get(`/api/hr/employees/${emp.body.id}/documents`).set(hdr());
    expect(list.body).toHaveLength(1);
    expect(list.body[0].title).toBe('Employment Contract');

    const dl = await ctx.api.get(`/api/hr/employees/${emp.body.id}/documents/${upload.body.id}/download`).set(hdr());
    expect(dl.status).toBe(200);
    expect(Buffer.from(dl.body).toString()).toBe('dummy pdf bytes');

    const del = await ctx.api.delete(`/api/hr/employees/${emp.body.id}/documents/${upload.body.id}`).set(hdr());
    expect(del.status).toBe(200);
    const listAfter = await ctx.api.get(`/api/hr/employees/${emp.body.id}/documents`).set(hdr());
    expect(listAfter.body).toHaveLength(0);
  });

  it('creates a cutoff, adds an employee, and pre-populates blank day rows for the range', async () => {
    const emp = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ name: 'Maria Santos', daily_rate: 700 });
    const period = await ctx.api.post('/api/hr/periods').set(hdr())
      .send({ label: 'Aug 1-5, 2026', start_date: '2026-08-01', end_date: '2026-08-05' });
    expect(period.status).toBe(201);

    const add = await ctx.api.post(`/api/hr/periods/${period.body.id}/employees`).set(hdr())
      .send({ employee_id: emp.body.id });
    expect(add.status).toBe(201);

    const detail = await ctx.api.get(`/api/hr/periods/${period.body.id}`).set(hdr());
    expect(detail.body.roster).toHaveLength(1);
    expect(detail.body.roster[0].days_total).toBe(5); // Aug 1..5 inclusive

    const days = await ctx.api.get(`/api/hr/periods/${period.body.id}/attendance?employee_id=${emp.body.id}`).set(hdr());
    expect(days.body.map((d: { work_date: string }) => d.work_date)).toEqual([
      '2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05',
    ]);
    expect(days.body.every((d: { time_in: string | null }) => d.time_in === null)).toBe(true);
  });

  it('saves daily time-in/out for an employee, replacing prior rows', async () => {
    const emp = await ctx.api.post('/api/hr/employees').set(hdr()).send({ name: 'Pedro Reyes' });
    const period = await ctx.api.post('/api/hr/periods').set(hdr())
      .send({ label: 'Aug 6-7, 2026', start_date: '2026-08-06', end_date: '2026-08-07' });
    await ctx.api.post(`/api/hr/periods/${period.body.id}/employees`).set(hdr()).send({ employee_id: emp.body.id });

    const save = await ctx.api.put(`/api/hr/periods/${period.body.id}/attendance`).set(hdr()).send({
      employee_id: emp.body.id,
      days: [
        { work_date: '2026-08-06', time_in: '08:00', time_out: '17:00', notes: '' },
        { work_date: '2026-08-07', time_in: '08:15', time_out: '17:05', notes: 'late' },
      ],
    });
    expect(save.status).toBe(200);

    const days = await ctx.api.get(`/api/hr/periods/${period.body.id}/attendance?employee_id=${emp.body.id}`).set(hdr());
    expect(days.body).toHaveLength(2);
    expect(days.body[0].time_in).toBe('08:00');
    expect(days.body[1].notes).toBe('late');

    const detail = await ctx.api.get(`/api/hr/periods/${period.body.id}`).set(hdr());
    expect(detail.body.roster[0].days_logged).toBe(2);
  });

  it('generates payslips into the HR Payroll form, then updates on a second call instead of duplicating', async () => {
    const emp = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ name: 'Ana Lim', position: 'Clerk', daily_rate: 650 });
    const period = await ctx.api.post('/api/hr/periods').set(hdr())
      .send({ label: 'Aug 8-9, 2026', start_date: '2026-08-08', end_date: '2026-08-09' });
    await ctx.api.post(`/api/hr/periods/${period.body.id}/employees`).set(hdr()).send({ employee_id: emp.body.id });

    const gen1 = await ctx.api.post(`/api/hr/periods/${period.body.id}/generate-payslips`).set(hdr())
      .send({ payroll_period: 'Aug 8-9, 2026', pay_date: '2026-08-10' });
    expect(gen1.status).toBe(201);
    expect(gen1.body.created).toBe(1);
    expect(gen1.body.updated).toBe(0);

    const records = await ctx.api.get(`/api/form-definitions/${gen1.body.form_id}/records`).query({ period: 'Aug 8-9, 2026' }).set(hdr());
    expect(records.body).toHaveLength(1);
    expect(records.body[0].data.employee_name).toBe('Ana Lim');
    expect(records.body[0].data.daily_rate).toBe(650);
    expect(records.body[0].data.pay_date).toBe('2026-08-10');

    const gen2 = await ctx.api.post(`/api/hr/periods/${period.body.id}/generate-payslips`).set(hdr())
      .send({ payroll_period: 'Aug 8-9, 2026' });
    expect(gen2.body.created).toBe(0);
    expect(gen2.body.updated).toBe(1);

    const recordsAfter = await ctx.api.get(`/api/form-definitions/${gen1.body.form_id}/records`).query({ period: 'Aug 8-9, 2026' }).set(hdr());
    expect(recordsAfter.body).toHaveLength(1); // still one record, not duplicated
  });

  it('blocks deleting an employee with attendance history (409), deleting is fine otherwise', async () => {
    const emp = await ctx.api.post('/api/hr/employees').set(hdr()).send({ name: 'Has History' });
    const period = await ctx.api.post('/api/hr/periods').set(hdr())
      .send({ label: 'Aug 20-21, 2026', start_date: '2026-08-20', end_date: '2026-08-21' });
    await ctx.api.post(`/api/hr/periods/${period.body.id}/employees`).set(hdr()).send({ employee_id: emp.body.id });

    const blocked = await ctx.api.delete(`/api/hr/employees/${emp.body.id}`).set(hdr());
    expect(blocked.status).toBe(409);

    const noHistory = await ctx.api.post('/api/hr/employees').set(hdr()).send({ name: 'No History' });
    const ok = await ctx.api.delete(`/api/hr/employees/${noHistory.body.id}`).set(hdr());
    expect(ok.status).toBe(200);
  });

  it('rejects generating payslips for a cutoff with no roster', async () => {
    const period = await ctx.api.post('/api/hr/periods').set(hdr())
      .send({ label: 'Empty cutoff', start_date: '2026-09-01', end_date: '2026-09-02' });
    const res = await ctx.api.post(`/api/hr/periods/${period.body.id}/generate-payslips`).set(hdr())
      .send({ payroll_period: 'Empty cutoff' });
    expect(res.status).toBe(400);
  });

  it('enforces hr.manage on writes for a non-HR role, while hr.view allows reads', async () => {
    const csr = await createEmployee(ctx.api, token, { role: 'csr' });
    const readRes = await ctx.api.get('/api/hr/employees').set({ Authorization: `Bearer ${csr.token}` });
    expect(readRes.status).toBe(403); // csr has neither hr.view nor hr.manage by default

    const hrUser = await createEmployee(ctx.api, token, { role: 'hr' });
    const hrRead = await ctx.api.get('/api/hr/employees').set({ Authorization: `Bearer ${hrUser.token}` });
    expect(hrRead.status).toBe(200);
    const hrWrite = await ctx.api.post('/api/hr/employees').set({ Authorization: `Bearer ${hrUser.token}` })
      .send({ name: 'Created by HR role' });
    expect(hrWrite.status).toBe(201);
  });
});
