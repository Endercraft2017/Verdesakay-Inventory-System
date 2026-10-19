import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { setupApp, cleanup, type TestContext } from './helpers';
let ctx: TestContext, token: string, otherToken: string;
let platform: typeof import('../src/platform/platform'), receipts: typeof import('../src/platform/onboarding-receipts'), billing: typeof import('../src/platform/billing');
const password = 'Synthetic receipt signup password';
const input = (slug: string) => ({ slug, company_name: slug, admin_username: 'owner', admin_password: password, admin_email: slug + '@example.test', modules: ['hr'], seats: 3 });
const signup = (body: object, key?: string) => {
  const request = ctx.api.post('/api/signup'); if (key !== undefined) request.set('Idempotency-Key', key); return request.send(body);
};
const consoleCreate = (body: object, key: string, auth = token) => ctx.api.post('/_platform/api/tenants').set('Authorization', 'Bearer ' + auth).set('Idempotency-Key', key).send(body);
const consoleInput = { name: 'Receipt sandbox', admin_username: 'owner', admin_password: password, is_sandbox: true };
beforeAll(async () => {
  process.env.SIGNUPS_OPEN = 'true'; process.env.PLATFORM_CONSOLE = 'true'; ctx = await setupApp();
  platform = await import('../src/platform/platform'); receipts = await import('../src/platform/onboarding-receipts'); billing = await import('../src/platform/billing');
  (await import('../src/platform/platform-mail')).savePlatformMail({transport:'brevo',from_email:'alerts@example.test',alert_to:'owner@example.test'},'synthetic-outbox-key');
  billing.setBillingSettings({ module_prices: { hr: 100 }, seat_price: 20 });
  const users = await import('../src/platform/platform-users');
  users.upsertPlatformUser('receipt-operator', password); users.upsertPlatformUser('other-operator', password);
  token = (await ctx.api.post('/_platform/api/login').send({ username: 'receipt-operator', password })).body.token;
  otherToken = (await ctx.api.post('/_platform/api/login').send({ username: 'other-operator', password })).body.token;
});
afterAll(() => { delete process.env.SIGNUPS_OPEN; delete process.env.PLATFORM_CONSOLE; cleanup(ctx); });

it('replays the original signup/invoice across changed prices and a reopened catalog, without another notification', async () => {
  const key = randomUUID(), body = input('receipt-public');
  const first = await signup(body, key); expect(first.status).toBe(201);
  billing.setBillingSettings({ module_prices: { hr: 200 }, seat_price: 30 });
  platform._resetPlatformDb();
  const replay = await signup({ ...body, modules: ['hr'] }, key.toUpperCase());
  expect(replay.status).toBe(201); expect(replay.headers['idempotency-replayed']).toBe('true'); expect(replay.body).toEqual(first.body);
  expect(platform.platformDb().prepare('SELECT * FROM billing_invoices WHERE tenant_slug=?').all(body.slug)).toHaveLength(1);
  expect(platform.platformDb().prepare('SELECT * FROM platform_owner_outbox WHERE tenant_slug=?').all(body.slug)).toHaveLength(1);
  const row = platform.platformDb().prepare('SELECT * FROM platform_creation_receipts WHERE tenant_slug=?').get(body.slug)!;
  expect(row.verifier).toMatch(/^scrypt\$v1\$/); expect(JSON.stringify(row)).not.toContain(password);
  expect(JSON.stringify(row)).not.toContain(key); expect(JSON.stringify(row)).not.toContain(body.admin_email);
  expect(replay.body.token).toBeUndefined();
});

it.each(['admin_password', 'seats'])('rejects a same-key signup with changed %s', async field => {
  const key = randomUUID(), body = input('receipt-change-' + field.replace('_', '-'));
  expect((await signup(body, key)).status).toBe(201);
  const changed = { ...body, [field]: field === 'seats' ? 4 : 'Different synthetic receipt password' };
  expect((await signup(changed, key)).status).toBe(409);
});

it('does not duplicate a generated console slug and preserves authentication before replay', async () => {
  const key = randomUUID(); const first = await consoleCreate(consoleInput, key); expect(first.status).toBe(201);
  const replay = await consoleCreate({ admin_password: password, is_sandbox: true, name: consoleInput.name, admin_username: 'owner' }, key);
  expect(replay.status).toBe(201); expect(replay.body).toEqual(first.body); expect(replay.headers['idempotency-replayed']).toBe('true');
  expect(platform.getTenant(first.body.slug + '-2')).toBeNull();
  const noAuth = await ctx.api.post('/_platform/api/tenants').set('Idempotency-Key', key).send(consoleInput);
  expect(noAuth.status).toBe(401);
  const other = await consoleCreate(consoleInput, key, otherToken);
  expect(other.status).toBe(201); expect(other.body.slug).not.toBe(first.body.slug); expect(other.headers['idempotency-replayed']).toBeUndefined();
});

