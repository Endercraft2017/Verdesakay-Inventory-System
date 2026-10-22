import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { setupApp, cleanup, login, type TestContext } from './helpers';
import { totpCode, totpCounter } from '../src/shared/totp';
const mail = vi.hoisted(() => ({ send: vi.fn(async (_args: any, _id?: number) => ({ ok: true })), ready: true }));
vi.mock('../src/shared/mailer', async original => ({ ...await original<typeof import('../src/shared/mailer')>(), mailReady: () => mail.ready, sendMail: mail.send }));
let ctx: TestContext, db: typeof import('../src/shared/db'), admin: string;
const h = (token: string) => ({ Authorization: `Bearer ${token}` });
const saved = { PUBLIC_APP_URL: process.env.PUBLIC_APP_URL, PLATFORM_CONSOLE: process.env.PLATFORM_CONSOLE, TENANT_PATH_HOST: process.env.TENANT_PATH_HOST };
beforeAll(async () => {
  process.env.PUBLIC_APP_URL = 'https://app.example.test'; process.env.PLATFORM_CONSOLE = 'true';
  process.env.TENANT_PATH_HOST = 'app.example.test';
  ctx = await setupApp(); db = await import('../src/shared/db'); admin = await login(ctx.api);
});
afterAll(() => { cleanup(ctx); for (const [key,value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
async function account() {
  const username = 'recover-' + randomUUID().slice(0,8), password = randomUUID();
  const create = await ctx.api.post('/api/users').set(h(admin)).send({ username, password, full_name: username, role: 'admin' });
  expect(create.status).toBe(201);
  const id = create.body.id as number;
  db.run('UPDATE users SET email=? WHERE id=?', username + '@example.test', id);
  const token = await login(ctx.api, username, password);
  const setup = await ctx.api.post('/api/auth/mfa/setup').set(h(token)).send({ password });
  const enable = await ctx.api.post('/api/auth/mfa/enable').set(h(token)).send({ code: totpCode(setup.body.secret, totpCounter()-1) });
  expect(enable.status).toBe(200);
  return { id, username, password, token, codes: enable.body.recovery_codes as string[] };
}
function latestToken() {
  const text = mail.send.mock.calls.at(-1)![0].text as string;
  return text.match(/\?reset=([a-f0-9]{64})/)![1]!;
}
const evidence = { reason: 'Lost authenticator verified by callback to established company contact', verification_reference: 'SUPPORT-RECOVERY-123' };

it('requires fresh existing-factor proof, preserves MFA until claim, then restricts access until enrollment', async () => {
  const approver = await account(), target = await account();
  const path = `/api/users/${target.id}/mfa/reset`;
  expect((await ctx.api.post(path).set(h(approver.token)).send({})).status).toBe(400);
  expect((await ctx.api.post(path).set(h(approver.token)).send({ ...evidence, current_password: 'wrong', code: approver.codes[0] })).status).toBe(403);
  const issue = await ctx.api.post(path).set(h(approver.token)).send({ ...evidence, current_password: approver.password, code: approver.codes[0] });
  expect(issue.status).toBe(200); expect(JSON.stringify(issue.body)).not.toContain('?reset=');
  const raw = latestToken();
  const oldChallenge = await ctx.api.post('/api/auth/login').send({ username: target.username, password: target.password });
  expect(oldChallenge.body.mfa_required).toBe(true);
  const next = randomUUID();
  const claim = () => ctx.api.post('/api/auth/reset-password').send({ token: raw, new_password: next });
  expect((await claim()).status).toBe(200); expect((await claim()).status).toBe(400);
  expect((await ctx.api.post('/api/auth/login/mfa').send({ mfa_token: oldChallenge.body.mfa_token, code: target.codes[0] })).status).toBe(401);
  expect((await ctx.api.get('/api/auth/me').set(h(target.token))).status).toBe(401);
  const token = await login(ctx.api, target.username, next);
  expect((await ctx.api.get('/api/inventory').set(h(token))).status).toBe(403);
  expect((await ctx.api.get('/api/auth/me').set(h(token))).body.user.mfa_setup_required).toBe(true);
  const mode = process.env.DEPLOY_MODE;
  process.env.DEPLOY_MODE = 'node';
  try { expect((await ctx.api.get('/api/inventory').set(h(token))).status).toBe(403); }
  finally { if (mode === undefined) delete process.env.DEPLOY_MODE; else process.env.DEPLOY_MODE = mode; }
  const { userFromToken } = await import('../src/shared/auth'); expect(userFromToken(token)).toBeNull();
  const setup = await ctx.api.post('/api/auth/mfa/setup').set(h(token)).send({ password: next });
  expect((await ctx.api.post('/api/auth/mfa/enable').set(h(token)).send({ code: totpCode(setup.body.secret, totpCounter()) })).status).toBe(200);
  expect((await ctx.api.get('/api/inventory').set(h(token))).status).toBe(200);
  expect(db.queryOne<{state:string}>('SELECT state FROM account_recoveries WHERE user_id=?', target.id)!.state).toBe('completed');
});

it('invalidates a recovery when the recorded email changes and leaves the original factor enabled', async () => {
  const operator = await account(), target = await account();
  expect((await ctx.api.post(`/api/users/${target.id}/mfa/reset`).set(h(operator.token)).send({ ...evidence, current_password: operator.password, code: operator.codes[0] })).status).toBe(200);
  const token = latestToken(); db.run('UPDATE users SET email=? WHERE id=?', 'changed@example.test', target.id);
  expect((await ctx.api.post('/api/auth/reset-password').send({ token, new_password: randomUUID() })).status).toBe(400);
  expect((await ctx.api.post('/api/auth/login').send({ username: target.username, password: target.password })).body.mfa_required).toBe(true);
});

it('enforces the 24-hour notice even with another operator, scopes approvals and never returns the link', async () => {
  const { upsertPlatformUser, platformLogin } = await import('../src/platform/platform-users');
  const { createTenant } = await import('../src/platform/provisioning');
  const { platformDb } = await import('../src/platform/platform');
  const password = randomUUID();
  upsertPlatformUser('recovery-one', password); upsertPlatformUser('recovery-two', password);
  const one = platformLogin('recovery-one', password)!, two = platformLogin('recovery-two', password)!;
  createTenant({ slug: 'recovery-co', name: 'Recovery Co', admin_username: 'owner', admin_password: randomUUID(), admin_email: 'owner@example.test' });
  const path = '/_platform/api/tenants/recovery-co/account-recoveries';
  const request = await ctx.api.post(path).set(h(one)).send({ ...evidence, current_password: password, owner_id: 1 });
  expect(request.status).toBe(201);
  const body = { current_password: password, verification_reference: 'SECOND-VERIFICATION-321' };
  expect((await ctx.api.post(`${path}/${request.body.id}/approve`).set(h(one)).send(body)).status).toBe(403);
  expect((await ctx.api.post(`/_platform/api/tenants/other-co/account-recoveries/${request.body.id}/approve`).set(h(two)).send(body)).status).toBe(409);
  expect((await ctx.api.post(`${path}/${request.body.id}/approve`).set(h(two)).send({ ...body, current_password: 'wrong' })).status).toBe(403);
  expect((await ctx.api.post(`${path}/${request.body.id}/approve`).set(h(two)).send(body)).status).toBe(403);
  platformDb().prepare("UPDATE platform_recovery_approvals SET created_at=datetime('now','-25 hours') WHERE id=?").run(request.body.id);
  const approved = await ctx.api.post(`${path}/${request.body.id}/approve`).set(h(one)).send(body);
  expect(approved.status).toBe(200); expect(JSON.stringify(approved.body)).not.toContain('?reset=');
  expect(mail.send.mock.calls.at(-1)![0].text).toContain('https://app.example.test/recovery-co/?reset=');
  expect((await ctx.api.post(`${path}/${request.body.id}/approve`).set(h(two)).send(body)).status).toBe(409);
  expect(platformDb().prepare('SELECT state FROM platform_recovery_approvals WHERE id=?').get(request.body.id)).toMatchObject({ state: 'issued' });
});

it('does not remove MFA or issue a usable link when email delivery fails', async () => {
  const operator = await account(), target = await account();
  mail.send.mockResolvedValueOnce({ ok: false });
  expect((await ctx.api.post(`/api/users/${target.id}/mfa/reset`).set(h(operator.token)).send({ ...evidence, current_password: operator.password, code: operator.codes[0] })).status).toBe(503);
  const token = latestToken();
  expect((await ctx.api.post('/api/auth/reset-password').send({ token, new_password: randomUUID() })).status).toBe(400);
  expect((await ctx.api.post('/api/auth/login').send({ username: target.username, password: target.password })).body.mfa_required).toBe(true);
});

it('rejects expired links without consuming or removing the existing authenticator', async () => {
  const operator = await account(), target = await account();
  expect((await ctx.api.post(`/api/users/${target.id}/mfa/reset`).set(h(operator.token)).send({ ...evidence, current_password: operator.password, code: operator.codes[0] })).status).toBe(200);
  const token = latestToken();
  db.run("UPDATE password_resets SET expires_at=datetime('now','-1 minute') WHERE user_id=?", target.id);
  expect((await ctx.api.post('/api/auth/reset-password').send({ token, new_password: randomUUID() })).status).toBe(400);
  expect((await ctx.api.post('/api/auth/login').send({ username: target.username, password: target.password })).body.mfa_required).toBe(true);
  expect((await ctx.api.post(`/api/users/${operator.id}/mfa/reset`).set(h(operator.token)).send({ ...evidence, current_password: operator.password, code: operator.codes[1] })).status).toBe(403);
});

it('invalidates outstanding assisted links when the user changes their enrolled factor', async () => {
  const operator = await account(), target = await account();
  expect((await ctx.api.post(`/api/users/${target.id}/mfa/reset`).set(h(operator.token)).send({ ...evidence, current_password: operator.password, code: operator.codes[0] })).status).toBe(200);
  const token = latestToken();
  expect((await ctx.api.post('/api/auth/mfa/disable').set(h(target.token)).send({ password: target.password, code: target.codes[0] })).status).toBe(200);
  expect((await ctx.api.post('/api/auth/reset-password').send({ token, new_password: randomUUID() })).status).toBe(400);
});

it('lets the notified owner cancel during the wait and prevents solo approval afterwards', async () => {
  const { upsertPlatformUser, platformLogin } = await import('../src/platform/platform-users');
  const { createTenant } = await import('../src/platform/provisioning');
  const { platformDb } = await import('../src/platform/platform');
  const password = randomUUID(); upsertPlatformUser('solo-support', password);
  const operator = platformLogin('solo-support', password)!;
  createTenant({ slug: 'cancel-co', name: 'Cancel Co', admin_username: 'owner', admin_password: randomUUID(), admin_email: 'owner@example.test' });
  const path = '/_platform/api/tenants/cancel-co/account-recoveries';
  const issue = () => ctx.api.post(path).set(h(operator)).send({ ...evidence, current_password: password, owner_id: 1 });
  const request = await issue(); expect(request.status).toBe(201);
  const text = mail.send.mock.calls.at(-1)![0].text as string;
  const cancellation = text.match(/cancel_recovery=([a-f0-9-]+\.[a-f0-9]{64})/)![1]!;
  const cancelPath = '/cancel-co/api/auth/cancel-recovery';
  expect((await ctx.api.post('/other-co/api/auth/cancel-recovery').set('Host','app.example.test').send({ token: cancellation })).status).not.toBe(200);
  expect((await ctx.api.post(cancelPath).set('Host','app.example.test').send({ token: cancellation })).status).toBe(200);
  expect((await ctx.api.post(cancelPath).set('Host','app.example.test').send({ token: cancellation })).status).toBe(400);
  platformDb().prepare("UPDATE platform_recovery_approvals SET created_at=datetime('now','-25 hours') WHERE id=?").run(request.body.id);
  expect((await ctx.api.post(`${path}/${request.body.id}/approve`).set(h(operator)).send({ current_password: password, verification_reference: 'SOLO-CALLBACK-VERIFIED' })).status).toBe(409);
});

it('migrates schema 83 without changing the user column order used by sync', () => {
  const columns = () => db.queryAll<{name:string}>('PRAGMA table_info(users)').map(row => row.name);
  const fresh = columns();
  db.db.exec('ALTER TABLE users DROP COLUMN mfa_recovery_required');
  db.setSetting('schema_version', 83);
  db.closeAllConnections(); db.init();
  expect(columns()).toEqual(fresh);
  expect(db.getSetting('schema_version')).toBe(db.SCHEMA_VERSION);
});
