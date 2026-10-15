import { beforeAll, afterAll, it, expect } from 'vitest';
import { setupApp, cleanup, login, type TestContext } from './helpers';
let ctx: TestContext;
let op: string;
let tenantToken: string;
let platform: typeof import('../src/platform/platform');
const endpoint = '/_platform/api/tenants/invoiceco/setup-invoices';
const auth = () => ({ Authorization: `Bearer ${op}` });
const payload = (number = 'SMTP-001') => ({ invoice_number: number, amount: '1250.50', currency: 'PHP', issued_on: '2026-10-15', due_on: '2026-10-30' });
beforeAll(async () => {
  process.env.PLATFORM_CONSOLE = 'true';
  ctx = await setupApp();
  tenantToken = await login(ctx.api);
  platform = await import('../src/platform/platform');
  platform.createTenantRow({ slug: 'invoiceco', name: 'Invoice Co' });
  platform.createTenantRow({ slug: 'invoiceother', name: 'Other Co' });
  platform.createTenantRow({ slug: 'invoicepurged', name: 'Purged', status: 'purged' });
  const users = await import('../src/platform/platform-users');
  users.upsertPlatformUser('owner', 'ownerpass1');
  op = (await ctx.api.post('/_platform/api/login').send({ username: 'owner', password: 'ownerpass1' })).body.token;
});
afterAll(() => { delete process.env.PLATFORM_CONSOLE; cleanup(ctx); });

it('records an external invoice in platform.db with exact money and an audit trail', async () => {
  const r = await ctx.api.post(endpoint).set(auth()).send(payload());
  expect(r.status).toBe(201);
  expect(r.body).toMatchObject({ amount_minor: 125050, currency: 'PHP', status: 'issued', service_status: 'pending', created_by: 'owner', version: 1 });
  expect((await ctx.api.get(endpoint).set(auth())).body).toHaveLength(1);
  expect((await ctx.api.get(endpoint.replace('invoiceco', 'invoiceother')).set(auth())).body).toEqual([]);
  const db = await import('../src/shared/db');
  expect(db.queryAll("SELECT name FROM sqlite_master WHERE name = 'setup_invoices'")).toEqual([]);
  expect(platform.listProvisioningLog('invoiceco')[0]).toMatchObject({ action: 'setup-invoice-created' });
});

it('rejects duplicate submissions globally including case variations', async () => {
  expect((await ctx.api.post(endpoint).set(auth()).send(payload())).status).toBe(409);
  expect((await ctx.api.post(endpoint.replace('invoiceco', 'invoiceother')).set(auth()).send(payload('smtp-001'))).status).toBe(409);
});

it('validates money, currency and real dates rather than silently rounding', async () => {
  for (const patch of [
    { amount: '0' }, { amount: '-1' }, { amount: '1.001' }, { amount: '1e3' }, { amount: '1000000000' },
    { amount: 1250.5 }, { currency: 'JPY' }, { currency: '' }, { invoice_number: '  ' },
    { issued_on: '2026-02-30' }, { due_on: '2026-10-01' }, { status: 'paid' },
  ]) {
    expect((await ctx.api.post(endpoint).set(auth()).send({ ...payload('BAD'), ...patch })).status, JSON.stringify(patch)).toBe(400);
  }
  const cents = await ctx.api.post(endpoint).set(auth()).send({ ...payload('SMALL'), amount: '0.01' });
  expect(cents.body.amount_minor).toBe(1);
});

it('requires payment evidence, tracks payment and service independently, rejects stale edits', async () => {
  const row = (await ctx.api.post(endpoint).set(auth()).send(payload('PAY'))).body;
  const url = endpoint + '/' + row.id;
  expect((await ctx.api.patch(url).set(auth()).send({ version: 1, action: 'paid' })).status).toBe(400);
  expect((await ctx.api.patch(url).set(auth()).send({ version: 1, action: 'paid', paid_on: '2026-10-14', payment_reference: 'BANK-1' })).status).toBe(400);
  const completed = await ctx.api.patch(url).set(auth()).send({ version: 1, action: 'complete' });
  expect(completed.body).toMatchObject({ service_status: 'completed', status: 'issued', version: 2 });
  expect((await ctx.api.patch(url).set(auth()).send({ version: 1, action: 'void' })).status).toBe(409);
  const paid = await ctx.api.patch(url).set(auth()).send({ version: 2, action: 'paid', paid_on: '2026-10-15', payment_reference: 'BANK-1' });
  expect(paid.body).toMatchObject({ service_status: 'completed', status: 'paid', paid_on: '2026-10-15', payment_reference: 'BANK-1', version: 3 });
  expect((await ctx.api.patch(url).set(auth()).send({ version: 3, action: 'void' })).status).toBe(409);
  expect((await ctx.api.patch(url).set(auth()).send({ version: 3, action: 'paid', paid_on: '2026-10-15', payment_reference: 'BANK-1' })).status).toBe(409);
  expect((await ctx.api.patch(url).set(auth()).send({ version: 3, action: 'complete' })).status).toBe(409);
});

it('voids unpaid records without deleting history or permitting financial edits', async () => {
  const row = (await ctx.api.post(endpoint).set(auth()).send(payload('VOID'))).body;
  const url = endpoint + '/' + row.id;
  expect((await ctx.api.patch(url).set(auth()).send({ version: 1, action: 'complete', amount: '1' })).status).toBe(400);
  expect((await ctx.api.patch(url).set(auth()).send({ version: 1, action: 'void' })).body.status).toBe('void');
  expect((await ctx.api.patch(url).set(auth()).send({ version: 2, action: 'complete' })).status).toBe(409);
  expect((await ctx.api.get(endpoint).set(auth())).body.some((r: { id: number; status: string }) => r.id === row.id && r.status === 'void')).toBe(true);
});

it('scopes writes to the chosen tenant and rejects unauthorized or invalid requests', async () => {
  const row = (await ctx.api.get(endpoint).set(auth())).body[0];
  expect((await ctx.api.patch(endpoint.replace('invoiceco', 'invoiceother') + '/' + row.id).set(auth()).send({ version: row.version, action: 'complete' })).status).toBe(404);
  for (const method of ['get', 'post', 'patch'] as const) {
    const url = method === 'patch' ? endpoint + '/' + row.id : endpoint;
    expect((await ctx.api[method](url)).status).toBe(401);
    expect((await ctx.api[method](url).set({ Authorization: `Bearer ${tenantToken}` })).status).toBe(401);
    expect((await ctx.api[method](url).set(auth()).set('X-Tenant', 'invoiceco')).status).toBe(404);
    expect((await ctx.api[method](url.replace('invoiceco', 'missing')).set(auth())).status).toBe(404);
    expect((await ctx.api[method](url.replace('invoiceco', 'invoicepurged')).set(auth())).status).toBe(404);
  }
  expect((await ctx.api.patch(endpoint + '/not-an-id').set(auth()).send({ version: 1, action: 'void' })).status).toBe(400);
});
