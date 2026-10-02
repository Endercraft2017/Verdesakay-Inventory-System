/**
 * Offline-first sync, phase 3c-i (docs/OFFLINE-FIRST.md §15): a site host relays for its LAN.
 * One real HTTP server serves three tenants: `default` = the cloud, `site-h` = the site host
 * (node, host), `lan-1` = a PC on the host's LAN. The host reaches the cloud at the server's
 * URL; the LAN PC reaches the host at the same URL with X-Tenant: site-h (honoured in tests).
 */
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, type TestContext } from './helpers';

let ctx: TestContext;
let server: http.Server;
let url: string;
let sync: typeof import('../src/sync');
let dbmod: typeof import('../src/shared/db');
let push: typeof import('../src/shared/push');
let provisioning: typeof import('../src/platform/provisioning');
let ctxmod: typeof import('../src/shared/sync-context');
let cloudToken: string;
let hostToken: string;
let lanToken: string;
let hostNo: number;
let lanNo: number;
let itemA: number;

const HOST = 'site-h';
const LAN = 'lan-1';
const cloudDb = () => dbmod.getDb('default');
const hostDb = () => dbmod.getDb(HOST);
const lanDb = () => dbmod.getDb(LAN);
const cloudHdr = () => ({ Authorization: `Bearer ${cloudToken}` });
const hostHdr = () => ({ Authorization: `Bearer ${hostToken}`, 'X-Tenant': HOST });
const lanHdr = () => ({ Authorization: `Bearer ${lanToken}`, 'X-Tenant': LAN });
const qty = (conn: DatabaseSync, id: number) =>
  (conn.prepare('SELECT quantity FROM inventory_items WHERE id = ?').get(id) as { quantity: number } | undefined)?.quantity;
const txRows = (conn: DatabaseSync, id: number) =>
  conn.prepare('SELECT id, change, reason, created_at FROM inventory_transactions WHERE item_id = ? ORDER BY id').all(id);
const stateOf = (conn: DatabaseSync, id: string) =>
  (conn.prepare('SELECT state FROM sync_commands WHERE id = ?').get(id) as { state: string } | undefined)?.state;
const signIn = async (tenant: string, u = 'admin', p = 'admin123') => {
  const r = await ctx.api.post('/api/auth/login').set('X-Tenant', tenant).send({ username: u, password: p });
  expect(r.status).toBe(200);
  return r.body.token as string;
};
const hostRound = () => sync.syncWithCloud(HOST);
const lanRound = () => sync.syncWithCloud(LAN);
const cutHostOff = () => hostDb().prepare('UPDATE sync_remote SET cloud_url = ?').run('http://127.0.0.1:1');
const reconnectHost = () => hostDb().prepare('UPDATE sync_remote SET cloud_url = ?').run(url);

