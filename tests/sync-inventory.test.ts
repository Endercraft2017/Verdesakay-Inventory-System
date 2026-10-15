/**
 * Offline-first sync, phase 2 (docs/OFFLINE-FIRST.md): inventory works on an installed node.
 * Stock movements are `physical` — accepted beyond recorded stock and flagged as a stock
 * discrepancy (decision D1); new master records are `merge`; edits, deletes and settings are
 * `claim` (refused on a PC that belongs to no site); item photos are `claim` too (phase 3e).
 */
import fs from 'node:fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cleanup } from './helpers';
import { setupSyncPair, type SyncPair } from './sync-helpers';

let P: SyncPair;
let loc2: number; // a second location, created on the cloud before enrolment

const api = () => P.ctx.api;
const qtyAt = (conn: import('node:sqlite').DatabaseSync, item: number, loc: number) =>
  (conn.prepare('SELECT quantity FROM inventory_stock WHERE item_id = ? AND location_id = ?').get(item, loc) as { quantity: number } | undefined)?.quantity ?? 0;
const defaultLoc = (conn: import('node:sqlite').DatabaseSync) =>
  (conn.prepare('SELECT id FROM locations WHERE is_default = 1').get() as { id: number }).id;
const openDiscrepancies = (conn: import('node:sqlite').DatabaseSync, item: number) =>
  conn.prepare("SELECT id, change, location_balance_after, reason FROM stock_discrepancies WHERE item_id = ? AND status = 'open' ORDER BY id").all(item);

async function cloudItem(qty: number): Promise<number> {
  const r = await api().post('/api/inventory').set(P.cloudHdr()).send({ name: 'Inv ' + Math.random(), quantity: qty });
  expect(r.status).toBe(201);
  return r.body.id as number;
}

beforeAll(async () => {
  P = await setupSyncPair('plant-b', 9);
  const l = await api().post('/api/locations').set(P.cloudHdr()).send({ name: 'Yard', type: 'warehouse' });
  expect(l.status).toBe(201);
  loc2 = l.body.id as number;
  await P.enrol();
});
afterAll(() => cleanup(P.ctx));

describe('decision D1 — an offline stock-out beyond recorded stock', () => {
  it('replays an interrupted local acknowledgement with its original sync command', async () => {
    const id = await cloudItem(10);
    await P.round();
    const key = 'local-ack-retry-001';
    const first = await api().post(`/api/inventory/${id}/adjust`).set(P.nodeHdr()).set('Idempotency-Key', key).send({ change: -2 });
    expect(first.status).toBe(200);
    expect(first.headers['x-sync-state']).toBe('local');
    expect(first.headers['x-sync-command']).toBeTruthy();
    const retry = await api().post(`/api/inventory/${id}/adjust`).set(P.nodeHdr()).set('Idempotency-Key', key).send({ change: -2 });
    expect(retry.body).toEqual(first.body);
    expect(retry.headers['idempotency-replayed']).toBe('true');
    expect(retry.headers['x-sync-state']).toBe('local');
    expect(retry.headers['x-sync-command']).toBe(first.headers['x-sync-command']);
    expect(qtyAt(P.nodeDb(), id, defaultLoc(P.nodeDb()))).toBe(8);
    const { pushed } = await P.round();
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.state).toBe('confirmed');
  });

  it('is accepted on the node, takes the location below zero, and opens a discrepancy', async () => {
    const id = await cloudItem(3);
    await P.round();
    const r = await api().post(`/api/inventory/${id}/adjust`).set(P.nodeHdr()).send({ change: -5, reason: 'Loaded on truck' });
    expect(r.status).toBe(200);
    expect(r.body.location_quantity).toBe(-2);
    expect(r.body.discrepancy_id).toBeGreaterThan(0);
    expect(openDiscrepancies(P.nodeDb(), id)).toEqual([
      { id: r.body.discrepancy_id, change: -5, location_balance_after: -2, reason: 'Loaded on truck (assembled balance)' },
    ]);

    // After sync the cloud agrees — same balance, same discrepancy row (same id).
    const { pushed } = await P.round();
    expect(pushed.map((p) => p.state)).toEqual(['confirmed']);
    expect(qtyAt(P.cloudDb(), id, defaultLoc(P.cloudDb()))).toBe(-2);
    expect(openDiscrepancies(P.cloudDb(), id)).toEqual(openDiscrepancies(P.nodeDb(), id));
  });

  it('is flagged by the cloud when stock was there on the node but not by the time it synced', async () => {
    const id = await cloudItem(10);
    await P.round();
    // Node: 10 − 8 = 2, fine locally. Cloud meanwhile: 10 − 5 = 5.
    const n = await api().post(`/api/inventory/${id}/adjust`).set(P.nodeHdr()).send({ change: -8, reason: 'Offline pick' });
    expect(n.body.discrepancy_id).toBeUndefined();
    await api().post(`/api/inventory/${id}/adjust`).set(P.cloudHdr()).send({ change: -5, reason: 'Online pick' });

    const { pushed } = await P.round();
    expect(pushed[0]!.state).toBe('confirmed'); // never rejected for a state reason
    const cloudFlags = openDiscrepancies(P.cloudDb(), id);
    expect(cloudFlags).toMatchObject([{ change: -8, location_balance_after: -3, reason: 'Offline pick (assembled balance)' }]);
    expect(openDiscrepancies(P.nodeDb(), id)).toEqual(cloudFlags); // the flag reaches the node
    expect(qtyAt(P.nodeDb(), id, defaultLoc(P.nodeDb()))).toBe(-3);
  });

  it('applies to damage reports and transfers too', async () => {
    const id = await cloudItem(2);
    await P.round();
    const dmg = await api().post(`/api/inventory/${id}/damage`).set(P.nodeHdr()).send({ quantity: 3, reason: 'Crushed' });
    expect(dmg.status).toBe(200);
    const tr = await api().post(`/api/inventory/${id}/transfer`).set(P.nodeHdr())
      .send({ from_location_id: defaultLoc(P.nodeDb()), to_location_id: loc2, amount: 4, reason: 'To yard' });
    expect(tr.status).toBe(200);
    expect(tr.body).toMatchObject({ from: -5, to: 4 });
    await P.round();
    expect(qtyAt(P.cloudDb(), id, defaultLoc(P.cloudDb()))).toBe(-5);
    expect(qtyAt(P.cloudDb(), id, loc2)).toBe(4);
    expect(openDiscrepancies(P.cloudDb(), id)).toHaveLength(2);
  });

  it('does not change online behaviour: a direct request to the cloud is still refused', async () => {
    const id = await cloudItem(1);
    const r = await api().post(`/api/inventory/${id}/adjust`).set(P.cloudHdr()).send({ change: -2 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Not enough stock/);
    expect(openDiscrepancies(P.cloudDb(), id)).toHaveLength(0);
  });
});

