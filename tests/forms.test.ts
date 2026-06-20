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
    const emp = await createEmployee(ctx.api, adminToken, { username: 'delemp' });
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
