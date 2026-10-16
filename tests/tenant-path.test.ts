import http from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { setupApp, cleanup, type TestContext } from './helpers';

let ctx: TestContext;
let token: string;
const host = 'otom.afkcube.com';
beforeAll(async () => {
  process.env.TENANT_PATH_HOST = host;
  process.env.PLATFORM_CONSOLE = 'true';
  ctx = await setupApp();
  const { createTenant } = await import('../src/platform/provisioning');
  createTenant({ slug: 'verdesakay', name: 'Verdesakay', admin_username: 'existing-admin', admin_password: 'existing-password', plan: 'unlimited' });
  createTenant({ slug: 'otherco', name: 'Other', admin_username: 'other-admin', admin_password: 'other-password-test-only', plan: 'unlimited' });
});
afterAll(() => {
  delete process.env.TENANT_PATH_HOST;
  delete process.env.DEFAULT_TENANT_REDIRECT;
  delete process.env.PLATFORM_CONSOLE;
  cleanup(ctx);
});

describe('tenants on one configured domain', () => {
  it('serves the desktop/mobile shells, scoped manifest, assets and worker', async () => {
    const desktop = await ctx.api.get('/verdesakay').set('Host', host);
    expect(desktop.status).toBe(200);
    expect(desktop.text).toContain('window.VDS_BASE_PATH="/verdesakay"');
    // Tenant-prefixed and content-versioned (src/shared/asset-version.ts).
    expect(desktop.text).toMatch(/src="\/verdesakay\/js\/tenant-context\.js\?v=[0-9a-f]{12}"/);
    expect(desktop.text).toMatch(/href="\/verdesakay\/css\/styles\.css\?v=[0-9a-f]{12}"/);
    const phone = await ctx.api.get('/verdesakay').set('Host', host).set('User-Agent', 'Android');
    expect(phone.headers.location).toBe('/verdesakay/m');
    const mobile = await ctx.api.get('/verdesakay/m').set('Host', host);
    expect(mobile.text).toContain('href="/verdesakay/mobile/manifest.webmanifest"');
    const manifest = await ctx.api.get('/verdesakay/mobile/manifest.webmanifest').set('Host', host);
    expect(JSON.parse(manifest.text)).toMatchObject({ start_url: '/verdesakay/m', scope: '/verdesakay/m', id: '/verdesakay/m' });
    const worker = await ctx.api.get('/verdesakay/mobile/sw.js').set('Host', host);
    expect(worker.headers['service-worker-allowed']).toBe('/verdesakay/m');
    expect(worker.text).toContain('var TENANT_BASE = "/verdesakay"');
    expect((await ctx.api.get('/verdesakay/js/tenant-context.js').set('Host', host)).status).toBe(200);
    expect((await ctx.api.get('/verdesakay/?view=desktop').set('Host', host)).headers.location).toBe('/verdesakay/');
  });

  it('selects the tenant in production and rejects cross-tenant tokens and overrides', async () => {
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const login = await ctx.api.post('/verdesakay/api/auth/login').set('Host', host)
        .send({ username: 'existing-admin', password: 'existing-password' });
      expect(login.status).toBe(200);
      token = login.body.token;
      const tenant = await ctx.api.get('/verdesakay/api/tenant?tenant=otherco').set('Host', host)
        .set('X-Tenant', 'otherco').set('Authorization', `Bearer ${token}`);
      expect(tenant.status).toBe(200);
      expect(tenant.body.slug).toBe('verdesakay');
      const create = await ctx.api.post('/verdesakay/api/inventory').set('Host', host)
        .set('Authorization', `Bearer ${token}`).send({ name: 'Verdesakay private item' });
      expect(create.status).toBe(201);
      expect((await ctx.api.get('/otherco/api/inventory').set('Host', host).set('Authorization', `Bearer ${token}`)).status).toBe(401);
      const otherLogin = await ctx.api.post('/otherco/api/auth/login').set('Host', host)
        .send({ username: 'other-admin', password: 'other-password-test-only' });
      const list = await ctx.api.get('/otherco/api/inventory').set('Host', host).set('Authorization', `Bearer ${otherLogin.body.token}`);
      expect(list.status).toBe(200);
      expect(JSON.stringify(list.body)).not.toContain('Verdesakay private item');
    } finally { process.env.NODE_ENV = env; }
  });

  it('keeps the owner console out of tenant paths, handles missing/suspended tenants, and retains status gates', async () => {
    expect((await ctx.api.get('/verdesakay/_platform').set('Host', host)).status).toBe(404);
    expect((await ctx.api.get('/missing-company/api/health').set('Host', host)).status).toBe(404);
    const { setTenantStatus } = await import('../src/platform/platform');
    setTenantStatus('verdesakay', 'past_due');
    expect((await ctx.api.post('/verdesakay/api/inventory').set('Host', host).set('Authorization', `Bearer ${token}`).send({ name: 'blocked' })).status).toBe(402);
    setTenantStatus('verdesakay', 'suspended');
    expect((await ctx.api.get('/verdesakay').set('Host', host)).status).toBe(403);
    setTenantStatus('verdesakay', 'active');
    process.env.PLATFORM_HOST = host;
    try {
      expect((await ctx.api.get('/verdesakay').set('Host', host)).status).toBe(200);
      expect((await ctx.api.get('/_platform').set('Host', host)).status).toBe(301);
    } finally { delete process.env.PLATFORM_HOST; }
  });

  it('serves the public apex and retires old company API aliases after cutover', async () => {
    process.env.DEFAULT_TENANT_REDIRECT = 'verdesakay';
    const root = await ctx.api.get('/').set('Host', host);
    expect(root.status).toBe(200);
    expect(root.text).toContain('Less busywork.');
    expect(root.text).not.toContain('window.VDS_BASE_PATH');
    expect((await ctx.api.get('/m').set('Host', host)).headers.location).toBe('/verdesakay/m');
    expect((await ctx.api.post('/api/auth/login').set('Host', host).send({ username: 'admin', password: 'admin123-test-only' })).status).toBe(410);
    expect((await ctx.api.get('/api/health').set('Host', host)).body.ok).toBe(true);
    expect((await ctx.api.get('/js/api.js').set('Host', host)).status).toBe(200);
  });

  it('authenticates a real WebSocket against the path tenant and refuses a foreign token', async () => {
    const { attachWebSocket } = await import('../src/shared/ws');
    const server = http.createServer(ctx.app);
    attachWebSocket(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as { port: number };
    try {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/verdesakay/ws?token=${token}`, { headers: { Host: host } });
      await once(socket, 'open');
      socket.close();
      await once(socket, 'close');
      const bad = new WebSocket(`ws://127.0.0.1:${address.port}/otherco/ws?token=${token}`, { headers: { Host: host } });
      await expect(once(bad, 'open')).rejects.toThrow('401');
      const old = new WebSocket(`ws://127.0.0.1:${address.port}/ws?token=${token}`, { headers: { Host: host } });
      await expect(once(old, 'open')).rejects.toThrow();
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});

it('scopes HttpOnly browser cookies to a tenant path and rejects another tenant cookie', async () => {
  const headers = { Host: host, 'X-Session-Mode': 'cookie', 'X-Requested-With': 'VDS' };
  const signed = await ctx.api.post('/verdesakay/api/auth/login').set(headers).send({ username: 'existing-admin', password: 'existing-password' });
  expect(signed.status).toBe(200); expect(signed.body.token).toBeUndefined();
  const raw = signed.headers['set-cookie']![0] as string;
  expect(raw).toContain('Path=/verdesakay'); expect(raw).toContain('HttpOnly');
  const cookie = raw.split(';')[0]!;
  expect((await ctx.api.get('/verdesakay/api/auth/me').set('Host', host).set('Cookie', cookie)).status).toBe(200);
  expect((await ctx.api.get('/otherco/api/auth/me').set('Host', host).set('Cookie', cookie)).status).toBe(401);
  expect((await ctx.api.get('/verdesakay/mobile/index.html').set('Host', host)).text).toContain('href="/verdesakay/policies"');
  expect((await ctx.api.get('/policies/privacy').set('Host', host)).status).toBe(200);
  const tenantPolicy = await ctx.api.get('/verdesakay/policies/privacy').set('Host', host);
  expect(tenantPolicy.status).toBe(200); expect(tenantPolicy.text).toContain('requires owner and legal approval');
  expect(tenantPolicy.headers['x-frame-options']).toBe('DENY');
});
