/**
 * A request's workspace (tenantStore) must survive an in-memory multer upload. Memory storage
 * finishes inside the request stream's own events, which run outside the request's async context,
 * so without shared/request-context.ts's keepRequestContext() the handler fell back to the default
 * workspace — a multipart anonymous report from another workspace was filed in the default one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, type TestContext } from './helpers';
import fs from 'node:fs';
import path from 'node:path';
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

describe('durable uploads keep their workspace', () => {
  it('recovers a branch form without exposing its bytes to the default tenant', async () => {
    const token = (await ctx.api.post('/api/auth/login').set(asTenant('branch-co'))
      .send({ username: 'owner', password: 'branchpass1' })).body.token;
    const headers = { ...asTenant('branch-co'), Authorization: `Bearer ${token}` };
    const upload = await ctx.api.post('/api/forms').set(headers)
      .attach('file', Buffer.from('branch-only content'), 'branch.txt');
    expect(upload.status).toBe(201);
    const name = dbmod.withTenant('branch-co', () => dbmod.queryOne<{ stored_name: string }>(
      'SELECT stored_name FROM forms WHERE id = ?', upload.body.id
    )!.stored_name);
    fs.unlinkSync(path.join(ctx.tmpDir, 'uploads', 'branch-co', name));
    const restored = await ctx.api.get(`/api/forms/${upload.body.id}/download`).set(headers);
    expect(restored.status).toBe(200);
    expect(restored.text).toBe('branch-only content');
    expect(dbmod.withTenant('default', () => dbmod.queryOne('SELECT 1 FROM durable_uploads WHERE name = ?', name))).toBeUndefined();
  });
});
