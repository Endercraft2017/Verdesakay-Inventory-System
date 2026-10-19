import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { setupApp, cleanup, type TestContext } from './helpers';
vi.mock('../src/platform/platform-mail', async original => ({ ...await original<typeof import('../src/platform/platform-mail')>(), notifyOwner: vi.fn(async () => {}) }));
let ctx: TestContext, token: string;
let notifyOwner: typeof import('../src/platform/platform-mail').notifyOwner;
let platform: typeof import('../src/platform/platform'), db: typeof import('../src/shared/db'), billing: typeof import('../src/platform/billing');
const auth = () => ({ Authorization: 'Bearer ' + token });
const password = 'Synthetic atomic signup password';
const signup = (slug: string) => ctx.api.post('/api/signup').send({ slug, company_name: slug, admin_username: 'owner', admin_password: password, admin_email: slug + '@example.test', modules: ['hr'], seats: 3 });
beforeAll(async () => {
  process.env.SIGNUPS_OPEN = 'true'; process.env.PLATFORM_CONSOLE = 'true'; ctx = await setupApp();
  notifyOwner = (await import('../src/platform/platform-mail')).notifyOwner;
  platform = await import('../src/platform/platform'); db = await import('../src/shared/db'); billing = await import('../src/platform/billing');
  billing.setBillingSettings({ module_prices: { hr: 100 }, seat_price: 20 });
  (await import('../src/platform/owner-analytics')).prepareOwnerAnalytics();
  const users = await import('../src/platform/platform-users'); users.upsertPlatformUser('operator', password);
  token = (await ctx.api.post('/_platform/api/login').send({ username: 'operator', password })).body.token;
});
afterAll(() => { delete process.env.SIGNUPS_OPEN; delete process.env.PLATFORM_CONSOLE; cleanup(ctx); });
const rows = (table: string, key: string, slug: string) => platform.platformDb().prepare(`SELECT * FROM ${table} WHERE ${key}=?`).all(slug);
describe('public signup publication includes local setup', () => {
  it.each([
    ['payment-lock', 'tenants', 'UPDATE', 'NEW.awaiting_payment=1'],
    ['subscription', 'tenants', 'UPDATE', 'NEW.subscription IS NOT NULL'],
    ['owner-details', 'tenant_owner_details', 'INSERT', '1'],
    ['invoice', 'billing_invoices', 'INSERT', '1'],
    ['invoice-audit', 'provisioning_log', 'INSERT', "NEW.action='billing'"],
    ['publication-audit', 'provisioning_log', 'INSERT', "NEW.action='create'"],
  ])('rolls back %s failure, sends no alert and permits one complete retry', async (phase, table, operation, condition) => {
    const slug = 'atomic-' + phase; vi.mocked(notifyOwner).mockClear();
    const database = platform.platformDb();
    database.exec(`CREATE TRIGGER atomic_setup_failure BEFORE ${operation} ON ${table} WHEN ${condition} BEGIN SELECT RAISE(ABORT,'synthetic private setup failure'); END`);
    try {
      const response = await signup(slug);
      expect(response.status).toBe(500); expect(response.body.error).toBe('Internal server error');
      expect(response.body.request_id).toBe(response.headers['x-request-id']);
      expect(platform.getTenant(slug)).toBeNull(); expect(fs.existsSync(path.join(db.DATA_DIR, slug + '.db'))).toBe(false);
      expect(rows('billing_invoices', 'tenant_slug', slug)).toEqual([]);
      expect(rows('tenant_owner_details', 'slug', slug)).toEqual([]); expect(platform.listProvisioningLog(slug)).toEqual([]);
      expect(notifyOwner).not.toHaveBeenCalled();
    } finally { database.exec('DROP TRIGGER atomic_setup_failure'); }
    const response = await signup(slug); expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(platform.getTenant(slug)).toMatchObject({ awaiting_payment: 1 });
    expect(rows('billing_invoices', 'tenant_slug', slug)).toHaveLength(1);
    expect(rows('tenant_owner_details', 'slug', slug)).toHaveLength(1); expect(notifyOwner).toHaveBeenCalledTimes(1);
  });
});

