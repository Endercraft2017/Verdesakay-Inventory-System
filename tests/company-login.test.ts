import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { setupApp, cleanup, type TestContext } from './helpers';
let ctx: TestContext;
let platform: typeof import('../src/platform/platform');
let db: typeof import('../src/shared/db');
const host = 'otom.example.test';
const oldHost = process.env.TENANT_PATH_HOST;
const oldRedirect = process.env.DEFAULT_TENANT_REDIRECT;
const credentials = { username: 'owner', password: 'hexter-pass-123' }; // gitleaks:allow -- synthetic test credential
beforeAll(async () => {
  ctx = await setupApp();
  process.env.TENANT_PATH_HOST = host;
  platform = await import('../src/platform/platform');
  db = await import('../src/shared/db');
  const { createTenant } = await import('../src/platform/provisioning');
  createTenant({ slug: 'hexter', name: 'Hexter', admin_username: 'owner', admin_password: credentials.password });
  createTenant({ slug: 'hoster', name: 'Hoster', admin_username: 'owner', admin_password: 'hoster-pass-123' });
  createTenant({ slug: 'joes', name: 'Joes', admin_username: 'owner', admin_password: 'joes-pass-123-test-only' });
});
afterAll(() => {
  if (oldHost === undefined) delete process.env.TENANT_PATH_HOST; else process.env.TENANT_PATH_HOST = oldHost;
  if (oldRedirect === undefined) delete process.env.DEFAULT_TENANT_REDIRECT; else process.env.DEFAULT_TENANT_REDIRECT = oldRedirect;
  cleanup(ctx);
});
const login = (company_id: unknown, extra = {}) => ctx.api.post('/site/login').set('Host', host).send({ company_id, ...credentials, ...extra });

describe('company login IDs', () => {
  it('allocates a separate permanent sequence for each first/last-letter pair', () => {
    expect(platform.getTenant('hexter')!.company_id).toBe('H0000R');
    expect(platform.getTenant('hoster')!.company_id).toBe('H0001R');
    expect(platform.getTenant('joes')!.company_id).toBe('J0000S');
    platform.setTenantName('hexter', 'Renamed Company');
    expect(platform.getTenant('hexter')!.company_id).toBe('H0000R');
  });
  it('backfills missing IDs and preserves allocations across reconnects', () => {
    platform.platformDb().prepare('INSERT INTO tenants (slug, name) VALUES (?, ?)').run('legacy', 'Hector');
    platform._resetPlatformDb();
    expect(platform.getTenant('legacy')!.company_id).toBe('H0002R');
    platform._resetPlatformDb();
    expect(platform.getTenantByCompanyId(' h0000r ')!.slug).toBe('hexter');
    expect(platform.getTenant('legacy')!.company_id).toBe('H0002R');
  });
  it('rolls back allocation on duplicate creation and never reuses a purged ID', () => {
    expect(() => platform.createTenantRow({ slug: 'legacy', name: 'Hammer' })).toThrow();
    platform.setTenantStatus('legacy', 'purged');
    expect(platform.createTenantRow({ slug: 'hammer', name: 'Hammer' }).company_id).toBe('H0003R');
  });
  it('joins an outer provisioning transaction without committing it', () => {
    const control = platform.platformDb();
    control.exec('BEGIN IMMEDIATE');
    expect(platform.createTenantRow({ slug: 'nested', name: 'Nested' }).company_id).toBe('N0000D');
    control.exec('ROLLBACK');
    expect(platform.getTenant('nested')).toBeNull();
    expect(platform.createTenantRow({ slug: 'nested', name: 'Nested' }).company_id).toBe('N0000D');
  });
  it('rejects sequence exhaustion without creating an invalid ID', () => {
    platform.platformDb().prepare('INSERT INTO company_id_sequences (pair, next_number) VALUES (?, ?)').run('ZZ', 10000);
    expect(() => platform.createTenantRow({ slug: 'zzz', name: 'Zzz' })).toThrow(/exhausted/);
    expect(platform.getTenant('zzz')).toBeNull();
  });
});

describe('apex company login', () => {
  it('authenticates in the selected tenant and returns its existing workspace path', async () => {
    const response = await login(' h0000r ');
    expect(response.status).toBe(200);
    expect(response.body.workspace_path).toBe('/hexter');
    expect(response.body.user.username).toBe('owner');
    const me = await ctx.api.get('/hexter/api/auth/me').set('Host', host).set('Authorization', 'Bearer ' + response.body.token);
    expect(me.status).toBe(200);
    const wrong = await ctx.api.get('/hoster/api/auth/me').set('Host', host).set('Authorization', 'Bearer ' + response.body.token);
    expect(wrong.status).toBe(401);
    const info = await ctx.api.get('/hexter/api/tenant').set('Host', host).set('Authorization', 'Bearer ' + response.body.token);
    expect(info.body.company_id).toBe('H0000R');
  });
  it('does not authenticate credentials from a different company', async () => {
    expect((await login('H0001R')).status).toBe(401);
    expect((await login('H0000R', { password: 'wrong' })).status).toBe(401);
    for (const value of [null, 'missing', 'H9999R', { slug: 'hexter' }]) expect((await login(value)).status).toBe(401);
  });
  it('rejects suspended and purged companies', async () => {
    platform.setTenantStatus('hexter', 'suspended');
    expect((await login('H0000R')).status).toBe(401);
    platform.setTenantStatus('hexter', 'active');
    expect((await login('H0002R')).status).toBe(401);
  });
  it('preserves shared-computer sessions and works after default-tenant cutover', async () => {
    process.env.DEFAULT_TENANT_REDIRECT = 'hexter';
    const response = await login('H0000R', { shared: true });
    expect(response.status).toBe(200);
    expect(response.body.session.shared).toBe(true);
    delete process.env.DEFAULT_TENANT_REDIRECT;
  });
  it('only exposes the entry point on the configured apex host', async () => {
    expect((await ctx.api.post('/site/login').send({ company_id: 'H0000R', ...credentials })).status).toBe(404);
  });
  it('reuses the tenant-scoped MFA challenge flow', async () => {
    const signed = await login('H0000R');
    const auth = { Host: host, Authorization: 'Bearer ' + signed.body.token };
    const setup = await ctx.api.post('/hexter/api/auth/mfa/setup').set(auth).send({ password: credentials.password });
    expect(setup.status).toBe(200);
    const { totpCode, totpCounter } = await import('../src/shared/totp');
    const enabled = await ctx.api.post('/hexter/api/auth/mfa/enable').set(auth).send({ code: totpCode(setup.body.secret, totpCounter() - 1) });
    expect(enabled.status).toBe(200);
    const step = await login('H0000R');
    expect(step.body.mfa_required).toBe(true);
    expect(step.body.token).toBeUndefined();
    const verified = await ctx.api.post('/site/login/mfa').set('Host', host).send({ company_id: 'H0000R', mfa_token: step.body.mfa_token, code: totpCode(setup.body.secret, totpCounter()) });
    expect(verified.status).toBe(200);
    expect(verified.body.workspace_path).toBe('/hexter');
    expect(verified.body.token).toBeTruthy();
  });
});
