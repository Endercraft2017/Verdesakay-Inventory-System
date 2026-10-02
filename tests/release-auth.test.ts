/** Warehouse-out rules (mobile Releasing, Figma 78:*; modules/inventory/release-auth.ts):
 *  Sales-issued release authorizations (token, recipient, expiry, revoke), per-product package
 *  checklists, partial release by splitting the order, the releaser's scan check and reports.
 *  Every refused slip leaves stock untouched. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, addSerializedUnits, type TestContext } from './helpers';

let ctx: TestContext;
let token: string;
let releaser: { id: number; token: string };
let __sentPush: typeof import('../src/shared/push').__sentPush;
const PNG = Buffer.from('fake-png-bytes');
const H = () => ({ Authorization: `Bearer ${token}` });
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  ctx = await setupApp();
  token = await login(ctx.api);
  releaser = await createEmployee(ctx.api, token, { role: 'releasing_clerk' });
  ({ __sentPush } = await import('../src/shared/push'));
});
const subscribe = (t: string, tag: string) => ctx.api.post('/api/push/subscribe').set(bearer(t))
  .send({ endpoint: 'https://push.example.com/sub/' + tag, keys: { p256dh: 'BAY'.padEnd(87, 'x'), auth: 'abc123def456' } });
afterAll(() => cleanup(ctx));

const mkItem = async (body: Record<string, unknown>) => (await ctx.api.post('/api/inventory').set(H()).send(body)).body.id as number;
const onHand = async (id: number) => (await ctx.api.get(`/api/inventory/${id}`).set(H())).body.quantity as number;

/** A finished product with `qty` in-stock serialized units labelled PFX-SN-n. */
async function productWithUnits(prefix: string, qty: number) {
  const product = await mkItem({ name: `${prefix} Bike`, unit_cost: 10 });
  const part = await mkItem({ name: `${prefix} Part`, quantity: 1000 });
  await ctx.api.put(`/api/finished-products/${product}`).set(H()).send({ components: [{ component_item_id: part, quantity: 1 }] });
  const mo = (await ctx.api.post('/api/job-orders').set(H()).send({ product_item_id: product, qty_ordered: qty, qc_stages: 1 })).body.id;
  await ctx.api.post(`/api/job-orders/${mo}/approve`).set(H());
  await ctx.api.post('/api/job-orders/warehouse-accept').set(H()).send({ job_order_ids: [mo] });
  await ctx.api.post('/api/job-orders/prepare').set(H()).send({ job_orders: [{ id: mo }] });
  await ctx.api.post(`/api/job-orders/${mo}/release`).set(H());
  await ctx.api.post(`/api/job-orders/${mo}/accept`).set(H());
  await addSerializedUnits(ctx.api, token, mo, qty, prefix);
  const pending = (await ctx.api.get(`/api/job-orders/${mo}/units`).set(H())).body as Array<{ id: number }>;
  const codes: string[] = [];
  for (let i = 0; i < pending.length; i++) {
    const code = `${prefix}-SN-${i + 1}`;
    await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(H()).send({ unit_ids: [pending[i]!.id], result: 'pass', identifier: code });
    codes.push(code);
  }
  const rec = (await ctx.api.get(`/api/job-orders/${mo}/receivable`).set(H())).body;
  await ctx.api.post(`/api/job-orders/${mo}/products-in`).set(H())
    .send({ location_id: rec.output_location_id, unit_ids: rec.units.map((u: { id: number }) => u.id) });
  return { product, codes };
}
async function approvedOrder(product: number, qty: number) {
  const id = (await ctx.api.post('/api/orders').set(H()).send({ type: 'sale', customer_name: 'ACME', status: 'approved', force: true,
    items: [{ name: 'Bike', item_id: product, quantity: qty, unit_price: 100 }] })).body.id as number;
  await ctx.api.post(`/api/orders/${id}/accept-release`).set(bearer(releaser.token));
  return id;
}
const issue = (order: number, body: Record<string, unknown> = {}) => ctx.api.post(`/api/release-slips/orders/${order}/authorizations`).set(H())
  .send({ mode: 'pickup', recipient_name: 'Jordan D.', id_reference: 'DL-N01-23-454821', valid_hours: 8, handoff_area: 'Release Bay 1', ...body });
const slip = (order: number, body: Record<string, unknown> = {}) => ctx.api.post(`/api/orders/${order}/release-slip`).set(bearer(releaser.token))
  .send({ collected_by: 'Jordan D.', ...body });

