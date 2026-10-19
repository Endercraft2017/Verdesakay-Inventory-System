import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setupApp, cleanup, type TestContext } from './helpers';
let ctx: TestContext, token: string;
const auth = () => ({ Authorization: 'Bearer ' + token });
const input = { name: 'Guarded settings', admin_username: 'owner', admin_password: 'Synthetic guarded settings password', is_sandbox: true, plan: 'complete' };
const quote = { mode: 'bundle', bundle: 'operations', modules: [], seat_limit: null, bundle_price: null, module_prices: {}, seat_price: null };
beforeAll(async () => {
  process.env.PLATFORM_CONSOLE = 'true'; ctx = await setupApp();
  const users = await import('../src/platform/platform-users'); users.upsertPlatformUser('operator', 'Synthetic operator settings password');
  token = (await ctx.api.post('/_platform/api/login').send({ username: 'operator', password: 'Synthetic operator settings password' })).body.token;
  expect((await ctx.api.post('/_platform/api/tenants').set(auth()).send({ ...input, slug: 'guarded-settings' })).status).toBe(201);
});
afterAll(() => { delete process.env.PLATFORM_CONSOLE; cleanup(ctx); });
describe('control-plane settings and provisioning boundaries', () => {
  it.each([{ modules: ['not-a-module'] }, { plan: 'not-a-plan' }])('rejects invalid creation options before creating any workspace', async extra => {
    const { getTenant } = await import('../src/platform/platform');
    const response = await ctx.api.post('/_platform/api/tenants').set(auth()).send({ ...input, slug: 'must-not-exist', ...extra });
    expect(response.status).toBe(400); expect(getTenant('must-not-exist')).toBeNull();
    expect(response.body.request_id).toBeTruthy();
  });
  it('retains deliberate duplicate-slug conflict feedback', async () => {
    const response = await ctx.api.post('/_platform/api/tenants').set(auth()).send({ ...input, slug: 'guarded-settings' });
    expect(response.status).toBe(409); expect(response.body.error).toContain('already taken');
    expect(response.body.request_id).toBe(response.headers['x-request-id']);
  });
  it.each([{ plan: 'invalid' }, { status: 'purged' }, { modules: ['unknown'] }, { trial_ends_at: 'invalid' }, { photo_max_mb: -1 }, { photo_retention_days: 1.5 }, { awaiting_payment: 'yes' }])('rejects the entire invalid patch without partial changes: %j', async extra => {
    const { getTenant, listProvisioningLog } = await import('../src/platform/platform');
    const before = getTenant('guarded-settings'), log = listProvisioningLog('guarded-settings');
    const response = await ctx.api.patch('/_platform/api/tenants/guarded-settings').set(auth()).send({ name: 'Must not persist', ...extra });
    expect(response.status).toBe(400); expect(getTenant('guarded-settings')).toEqual(before);
    expect(listProvisioningLog('guarded-settings')).toEqual(log);
  });
  it.each(['create', 'patch', 'subscription', 'audit', 'subscription-audit'])('hides storage failure for %s and rolls back catalog writes', async operation => {
    const { platformDb, getTenant, listProvisioningLog } = await import('../src/platform/platform');
    const database = platformDb(), before = getTenant('guarded-settings'), audit = listProvisioningLog('guarded-settings');
    // "module" deliberately appears in the error: the previous route treated any such message as public.
    const marker = 'module synthetic-private-database-detail';
    const table = operation.endsWith('audit') ? 'provisioning_log' : 'tenants';
    const event = operation === 'create' || operation.endsWith('audit') ? 'INSERT' : 'UPDATE';
    database.exec(`CREATE TRIGGER settings_error_probe BEFORE ${event} ON ${table} BEGIN SELECT RAISE(ABORT, '${marker}'); END`);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const response = operation === 'create'
        ? await ctx.api.post('/_platform/api/tenants').set(auth()).send({ ...input, slug: 'failed-create' })
        : operation.startsWith('subscription')
        ? await ctx.api.put('/_platform/api/tenants/guarded-settings/subscription').set(auth()).send(quote)
        : await ctx.api.patch('/_platform/api/tenants/guarded-settings').set(auth()).send({ name: 'Do not save', modules: ['hr'] });
      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Internal server error', request_id: response.headers['x-request-id'] });
      expect(response.body.request_id).toBeTruthy(); expect(JSON.stringify(log.mock.calls)).not.toContain(marker);
      expect(JSON.stringify(log.mock.calls)).toContain(response.body.request_id);
      expect(getTenant('guarded-settings')).toEqual(before); expect(getTenant('failed-create')).toBeNull();
      expect(listProvisioningLog('guarded-settings')).toEqual(audit);
    } finally { database.exec('DROP TRIGGER settings_error_probe'); log.mockRestore(); }
  });
  it('commits a valid multi-field patch with a single matching audit entry', async () => {
    const { getTenant, listProvisioningLog } = await import('../src/platform/platform');
    const before = listProvisioningLog('guarded-settings').length;
    const response = await ctx.api.patch('/_platform/api/tenants/guarded-settings').set(auth()).send({ name: 'Validated company', modules: ['manufacturing'], photo_retention_days: 14, photo_max_mb: 50 });
    expect(response.status).toBe(200); expect(response.body.modules.effective).toEqual(['inventory', 'manufacturing']);
    expect(getTenant('guarded-settings')).toMatchObject({ name: 'Validated company', photo_retention_days: 14, photo_max_mb: 50 });
    expect(listProvisioningLog('guarded-settings')).toHaveLength(before + 1);
  });
  it('preserves public import-format feedback without exposing internal diagnostics', async () => {
    const response = await ctx.api.post('/_platform/api/tenants/import').set(auth()).field('slug', 'invalid-import').field('name', 'Invalid').attach('db', Buffer.from('not a database'), 'bad.db');
    expect(response.status).toBe(400); expect(response.body.error).toBe('That file is not a SQLite database.');
    expect(response.body.request_id).toBeTruthy();
  });
});