beforeAll(async () => {
  ctx = await setupApp();
  sync = await import('../src/sync');
  dbmod = await import('../src/shared/db');
  push = await import('../src/shared/push');
  provisioning = await import('../src/platform/provisioning');
  ctxmod = await import('../src/shared/sync-context');
  cloudToken = await login(ctx.api);
  server = http.createServer(ctx.app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  itemA = (await ctx.api.post('/api/inventory').set(cloudHdr()).send({ name: 'Site item', quantity: 20 })).body.id;
  const u = await ctx.api.post('/api/users').set(cloudHdr())
    .send({ username: 'wh-site', full_name: 'Site Clerk', password: 'whsite1', role: 'warehouse' });
  expect(u.status).toBe(201);
});
afterAll(() => {
  server.close();
  cleanup(ctx);
});

describe('setting up a site', () => {
  it('enrols the host against the cloud', async () => {
    const reg = await sync.registerNode({ cloudUrl: url, username: 'admin', password: 'admin123', name: 'Office PC (host)', asHost: true });
    hostNo = reg.nodeNo;
    const file = path.join(ctx.tmpDir, 'host.db');
    await sync.downloadSnapshot({ fromUrl: url, nodeToken: reg.nodeToken, file });
    provisioning.importTenant({ slug: HOST, name: 'Site host', sourceFile: file });
    sync.adoptSnapshot(hostDb(), { ...reg, cloudUrl: url, isHost: true });
    expect(sync.syncConfigOf(hostDb())).toEqual({ role: 'node', nodeNo: hostNo, isHost: true });
    hostToken = await signIn(HOST);
    const who = await ctx.api.get('/api/sync/whoami').set('X-Tenant', HOST);
    // A host also names its site (numbered after it), its term and its stream's epoch (§30).
    expect(who.body).toMatchObject({ role: 'node', node_no: hostNo, is_host: true, site_no: hostNo, term: 1 });
    expect(who.body.epoch).toMatch(/^[0-9a-f]{16}$/);
  });

  it('enrols a LAN PC through the host: registered at the cloud, copied from the host', async () => {
    expect(await sync.hostNodeNo(url, HOST)).toBe(hostNo);
    const reg = await sync.registerNode({ cloudUrl: url, username: 'admin', password: 'admin123', name: 'Warehouse desk', hostNodeNo: hostNo });
    lanNo = reg.nodeNo;
    const file = path.join(ctx.tmpDir, 'lan.db');
    // The host only lets it in once it has heard about it from the cloud.
    await expect(sync.downloadSnapshot({ fromUrl: url, tenant: HOST, nodeToken: reg.nodeToken, file })).rejects.toThrow(/401/);
    await hostRound();
    await sync.downloadSnapshot({ fromUrl: url, tenant: HOST, nodeToken: reg.nodeToken, file });
    provisioning.importTenant({ slug: LAN, name: 'LAN PC', sourceFile: file });
    sync.adoptSnapshot(lanDb(), { ...reg, cloudUrl: url, tenant: HOST });
    lanToken = await signIn(LAN);
    expect(qty(lanDb(), itemA)).toBe(20);
    const pcs = (await ctx.api.get('/api/sync/nodes').set(cloudHdr())).body;
    expect(pcs).toMatchObject([
      { node_no: hostNo, is_host: 1, host_node_no: null },
      { node_no: lanNo, is_host: 0, host_node_no: hostNo },
    ]);
  });
});

describe('a LAN PC with its host', () => {
  it('its work is accepted on site at once, and reaches the cloud through the host', async () => {
    const r = await ctx.api.post(`/api/inventory/${itemA}/adjust`).set(lanHdr()).send({ change: -3, reason: 'LAN pick' });
    const cmdId = r.headers['x-sync-command'] as string;
    const first = await lanRound();
    expect(first.pushed).toMatchObject([{ id: cmdId, state: 'host_confirmed' }]);
    expect(stateOf(lanDb(), cmdId)).toBe('host_confirmed');
    expect(qty(hostDb(), itemA)).toBe(17); // the site sees it…
    expect(qty(cloudDb(), itemA)).toBe(20); // …the cloud not yet
    expect((await ctx.api.get('/api/sync/status').set(lanHdr())).body).toMatchObject({ pending_total: 0, on_site: 1 });

    await hostRound(); // the host forwards it
    expect(qty(cloudDb(), itemA)).toBe(17);
    await lanRound(); // and the cloud's verdict comes back down
    expect(stateOf(lanDb(), cmdId)).toBe('confirmed');
    expect(txRows(lanDb(), itemA)).toEqual(txRows(cloudDb(), itemA));
    expect(txRows(hostDb(), itemA)).toEqual(txRows(cloudDb(), itemA));
  });

  it('keeps the whole site working while the cloud is unreachable, then merges with the cloud', async () => {
    cutHostOff();
    await ctx.api.post(`/api/inventory/${itemA}/adjust`).set(hostHdr()).send({ change: -2, reason: 'Office, offline' });
    await ctx.api.post(`/api/inventory/${itemA}/adjust`).set(lanHdr()).send({ change: -1, reason: 'Desk, offline' });
    await lanRound(); // the LAN still reaches its host
    expect(qty(hostDb(), itemA)).toBe(14);
    expect(qty(lanDb(), itemA)).toBe(14); // each PC sees the other's work
    await expect(hostRound()).rejects.toBeInstanceOf(sync.SyncOfflineError);
    await lanRound();
    expect((await ctx.api.get('/api/sync/status').set(lanHdr())).body).toMatchObject({ online: true, upstream_online: false, on_site: 1 });

    await ctx.api.post(`/api/inventory/${itemA}/adjust`).set(cloudHdr()).send({ change: 10, reason: 'Cloud GRN' });
    reconnectHost();
    const back = await hostRound();
    expect(back.pushed.map((p) => p.state)).toEqual(['confirmed', 'confirmed']);
    await lanRound();
    // 17 − 2 − 1 + 10 everywhere, with identical rows.
    for (const conn of [cloudDb(), hostDb(), lanDb()]) expect(qty(conn, itemA)).toBe(24);
    expect(txRows(lanDb(), itemA)).toEqual(txRows(cloudDb(), itemA));
    expect(txRows(hostDb(), itemA)).toEqual(txRows(cloudDb(), itemA));
    expect((await ctx.api.get('/api/sync/status').set(lanHdr())).body).toMatchObject({ on_site: 0, upstream_online: true });
  });

  it('what the host accepted but the cloud rejects is undone on every copy', async () => {
    const clerk = await signIn(LAN, 'wh-site', 'whsite1');
    const r = await ctx.api.post(`/api/inventory/${itemA}/adjust`)
      .set({ Authorization: `Bearer ${clerk}`, 'X-Tenant': LAN }).send({ change: -4, reason: 'Clerk' });
    const cmdId = r.headers['x-sync-command'] as string;
    await lanRound();
    expect(qty(hostDb(), itemA)).toBe(20);
    const users = (await ctx.api.get('/api/users').set(cloudHdr())).body as Array<{ id: number; username: string }>;
    const clerkId = users.find((x) => x.username === 'wh-site')!.id;
    expect((await ctx.api.put(`/api/users/${clerkId}`).set(cloudHdr()).send({ active: false })).status).toBe(200);

    const h = await hostRound();
    expect(h.pushed).toMatchObject([{ id: cmdId, state: 'rejected', response_status: 401 }]);
    expect(qty(hostDb(), itemA)).toBe(24); // the host undid it…
    await lanRound();
    expect(qty(lanDb(), itemA)).toBe(24); // …and so did the LAN PC, through the host's stream
    expect(stateOf(lanDb(), cmdId)).toBe('rejected');
    expect(txRows(lanDb(), itemA)).toEqual(txRows(cloudDb(), itemA));
  });

  it('push notifications come only from the cloud — not from the PC, not from the host', async () => {
    const id = (await ctx.api.post('/api/inventory').set(cloudHdr()).send({ name: 'Site low', quantity: 5, min_quantity: 3 })).body.id;
    await hostRound();
    await lanRound();
    for (const conn of [cloudDb(), hostDb(), lanDb()]) {
      conn.prepare("INSERT OR IGNORE INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (1, 'https://push.test/site', 'k', 'a')").run();
    }
    const lowStock = () => push.__sentPush.filter((p) => p.payload.title === 'Low stock').length;
    push.__sentPush.length = 0;
    await ctx.api.post(`/api/inventory/${id}/adjust`).set(lanHdr()).send({ change: -3 });
    await lanRound(); // the host replays it: crosses the reorder point there too
    await new Promise((r) => setTimeout(r, 20));
    expect(lowStock()).toBe(0);
    await hostRound(); // the cloud's replay
    await new Promise((r) => setTimeout(r, 20));
    expect(lowStock()).toBe(1);
  });
});

describe('the host as a gate', () => {
  it('refuses unknown tokens, and a LAN PC cannot submit another PC\'s commands', async () => {
    const pull = await ctx.api.get('/api/sync/pull').set({ 'X-Tenant': HOST, 'X-Sync-Node-Token': 'nope' });
    expect(pull.status).toBe(401);
    const remote = sync.remoteOf(lanDb())!;
    const forged = {
      id: '01FORGEDSITECOMMAND00000000', node_no: hostNo, node_seq: 1, hlc: null, occurred_at: new Date().toISOString(),
      occurred_date: '2026-10-01', actor_user_id: 1, device_id: null, method: 'POST',
      path: `/api/inventory/${itemA}/adjust`, body: JSON.stringify({ change: -50 }), sync_class: 'physical',
      allocation_plan: '[]', app_version: '1.0.0', unattributed: 0,
    };
    const r = await ctx.api.post('/api/sync/commands').set({ 'X-Tenant': HOST, 'X-Sync-Node-Token': remote.nodeToken }).send({ commands: [forged] });
    expect(r.body.results).toMatchObject([{ state: 'rejected', response_status: 403 }]);
    expect(qty(hostDb(), itemA)).toBe(24);
  });

  it('only the cloud enrols PCs', async () => {
    const r = await ctx.api.post('/api/sync/nodes').set(hostHdr()).send({ name: 'Nope' });
    expect(r.status).toBe(409);
  });
});

describe('details', () => {
  it('a host keeps a LAN PC\'s provisional document number provisional (only the cloud issues real ones)', () => {
    const plan = [{ t: 'seq' as const, key: 'order_seq_sale', value: `SO-P${lanNo}-0001`, provisional: true }];
    const v = dbmod.withTenant(HOST, () => ctxmod.syncStore.run({ mode: 'replay', plan, cursor: { id: 0, seq: 0 } },
      () => dbmod.nextSequence('order_seq_sale', 'SO')));
    expect(v).toBe(`SO-P${lanNo}-0001`);
  });

  it('verdicts on unattributed commands are found by id, never by node', () => {
    const c = cloudDb();
    c.prepare(`INSERT INTO sync_commands (id, occurred_date, method, path, body, sync_class, app_version, unattributed, state)
               VALUES ('01ANONVERDICT0000000000000', '2026-10-01', 'POST', '/x', '{}', 'merge', '1.0.0', 1, 'confirmed')`).run();
    expect(sync.pullFor('default', 99, 1e9).results).toEqual([]);
    expect(sync.pullFor('default', 99, 1e9, ['01ANONVERDICT0000000000000']).results).toMatchObject([{ id: '01ANONVERDICT0000000000000', state: 'confirmed' }]);
  });
});