describe('stock discrepancies', () => {
  it('are listed with their item, location and current balance, and resolved online', async () => {
    const id = await cloudItem(0);
    await P.round();
    await api().post(`/api/inventory/${id}/adjust`).set(P.nodeHdr()).send({ change: -1, reason: 'Found short' });
    await P.round();

    const list = await api().get('/api/inventory/discrepancies').set(P.cloudHdr());
    expect(list.status).toBe(200);
    const row = (list.body as Array<Record<string, unknown>>).find((d) => d.item_id === id)!;
    expect(row).toMatchObject({ status: 'open', change: -1, location_balance_after: -1, location_quantity_now: -1 });
    expect(row.location_name).toBeTruthy();

    // Resolving is a decision: refused on the node until site hosts exist…
    const onNode = await api().post(`/api/inventory/discrepancies/${row.id}/resolve`).set(P.nodeHdr()).send({ note: 'Counted' });
    expect(onNode.status).toBe(503);
    expect(onNode.body.sync).toBe('claim');
    // …and done on the cloud, which the node then sees.
    expect((await api().post(`/api/inventory/discrepancies/${row.id}/resolve`).set(P.cloudHdr()).send({ note: '' })).status).toBe(400);
    const ok = await api().post(`/api/inventory/discrepancies/${row.id}/resolve`).set(P.cloudHdr()).send({ note: 'Counted: 0 on shelf, adjusted' });
    expect(ok.status).toBe(200);
    const again = await api().post(`/api/inventory/discrepancies/${row.id}/resolve`).set(P.cloudHdr()).send({ note: 'x' });
    expect(again.status).toBe(409);
    await P.round();
    expect(P.nodeDb().prepare('SELECT status, resolution_note FROM stock_discrepancies WHERE id = ?').get(row.id as number))
      .toEqual({ status: 'resolved', resolution_note: 'Counted: 0 on shelf, adjusted' });
    const resolved = await api().get('/api/inventory/discrepancies?status=resolved').set(P.nodeHdr());
    expect((resolved.body as Array<{ id: number }>).some((d) => d.id === row.id)).toBe(true);
  });
});