describe('release authorization', () => {
  it('masks the recipient ID and hides the token from the releaser; the slip needs the right token', async () => {
    const { product, codes } = await productWithUnits('RA1', 1);
    const so = await approvedOrder(product, 1);
    const iss = await issue(so);
    expect(iss.status).toBe(201);
    expect(iss.body.token).toMatch(/^PICKUP-[A-Z2-9]{4}$/);
    const ctxRes = await ctx.api.get(`/api/release-slips/orders/${so}/context`).set(bearer(releaser.token));
    expect(ctxRes.body.authorization).toMatchObject({ state: 'valid', mode: 'pickup', recipient_name: 'Jordan D.', id_reference: '••4821',
      handoff_area: 'Release Bay 1' });
    expect(JSON.stringify(ctxRes.body)).not.toContain(iss.body.token);
    expect(JSON.stringify(ctxRes.body)).not.toContain('454821');
    // The releaser sees the history with the token masked; Sales sees it in full.
    const hist = await ctx.api.get(`/api/release-slips/orders/${so}/authorizations`).set(bearer(releaser.token));
    expect(hist.body.history[0].token).toBe('PICKUP-••••');
    expect((await ctx.api.get(`/api/release-slips/orders/${so}/authorizations`).set(H())).body.history[0].token).toBe(iss.body.token);

    await ctx.api.post(`/api/orders/${so}/release`).set(bearer(releaser.token)).send({ codes: [codes[0]!] });
    const before = await onHand(product);
    const wrong = await slip(so, { authorization_token: 'PICKUP-AAAA' });
    expect(wrong.status).toBe(409);
    expect(wrong.body.blocked).toBe('authorization');
    expect(await onHand(product)).toBe(before);
    expect((await ctx.api.get(`/api/release-slips/orders/${so}/verify-token?token=${iss.body.token.toLowerCase()}`).set(bearer(releaser.token))).body).toEqual({ ok: true });
    const ok = await slip(so, { authorization_token: iss.body.token, acknowledged: true, seal_tag: 'PKG-0142' });
    expect(ok.status).toBe(201);
    const after = await ctx.api.get(`/api/release-slips/orders/${so}/authorizations`).set(H());
    expect(after.body.current.state).toBe('used');
  });

  it('refuses a revoked or replaced authorization with zero stock change', async () => {
    const { product, codes } = await productWithUnits('RA2', 1);
    const so = await approvedOrder(product, 1);
    const first = await issue(so);
    const second = await issue(so, { mode: 'delivery', recipient_name: 'Truck 02 driver' });
    expect(second.body.token).toMatch(/^DELIV-/);
    await ctx.api.post(`/api/orders/${so}/release`).set(bearer(releaser.token)).send({ codes: [codes[0]!] });
    const before = await onHand(product);
    expect((await slip(so, { authorization_token: first.body.token })).status).toBe(409); // replaced
    expect((await ctx.api.post(`/api/release-slips/orders/${so}/authorizations/revoke`).set(H()).send({ reason: 'Customer called — hold' })).status).toBe(200);
    const revoked = await slip(so, { authorization_token: second.body.token });
    expect(revoked.status).toBe(409);
    expect(revoked.body.error).toMatch(/revoked: Customer called/);
    expect(await onHand(product)).toBe(before);
  });

  it('is required for every order by default, until the company turns it off', async () => {
    const { product, codes } = await productWithUnits('RA3', 1);
    const so = await approvedOrder(product, 1);
    await ctx.api.post(`/api/orders/${so}/release`).set(bearer(releaser.token)).send({ codes: [codes[0]!] });
    expect((await ctx.api.get('/api/release-slips/policy').set(H())).body.authorization_required).toBe(true);
    const none = await slip(so);
    expect(none.status).toBe(409);
    expect(none.body.error).toMatch(/no release authorization/i);
    await ctx.api.put('/api/release-slips/policy').set(H()).send({ authorization_required: false });
    expect((await slip(so)).status).toBe(201);
  });

  it('lets a supervisor approve releasing without the token, with a reason, once', async () => {
    await ctx.api.put('/api/release-slips/policy').set(H()).send({ authorization_required: true });
    const { product, codes } = await productWithUnits('OV', 1);
    const so = await approvedOrder(product, 1);
    await ctx.api.post(`/api/orders/${so}/release`).set(bearer(releaser.token)).send({ codes: [codes[0]!] });
    // No valid authorization: nothing to override.
    expect((await ctx.api.post(`/api/release-slips/orders/${so}/override-request`).set(bearer(releaser.token)).send({ reason: 'Lost the token' })).status).toBe(409);
    await issue(so);
    await subscribe(token, 'sup-ov');
    __sentPush.length = 0;
    const asked = await ctx.api.post(`/api/release-slips/orders/${so}/override-request`).set(bearer(releaser.token)).send({ reason: 'Recipient lost the token SMS' });
    expect(asked.status).toBe(201);
    expect(asked.body.override).toMatchObject({ status: 'requested', reason: 'Recipient lost the token SMS' });
    expect(__sentPush.some((p) => /Release without token\? SO-/.test(p.payload.title))).toBe(true);
    // The releaser can't approve it, and the slip still needs the token meanwhile.
    expect((await ctx.api.post(`/api/release-slips/orders/${so}/override`).set(bearer(releaser.token)).send({ reason: 'self approve' })).status).toBe(403);
    const before = await onHand(product);
    expect((await slip(so)).body.blocked).toBe('authorization');
    expect((await ctx.api.post(`/api/release-slips/orders/${so}/override`).set(H()).send({ reason: 'x' })).status).toBe(400);
    const ok = await ctx.api.post(`/api/release-slips/orders/${so}/override`).set(H()).send({ reason: 'ID checked in person against the order' });
    expect(ok.body.override).toMatchObject({ status: 'approved', decision_note: 'ID checked in person against the order' });
    expect(await onHand(product)).toBe(before);
    const res = await slip(so);
    expect(res.status).toBe(201);
    const sl = (await ctx.api.get(`/api/release-slips/${res.body.id}`).set(H())).body;
    expect(sl).toMatchObject({ override_reason: 'ID checked in person against the order', override_by_name: expect.any(String) });
  });

  it('a declined override leaves the token required', async () => {
    const { product, codes } = await productWithUnits('OD', 1);
    const so = await approvedOrder(product, 1);
    await ctx.api.post(`/api/orders/${so}/release`).set(bearer(releaser.token)).send({ codes: [codes[0]!] });
    await issue(so);
    expect((await ctx.api.post(`/api/release-slips/orders/${so}/override`).set(H()).send({ approve: false, reason: 'Nothing to decline yet' })).status).toBe(409);
    await ctx.api.post(`/api/release-slips/orders/${so}/override-request`).set(bearer(releaser.token)).send({ reason: 'Token not received' });
    const no = await ctx.api.post(`/api/release-slips/orders/${so}/override`).set(H()).send({ approve: false, reason: 'Ask Sales to resend it' });
    expect(no.body.override.status).toBe('declined');
    expect((await slip(so)).body.blocked).toBe('authorization');
  });
});

