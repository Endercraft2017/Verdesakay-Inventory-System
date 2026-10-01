/**
 * Offline-first sync, phase 4b (docs/OFFLINE-FIRST.md §21): production offline, with site number
 * blocks. A whole production run happens on the site host while the internet is down — the job
 * order gets a real number from the host's block — and reaches the cloud identically (numbers,
 * stock, unit photos). Releasing parts short on stock is accepted and flagged (D1); an approval made
 * on both sides stands with a clash flagged (D6).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cleanup } from './helpers';
import { setupSiteTrio, type SiteTrio } from './sync-helpers';

let T: SiteTrio;
let part: number;
let product: number;
const api = () => T.ctx.api;
type H = Record<string, string>;
const qtyOf = (conn: import('node:sqlite').DatabaseSync, id: number) =>
  (conn.prepare('SELECT quantity FROM inventory_items WHERE id = ?').get(id) as { quantity: number }).quantity;
const joOf = (conn: import('node:sqlite').DatabaseSync, id: number) =>
  conn.prepare('SELECT number, status, approved_at IS NOT NULL AS approved FROM job_orders WHERE id = ?').get(id);

async function ok(p: Promise<import('supertest').Response>, status = 200) {
  const r = await p;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status} ${JSON.stringify(r.body)}`);
  return r;
}

/** A full production run with `hdr` (cloud, host or LAN PC). Returns the job order id. */
async function produce(hdr: H, qty: number, units: number): Promise<{ id: number; number: string; slip: string | null; unitIds: number[] }> {
  const jo = await ok(api().post('/api/job-orders').set(hdr).send({ product_item_id: product, qty_ordered: qty, qc_stages: 1 }), 201);
  const id = jo.body.id as number;
  await ok(api().post(`/api/job-orders/${id}/approve`).set(hdr).send({}));
  await ok(api().post('/api/job-orders/warehouse-accept').set(hdr).send({ job_order_ids: [id] }));
  await ok(api().post('/api/job-orders/prepare').set(hdr).send({ job_orders: [{ id }] }));
  const rel = await ok(api().post(`/api/job-orders/${id}/release`).set(hdr).send({}));
  await ok(api().post(`/api/job-orders/${id}/accept`).set(hdr).send({}));
  const unitIds: number[] = [];
  for (let i = 0; i < units; i++) {
    const u = await ok(api().post(`/api/job-orders/${id}/units`).set(hdr)
      .field('identifier', `SN-${id}-${i}-${Math.floor(Math.random() * 1e6)}`)
      .attach('image', Buffer.from(`unit-photo-${id}-${i}`), 'unit.png'), 201);
    unitIds.push(u.body.id as number);
  }
  if (unitIds.length) await ok(api().post(`/api/job-orders/${id}/units/inspect`).set(hdr).send({ unit_ids: unitIds, result: 'pass' }));
  const rec = (await ok(api().get(`/api/job-orders/${id}/receivable`).set(hdr))).body;
  if (rec.units?.length) {
    await ok(api().post(`/api/job-orders/${id}/products-in`).set(hdr)
      .send({ location_id: rec.output_location_id, unit_ids: rec.units.map((u: { id: number }) => u.id) }), 201);
  }
  return { id, number: jo.body.number ?? (joOf(T.hostDb(), id) as { number: string } | undefined)?.number, slip: rel.body.slip_number ?? null, unitIds };
}

beforeAll(async () => {
  T = await setupSiteTrio();
  part = (await ok(api().post('/api/inventory').set(T.cloudHdr()).send({ name: 'Bracket', quantity: 100 }), 201)).body.id;
  product = (await ok(api().post('/api/inventory').set(T.cloudHdr()).send({ name: 'Shelf unit' }), 201)).body.id;
  await ok(api().put(`/api/finished-products/${product}`).set(T.cloudHdr()).send({ components: [{ component_item_id: part, quantity: 2 }] }));
  // One run on the cloud, so every production number series is in use (and leasable).
  await produce(T.cloudHdr(), 1, 1);
  // Company-wide decisions (job orders without a site location) are the main site's: the host's.
  await ok(api().put('/api/sync/sites').set(T.cloudHdr()).send({ main_host: T.hostNo }));
  T.hostDb().prepare('DELETE FROM sync_seq_blocks').run(); // lease afresh now that the series exist
  await T.hostRound();
  await T.lanRound();
});
afterAll(() => {
  T.close();
  cleanup(T.ctx);
});

