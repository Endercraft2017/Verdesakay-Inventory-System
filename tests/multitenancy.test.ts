/** SaaS phase 2: tenant resolution, provisioning, isolation, lifecycle.
    The `default` tenant works with no catalog row; a named tenant needs one. */
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, type TestContext } from './helpers';

let ctx: TestContext;
let platform: typeof import('../src/platform/platform');
let provisioning: typeof import('../src/platform/provisioning');
let dbmod: typeof import('../src/shared/db');

const asTenant = (slug: string) => ({ 'X-Tenant': slug });

beforeAll(async () => {
  ctx = await setupApp();
  platform = await import('../src/platform/platform');
  provisioning = await import('../src/platform/provisioning');
  dbmod = await import('../src/shared/db');
});
afterAll(() => cleanup(ctx));

describe('resolveTenantSlug', () => {
  it('maps hosts to slugs', () => {
    const r = platform.resolveTenantSlug;
    expect(r('localhost:3000')).toBe('default');
    expect(r('127.0.0.1:3000')).toBe('default');
    // non-production honours the override header
    expect(r('anything', 'acme')).toBe('acme');
    expect(r('anything', 'WWW')).toBe('default'); // reserved
    expect(r('anything', 'bad_slug!')).toBe('default'); // invalid
  });
});

describe('the default tenant still works with no catalog', () => {
  it('logs in and serves data as before', async () => {
    const token = await login(ctx.api);
    const inv = await ctx.api.get('/api/inventory').set({ Authorization: `Bearer ${token}` });
    expect(inv.status).toBe(200);
  });
});

describe('provisioning + isolation', () => {
  it('rejects a reserved or malformed slug', () => {
    expect(() => provisioning.createTenant({ slug: 'admin', name: 'X', admin_username: 'owner', admin_password: 'secret1' })).toThrow();
    expect(() => provisioning.createTenant({ slug: 'A B', name: 'X', admin_username: 'owner', admin_password: 'secret1' })).toThrow();
  });

  it('creates a tenant with its own admin, isolated from the default tenant', async () => {
    provisioning.createTenant({ slug: 'acme', name: 'Acme Mfg', admin_username: 'owner', admin_password: 'acmepass1' });

    // The default admin cannot log into the acme tenant…
    const bad = await ctx.api.post('/api/auth/login').set(asTenant('acme')).send({ username: 'admin', password: 'admin123' });
    expect(bad.status).toBe(401);

    // …but the acme admin can.
    const good = await ctx.api.post('/api/auth/login').set(asTenant('acme')).send({ username: 'owner', password: 'acmepass1' });
    expect(good.status).toBe(200);
    const acmeToken = good.body.token as string;

    // An item created in `default` is not visible in `acme`.
    const defToken = await login(ctx.api);
    await ctx.api.post('/api/inventory').set({ Authorization: `Bearer ${defToken}` })
      .send({ name: 'Default-only Widget', sku: 'DEF-ONLY', quantity: 3 });

    const defList = await ctx.api.get('/api/inventory?q=DEF-ONLY').set({ Authorization: `Bearer ${defToken}` });
    expect(defList.body.some((i: { sku: string }) => i.sku === 'DEF-ONLY')).toBe(true);

    const acmeList = await ctx.api.get('/api/inventory?q=DEF-ONLY').set(asTenant('acme')).set({ Authorization: `Bearer ${acmeToken}` });
    expect(acmeList.status).toBe(200);
    expect(acmeList.body.length).toBe(0);
  });

  it('404s an unknown tenant and 403s a suspended one', async () => {
    expect((await ctx.api.get('/api/health').set(asTenant('ghostco'))).status).toBe(404);

    provisioning.suspendTenant('acme');
    const suspended = await ctx.api.post('/api/auth/login').set(asTenant('acme')).send({ username: 'owner', password: 'acmepass1' });
    expect(suspended.status).toBe(403);

    provisioning.resumeTenant('acme');
    const back = await ctx.api.post('/api/auth/login').set(asTenant('acme')).send({ username: 'owner', password: 'acmepass1' });
    expect(back.status).toBe(200);
  });

  it('rejects a duplicate slug', () => {
    expect(() => provisioning.createTenant({ slug: 'acme', name: 'Dupe', admin_username: 'x', admin_password: 'secret1' })).toThrow(/taken/i);
  });
});

describe('POST /api/signup', () => {
  it('404s while SIGNUPS_OPEN is off (default)', async () => {
    const r = await ctx.api.post('/api/signup').send({
      company_name: 'Trial Co', slug: 'trialco', admin_username: 'owner', admin_password: 'trialpass1',
    });
    expect(r.status).toBe(404);
  });
});

describe('per-tenant upload folders', () => {
  it('uploadDir() is the base for default and a sub-folder per tenant', () => {
    const base = dbmod.withTenant('default', () => dbmod.uploadDir());
    const acme = dbmod.withTenant('acme', () => dbmod.uploadDir());
    expect(path.basename(acme)).toBe('acme');
    expect(path.dirname(acme)).toBe(base);
    expect(base).not.toContain(`${path.sep}acme`);
  });
});

describe('schema_version', () => {
  it('the default tenant is stamped at the current version after init', () => {
    const v = dbmod.withTenant('default', () => dbmod.getSetting<number>('schema_version'));
    expect(v).toBe(dbmod.SCHEMA_VERSION);
  });
});
