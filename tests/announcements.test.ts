/** Announcements: anyone reads the active ones; the `announce` permission gates
 *  posting / editing / deleting, and expired ones drop off the public list. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';

let ctx: TestContext;
let adminToken: string;
const A = () => ({ Authorization: `Bearer ${adminToken}` });

beforeAll(async () => {
  ctx = await setupApp();
  adminToken = await login(ctx.api);
});
afterAll(() => cleanup(ctx));

describe('announcements', () => {
  it('lets an announce holder post and everyone read; pinned float to the top', async () => {
    const reader = await createEmployee(ctx.api, adminToken, { role: 'warehouse' });

    await ctx.api.post('/api/announcements').set(A()).send({ title: 'Plain', body: 'first' });
    await ctx.api.post('/api/announcements').set(A()).send({ title: 'Pinned', body: 'important', pinned: true });

    const res = await ctx.api.get('/api/announcements').set({ Authorization: `Bearer ${reader.token}` });
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(2);
    expect(res.body[0].title).toBe('Pinned');
    expect(res.body[0].created_by_name).toBeTruthy();
  });

  it('blocks posting without the announce permission', async () => {
    const wh = await createEmployee(ctx.api, adminToken, { role: 'warehouse' });
    const res = await ctx.api.post('/api/announcements')
      .set({ Authorization: `Bearer ${wh.token}` }).send({ title: 'nope', body: 'x' });
    expect(res.status).toBe(403);
  });

  it('hides expired announcements from the public list but not from /all', async () => {
    const past = await ctx.api.post('/api/announcements').set(A())
      .send({ title: 'Old news', body: 'x', expires_at: '2000-01-01 00:00' });
    expect(past.status).toBe(201);

    const pub = await ctx.api.get('/api/announcements').set(A());
    expect(pub.body.some((r: { id: number }) => r.id === past.body.id)).toBe(false);

    const all = await ctx.api.get('/api/announcements/all').set(A());
    expect(all.body.some((r: { id: number }) => r.id === past.body.id)).toBe(true);
  });

  it('edits and deletes', async () => {
    const c = await ctx.api.post('/api/announcements').set(A()).send({ title: 'Draft', body: 'v1' });
    const id = c.body.id;
    expect((await ctx.api.put('/api/announcements/' + id).set(A()).send({ title: 'Final', body: 'v2', pinned: true })).status).toBe(200);
    const one = (await ctx.api.get('/api/announcements/all').set(A())).body.find((r: { id: number }) => r.id === id);
    expect(one.title).toBe('Final');
    expect(one.pinned).toBe(1);
    expect((await ctx.api.del('/api/announcements/' + id).set(A())).status).toBe(200);
    expect((await ctx.api.put('/api/announcements/' + id).set(A()).send({ title: 'x', body: 'y' })).status).toBe(404);
  });
});
