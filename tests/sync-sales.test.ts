/**
 * Offline-first sync, phase 4c (docs/OFFLINE-FIRST.md §22): sales-order release offline. A sale
 * order at the site's warehouse goes from entry to proof of delivery on the site host while the
 * internet is down — real numbers from the host's blocks — and reaches the cloud identically,
 * release-slip photos included. Checks that only fail because the cloud changed meanwhile stand,
 * flagged (D6); goods that left beyond recorded stock are accepted and flagged (D1).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { cleanup } from './helpers';
import { setupSiteTrio, type SiteTrio } from './sync-helpers';

let T: SiteTrio;
let bay: number;    // the site's warehouse
let widget: number; // a bulk item stocked there
const api = () => T.ctx.api;
type H = Record<string, string>;

async function ok(p: Promise<import('supertest').Response>, status = 200) {
  const r = await p;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status} ${JSON.stringify(r.body)}`);
  return r;
}
const qtyOf = (conn: DatabaseSync, id: number) =>
  (conn.prepare('SELECT quantity FROM inventory_items WHERE id = ?').get(id) as { quantity: number }).quantity;
const orderOf = (conn: DatabaseSync, id: number) =>
  conn.prepare('SELECT number, status, fulfilled_at IS NOT NULL AS fulfilled FROM orders WHERE id = ?').get(id);
const slipOf = (conn: DatabaseSync, orderId: number) =>
  conn.prepare('SELECT id, number, collected_by FROM release_slips WHERE order_id = ?').get(orderId) as
    { id: number; number: string; collected_by: string } | undefined;
const clashes = async () =>
  ((await ok(api().get('/api/sync/clashes').set(T.cloudHdr()))).body as Array<{ summary: string }>).map((c) => c.summary);

const newOrder = async (hdr: H, qty: number) =>
  (await ok(api().post('/api/orders').set(hdr).send({
    type: 'sale', customer_name: 'Casa Verde', location_id: bay,
    items: [{ item_id: widget, name: 'Widget', quantity: qty, unit_price: 100 }],
  }), 201)).body as { id: number; number: string };

/** Approve → warehouse accepts → release every unit → release slip (+ a photo). */
async function shipOut(hdr: H, id: number, qty: number, opts: { photo?: boolean; slip?: boolean } = {}) {
  await ok(api().post(`/api/orders/${id}/status`).set(hdr).send({ status: 'approved' }));
  await ok(api().post(`/api/orders/${id}/accept-release`).set(hdr).send({}));
  await ok(api().post(`/api/orders/${id}/release`).set(hdr).send({ bulk: [{ item_id: widget, quantity: qty }] }));
  if (opts.slip === false) return null;
  const slip = (await ok(api().post(`/api/orders/${id}/release-slip`).set(hdr).send({ collected_by: 'J. Driver', vehicle_plate: 'ABC 123' }), 201)).body.id as number;
  if (opts.photo !== false) {
    await ok(api().post('/api/attachments').set(hdr).field('kind', 'release').field('ref_id', String(slip))
      .attach('image', Buffer.from(`goods-out-${id}`), 'goods.png'), 201);
  }
  return slip;
}

const releasePhotos = (conn: DatabaseSync, slipId: number) =>
  (conn.prepare("SELECT image_path FROM attachments WHERE kind = 'release' AND ref_id = ?").all(slipId) as Array<{ image_path: string }>)
    .map((r) => r.image_path);

beforeAll(async () => {
  T = await setupSiteTrio(async ({ api: a, cloudHdr }) => {
    bay = (await a.post('/api/locations').set(cloudHdr()).send({ name: 'Site warehouse', type: 'warehouse' })).body.id;
    widget = (await a.post('/api/inventory').set(cloudHdr()).send({ name: 'Widget', quantity: 0 })).body.id;
    await a.post(`/api/inventory/${widget}/adjust`).set(cloudHdr()).send({ change: 100, location_id: bay, reason: 'Opening stock' });
    // Release authorizations are tests/release-auth.test.ts; this file is about sync.
    await a.put('/api/release-slips/policy').set(cloudHdr()).send({ authorization_required: false });
  });
  // The site's warehouse is the host's.
  await ok(api().put('/api/sync/sites').set(T.cloudHdr()).send({ locations: [{ location_id: bay, host_node_no: T.hostNo }] }));
  // One sale on the cloud, so the SO / RS / DEL number series are in use (and leasable).
  const first = await newOrder(T.cloudHdr(), 1);
  await shipOut(T.cloudHdr(), first.id, 1, { photo: false });
  await ok(api().post('/api/deliveries').set(T.cloudHdr()).send({ order_id: first.id }), 201);
  T.hostDb().prepare('DELETE FROM sync_seq_blocks').run(); // lease afresh now that the series exist
  await T.hostRound();
  await T.lanRound();
});
afterAll(() => {
  T.close();
  cleanup(T.ctx);
});