describe('a production run while the internet is down', () => {
  let run: Awaited<ReturnType<typeof produce>>;

  it('happens entirely on the site host, with real numbers from its blocks', async () => {
    T.cutOff('host');
    const before = qtyOf(T.hostDb(), part);
    run = await produce(T.hostHdr(), 2, 2);
    const jo = joOf(T.hostDb(), run.id) as { number: string };
    expect(jo.number).toMatch(/^MO-\d{5}$/); // a real number, not MO-P…
    expect(qtyOf(T.hostDb(), part)).toBe(before - 4);
    expect(qtyOf(T.hostDb(), product)).toBe(1 + 2);
  });

  it('reaches the cloud identically: numbers, stock, statuses and the unit photos', async () => {
    T.reconnect('host');
    const r = await T.hostRound();
    expect(r.pushed.length).toBeGreaterThan(5);
    expect(r.pushed.every((p) => p.state === 'confirmed')).toBe(true);
    expect(joOf(T.cloudDb(), run.id)).toEqual(joOf(T.hostDb(), run.id));
    for (const id of [part, product]) expect(qtyOf(T.cloudDb(), id)).toBe(qtyOf(T.hostDb(), id));
    // Each unit's photo is a 'qc_unit' attachment; the files reached the cloud under the same names.
    const photos = T.cloudDb().prepare(`SELECT image_path FROM attachments WHERE kind = 'qc_unit' AND ref_id IN (?, ?)`)
      .all(...run.unitIds) as Array<{ image_path: string }>;
    expect(photos).toHaveLength(2);
    for (const p of photos) {
      expect(fs.existsSync(path.join(T.dbmod.uploadDir('default'), p.image_path))).toBe(true);
      expect(fs.existsSync(path.join(T.dbmod.uploadDir(T.hostSlug), p.image_path))).toBe(true);
    }
    await T.lanRound();
    expect(joOf(T.lanDb(), run.id)).toEqual(joOf(T.cloudDb(), run.id));
  });
});

describe('releasing parts that ran short meanwhile (D1)', () => {
  it('is accepted when it syncs — the parts left — and flagged as a stock discrepancy', async () => {
    const bolt = (await ok(api().post('/api/inventory').set(T.cloudHdr()).send({ name: 'Rare bolt', quantity: 6 }), 201)).body.id;
    const gadget = (await ok(api().post('/api/inventory').set(T.cloudHdr()).send({ name: 'Gadget' }), 201)).body.id;
    await ok(api().put(`/api/finished-products/${gadget}`).set(T.cloudHdr()).send({ components: [{ component_item_id: bolt, quantity: 3 }] }));
    await T.hostRound();
    T.cutOff('host');
    const h = T.hostHdr();
    const jo = await ok(api().post('/api/job-orders').set(h).send({ product_item_id: gadget, qty_ordered: 1, qc_stages: 1 }), 201);
    const id = jo.body.id as number;
    await ok(api().post(`/api/job-orders/${id}/approve`).set(h).send({}));
    await ok(api().post('/api/job-orders/warehouse-accept').set(h).send({ job_order_ids: [id] }));
    await ok(api().post('/api/job-orders/prepare').set(h).send({ job_orders: [{ id }] }));
    // Meanwhile, online, someone takes 5 of the 6 bolts.
    await ok(api().post(`/api/inventory/${bolt}/adjust`).set(T.cloudHdr()).send({ change: -5, reason: 'Used elsewhere' }));
    // The site still sees 6 and releases the kit (3).
    await ok(api().post(`/api/job-orders/${id}/release`).set(h).send({}));
    expect(qtyOf(T.hostDb(), bolt)).toBe(3);
    T.reconnect('host');
    const r = await T.hostRound();
    expect(r.pushed.filter((p) => p.state !== "confirmed")).toEqual([]); // never rejected for a stock reason
    expect(qtyOf(T.cloudDb(), bolt)).toBe(-2); // 6 − 5 − 3
    expect(qtyOf(T.hostDb(), bolt)).toBe(-2);
    const flags = T.cloudDb().prepare("SELECT change, location_balance_after FROM stock_discrepancies WHERE item_id = ? AND status = 'open'").all(bolt);
    expect(flags).toEqual([{ change: -3, location_balance_after: -2 }]);
  });
});

describe('an approval made on both sides (D6)', () => {
  it('the site\'s approval stands and the clash is flagged', async () => {
    const jo = await ok(api().post('/api/job-orders').set(T.cloudHdr()).send({ product_item_id: product, qty_ordered: 1, qc_stages: 1 }), 201);
    await T.hostRound();
    T.cutOff('host');
    await ok(api().post(`/api/job-orders/${jo.body.id}/approve`).set(T.hostHdr()).send({}));
    await ok(api().post(`/api/job-orders/${jo.body.id}/approve`).set(T.cloudHdr()).send({}));
    T.reconnect('host');
    const r = await T.hostRound();
    expect(r.pushed).toMatchObject([{ state: 'confirmed' }]);
    const clashes = (await ok(api().get('/api/sync/clashes').set(T.cloudHdr()))).body as Array<{ summary: string }>;
    expect(clashes.some((c) => c.summary.includes('approved on the cloud and at the site'))).toBe(true);
  });
});
