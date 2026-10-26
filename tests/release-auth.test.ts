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
  it('needs an authorization that allows it, keeps the rest reserved on the same sales order', async () => {
    const { product, codes } = await productWithUnits('PR', 1);
    const so = await approvedOrder(product, 2);
    await ctx.api.post(`/api/orders/${so}/release`).set(bearer(releaser.token)).send({ codes: [codes[0]!] });
    const early = await slip(so);
    expect(early.body).toMatchObject({ blocked: 'incomplete' });
    const iss = await issue(so, { partial_allowed: true });
    const res = await slip(so, { authorization_token: iss.body.token });
    expect(res.status).toBe(201);
    expect(res.body.backorder).toBeNull();
    const orig = (await ctx.api.get(`/api/orders/${so}`).set(H())).body;
    expect(orig.status).toBe('approved');
    expect(orig.items[0]).toMatchObject({quantity:2,dispatched_qty:1,cancelled_qty:0});
    expect(orig.total).toBe(200);
    expect(orig.fulfillment).toMatchObject({remaining:1,dispatched:1,state:'partially_fulfilled'});
    const listing=(await ctx.api.get('/api/orders?type=sale').set(H())).body.find((r:{id:number})=>r.id===so);
    expect(listing).toMatchObject({fulfillment_remaining:1,fulfillment_dispatched:1});

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

/** The Sales-issued assignment selects the policy. Requests cannot choose a weaker path. */
describe('internal staff handoff', () => {
  let db: typeof import('../src/shared/db');
  let receiver: Awaited<ReturnType<typeof createEmployee>>;
  beforeAll(async () => {
    db = await import('../src/shared/db');
    receiver = await createEmployee(ctx.api, token, { role: 'driver', full_name: 'Assigned staff receiver' });
    await ctx.api.put('/api/release-slips/policy').set(H()).send({ authorization_required: true });
  });
  async function assigned(prefix: string, checklist = false) {
    const { product, codes } = await productWithUnits(prefix, 1);
    if (checklist) await ctx.api.put(`/api/finished-products/${product}/package`).set(H())
      .send({ items: [{ label: 'Keys', required: true }] });
    const so = await approvedOrder(product, 1);
    const issued = await issue(so, { handoff_type: 'internal', receiver_user_id: receiver.id, recipient_name: 'Untrusted free text' });
    expect(issued.status).toBe(201);
    await ctx.api.post(`/api/orders/${so}/release`).set(bearer(releaser.token)).send({ codes });
    const authorization = issued.body.authorization;
    const payload = { handoff_type: 'internal', authorization_id: authorization.id, receiver_user_id: receiver.id,
      acknowledged: true, collected_by: 'Another untrusted name' };
    return { so, product, authorization, payload, issued };
  }
  async function signature(authId: number, headers = bearer(releaser.token)) {
    const res = await ctx.api.post('/api/attachments').set(headers).field('kind', 'release_acknowledgment')
      .field('ref_id', String(authId)).attach('image', PNG, 'signed.png');
    expect(res.status).toBe(201);
    return res.body.id as number;
  }
  it('migrates legacy authorizations and slips as external, and can run twice', async () => {
    // Reproduce the v97 shapes, retaining real legacy authorization/slip rows from the tests above.
    const columns = {
      release_authorizations: ['receiver_user_id', 'handoff_type'],
      release_slip_details: ['signature_attachment_id', 'receiver_user_id', 'handoff_type'],
    };
    const before = db.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM release_authorizations')!.n;
    expect(before).toBeGreaterThan(0);
    for (const [table, names] of Object.entries(columns)) for (const name of names) db.db.exec(`ALTER TABLE ${table} DROP COLUMN ${name}`);
    db.forceMigrate('default');
    db.forceMigrate('default');
    expect(db.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM release_authorizations')!.n).toBe(before);
    expect(db.queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM release_authorizations WHERE handoff_type!='external' OR receiver_user_id IS NOT NULL")!.n).toBe(0);
    expect(db.queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM release_slip_details WHERE handoff_type!='external' OR signature_attachment_id IS NOT NULL")!.n).toBe(0);
  });
  it('requires Sales permission and an active assigned staff account; no code is issued', async () => {
    const { so, issued } = await assigned('INT1');
    expect(issued.body.token).toBeNull();
    expect(issued.body.authorization).toMatchObject({ handoff_type: 'internal', receiver_user_id: receiver.id,
      recipient_name: 'Assigned staff receiver', token_required: false, token_hint: null, receiver_active: true });
    expect((await ctx.api.get('/api/release-slips/receivers').set(H())).body).toContainEqual({ id: receiver.id, full_name: 'Assigned staff receiver' });
    expect((await ctx.api.get('/api/release-slips/receivers').set(bearer(releaser.token))).status).toBe(403);
    expect((await ctx.api.post(`/api/release-slips/orders/${so}/authorizations`).set(bearer(releaser.token))
      .send({ mode: 'pickup', handoff_type: 'internal', receiver_user_id: receiver.id })).status).toBe(403);
    expect((await issue(so, { handoff_type: 'internal', receiver_user_id: null })).status).toBe(400);
    expect((await issue(so, { handoff_type: 'internal', receiver_user_id: 999999 })).status).toBe(400);
    db.run('UPDATE users SET active=0 WHERE id=?', receiver.id);
    expect((await issue(so, { handoff_type: 'internal', receiver_user_id: receiver.id })).status).toBe(400);
    db.run('UPDATE users SET active=1 WHERE id=?', receiver.id);
    expect((await ctx.api.get(`/api/release-slips/orders/${so}/authorizations`).set(bearer(releaser.token))).body.history[0].token).toBeNull();
    expect((await ctx.api.get(`/api/release-slips/orders/${so}/verify-token?token=anything`).set(bearer(releaser.token))).body).toMatchObject({ ok: false, error: expect.stringContaining('assigned-receiver acknowledgment') });
  });
  it('cannot switch an external authorization to an internal request or use an internal token override', async () => {
    const { so, payload } = await assigned('INT2');
    expect((await ctx.api.post(`/api/release-slips/orders/${so}/override-request`).set(bearer(releaser.token))
      .send({ reason: 'Skip signature' })).status).toBe(409);
    expect((await ctx.api.post(`/api/release-slips/orders/${so}/override`).set(H())
      .send({ reason: 'Skip signature' })).status).toBe(409);
    const external = await issue(so);
    expect(external.body.authorization).toMatchObject({ handoff_type: 'external', token_required: true });
    expect((await slip(so, { ...payload, authorization_id: external.body.authorization.id })).body.blocked).toBe('authorization');
    expect((await slip(so, { handoff_type: 'external' })).body.blocked).toBe('authorization');
    expect((await slip(so, { authorization_token: external.body.token })).status).toBe(201);
  });
  it('requires the exact active receiver, a real uploaded signature and explicit acknowledgment', async () => {
    const { so, product, authorization, payload } = await assigned('INT3');
    const before = await onHand(product);
    expect((await slip(so, payload)).body.blocked).toBe('acknowledgment');
    const ordinary = await ctx.api.post('/api/attachments').set(bearer(releaser.token)).field('kind', 'release_proof')
      .field('ref_id', String(so)).attach('image', PNG, 'photo.png');
    expect((await slip(so, { ...payload, signature_attachment_id: ordinary.body.id })).body.blocked).toBe('acknowledgment');
    const sig = await signature(authorization.id);
    expect((await slip(so, { ...payload, receiver_user_id: releaser.id, signature_attachment_id: sig })).body.blocked).toBe('receiver');
    expect((await slip(so, { ...payload, acknowledged: false, signature_attachment_id: sig })).body.blocked).toBe('acknowledgment');
    expect((await slip(so, { ...payload, authorization_id: authorization.id + 999, signature_attachment_id: sig })).body.blocked).toBe('authorization');
    db.run('UPDATE users SET active=0 WHERE id=?', receiver.id);
    expect((await slip(so, { ...payload, signature_attachment_id: sig })).body.blocked).toBe('receiver');
    expect((await ctx.api.get(`/api/release-slips/orders/${so}/context`).set(bearer(releaser.token))).body.authorization.receiver_active).toBe(false);
    db.run('UPDATE users SET active=1 WHERE id=?', receiver.id);
    expect(await onHand(product)).toBe(before);
    expect(db.queryOne('SELECT 1 FROM release_slips WHERE order_id=?', so)).toBeUndefined();
  });
  it('rejects empty signatures and signatures from another order or an old assignment', async () => {
    const a = await assigned('INT4A'), b = await assigned('INT4B');
    const oldSig = await signature(a.authorization.id);
    const empty = await ctx.api.post('/api/attachments').set(bearer(releaser.token)).field('kind', 'release_acknowledgment')
      .field('ref_id', String(b.authorization.id)).attach('image', Buffer.alloc(0), 'empty.png');
    expect(empty.status).toBe(409);
    expect((await slip(b.so, { ...b.payload, signature_attachment_id: oldSig })).body.blocked).toBe('acknowledgment');
    const replacement = await issue(a.so, { handoff_type: 'internal', receiver_user_id: releaser.id });
    expect((await slip(a.so, { ...a.payload, signature_attachment_id: oldSig })).body.blocked).toBe('authorization');
    expect((await slip(a.so, { ...a.payload, authorization_id: replacement.body.authorization.id,
      receiver_user_id: releaser.id, signature_attachment_id: oldSig })).body.blocked).toBe('acknowledgment');
    const staleUpload = await ctx.api.post('/api/attachments').set(bearer(releaser.token)).field('kind', 'release_acknowledgment')
      .field('ref_id', String(a.authorization.id)).attach('image', PNG, 'stale.png');
    expect(staleUpload.status).toBe(409);
    expect(await onHand(a.product)).toBe(1);
    expect(await onHand(b.product)).toBe(1);
  });
  it('continues to enforce expiry, revocation and package requirements without a code', async () => {
    const { so, product, authorization, payload } = await assigned('INT5', true);
    const sig = await signature(authorization.id);
    const signed = { ...payload, signature_attachment_id: sig };
    expect((await slip(so, signed)).body).toMatchObject({ blocked: 'package', missing: ['Bike: Keys'] });
    db.run("UPDATE release_authorizations SET valid_until=datetime('now','-1 minute') WHERE id=?", authorization.id);
    expect((await slip(so, signed)).body.blocked).toBe('authorization');
    db.run("UPDATE release_authorizations SET valid_until=datetime('now','+1 hour'),revoked_at=datetime('now') WHERE id=?", authorization.id);
    expect((await slip(so, signed)).body.blocked).toBe('authorization');
    expect(await onHand(product)).toBe(1);
  });
  it('records a signed internal handoff atomically and replays the same request without another stock movement', async () => {
    const { so, product, authorization, payload } = await assigned('INT6', true);
    const sig = await signature(authorization.id);
    const proof = await ctx.api.post('/api/attachments').set(bearer(releaser.token)).field('kind', 'release_proof')
      .field('ref_id', String(so)).attach('image', PNG, 'handoff.png');
    const body = { ...payload, signature_attachment_id: sig, evidence_ids: [proof.body.id], package: [{ item_id: product, label: 'Keys', ok: true }] };
    const submit = () => ctx.api.post(`/api/orders/${so}/release-slip`).set({ ...bearer(releaser.token), 'X-Client': 'mobile' })
      .set('Idempotency-Key', `internal-signed-${so}`).send(body);
    const invalidTrip = await slip(so, { ...body, delivery_id: 999999 });
    expect(invalidTrip.status).toBe(409);
    expect(await onHand(product)).toBe(1);
    expect(db.queryOne('SELECT kind,ref_id FROM attachments WHERE id=?', sig)).toEqual({ kind: 'release_acknowledgment', ref_id: authorization.id });
    expect(db.queryOne('SELECT used_slip_id FROM release_authorizations WHERE id=?', authorization.id)).toEqual({ used_slip_id: null });
    const result = await submit();
    expect(result.status).toBe(201);
    expect(await onHand(product)).toBe(0);
    const saved = (await ctx.api.get(`/api/release-slips/${result.body.id}`).set(H())).body;
    expect(saved).toMatchObject({ handoff_type: 'internal', receiver_user_id: receiver.id, signature_attachment_id: sig,
      acknowledged: 1, collected_by: 'Assigned staff receiver', approved_receiver_name: 'Assigned staff receiver' });
    expect(db.queryOne('SELECT kind,ref_id FROM attachments WHERE id=?', sig)).toEqual({ kind: 'release', ref_id: result.body.id });
    expect((await ctx.api.delete(`/api/attachments/${sig}`).set(bearer(releaser.token))).status).toBe(409);
    const replay = await submit();
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(result.body.id);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(await onHand(product)).toBe(0);
    expect(db.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM release_slips WHERE order_id=?', so)!.n).toBe(1);
  });
});
