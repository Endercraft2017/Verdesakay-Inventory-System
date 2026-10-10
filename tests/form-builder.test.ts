/** Form builder: form definition CRUD, record CRUD, global variables, auth & permissions. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';

let ctx: TestContext;
let adminToken: string;
let empToken: string;
const hdr = (tok: string) => ({ Authorization: `Bearer ${tok}` });

const sampleForm = {
  name: 'Leave Request',
  slug: 'leave_request',
  number_prefix: 'LR',
  icon: 'file',
  fields: [
    { key: 'reason', label: 'Reason', type: 'text', required: true, options: [], default: '' },
    { key: 'days', label: 'Days', type: 'number', required: true, options: [], default: '1' },
    { key: 'leave_type', label: 'Type', type: 'select', required: false, options: ['Sick', 'Vacation'], default: '' },
  ],
};

beforeAll(async () => {
  ctx = await setupApp();
  adminToken = await login(ctx.api);
  const emp = await createEmployee(ctx.api, adminToken, { role: 'warehouse' });
  empToken = emp.token;
});
afterAll(() => cleanup(ctx));

// ─── Form Definitions ───────────────────────────────────────────────────────

describe('form definitions', () => {
  let formId: number;

  it('requires auth to list', async () => {
    expect((await ctx.api.get('/api/form-definitions')).status).toBe(401);
  });

  it('any user can list form definitions (empty at start)', async () => {
    const res = await ctx.api.get('/api/form-definitions').set(hdr(empToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('employee cannot create a form definition (403)', async () => {
    const res = await ctx.api.post('/api/form-definitions').set(hdr(empToken)).send(sampleForm);
    expect(res.status).toBe(403);
  });

  it('admin can create a form definition', async () => {
    const res = await ctx.api.post('/api/form-definitions').set(hdr(adminToken)).send(sampleForm);
    expect(res.status).toBe(201);
    formId = res.body.id;
    expect(typeof formId).toBe('number');
  });

  it('detail returns parsed fields array', async () => {
    const res = await ctx.api.get('/api/form-definitions/' + formId).set(hdr(empToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.fields)).toBe(true);
    expect(res.body.fields).toHaveLength(3);
    expect(res.body.fields[0].key).toBe('reason');
  });

  it('list includes record_count', async () => {
    const res = await ctx.api.get('/api/form-definitions').set(hdr(empToken));
    const form = res.body.find((f: { id: number }) => f.id === formId);
    expect(form).toBeDefined();
    expect(form.record_count).toBe(0);
  });

  it('rejects duplicate slug', async () => {
    const res = await ctx.api.post('/api/form-definitions').set(hdr(adminToken)).send(sampleForm);
    expect(res.status).toBe(500); // UNIQUE constraint
  });

  it('admin can update the form definition', async () => {
    const updated = { ...sampleForm, name: 'Leave Request v2' };
    const res = await ctx.api.put('/api/form-definitions/' + formId).set(hdr(adminToken)).send(updated);
    expect(res.status).toBe(200);
    const detail = await ctx.api.get('/api/form-definitions/' + formId).set(hdr(empToken));
    expect(detail.body.name).toBe('Leave Request v2');
  });

  it('employee cannot update a form definition (403)', async () => {
    const res = await ctx.api.put('/api/form-definitions/' + formId).set(hdr(empToken)).send(sampleForm);
    expect(res.status).toBe(403);
  });

  // Records + delete tests follow so we reuse formId.
  it('stores formId for later tests', () => { expect(formId).toBeGreaterThan(0); });

  it('accepts an "employee" field type (live employee dropdown, not free text)', async () => {
    const res = await ctx.api.post('/api/form-definitions').set(hdr(adminToken)).send({
      name: 'Employee Field Test', slug: 'employee_field_test', number_prefix: 'EF', icon: 'file',
      fields: [{ key: 'employee_name', label: 'Employee Name', type: 'employee', required: true, options: [], default: '' }],
    });
    expect(res.status).toBe(201);
    const detail = await ctx.api.get('/api/form-definitions/' + res.body.id).set(hdr(empToken));
    expect(detail.body.fields[0].type).toBe('employee');
  });

  it('rejects an unknown field type', async () => {
    const res = await ctx.api.post('/api/form-definitions').set(hdr(adminToken)).send({
      name: 'Bad Field Type', slug: 'bad_field_type', number_prefix: 'BF', icon: 'file',
      fields: [{ key: 'x', label: 'X', type: 'bogus', required: false, options: [], default: '' }],
    });
    expect(res.status).toBe(400);
  });
});

// ─── Per-section access control (forms.manage.<scope>) ─────────────────────────

describe('form definition scope-based access control', () => {
  let hrToken: string;
  let accountingToken: string;
  let adminStaffToken: string;

  beforeAll(async () => {
    hrToken = (await createEmployee(ctx.api, adminToken, { role: 'hr' })).token;
    accountingToken = (await createEmployee(ctx.api, adminToken, { role: 'accounting' })).token;
    adminStaffToken = (await createEmployee(ctx.api, adminToken, { role: 'admin_staff' })).token;
  });

  const formFor = (scope: string | null, slugSuffix: string) => ({
    name: 'Scope Test ' + slugSuffix, slug: 'scope_test_' + slugSuffix, number_prefix: 'ST', icon: 'file',
    fields: [{ key: 'note', label: 'Note', type: 'text', required: false, options: [], default: '' }],
    scope,
  });

  it('hr can create an hr-scoped form; warehouse (inventory) cannot', async () => {
    const okRes = await ctx.api.post('/api/form-definitions').set(hdr(hrToken)).send(formFor('hr', 'a'));
    expect(okRes.status).toBe(201);
    const forbidden = await ctx.api.post('/api/form-definitions').set(hdr(empToken)).send(formFor('hr', 'b'));
    expect(forbidden.status).toBe(403);
  });

  it('warehouse can create an inventory-scoped form; accounting cannot', async () => {
    const okRes = await ctx.api.post('/api/form-definitions').set(hdr(empToken)).send(formFor('inventory', 'c'));
    expect(okRes.status).toBe(201);
    const forbidden = await ctx.api.post('/api/form-definitions').set(hdr(accountingToken)).send(formFor('inventory', 'd'));
    expect(forbidden.status).toBe(403);
  });

  it('accounting can create an accounting-scoped form; hr cannot', async () => {
    const okRes = await ctx.api.post('/api/form-definitions').set(hdr(accountingToken)).send(formFor('accounting', 'e'));
    expect(okRes.status).toBe(201);
    const forbidden = await ctx.api.post('/api/form-definitions').set(hdr(hrToken)).send(formFor('accounting', 'f'));
    expect(forbidden.status).toBe(403);
  });

  it('admin_staff can create an admin-scoped form; accounting cannot', async () => {
    const okRes = await ctx.api.post('/api/form-definitions').set(hdr(adminStaffToken)).send(formFor('admin', 'g'));
    expect(okRes.status).toBe(201);
    const forbidden = await ctx.api.post('/api/form-definitions').set(hdr(accountingToken)).send(formFor('admin', 'h'));
    expect(forbidden.status).toBe(403);
  });

  it('General (null scope) requires every forms.manage.* — a single-section role is not enough', async () => {
    const res = await ctx.api.post('/api/form-definitions').set(hdr(hrToken)).send(formFor(null, 'i'));
    expect(res.status).toBe(403);
    const okRes = await ctx.api.post('/api/form-definitions').set(hdr(adminToken)).send(formFor(null, 'j'));
    expect(okRes.status).toBe(201);
  });

  it('a section role cannot edit or delete a form in a different section (403), even though it exists', async () => {
    const created = await ctx.api.post('/api/form-definitions').set(hdr(hrToken)).send(formFor('hr', 'k'));
    const id = created.body.id;
    const editForbidden = await ctx.api.put('/api/form-definitions/' + id).set(hdr(empToken)).send(formFor('hr', 'k'));
    expect(editForbidden.status).toBe(403);
    const delForbidden = await ctx.api.delete('/api/form-definitions/' + id).set(hdr(empToken));
    expect(delForbidden.status).toBe(403);
    // the owning section can still edit/delete it
    const editOk = await ctx.api.put('/api/form-definitions/' + id).set(hdr(hrToken)).send(formFor('hr', 'k'));
    expect(editOk.status).toBe(200);
  });

  it('moving a form to a section you cannot manage is rejected, even though you own its current section', async () => {
    const created = await ctx.api.post('/api/form-definitions').set(hdr(hrToken)).send(formFor('hr', 'l'));
    const id = created.body.id;
    const res = await ctx.api.put('/api/form-definitions/' + id).set(hdr(hrToken)).send(formFor('accounting', 'l'));
    expect(res.status).toBe(403);
  });

  it('the seeded HR Payroll form was backfilled to scope "hr" by the migration', async () => {
    const forms = await ctx.api.get('/api/form-definitions').set(hdr(adminToken));
    const payroll = forms.body.find((f: { slug: string }) => f.slug === 'hr_payroll');
    expect(payroll.scope).toBe('hr');
  });
});

// ─── Form definition <-> print template link ───────────────────────────────────

describe('form definition template link', () => {
  let formId: number;
  let templateId: number;

  beforeAll(async () => {
    const form = await ctx.api.post('/api/form-definitions').set(hdr(adminToken)).send({
      name: 'Overtime Slip', slug: 'overtime_slip', number_prefix: 'OS', icon: 'file',
      fields: [{ key: 'hours', label: 'Hours', type: 'number', required: true, options: [], default: '' }],
    });
    formId = form.body.id;
    const tpl = await ctx.api.post('/api/templates').set(hdr(adminToken))
      .send({ name: 'Overtime Slip Template', type: 'generic', body: '<p>{{hours}}</p>' });
    templateId = tpl.body.id;
  });

  it('starts unlinked', async () => {
    const res = await ctx.api.get('/api/form-definitions/' + formId).set(hdr(empToken));
    expect(res.body.template_id).toBeNull();
  });

  it('employee cannot link a template (403)', async () => {
    const res = await ctx.api.put(`/api/form-definitions/${formId}/template`)
      .set(hdr(empToken)).send({ template_id: templateId });
    expect(res.status).toBe(403);
  });

  it('admin can link a template, reflected on GET', async () => {
    const res = await ctx.api.put(`/api/form-definitions/${formId}/template`)
      .set(hdr(adminToken)).send({ template_id: templateId });
    expect(res.status).toBe(200);
    const detail = await ctx.api.get('/api/form-definitions/' + formId).set(hdr(empToken));
    expect(detail.body.template_id).toBe(templateId);
  });

  it('404s linking a non-existent template', async () => {
    const res = await ctx.api.put(`/api/form-definitions/${formId}/template`)
      .set(hdr(adminToken)).send({ template_id: 999999 });
    expect(res.status).toBe(404);
  });

  it('404s for a non-existent form', async () => {
    const res = await ctx.api.put('/api/form-definitions/999999/template')
      .set(hdr(adminToken)).send({ template_id: templateId });
    expect(res.status).toBe(404);
  });

  it('admin can unlink with template_id: null', async () => {
    const res = await ctx.api.put(`/api/form-definitions/${formId}/template`)
      .set(hdr(adminToken)).send({ template_id: null });
    expect(res.status).toBe(200);
    const detail = await ctx.api.get('/api/form-definitions/' + formId).set(hdr(empToken));
    expect(detail.body.template_id).toBeNull();
  });

  it('deleting the linked template un-links it automatically (ON DELETE SET NULL)', async () => {
    await ctx.api.put(`/api/form-definitions/${formId}/template`)
      .set(hdr(adminToken)).send({ template_id: templateId });
    await ctx.api.delete('/api/templates/' + templateId).set(hdr(adminToken));
    const detail = await ctx.api.get('/api/form-definitions/' + formId).set(hdr(empToken));
    expect(detail.body.template_id).toBeNull();
  });
});

// ─── /form-definitions/:id/template-body — design a form's own print template without
// needing the separate, broader templates.edit permission ───────────────────────────

describe('form definition template-body (design print template, scope-authorized not templates.edit)', () => {
  let hrToken: string;
  let hrFormId: number;

  beforeAll(async () => {
    hrToken = (await createEmployee(ctx.api, adminToken, { role: 'hr' })).token;
    const form = await ctx.api.post('/api/form-definitions').set(hdr(hrToken)).send({
      name: 'Leave Slip', slug: 'leave_slip_tplbody', number_prefix: 'LS', icon: 'file', scope: 'hr',
      fields: [{ key: 'reason', label: 'Reason', type: 'text', required: true, options: [], default: '' }],
    });
    hrFormId = form.body.id;
  });

  it('hr (no templates.edit) can create the template body for its own hr-scoped form', async () => {
    const res = await ctx.api.put(`/api/form-definitions/${hrFormId}/template-body`)
      .set(hdr(hrToken)).send({ name: 'Leave Slip Template', type: 'generic', body: '<p>{{reason}}</p>' });
    expect(res.status).toBe(201);
    const detail = await ctx.api.get('/api/form-definitions/' + hrFormId).set(hdr(hrToken));
    expect(detail.body.template_id).toBe(res.body.id);
    const tpl = await ctx.api.get('/api/templates/' + res.body.id).set(hdr(hrToken));
    expect(tpl.body.body).toBe('<p>{{reason}}</p>');
  });

  it('calling it again updates the same template (upsert), not a second one', async () => {
    const first = await ctx.api.get('/api/form-definitions/' + hrFormId).set(hdr(hrToken));
    const res = await ctx.api.put(`/api/form-definitions/${hrFormId}/template-body`)
      .set(hdr(hrToken)).send({ name: 'Leave Slip Template v2', type: 'generic', body: '<p>updated {{reason}}</p>' });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(first.body.template_id);
    const tpl = await ctx.api.get('/api/templates/' + res.body.id).set(hdr(hrToken));
    expect(tpl.body.body).toBe('<p>updated {{reason}}</p>');
    expect(tpl.body.name).toBe('Leave Slip Template v2');
  });

  it('a different section (accounting) cannot design this hr form\'s template (403)', async () => {
    const accToken = (await createEmployee(ctx.api, adminToken, { role: 'accounting' })).token;
    const res = await ctx.api.put(`/api/form-definitions/${hrFormId}/template-body`)
      .set(hdr(accToken)).send({ name: 'Hijack', type: 'generic', body: '<p>x</p>' });
    expect(res.status).toBe(403);
  });
});

// ─── Form Records ────────────────────────────────────────────────────────────

describe('form records', () => {
  let formId: number;
  let recordId: number;

  beforeAll(async () => {
    // Create a fresh form for record tests, scoped to 'inventory' so empToken (warehouse role,
    // forms.manage.inventory) legitimately manages its records below — record CRUD requires the
    // same forms.manage.<scope> permission as managing the definition itself (no separate
    // view-only tier), so the test identity needs a matching scope, not just "any logged-in user".
    const res = await ctx.api.post('/api/form-definitions').set(hdr(adminToken)).send({
      name: 'Expense Report', slug: 'expense_report', number_prefix: 'ER', icon: 'file', scope: 'inventory',
      fields: [
        { key: 'amount', label: 'Amount', type: 'number', required: true, options: [], default: '' },
        { key: 'description', label: 'Description', type: 'text', required: false, options: [], default: '' },
      ],
    });
    formId = res.body.id;
  });

  it('a user without forms.manage.<scope> for the record cannot create, read, update, or delete it', async () => {
    // marketing holds none of the four forms.manage.* permissions (see the global-variables
    // describe block below) and expense_report isn't a self-fileable request form.
    const marketing = (await createEmployee(ctx.api, adminToken, { role: 'marketing' })).token;
    expect((await ctx.api.post('/api/form-records').set(hdr(marketing))
      .send({ form_def_id: formId, data: { amount: 1 } })).status).toBe(403);
    // Use the real employee record (created below by empToken) to check read/write 403s once it
    // exists; here just confirm listing this inventory-scoped form's records 403s too.
    expect((await ctx.api.get('/api/form-definitions/' + formId + '/records').set(hdr(marketing))).status).toBe(403);
  });

  it('a forms.manage.inventory holder can create a record', async () => {
    const res = await ctx.api.post('/api/form-records').set(hdr(empToken)).send({
      form_def_id: formId,
      data: { amount: 500, description: 'Office supplies' },
      status: 'submitted',
    });
    expect(res.status).toBe(201);
    expect(res.body.number).toMatch(/^ER-\d{5}$/);
    recordId = res.body.id;
  });

  it('auto-numbers increment per form', async () => {
    const r2 = await ctx.api.post('/api/form-records').set(hdr(empToken)).send({
      form_def_id: formId,
      data: { amount: 100 },
    });
    const r3 = await ctx.api.post('/api/form-records').set(hdr(empToken)).send({
      form_def_id: formId,
      data: { amount: 200 },
    });
    const num2 = Number(r2.body.number.split('-')[1]);
    const num3 = Number(r3.body.number.split('-')[1]);
    expect(num3).toBe(num2 + 1);
  });

  it('GET /form-definitions/:id/records lists records for the form', async () => {
    const res = await ctx.api.get('/api/form-definitions/' + formId + '/records').set(hdr(empToken));
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    expect(res.body[0].data).toEqual(expect.objectContaining({ amount: expect.anything() }));
  });

  it('?q= matches the record\'s own number OR its employee_name field (e.g. payroll, searched by who it\'s for far more often than by number)', async () => {
    const named = await ctx.api.post('/api/form-records').set(hdr(empToken)).send({
      form_def_id: formId,
      data: { amount: 50, employee_name: 'Jordan Cruz Q-Search Test' },
    });
    // Matches by number, unaffected by the new employee_name OR-clause.
    const byNumber = await ctx.api.get('/api/form-definitions/' + formId + '/records')
      .query({ q: named.body.number }).set(hdr(empToken));
    expect(byNumber.body.some((r: { id: number }) => r.id === named.body.id)).toBe(true);
    // Matches by employee_name, the new part.
    const byName = await ctx.api.get('/api/form-definitions/' + formId + '/records')
      .query({ q: 'Jordan Cruz' }).set(hdr(empToken));
    expect(byName.body.some((r: { id: number }) => r.id === named.body.id)).toBe(true);
    // A record with no employee_name field at all still lists fine under a name-only search
    // that doesn't match it (no crash from the missing key).
    const noMatch = await ctx.api.get('/api/form-definitions/' + formId + '/records')
      .query({ q: 'Nobody Named This' }).set(hdr(empToken));
    expect(noMatch.body.some((r: { id: number }) => r.id === named.body.id)).toBe(false);
  });

  it('GET /form-records/:id returns parsed data', async () => {
    const res = await ctx.api.get('/api/form-records/' + recordId).set(hdr(empToken));
    expect(res.status).toBe(200);
    expect(res.body.data.amount).toBe(500);
    expect(res.body.data.description).toBe('Office supplies');
    expect(res.body.form_name).toBe('Expense Report');
  });

  it('a scope-mismatched user 403s reading, updating, or deleting this specific record', async () => {
    const marketing = (await createEmployee(ctx.api, adminToken, { role: 'marketing' })).token;
    expect((await ctx.api.get('/api/form-records/' + recordId).set(hdr(marketing))).status).toBe(403);
    expect((await ctx.api.put('/api/form-records/' + recordId).set(hdr(marketing))
      .send({ data: { amount: 999 } })).status).toBe(403);
    expect((await ctx.api.delete('/api/form-records/' + recordId).set(hdr(marketing))).status).toBe(403);
  });

  it('can update a record (data + status)', async () => {
    const res = await ctx.api.put('/api/form-records/' + recordId).set(hdr(empToken))
      .send({ data: { amount: 750, description: 'Updated' }, status: 'approved' });
    expect(res.status).toBe(200);
    const detail = await ctx.api.get('/api/form-records/' + recordId).set(hdr(empToken));
    expect(detail.body.data.amount).toBe(750);
    expect(detail.body.status).toBe('approved');
  });

  it('rejects a record for a non-existent form', async () => {
    const res = await ctx.api.post('/api/form-records').set(hdr(empToken))
      .send({ form_def_id: 99999, data: {} });
    expect(res.status).toBe(404);
  });

  it('can delete a record', async () => {
    const res = await ctx.api.delete('/api/form-records/' + recordId).set(hdr(empToken));
    expect(res.status).toBe(200);
    expect((await ctx.api.get('/api/form-records/' + recordId).set(hdr(empToken))).status).toBe(404);
  });

  it('deleting a form cascades its records', async () => {
    const r = await ctx.api.post('/api/form-records').set(hdr(empToken))
      .send({ form_def_id: formId, data: { amount: 1 } });
    expect(r.status).toBe(201);
    await ctx.api.delete('/api/form-definitions/' + formId).set(hdr(adminToken));
    expect((await ctx.api.get('/api/form-records/' + r.body.id).set(hdr(empToken))).status).toBe(404);
  });

  it('self-filing a REQUEST_SLUGS form (e.g. leave_request) works for anyone, forced to status=pending, regardless of scope permissions', async () => {
    // sampleForm ('Leave Request', slug leave_request) was created earlier with no scope — a
    // marketing-role user holds none of the four forms.manage.* and couldn't manage it, but
    // self-filing bypasses the scope gate entirely for the ~12 whitelisted HR request slugs.
    const person = await createEmployee(ctx.api, adminToken, { role: 'marketing' });
    const marketing = person.token;
    await ctx.api.post('/api/hr/employees').set(hdr(adminToken)).send({ employee_no: `FORM-SELF-${person.id}`, name: person.username, user_id: person.id });
    const leaveFormId = (await ctx.api.get('/api/form-definitions').set(hdr(adminToken)))
      .body.find((f: { slug: string }) => f.slug === 'leave_request').id;
    const res = await ctx.api.post('/api/form-records').set(hdr(marketing)).send({
      form_def_id: leaveFormId,
      data: { reason: 'Trip', days: 2, date_from: '2026-06-01', date_to: '2026-06-02' },
      status: 'approved', // a self-filer trying to skip the workflow — must be ignored
    });
    expect(res.status).toBe(201);
    // Reading it back needs a manager token (marketing still can't browse the General scope);
    // confirm the forced status via the admin view instead of trusting the create response.
    const detail = await ctx.api.get('/api/form-records/' + res.body.id).set(hdr(adminToken));
    expect(detail.body.status).toBe('pending');
  });
});

// ─── Global Variables ─────────────────────────────────────────────────────────

describe('global variables', () => {
  let marketingToken: string;
  beforeAll(async () => {
    // marketing has no forms.manage.* by default — the one role left with no section forms
    // access, useful for testing the "holds none of the four" 403 case.
    marketingToken = (await createEmployee(ctx.api, adminToken, { role: 'marketing' })).token;
  });

  it('any user can list global variables', async () => {
    const res = await ctx.api.get('/api/global-variables').set(hdr(empToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('a role with no forms.manage.* at all cannot upsert a global variable (403)', async () => {
    const res = await ctx.api.put('/api/global-variables/company_tin')
      .set(hdr(marketingToken)).send({ label: 'TIN', value: '123' });
    expect(res.status).toBe(403);
  });

  it('a role with forms.manage for just one section can still upsert (globals are shared)', async () => {
    // empToken = warehouse -> forms.manage.inventory only, but globals aren't scoped
    const res = await ctx.api.put('/api/global-variables/warehouse_note')
      .set(hdr(empToken)).send({ label: 'Warehouse Note', value: 'x' });
    expect(res.status).toBe(200);
  });

  it('admin can create a global variable', async () => {
    const res = await ctx.api.put('/api/global-variables/company_tin')
      .set(hdr(adminToken)).send({ label: 'Company TIN', value: '123-456-789' });
    expect(res.status).toBe(200);
  });

  it('global variable appears in list', async () => {
    const res = await ctx.api.get('/api/global-variables').set(hdr(empToken));
    const v = res.body.find((x: { key: string }) => x.key === 'company_tin');
    expect(v).toBeDefined();
    expect(v.value).toBe('123-456-789');
  });

  it('admin can update a global variable value', async () => {
    await ctx.api.put('/api/global-variables/company_tin')
      .set(hdr(adminToken)).send({ label: 'Company TIN', value: '000-111-222' });
    const res = await ctx.api.get('/api/global-variables').set(hdr(empToken));
    const v = res.body.find((x: { key: string }) => x.key === 'company_tin');
    expect(v.value).toBe('000-111-222');
  });

  it('rejects a key with invalid characters', async () => {
    const res = await ctx.api.put('/api/global-variables/My%20Key')
      .set(hdr(adminToken)).send({ label: 'Bad', value: '' });
    expect(res.status).toBe(400);
  });

  it('admin can delete a global variable', async () => {
    await ctx.api.delete('/api/global-variables/company_tin').set(hdr(adminToken));
    const res = await ctx.api.get('/api/global-variables').set(hdr(empToken));
    expect(res.body.find((x: { key: string }) => x.key === 'company_tin')).toBeUndefined();
  });
});

// ─── HR Payroll CSV import ────────────────────────────────────────────────────

describe('hr payroll csv import', () => {
  let payrollFormId: number;

  // 46-column rows (matching the real "Summary" sheet's column count), with the header row
  // labeled to match — src/hr-payroll-import.ts locates each field by the header row's own
  // text (column position drifts between exports, see that file's resolveColumns), so the
  // header row here must carry real labels, not just be wide enough. See
  // tests/hr-payroll-import.test.ts for the header-text-driven parsing this exercises.
  const COLS = 46;
  const COL = { no: 0, name: 1, totalDaysWork: 19, dailyRate: 24, hourlyRate: 25, otPay: 28, lateUndertimePay: 30, basicPay: 36, totalDeductions: 42, totalSalary: 43 };
  function csvRow(set: Record<number, string | number>): string {
    const cells = new Array(COLS).fill('');
    for (const [i, v] of Object.entries(set)) cells[Number(i)] = String(v);
    return cells.map((v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(',');
  }

  const SUMMARY_CSV = [
    'June 16-30  2026,,,SUMMARY JUNE 01 -15 2026',
    csvRow({
      [COL.no]: 'No.', [COL.name]: 'Employee Name', [COL.totalDaysWork]: 'Total Days Work',
      [COL.dailyRate]: 'Daily Rate', [COL.hourlyRate]: 'Hourly Rate', [COL.otPay]: 'Reg OT 25%',
      [COL.lateUndertimePay]: 'Late/ Undertime', [COL.basicPay]: 'BASIC PAY',
      [COL.totalDeductions]: 'TOTAL DEDUCTIONS', [COL.totalSalary]: 'Total Salary',
    }),
    csvRow({ [COL.no]: 'WAREHOUSE' }),
    csvRow({
      [COL.no]: 1, [COL.name]: 'Dela Cruz, Juan', [COL.totalDaysWork]: 13,
      [COL.dailyRate]: 600, [COL.hourlyRate]: 75, [COL.otPay]: 0, [COL.lateUndertimePay]: 3.3,
      [COL.basicPay]: 7800, [COL.totalDeductions]: 3.3, [COL.totalSalary]: 7796.7,
    }),
  ].join('\n');

  beforeAll(async () => {
    // The "HR Payroll" form is auto-seeded (src/db.ts seedHrPayrollForm()) rather than
    // hand-created, so it already exists — just look it up by slug.
    const forms = await ctx.api.get('/api/form-definitions').set(hdr(adminToken));
    payrollFormId = forms.body.find((f: { slug: string }) => f.slug === 'hr_payroll').id;
  });

  it('rejects import for a non-payroll form', async () => {
    const other = await ctx.api.post('/api/form-definitions').set(hdr(adminToken)).send(sampleForm2());
    const res = await ctx.api.post(`/api/form-definitions/${other.body.id}/import`)
      .set(hdr(adminToken)).attach('file', Buffer.from(SUMMARY_CSV), 'summary.csv');
    expect(res.status).toBe(400);
  });

  it('requires a file', async () => {
    const res = await ctx.api.post(`/api/form-definitions/${payrollFormId}/import`).set(hdr(adminToken));
    expect(res.status).toBe(400);
  });

  it('imports records from a summary CSV, stamping the given pay date', async () => {
    const res = await ctx.api.post(`/api/form-definitions/${payrollFormId}/import`)
      .set(hdr(adminToken)).field('pay_date', '2026-07-05').field('period', 'June 16-30 2026')
      .attach('file', Buffer.from(SUMMARY_CSV), 'summary.csv');
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(1);

    // empToken (warehouse, forms.manage.inventory) can't browse hr_payroll's records — that
    // needs forms.manage.hr, same as managing the form itself.
    const records = await ctx.api
      .get(`/api/form-definitions/${payrollFormId}/records`)
      .set(hdr(adminToken));
    expect(records.body).toHaveLength(1);
    expect(records.body[0].data.employee_name).toBe('Dela Cruz, Juan');
    expect(records.body[0].data.dept_position).toBe('WAREHOUSE');
    expect(records.body[0].data.daily_rate).toBe(600);
    expect(records.body[0].data.total_earnings).toBe(7800); // basic_salary (BASIC PAY column) — no OT/holiday this row, late is not added back (see hr-payroll-import.ts)
    expect(records.body[0].data.net_pay).toBe(7796.7);
    expect(records.body[0].data.pay_date).toBe('2026-07-05');
    expect(records.body[0].status).toBe('completed');
    expect(records.body[0].number).toMatch(/^PAY-\d{5}$/);
  });

  it('404s for a non-existent form', async () => {
    const res = await ctx.api.post('/api/form-definitions/999999/import')
      .set(hdr(adminToken)).attach('file', Buffer.from(SUMMARY_CSV), 'summary.csv');
    expect(res.status).toBe(404);
  });

  it('requires hr.manage — a caller without it is rejected', async () => {
    const res = await ctx.api.post(`/api/form-definitions/${payrollFormId}/import`)
      .set(hdr(empToken)).field('period', 'June 16-30 2026')
      .attach('file', Buffer.from(SUMMARY_CSV), 'summary.csv');
    expect(res.status).toBe(403);
  });

  // Just needs to be SOME non-payroll form to prove the import route rejects it — not literally
  // 'overtime_request' (now auto-seeded by src/db.ts's seedHrRequestForms(), so that slug is
  // already taken by the time this test DB is set up).
  function sampleForm2() {
    return {
      name: 'Sample Non-Payroll Form', slug: 'sample_non_payroll_form', number_prefix: 'SPL', icon: 'file',
      fields: [{ key: 'hours', label: 'Hours', type: 'number', required: true, options: [], default: '' }],
    };
  }
});
it('supports editable time fields used by HR offset requests', async () => {
  const form = { name: 'Time field test', slug: 'time_field_test', number_prefix: 'TFT', scope: 'hr', fields: [{ key: 'new_time_out', label: 'New time out', type: 'time', required: true }] };
  const created = await ctx.api.post('/api/form-definitions').set(hdr(adminToken)).send(form);
  expect(created.status).toBe(201);
  const saved = await ctx.api.get(`/api/form-definitions/${created.body.id}`).set(hdr(adminToken));
  expect(saved.body.fields[0].type).toBe('time');
  const updated = await ctx.api.put(`/api/form-definitions/${created.body.id}`).set(hdr(adminToken)).send({ ...form, name: 'Updated time field test' });
  expect(updated.status).toBe(200);
});
