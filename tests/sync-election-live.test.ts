/**
 * Automatic host election on real site copies (phase 5b, docs/OFFLINE-FIRST.md §31): a site with
 * 3 voting PCs loses its host during an internet outage; the two desk PCs elect one of themselves
 * with no admin involved, the other follows it, work continues, and when the internet returns
 * everything reaches the cloud. The old host, back on the LAN, steps down by itself.
 */
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { cleanup } from './helpers';
import { setupSiteTrio, type SiteTrio } from './sync-helpers';
// NOTE: src/ modules are imported inside beforeAll, after setupSiteTrio() (setupApp) has pointed
// DB_PATH / DATA_DIR at a throwaway folder. A top-level import of anything that loads
// src/shared/db would bind the REAL database paths first (tests/helpers.ts).
import type { SiteElection as SiteElectionT } from '../src/sync/election';

let T: SiteTrio;
let item: number;
const DESK2 = 'elect-desk2';
let desk2Token = '';
let clock = 0;
let LEASE_MS = 15_000;
let bus: import('../src/sync/election').MemoryBus;
const elections = new Map<string, SiteElectionT>();
const api = () => T.ctx.api;
const db = (slug: string) => T.dbmod.getDb(slug);
const nodeNoOf = (slug: string) => (db(slug).prepare('SELECT node_no FROM sync_node').get() as { node_no: number }).node_no;
const isHost = (slug: string) => (db(slug).prepare('SELECT is_host FROM sync_node').get() as { is_host: number }).is_host === 1;
const qty = (conn: DatabaseSync) => (conn.prepare('SELECT quantity FROM inventory_items WHERE id = ?').get(item) as { quantity: number }).quantity;
const unreachable = (conn: DatabaseSync) => conn.prepare('UPDATE sync_remote SET cloud_url = ?').run('http://127.0.0.1:1');

async function ok(p: Promise<import('supertest').Response>, status = 200) {
  const r = await p;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status} ${JSON.stringify(r.body)}`);
  return r;
}
/** Let `ms` of LAN time pass, every PC's election ticking every 250 ms. */
async function lanTime(ms: number, off: Set<string> = new Set()) {
  for (let t = 0; t < ms; t += 250) {
    clock += 250;
    for (const [slug, e] of elections) if (!off.has(slug)) await e.tick();
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
  }
}

beforeAll(async () => {
  T = await setupSiteTrio(async ({ api: a, cloudHdr }) => {
    item = (await a.post('/api/inventory').set(cloudHdr()).send({ name: 'Election widget', quantity: 50 })).body.id;
  });
  const reg = await T.sync.registerNode({ cloudUrl: T.url, username: 'admin', password: 'admin123-test-only', name: 'Desk 2', hostNodeNo: T.hostNo });
  await T.hostRound();
  const file = path.join(T.ctx.tmpDir, `${DESK2}.db`);
  await T.sync.downloadSnapshot({ fromUrl: T.url, tenant: T.hostSlug, nodeToken: reg.nodeToken, file });
  const provisioning = await import('../src/platform/provisioning');
  provisioning.importTenant({ slug: DESK2, name: DESK2, sourceFile: file, plan: 'unlimited' });
  T.sync.adoptSnapshot(db(DESK2), { ...reg, cloudUrl: T.url, tenant: T.hostSlug, hostNodeNo: T.hostNo });
  desk2Token = (await ok(api().post('/api/auth/login').set('X-Tenant', DESK2).send({ username: 'admin', password: 'admin123-test-only' }))).body.token;
  for (const slug of [T.hostSlug, T.lanSlug, DESK2]) db(slug).prepare('UPDATE sync_node SET lan_url = ?, lan_tenant = ?').run(T.url, slug);
  // Everyone learns everyone: the cloud learns addresses, the host passes them on.
  for (let i = 0; i < 2; i++) { await T.hostRound(); await T.lanRound(); await T.sync.syncWithCloud(DESK2); }
  const { MemoryBus, SiteElection, LEASE_MS: lease } = await import('../src/sync/election');
  const { electionDeps } = await import('../src/sync/site-election');
  LEASE_MS = lease;
  bus = new MemoryBus();
  const fake = { now: () => clock, random: (() => { let s = 3; return () => (s = (s * 9301 + 49297) % 233280) / 233280; })() };
  for (const slug of [T.hostSlug, T.lanSlug, DESK2]) {
    elections.set(slug, new SiteElection(electionDeps(slug, fake)!, bus.for(nodeNoOf(slug))));
  }
}, 120_000);
afterAll(() => {
  for (const e of elections.values()) e.stop();
  T?.close();
  if (T) cleanup(T.ctx);
});

describe('a 3-PC site loses its host during an outage', () => {
  it('while the host is alive, nobody runs an election', async () => {
    T.cutOff('host');
    await lanTime(LEASE_MS * 3);
    expect([T.hostSlug, T.lanSlug, DESK2].map(isHost)).toEqual([true, false, false]);
    await ok(api().post(`/api/inventory/${item}/adjust`).set(T.hostHdr()).send({ change: -5, reason: 'At the host before it died' }));
    await T.lanRound();
    await T.sync.syncWithCloud(DESK2);
  });

  it('the host dies: the desk PCs elect one of themselves, and the other follows it', async () => {
    bus.cutOff(T.hostNo);
    unreachable(T.hostDb());
    await lanTime(LEASE_MS * 4, new Set([T.hostSlug]));
    const winners = [T.lanSlug, DESK2].filter(isHost);
    expect(winners).toHaveLength(1);
    const winner = winners[0]!;
    const loser = winner === T.lanSlug ? DESK2 : T.lanSlug;
    expect(db(loser).prepare('SELECT tenant FROM sync_remote').get()).toEqual({ tenant: winner });
    // Work carries on at the follower, through the new host, still with no internet.
    unreachable(db(winner));
    const hdr = loser === DESK2 ? { Authorization: `Bearer ${desk2Token}`, 'X-Tenant': DESK2 } : T.lanHdr();
    await ok(api().post(`/api/inventory/${item}/adjust`).set(hdr).send({ change: -2, reason: 'After the election' }));
    await T.sync.syncWithCloud(loser);
    await T.sync.syncWithCloud(loser);
    expect(qty(db(loser))).toBe(43);

    // The internet returns: the new host claims the site; nothing is lost.
    db(winner).prepare('UPDATE sync_remote SET cloud_url = ?, tenant = NULL').run(T.url);
    await T.sync.syncWithCloud(winner);
    expect(qty(T.cloudDb())).toBe(43);
    expect(T.cloudDb().prepare('SELECT host_node_no, term FROM sync_sites').get())
      .toMatchObject({ host_node_no: nodeNoOf(winner) });

    // The old host comes back on the LAN: it hears the new host's heartbeat and steps down.
    bus.reconnect(T.hostNo);
    await lanTime(5_000);
    expect(isHost(T.hostSlug)).toBe(false);
    expect(T.hostDb().prepare('SELECT tenant FROM sync_remote').get()).toEqual({ tenant: winner });
  });
});
