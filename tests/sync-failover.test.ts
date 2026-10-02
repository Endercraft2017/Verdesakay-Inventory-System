/**
 * Offline-first sync, phase 5a (docs/OFFLINE-FIRST.md §30): a site keeps working when its host is
 * lost. The host records work offline and accepts a desk PC's; then it dies with all of that
 * unseen by the cloud. A desk PC takes over: nothing is lost — it forwards what the old host held
 * — the cloud makes it the site's host under a new term, the other desk PC finds and follows it,
 * and when the old host comes back it steps down and follows the new host too.
 */
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { cleanup } from './helpers';
import { setupSiteTrio, type SiteTrio } from './sync-helpers';

let T: SiteTrio;
let item: number;
const DESK2 = 'trio-desk2';
let desk2No: number;
let desk2Token = '';
const api = () => T.ctx.api;
const desk2Db = () => T.dbmod.getDb(DESK2);
const desk2Hdr = () => ({ Authorization: `Bearer ${desk2Token}`, 'X-Tenant': DESK2 });
const desk2Round = () => T.sync.syncWithCloud(DESK2);

async function ok(p: Promise<import('supertest').Response>, status = 200) {
  const r = await p;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status} ${JSON.stringify(r.body)}`);
  return r;
}
const qtyOf = (conn: DatabaseSync) =>
  (conn.prepare('SELECT quantity FROM inventory_items WHERE id = ?').get(item) as { quantity: number }).quantity;
const isHost = (conn: DatabaseSync) => (conn.prepare('SELECT is_host FROM sync_node').get() as { is_host: number }).is_host;
const adjust = (hdr: Record<string, string>, change: number, reason: string) =>
  ok(api().post(`/api/inventory/${item}/adjust`).set(hdr).send({ change, reason }));
/** Where each "PC" answers on the LAN: in tests every PC is a workspace on one server. */
const setLan = (conn: DatabaseSync, tenant: string) =>
  conn.prepare('UPDATE sync_node SET lan_url = ?, lan_tenant = ?').run(T.url, tenant);
const unreachable = (conn: DatabaseSync) => conn.prepare('UPDATE sync_remote SET cloud_url = ?').run('http://127.0.0.1:1');

beforeAll(async () => {
  T = await setupSiteTrio(async ({ api: a, cloudHdr }) => {
    item = (await a.post('/api/inventory').set(cloudHdr()).send({ name: 'Failover widget', quantity: 100 })).body.id;
  });
  setLan(T.hostDb(), T.hostSlug);
  setLan(T.lanDb(), T.lanSlug);
  // A second desk PC on the same site.
  const reg = await T.sync.registerNode({ cloudUrl: T.url, username: 'admin', password: 'admin123', name: 'Desk 2', hostNodeNo: T.hostNo });
  desk2No = reg.nodeNo;
  await T.hostRound(); // the host learns about it
  const file = path.join(T.ctx.tmpDir, `${DESK2}.db`);
  await T.sync.downloadSnapshot({ fromUrl: T.url, tenant: T.hostSlug, nodeToken: reg.nodeToken, file });
  const provisioning = await import('../src/platform/provisioning');
  provisioning.importTenant({ slug: DESK2, name: DESK2, sourceFile: file, plan: 'unlimited' });
  T.sync.adoptSnapshot(desk2Db(), { ...reg, cloudUrl: T.url, tenant: T.hostSlug, hostNodeNo: T.hostNo });
  setLan(desk2Db(), DESK2);
  desk2Token = (await ok(api().post('/api/auth/login').set('X-Tenant', DESK2).send({ username: 'admin', password: 'admin123' }))).body.token;
  await T.lanRound();
  await desk2Round();
  await T.hostRound(); // the cloud learns where everyone is
  await T.lanRound();
  await desk2Round();
}, 120_000);
afterAll(() => {
  T?.close();
  cleanup(T.ctx);
});

describe('the site host is lost during an outage', () => {
  it('before it dies, the desk PCs mirror the commands the host holds unconfirmed', async () => {
    T.cutOff('host'); // no internet at the site
    await adjust(T.hostHdr(), -3, 'Used at the host');
    await adjust(T.lanHdr(), -2, 'Used at desk 1');
    await T.lanRound();  // desk 1 → host (accepted)
    await T.lanRound();  // and back: the mirror now holds both
    await desk2Round();
    const mirrored = (conn: DatabaseSync) => (conn.prepare('SELECT COUNT(*) AS n FROM sync_site_log').get() as { n: number }).n;
    expect(mirrored(T.lanDb())).toBe(2);
    expect(mirrored(desk2Db())).toBe(2);
    expect(qtyOf(T.lanDb())).toBe(95);
    expect(qtyOf(T.cloudDb())).toBe(100); // the cloud has seen none of it
  });

  it('a desk PC takes over (an admin decides) and keeps working, still offline', async () => {
    unreachable(T.hostDb()); // the host PC dies
    const refused = await api().post('/api/sync/site/take-over').set(T.lanHdr()).send({});
    expect(refused.status).toBe(400); // must confirm the host is really off
    const r = await ok(api().post('/api/sync/site/take-over').set(T.lanHdr()).send({ confirm: true }));
    expect(r.body).toMatchObject({ site: T.hostNo, term: 2 });
    expect(isHost(T.lanDb())).toBe(1);
    unreachable(T.lanDb()); // the internet is still down
    await adjust(T.lanHdr(), -1, 'Used at desk 1, now the host');
  });

  it('the other desk PC finds the new host by itself and follows it', async () => {
    unreachable(desk2Db()); // its host is gone…
    for (let i = 0; i < 3; i++) await desk2Round().catch(() => {});
    // …so it asked the site's PCs, found desk 1 hosting under term 2, and switched to it.
    expect(desk2Db().prepare('SELECT cloud_url, tenant FROM sync_remote').get()).toEqual({ cloud_url: T.url, tenant: T.lanSlug });
    await adjust(desk2Hdr(), -4, 'Used at desk 2');
    await desk2Round(); // sends to the new host, then re-syncs from it
    expect(qtyOf(desk2Db())).toBe(qtyOf(T.lanDb()));
    expect(qtyOf(T.lanDb())).toBe(90); // 100 − 3 − 2 − 1 − 4
  });

  it('back online, the new host claims the site and nothing recorded through the old host is lost', async () => {
    T.lanDb().prepare('UPDATE sync_remote SET cloud_url = ?, tenant = NULL').run(T.url);
    const r = await T.lanRound();
    expect(r.pushed.filter((p) => p.state !== 'confirmed')).toEqual([]);
    expect(qtyOf(T.cloudDb())).toBe(90);
    expect(qtyOf(T.lanDb())).toBe(90);
    // Every command — the dead host's own included — reached the cloud once.
    const reasons = (T.cloudDb().prepare(
      'SELECT reason FROM inventory_transactions WHERE item_id = ? AND change < 0 ORDER BY id',
    ).all(item) as Array<{ reason: string }>).map((x) => x.reason);
    expect(reasons.sort()).toEqual(['Used at desk 1', 'Used at desk 1, now the host', 'Used at desk 2', 'Used at the host'].sort());
    expect(T.cloudDb().prepare('SELECT site_no, host_node_no, term FROM sync_sites').get())
      .toEqual({ site_no: T.hostNo, host_node_no: T.lanNo, term: 2 });
    // Desk 2 follows the new host's fresh stream.
    await desk2Round();
    await desk2Round();
    expect(qtyOf(desk2Db())).toBe(90);
  });

  it('the old host comes back, steps down and follows the new host', async () => {
    T.reconnect('host');
    await T.hostRound(); // hears from the cloud that desk 1 hosts the site under term 2
    expect(isHost(T.hostDb())).toBe(0);
    expect(T.hostDb().prepare('SELECT cloud_url, tenant FROM sync_remote').get()).toEqual({ cloud_url: T.url, tenant: T.lanSlug });
    await T.hostRound(); // re-syncs from the new host
    expect(qtyOf(T.hostDb())).toBe(90);
    // It works as an ordinary PC of the site now.
    await adjust(T.hostHdr(), -5, 'Back at the old host');
    await T.hostRound();
    await T.lanRound();
    expect(qtyOf(T.cloudDb())).toBe(85);
    const cloudNodes = T.cloudDb().prepare('SELECT node_no, is_host, host_node_no FROM sync_nodes WHERE node_no IN (?, ?) ORDER BY node_no')
      .all(T.hostNo, T.lanNo);
    expect(cloudNodes).toEqual([
      { node_no: T.hostNo, is_host: 0, host_node_no: T.hostNo },
      { node_no: T.lanNo, is_host: 1, host_node_no: T.hostNo },
    ]);
    expect(desk2No).toBeGreaterThan(0);
  });
});

describe('re-syncing a PC whose copy went wrong', () => {
  it('takes a fresh copy from its authority and keeps its own unsent work', async () => {
    // Desk 2 follows the new host (desk 1). Its copy is damaged, and it has unsent work.
    desk2Db().prepare('UPDATE inventory_items SET quantity = 999 WHERE id = ?').run(item);
    unreachable(desk2Db());
    await adjust(desk2Hdr(), -1, 'Unsent at desk 2');
    desk2Db().prepare('UPDATE sync_remote SET cloud_url = ?, tenant = ?').run(T.url, T.lanSlug);
    await ok(api().post('/api/sync/site/resync').set(desk2Hdr()).send({}));
    await desk2Round();
    expect(qtyOf(desk2Db())).toBe(qtyOf(T.lanDb())); // the damage is gone, the unsent −1 went through the host
    expect(qtyOf(T.lanDb())).toBe(84);
    await T.lanRound();
    expect(qtyOf(T.cloudDb())).toBe(84);
  });
});
