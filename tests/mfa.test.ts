/** Two-step sign-in (src/shared/mfa.ts, src/shared/totp.ts) and hashed session tokens. */
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { setupApp, cleanup, login, type TestContext } from './helpers';
import { totpCode, totpCounter } from '../src/shared/totp';

let ctx: TestContext;
let admin: string;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
let db: typeof import('../src/shared/db');

beforeAll(async () => {
  ctx = await setupApp();
  admin = await login(ctx.api);
  db = await import('../src/shared/db');
});
afterAll(() => cleanup(ctx));

/** Create an account and turn two-step sign-in on for it; returns its secret + recovery codes. */
async function enrol(username: string, password: string, role = 'admin') {
  await ctx.api.post('/api/users').set(bearer(admin)).send({ username, full_name: username, password, role });
  const token = await login(ctx.api, username, password);
  expect((await ctx.api.post('/api/auth/mfa/setup').set(bearer(token)).send({ password: 'wrong-password' })).status).toBe(400);
  const setup = await ctx.api.post('/api/auth/mfa/setup').set(bearer(token)).send({ password });
  expect(setup.body.otpauth_url).toMatch(/^otpauth:\/\/totp\//);
  expect((await ctx.api.post('/api/auth/mfa/enable').set(bearer(token)).send({ code: '000000' })).status).toBe(400);
  // Use the previous step so the sign-in test below can use the current one (each step only once).
  const enable = await ctx.api.post('/api/auth/mfa/enable').set(bearer(token))
    .send({ code: totpCode(setup.body.secret, totpCounter() - 1) });
  expect(enable.status).toBe(200);
  expect(enable.body.recovery_codes).toHaveLength(10);
  return { secret: setup.body.secret as string, recovery: enable.body.recovery_codes as string[], token };
}

describe('two-step sign-in', () => {
  it('asks for the code after the password, and each code works once', async () => {
    const { secret } = await enrol('mfa-alice', 'alice-pass-123');
    const first = await ctx.api.post('/api/auth/login').send({ username: 'mfa-alice', password: 'alice-pass-123' });
    expect(first.body.mfa_required).toBe(true);
    expect(first.body.token).toBeUndefined();
    expect((await ctx.api.post('/api/auth/login/mfa').send({ mfa_token: first.body.mfa_token, code: '123456' })).status).toBe(401);
    const code = totpCode(secret, totpCounter());
    const ok = await ctx.api.post('/api/auth/login/mfa').send({ mfa_token: first.body.mfa_token, code });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBeTruthy();
    // The same code can't sign in again (replay), even with a fresh password step.
    const again = await ctx.api.post('/api/auth/login').send({ username: 'mfa-alice', password: 'alice-pass-123' });
    expect((await ctx.api.post('/api/auth/login/mfa').send({ mfa_token: again.body.mfa_token, code })).status).toBe(401);
  });

  it('accepts a recovery code once, and stops a challenge after five wrong codes', async () => {
    const { recovery } = await enrol('mfa-bob', 'bob-pass-1234');
    const step = await ctx.api.post('/api/auth/login').send({ username: 'mfa-bob', password: 'bob-pass-1234' });
    expect((await ctx.api.post('/api/auth/login/mfa').send({ mfa_token: step.body.mfa_token, code: recovery[0] })).status).toBe(200);
    const step2 = await ctx.api.post('/api/auth/login').send({ username: 'mfa-bob', password: 'bob-pass-1234' });
    expect((await ctx.api.post('/api/auth/login/mfa').send({ mfa_token: step2.body.mfa_token, code: recovery[0] })).status).toBe(401);
    for (let i = 0; i < 4; i++) {
      await ctx.api.post('/api/auth/login/mfa').send({ mfa_token: step2.body.mfa_token, code: '000000' });
    }
    // Five failures used up this challenge: even a valid recovery code is refused now.
    const locked = await ctx.api.post('/api/auth/login/mfa').send({ mfa_token: step2.body.mfa_token, code: recovery[1] });
    expect(locked.status).toBe(401);
    expect(locked.body.error).toMatch(/expired/);
  });

  it('can be required for privileged accounts, but only by someone who uses it', async () => {
    expect((await ctx.api.put('/api/users/security-policy').set(bearer(admin)).send({ require_mfa_privileged: true })).status).toBe(409);
    const { token: carolToken } = await enrol('mfa-carol', 'carol-pass-123');
    // carol (admin, enrolled) switches the requirement on.
    expect((await ctx.api.put('/api/users/security-policy').set(bearer(carolToken)).send({ require_mfa_privileged: true })).status).toBe(200);
    // The seeded admin (no two-step yet) can only reach the set-up screens now.
    const me = await ctx.api.get('/api/auth/me').set(bearer(admin));
    expect(me.body.user.mfa_setup_required).toBe(true);
    const blocked = await ctx.api.get('/api/inventory').set(bearer(admin));
    expect(blocked.status).toBe(403);
    expect(blocked.body.mfa_setup_required).toBe(true);
    // A plain staff account isn't affected.
    await ctx.api.post('/api/users').set(bearer(carolToken)).send({ username: 'mfa-staff', full_name: 'Staff', password: 'staff-pass-12', role: 'admin_staff' });
    const staff = await login(ctx.api, 'mfa-staff', 'staff-pass-12');
    expect((await ctx.api.get('/api/auth/me').set(bearer(staff))).body.user.mfa_setup_required).toBe(false);
    // While required, carol can't switch hers off.
    expect((await ctx.api.post('/api/auth/mfa/disable').set(bearer(carolToken)).send({ password: 'carol-pass-123', code: '000000' })).status).toBe(403);
    // Back off for the remaining tests.
    expect((await ctx.api.put('/api/users/security-policy').set(bearer(carolToken)).send({ require_mfa_privileged: false })).status).toBe(200);
    expect((await ctx.api.get('/api/inventory').set(bearer(admin))).status).toBe(200);
  });

  it('refuses the old session-only authenticator bypass', async () => {
    await enrol('mfa-dan', 'dan-pass-1234');
    const users = await ctx.api.get('/api/users').set(bearer(admin));
    const dan = users.body.find((u: { username: string }) => u.username === 'mfa-dan');
    expect(dan.mfa_enabled).toBe(true);
    expect((await ctx.api.post(`/api/users/${dan.id}/mfa/reset`).set(bearer(admin)).send({})).status).toBe(400);
    const back = await ctx.api.post('/api/auth/login').send({ username: 'mfa-dan', password: 'dan-pass-1234' });
    expect(back.body.token).toBeUndefined();
    expect(back.body.mfa_required).toBe(true); // no session-only bypass
  });
});

describe('hashed session tokens', () => {
  it('stores only a digest, and upgrades a token stored before hashing', async () => {
    const token = await login(ctx.api);
    expect(db.queryOne('SELECT 1 AS x FROM sessions WHERE token = ?', token)).toBeUndefined();
    expect(db.queryOne('SELECT 1 AS x FROM sessions WHERE token = ?', db.tokenDigest(token))).toBeTruthy();
    // A pre-upgrade row (raw token) keeps working after the one-time conversion.
    const legacy = 'legacy-raw-token-' + 'f'.repeat(40);
    db.run("INSERT INTO sessions (token, sid, user_id, expires_at) VALUES (?, 'sid-legacy', 1, datetime('now', '+1 hour'))", legacy);
    db.hashLegacySessionTokens(db.activeDb());
    expect((await ctx.api.get('/api/auth/me').set(bearer(legacy))).status).toBe(200);
    // The stored digest itself is useless as a bearer token.
    expect((await ctx.api.get('/api/auth/me').set(bearer(db.tokenDigest(legacy)))).status).toBe(401);
  });
});

it('shares the security verification failure budget across sessions and factor endpoints', async () => {
  const password = randomUUID();
  const { token, recovery } = await enrol('mfa-throttle', password);
  const challenge = await ctx.api.post('/api/auth/login').send({ username: 'mfa-throttle', password });
  const other = await ctx.api.post('/api/auth/login/mfa').send({ mfa_token: challenge.body.mfa_token, code: recovery[0] });
  expect(other.status).toBe(200);
  // enrol() already made two failed verifications for this account.
  for (let i = 0; i < 8; i++) {
    const endpoint = i % 2 ? 'disable' : 'recovery-codes';
    const session = i % 2 ? token : other.body.token;
    expect((await ctx.api.post(`/api/auth/mfa/${endpoint}`).set(bearer(session))
      .send({ password: 'wrong-password', code: '000000' })).status).toBe(400);
  }
  const blocked = await ctx.api.post('/api/auth/mfa/recovery-codes').set(bearer(other.body.token))
    .send({ password, code: recovery[1] });
  expect(blocked.status).toBe(429);
  expect(blocked.headers['retry-after']).toBeTruthy();
  // Blocking happens before any factor is consumed or changed.
  const { checkMfaCode } = await import('../src/shared/mfa');
  expect(checkMfaCode(db.queryOne<{ id: number }>('SELECT id FROM users WHERE username = ?', 'mfa-throttle')!.id, recovery[1]!)).toBe(true);
});

it('requires an existing factor to disable MFA and revokes other sessions after success', async () => {
  const password = randomUUID();
  const { token, recovery } = await enrol('mfa-disable', password);
  const challenge = await ctx.api.post('/api/auth/login').send({ username: 'mfa-disable', password });
  const other = await ctx.api.post('/api/auth/login/mfa').send({ mfa_token: challenge.body.mfa_token, code: recovery[0] });
  expect(other.status).toBe(200);
  expect((await ctx.api.post('/api/auth/mfa/disable').set(bearer(token)).send({ password, code: 'invalid-code' })).status).toBe(400);
  expect((await ctx.api.get('/api/auth/me').set(bearer(other.body.token))).status).toBe(200);
  expect((await ctx.api.post('/api/auth/mfa/disable').set(bearer(token)).send({ password, code: recovery[1] })).status).toBe(200);
  expect((await ctx.api.get('/api/auth/me').set(bearer(other.body.token))).status).toBe(401);
  expect((await ctx.api.get('/api/auth/me').set(bearer(token))).status).toBe(200);
});


it('binds pending enrollment to its session, limits guesses and expires setup', async () => {
  await ctx.api.post('/api/users').set(bearer(admin)).send({ username: 'enroll-bound', full_name: 'Enrollment boundary', password: 'enroll-test-password', role: 'warehouse' });
  const first = await login(ctx.api, 'enroll-bound', 'enroll-test-password');
  const second = await login(ctx.api, 'enroll-bound', 'enroll-test-password');
  const start = () => ctx.api.post('/api/auth/mfa/setup').set(bearer(first)).send({ password: 'enroll-test-password' });
  const setup = await start(); expect(setup.status).toBe(200);
  const code = totpCode(setup.body.secret, totpCounter());
  expect((await ctx.api.post('/api/auth/mfa/enable').set(bearer(second)).send({ code })).status).toBe(400);
  const user = db.queryOne<{id:number}>('SELECT id FROM users WHERE username = ?', 'enroll-bound')!;
  db.run("UPDATE mfa_enrollments SET expires_at = datetime('now', '-1 minute') WHERE user_id = ?", user.id);
  expect((await ctx.api.post('/api/auth/mfa/enable').set(bearer(first)).send({ code })).status).toBe(400);
  const restarted = await start(); expect(restarted.status).toBe(200);
  db.run('UPDATE mfa_enrollments SET attempts = 5 WHERE user_id = ?', user.id);
  expect((await ctx.api.post('/api/auth/mfa/enable').set(bearer(first)).send({ code: totpCode(restarted.body.secret, totpCounter()) })).status).toBe(400);
  const { isNodeLocalTable } = await import('../src/sync/node');
  expect(isNodeLocalTable('mfa_enrollments')).toBe(true);
  expect(isNodeLocalTable('ai_tool_audit')).toBe(true);
});
