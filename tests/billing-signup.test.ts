/** Pay-first website sign-up (docs/SAAS-READINESS.md §12): a company that signs up on the public
    site gets a workspace locked to Billing, an automatic first invoice priced from the owner's
    price list, and pays by GCash or bank transfer; it opens when the owner confirms the payment.
    A workspace the owner creates in the console is never locked. */
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { setupApp, cleanup, type TestContext } from './helpers';

let ctx: TestContext;
const host = 'otom.afkcube.com';
let op = '';
const opHdr = () => ({ Authorization: `Bearer ${op}`, Host: host });
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const today = () => new Date().toISOString().slice(0, 10);

async function signup(slug: string, extra: Record<string, unknown> = {}) {
  return ctx.api.post('/api/signup').set('Host', host).send({
    slug, company_name: slug.toUpperCase(), admin_username: 'owner', admin_password: 'secret1',
    admin_email: `${slug}@example.test`, seats: 3, modules: ['hr'], ...extra,
  });
}
async function tenantLogin(slug: string) {
  const r = await ctx.api.post(`/${slug}/api/auth/login`).set('Host', host).send({ username: 'owner', password: 'secret1' });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return { Host: host, Authorization: `Bearer ${r.body.token}` };
}

beforeAll(async () => {
  process.env.TENANT_PATH_HOST = host;
  process.env.SIGNUPS_OPEN = 'true';
  process.env.PLATFORM_CONSOLE = 'true';
  process.env.PLATFORM_HOST = host;
  ctx = await setupApp();
  const users = await import('../src/platform/platform-users');
  users.upsertPlatformUser('boss', 'bosspass1', 'Owner');
  op = (await ctx.api.post('/_platform/api/login').set('Host', host).send({ username: 'boss', password: 'bosspass1' })).body.token;
});
afterAll(() => {
  for (const key of ['TENANT_PATH_HOST', 'SIGNUPS_OPEN', 'PLATFORM_CONSOLE', 'PLATFORM_HOST']) delete process.env[key];
  cleanup(ctx);
});

describe('without a price list', () => {
  it('locks the new workspace and leaves the first invoice to the owner', async () => {
    const r = await signup('earlyco');
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ slug: 'earlyco', awaiting_payment: true, invoice: null });
    const cfg = (await ctx.api.get('/site/config').set('Host', host)).body;
    expect(cfg.pricing).toEqual({ module_prices: {}, seat_price: null, vat_registered: false });
    expect(cfg.max_seats).toBe(500);
  });
});

