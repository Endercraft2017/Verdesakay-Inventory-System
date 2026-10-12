/** The platform mailbox (src/platform/platform-mail.ts): owner alerts for website inquiries,
    reported payments and sign-ups, configured in the owner console. In tests nothing leaves the
    machine — sends land in `_testOutbox` and the send log. */
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { setupApp, cleanup, type TestContext } from './helpers';

let ctx: TestContext;
let mail: typeof import('../src/platform/platform-mail');
const host = 'otom.afkcube.com';
let op = '';
const opHdr = () => ({ Authorization: `Bearer ${op}`, Host: host });
const tick = () => new Promise((r) => setTimeout(r, 20));
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const inquiry = { name: 'Ana Cruz', company: 'Cruz Foods', email: 'ana@cruz.test', employees: '21-50', modules: ['hr'], message: 'Payroll for 40 staff' };

beforeAll(async () => {
  process.env.TENANT_PATH_HOST = host;
  process.env.PLATFORM_CONSOLE = 'true';
  process.env.PLATFORM_HOST = host;
  process.env.SIGNUPS_OPEN = 'true';
  ctx = await setupApp();
  mail = await import('../src/platform/platform-mail');
  const users = await import('../src/platform/platform-users');
  users.upsertPlatformUser('boss', 'bosspass1', 'Owner');
  op = (await ctx.api.post('/_platform/api/login').set('Host', host).send({ username: 'boss', password: 'bosspass1' })).body.token;
});
afterAll(() => {
  for (const key of ['TENANT_PATH_HOST', 'PLATFORM_CONSOLE', 'PLATFORM_HOST', 'SIGNUPS_OPEN']) delete process.env[key];
  cleanup(ctx);
});

describe('while email is off', () => {
  it('inquiries still work and nothing is sent', async () => {
    expect((await ctx.api.post('/site/inquiry').set('Host', host).send(inquiry)).status).toBe(201);
    await tick();
    expect(mail._testOutbox).toHaveLength(0);
    const t = await ctx.api.post('/_platform/api/mail/test').set(opHdr()).send({ to: 'me@example.test' });
    expect(t.status).toBe(502);
    expect(t.body.error).toBe('Email is off.');
  });
});

describe('settings', () => {
  it('validate, and the secret is stored but never returned', async () => {
    for (const bad of [{ transport: 'pigeon' }, { from_email: 'nope' }, { alert_to: 'a@b.test, nope' }, { smtp_port: 99999 }]) {
      expect((await ctx.api.put('/_platform/api/mail').set(opHdr()).send(bad)).status).toBe(400);
    }
    const r = await ctx.api.put('/_platform/api/mail').set(opHdr()).send({
      transport: 'brevo', from_name: 'OTOM', from_email: 'alerts@otom.test', alert_to: 'owner@otom.test, partner@otom.test', secret: 'xkeysib-secret',
    });
    expect(r.status).toBe(200);
    expect(r.body.settings).toMatchObject({ transport: 'brevo', has_secret: true, alert_to: 'owner@otom.test, partner@otom.test' });
    expect(JSON.stringify(r.body)).not.toContain('xkeysib-secret');
    // saving again without a secret keeps the saved one
    const again = await ctx.api.put('/_platform/api/mail').set(opHdr()).send({ from_name: 'OTOM Alerts' });
    expect(again.body.settings.has_secret).toBe(true);
    expect((await ctx.api.get('/_platform/api/mail').set('Host', host)).status).toBe(401);
  });

  it('a test email goes to the alert recipients and is logged', async () => {
    const r = await ctx.api.post('/_platform/api/mail/test').set(opHdr()).send({});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(mail._testOutbox.at(-1)).toMatchObject({ to: ['owner@otom.test', 'partner@otom.test'], subject: 'OTOM test email' });
    expect(r.body.log[0]).toMatchObject({ status: 'sent', kind: 'test' });
  });
});

describe('owner alerts', () => {
  it('a website inquiry emails the owner', async () => {
    const before = mail._testOutbox.length;
    await ctx.api.post('/site/inquiry').set('Host', host).send(inquiry);
    await tick();
    const m = mail._testOutbox.at(-1)!;
    expect(mail._testOutbox.length).toBe(before + 1);
    expect(m.subject).toBe('New inquiry: Cruz Foods');
    expect(m.text).toContain('ana@cruz.test');
    expect(m.text).toContain('Payroll for 40 staff');
    expect(m.text).toContain('https://otom.afkcube.com/_platform/');
  });

  it('a self-serve sign-up and its reported payment email the owner', async () => {
    await ctx.api.put('/_platform/api/billing/settings').set(opHdr()).send({ module_prices: { hr: 3000 }, seat_price: 100, gcash_number: '09171234567' });
    const s = await ctx.api.post('/api/signup').set('Host', host).send({ slug: 'cruzfoods', company_name: 'Cruz Foods', admin_username: 'owner', admin_password: 'secret123', admin_email: 'ana@cruz.test', seats: 2, modules: ['hr'] });
    expect(s.status, JSON.stringify(s.body)).toBe(201);
    await tick();
    expect(mail._testOutbox.at(-1)!.subject).toBe('New sign-up: Cruz Foods');

    const login = await ctx.api.post('/cruzfoods/api/auth/login').set('Host', host).send({ username: 'owner', password: 'secret123' });
    const h = { Host: host, Authorization: `Bearer ${login.body.token}` };
    const inv = (await ctx.api.get('/cruzfoods/api/tenant/billing').set(h)).body.invoices[0];
    const rep = await ctx.api.post(`/cruzfoods/api/tenant/billing/invoices/${inv.id}/payments`).set(h)
      .field('channel', 'gcash').field('reference_no', '5012345678901').field('amount', '3200').field('paid_on', new Date().toISOString().slice(0, 10))
      .attach('proof', PNG, { filename: 'g.png', contentType: 'image/png' });
    expect(rep.status, JSON.stringify(rep.body)).toBe(201);
    await tick();
    const m = mail._testOutbox.at(-1)!;
    expect(m.subject).toBe(`Payment to check: cruzfoods ${inv.reference}`);
    expect(m.text).toContain('GCash');
    expect(m.text).toContain('5012345678901');
  });

  it('a switched-off alert sends nothing', async () => {
    await ctx.api.put('/_platform/api/mail').set(opHdr()).send({ alert_inquiry: false });
    const before = mail._testOutbox.length;
    await ctx.api.post('/site/inquiry').set('Host', host).send(inquiry);
    await tick();
    expect(mail._testOutbox.length).toBe(before);
  });
});
