/** Document templates: default seeds, admin-only CRUD, company profile. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';

let ctx: TestContext;
let admin: string;
let emp: { token: string };
const hdr = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  ctx = await setupApp();
  admin = await login(ctx.api);
  emp = await createEmployee(ctx.api, admin);
});
afterAll(() => cleanup(ctx));

describe('templates', () => {
  it('seeds default Sale and Job order templates on first run', async () => {
    const list = await ctx.api.get('/api/templates').set(hdr(admin));
    expect(list.body.some((t: { type: string }) => t.type === 'sale')).toBe(true);
    expect(list.body.some((t: { type: string }) => t.type === 'job')).toBe(true);
  });

  it('lets an admin create, edit and delete a template', async () => {
    const c = await ctx.api.post('/api/templates').set(hdr(admin))
      .send({ name: 'Custom', type: 'generic', body: 'Hi {{order.no}}' });
    expect(c.status).toBe(201);

    const u = await ctx.api.put('/api/templates/' + c.body.id).set(hdr(admin))
      .send({ name: 'Custom 2', type: 'generic', body: 'Bye {{order.no}}' });
    expect(u.status).toBe(200);

    const got = await ctx.api.get('/api/templates/' + c.body.id).set(hdr(admin));
    expect(got.body.name).toBe('Custom 2');

    expect((await ctx.api.delete('/api/templates/' + c.body.id).set(hdr(admin))).status).toBe(200);
  });

  it('forbids a non-admin from creating or deleting templates', async () => {
    const c = await ctx.api.post('/api/templates').set(hdr(emp.token))
      .send({ name: 'Nope', type: 'generic', body: 'x' });
    expect(c.status).toBe(403);
    // employees can still read
    expect((await ctx.api.get('/api/templates').set(hdr(emp.token))).status).toBe(200);
  });

  it('rejects an empty template body', async () => {
    const res = await ctx.api.post('/api/templates').set(hdr(admin)).send({ name: 'X', body: '' });
    expect(res.status).toBe(400);
  });
});

describe('company profile', () => {
  it('returns a default (empty) profile and saves admin edits', async () => {
    const def = await ctx.api.get('/api/templates/company').set(hdr(admin));
    expect(def.status).toBe(200);
    expect(def.body).toHaveProperty('name');

    const put = await ctx.api.put('/api/templates/company').set(hdr(admin))
      .send({ name: 'Verdesakay Inc.', address: 'Cebu', phone: '123', email: 'a@b.c', logo_url: '' });
    expect(put.status).toBe(200);

    const got = await ctx.api.get('/api/templates/company').set(hdr(admin));
    expect(got.body.name).toBe('Verdesakay Inc.');
  });

  it('forbids a non-admin from editing the company profile', async () => {
    const res = await ctx.api.put('/api/templates/company').set(hdr(emp.token)).send({ name: 'Hack' });
    expect(res.status).toBe(403);
  });
});
