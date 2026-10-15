/** Owner console (`/_platform`, PLATFORM_CONSOLE=true): operator auth is separate from
    tenant auth, and the console can provision tenants + set plan / status / modules —
    the same primitives as the `tenant:*` CLI. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, type TestContext } from './helpers';

let ctx: TestContext;
let op: string; // operator bearer token
let users: typeof import('../src/platform/platform-users');
const opHdr = () => ({ Authorization: `Bearer ${op}` });
const asTenant = (slug: string) => ({ 'X-Tenant': slug });

beforeAll(async () => {
  process.env.PLATFORM_CONSOLE = 'true';
  ctx = await setupApp();
  await login(ctx.api); // seeds the default tenant
  users = await import('../src/platform/platform-users');
  users.upsertPlatformUser('owner', 'ownerpass1', 'System Owner');
  const r = await ctx.api.post('/_platform/api/login').send({ username: 'owner', password: 'ownerpass1' });
  op = r.body.token;
});
afterAll(() => { delete process.env.PLATFORM_CONSOLE; cleanup(ctx); });

describe('operator auth', () => {
  it('rejects a bad password, accepts a good one', async () => {
    expect((await ctx.api.post('/_platform/api/login').send({ username: 'owner', password: 'nope' })).status).toBe(401);
    expect(typeof op).toBe('string');
    const me = await ctx.api.get('/_platform/api/me').set(opHdr());
    expect(me.body.user.username).toBe('owner');
  });

  it('401s without a token', async () => {
    expect((await ctx.api.get('/_platform/api/tenants')).status).toBe(401);
  });

  it('a tenant user token does not work on the console', async () => {
    const tenantTok = await login(ctx.api); // default-tenant admin
    const r = await ctx.api.get('/_platform/api/tenants').set({ Authorization: `Bearer ${tenantTok}` });
    expect(r.status).toBe(401);
  });

  it('the console 404s on a tenant sub-domain (apex host only)', async () => {
    // create one first so the slug resolves past the tenant middleware
    await ctx.api.post('/_platform/api/tenants').set(opHdr())
      .send({ slug: 'hostcheck', name: 'Host Check', admin_username: 'owner', admin_password: 'ownerpass1', plan: 'starter' });
    const r = await ctx.api.get('/_platform/api/tenants').set(opHdr()).set(asTenant('hostcheck'));
    expect(r.status).toBe(404);
  });
});

describe('bootstrap reference', () => {
  it('returns the module + plan catalogue', async () => {
    const b = (await ctx.api.get('/_platform/api/bootstrap').set(opHdr())).body;
    expect(b.modules).toContain('hr');
    expect(b.plan_modules.starter).toEqual(['inventory', 'purchasing', 'mobile']);
    expect(b.plans).toContain('complete');
    expect(b.statuses).not.toContain('purged');
  });
});

describe('provision + edit a workspace', () => {
  it('creates one on the starter bundle', async () => {
    const r = await ctx.api.post('/_platform/api/tenants').set(opHdr())
      .send({ slug: 'consoleco', name: 'Console Co', admin_username: 'owner', admin_password: 'ownerpass1', plan: 'starter' });
    expect(r.status).toBe(201);
    expect(r.body.slug).toBe('consoleco');
    expect(r.body.modules.effective).toEqual(['inventory', 'purchasing', 'mobile']);
    expect(r.body.modules.override).toBeNull();

    const list = (await ctx.api.get('/_platform/api/tenants').set(opHdr())).body;
    expect(list.map((t: { slug: string }) => t.slug)).toContain('consoleco');

    // the tenant's own admin can log in normally
    const t = await ctx.api.post('/api/auth/login').set(asTenant('consoleco'))
      .send({ username: 'owner', password: 'ownerpass1' });
    expect(t.status).toBe(200);
  });

  it('PATCH sets plan + an explicit module override, reflected on /api/tenant', async () => {
    const p = await ctx.api.patch('/_platform/api/tenants/consoleco').set(opHdr())
      .send({ plan: 'complete', modules: ['hr'] });
    expect(p.status).toBe(200);
    expect(p.body.plan).toBe('complete');
    expect(p.body.modules.effective).toEqual(['hr']);
    expect(p.body.modules.override).toEqual(['hr']);

    const tok = (await ctx.api.post('/api/auth/login').set(asTenant('consoleco'))
      .send({ username: 'owner', password: 'ownerpass1' })).body.token;
    const view = await ctx.api.get('/api/tenant').set(asTenant('consoleco')).set({ Authorization: `Bearer ${tok}` });
    expect(view.body.plan).toBe('complete');
    expect(view.body.modules).toEqual(['hr']);
    expect((await ctx.api.get('/api/inventory').set(asTenant('consoleco')).set({ Authorization: `Bearer ${tok}` })).status).toBe(402);
  });

  it('module dependencies are unioned in; null clears the override', async () => {
    let p = await ctx.api.patch('/_platform/api/tenants/consoleco').set(opHdr()).send({ modules: ['manufacturing'] });
    expect(p.body.modules.effective).toEqual(['inventory', 'manufacturing']);

    p = await ctx.api.patch('/_platform/api/tenants/consoleco').set(opHdr()).send({ modules: null });
    expect(p.body.modules.override).toBeNull();
    expect(p.body.modules.effective).toEqual(p.body.modules.plan_default); // complete = everything
  });

  it('rejects an unknown plan or module', async () => {
    expect((await ctx.api.patch('/_platform/api/tenants/consoleco').set(opHdr()).send({ plan: 'gold' })).status).toBe(400);
    expect((await ctx.api.patch('/_platform/api/tenants/consoleco').set(opHdr()).send({ modules: ['hr', 'wat'] })).status).toBe(400);
  });

  it('PATCH sets kiosk punch-photo retention (owner-only), reads back via photo_retention', async () => {
    const defaults = (await ctx.api.get('/_platform/api/tenants/consoleco').set(opHdr())).body;
    expect(defaults.photo_retention).toEqual({ retention_days: null, max_mb: null, usage_mb: expect.any(Number) });

    const p = await ctx.api.patch('/_platform/api/tenants/consoleco').set(opHdr())
      .send({ photo_retention_days: 14, photo_max_mb: 50 });
    expect(p.status).toBe(200);
    expect(p.body.photo_retention.retention_days).toBe(14);
    expect(p.body.photo_retention.max_mb).toBe(50);

    // 0 means "no limit" for that dimension, not "use the default" -- distinct from null.
    const cleared = await ctx.api.patch('/_platform/api/tenants/consoleco').set(opHdr())
      .send({ photo_retention_days: 0, photo_max_mb: null });
    expect(cleared.body.photo_retention).toEqual({ retention_days: 0, max_mb: null, usage_mb: expect.any(Number) });

    expect((await ctx.api.patch('/_platform/api/tenants/consoleco').set(opHdr())
      .send({ photo_max_mb: -1 })).status).toBe(400);
    expect((await ctx.api.patch('/_platform/api/tenants/consoleco').set(opHdr())
      .send({ photo_retention_days: 1.5 })).status).toBe(400);
  });

  it('suspending blocks tenant login; resuming restores it', async () => {
    await ctx.api.patch('/_platform/api/tenants/consoleco').set(opHdr()).send({ status: 'suspended' });
    expect((await ctx.api.post('/api/auth/login').set(asTenant('consoleco'))
      .send({ username: 'owner', password: 'ownerpass1' })).status).toBe(403);
    await ctx.api.patch('/_platform/api/tenants/consoleco').set(opHdr()).send({ status: 'active' });
    expect((await ctx.api.post('/api/auth/login').set(asTenant('consoleco'))
      .send({ username: 'owner', password: 'ownerpass1' })).status).toBe(200);
  });

  it('purge needs the slug typed back, then the workspace is gone', async () => {
    expect((await ctx.api.post('/_platform/api/tenants/consoleco/purge').set(opHdr()).send({ confirm: 'wrong' })).status).toBe(400);
    expect((await ctx.api.post('/_platform/api/tenants/consoleco/purge').set(opHdr()).send({ confirm: 'consoleco' })).status).toBe(200);
    const list = (await ctx.api.get('/_platform/api/tenants').set(opHdr())).body;
    expect(list.map((t: { slug: string }) => t.slug)).not.toContain('consoleco');
  });
});

describe('logout', () => {
  it('invalidates the operator session', async () => {
    const tok = (await ctx.api.post('/_platform/api/login').send({ username: 'owner', password: 'ownerpass1' })).body.token;
    expect((await ctx.api.get('/_platform/api/me').set({ Authorization: `Bearer ${tok}` })).status).toBe(200);
    await ctx.api.post('/_platform/api/logout').set({ Authorization: `Bearer ${tok}` });
    expect((await ctx.api.get('/_platform/api/me').set({ Authorization: `Bearer ${tok}` })).status).toBe(401);
  });
});

describe('module subscriptions and employee allowances', () => {
  const settings = {
    mode: 'per_module', bundle: 'starter', modules: ['hr', 'manufacturing'],
    employee_limit: 2, bundle_price: null,
    module_prices: { hr: 500, manufacturing: 250, inventory: 100 }, employee_price: 50,
  };
  let tenantToken: string;
  const tenantHeaders = () => ({ ...asTenant('subscriptionco'), Authorization: `Bearer ${tenantToken}` });

  it('creates a tenant without selecting or pricing modules', async () => {
    const r = await ctx.api.post('/_platform/api/tenants').set(opHdr()).send({
      slug: 'subscriptionco', name: 'Subscription Co', admin_username: 'owner', admin_password: 'ownerpass1',
    });
    expect(r.status).toBe(201);
    expect(r.body.modules.effective).toEqual([]);
    expect(r.body.subscription.employee_limit).toBe(0);
    expect(r.body.subscription.monthly_total).toBeNull();
    tenantToken = (await ctx.api.post('/api/auth/login').set(asTenant('subscriptionco'))
      .send({ username: 'owner', password: 'ownerpass1' })).body.token;
  });

  it('saves module prices, expands dependencies and quotes employee allowance', async () => {
    const r = await ctx.api.put('/_platform/api/tenants/subscriptionco/subscription').set(opHdr()).send(settings);
    expect(r.status).toBe(200);
    expect(r.body.modules.effective).toEqual(['inventory', 'manufacturing', 'hr']);
    expect(r.body.subscription.monthly_total).toBe(950);
    expect(r.body.subscription.currency).toBe('PHP');
    const own = await ctx.api.get('/api/tenant').set(tenantHeaders());
    expect(own.body.limits.employees).toBe(2);
  });

  it('rejects invalid prices without changing entitlements, requires owner auth', async () => {
    const url = '/_platform/api/tenants/subscriptionco/subscription';
    expect((await ctx.api.put(url).send(settings)).status).toBe(401);
    for (const patch of [{ employee_limit: -1 }, { employee_limit: 1.5 }, { employee_price: -10 },
      { employee_price: 0.001 }, { modules: ['unknown'] }, { module_prices: { unknown: 10 } }]) {
      expect((await ctx.api.put(url).set(opHdr()).send({ ...settings, ...patch })).status).toBe(400);
    }
    const unchanged = await ctx.api.get('/_platform/api/tenants/subscriptionco').set(opHdr());
    expect(unchanged.body.subscription.monthly_total).toBe(950);
    expect((await ctx.api.patch('/_platform/api/tenants/subscriptionco').set(opHdr()).send({ plan: 'complete' })).status).toBe(400);
  });

  it('enforces employee caps on create and CSV import, while permitting updates', async () => {
    const create = await ctx.api.post('/api/hr/employees').set(tenantHeaders()).send({ employee_no: 'E1', name: 'First', status: 'resigned' });
    expect(create.status).toBe(201);
    const preview = await ctx.api.post('/api/hr/employees/import').set(tenantHeaders())
      .send({ csv: 'employee_no,name\nE2,Second\nE3,Third', dry_run: true });
    expect(preview.body.created).toBe(1);
    expect(preview.body.skipped).toBe(1);
    expect((await ctx.api.get('/api/tenant').set(tenantHeaders())).body.usage.employees).toBe(1);
    const imported = await ctx.api.post('/api/hr/employees/import').set(tenantHeaders())
      .send({ csv: 'employee_no,name\nE2,Second\nE3,Third' });
    expect(imported.status).toBe(200);
    expect(imported.body.created).toBe(1);
    expect(imported.body.skipped).toBe(1);
    expect(imported.body.errors[0].message).toMatch(/employee record limit/);
    expect((await ctx.api.post('/api/hr/employees').set(tenantHeaders()).send({ employee_no: 'E4', name: 'Fourth' })).status).toBe(402);
    const update = await ctx.api.post('/api/hr/employees/import').set(tenantHeaders())
      .send({ csv: 'employee_no,name\nE1,First updated' });
    expect(update.body.updated).toBe(1);
    const usage = await ctx.api.get('/api/tenant').set(tenantHeaders());
    expect(usage.body.usage.employees).toBe(2);
  });

  it('switches to bundles and preserves records when reducing allowance', async () => {
    const r = await ctx.api.put('/_platform/api/tenants/subscriptionco/subscription').set(opHdr())
      .send({ ...settings, mode: 'bundle', bundle: 'operations', employee_limit: 1, bundle_price: 2000 });
    expect(r.status).toBe(200);
    expect(r.body.modules.override).toBeNull();
    expect(r.body.subscription.monthly_total).toBe(2050);
    expect(r.body.usage.employees).toBe(2);
    expect((await ctx.api.post('/api/hr/employees').set(tenantHeaders()).send({ employee_no: 'E5', name: 'Fifth' })).status).toBe(402);
    const blank = await ctx.api.put('/_platform/api/tenants/subscriptionco/subscription').set(opHdr())
      .send({ ...settings, module_prices: { hr: 0 }, employee_limit: null });
    expect(blank.body.subscription.monthly_total).toBeNull();
    expect((await ctx.api.post('/api/hr/employees').set(tenantHeaders()).send({ employee_no: 'E6', name: 'Sixth' })).status).toBe(201);
  });
});

it('uses HttpOnly console cookies and CSRF checks without returning a browser bearer token', async () => {
  const headers = { 'X-Session-Mode': 'cookie', 'X-Requested-With': 'VDS' };
  const result = await ctx.api.post('/_platform/api/login').set(headers).send({ username: 'owner', password: 'ownerpass1' });
  expect(result.status).toBe(200); expect(result.body.token).toBeUndefined();
  const raw = result.headers['set-cookie']![0] as string;
  expect(raw).toContain('HttpOnly'); expect(raw).toContain('Path=/_platform');
  const cookie = raw.split(';')[0]!;
  expect((await ctx.api.get('/_platform/api/me').set('Cookie', cookie)).status).toBe(200);
  expect((await ctx.api.post('/_platform/api/logout').set('Cookie', cookie)).status).toBe(403);
  expect((await ctx.api.post('/_platform/api/logout').set(headers).set('Cookie', cookie)).status).toBe(200);
  expect((await ctx.api.get('/_platform/api/me').set('Cookie', cookie)).status).toBe(401);
});
