/** Integration tests: form upload, download round-trip, department visibility, delete. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';

let ctx: TestContext;
let adminToken: string;

beforeAll(async () => {
  ctx = await setupApp();
  adminToken = await login(ctx.api);
});
afterAll(() => cleanup(ctx));

describe('forms', () => {
  it('uploads a file and downloads identical content', async () => {
    const content = 'Hello Verdesakay form content';
    const up = await ctx.api
      .post('/api/forms')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('title', 'Leave Request')
      .field('category', 'HR Forms')
      .attach('file', Buffer.from(content), 'leave.txt');
    expect(up.status).toBe(201);

    const dl = await ctx.api
      .get(`/api/forms/${up.body.id}/download`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(dl.status).toBe(200);
    expect(dl.text).toBe(content);
  });

  it('rejects an upload with no file', async () => {
    const res = await ctx.api
      .post('/api/forms')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('title', 'No File');
    expect(res.status).toBe(400);
  });

  it('enforces department visibility for employees', async () => {
    // Departments seeded: Administration(1), Operations(2), Finance(3)...
    const finance = await createEmployee(ctx.api, adminToken, { username: 'finguy', department_id: 3 });
    const ops = await createEmployee(ctx.api, adminToken, { username: 'opsguy', department_id: 2 });

    // Admin uploads a Finance-only form.
    const up = await ctx.api
      .post('/api/forms')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('title', 'Finance Only')
      .field('department_id', '3')
      .attach('file', Buffer.from('secret budget'), 'budget.txt');
    const formId = up.body.id;

    // Finance employee can see + download it.
    const finList = await ctx.api.get('/api/forms').set('Authorization', `Bearer ${finance.token}`);
    expect(finList.body.some((f: { id: number }) => f.id === formId)).toBe(true);

    // Operations employee cannot see it...
    const opsList = await ctx.api.get('/api/forms').set('Authorization', `Bearer ${ops.token}`);
    expect(opsList.body.some((f: { id: number }) => f.id === formId)).toBe(false);

    // ...and is blocked from downloading directly.
    const opsDl = await ctx.api.get(`/api/forms/${formId}/download`).set('Authorization', `Bearer ${ops.token}`);
    expect(opsDl.status).toBe(403);
  });

  it('shows all-staff forms to everyone', async () => {
    const emp = await createEmployee(ctx.api, adminToken, { username: 'anyemp' });
    await ctx.api
      .post('/api/forms')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('title', 'Shared Memo')
      .attach('file', Buffer.from('all staff'), 'memo.txt');
    const list = await ctx.api.get('/api/forms').set('Authorization', `Bearer ${emp.token}`);
    expect(list.body.some((f: { title: string }) => f.title === 'Shared Memo')).toBe(true);
  });

  it('only lets the uploader or an admin delete', async () => {
    const emp = await createEmployee(ctx.api, adminToken, { username: 'delemp', role: 'warehouse' });
    const up = await ctx.api
      .post('/api/forms')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('title', 'Admin Doc')
      .attach('file', Buffer.from('x'), 'a.txt');

    const empDel = await ctx.api.delete(`/api/forms/${up.body.id}`).set('Authorization', `Bearer ${emp.token}`);
    expect(empDel.status).toBe(403);

    const adminDel = await ctx.api.delete(`/api/forms/${up.body.id}`).set('Authorization', `Bearer ${adminToken}`);
    expect(adminDel.status).toBe(200);
  });
});

describe('forms: RBAC honors per-user overrides', () => {
  it('revoking forms.upload via override blocks uploads, without touching forms.view', async () => {
    const dave = await createEmployee(ctx.api, adminToken, { username: 'dave_rbac' });
    await ctx.api.put(`/api/users/${dave.id}/permissions`).set('Authorization', `Bearer ${adminToken}`)
      .send({ overrides: { 'forms.upload': false } });
    dave.token = await login(ctx.api, dave.username, dave.password);
    const up = await ctx.api.post('/api/forms').set('Authorization', `Bearer ${dave.token}`)
      .field('title', 'Blocked').attach('file', Buffer.from('x'), 'x.txt');
    expect(up.status).toBe(403);
    expect((await ctx.api.get('/api/forms').set('Authorization', `Bearer ${dave.token}`)).status).toBe(200);
  });

  it('revoking forms.view via override blocks listing and downloading', async () => {
    const erin = await createEmployee(ctx.api, adminToken, { username: 'erin_rbac' });
    const up = await ctx.api.post('/api/forms').set('Authorization', `Bearer ${adminToken}`)
      .field('title', 'Visible').attach('file', Buffer.from('x'), 'x.txt');
    await ctx.api.put(`/api/users/${erin.id}/permissions`).set('Authorization', `Bearer ${adminToken}`)
      .send({ overrides: { 'forms.view': false } });
    erin.token = await login(ctx.api, erin.username, erin.password);
    expect((await ctx.api.get('/api/forms').set('Authorization', `Bearer ${erin.token}`)).status).toBe(403);
    expect((await ctx.api.get(`/api/forms/${up.body.id}/download`).set('Authorization', `Bearer ${erin.token}`)).status).toBe(403);
  });
});

it('does not serve uploaded scripts as an executable same-origin script source', async () => {
  const upload = await ctx.api.post('/api/forms').set('Authorization', `Bearer ${adminToken}`)
    .field('title', 'Unsafe file').attach('file', Buffer.from('alert(1)'), { filename: 'script.js', contentType: 'application/javascript' });
  expect(upload.status).toBe(201);
  const file = await ctx.api.get(`/api/forms/${upload.body.id}/download`).set('Authorization', `Bearer ${adminToken}`);
  expect(file.type).toBe('application/octet-stream');
  expect(file.headers['content-disposition']).toMatch(/^attachment;/);
});
