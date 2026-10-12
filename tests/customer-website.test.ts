import { beforeAll, afterAll, it, expect } from 'vitest';
import { setupApp, cleanup, type TestContext } from './helpers';
let ctx: TestContext;
const host = 'otom.afkcube.com';
beforeAll(async () => {
  process.env.TENANT_PATH_HOST = host;
  process.env.SIGNUPS_OPEN = 'true';
  process.env.PLATFORM_CONSOLE = 'true';
  process.env.PLATFORM_HOST = host;
  ctx = await setupApp();
  const { createTenant } = await import('../src/platform/provisioning');
  createTenant({ slug: 'verdesakay', name: 'Verdesakay', admin_username: 'owner', admin_password: 'secret123', plan: 'unlimited' });
  process.env.DEFAULT_TENANT_REDIRECT = 'verdesakay';
});
afterAll(() => {
  for (const key of ['TENANT_PATH_HOST', 'SIGNUPS_OPEN', 'PLATFORM_CONSOLE', 'PLATFORM_HOST', 'DEFAULT_TENANT_REDIRECT']) delete process.env[key];
  cleanup(ctx);
});
it('serves the public site on desktop and mobile while preserving tenant routing and the owner console', async () => {
  for (const url of ['/', '/index.html', '/login', '/signup']) {
    const r = await ctx.api.get(url).set('Host', host).set('User-Agent', 'Android');
    expect(r.status).toBe(200);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.text).toContain('Your business, connected');
    expect(r.text).not.toContain('window.VDS_BASE_PATH');
    expect(r.headers.location).toBeUndefined();
  }
  expect((await ctx.api.get('/site/style.css').set('Host', host)).status).toBe(200);
  const config = (await ctx.api.get('/site/config').set('Host', host)).body;
  expect(config.signups_open).toBe(true);
  expect(config.max_seats).toBe(500);
  expect(config.modules).toContain('hr');
  expect((await ctx.api.get('/_platform/').set('Host', host)).status).toBe(200);
  expect((await ctx.api.get('/verdesakay').set('Host', host)).text).toContain('window.VDS_BASE_PATH="/verdesakay"');
  expect((await ctx.api.get('/api/inventory').set('Host', host)).status).toBe(410);
});
it('registers a pay-first workspace at the apex without reopening the original company database', async () => {
  const r = await ctx.api.post('/api/signup').set('Host', host).send({ slug: 'new-company', company_name: 'New Company', admin_username: 'new-admin', admin_password: 'secret123', admin_email: 'new@example.test', seats: 3, modules: ['manufacturing', 'hr'] });
  expect(r.status).toBe(201);
  expect(r.body.url).toBe('https://otom.afkcube.com/new-company');
  const { getTenant } = await import('../src/platform/platform');
  // Website sign-ups pay before they get in: no trial, locked to Billing (tests/billing-signup.test.ts).
  expect(getTenant('new-company')?.status).toBe('active');
  expect(getTenant('new-company')?.awaiting_payment).toBe(1);
  expect(getTenant('new-company')?.trial_ends_at).toBeNull();
  const login = await ctx.api.post('/new-company/api/auth/login').set('Host', host).send({ username: 'new-admin', password: 'secret123' });
  expect(login.status).toBe(200);
  const own = await ctx.api.get('/new-company/api/tenant').set('Host', host).set('Authorization', `Bearer ${login.body.token}`);
  expect(own.body.limits.users).toBe(3);
  expect(own.body.modules).toEqual(['inventory', 'manufacturing', 'hr']);
  expect(own.body.limits.employees).toBeNull();
});
it('rejects unknown modules and out-of-range seat requests before creating a tenant', async () => {
  const input = { slug: 'invalid-trial', company_name: 'Invalid Trial', admin_username: 'owner', admin_password: 'secret123', admin_email: 'owner@example.test' };
  for (const extra of [{ seats: 1000 }, { seats: 0 }, { modules: ['unknown-module'] }]) {
    expect((await ctx.api.post('/api/signup').set('Host', host).send({ ...input, ...extra })).status).toBe(400);
  }
  const { getTenant } = await import('../src/platform/platform');
  expect(getTenant('invalid-trial')).toBeNull();
});