describe('a sale while the internet is down', () => {
  let order: { id: number; number: string };
  let slip: number;
  let delivery: { id: number; number: string };

  it('runs entirely on the site host: entry, approval, release, slip with a photo, delivery', async () => {
    T.cutOff('host');
    const before = qtyOf(T.hostDb(), widget);
    order = await newOrder(T.hostHdr(), 4);
    expect(order.number).toMatch(/^SO-\d{5}$/); // a real number from the host's block
    slip = (await shipOut(T.hostHdr(), order.id, 4))!;
    expect(slipOf(T.hostDb(), order.id)!.number).toMatch(/^RS-\d{5}$/);
    expect(orderOf(T.hostDb(), order.id)).toEqual({ number: order.number, status: 'confirmed', fulfilled: 1 });
    expect(qtyOf(T.hostDb(), widget)).toBe(before - 4);
    delivery = (await ok(api().post('/api/deliveries').set(T.hostHdr()).send({ order_id: order.id }), 201)).body;
    expect(delivery.number).toMatch(/^DEL-\d{5}$/);
    await ok(api().post(`/api/deliveries/${delivery.id}/status`).set(T.hostHdr()).send({ status: 'out_for_delivery' }));
    await ok(api().post(`/api/deliveries/${delivery.id}/complete`).set(T.hostHdr()).send({ outcome: 'delivered', recipient: 'Ms. Reyes' }));
  });

  it('reaches the cloud identically: numbers, statuses, stock and the slip photo', async () => {
    T.reconnect('host');
    const r = await T.hostRound();
    expect(r.pushed.filter((p) => p.state !== 'confirmed')).toEqual([]);
    expect(orderOf(T.cloudDb(), order.id)).toEqual(orderOf(T.hostDb(), order.id));
    expect(slipOf(T.cloudDb(), order.id)).toEqual(slipOf(T.hostDb(), order.id));
    expect(qtyOf(T.cloudDb(), widget)).toBe(qtyOf(T.hostDb(), widget));
    expect(T.cloudDb().prepare('SELECT number, status FROM deliveries WHERE id = ?').get(delivery.id))
      .toEqual({ number: delivery.number, status: 'delivered' });
    const photos = releasePhotos(T.cloudDb(), slip);
    expect(photos).toEqual(releasePhotos(T.hostDb(), slip));
    expect(photos).toHaveLength(1);
    expect(fs.existsSync(path.join(T.dbmod.uploadDir('default'), photos[0]!))).toBe(true);
    await T.lanRound();
    expect(orderOf(T.lanDb(), order.id)).toEqual(orderOf(T.cloudDb(), order.id));
    expect(fs.existsSync(path.join(T.dbmod.uploadDir(T.lanSlug), photos[0]!))).toBe(true);
  });
});

describe('a release slip from a desk PC on the site LAN', () => {
  it('goes through the host (real RS number there) and on to the cloud, photo included', async () => {
    const o = await newOrder(T.cloudHdr(), 2);
    await shipOut(T.cloudHdr(), o.id, 2, { slip: false });
    await T.hostRound();
    await T.lanRound();
    T.cutOff('host'); // the site has no internet; the desk PC still reaches its host
    const slip = (await ok(api().post(`/api/orders/${o.id}/release-slip`).set(T.lanHdr()).send({ collected_by: 'Walk-in' }), 201)).body.id as number;
    await ok(api().post('/api/attachments').set(T.lanHdr()).field('kind', 'release').field('ref_id', String(slip))
      .attach('image', Buffer.from(`desk-photo-${o.id}`), 'desk.png'), 201);
    await T.lanRound();
    expect(slipOf(T.hostDb(), o.id)!.number).toMatch(/^RS-\d{5}$/);
    T.reconnect('host');
    const r = await T.hostRound();
    expect(r.pushed.filter((p) => p.state !== 'confirmed')).toEqual([]);
    expect(slipOf(T.cloudDb(), o.id)).toEqual(slipOf(T.hostDb(), o.id));
    const [photo] = releasePhotos(T.cloudDb(), slip);
    expect(fs.readFileSync(path.join(T.dbmod.uploadDir('default'), photo!), 'utf8')).toBe(`desk-photo-${o.id}`);
    await T.lanRound();
    expect(slipOf(T.lanDb(), o.id)).toEqual(slipOf(T.cloudDb(), o.id)); // the PC's provisional number was replaced
  });
});

