/**
 * Offline-first sync, phase 4d (docs/OFFLINE-FIRST.md §23): purchasing offline. Goods arrive at
 * the site and are received on the site host while the internet is down — PR (purchase order), GRN
 * and BILL numbers from its blocks — and a bill is entered and approved at the main site; all of it reaches the
 * cloud identically. A receipt against a PO line removed on the cloud meanwhile, and an approval
 * whose 3-way match fails only on the cloud, stand, flagged (D6).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { cleanup } from './helpers';
import { setupSiteTrio, type SiteTrio } from './sync-helpers';

let T: SiteTrio;
let bay: number;      // the site's receiving warehouse
let supplier: number;
let resin: number;    // an item bought in
const api = () => T.ctx.api;
type H = Record<string, string>;

async function ok(p: Promise<import('supertest').Response>, status = 200) {
  const r = await p;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status} ${JSON.stringify(r.body)}`);
  return r;
}
const qtyOf = (conn: DatabaseSync, id: number) =>
  (conn.prepare('SELECT quantity FROM inventory_items WHERE id = ?').get(id) as { quantity: number }).quantity;
const receiptsOf = (conn: DatabaseSync, orderId: number) =>
  conn.prepare('SELECT number, location_id FROM goods_receipts WHERE order_id = ? ORDER BY id').all(orderId);
const billOf = (conn: DatabaseSync, id: number) =>
  conn.prepare('SELECT number, status, approved_at IS NOT NULL AS approved FROM vendor_bills WHERE id = ?').get(id);
const clashes = async () =>
  ((await ok(api().get('/api/sync/clashes').set(T.cloudHdr()))).body as Array<{ summary: string }>).map((c) => c.summary);

async function newPO(hdr: H, lines: Array<{ name: string; quantity: number; unit_price: number }>) {
  const po = (await ok(api().post('/api/orders').set(hdr).send({
    type: 'purchase', supplier_id: supplier,
    items: lines.map((l) => ({ item_id: resin, ...l })),
  }), 201)).body as { id: number; number: string };
  const items = (await ok(api().get(`/api/orders/${po.id}`).set(hdr))).body.items as Array<{ id: number; name: string; quantity: number; unit_price: number }>;
  return { ...po, items };
}
const receive = (hdr: H, po: { id: number; items: Array<{ id: number; name: string; quantity: number }> }) =>
  ok(api().post(`/api/purchasing/orders/${po.id}/receipts`).set(hdr).send({
    location_id: bay,
    lines: po.items.map((l) => ({ order_item_id: l.id, item_id: resin, name: l.name, quantity: l.quantity })),
  }), 201);
const enterBill = async (hdr: H, po: { id: number; items: Array<{ id: number; name: string; quantity: number; unit_price: number }> }) =>
  (await ok(api().post(`/api/purchasing/orders/${po.id}/bills`).set(hdr).send({
    vendor_ref: `INV-${po.id}`,
    lines: po.items.map((l) => ({ order_item_id: l.id, item_id: resin, name: l.name, quantity: l.quantity, unit_price: l.unit_price })),
  }), 201)).body as { id: number; number: string };

beforeAll(async () => {
  T = await setupSiteTrio(async ({ api: a, cloudHdr }) => {
    bay = (await a.post('/api/locations').set(cloudHdr()).send({ name: 'Receiving bay', type: 'warehouse' })).body.id;
    supplier = (await a.post('/api/suppliers').set(cloudHdr()).send({ name: 'Polymer Supply Co.' })).body.id;
    resin = (await a.post('/api/inventory').set(cloudHdr()).send({ name: 'Resin (kg)', quantity: 0 })).body.id;
  });
  // The receiving bay is the host's; company-wide records (bills) are decided at the main site: the host.
  await ok(api().put('/api/sync/sites').set(T.cloudHdr()).send({ main_host: T.hostNo, locations: [{ location_id: bay, host_node_no: T.hostNo }] }));
  // One purchase on the cloud, so the PO / GRN / BILL number series are in use (and leasable).
  const first = await newPO(T.cloudHdr(), [{ name: 'Resin', quantity: 1, unit_price: 50 }]);
  await receive(T.cloudHdr(), first);
  await enterBill(T.cloudHdr(), first);
  T.hostDb().prepare('DELETE FROM sync_seq_blocks').run(); // lease afresh now that the series exist
  await T.hostRound();
  await T.lanRound();
});
afterAll(() => {
  T.close();
  cleanup(T.ctx);
});

describe('purchasing while the internet is down', () => {
  let po: Awaited<ReturnType<typeof newPO>>;
  let bill: { id: number; number: string };

  it('the site raises a PO, receives the goods and approves the bill — with real numbers', async () => {
    T.cutOff('host');
    const before = qtyOf(T.hostDb(), resin);
    po = await newPO(T.hostHdr(), [{ name: 'Resin', quantity: 25, unit_price: 80 }]);
    expect(po.number).toMatch(/^PR-\d{5}$/); // purchase orders are numbered PR-
    const grn = (await receive(T.hostHdr(), po)).body as { number: string };
    expect(grn.number).toMatch(/^GRN-\d{5}$/);
    expect(qtyOf(T.hostDb(), resin)).toBe(before + 25);
    bill = await enterBill(T.hostHdr(), po);
    expect(bill.number).toMatch(/^BILL-\d{5}$/);
    const a = await ok(api().post(`/api/purchasing/bills/${bill.id}/approve`).set(T.hostHdr()).send({}));
    expect(a.body.match.ok).toBe(true);
  });

  it('reaches the cloud identically', async () => {
    T.reconnect('host');
    const r = await T.hostRound();
    expect(r.pushed.filter((p) => p.state !== 'confirmed')).toEqual([]);
    expect(receiptsOf(T.cloudDb(), po.id)).toEqual(receiptsOf(T.hostDb(), po.id));
    expect(billOf(T.cloudDb(), bill.id)).toEqual({ number: bill.number, status: 'approved', approved: 1 });
    expect(qtyOf(T.cloudDb(), resin)).toBe(qtyOf(T.hostDb(), resin));
    await T.lanRound();
    expect(billOf(T.lanDb(), bill.id)).toEqual(billOf(T.cloudDb(), bill.id));
  });

  it('a desk PC on the site LAN receives through its host', async () => {
    const p = await newPO(T.cloudHdr(), [{ name: 'Resin', quantity: 7, unit_price: 80 }]);
    await T.hostRound();
    await T.lanRound();
    T.cutOff('host');
    await receive(T.lanHdr(), p);
    await T.lanRound();
    T.reconnect('host');
    const r = await T.hostRound();
    expect(r.pushed.filter((x) => x.state !== 'confirmed')).toEqual([]);
    const [grn] = receiptsOf(T.cloudDb(), p.id) as Array<{ number: string }>;
    expect(grn!.number).toMatch(/^GRN-\d{5}$/); // the PC's provisional number became a real one at the host
    await T.lanRound();
    expect(receiptsOf(T.lanDb(), p.id)).toEqual(receiptsOf(T.cloudDb(), p.id));
  });
});

describe('the cloud changed meanwhile (D6)', () => {
  it('goods received against a PO line removed on the cloud are kept, unlinked, and flagged', async () => {
    const p = await newPO(T.cloudHdr(), [{ name: 'Resin', quantity: 5, unit_price: 80 }]);
    await T.hostRound();
    T.cutOff('host');
    const before = qtyOf(T.cloudDb(), resin);
    await receive(T.hostHdr(), p);
    // Online, someone rewrites the PO's lines (the old line is gone).
    await ok(api().put(`/api/orders/${p.id}`).set(T.cloudHdr()).send({
      supplier_id: supplier, items: [{ item_id: resin, name: 'Resin (revised)', quantity: 4, unit_price: 75 }],
    }));
    T.reconnect('host');
    const r = await T.hostRound();
    expect(r.pushed.filter((x) => x.state !== 'confirmed')).toEqual([]);
    expect(qtyOf(T.cloudDb(), resin)).toBe(before + 5); // the goods arrived
    const lines = T.cloudDb().prepare(
      'SELECT gi.order_item_id, gi.quantity FROM goods_receipt_items gi JOIN goods_receipts g ON g.id = gi.receipt_id WHERE g.order_id = ?'
    ).all(p.id);
    expect(lines).toEqual([{ order_item_id: null, quantity: 5 }]);
    expect((await clashes()).some((c) => c.includes(`Goods receipt on ${p.number}`))).toBe(true);
  });

  it('a bill approved at the main site stands when the cloud\'s 3-way match fails by now — flagged', async () => {
    const p = await newPO(T.cloudHdr(), [{ name: 'Resin', quantity: 3, unit_price: 80 }]);
    const grn = (await receive(T.cloudHdr(), p)).body as { id: number };
    const b = await enterBill(T.cloudHdr(), p);
    await T.hostRound();
    T.cutOff('host');
    await ok(api().post(`/api/purchasing/bills/${b.id}/approve`).set(T.hostHdr()).send({}));
    // Online, the receipt is reversed: the bill no longer matches what arrived.
    await ok(api().delete(`/api/purchasing/receipts/${grn.id}`).set(T.cloudHdr()));
    expect((await api().get(`/api/purchasing/bills/${b.id}`).set(T.cloudHdr())).body.match.ok).toBe(false);
    T.reconnect('host');
    const r = await T.hostRound();
    expect(r.pushed.filter((x) => x.state !== 'confirmed')).toEqual([]);
    expect(billOf(T.cloudDb(), b.id)).toMatchObject({ status: 'approved', approved: 1 });
    expect((await clashes()).some((c) => c.includes(`Vendor bill ${b.number} was approved at the main site`))).toBe(true);
  });

  it('a bill approved on both sides keeps the first approval — flagged', async () => {
    const p = await newPO(T.cloudHdr(), [{ name: 'Resin', quantity: 2, unit_price: 80 }]);
    await receive(T.cloudHdr(), p);
    const b = await enterBill(T.cloudHdr(), p);
    await T.hostRound();
    T.cutOff('host');
    await ok(api().post(`/api/purchasing/bills/${b.id}/approve`).set(T.hostHdr()).send({}));
    await ok(api().post(`/api/purchasing/bills/${b.id}/approve`).set(T.cloudHdr()).send({}));
    T.reconnect('host');
    const r = await T.hostRound();
    expect(r.pushed.filter((x) => x.state !== 'confirmed')).toEqual([]);
    expect((await clashes()).some((c) => c.includes(`Vendor bill ${b.number} was approved on the cloud and at the main site`))).toBe(true);
  });
});
