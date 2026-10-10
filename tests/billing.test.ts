/** Workspace billing, phase a (docs/SAAS-READINESS.md §12): the operator issues an invoice in the
    owner console, the workspace admin reports a bank transfer with proof, the operator confirms or
    rejects it, and a paid invoice lifts a past-due lock. Amounts follow the EWT-on-net-of-VAT rule. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, type TestContext } from './helpers';

let ctx: TestContext;
let op: string;
const opHdr = () => ({ Authorization: `Bearer ${op}` });
const asTenant = (slug: string) => ({ 'X-Tenant': slug });
const tenantTok: Record<string, string> = {};
const tHdr = (slug: string) => ({ ...asTenant(slug), Authorization: `Bearer ${tenantTok[slug]}` });
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const today = () => new Date().toISOString().slice(0, 10);
const due = '2099-12-31';

async function newTenant(slug: string) {
  await ctx.api.post('/_platform/api/tenants').set(opHdr())
    .send({ slug, name: slug.toUpperCase(), admin_username: 'owner', admin_password: 'ownerpass1', plan: 'starter' });
  const r = await ctx.api.post('/api/auth/login').set(asTenant(slug)).send({ username: 'owner', password: 'ownerpass1' });
  tenantTok[slug] = r.body.token;
}

async function issue(slug: string, body: Record<string, unknown> = {}) {
  const r = await ctx.api.post(`/_platform/api/tenants/${slug}/invoices`).set(opHdr())
    .send({ kind: 'subscription', description: 'Plan — October 2026', amount: 25000, due_on: due, ...body });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
}

function report(slug: string, invoiceId: number, fields: Record<string, string> = {}, withProof = true) {
  let req = ctx.api.post(`/api/tenant/billing/invoices/${invoiceId}/payments`).set(tHdr(slug))
    .field('reference_no', fields.reference_no ?? 'IP-778812')
    .field('amount', fields.amount ?? '24500')
    .field('paid_on', fields.paid_on ?? today());
  if (withProof) req = req.attach('proof', PNG, { filename: 'receipt.png', contentType: 'image/png' });
  return req;
}

beforeAll(async () => {
  process.env.PLATFORM_CONSOLE = 'true';
  ctx = await setupApp();
  await login(ctx.api);
  const users = await import('../src/platform/platform-users');
  users.upsertPlatformUser('owner', 'ownerpass1', 'System Owner');
  op = (await ctx.api.post('/_platform/api/login').send({ username: 'owner', password: 'ownerpass1' })).body.token;
  await ctx.api.put('/_platform/api/billing/settings').set(opHdr())
    .send({ bank_details: 'BPI · Our Company Inc. · 1234-5678-90', reference_prefix: 'vdk' });
  await newTenant('billco');
  await newTenant('otherco');
});
afterAll(() => { delete process.env.PLATFORM_CONSOLE; cleanup(ctx); });

describe('issuing', () => {
  it('numbers invoices per year and expects 2% EWT off the gross when not VAT-registered', async () => {
    const a = await issue('billco');
    const b = await issue('billco', { amount: '1,000' });
    const year = today().slice(0, 4);
    expect(a.reference).toBe(`VDK-${year}-0001`);
    expect(b.reference).toBe(`VDK-${year}-0002`);
    expect(a).toMatchObject({ amount: 25000, vat: 0, ewt: 500, net_if_withheld: 24500, balance: 24500, status: 'open', overdue: false });
    await ctx.api.post(`/_platform/api/billing/invoices/${b.id}/void`).set(opHdr()).send({ reason: 'test' });
  });

  it('takes EWT on the amount net of VAT once VAT-registered', async () => {
    await ctx.api.put('/_platform/api/billing/settings').set(opHdr()).send({ vat_registered: true });
    const inv = await issue('otherco', { amount: 28000 });
    expect(inv).toMatchObject({ vat_rate: 12, vat: 3000, ewt: 500, net_if_withheld: 27500 });
    await ctx.api.put('/_platform/api/billing/settings').set(opHdr()).send({ vat_registered: false });
    await ctx.api.post(`/_platform/api/billing/invoices/${inv.id}/void`).set(opHdr()).send({ reason: 'test' });
  });

  it('rejects bad input and unknown workspaces', async () => {
    const bad = (body: object, slug = 'billco') => ctx.api.post(`/_platform/api/tenants/${slug}/invoices`).set(opHdr())
      .send({ kind: 'subscription', description: 'x', amount: 100, due_on: due, ...body });
    expect((await bad({ amount: 0 })).status).toBe(400);
    expect((await bad({ due_on: 'soon' })).status).toBe(400);
    expect((await bad({ kind: 'gift' })).status).toBe(400);
    expect((await bad({ description: ' ' })).status).toBe(400);
    expect((await bad({}, 'nosuchco')).status).toBe(404);
  });

  it('needs an operator session', async () => {
    expect((await ctx.api.post('/_platform/api/tenants/billco/invoices').send({})).status).toBe(401);
    expect((await ctx.api.get('/_platform/api/billing/invoices').set({ Authorization: `Bearer ${tenantTok.billco}` })).status).toBe(401);
  });
});

describe('the workspace side', () => {
  it('shows its own invoices and our bank details; the banner gets a summary', async () => {
    const r = await ctx.api.get('/api/tenant/billing').set(tHdr('billco'));
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(true);
    expect(r.body.bank_details).toContain('1234-5678-90');
    expect(r.body.invoices.every((i: { tenant_slug: string }) => i.tenant_slug === 'billco')).toBe(true);
    expect(r.body.invoices[0]).not.toHaveProperty('created_by');
    const t = await ctx.api.get('/api/tenant').set(tHdr('billco'));
    expect(t.body.billing).toEqual({ open: 1, overdue: 0, submitted: 0 });
  });

  it('the single-tenant install has no billing', async () => {
    const tok = await login(ctx.api);
    const r = await ctx.api.get('/api/tenant/billing').set({ Authorization: `Bearer ${tok}` });
    expect(r.body).toEqual({ enabled: false, bank_details: '', gcash: null, awaiting_payment: false, invoices: [] });
  });

  it('needs a signed-in workspace admin', async () => {
    expect((await ctx.api.get('/api/tenant/billing').set(asTenant('billco'))).status).toBe(401);
  });
});

describe('bank transfer → review', () => {
  let invId: number;
  let paymentId: number;

  beforeAll(async () => {
    invId = (await issue('billco', { description: 'Implementation fee', kind: 'implementation', amount: 150000 })).id;
  });

  it('requires proof, a reference, an amount and a past date', async () => {
    expect((await report('billco', invId, {}, false)).status).toBe(400);
    expect((await report('billco', invId, { reference_no: ' ' })).status).toBe(400);
    expect((await report('billco', invId, { amount: '0' })).status).toBe(400);
    expect((await report('billco', invId, { paid_on: '2999-01-01' })).status).toBe(400);
  });

  it('another workspace cannot report against it', async () => {
    expect((await report('otherco', invId)).status).toBe(404);
  });

  it('a report puts the invoice in review and keeps the proof', async () => {
    const r = await report('billco', invId, { amount: '147000' });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('payment_submitted');
    paymentId = r.body.payments[0].id;
    expect(r.body.payments[0]).toMatchObject({ status: 'pending', has_proof: true, has_2307: false, submitted_by: 'owner' });

    const own = await ctx.api.get(`/api/tenant/billing/payments/${paymentId}/files/proof`).set(tHdr('billco'));
    expect(own.status).toBe(200);
    expect(own.headers['content-type']).toContain('image/png');
    expect((await ctx.api.get(`/api/tenant/billing/payments/${paymentId}/files/proof`).set(tHdr('otherco'))).status).toBe(404);
    expect((await ctx.api.get(`/_platform/api/billing/payments/${paymentId}/files/proof`).set(opHdr())).status).toBe(200);
  });

  it('a rejection sends it back to open with the reason', async () => {
    expect((await ctx.api.post(`/_platform/api/billing/payments/${paymentId}/reject`).set(opHdr()).send({})).status).toBe(400);
    const r = await ctx.api.post(`/_platform/api/billing/payments/${paymentId}/reject`).set(opHdr())
      .send({ note: 'Reference not found on our statement' });
    expect(r.body.status).toBe('open');
    const seen = (await ctx.api.get('/api/tenant/billing').set(tHdr('billco'))).body.invoices.find((i: { id: number }) => i.id === invId);
    expect(seen.payments[0]).toMatchObject({ status: 'rejected', review_note: 'Reference not found on our statement' });
    expect((await ctx.api.post(`/_platform/api/billing/payments/${paymentId}/confirm`).set(opHdr())).status).toBe(409);
  });

  it('a confirmed transfer of the net amount (with the 2307) pays it', async () => {
    const r = await ctx.api.post(`/api/tenant/billing/invoices/${invId}/payments`).set(tHdr('billco'))
      .field('reference_no', 'PESONET-0091').field('amount', '147000').field('paid_on', today())
      .attach('proof', PNG, { filename: 'r.png', contentType: 'image/png' })
      .attach('form_2307', Buffer.from('%PDF-1.4'), { filename: '2307.pdf', contentType: 'application/pdf' });
    expect(r.status).toBe(201);
    const p = r.body.payments.find((x: { status: string }) => x.status === 'pending');
    expect(p.has_2307).toBe(true);
    const c = await ctx.api.post(`/_platform/api/billing/payments/${p.id}/confirm`).set(opHdr()).send({ bir_invoice_no: 'SI-00042' });
    expect(c.body).toMatchObject({ status: 'paid', bir_invoice_no: 'SI-00042', paid_total: 147000, balance: 0 });
    expect((await report('billco', invId)).status).toBe(409);
    expect((await ctx.api.post(`/_platform/api/billing/invoices/${invId}/void`).set(opHdr()).send({ reason: 'x' })).status).toBe(409);
  });

  it('rejects a file that is not an image or PDF', async () => {
    const inv = await issue('billco', { amount: 500 });
    const r = await ctx.api.post(`/api/tenant/billing/invoices/${inv.id}/payments`).set(tHdr('billco'))
      .field('reference_no', 'X1').field('amount', '490').field('paid_on', today())
      .attach('proof', Buffer.from('MZ'), { filename: 'a.exe', contentType: 'application/x-msdownload' });
    expect(r.status).toBe(400);
    await ctx.api.post(`/_platform/api/billing/invoices/${inv.id}/void`).set(opHdr()).send({ reason: 'test' });
  });
});

describe('payments the operator records', () => {
  it('a short payment leaves a balance; the rest settles it', async () => {
    const inv = await issue('otherco', { amount: 10000 }); // net 9,800
    const part = await ctx.api.post(`/_platform/api/billing/invoices/${inv.id}/record-payment`).set(opHdr())
      .send({ amount: 5000, paid_on: today(), reference_no: 'CHK 1001' });
    expect(part.body).toMatchObject({ status: 'open', paid_total: 5000, balance: 4800 });
    const rest = await ctx.api.post(`/_platform/api/billing/invoices/${inv.id}/record-payment`).set(opHdr())
      .send({ amount: 4800, paid_on: today() });
    expect(rest.body).toMatchObject({ status: 'paid', balance: 0 });
  });

  it('a voided invoice takes no payment', async () => {
    const inv = await issue('otherco', { amount: 100 });
    expect((await ctx.api.post(`/_platform/api/billing/invoices/${inv.id}/void`).set(opHdr()).send({})).status).toBe(400);
    const v = await ctx.api.post(`/_platform/api/billing/invoices/${inv.id}/void`).set(opHdr()).send({ reason: 'Wrong amount' });
    expect(v.body).toMatchObject({ status: 'void', void_reason: 'Wrong amount' });
    expect((await ctx.api.post(`/_platform/api/billing/invoices/${inv.id}/record-payment`).set(opHdr())
      .send({ amount: 98, paid_on: today() })).status).toBe(409);
    expect((await report('otherco', inv.id)).status).toBe(409);
  });
});

describe('past-due workspaces', () => {
  it('stay read-only except for billing, and paying makes them active again', async () => {
    await newTenant('lateco');
    const inv = await issue('lateco', { amount: 5000 }); // net 4,900
    await ctx.api.patch('/_platform/api/tenants/lateco').set(opHdr()).send({ status: 'past_due' });

    const blocked = await ctx.api.post('/api/locations').set(tHdr('lateco')).send({ name: 'Annex' });
    expect(blocked.status).toBe(402);
    const r = await report('lateco', inv.id, { amount: '4900' });
    expect(r.status).toBe(201);

    const pid = r.body.payments[0].id;
    await ctx.api.post(`/_platform/api/billing/payments/${pid}/confirm`).set(opHdr()).send({});
    const t = (await ctx.api.get('/_platform/api/tenants/lateco').set(opHdr())).body;
    expect(t.status).toBe('active');
    expect(t.log.some((e: { detail: string }) => /status=active \(invoice paid\)/.test(e.detail || ''))).toBe(true);
  });

  it('a suspension is not lifted by a payment', async () => {
    await newTenant('suspco');
    const inv = await issue('suspco', { amount: 1000 });
    await ctx.api.patch('/_platform/api/tenants/suspco').set(opHdr()).send({ status: 'suspended' });
    await ctx.api.post(`/_platform/api/billing/invoices/${inv.id}/record-payment`).set(opHdr()).send({ amount: 980, paid_on: today() });
    expect((await ctx.api.get('/_platform/api/tenants/suspco').set(opHdr())).body.status).toBe('suspended');
  });
});

describe('console listing', () => {
  it('filters by workspace and status, and settings validate', async () => {
    const all = (await ctx.api.get('/_platform/api/billing/invoices?slug=billco').set(opHdr())).body;
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((i: { tenant_slug: string }) => i.tenant_slug === 'billco')).toBe(true);
    expect(all[0]).toHaveProperty('created_by', 'owner');
    const paid = (await ctx.api.get('/_platform/api/billing/invoices?status=paid').set(opHdr())).body;
    expect(paid.every((i: { status: string }) => i.status === 'paid')).toBe(true);
    expect((await ctx.api.put('/_platform/api/billing/settings').set(opHdr()).send({ reference_prefix: 'no spaces!' })).status).toBe(400);
    expect((await ctx.api.put('/_platform/api/billing/settings').set(opHdr()).send({ default_ewt_rate: 40 })).status).toBe(400);
  });
});
