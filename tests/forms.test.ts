/** Integration tests: form upload, download round-trip, department visibility, delete. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
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

    const { queryOne } = await import('../src/shared/db');
    const stored = queryOne<{ stored_name: string }>('SELECT stored_name FROM forms WHERE id = ?', up.body.id)!;
    const diskFile = path.join(ctx.tmpDir, 'uploads', stored.stored_name);
    fs.unlinkSync(diskFile); // simulate a container replacing its upload folder

    const dl = await ctx.api
      .get(`/api/forms/${up.body.id}/download`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(dl.status).toBe(200);
    expect(dl.text).toBe(content);
    expect(fs.existsSync(diskFile)).toBe(true);
  });

  it('rejects an upload with no file', async () => {
    const res = await ctx.api
      .post('/api/forms')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('title', 'No File');
    expect(res.status).toBe(400);
  });

  it('recovers an older file from the upload backup when it has no database copy', async () => {
    const content = Buffer.from('legacy form');
    const up = await ctx.api.post('/api/forms').set('Authorization', `Bearer ${adminToken}`)
      .attach('file', content, 'legacy.txt');
    const { queryOne, run } = await import('../src/shared/db');
    const { backupDir } = await import('../src/shared/backup');
    const name = queryOne<{ stored_name: string }>('SELECT stored_name FROM forms WHERE id = ?', up.body.id)!.stored_name;
    const primary = path.join(ctx.tmpDir, 'uploads', name);
    const backup = path.join(backupDir(), 'uploads', name);
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.copyFileSync(primary, backup);
    run('DELETE FROM durable_uploads WHERE name = ?', name);
    fs.unlinkSync(primary);
    const response = await ctx.api.get(`/api/forms/${up.body.id}/download`).set('Authorization', `Bearer ${adminToken}`);
    expect(response.status).toBe(200);
    expect(response.text).toBe(content.toString());
    expect(queryOne<{ size_bytes: number }>('SELECT size_bytes FROM durable_uploads WHERE name = ?', name)?.size_bytes).toBe(content.length);
  });

  it('backfills surviving pre-upgrade files into durable storage', async () => {
    const up = await ctx.api.post('/api/forms').set('Authorization', `Bearer ${adminToken}`)
      .attach('file', Buffer.from('older form'), 'older.txt');
    const { queryOne, run, forceMigrate, setSetting } = await import('../src/shared/db');
    const name = queryOne<{ stored_name: string }>('SELECT stored_name FROM forms WHERE id = ?', up.body.id)!.stored_name;
    run('DELETE FROM durable_uploads WHERE name = ?', name);
    setSetting('schema_version', 65);
    forceMigrate('default');
    expect(Buffer.from(queryOne<{ data: Uint8Array }>('SELECT data FROM durable_uploads WHERE name = ?', name)!.data).toString()).toBe('older form');
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

    const { queryOne } = await import('../src/shared/db');
    const stored = queryOne<{ stored_name: string }>('SELECT stored_name FROM forms WHERE id = ?', up.body.id)!;
    const adminDel = await ctx.api.delete(`/api/forms/${up.body.id}`).set('Authorization', `Bearer ${adminToken}`);
    expect(adminDel.status).toBe(200);
    expect(queryOne('SELECT 1 FROM durable_uploads WHERE name = ?', stored.stored_name)).toBeUndefined();
  });
});

describe('forms: RBAC honors per-user overrides', () => {
  it('revoking forms.upload via override blocks uploads, without touching forms.view', async () => {
    const dave = await createEmployee(ctx.api, adminToken, { username: 'dave_rbac' });
    await ctx.api.put(`/api/users/${dave.id}/permissions`).set('Authorization', `Bearer ${adminToken}`)
      .send({ overrides: { 'forms.upload': false } });
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
    expect((await ctx.api.get('/api/forms').set('Authorization', `Bearer ${erin.token}`)).status).toBe(403);
    expect((await ctx.api.get(`/api/forms/${up.body.id}/download`).set('Authorization', `Bearer ${erin.token}`)).status).toBe(403);
  });
});
