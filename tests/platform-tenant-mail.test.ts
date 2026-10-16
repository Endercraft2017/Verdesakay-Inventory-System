/** Operator-assisted SMTP uses the target tenant, not the platform mailbox or default DB. */
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { setupApp, cleanup, login, type TestContext } from './helpers';
let ctx: TestContext;
let op: string;
let tenantToken: string;
const auth = () => ({ Authorization: `Bearer ${op}` });
const endpoint = '/_platform/api/tenants/smtpco/mail';
const SMTP = { transport: 'smtp', from_email: 'office@example.test', smtp_host: 'smtp.example.test', smtp_port: 587, smtp_user: 'office@example.test', smtp_pass: 'smtp-secret' };
beforeAll(async () => {
  process.env.PLATFORM_CONSOLE = 'true';
  ctx = await setupApp();
  tenantToken = await login(ctx.api);
  const users = await import('../src/platform/platform-users');
  users.upsertPlatformUser('owner', 'ownerpass1-test-only');
  op = (await ctx.api.post('/_platform/api/login').send({ username: 'owner', password: 'ownerpass1-test-only' })).body.token;
  const { createTenant } = await import('../src/platform/provisioning');
  for (const slug of ['smtpco', 'smtpother']) createTenant({ slug, name: slug, admin_username: 'owner', admin_password: 'ownerpass1-test-only', admin_email: `${slug}@example.test`, plan: 'complete' });
});
afterAll(() => { delete process.env.PLATFORM_CONSOLE; delete process.env.PLATFORM_HOST; delete process.env.TENANT_PATH_HOST; cleanup(ctx); });

describe('operator SMTP configuration', () => {
  it('isolates and encrypts credentials and audits the operator without secrets', async () => {
    expect((await ctx.api.put(endpoint).set(auth()).send(SMTP)).status).toBe(200);
    const saved = (await ctx.api.get(endpoint).set(auth())).body;
    expect(saved).toMatchObject({ ready: true, has_password: true, smtp_host: SMTP.smtp_host });
    expect(saved).not.toHaveProperty('smtp_pass');
    const db = await import('../src/shared/db');
    expect(db.withTenant('smtpco', () => db.getSetting<string>('mail_smtp_pass'))).not.toContain('smtp-secret');
    expect(db.getSetting('mail_settings')).toBeUndefined();
    expect((await ctx.api.get(endpoint.replace('smtpco', 'smtpother')).set(auth())).body.has_password).toBe(false);
    const platformMail = await import('../src/platform/platform-mail');
    expect(platformMail.getPlatformMail().transport).toBe('off');
    const { listProvisioningLog } = await import('../src/platform/platform');
    expect(listProvisioningLog('smtpco')[0]).toMatchObject({ action: 'email-settings' });
    expect(JSON.stringify(listProvisioningLog('smtpco'))).not.toContain('smtp-secret');
  });
  it('preserves omitted passwords, clears explicitly, and rejects invalid settings', async () => {
    const { smtp_pass, ...settings } = SMTP;
    await ctx.api.put(endpoint).set(auth()).send(settings);
    expect((await ctx.api.get(endpoint).set(auth())).body.has_password).toBe(true);
    for (const patch of [{ smtp_port: 70000 }, { smtp_host: '' }, { from_email: 'bad' }]) {
      expect((await ctx.api.put(endpoint).set(auth()).send({ ...settings, ...patch })).status).toBe(400);
    }
    await ctx.api.put(endpoint).set(auth()).send({ ...settings, smtp_pass: '' });
    expect((await ctx.api.get(endpoint).set(auth())).body.has_password).toBe(false);
  });
  it('logs tests in the chosen tenant without attributing the operator to a tenant user', async () => {
    await ctx.api.put(endpoint).set(auth()).send(SMTP);
    expect((await ctx.api.post(endpoint + '/test').set(auth()).send({ to: 'bad' })).status).toBe(400);
    expect((await ctx.api.post(endpoint + '/test').set(auth()).send({ to: 'test@example.test' })).status).toBe(200);
    const db = await import('../src/shared/db');
    expect(db.withTenant('smtpco', () => db.queryAll('SELECT sent_by, status FROM mail_log'))).toEqual([{ sent_by: null, status: 'sent' }]);
    expect(db.withTenant('smtpother', () => db.queryAll('SELECT * FROM mail_log'))).toEqual([]);
    await ctx.api.put(endpoint).set(auth()).send({ transport: 'off' });
    expect((await ctx.api.post(endpoint + '/test').set(auth()).send({ to: 'test@example.test' })).status).toBe(400);
  });
  it('rejects tenant sessions, tenant hosts, unknown and purged workspaces', async () => {
    for (const method of ['get', 'put', 'post'] as const) {
      const url = method === 'post' ? endpoint + '/test' : endpoint;
      expect((await ctx.api[method](url)).status).toBe(401);
      expect((await ctx.api[method](url).set({ Authorization: `Bearer ${tenantToken}` })).status).toBe(401);
      expect((await ctx.api[method](url).set(auth()).set('X-Tenant', 'smtpco')).status).toBe(404);
      expect((await ctx.api[method](url.replace('smtpco', 'missing')).set(auth())).status).toBe(404);
    }
    const { setTenantStatus } = await import('../src/platform/platform');
    setTenantStatus('smtpother', 'purged');
    expect((await ctx.api.get(endpoint.replace('smtpco', 'smtpother')).set(auth())).status).toBe(404);
  });
  it('serves the guide on tenant paths and dedicated console hosts', async () => {
    process.env.TENANT_PATH_HOST = 'app.example.test';
    const guide = await ctx.api.get('/email-setup.html').set('Host', 'app.example.test');
    expect(guide.status).toBe(200);
    expect(guide.text).toContain('Configure and test');
    const scoped = await ctx.api.get('/smtpco/email-setup.html').set('Host', 'app.example.test');
    expect(scoped.status).toBe(200);
    expect(scoped.text).toContain('Configure and test');
    process.env.PLATFORM_HOST = 'console.example.test';
    const consoleGuide = await ctx.api.get('/_platform/email-setup.html').set('Host', 'console.example.test');
    expect(consoleGuide.status).toBe(200);
    expect(consoleGuide.text).toContain('Configure and test');
    expect((await ctx.api.get('/_platform/api/me').set(auth()).set('Host', 'console.example.test')).status).toBe(200);
    delete process.env.PLATFORM_HOST; delete process.env.TENANT_PATH_HOST;
  });
});