describe('the cloud changed meanwhile (D6) and goods left beyond stock (D1)', () => {
  it('an approval the site made with enough stock stands when the cloud is short by now — flagged', async () => {
    const o = await newOrder(T.cloudHdr(), 5);
    await T.hostRound();
    T.cutOff('host');
    await ok(api().post(`/api/orders/${o.id}/status`).set(T.hostHdr()).send({ status: 'approved' }));
    const left = qtyOf(T.cloudDb(), widget);
    await ok(api().post(`/api/inventory/${widget}/adjust`).set(T.cloudHdr()).send({ change: -(left - 2), location_id: bay, reason: 'Sold at the counter' }));
    // Online, the same approval would now be refused.
    const other = await newOrder(T.cloudHdr(), 5);
    expect((await api().post(`/api/orders/${other.id}/status`).set(T.cloudHdr()).send({ status: 'approved' })).status).toBe(409);
    T.reconnect('host');
    const r = await T.hostRound();
    expect(r.pushed.filter((p) => p.state !== 'confirmed')).toEqual([]);
    expect(orderOf(T.cloudDb(), o.id)).toMatchObject({ status: 'approved' });
    expect((await clashes()).some((c) => c.includes(`${o.number} was approved at the site`))).toBe(true);
  });

  it('the release slip for those goods lands too: stock goes below zero and is flagged', async () => {
    const o = (T.cloudDb().prepare("SELECT id, number FROM orders WHERE status = 'approved' ORDER BY id DESC LIMIT 1").get()) as { id: number; number: string };
    T.cutOff('host');
    await ok(api().post(`/api/orders/${o.id}/accept-release`).set(T.hostHdr()).send({}));
    await ok(api().post(`/api/orders/${o.id}/release`).set(T.hostHdr()).send({ bulk: [{ item_id: widget, quantity: 5 }] }));
    await ok(api().post(`/api/orders/${o.id}/release-slip`).set(T.hostHdr()).send({ collected_by: 'Truck 2' }), 201);
    T.reconnect('host');
    const r = await T.hostRound();
    expect(r.pushed.filter((p) => p.state !== 'confirmed')).toEqual([]);
    expect(qtyOf(T.cloudDb(), widget)).toBe(-3); // 2 left − 5 out
    expect(qtyOf(T.hostDb(), widget)).toBe(-3);
    const flags = T.cloudDb().prepare("SELECT change, location_balance_after FROM stock_discrepancies WHERE item_id = ? AND status = 'open'").all(widget);
    expect(flags).toEqual([{ change: -5, location_balance_after: -3 }]);
  });

  it('a proof of delivery stands over a cancellation made on the cloud meanwhile — flagged', async () => {
    await ok(api().post(`/api/inventory/${widget}/adjust`).set(T.cloudHdr()).send({ change: 50, location_id: bay, reason: 'Restock' }));
    const o = await newOrder(T.cloudHdr(), 1);
    const d = (await ok(api().post('/api/deliveries').set(T.cloudHdr()).send({ order_id: o.id }), 201)).body as { id: number; number: string };
    await T.hostRound();
    T.cutOff('host');
    await ok(api().post(`/api/deliveries/${d.id}/complete`).set(T.hostHdr()).send({ outcome: 'delivered', recipient: 'Guard on duty' }));
    await ok(api().post(`/api/deliveries/${d.id}/status`).set(T.cloudHdr()).send({ status: 'cancelled' }));
    T.reconnect('host');
    const r = await T.hostRound();
    expect(r.pushed.filter((p) => p.state !== 'confirmed')).toEqual([]);
    expect(T.cloudDb().prepare('SELECT status, pod_recipient FROM deliveries WHERE id = ?').get(d.id))
      .toEqual({ status: 'delivered', pod_recipient: 'Guard on duty' });
    expect((await clashes()).some((c) => c.includes(`Delivery ${d.number} was cancelled on the cloud`))).toBe(true);
  });
});
