/** Owner console: importing an existing workspace DB as a tenant (POST /_platform/api/tenants/import),
    and the dedicated console host (PLATFORM_HOST) — console only there, nothing else there. */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, type TestContext } from './helpers';

let ctx: TestContext;
let op: string;
let snapshot: string;
const opHdr = () => ({ Authorization: `Bearer ${op}` });

beforeAll(async () => {
  process.env.PLATFORM_CONSOLE = 'true';
  ctx = await setupApp();
  const oldToken = await login(ctx.api); // default tenant, seeded admin/admin123 + a live session
  expect(oldToken).toBeTruthy();
  const db = await import('../src/shared/db');
  snapshot = path.join(ctx.tmpDir, 'snapshot.db');
  db.getDb().exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
  const users = await import('../src/platform/platform-users');
  users.upsertPlatformUser('owner', 'ownerpass1-test-only', 'System Owner');
  op = (await ctx.api.post('/_platform/api/login').send({ username: 'owner', password: 'ownerpass1-test-only' })).body.token;
});
afterAll(() => {
  delete process.env.PLATFORM_CONSOLE;
  delete process.env.PLATFORM_HOST;
  cleanup(ctx);
});

describe('import workspace', () => {
  it('adopts the DB as a tenant: same logins work, old sessions do not', async () => {
    const r = await ctx.api.post('/_platform/api/tenants/import').set(opHdr())
      .field('slug', 'ourco').field('name', 'Our Co').field('plan', 'complete')
      .attach('db', snapshot);
    expect(r.status).toBe(201);
    expect(r.body.slug).toBe('ourco');
    expect(r.body.imported_users).toBeGreaterThan(0);

    const li = await ctx.api.post('/api/auth/login').set('X-Tenant', 'ourco')
      .send({ username: 'admin', password: 'admin123-test-only' });
    expect(li.status).toBe(200);

    const db = await import('../src/shared/db');
    const sessions = db.withTenant('ourco', () => db.queryAll('SELECT token FROM sessions'));
    expect(sessions.length).toBe(1); // only the login just made, none carried over
  });

  it('rejects a taken slug, a non-SQLite file, and a missing file — leaving nothing behind', async () => {
    const taken = await ctx.api.post('/_platform/api/tenants/import').set(opHdr())
      .field('slug', 'ourco').field('name', 'Dup').attach('db', snapshot);
    expect(taken.status).toBe(409);

    const junk = path.join(ctx.tmpDir, 'junk.db');
    fs.writeFileSync(junk, 'not a database at all');
    const bad = await ctx.api.post('/_platform/api/tenants/import').set(opHdr())
      .field('slug', 'junkco').field('name', 'Junk').attach('db', junk);
    expect(bad.status).toBe(400);
    expect(fs.existsSync(path.join(process.env.DATA_DIR!, 'junkco.db'))).toBe(false);

    const none = await ctx.api.post('/_platform/api/tenants/import').set(opHdr()).field('slug', 'x1').field('name', 'X');
    expect(none.status).toBe(400);
  });

  it('requires an operator login', async () => {
    // No file attached: auth runs before the upload is read, so an attached body would be cut off.
    const r = await ctx.api.post('/_platform/api/tenants/import').field('slug', 'anon1');
    expect(r.status).toBe(401);
  });
});

describe('PLATFORM_HOST', () => {
  beforeAll(() => { process.env.PLATFORM_HOST = 'admin.app.example.com'; });
  afterAll(() => { delete process.env.PLATFORM_HOST; });

  it('serves the console on its host and redirects everything else there to it', async () => {
    const api = await ctx.api.get('/_platform/api/tenants').set('Host', 'admin.app.example.com').set(opHdr());
    expect(api.status).toBe(200);
    const root = await ctx.api.get('/').set('Host', 'admin.app.example.com');
    expect(root.status).toBe(302);
    expect(root.headers.location).toBe('/_platform/');
    const tenantApi = await ctx.api.get('/api/auth/me').set('Host', 'admin.app.example.com');
    expect(tenantApi.status).toBe(404);
    expect((await ctx.api.get('/api/health').set('Host', 'admin.app.example.com')).status).toBe(200);
  });

  it('404s the console on any other host', async () => {
    const r = await ctx.api.get('/_platform/api/tenants').set('Host', 'ourco.app.example.com').set(opHdr());
    expect(r.status).toBe(404);
    const page = await ctx.api.get('/_platform/').set('Host', 'localhost');
    expect(page.status).toBe(404);
  });
});
