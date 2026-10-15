/** Password reset: users.email, forgot-password (no account leak), token-based reset. */
import crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, type TestContext } from './helpers';

let ctx: TestContext;
let token: string;
let dbmod: typeof import('../src/shared/db');
const authHdr = () => ({ Authorization: `Bearer ${token}` });
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

beforeAll(async () => {
  process.env.PUBLIC_APP_URL = 'https://office.example.test';
  ctx = await setupApp();
  token = await login(ctx.api);
  dbmod = await import('../src/shared/db');
  // Give the admin an email + turn on email (jsonTransport in test → sends succeed).
  await ctx.api.put('/api/users/1').set(authHdr()).send({ email: 'admin@acme.test' });
  await ctx.api.put('/api/mail/settings').set(authHdr()).send({
    transport: 'smtp', from_name: 'V', from_email: 'sys@acme.test',
    smtp_host: 'smtp.acme.test', smtp_port: 587, smtp_secure: false, smtp_user: 'sys@acme.test', smtp_pass: 'x',
  });
});
afterAll(() => { delete process.env.PUBLIC_APP_URL; cleanup(ctx); });

describe('users.email', () => {
  it('is stored on create/update and returned in the directory', async () => {
    const c = await ctx.api.post('/api/users').set(authHdr())
      .send({ username: 'emailu', full_name: 'Email User', password: 'secret1', email: 'e@u.test' });
    expect(c.status).toBe(201);
    const list = await ctx.api.get('/api/users').set(authHdr());
    expect(list.body.find((u: { username: string }) => u.username === 'emailu').email).toBe('e@u.test');

    const bad = await ctx.api.post('/api/users').set(authHdr())
      .send({ username: 'emailbad', full_name: 'x', password: 'secret1', email: 'not-an-email' });
    expect(bad.status).toBe(400);
  });
});

describe('POST /api/auth/forgot-password', () => {
  it('sends a link for a known email and creates a reset row', async () => {
    const before = dbmod.queryOne<{ c: number }>('SELECT COUNT(*) AS c FROM password_resets')!.c;
    const r = await ctx.api.post('/api/auth/forgot-password').send({ identifier: 'admin@acme.test' });
    expect(r.status).toBe(200);
    expect(r.body.message).toMatch(/eligible/);
    expect(r.body).not.toHaveProperty('sent');
    expect(dbmod.queryOne<{ c: number }>('SELECT COUNT(*) AS c FROM password_resets')!.c).toBe(before + 1);
  });

  it('still 200s for an unknown account, without sending', async () => {
    const r = await ctx.api.post('/api/auth/forgot-password').send({ identifier: 'nobody@nowhere.test' });
    expect(r.status).toBe(200);
    expect(r.body.message).toMatch(/eligible/);
    expect(r.body).not.toHaveProperty('sent');
  });

  it('reports when the account has no email on file', async () => {
    await ctx.api.post('/api/users').set(authHdr()).send({ username: 'noemail', full_name: 'No Email', password: 'secret1' });
    const r = await ctx.api.post('/api/auth/forgot-password').send({ identifier: 'noemail' });
    expect(r.body.message).toMatch(/eligible/);
    expect(r.body).not.toHaveProperty('sent');
    expect(r.body).not.toHaveProperty('reason');
  });
});

describe('POST /api/auth/reset-password', () => {
  it('accepts a valid token, changes the password, and kills sessions', async () => {
    const u = await ctx.api.post('/api/users').set(authHdr())
      .send({ username: 'resetme', full_name: 'Reset Me', password: 'oldpass1', email: 'r@m.test' });
    const uid = u.body.id;
    const rawToken = 'tok_' + 'a'.repeat(24);
    dbmod.run("INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now','+1 hour'))", sha256(rawToken), uid);

    const sess = await login(ctx.api, 'resetme', 'oldpass1'); // an existing session to be killed
    expect(sess).toBeTruthy();

    const r = await ctx.api.post('/api/auth/reset-password').send({ token: rawToken, new_password: 'brandnew1' });
    expect(r.status).toBe(200);

    expect((await ctx.api.post('/api/auth/login').send({ username: 'resetme', password: 'oldpass1' })).status).toBe(401);
    expect((await ctx.api.post('/api/auth/login').send({ username: 'resetme', password: 'brandnew1' })).status).toBe(200);
    // The pre-reset session is gone.
    expect((await ctx.api.get('/api/auth/me').set('Authorization', `Bearer ${sess}`)).status).toBe(401);
    // Token can't be reused.
    expect((await ctx.api.post('/api/auth/reset-password').send({ token: rawToken, new_password: 'again1234' })).status).toBe(400);
  });

  it('400s a bogus or expired token', async () => {
    expect((await ctx.api.post('/api/auth/reset-password').send({ token: 'x'.repeat(20), new_password: 'whatever1' })).status).toBe(400);
    dbmod.run("INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, 1, datetime('now','-1 minute'))", sha256('expiredtok_xxxxxxxx'));
    expect((await ctx.api.post('/api/auth/reset-password').send({ token: 'expiredtok_xxxxxxxx', new_password: 'whatever1' })).status).toBe(400);
  });
});

it('limits recovery per account, expires within 15 minutes, and invalidates prior links', async () => {
  const account = await ctx.api.post('/api/users').set(authHdr()).send({ username: 'reset-limited', full_name: 'Limited', password: 'secret123', email: 'limited@example.test' });
  for (let i = 0; i < 5; i++) {
    const result = await ctx.api.post('/api/auth/forgot-password').send({ identifier: i % 2 ? 'reset-limited' : 'limited@example.test' });
    expect(result.status).toBe(200);
    expect(result.body).not.toHaveProperty('sent');
  }
  const rows = dbmod.queryAll<{ used: number; lifetime: number }>(
    'SELECT used, (julianday(expires_at)-julianday(created_at))*1440 AS lifetime FROM password_resets WHERE user_id = ?', account.body.id
  );
  expect(rows).toHaveLength(3);
  expect(rows.filter(row => row.used === 0)).toHaveLength(1);
  expect(rows.every(row => Math.abs(row.lifetime - 15) < 0.001)).toBe(true);
});