it('keeps signup and console receipt namespaces separate', async () => {
  const key = randomUUID(); expect((await signup(input('receipt-namespace'), key)).status).toBe(201);
  const result = await consoleCreate({ ...consoleInput, name: 'Receipt namespace console' }, key);
  expect(result.status).toBe(201); expect(result.body.slug).not.toBe('receipt-namespace');
});

it.each(['', 'predictable', '11111111-1111-1111-1111-111111111111'])('rejects invalid key %j before provisioning', async key => {
  const body = input('receipt-invalid-key'); expect((await signup(body, key)).status).toBe(400); expect(platform.getTenant(body.slug)).toBeNull();
});

it('retains legacy no-key behavior without promising response replay', async () => {
  const body = input('receipt-legacy'); expect((await signup(body)).status).toBe(201); expect((await signup(body)).status).toBe(409);
  expect(platform.platformDb().prepare('SELECT * FROM platform_creation_receipts WHERE tenant_slug=?').all(body.slug)).toEqual([]);
});

it('rolls back workspace, invoice and receipt on final audit failure and permits the same-key retry', async () => {
  const key = randomUUID(), body = input('receipt-rollback'), database = platform.platformDb();
  database.exec("CREATE TRIGGER receipt_final_failure BEFORE INSERT ON provisioning_log WHEN NEW.action='create' BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END");
  try {
    expect((await signup(body, key)).status).toBe(500); expect(platform.getTenant(body.slug)).toBeNull();
    expect(database.prepare('SELECT * FROM platform_creation_receipts WHERE tenant_slug=?').all(body.slug)).toEqual([]);
    expect(database.prepare('SELECT * FROM billing_invoices WHERE tenant_slug=?').all(body.slug)).toEqual([]);
    expect(fs.existsSync(path.join(process.env.DATA_DIR!, body.slug + '.db'))).toBe(false);
  } finally { database.exec('DROP TRIGGER receipt_final_failure'); }
  expect((await signup(body, key)).status).toBe(201); expect((await signup(body, key)).headers['idempotency-replayed']).toBe('true');
});

it('rolls back workspace and setup when receipt insertion fails', async () => {
  const key = randomUUID(), body = input('receipt-storage-failure'), database = platform.platformDb();
  database.exec("CREATE TRIGGER receipt_insert_failure BEFORE INSERT ON platform_creation_receipts BEGIN SELECT RAISE(ABORT,'synthetic receipt storage failure'); END");
  try {
    const result = await signup(body, key); expect(result.status).toBe(500); expect(result.body.error).toBe('Internal server error');
    expect(platform.getTenant(body.slug)).toBeNull(); expect(database.prepare('SELECT * FROM billing_invoices WHERE tenant_slug=?').all(body.slug)).toEqual([]);
  } finally { database.exec('DROP TRIGGER receipt_insert_failure'); }
  expect((await signup(body, key)).status).toBe(201);
});

it('rejects expired keys permanently and removes the response/verifier while retaining a tombstone', async () => {
  const key = randomUUID(), body = input('receipt-expired'); expect((await signup(body, key)).status).toBe(201);
  platform.platformDb().prepare('UPDATE platform_creation_receipts SET expires_at=? WHERE tenant_slug=?').run(Date.now() - 1, body.slug);
  receipts.pruneCreationReceipts();
  const row = platform.platformDb().prepare('SELECT * FROM platform_creation_receipts WHERE tenant_slug=?').get(body.slug)!;
  expect(row.response).toBeNull(); expect(row.verifier).toBeNull();
  expect((await signup(body, key)).status).toBe(409);
});

it('does not replay a purged workspace', async () => {
  const key = randomUUID(), body = input('receipt-purged'); expect((await signup(body, key)).status).toBe(201);
  platform.setTenantStatus(body.slug, 'purged'); expect((await signup(body, key)).status).toBe(409);
});