describe('new records made offline (merge)', () => {
  it('an item created and moved offline syncs with the ids the node gave it', async () => {
    const c = await api().post('/api/inventory').set(P.nodeHdr()).send({ name: 'Made offline', sku: 'OFF-1', quantity: 5 });
    expect(c.status).toBe(201);
    const id = c.body.id as number;
    expect(id).toBeGreaterThanOrEqual(9 * 2 ** 37); // node 9's range
    // A second command refers to the first one's new id before anything has synced.
    const a = await api().post(`/api/inventory/${id}/adjust`).set(P.nodeHdr()).send({ change: -2 });
    expect(a.body.quantity).toBe(3);

    const { pushed } = await P.round();
    expect(pushed.map((p) => p.state)).toEqual(['confirmed', 'confirmed']);
    expect(P.cloudDb().prepare('SELECT id, sku, quantity FROM inventory_items WHERE id = ?').get(id))
      .toEqual({ id, sku: 'OFF-1', quantity: 3 });
  });

  it('locations, suppliers and customers too', async () => {
    const l = await api().post('/api/locations').set(P.nodeHdr()).send({ name: 'Offline bay', type: 'warehouse' });
    const s = await api().post('/api/suppliers').set(P.nodeHdr()).send({ name: 'Offline Supplier Co' });
    const c = await api().post('/api/customers').set(P.nodeHdr()).send({ name: 'Offline Customer Inc' });
    expect([l.status, s.status, c.status]).toEqual([201, 201, 201]);
    await P.round();
    expect(P.cloudDb().prepare('SELECT name FROM locations WHERE id = ?').get(l.body.id)).toEqual({ name: 'Offline bay' });
    expect(P.cloudDb().prepare('SELECT name FROM suppliers WHERE id = ?').get(s.body.id)).toEqual({ name: 'Offline Supplier Co' });
    expect(P.cloudDb().prepare('SELECT name FROM customers WHERE id = ?').get(c.body.id)).toEqual({ name: 'Offline Customer Inc' });
  });

  it('a duplicate SKU made offline is rejected at sync and undone on the node', async () => {
    await api().post('/api/inventory').set(P.cloudHdr()).send({ name: 'Cloud SKU', sku: 'DUP-9', quantity: 0 });
    const c = await api().post('/api/inventory').set(P.nodeHdr()).send({ name: 'Node SKU', sku: 'DUP-9', quantity: 0 });
    expect(c.status).toBe(201); // the node hadn't seen the cloud's item yet
    const { pushed } = await P.round();
    expect(pushed[0]).toMatchObject({ state: 'rejected', response_status: 409 });
    expect(P.nodeDb().prepare("SELECT name FROM inventory_items WHERE sku = 'DUP-9'").all()).toEqual([{ name: 'Cloud SKU' }]);
  });
});

describe('what stays refused on a node', () => {
  it('edits, deletes, imports and settings need the site host (claim)', async () => {
    const id = await cloudItem(0);
    await P.round();
    const calls = [
      api().put(`/api/inventory/${id}`).set(P.nodeHdr()).send({ name: 'Renamed offline' }),
      api().delete(`/api/inventory/${id}`).set(P.nodeHdr()),
      api().post('/api/inventory/import').set(P.nodeHdr()).send({ csv: 'name\nX' }),
      api().put('/api/inventory/form-config').set(P.nodeHdr()).send({}),
      api().post('/api/inventory/reorder-po').set(P.nodeHdr()).send({}),
      api().put(`/api/locations/${loc2}`).set(P.nodeHdr()).send({ name: 'Renamed' }),
      api().post(`/api/locations/${loc2}/default`).set(P.nodeHdr()),
      api().delete(`/api/locations/${loc2}`).set(P.nodeHdr()),
    ];
    for (const r of await Promise.all(calls)) {
      expect(r.status).toBe(503);
      expect(r.body.sync).toBe('claim');
    }
    expect(P.nodeDb().prepare('SELECT name FROM inventory_items WHERE id = ?').get(id)).not.toEqual({ name: 'Renamed offline' });
  });

  it('photos are a site decision: refused on a PC that belongs to no site — before anything is written to disk', async () => {
    const id = await cloudItem(0);
    await P.round();
    const dir = P.dbmod.uploadDir(P.nodeSlug);
    const before = fs.readdirSync(dir).length;
    const r = await api().post(`/api/inventory/${id}/image`).set(P.nodeHdr())
      .attach('image', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { filename: 'x.jpg', contentType: 'image/jpeg' });
    expect(r.status).toBe(503);
    expect(r.body.sync).toBe('claim');
    expect(fs.readdirSync(dir).length).toBe(before);
  });
});
