/** Form actions engine (src/form-actions.ts): notify_employee + save_to_201 fire on record
    creation for the seeded HR memo forms; per-(record, action) idempotency on re-run. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';

let ctx: TestContext;
let token: string;
const hdr = (t = token) => ({ Authorization: `Bearer ${t}` });

let empUserToken: string;
let employeeId: number;
const EMP_NAME = 'Action Target Employee';

beforeAll(async () => {
  ctx = await setupApp();
  token = await login(ctx.api);
  const acct = await createEmployee(ctx.api, token, { username: 'action_target', role: 'warehouse' });
  empUserToken = acct.token;
  const emp = await ctx.api.post('/api/hr/employees').set(hdr())
    .send({ employee_no: 'TEST-ACT-1', name: EMP_NAME, daily_rate: 600, user_id: acct.id });
  employeeId = emp.body.id;
});
afterAll(() => cleanup(ctx));

async function formIdBySlug(slug: string): Promise<number> {
  const list = await ctx.api.get('/api/form-definitions').set(hdr());
  const f = list.body.find((x: { slug: string }) => x.slug === slug);
  if (!f) throw new Error(`form ${slug} not seeded`);
  return f.id;
}

describe('seeded memo forms carry actions', () => {
  it('the NTE form is seeded with notify_employee + save_to_201 + a template', async () => {
    const list = await ctx.api.get('/api/form-definitions').set(hdr());
    const nte = list.body.find((x: { slug: string }) => x.slug === 'nte');
    expect(nte).toBeTruthy();
    expect(nte.template_id).toBeTruthy();
    const types = (nte.actions || []).map((a: { type: string }) => a.type);
    expect(types).toContain('notify_employee');
    expect(types).toContain('save_to_201');
  });

  it('no_work_memo carries apply_no_work', async () => {
    const list = await ctx.api.get('/api/form-definitions').set(hdr());
    const nw = list.body.find((x: { slug: string }) => x.slug === 'no_work_memo');
    expect((nw.actions || []).map((a: { type: string }) => a.type)).toContain('apply_no_work');
  });
});

describe('actions fire on record creation', () => {
  it('issuing an NTE messages the employee and files it into their 201', async () => {
    const formId = await formIdBySlug('nte');
    const before = (await ctx.api.get(`/api/hr/employees/${employeeId}/documents`).set(hdr())).body.length;

    const res = await ctx.api.post('/api/form-records').set(hdr()).send({
      form_def_id: formId,
      status: 'submitted',
      data: {
        employee_name: EMP_NAME,
        subject: 'Tardiness',
        incident_date: '2026-09-01',
        details: 'Late 5 times in one cutoff.',
        response_deadline: '2026-09-10',
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.action_warnings).toEqual([]);

    // Employee's login account received a notice.
    const inbox = await ctx.api.get('/api/messages?box=inbox').set(hdr(empUserToken));
    expect(inbox.body.some((m: { subject: string | null }) => /Notice to Explain/i.test(m.subject || ''))).toBe(true);

    // A 201-file document was created.
    const docs = (await ctx.api.get(`/api/hr/employees/${employeeId}/documents`).set(hdr())).body;
    expect(docs.length).toBe(before + 1);
    expect(docs[0].title).toMatch(/Notice to Explain/);
  });

  it('warns (but still creates) when the target employee has no login account', async () => {
    const noAcct = await ctx.api.post('/api/hr/employees').set(hdr())
      .send({ employee_no: 'TEST-ACT-2', name: 'No Account Person', daily_rate: 500 });
    const formId = await formIdBySlug('nte');
    const res = await ctx.api.post('/api/form-records').set(hdr()).send({
      form_def_id: formId,
      status: 'submitted',
      data: { employee_name: 'No Account Person', subject: 'x', incident_date: '2026-09-01', details: 'y', response_deadline: '2026-09-10' },
    });
    expect(res.status).toBe(201);
    expect(res.body.action_warnings.join(' ')).toMatch(/no login account/i);
    // 201 filing still worked (doesn't need an account).
    expect((await ctx.api.get(`/api/hr/employees/${noAcct.body.id}/documents`).set(hdr())).body.length).toBe(1);
  });
});

describe('idempotency', () => {
  it('an approved-trigger action runs once even if the record re-enters approved', async () => {
    const def = await ctx.api.post('/api/form-definitions').set(hdr()).send({
      name: 'Ack Notice', slug: 'ack_notice', number_prefix: 'ACK', icon: 'file', scope: 'hr',
      fields: [{ key: 'employee_name', label: 'Employee', type: 'employee', required: true, options: [], default: '' }],
      actions: [{ type: 'notify_employee', run_on: 'approved', subject: 'Ack {number}' }],
    });
    const rec = await ctx.api.post('/api/form-records').set(hdr())
      .send({ form_def_id: def.body.id, status: 'draft', data: { employee_name: EMP_NAME } });

    const count = async () =>
      (await ctx.api.get('/api/messages?box=inbox').set(hdr(empUserToken))).body
        .filter((m: { subject: string | null }) => /^Ack ACK-/.test(m.subject || '')).length;

    await ctx.api.put(`/api/form-records/${rec.body.id}`).set(hdr())
      .send({ data: { employee_name: EMP_NAME }, status: 'approved' });
    expect(await count()).toBe(1);

    await ctx.api.put(`/api/form-records/${rec.body.id}`).set(hdr())
      .send({ data: { employee_name: EMP_NAME }, status: 'rejected' });
    await ctx.api.put(`/api/form-records/${rec.body.id}`).set(hdr())
      .send({ data: { employee_name: EMP_NAME }, status: 'approved' });
    expect(await count()).toBe(1); // not re-sent
  });
});