it('rolls back console modules and inquiry link when final publication audit fails', async () => {
  const inquiries = await import('../src/platform/inquiries');
  const inquiry = inquiries.createInquiry({ name: 'Synthetic contact', company: 'Atomic company', email: 'atomic@example.test' });
  const slug = 'atomic-console', database = platform.platformDb();
  database.exec("CREATE TRIGGER console_setup_failure BEFORE INSERT ON provisioning_log WHEN NEW.action='create' BEGIN SELECT RAISE(ABORT,'synthetic console setup failure'); END");
  const input = { slug, name: 'Atomic console', admin_username: 'owner', admin_password: password, is_sandbox: true, modules: ['manufacturing'], awaiting_payment: true, inquiry_id: inquiry.id };
  try {
    const response = await ctx.api.post('/_platform/api/tenants').set(auth()).send(input);
    expect(response.status).toBe(500); expect(platform.getTenant(slug)).toBeNull();
    expect(inquiries.getInquiry(inquiry.id)?.tenant_slug).toBeNull(); expect(platform.listProvisioningLog(slug)).toEqual([]);
    expect(fs.existsSync(path.join(db.DATA_DIR, slug + '.db'))).toBe(false);
  } finally { database.exec('DROP TRIGGER console_setup_failure'); }
  const response = await ctx.api.post('/_platform/api/tenants').set(auth()).send(input);
  expect(response.status).toBe(201); expect(response.body.modules.effective).toEqual(['inventory', 'manufacturing']);
  expect(inquiries.getInquiry(inquiry.id)?.tenant_slug).toBe(slug);
});

it('standalone invoice audit failure rolls back issuance and keeps the connection usable', () => {
  const slug = 'atomic-payment-lock', database = platform.platformDb(), before = rows('billing_invoices', 'tenant_slug', slug);
  const invoice = { kind: 'other' as const, description: 'Synthetic invoice', amount_centavos: 500, due_on: '2026-10-31' };
  database.exec("CREATE TRIGGER invoice_audit_failure BEFORE INSERT ON provisioning_log WHEN NEW.action='billing' BEGIN SELECT RAISE(ABORT,'synthetic billing audit failure'); END");
  try { expect(() => billing.createInvoice(slug, invoice, 'operator')).toThrow('synthetic billing audit failure'); }
  finally { database.exec('DROP TRIGGER invoice_audit_failure'); }
  expect(rows('billing_invoices', 'tenant_slug', slug)).toEqual(before);
  expect(billing.createInvoice(slug, invoice, 'operator').id).toBeGreaterThan(0);
});


it('rolls back completed local signup setup after a real process exit before publication commits', () => {
  const root = path.join(ctx.tmpDir, 'setup-crash'); fs.mkdirSync(root);
  const env = { PATH: process.env.PATH, NODE_ENV: 'test', DEPLOY_MODE: 'cloud', ADMIN_PASSWORD: 'Synthetic crash bootstrap password',
    DB_PATH: path.join(root, 'default.db'), DATA_DIR: path.join(root, 'tenants'), PLATFORM_DB_PATH: path.join(root, 'platform.db'),
    UPLOAD_DIR: path.join(root, 'uploads'), BACKUP_DIR: path.join(root, 'backups') };
  const source = `
    import { platformDb, setAwaitingPayment } from './src/platform/platform.ts';
    import { createTenant } from './src/platform/provisioning.ts';
    import { getBillingSettings, createInvoice } from './src/platform/billing.ts';
    import { prepareOwnerAnalytics, saveOwnerDetails } from './src/platform/owner-analytics.ts';
    import { saveSubscription } from './src/platform/subscription.ts';
    getBillingSettings(); prepareOwnerAnalytics();
    const database=platformDb(); database.function('exit_setup',()=>process.exit(73));
    database.exec("CREATE TRIGGER crash_setup BEFORE INSERT ON provisioning_log WHEN NEW.action='create' BEGIN SELECT exit_setup(); END");
    createTenant({slug:'crashed-setup',name:'Crash fixture',admin_username:'chosen-owner',admin_password:'Synthetic setup crash password'}, slug=>{
      setAwaitingPayment(slug,true);
      saveSubscription(slug,{mode:'per_module',bundle:'complete',modules:['hr'],seat_limit:3,seat_price:20,bundle_price:null,module_prices:{hr:100}});
      saveOwnerDetails(slug,{contact_email:'crash@example.test'});
      createInvoice(slug,{kind:'subscription',description:'Synthetic first invoice',amount_centavos:16000,due_on:'2026-10-31'},'signup');
    });`;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 15000 });
  expect(child.status, child.stderr).toBe(73);
  const database = new DatabaseSync(env.PLATFORM_DB_PATH);
  try {
    for (const table of ['tenants', 'billing_invoices', 'tenant_owner_details', 'provisioning_log']) {
      expect(database.prepare(`SELECT COUNT(*) n FROM ${table}`).get(), table).toMatchObject({ n: 0 });
    }
  } finally { database.close(); }
  expect(fs.existsSync(path.join(env.DATA_DIR, 'crashed-setup.db'))).toBe(true);
});
