/**
 * Sync upkeep (phase 6, docs/OFFLINE-FIRST.md §32): a PC newer than its authority waits; a command
 * from outside the replay window is rejected for re-entry instead of being replayed; the effect
 * stream is trimmed once every PC has read it, and a PC that fell behind the trimmed point
 * re-syncs from a fresh copy with its unsent work kept.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cleanup } from './helpers';
import { setupSiteTrio, type SiteTrio } from './sync-helpers';

let T: SiteTrio;
let item: number;
const api = () => T.ctx.api;
const qty = (conn: import('node:sqlite').DatabaseSync) =>
  (conn.prepare('SELECT quantity FROM inventory_items WHERE id = ?').get(item) as { quantity: number }).quantity;

beforeAll(async () => {
  T = await setupSiteTrio(async ({ api: a, cloudHdr }) => {
    item = (await a.post('/api/inventory').set(cloudHdr()).send({ name: 'Upkeep widget', quantity: 20 })).body.id;
  });
  await T.hostRound();
  await T.lanRound();
}, 90_000);
afterAll(() => {
  T?.close();
  if (T) cleanup(T.ctx);
});

describe('version skew', () => {
  it('a PC newer than its authority is told to wait', async () => {
    const token = T.sync.remoteOf(T.hostDb())!.nodeToken;
    const r = await api().get('/api/sync/pull?since=0').set('X-Sync-Node-Token', token).set('X-Sync-App-Version', '99.0.0');
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('version_ahead');
    expect(r.body.error).toMatch(/newer/);
  });

  it('a command made with an app version outside the replay window is rejected for re-entry, not replayed', async () => {
    T.cutOff('host');
    await api().post(`/api/inventory/${item}/adjust`).set(T.hostHdr()).send({ change: -1, reason: 'Old app' });
    T.hostDb().prepare("UPDATE sync_commands SET app_version = '0.9.0' WHERE state = 'local'").run();
    T.reconnect('host');
    const r = await T.hostRound();
    expect(r.pushed).toMatchObject([{ state: 'rejected' }]);
    expect(r.pushed[0]!.error).toMatch(/app version 0\.9\.0/);
    expect(qty(T.cloudDb())).toBe(20);
    expect(qty(T.hostDb())).toBe(20); // the host's copy follows the cloud; the action waits in Needs attention
  });
});

describe('trimming the effect stream', () => {
  it('drops effects every PC has read; a PC behind the trimmed point re-syncs, keeping its unsent work', async () => {
    const maint = await import('../src/sync/maintenance');
    // Some changes on the cloud; the host reads them, the LAN PC doesn't (it is "away").
    for (let i = 0; i < 3; i++) await api().post(`/api/inventory/${item}/adjust`).set(T.cloudHdr()).send({ change: 1, reason: `Cloud ${i}` });
    await T.hostRound();
    await T.hostRound(); // reports how far it has read
    // Age the stream, and let the LAN PC count as gone for a while (not holding the stream back).
    T.cloudDb().prepare("UPDATE sync_effects SET created_at = datetime('now', '-30 days')").run();
    T.cloudDb().prepare("UPDATE sync_nodes SET last_seen_at = datetime('now', '-60 days') WHERE node_no = ?").run(T.lanNo);
    const before = (T.cloudDb().prepare('SELECT COUNT(*) AS n FROM sync_effects').get() as { n: number }).n;
    expect(maint.compactEffects(T.cloudDb())).toBeGreaterThan(0);
    expect((T.cloudDb().prepare('SELECT COUNT(*) AS n FROM sync_effects').get() as { n: number }).n).toBeLessThan(before);
    // The host read everything it needs: its rounds work as usual.
    await T.hostRound();
    // The host trims its own stream; the LAN PC (away, with unsent work) falls behind it.
    T.cutOff('lan');
    await api().post(`/api/inventory/${item}/adjust`).set(T.lanHdr()).send({ change: -2, reason: 'Unsent at the desk' });
    T.hostDb().prepare("UPDATE sync_effects SET created_at = datetime('now', '-30 days')").run();
    T.hostDb().prepare("UPDATE sync_nodes SET last_seen_at = datetime('now', '-60 days')").run();
    await api().post(`/api/inventory/${item}/adjust`).set(T.hostHdr()).send({ change: 1, reason: 'At the host' });
    expect(maint.compactEffects(T.hostDb())).toBeGreaterThan(0);
    T.reconnect('lan');
    await expect(T.lanRound()).rejects.toThrow(/re-syncs/);
    await T.lanRound(); // re-syncs from a fresh copy, sending its unsent −2 first
    expect(qty(T.lanDb())).toBe(qty(T.hostDb()));
    await T.hostRound();
    expect(qty(T.cloudDb())).toBe(20 + 3 - 2 + 1);
  });
});
