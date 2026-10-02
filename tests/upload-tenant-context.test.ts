/**
 * A request's workspace (tenantStore) must survive an in-memory multer upload. Memory storage
 * finishes inside the request stream's own events, which run outside the request's async context,
 * so without shared/request-context.ts's keepRequestContext() the handler fell back to the default
 * workspace — a multipart anonymous report from another workspace was filed in the default one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, type TestContext } from './helpers';
import { jpegWithMetadata } from './image-fixtures';

let ctx: TestContext;
let dbmod: typeof import('../src/shared/db');
const asTenant = (slug: string) => ({ 'X-Tenant': slug });

beforeAll(async () => {
  ctx = await setupApp();
  dbmod = await import('../src/shared/db');
  const provisioning = await import('../src/platform/provisioning');
  provisioning.createTenant({ slug: 'branch-co', name: 'Branch Co', admin_username: 'owner', admin_password: 'branchpass1', plan: 'unlimited' });
});
afterAll(() => cleanup(ctx));

describe('in-memory uploads keep the request\'s workspace', () => {
  it('a multipart anonymous report lands in its own workspace, not the default one', async () => {
    const token = (await ctx.api.post('/api/auth/login').set(asTenant('branch-co')).send({ username: 'owner', password: 'branchpass1' })).body.token;
    const ticket = (await ctx.api.post('/api/anonymous-reports/ticket').set({ ...asTenant('branch-co'), Authorization: `Bearer ${token}` })).body.ticket;
    const r = await ctx.api.post('/api/anonymous-reports').set(asTenant('branch-co'))
      .field('ticket', ticket).field('category', 'Safety risk').field('description', 'Blocked fire exit on level 2.')
      .attach('photos', jpegWithMetadata(), { filename: 'exit.jpg', contentType: 'image/jpeg' });
    expect(r.status).toBe(201);
    const count = (slug: string) => dbmod.withTenant(slug, () =>
      dbmod.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM anonymous_reports')!.n);
    expect(count('branch-co')).toBe(1);
    expect(count('default')).toBe(0);
  });
});
