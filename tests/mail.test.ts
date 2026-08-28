/** Email (BYO SMTP): secret encryption, settings config + masking, send + log,
    RBAC, validation, and the send_email AI tool. Uses nodemailer's jsonTransport
    in test mode — nothing is actually delivered. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';
import type { AuthUser } from '../src/types';

let ctx: TestContext;
let token: string;
let mailTool: typeof import('../src/ai-mail');
let encryptSecret: typeof import('../src/secrets').encryptSecret;
let decryptSecret: typeof import('../src/secrets').decryptSecret;

const authHdr = () => ({ Authorization: `Bearer ${token}` });
const user = (perms: string[]): AuthUser => ({
  id: 1, username: 'admin', full_name: 'Admin', role: 'admin',
  department_id: null, active: 1, department_name: null, permissions: perms as never,
});

const SMTP = {
  transport: 'smtp', from_name: 'Verdesakay', from_email: 'office@acme.test',
  smtp_host: 'smtp.acme.test', smtp_port: 587, smtp_secure: false, smtp_user: 'office@acme.test',
};

beforeAll(async () => {
  ctx = await setupApp();
  token = await login(ctx.api);
  mailTool = await import('../src/ai-mail');
  ({ encryptSecret, decryptSecret } = await import('../src/secrets'));
});
afterAll(() => cleanup(ctx));

describe('secrets: encrypt / decrypt', () => {
  it('round-trips and rejects tampering', () => {
    const enc = encryptSecret('hunter2-app-password');
    expect(enc).toMatch(/^v1:/);
    expect(enc).not.toContain('hunter2');
    expect(decryptSecret(enc)).toBe('hunter2-app-password');
    expect(decryptSecret(enc.slice(0, -4) + 'AAAA')).toBe('');
    expect(decryptSecret('')).toBe('');
    expect(encryptSecret('')).toBe('');
  });
});

describe('mail settings', () => {
  it('starts off, never returns the password, and needs host+from for SMTP', async () => {
    const g = await ctx.api.get('/api/mail/settings').set(authHdr());
    expect(g.status).toBe(200);
    expect(g.body.transport).toBe('off');
    expect(g.body.ready).toBe(false);
    expect(g.body.has_password).toBe(false);
    expect(g.body).not.toHaveProperty('smtp_pass');

    const bad = await ctx.api.put('/api/mail/settings').set(authHdr()).send({ transport: 'smtp', from_email: 'x@y.test' });
    expect(bad.status).toBe(400);
  });

  it('saves, keeps the password on a passwordless update, and clears it on empty', async () => {
    let r = await ctx.api.put('/api/mail/settings').set(authHdr()).send({ ...SMTP, smtp_pass: 'app-pw-1' });
    expect(r.status).toBe(200);
    expect(r.body.ready).toBe(true);

    let g = await ctx.api.get('/api/mail/settings').set(authHdr());
    expect(g.body.has_password).toBe(true);
    expect(g.body).not.toHaveProperty('smtp_pass');

    // update without smtp_pass → keep it
    await ctx.api.put('/api/mail/settings').set(authHdr()).send({ ...SMTP, from_name: 'Renamed' });
    g = await ctx.api.get('/api/mail/settings').set(authHdr());
    expect(g.body.has_password).toBe(true);
    expect(g.body.from_name).toBe('Renamed');

    // explicit empty string → clear it
    await ctx.api.put('/api/mail/settings').set(authHdr()).send({ ...SMTP, smtp_pass: '' });
    g = await ctx.api.get('/api/mail/settings').set(authHdr());
    expect(g.body.has_password).toBe(false);
  });

  it('config endpoints require users.manage', async () => {
    const warehouse = await createEmployee(ctx.api, token, { role: 'warehouse'});
    const r = await ctx.api.get('/api/mail/settings').set('Authorization', `Bearer ${warehouse.token}`);
    expect(r.status).toBe(403);
  });
});

describe('mail send + log', () => {
  it('sends when configured and records a "sent" log row', async () => {
    await ctx.api.put('/api/mail/settings').set(authHdr()).send({ ...SMTP, smtp_pass: 'app-pw' });

    const r = await ctx.api.post('/api/mail/send').set(authHdr())
      .send({ to: 'client@example.com', subject: 'Your order', body: 'Thanks for your order.' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.id).toBeTruthy();

    const log = await ctx.api.get('/api/mail/log').set(authHdr());
    const row = log.body[0];
    expect(row.to_addr).toBe('client@example.com');
    expect(row.status).toBe('sent');
    expect(row.sent_by_name).toBeTruthy();
  });

  it('fails cleanly when email is off and logs "failed"', async () => {
    await ctx.api.put('/api/mail/settings').set(authHdr()).send({ transport: 'off' });
    const r = await ctx.api.post('/api/mail/send').set(authHdr())
      .send({ to: 'x@example.com', subject: 'Nope', body: 'body' });
    expect(r.status).toBe(400);
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toMatch(/not configured/i);

    const log = await ctx.api.get('/api/mail/log').set(authHdr());
    expect(log.body[0].status).toBe('failed');
  });

  it('validates the recipient and gates on mail.send', async () => {
    await ctx.api.put('/api/mail/settings').set(authHdr()).send({ ...SMTP, smtp_pass: 'x' });

    expect((await ctx.api.post('/api/mail/send').set(authHdr()).send({ to: 'not-an-email', subject: 's', body: 'b' })).status).toBe(400);

    const hr = await createEmployee(ctx.api, token, { role: 'hr'}); // no mail.send
    const r = await ctx.api.post('/api/mail/send').set('Authorization', `Bearer ${hr.token}`)
      .send({ to: 'a@b.test', subject: 's', body: 'b' });
    expect(r.status).toBe(403);
  });

  it('POST /api/mail/test verifies + sends a test', async () => {
    await ctx.api.put('/api/mail/settings').set(authHdr()).send({ ...SMTP, smtp_pass: 'x' });
    const r = await ctx.api.post('/api/mail/test').set(authHdr()).send({ to: 'admin@acme.test' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });
});

describe('send_email AI tool', () => {
  it('is offered only with mail.send and sends via the mailer', async () => {
    await ctx.api.put('/api/mail/settings').set(authHdr()).send({ ...SMTP, smtp_pass: 'x' });

    expect(mailTool.mailToolsForUser(user(['mail.send'])).length).toBe(1);
    expect(mailTool.mailToolsForUser(user(['inventory.view'])).length).toBe(0);

    const ok = await mailTool.executeMailTool('send_email',
      { to: 'ceo@example.com', subject: 'Weekly numbers', body: 'See attached summary.' }, user(['mail.send']));
    expect(ok).toMatchObject({ success: true, data: { sent: true, to: 'ceo@example.com' } });

    const denied = await mailTool.executeMailTool('send_email',
      { to: 'a@b.test', subject: 's', body: 'b' }, user(['inventory.view']));
    expect(denied).toMatchObject({ success: false, error: 'Permission denied.' });

    const badAddr = await mailTool.executeMailTool('send_email',
      { to: 'nope', subject: 's', body: 'b' }, user(['mail.send']));
    expect(badAddr.success).toBe(false);
  });
});
