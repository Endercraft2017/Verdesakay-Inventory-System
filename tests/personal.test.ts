/** Personal tools: notes / tasks / bookmarks — CRUD, per-user isolation, auth. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';

let ctx: TestContext;
let admin: string; // admin token (user A)
let emp: { id: number; token: string }; // employee (user B)
const hdr = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  ctx = await setupApp();
  admin = await login(ctx.api);
  emp = await createEmployee(ctx.api, admin);
});
afterAll(() => cleanup(ctx));

describe('notes', () => {
  it('requires authentication', async () => {
    const res = await ctx.api.get('/api/notes');
    expect(res.status).toBe(401);
  });

  it('creates, lists, updates and deletes a note', async () => {
    const c = await ctx.api.post('/api/notes').set(hdr(admin)).send({ title: 'T', body: 'hello' });
    expect(c.status).toBe(201);
    const id = c.body.id;

    const list = await ctx.api.get('/api/notes').set(hdr(admin));
    expect(list.body.find((n: { id: number }) => n.id === id).body).toBe('hello');

    await ctx.api.put(`/api/notes/${id}`).set(hdr(admin)).send({ title: 'T2', body: 'world' });
    const after = await ctx.api.get('/api/notes').set(hdr(admin));
    expect(after.body.find((n: { id: number }) => n.id === id).body).toBe('world');

    const del = await ctx.api.delete(`/api/notes/${id}`).set(hdr(admin));
    expect(del.status).toBe(200);
  });

  it('rejects an empty note body', async () => {
    const res = await ctx.api.post('/api/notes').set(hdr(admin)).send({ body: '   ' });
    expect(res.status).toBe(400);
  });

  it('does not leak notes across users', async () => {
    const a = await ctx.api.post('/api/notes').set(hdr(admin)).send({ body: 'admin-only secret' });
    const empList = await ctx.api.get('/api/notes').set(hdr(emp.token));
    expect(empList.body.some((n: { id: number }) => n.id === a.body.id)).toBe(false);

    // employee cannot update or delete the admin's note
    const upd = await ctx.api.put(`/api/notes/${a.body.id}`).set(hdr(emp.token)).send({ body: 'hijacked' });
    expect(upd.status).toBe(404);
    const del = await ctx.api.delete(`/api/notes/${a.body.id}`).set(hdr(emp.token));
    expect(del.status).toBe(404);
  });
});

describe('tasks', () => {
  it('creates, toggles done, and deletes a task', async () => {
    const c = await ctx.api.post('/api/tasks').set(hdr(admin)).send({ title: 'Do thing', due_date: '2026-07-01' });
    expect(c.status).toBe(201);
    const id = c.body.id;

    await ctx.api.put(`/api/tasks/${id}`).set(hdr(admin)).send({ done: true });
    const list = await ctx.api.get('/api/tasks').set(hdr(admin));
    expect(list.body.find((t: { id: number }) => t.id === id).done).toBe(1);

    const del = await ctx.api.delete(`/api/tasks/${id}`).set(hdr(admin));
    expect(del.status).toBe(200);
  });

  it('rejects a task with no title', async () => {
    const res = await ctx.api.post('/api/tasks').set(hdr(admin)).send({ title: '' });
    expect(res.status).toBe(400);
  });

  it('keeps tasks private per user', async () => {
    const a = await ctx.api.post('/api/tasks').set(hdr(admin)).send({ title: 'admin task' });
    const empList = await ctx.api.get('/api/tasks').set(hdr(emp.token));
    expect(empList.body.some((t: { id: number }) => t.id === a.body.id)).toBe(false);
    const upd = await ctx.api.put(`/api/tasks/${a.body.id}`).set(hdr(emp.token)).send({ done: true });
    expect(upd.status).toBe(404);
  });
});

describe('bookmarks', () => {
  it('creates with params, lists (parsed), navigates target, and deletes', async () => {
    const c = await ctx.api.post('/api/bookmarks').set(hdr(admin))
      .send({ label: 'Low stock', route: 'inventory', params: { low: '1' } });
    expect(c.status).toBe(201);

    const list = await ctx.api.get('/api/bookmarks').set(hdr(admin));
    const bm = list.body.find((b: { id: number }) => b.id === c.body.id);
    expect(bm.route).toBe('inventory');
    expect(bm.params).toEqual({ low: '1' }); // returned parsed, not a JSON string

    const del = await ctx.api.delete(`/api/bookmarks/${c.body.id}`).set(hdr(admin));
    expect(del.status).toBe(200);
  });

  it('requires a route', async () => {
    const res = await ctx.api.post('/api/bookmarks').set(hdr(admin)).send({ label: 'x' });
    expect(res.status).toBe(400);
  });

  it('keeps bookmarks private per user', async () => {
    const a = await ctx.api.post('/api/bookmarks').set(hdr(admin)).send({ label: 'mine', route: 'dashboard' });
    const empList = await ctx.api.get('/api/bookmarks').set(hdr(emp.token));
    expect(empList.body.some((b: { id: number }) => b.id === a.body.id)).toBe(false);
    const del = await ctx.api.delete(`/api/bookmarks/${a.body.id}`).set(hdr(emp.token));
    expect(del.status).toBe(404);
  });
});