describe('with GCash and a price list', () => {
  beforeAll(async () => {
    const s = await ctx.api.put('/_platform/api/billing/settings').set(opHdr()).send({
      gcash_name: 'Juan D.', gcash_number: '0917 123 4567', bank_details: 'BPI · 1234',
      module_prices: { hr: 3000, inventory: '2000' }, seat_price: 500,
    });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(s.body).toMatchObject({ gcash_number: '09171234567', module_prices: { hr: 3000, inventory: 2000 }, seat_price: 500 });
    const qr = await ctx.api.post('/_platform/api/billing/settings/gcash-qr').set(opHdr())
      .attach('qr', PNG, { filename: 'qr.png', contentType: 'image/png' });
    expect(qr.status).toBe(200);
  });

  it('validates the GCash number and prices', async () => {
    expect((await ctx.api.put('/_platform/api/billing/settings').set(opHdr()).send({ gcash_number: '12345' })).status).toBe(400);
    expect((await ctx.api.put('/_platform/api/billing/settings').set(opHdr()).send({ module_prices: { teleport: 5 } })).status).toBe(400);
    expect((await ctx.api.put('/_platform/api/billing/settings').set(opHdr()).send({ seat_price: -1 })).status).toBe(400);
    expect((await ctx.api.post('/_platform/api/billing/settings/gcash-qr').set(opHdr())
      .attach('qr', Buffer.from('%PDF'), { filename: 'q.pdf', contentType: 'application/pdf' })).status).toBe(400);
  });

  it('the website shows the prices and payment methods', async () => {
    const cfg = (await ctx.api.get('/site/config').set('Host', host)).body;
    expect(cfg.pricing.module_prices.hr).toBe(3000);
    expect(cfg.payment_methods).toEqual({ bank: true, gcash: true });
  });

  it('a sign-up is invoiced for the first month, then locked to Billing until paid', async () => {
    // manufacturing has no price yet, so this one waits for the owner to invoice it
    const unpriced = await signup('payco', { seats: 4, modules: ['hr', 'manufacturing'] });
    expect(unpriced.status, JSON.stringify(unpriced.body)).toBe(201);
    expect(unpriced.body.invoice).toBeNull();

    const ok = await signup('paidco', { seats: 4, modules: ['hr', 'inventory'] });
    expect(ok.status).toBe(201);
    expect(ok.body.awaiting_payment).toBe(true);
    // inventory 2,000 + hr 3,000 + 4 seats × 500 = 7,000; 2% EWT → 6,860
    expect(ok.body.invoice).toMatchObject({ amount: 7000, net_if_withheld: 6860 });

    const h = await tenantLogin('paidco');
    const t = (await ctx.api.get('/paidco/api/tenant').set(h)).body;
    expect(t.awaiting_payment).toBe(true);
    expect(t.limits.users).toBe(4);
    expect((await ctx.api.get('/paidco/api/users').set(h)).status).toBe(402);
    expect((await ctx.api.post('/paidco/api/locations').set(h).send({ name: 'X' })).status).toBe(402);
    const phone = await ctx.api.get('/paidco/m').set('Host', host);
    expect(phone.status).toBe(402);
    expect(phone.text).toContain("isn't open yet");

    const bill = (await ctx.api.get('/paidco/api/tenant/billing').set(h)).body;
    expect(bill).toMatchObject({ awaiting_payment: true, bank_details: 'BPI · 1234', gcash: { name: 'Juan D.', number: '09171234567', has_qr: true } });
    expect(bill.invoices).toHaveLength(1);
    const qr = await ctx.api.get('/paidco/api/tenant/billing/gcash-qr').set(h);
    expect(qr.status).toBe(200);
    expect(qr.headers['content-type']).toContain('image/png');

    // pays by GCash and reports it
    const inv = bill.invoices[0];
    expect((await ctx.api.post(`/paidco/api/tenant/billing/invoices/${inv.id}/payments`).set(h)
      .field('channel', 'cash').field('reference_no', 'X').field('amount', '7000').field('paid_on', today())
      .attach('proof', PNG, { filename: 'r.png', contentType: 'image/png' })).status).toBe(400);
    const rep = await ctx.api.post(`/paidco/api/tenant/billing/invoices/${inv.id}/payments`).set(h)
      .field('channel', 'gcash').field('reference_no', '5012345678901').field('amount', '7000').field('paid_on', today())
      .attach('proof', PNG, { filename: 'gcash.png', contentType: 'image/png' });
    expect(rep.status, JSON.stringify(rep.body)).toBe(201);
    expect(rep.body.payments[0]).toMatchObject({ method: 'gcash', status: 'pending' });

    // the owner confirms it → the workspace opens
    const c = await ctx.api.post(`/_platform/api/billing/payments/${rep.body.payments[0].id}/confirm`).set(opHdr()).send({});
    expect(c.body.status).toBe('paid');
    expect((await ctx.api.get('/paidco/api/tenant').set(h)).body.awaiting_payment).toBe(false);
    expect((await ctx.api.get('/paidco/api/users').set(h)).status).toBe(200);
    expect((await ctx.api.get('/paidco/m').set('Host', host)).status).toBe(200);
    const log = (await ctx.api.get('/_platform/api/tenants/paidco').set(opHdr())).body.log;
    expect(log.some((e: { detail: string }) => /workspace opened \(first payment confirmed\)/.test(e.detail || ''))).toBe(true);
  });

  it('the owner can open a waiting workspace without payment', async () => {
    const t = (await ctx.api.get('/_platform/api/tenants/payco').set(opHdr())).body;
    expect(t.awaiting_payment).toBe(true);
    const p = await ctx.api.patch('/_platform/api/tenants/payco').set(opHdr()).send({ awaiting_payment: false });
    expect(p.body.awaiting_payment).toBe(false);
    const h = await tenantLogin('payco');
    expect((await ctx.api.get('/payco/api/users').set(h)).status).toBe(200);
  });

  it('a workspace the owner creates is usable straight away', async () => {
    const r = await ctx.api.post('/_platform/api/tenants').set(opHdr())
      .send({ name: 'Console Made', slug: 'consolemade', admin_username: 'owner', admin_password: 'secret1', admin_email: 'owner@consolemade.test', plan: 'starter' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.awaiting_payment).toBe(false);
    const h = await tenantLogin('consolemade');
    expect((await ctx.api.get('/consolemade/api/users').set(h)).status).toBe(200);
  });
});