describe('phone app evidence', () => {
  it('refuses a warehouse-out from the phone without a handoff photo; the slip takes the photos over', async () => {
    await ctx.api.put('/api/release-slips/policy').set(H()).send({ authorization_required: false });
    const { product, codes } = await productWithUnits('EV', 1);
    const so = await approvedOrder(product, 1);
    await ctx.api.post(`/api/orders/${so}/release`).set(bearer(releaser.token)).send({ codes: [codes[0]!] });
    const before = await onHand(product);
    const phone = { ...bearer(releaser.token), 'X-Client': 'mobile' };
    const bare = await ctx.api.post(`/api/orders/${so}/release-slip`).set(phone).send({ collected_by: 'Jordan D.' });
    expect(bare.status).toBe(409);
    expect(bare.body.blocked).toBe('evidence');
    expect(await onHand(product)).toBe(before);
    const up = await ctx.api.post('/api/attachments').set(phone).field('kind', 'release_proof').field('ref_id', String(so)).attach('image', PNG, 'handoff.png');
    expect(up.status).toBe(201);
    // A photo that isn't this order's doesn't count.
    expect((await ctx.api.post(`/api/orders/${so}/release-slip`).set(phone).send({ collected_by: 'Jordan D.', evidence_ids: [up.body.id + 999] })).body.blocked).toBe('evidence');
    const ok = await ctx.api.post(`/api/orders/${so}/release-slip`).set(phone).send({ collected_by: 'Jordan D.', evidence_ids: [up.body.id] });
    expect(ok.status).toBe(201);
    const photos = (await ctx.api.get(`/api/attachments?kind=release&ref_id=${ok.body.id}`).set(H())).body;
    expect(photos.map((p: { id: number }) => p.id)).toEqual([up.body.id]);
  });

  it('holds the desktop app to the same rule; a scripted API call is not', async () => {
    const { product, codes } = await productWithUnits('EW', 1);
    const so = await approvedOrder(product, 1);
    await ctx.api.post(`/api/orders/${so}/release`).set(bearer(releaser.token)).send({ codes: [codes[0]!] });
    const desk = await ctx.api.post(`/api/orders/${so}/release-slip`).set({ ...bearer(releaser.token), 'X-Client': 'desktop' }).send({ collected_by: 'Jordan D.' });
    expect(desk.body.blocked).toBe('evidence');
    expect((await slip(so)).status).toBe(201); // no app header: an integration / test client
  });
});

