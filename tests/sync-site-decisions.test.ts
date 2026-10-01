/**
 * Offline-first sync, phase 3c-ii (docs/OFFLINE-FIRST.md §16; decisions D4, D6): home sites and
 * site decisions. While the internet is down a site decides its own records — on its host, or on
 * a LAN PC that can reach the host — and the cloud keeps that decision when it re-runs it,
 * flagging a clash-check that now fails instead of refusing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cleanup } from './helpers';
import { setupSiteTrio, type SiteTrio } from './sync-helpers';

let T: SiteTrio;
let bayH: number; // a location owned by the trio's host
let bayX: number; // a location owned by another site
let otherHost: number;
let itemId: number;
const api = () => T.ctx.api;
const nameOf = (conn: import('node:sqlite').DatabaseSync, id: number) =>
  (conn.prepare('SELECT name FROM locations WHERE id = ?').get(id) as { name: string } | undefined)?.name;
const everyone = async () => { await T.lanRound(); await T.hostRound(); await T.lanRound(); };

beforeAll(async () => {
  T = await setupSiteTrio(async ({ api: a, cloudHdr }) => {
    bayH = (await a.post('/api/locations').set(cloudHdr()).send({ name: 'Bay H', type: 'warehouse' })).body.id;
    bayX = (await a.post('/api/locations').set(cloudHdr()).send({ name: 'Bay X', type: 'warehouse' })).body.id;
    itemId = (await a.post('/api/inventory').set(cloudHdr()).send({ name: 'Decided item', quantity: 0 })).body.id;
  });
  otherHost = (await api().post('/api/sync/nodes').set(T.cloudHdr()).send({ name: 'Branch host', is_host: true })).body.node_no;
});
afterAll(() => {
  T.close();
  cleanup(T.ctx);
});

describe('setting up sites', () => {
  it('an admin names the main site and each location\'s site; the copies receive it', async () => {
    const bad = await api().put('/api/sync/sites').set(T.cloudHdr()).send({ main_host: T.lanNo });
    expect(bad.status).toBe(400); // a LAN PC is not a site host
    const ok = await api().put('/api/sync/sites').set(T.cloudHdr()).send({
      main_host: T.hostNo,
      locations: [{ location_id: bayH, host_node_no: T.hostNo }, { location_id: bayX, host_node_no: otherHost }],
    });
    expect(ok.status).toBe(200);
    const s = (await api().get('/api/sync/sites').set(T.cloudHdr())).body;
    expect(s.main_host).toBe(T.hostNo);
    expect(s.hosts.map((h: { node_no: number }) => h.node_no).sort()).toEqual([T.hostNo, otherHost].sort());
    expect(s.locations.find((l: { id: number }) => l.id === bayX).host_node_no).toBe(otherHost);
    expect((await api().put('/api/sync/sites').set(T.hostHdr()).send({ main_host: null })).status).toBe(409);
    await everyone();
    for (const db of [T.hostDb(), T.lanDb()]) {
      expect(db.prepare('SELECT host_node_no FROM location_sites WHERE location_id = ?').get(bayH)).toEqual({ host_node_no: T.hostNo });
    }
  });
});

describe('deciding while the internet is down', () => {
  it('the host decides its own locations and — as the main site — company-wide records', async () => {
    T.cutOff('host');
    const loc = await api().put(`/api/locations/${bayH}`).set(T.hostHdr()).send({ name: 'Bay H (renamed on site)' });
    expect(loc.status).toBe(200);
    expect(loc.headers['x-sync-state']).toBe('local');
    const item = await api().put(`/api/inventory/${itemId}`).set(T.hostHdr()).send({ name: 'Renamed at the main site' });
    expect(item.status).toBe(200);
  });

  it('but not another site\'s records', async () => {
    const r = await api().put(`/api/locations/${bayX}`).set(T.hostHdr()).send({ name: 'Not ours' });
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ sync: 'claim', error: expect.stringMatching(/another site/) });
  });

  it('a LAN PC decides its site\'s records only while it can reach its host', async () => {
    await T.lanRound(); // fresh contact with the host
    const ok = await api().put(`/api/locations/${bayH}`).set(T.lanHdr()).send({ name: 'Bay H (renamed on the desk)' });
    expect(ok.status).toBe(200);
    T.cutOff('lan');
    await expect(T.lanRound()).rejects.toBeInstanceOf(T.sync.SyncOfflineError);
    const r = await api().put(`/api/locations/${bayH}`).set(T.lanHdr()).send({ name: 'Blind' });
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/site host/);
    T.reconnect('lan');
    await T.lanRound();
    expect(nameOf(T.hostDb(), bayH)).toBe('Bay H (renamed on the desk)'); // the host took the desk's decision
  });

  it('the decisions reach the cloud when the host is back', async () => {
    T.reconnect('host');
    const r = await T.hostRound();
    expect(r.pushed.every((p) => p.state === 'confirmed')).toBe(true);
    await T.lanRound();
    for (const db of [T.cloudDb(), T.hostDb(), T.lanDb()]) {
      expect(nameOf(db, bayH)).toBe('Bay H (renamed on the desk)');
      expect(db.prepare('SELECT name FROM inventory_items WHERE id = ?').get(itemId)).toEqual({ name: 'Renamed at the main site' });
    }
  });
});

describe('the cloud keeps a site\'s decision (D6)', () => {
  it('a discrepancy the site resolved offline stays resolved, although the cloud resolved it meanwhile — and the clash is flagged', async () => {
    // An offline stock-out at Bay H opens a discrepancy there.
    T.cutOff('host');
    const out = await api().post(`/api/inventory/${itemId}/adjust`).set(T.hostHdr()).send({ change: -2, location_id: bayH, reason: 'Short' });
    const discId = out.body.discrepancy_id as number;
    expect(discId).toBeGreaterThan(0);
    T.reconnect('host');
    await T.hostRound();

    // Now both sides resolve it while apart.
    T.cutOff('host');
    const site = await api().post(`/api/inventory/discrepancies/${discId}/resolve`).set(T.hostHdr()).send({ note: 'Counted on site: 0' });
    expect(site.status).toBe(200);
    const cloud = await api().post(`/api/inventory/discrepancies/${discId}/resolve`).set(T.cloudHdr()).send({ note: 'Checked from HQ' });
    expect(cloud.status).toBe(200);

    T.reconnect('host');
    const r = await T.hostRound();
    expect(r.pushed).toMatchObject([{ state: 'confirmed' }]); // not rejected as "Already resolved"
    const clashes = (await api().get('/api/sync/clashes').set(T.cloudHdr())).body as Array<{ id: number; summary: string; host_node_no: number }>;
    expect(clashes).toHaveLength(1);
    expect(clashes[0]).toMatchObject({ host_node_no: T.hostNo });
    expect(clashes[0]!.summary).toMatch(new RegExp(`#${discId}.*Counted on site: 0`));
    // The first resolution (the cloud's) is what stands, everywhere.
    await T.lanRound();
    for (const db of [T.cloudDb(), T.hostDb(), T.lanDb()]) {
      expect(db.prepare('SELECT resolution_note FROM stock_discrepancies WHERE id = ?').get(discId)).toEqual({ resolution_note: 'Checked from HQ' });
    }

    const resolved = await api().post(`/api/sync/clashes/${clashes[0]!.id}/resolve`).set(T.cloudHdr()).send({ note: 'Fine — same count' });
    expect(resolved.status).toBe(200);
    expect((await api().get('/api/sync/clashes').set(T.cloudHdr())).body).toEqual([]);
  });

  it('the same clash from a direct request to the cloud is still refused', async () => {
    const out = await api().post(`/api/inventory/${itemId}/adjust`).set(T.hostHdr()).send({ change: -1, location_id: bayH });
    await T.hostRound();
    const id = out.body.discrepancy_id as number;
    expect((await api().post(`/api/inventory/discrepancies/${id}/resolve`).set(T.cloudHdr()).send({ note: 'a' })).status).toBe(200);
    expect((await api().post(`/api/inventory/discrepancies/${id}/resolve`).set(T.cloudHdr()).send({ note: 'b' })).status).toBe(409);
  });
});