it('unique receipt enforcement survives a separately prepared concurrent writer and rolls its publication back', async () => {
  const key = randomUUID(), body = { ...consoleInput, name: 'Receipt competing writer' };
  const candidate = receipts.prepareCreationReceipt('console-create:v1:999', key, body)!;
  const competing = receipts.prepareCreationReceipt('console-create:v1:999', key, body)!;
  const { createTenant } = await import('../src/platform/provisioning');
  createTenant({ slug: 'receipt-winner', name: body.name, admin_username: 'owner', admin_password: password, is_sandbox: true }, slug => receipts.saveCreationReceipt(candidate, slug, { slug }));
  expect(() => createTenant({ slug: 'receipt-loser', name: body.name, admin_username: 'owner', admin_password: password, is_sandbox: true }, slug => receipts.saveCreationReceipt(competing, slug, { slug }))).toThrow('Another request completed');
  expect(platform.getTenant('receipt-loser')).toBeNull(); expect(fs.existsSync(path.join(process.env.DATA_DIR!, 'receipt-loser.db'))).toBe(false);
  const independent = new DatabaseSync(process.env.PLATFORM_DB_PATH!, { readOnly: true });
  try { expect(independent.prepare('SELECT tenant_slug FROM platform_creation_receipts WHERE scope=?').all('console-create:v1:999')).toEqual([{ tenant_slug: 'receipt-winner' }]); }
  finally { independent.close(); }
});

it('replays a committed receipt after the creating process exits before acknowledgement', () => {
  const root = path.join(ctx.tmpDir, 'receipt-process-loss'); fs.mkdirSync(root);
  const env = { PATH: process.env.PATH, NODE_ENV: 'test', DEPLOY_MODE: 'cloud', ADMIN_PASSWORD: 'Synthetic receipt bootstrap password',
    DB_PATH: path.join(root, 'default.db'), DATA_DIR: path.join(root, 'tenants'), PLATFORM_DB_PATH: path.join(root, 'platform.db'),
    UPLOAD_DIR: path.join(root, 'uploads'), BACKUP_DIR: path.join(root, 'backups') };
  const key = randomUUID();
  const prelude = `import { prepareCreationReceipt,saveCreationReceipt } from './src/platform/onboarding-receipts.ts';
    import { createTenant } from './src/platform/provisioning.ts';
    import { listTenants } from './src/platform/platform.ts';
    const body={slug:'receipt-crashed',name:'Synthetic receipt crash',admin_username:'owner',admin_password:'Synthetic receipt crash password',is_sandbox:true};
    const receipt=prepareCreationReceipt('console-create:v1:999',${JSON.stringify(key)},body);`;
  const first = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', prelude + `
    createTenant(body,slug=>saveCreationReceipt(receipt,slug,{slug,company_id:'synthetic'}));
    process.exit(73);`], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 20000 });
  expect(first.status, first.stderr).toBe(73);
  const second = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', prelude + `
    if(receipt?.replay?.slug!=='receipt-crashed'||listTenants().length!==1)process.exit(74);
    process.exit(0);`], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 20000 });
  expect(second.status, second.stderr).toBe(0);
});

it('requires current fresh passkey proof even when the creation receipt already exists', async () => {
  const key = randomUUID(), body = { ...consoleInput, name: 'Receipt fresh proof' };
  expect((await consoleCreate(body, key)).status).toBe(201);
  const database = platform.platformDb();
  const user = database.prepare("SELECT id FROM platform_users WHERE username='receipt-operator'").get()!;
  database.prepare(`INSERT INTO platform_passkeys(id,user_id,public_key,counter,transports,label,backed_up,device_type)
    VALUES('synthetic-receipt-key',?,'synthetic',0,'[]','Synthetic test key',0,'singleDevice')`).run(user.id!);
  const { tokenDigest } = await import('../src/shared/db');
  const { markPlatformSessionVerified } = await import('../src/platform/platform-passkeys');
  try {
    markPlatformSessionVerified(token);
    database.prepare("UPDATE platform_session_security SET verified_at=datetime('now','-6 minutes') WHERE token_hash=?").run(tokenDigest(token));
    const stale = await consoleCreate(body, key); expect(stale.status).toBe(403); expect(stale.body.passkey_required).toBe(true);
    markPlatformSessionVerified(token);
    const replay = await consoleCreate(body, key); expect(replay.status).toBe(201); expect(replay.headers['idempotency-replayed']).toBe('true');
  } finally { database.prepare("DELETE FROM platform_passkeys WHERE id='synthetic-receipt-key'").run(); }
});