describe('package checklist', () => {
  it('blocks the slip until every required item is confirmed', async () => {
    const { product, codes } = await productWithUnits('PK', 1);
    expect((await ctx.api.put(`/api/finished-products/${product}/package`).set(H()).send({ items: [
      { label: 'Charger and cable', required: true }, { label: 'Keys (2)', required: true }, { label: 'Sticker sheet', required: false },
    ] })).status).toBe(200);
    const so = await approvedOrder(product, 1);
    await ctx.api.post(`/api/orders/${so}/release`).set(bearer(releaser.token)).send({ codes: [codes[0]!] });
    const c = await ctx.api.get(`/api/release-slips/orders/${so}/context`).set(bearer(releaser.token));
    expect(c.body.package.map((p: { label: string }) => p.label)).toEqual(['Charger and cable', 'Keys (2)', 'Sticker sheet']);
    const before = await onHand(product);
    const missing = await slip(so, { package: [{ item_id: product, label: 'Charger and cable', ok: true }] });
    expect(missing.status).toBe(409);
    expect(missing.body).toMatchObject({ blocked: 'package', missing: ['Bike: Keys (2)'] });
    expect(await onHand(product)).toBe(before);
    const ok = await slip(so, { package: [{ item_id: product, label: 'Charger and cable', ok: true }, { item_id: product, label: 'Keys (2)', ok: true }] });
    expect(ok.status).toBe(201);
  });
});

describe('partial release', () => {
  it('needs an authorization that allows it, then splits the rest into a backorder', async () => {
    const { product, codes } = await productWithUnits('PR', 1);
    const so = await approvedOrder(product, 2);
    await ctx.api.post(`/api/orders/${so}/release`).set(bearer(releaser.token)).send({ codes: [codes[0]!] });
    const early = await slip(so);
    expect(early.body).toMatchObject({ blocked: 'incomplete' });
    const iss = await issue(so, { partial_allowed: true });
    const res = await slip(so, { authorization_token: iss.body.token });
    expect(res.status).toBe(201);
    expect(res.body.backorder.number).toMatch(/^SO-/);
    const orig = (await ctx.api.get(`/api/orders/${so}`).set(H())).body;
    expect(orig.status).toBe('confirmed');
    expect(orig.items[0].quantity).toBe(1);
    expect(orig.total).toBe(100);
    const bo = (await ctx.api.get(`/api/orders/${res.body.backorder.id}`).set(H())).body;
    expect(bo).toMatchObject({ status: 'approved', total: 100 });
    expect(bo.items[0]).toMatchObject({ item_id: product, quantity: 1 });
  });
});

describe('scan check and reports', () => {
  it('tells the releaser whether a scanned label belongs to this order', async () => {
    const { product, codes } = await productWithUnits('SC', 2);
    const a = await approvedOrder(product, 1);
    const b = await approvedOrder(product, 1);
    await subscribe(token, 'sales-rep');
    __sentPush.length = 0;
    await ctx.api.post(`/api/orders/${a}/release`).set(bearer(releaser.token)).send({ codes: [codes[0]!] });
    const chk = (order: number, code: string) => ctx.api.get(`/api/release-slips/orders/${order}/unit?code=${code}`).set(bearer(releaser.token));
    expect((await chk(a, codes[0]!)).body.state).toBe('allocated');
    expect((await chk(b, codes[0]!)).body).toMatchObject({ state: 'other_order' });
    expect((await chk(b, codes[1]!)).body.state).toBe('available');
    expect((await chk(b, 'NOPE-1')).body.state).toBe('not_found');
    const rep = await ctx.api.post(`/api/release-slips/orders/${b}/reports`).set(bearer(releaser.token))
      .send({ kind: 'unit_mismatch', description: `Scanned ${codes[0]} which is allocated to another order`, unit_identifier: codes[0] });
    expect(rep.status).toBe(201);
    const bNo = (await ctx.api.get(`/api/orders/${b}`).set(H())).body.number;
    expect(__sentPush.some((p) => p.payload.title === 'Release report — ' + bNo)).toBe(true);
    const q = await ctx.api.get('/api/release-slips/queue').set(bearer(releaser.token));
    const row = [...q.body.to_accept, ...q.body.releasing].find((r: { id: number }) => r.id === b);
    expect(row.open_reports).toBe(1);
    expect((await ctx.api.post(`/api/release-slips/reports/${rep.body.id}/resolve`).set(H()).send({ resolution: 'Rescanned' })).status).toBe(200);
  });
});
