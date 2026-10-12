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
      .send({ slug: 'hostcheck', name: 'Host Check', admin_username: 'owner', admin_password: 'ownerpass1', admin_email: 'owner@acme.test', plan: 'starter' });
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
  it('requires a recovery email for regular accounts and persists it on the owner', async () => {
    const input = { name: 'Real Company', admin_username: 'realowner', admin_password: 'realpass1' };
    expect((await ctx.api.post('/_platform/api/tenants').set(opHdr()).send(input)).status).toBe(400);
    expect((await ctx.api.post('/_platform/api/tenants').set(opHdr()).send({ ...input, admin_email: 'invalid' })).status).toBe(400);
    expect((await ctx.api.post('/_platform/api/tenants').set(opHdr()).send({ ...input, is_sandbox: 'true' })).status).toBe(400);
    const r = await ctx.api.post('/_platform/api/tenants').set(opHdr()).send({ ...input, admin_email: ' Owner@Real.test ' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ slug: 'real-company', is_sandbox: false });
    const detail = await ctx.api.get('/_platform/api/tenants/real-company').set(opHdr());
    expect(detail.body.owner.email).toBe('owner@real.test');
    const { withTenant, setSetting, queryOne } = await import('../src/shared/db');
    withTenant('real-company', () => setSetting('mail_settings', { transport: 'smtp', smtp_host: 'smtp.real.test', from_email: 'system@real.test' }));
    const forgot = await ctx.api.post('/api/auth/forgot-password').set(asTenant('real-company')).send({ identifier: 'owner@real.test' });
    expect(forgot.body.ok).toBe(true); // same answer for every account; the link row proves it was issued
    expect(withTenant('real-company', () => queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM password_resets')!.n)).toBeGreaterThan(0);
    expect((await ctx.api.post('/_platform/api/tenants/real-company/recover-owner-username').set(opHdr())).body.email.sent).toBe(true);
    const reset = await ctx.api.post('/_platform/api/tenants/real-company/reset-owner-password').set(opHdr())
      .send({ owner_id: 1, new_password: 'newrealpass1' });
    expect(reset.body.email.sent).toBe(true);
    expect(withTenant('real-company', () => queryOne<{ c: number }>("SELECT COUNT(*) AS c FROM mail_log WHERE to_addr = 'owner@real.test' AND status = 'sent'")!.c)).toBe(3);
  });

  it('creates sandbox tenants from just company and login, skips every recovery email, and removes them', async () => {
    const input = { name: 'Sandbox Company', admin_username: 'sandboxowner', admin_password: 'sandboxpass1', is_sandbox: true };
    expect((await ctx.api.post('/_platform/api/tenants').set(opHdr()).send({ ...input, name: '' })).status).toBe(400);
    const r = await ctx.api.post('/_platform/api/tenants').set(opHdr()).send(input);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ slug: 'sandbox-company', is_sandbox: true });
    const duplicate = await ctx.api.post('/_platform/api/tenants').set(opHdr()).send(input);
    expect(duplicate.body.slug).toBe('sandbox-company-2');
    const { withTenant, setSetting, run, queryOne, DATA_DIR } = await import('../src/shared/db');
    const fs = await import('node:fs');
    const { _resetPlatformDb, getTenant } = await import('../src/platform/platform');
    _resetPlatformDb();
    expect(getTenant('sandbox-company')!.is_sandbox).toBe(1);
    const detail = await ctx.api.get('/_platform/api/tenants/sandbox-company').set(opHdr());
    expect(detail.body.owner.email).toBeNull();
    // Even an email added later and functioning SMTP must not send sandbox recovery mail.
    withTenant('sandbox-company', () => {
      run("UPDATE users SET email = 'sandbox@acme.test' WHERE id = 1");
      setSetting('mail_settings', { transport: 'smtp', smtp_host: 'smtp.acme.test', from_email: 'system@acme.test' });
    });
    const forgot = await ctx.api.post('/api/auth/forgot-password').set(asTenant('sandbox-company')).send({ identifier: 'sandboxowner' });
    expect(forgot.body).toMatchObject({ sent: false });
    expect(forgot.body.reason).toMatch(/Sandbox/);
    const reminder = await ctx.api.post('/_platform/api/tenants/sandbox-company/recover-owner-username').set(opHdr());
    expect(reminder.body.email).toEqual({ sent: false, reason: 'sandbox' });
    const reset = await ctx.api.post('/_platform/api/tenants/sandbox-company/reset-owner-password').set(opHdr())
      .send({ owner_id: 1, new_password: 'new-sandbox1' });
    expect(reset.status).toBe(200);
    expect(reset.body.email).toEqual({ sent: false, reason: 'sandbox' });
    expect(withTenant('sandbox-company', () => queryOne<{ c: number }>('SELECT COUNT(*) AS c FROM mail_log')!.c)).toBe(0);
    expect(withTenant('sandbox-company', () => queryOne<{ c: number }>('SELECT COUNT(*) AS c FROM password_resets')!.c)).toBe(0);
    expect((await ctx.api.post('/api/auth/login').set(asTenant('sandbox-company')).send({ username: 'sandboxowner', password: 'new-sandbox1' })).status).toBe(200);
    const path = '/_platform/api/tenants/sandbox-company/purge';
    expect((await ctx.api.post(path).send({ confirm: 'sandbox-company' })).status).toBe(401);
    expect((await ctx.api.post(path).set(opHdr()).send({ confirm: 'wrong' })).status).toBe(400);
    expect(fs.existsSync(`${DATA_DIR}/sandbox-company.db`)).toBe(true);
    expect((await ctx.api.post(path).set(opHdr()).send({ confirm: 'sandbox-company' })).status).toBe(200);
    expect(fs.existsSync(`${DATA_DIR}/sandbox-company.db`)).toBe(false);
    expect((await ctx.api.get('/_platform/api/tenants').set(opHdr())).body.some((t: { slug: string }) => t.slug === 'sandbox-company')).toBe(false);
    expect((await ctx.api.post('/api/auth/login').set(asTenant('sandbox-company')).send({ username: 'sandboxowner', password: 'new-sandbox1' })).status).toBe(403);
    expect((await ctx.api.get('/_platform/api/tenants/sandbox-company').set(opHdr())).status).toBe(404);
    expect(fs.existsSync(`${DATA_DIR}/sandbox-company.db`)).toBe(false);
  });

  it('creates one on the starter bundle', async () => {
    const r = await ctx.api.post('/_platform/api/tenants').set(opHdr())
      .send({ slug: 'consoleco', name: 'Console Co', admin_username: 'owner', admin_password: 'ownerpass1', admin_email: 'owner@acme.test', plan: 'starter' });
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

  it('recovers only the first admin login, revokes sessions and reset links, and audits without secrets', async () => {
    const { withTenant, run, queryOne } = await import('../src/shared/db');
    const bcrypt = (await import('bcryptjs')).default;
    const old = await ctx.api.post('/api/auth/login').set(asTenant('consoleco'))
      .send({ username: 'owner', password: 'ownerpass1' });
    withTenant('consoleco', () => {
      run("INSERT INTO users (username, full_name, password_hash, role) VALUES (?, ?, ?, 'admin')",
        'secondadmin', 'Second Admin', bcrypt.hashSync('secondpass1', 10));
      run("INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ('old-reset', 1, datetime('now', '+1 hour'))");
    });
    const view = await ctx.api.get('/_platform/api/tenants/consoleco').set(opHdr());
    expect(view.body.owner).toMatchObject({ id: 1, username: 'owner' });
    expect(view.body.owner.password_hash).toBeUndefined();
    const path = '/_platform/api/tenants/consoleco/reset-owner-password';
    const body = { owner_id: 1, new_password: 'replacement1' };
    expect((await ctx.api.post(path).send(body)).status).toBe(401);
    expect((await ctx.api.post(path).set({ Authorization: `Bearer ${old.body.token}` }).send(body)).status).toBe(401);
    expect((await ctx.api.post(path).set(opHdr()).set(asTenant('consoleco')).send(body)).status).toBe(404);
    expect((await ctx.api.post(path).set(opHdr()).send({ ...body, owner_id: 2 })).status).toBe(409);
    expect((await ctx.api.post(path).set(opHdr()).send({ ...body, new_password: 'short' })).status).toBe(400);
    expect((await ctx.api.post(path).set(opHdr()).send(body)).status).toBe(200);
    expect((await ctx.api.post('/api/auth/login').set(asTenant('consoleco'))
      .send({ username: 'owner', password: 'ownerpass1' })).status).toBe(401);
    expect((await ctx.api.post('/api/auth/login').set(asTenant('consoleco'))
      .send({ username: 'owner', password: body.new_password })).status).toBe(200);
    expect((await ctx.api.get('/api/auth/me').set(asTenant('consoleco'))
      .set({ Authorization: `Bearer ${old.body.token}` })).status).toBe(401);
    expect((await ctx.api.post('/api/auth/login').set(asTenant('consoleco'))
      .send({ username: 'secondadmin', password: 'secondpass1' })).status).toBe(200);
    expect(withTenant('consoleco', () => queryOne<{ c: number }>('SELECT COUNT(*) AS c FROM password_resets')!.c)).toBe(0);
    expect((await ctx.api.post('/api/auth/login').send({ username: 'admin', password: 'admin123' })).status).toBe(200);
    const detail = (await ctx.api.get('/_platform/api/tenants/consoleco').set(opHdr())).body;
    expect(detail.log.find((e: { action: string }) => e.action === 'owner-password-reset').detail).toContain('owner: reset owner owner');
    expect(JSON.stringify(detail)).not.toContain(body.new_password);
    expect((await ctx.api.post('/_platform/api/tenants/missing/reset-owner-password').set(opHdr()).send(body)).status).toBe(404);
  });

  it('issues a temporary fallback once, blocks workspace access until replacement, and expires it', async () => {
    const { withTenant, queryOne, run } = await import('../src/shared/db');
    const bcrypt = (await import('bcryptjs')).default;
    const create = await ctx.api.post('/_platform/api/tenants').set(opHdr()).send({
      slug: 'temprecovery', name: 'Temporary Recovery', admin_email: 'tempowner@acme.test',
      admin_username: 'tempowner', admin_password: 'old-temporary1',
    });
    expect(create.status).toBe(201);
    const path = '/_platform/api/tenants/temprecovery/reset-owner-password';
    expect((await ctx.api.post(path).send({ owner_id: 1, temporary: true })).status).toBe(401);
    expect((await ctx.api.post(path).set(opHdr()).send({ owner_id: 1, temporary: 'true' })).status).toBe(400);
    const issue = await ctx.api.post(path).set(opHdr()).send({ owner_id: 1, temporary: true });
    expect(issue.status).toBe(200);
    expect(issue.headers['cache-control']).toBe('no-store');
    const temporary = issue.body.temporary_password;
    expect(temporary).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(Date.parse(issue.body.expires_at) - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1000);
    const user = withTenant('temprecovery', () => queryOne<{ password_hash: string; password_change_required: number }>('SELECT * FROM users WHERE id = 1')!);
    expect(user.password_hash).not.toBe(temporary);
    expect(bcrypt.compareSync(temporary, user.password_hash)).toBe(true);
    expect(user.password_change_required).toBe(1);
    expect(withTenant('temprecovery', () => queryOne<{ c: number }>('SELECT COUNT(*) AS c FROM mail_log')!.c)).toBe(0);
    const detail = await ctx.api.get('/_platform/api/tenants/temprecovery').set(opHdr());
    expect(JSON.stringify(detail.body)).not.toContain(temporary);
    const loginResult = await ctx.api.post('/api/auth/login').set(asTenant('temprecovery')).send({ username: 'tempowner', password: temporary });
    expect(loginResult.status).toBe(200);
    expect(loginResult.body.user.password_change_required).toBe(1);
    expect(loginResult.body.user.permissions).toEqual([]);
    const header = { Authorization: `Bearer ${loginResult.body.token}` };
    expect((await ctx.api.get('/api/users').set(asTenant('temprecovery')).set(header)).status).toBe(403);
    expect((await ctx.api.get('/api/auth/me').set(asTenant('temprecovery')).set(header)).body.user.password_change_required).toBe(1);
    const { userFromToken } = await import('../src/shared/auth');
    expect(withTenant('temprecovery', () => userFromToken(loginResult.body.token))).toBeNull(); // WebSocket auth stays blocked too.
    expect((await ctx.api.post('/api/auth/change-password').set(asTenant('temprecovery')).set(header)
      .send({ current_password: temporary, new_password: temporary })).status).toBe(400);
    expect((await ctx.api.post('/api/auth/change-password').set(asTenant('temprecovery')).set(header)
      .send({ current_password: temporary, new_password: 'permanent-owner1' })).status).toBe(200);
    expect((await ctx.api.get('/api/users').set(asTenant('temprecovery')).set(header)).status).toBe(200);
    expect((await ctx.api.post('/api/auth/login').set(asTenant('temprecovery')).send({ username: 'tempowner', password: temporary })).status).toBe(401);
    const replacement = await ctx.api.post(path).set(opHdr()).send({ owner_id: 1, temporary: true });
    expect(replacement.body.temporary_password).not.toBe(temporary);
    expect((await ctx.api.get('/api/auth/me').set(asTenant('temprecovery')).set(header)).status).toBe(401);
    withTenant('temprecovery', () => run("UPDATE users SET temporary_password_expires_at = ? WHERE id = 1", new Date(Date.now() - 1000).toISOString()));
    expect((await ctx.api.post('/api/auth/login').set(asTenant('temprecovery'))
      .send({ username: 'tempowner', password: replacement.body.temporary_password })).status).toBe(401);
  });

  it('purge needs the slug typed back, then the workspace is gone', async () => {
    expect((await ctx.api.post('/_platform/api/tenants/consoleco/purge').set(opHdr()).send({ confirm: 'wrong' })).status).toBe(400);
    expect((await ctx.api.post('/_platform/api/tenants/consoleco/purge').set(opHdr()).send({ confirm: 'consoleco' })).status).toBe(200);
    const list = (await ctx.api.get('/_platform/api/tenants').set(opHdr())).body;
    expect(list.map((t: { slug: string }) => t.slug)).not.toContain('consoleco');
    expect((await ctx.api.post('/_platform/api/tenants/consoleco/reset-owner-password').set(opHdr())
      .send({ owner_id: 1, new_password: 'replacement2' })).status).toBe(404);
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

describe('module subscriptions and login seats', () => {
  const settings = {
    mode: 'per_module', bundle: 'starter', modules: ['hr', 'manufacturing'],
    seat_limit: 2, bundle_price: null,
    module_prices: { hr: 500, manufacturing: 250, inventory: 100 }, seat_price: 50,
  };
  let tenantToken: string;
  const tenantHeaders = () => ({ ...asTenant('subscriptionco'), Authorization: `Bearer ${tenantToken}` });

  it('creates a tenant without selecting or pricing modules', async () => {
    const r = await ctx.api.post('/_platform/api/tenants').set(opHdr()).send({
      slug: 'subscriptionco', name: 'Subscription Co', admin_username: 'owner', admin_password: 'ownerpass1', admin_email: 'owner@subscription.test',
    });
    expect(r.status).toBe(201);
    expect(r.body.modules.effective).toEqual([]);
    expect(r.body.subscription.seat_limit).toBeNull();
    expect(r.body.subscription.monthly_total).toBeNull();
    tenantToken = (await ctx.api.post('/api/auth/login').set(asTenant('subscriptionco'))
      .send({ username: 'owner', password: 'ownerpass1' })).body.token;
  });

  it('saves module prices, expands dependencies and quotes seat allowance', async () => {
    const r = await ctx.api.put('/_platform/api/tenants/subscriptionco/subscription').set(opHdr()).send(settings);
    expect(r.status).toBe(200);
    expect(r.body.modules.effective).toEqual(['inventory', 'manufacturing', 'hr']);
    expect(r.body.subscription.monthly_total).toBe(950);
    expect(r.body.subscription.currency).toBe('PHP');
    const own = await ctx.api.get('/api/tenant').set(tenantHeaders());
    expect(own.body.limits.users).toBe(2);
  });

  it('rejects invalid prices without changing entitlements, requires owner auth', async () => {
    const url = '/_platform/api/tenants/subscriptionco/subscription';
    expect((await ctx.api.put(url).send(settings)).status).toBe(401);
    for (const patch of [{ seat_limit: -1 }, { seat_limit: 1.5 }, { seat_price: -10 },
      { seat_price: 0.001 }, { modules: ['unknown'] }, { module_prices: { unknown: 10 } }]) {
      expect((await ctx.api.put(url).set(opHdr()).send({ ...settings, ...patch })).status).toBe(400);
    }
    const unchanged = await ctx.api.get('/_platform/api/tenants/subscriptionco').set(opHdr());
    expect(unchanged.body.subscription.monthly_total).toBe(950);
    expect((await ctx.api.patch('/_platform/api/tenants/subscriptionco').set(opHdr()).send({ plan: 'complete' })).status).toBe(400);
  });

  it('enforces active login seats on creation and reactivation, without capping employees', async () => {
    const second = await ctx.api.post('/api/users').set(tenantHeaders()).send({ username: 'second', full_name: 'Second', password: 'secret123' });
    expect(second.status).toBe(201);
    expect((await ctx.api.post('/api/users').set(tenantHeaders()).send({ username: 'third', full_name: 'Third', password: 'secret123' })).status).toBe(402);
    expect((await ctx.api.put('/api/users/' + second.body.id).set(tenantHeaders()).send({ active: false })).status).toBe(200);
    const third = await ctx.api.post('/api/users').set(tenantHeaders()).send({ username: 'third', full_name: 'Third', password: 'secret123' });
    expect(third.status).toBe(201);
    expect((await ctx.api.put('/api/users/' + second.body.id).set(tenantHeaders()).send({ active: true })).status).toBe(402);
    const created = await ctx.api.post('/api/hr/employees').set(tenantHeaders()).send({ employee_no: 'E1', name: 'First', status: 'resigned' });
    expect(created.status).toBe(201);
    const imported = await ctx.api.post('/api/hr/employees/import').set(tenantHeaders())
      .send({ csv: 'employee_no,name\nE2,Second\nE3,Third\nE4,Fourth' });
    expect(imported.body.created).toBe(3);
    expect(imported.body.skipped).toBe(0);
    const usage = await ctx.api.get('/api/tenant').set(tenantHeaders());
    expect(usage.body.usage.employees).toBe(4);
    expect(usage.body.limits.employees).toBeNull(); // Infinity serialized to null
  });

  it('switches to bundles and preserves accounts and employees when reducing seats', async () => {
    const r = await ctx.api.put('/_platform/api/tenants/subscriptionco/subscription').set(opHdr())
      .send({ ...settings, mode: 'bundle', bundle: 'operations', seat_limit: 1, bundle_price: 2000 });
    expect(r.status).toBe(200);
    expect(r.body.modules.override).toBeNull();
    expect(r.body.subscription.monthly_total).toBe(2050);
    expect(r.body.usage.employees).toBe(4);
    expect((await ctx.api.post('/api/hr/employees').set(tenantHeaders()).send({ employee_no: 'E5', name: 'Fifth' })).status).toBe(201);
    expect((await ctx.api.post('/api/users').set(tenantHeaders()).send({ username: 'fourth', full_name: 'Fourth', password: 'secret123' })).status).toBe(402);
    const blank = await ctx.api.put('/_platform/api/tenants/subscriptionco/subscription').set(opHdr())
      .send({ ...settings, module_prices: { hr: 0 }, seat_limit: null });
    expect(blank.body.subscription.monthly_total).toBeNull();
    expect((await ctx.api.post('/api/hr/employees').set(tenantHeaders()).send({ employee_no: 'E6', name: 'Sixth' })).status).toBe(201);
  });
});

describe('operator password', () => {
  const sessionOf = async (username: string, password: string) =>
    (await ctx.api.post('/_platform/api/login').send({ username, password })).body.token as string | undefined;
  const change = (tok: string, current_password: string, new_password: string) =>
    ctx.api.post('/_platform/api/password').set({ Authorization: `Bearer ${tok}` }).send({ current_password, new_password });

  it('changes your own password and signs out your other sessions', async () => {
    users.upsertPlatformUser('pwtest', 'pwtestpass1');
    const a = (await sessionOf('pwtest', 'pwtestpass1'))!;
    const b = (await sessionOf('pwtest', 'pwtestpass1'))!;
    expect((await change(a, 'wrong-current', 'Brand-new-pass-42')).status).toBe(400);
    expect((await change(a, 'pwtestpass1', 'short1')).body.error).toMatch(/at least 8/);
    expect((await change(a, 'pwtestpass1', 'Password1')).body.error).toMatch(/common/);
    expect((await change(a, 'pwtestpass1', 'Brand-new-pass-42')).status).toBe(200);
    expect((await ctx.api.get('/_platform/api/me').set({ Authorization: `Bearer ${a}` })).status).toBe(200);
    expect((await ctx.api.get('/_platform/api/me').set({ Authorization: `Bearer ${b}` })).status).toBe(401);
    expect(await sessionOf('pwtest', 'pwtestpass1')).toBeUndefined();
    expect(typeof await sessionOf('pwtest', 'Brand-new-pass-42')).toBe('string');
  });

  it('needs a session', async () => {
    expect((await ctx.api.post('/_platform/api/password').send({ current_password: 'x', new_password: 'y' })).status).toBe(401);
  });

  it('the env bootstrap no longer overwrites a changed password unless PLATFORM_ADMIN_RESET=true', async () => {
    const platform = await import('../src/platform/platform');
    const reopen = () => { platform._resetPlatformDb(); platform.platformDb(); };
    process.env.PLATFORM_ADMIN_USERNAME = 'pwtest';
    process.env.PLATFORM_ADMIN_PASSWORD = 'env-password-1';
    try {
      const live = (await sessionOf('pwtest', 'Brand-new-pass-42'))!;
      reopen();
      expect(await sessionOf('pwtest', 'env-password-1')).toBeUndefined();
      expect(typeof await sessionOf('pwtest', 'Brand-new-pass-42')).toBe('string');
      process.env.PLATFORM_ADMIN_RESET = 'true';
      reopen();
      expect(typeof await sessionOf('pwtest', 'env-password-1')).toBe('string');
      expect((await ctx.api.get('/_platform/api/me').set({ Authorization: `Bearer ${live}` })).status).toBe(401);
    } finally {
      delete process.env.PLATFORM_ADMIN_USERNAME;
      delete process.env.PLATFORM_ADMIN_PASSWORD;
      delete process.env.PLATFORM_ADMIN_RESET;
    }
  });
});
