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
  ctx = await setupApp();
  process.env.PUBLIC_APP_URL = 'https://app.example.test';
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
      .send({ username: 'emailu', full_name: 'Email User', password: 'secret123-test-only', email: 'e@u.test' });
    expect(c.status).toBe(201);
    const list = await ctx.api.get('/api/users').set(authHdr());
    expect(list.body.find((u: { username: string }) => u.username === 'emailu').email).toBe('e@u.test');

    const bad = await ctx.api.post('/api/users').set(authHdr())
      .send({ username: 'emailbad', full_name: 'x', password: 'secret123-test-only', email: 'not-an-email' });
    expect(bad.status).toBe(400);
  });
});

describe('POST /api/auth/forgot-password', () => {
  const resets = () => dbmod.queryOne<{ c: number }>('SELECT COUNT(*) AS c FROM password_resets')!.c;

  it('creates a reset link for a known email', async () => {
    const before = resets();
    const r = await ctx.api.post('/api/auth/forgot-password').send({ identifier: 'admin@acme.test' });
    expect(r.status).toBe(200);
    expect(resets()).toBe(before + 1);
  });

  it('answers exactly the same for a real account, an unknown one and one without email', async () => {
    await ctx.api.post('/api/users').set(authHdr()).send({ username: 'noemail', full_name: 'No Email', password: 'secret123-test-only' });
    const before = resets();
    const known = await ctx.api.post('/api/auth/forgot-password').send({ identifier: 'admin@acme.test' });
    const unknown = await ctx.api.post('/api/auth/forgot-password').send({ identifier: 'nobody@nowhere.test' });
    const noEmail = await ctx.api.post('/api/auth/forgot-password').send({ identifier: 'noemail' });
    for (const r of [known, unknown, noEmail]) expect(r.status).toBe(200);
    expect(unknown.body).toEqual(known.body);
    expect(noEmail.body).toEqual(known.body);
    expect(known.body).not.toHaveProperty('sent');
    expect(resets()).toBe(before + 1); // only the real account with an email got a link
  });
});

describe('POST /api/auth/reset-password', () => {
  it('accepts a valid token, changes the password, and kills sessions', async () => {
    const u = await ctx.api.post('/api/users').set(authHdr())
      .send({ username: 'resetme', full_name: 'Reset Me', password: 'oldpass1-test-only', email: 'r@m.test' });
    const uid = u.body.id;
    const rawToken = 'tok_' + 'a'.repeat(24);
    dbmod.run("INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now','+1 hour'))", sha256(rawToken), uid);

    const sess = await login(ctx.api, 'resetme', 'oldpass1-test-only'); // an existing session to be killed
    expect(sess).toBeTruthy();

    const r = await ctx.api.post('/api/auth/reset-password').send({ token: rawToken, new_password: 'brandnew1-test-only' });
    expect(r.status).toBe(200);

    expect((await ctx.api.post('/api/auth/login').send({ username: 'resetme', password: 'oldpass1-test-only' })).status).toBe(401);
    expect((await ctx.api.post('/api/auth/login').send({ username: 'resetme', password: 'brandnew1-test-only' })).status).toBe(200);
    // The pre-reset session is gone.
    expect((await ctx.api.get('/api/auth/me').set('Authorization', `Bearer ${sess}`)).status).toBe(401);
    // Token can't be reused.
    expect((await ctx.api.post('/api/auth/reset-password').send({ token: rawToken, new_password: 'again1234-test-only' })).status).toBe(400);
  });

  it('a reset also cancels the account\'s other outstanding links', async () => {
    const u = await ctx.api.post('/api/users').set(authHdr())
      .send({ username: 'twolinks', full_name: 'Two Links', password: 'oldpass12-test-only', email: 't@l.test' });
    const [a, b] = ['tok_first_' + 'b'.repeat(20), 'tok_second_' + 'c'.repeat(20)];
    for (const t of [a, b]) dbmod.run("INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now','+1 hour'))", sha256(t), u.body.id);
    expect((await ctx.api.post('/api/auth/reset-password').send({ token: a, new_password: 'firstnew99-test-only' })).status).toBe(200);
    expect((await ctx.api.post('/api/auth/reset-password').send({ token: b, new_password: 'secondnew99-test-only' })).status).toBe(400);
  });

  it('rejects a new password that is too short or too common', async () => {
    const rawToken = 'tok_policy_' + 'd'.repeat(20);
    dbmod.run("INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, 1, datetime('now','+1 hour'))", sha256(rawToken));
    expect((await ctx.api.post('/api/auth/reset-password').send({ token: rawToken, new_password: 'short7c' })).status).toBe(400);
    const common = await ctx.api.post('/api/auth/reset-password').send({ token: rawToken, new_password: 'PasswordPassword' });
    expect(common.status).toBe(400);
    expect(JSON.stringify(common.body)).toMatch(/most common passwords/);
  });

  it('400s a bogus or expired token', async () => {
    expect((await ctx.api.post('/api/auth/reset-password').send({ token: 'x'.repeat(20), new_password: 'whatever1-test-only' })).status).toBe(400);
    dbmod.run("INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, 1, datetime('now','-1 minute'))", sha256('expiredtok_xxxxxxxx'));
    expect((await ctx.api.post('/api/auth/reset-password').send({ token: 'expiredtok_xxxxxxxx', new_password: 'whatever1-test-only' })).status).toBe(400);
  });
});
