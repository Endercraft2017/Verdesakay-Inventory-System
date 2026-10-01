/**
 * Offline-first sync, phase 3a (docs/OFFLINE-FIRST.md §12): enrolment and the HTTP transport,
 * over a real listening server. The `default` tenant is the cloud; the PC's copy is imported
 * as tenant `desk-1` after enrolling through the same HTTP calls an installer makes.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, type TestContext } from './helpers';

let ctx: TestContext;
let server: http.Server;
let cloudUrl: string;
let sync: typeof import('../src/sync');
let dbmod: typeof import('../src/shared/db');
let cloudToken: string;
let nodeToken: string;
let nodeNo: number;
let snapshotFile: string;

const NODE = 'desk-1';
const cloudHdr = () => ({ Authorization: `Bearer ${cloudToken}` });
const nodeHdr = () => ({ Authorization: `Bearer ${nodeToken}`, 'X-Tenant': NODE });
const cloudDb = () => dbmod.getDb('default');
const nodeDb = () => dbmod.getDb(NODE);
const qty = (conn: import('node:sqlite').DatabaseSync, id: number) =>
  (conn.prepare('SELECT quantity FROM inventory_items WHERE id = ?').get(id) as { quantity: number } | undefined)?.quantity;

let itemId: number;

beforeAll(async () => {
  ctx = await setupApp();
  sync = await import('../src/sync');
  dbmod = await import('../src/shared/db');
  cloudToken = await login(ctx.api);
  server = http.createServer(ctx.app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cloudUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // Secrets on the cloud that must never reach a PC.
  dbmod.withTenant('default', () => {
    dbmod.setSetting('mail_smtp_pass', 'v1:SMTP-SECRET-MARKER');
    dbmod.setSetting('_secret_key', 'MASTER-KEY-MARKER');
    dbmod.setSetting('company_name_test', 'Acme Plant');
  });
  const r = await ctx.api.post('/api/inventory').set(cloudHdr()).send({ name: 'Transport item', quantity: 20 });
  itemId = r.body.id as number;
});
afterAll(() => {
  server.close();
  cleanup(ctx);
});

describe('enrolment', () => {
  it('needs an admin who can manage users', async () => {
    const u = await ctx.api.post('/api/users').set(cloudHdr())
      .send({ username: 'clerk-t', full_name: 'Clerk', password: 'clerkpass1', role: 'warehouse' });
    expect(u.status).toBe(201);
    const t = await login(ctx.api, 'clerk-t', 'clerkpass1');
    const r = await ctx.api.post('/api/sync/nodes').set({ Authorization: `Bearer ${t}` }).send({ name: 'Nope' });
    expect(r.status).toBe(403);
    expect(sync.syncConfigOf(cloudDb())).toBeNull(); // nothing switched on
  });

  it('registers the PC, switches the workspace to sync mode, and downloads a copy', async () => {
    snapshotFile = path.join(ctx.tmpDir, 'desk-1.db');
    const id = await sync.enrolNode({ cloudUrl, username: 'admin', password: 'admin123', name: 'Warehouse desk', file: snapshotFile });
    expect(id.nodeNo).toBe(1);
    nodeNo = id.nodeNo;
    expect(sync.syncConfigOf(cloudDb())).toEqual({ role: 'cloud', nodeNo: 0 });
    const list = await ctx.api.get('/api/sync/nodes').set(cloudHdr());
    expect(list.body).toMatchObject([{ node_no: 1, name: 'Warehouse desk', revoked_at: null }]);

    const provisioning = await import('../src/platform/provisioning');
    provisioning.importTenant({ slug: NODE, name: 'Desk 1', sourceFile: snapshotFile });
    sync.adoptSnapshot(nodeDb(), { ...id, cloudUrl });
    expect(sync.syncConfigOf(nodeDb())).toEqual({ role: 'node', nodeNo: 1 });
    const nl = await ctx.api.post('/api/auth/login').set('X-Tenant', NODE).send({ username: 'admin', password: 'admin123' });
    expect(nl.status).toBe(200);
    nodeToken = nl.body.token as string;
    expect(qty(nodeDb(), itemId)).toBe(20);
  });

  it('the copy carries no credentials: no sessions, tokens or secrets — not even in free pages', () => {
    const bytes = fs.readFileSync(snapshotFile).toString('latin1');
    expect(bytes).not.toContain('SMTP-SECRET-MARKER');
    expect(bytes).not.toContain('MASTER-KEY-MARKER');
    expect(bytes).toContain('Acme Plant'); // ordinary settings do travel
    const n = nodeDb();
    const count = (t: string) => (n.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c;
    expect(n.prepare("SELECT key FROM settings WHERE key IN ('mail_smtp_pass', '_secret_key')").all()).toEqual([]);
    expect(count('sync_nodes')).toBe(0); // the cloud's token hashes stay there
    expect(count('sync_commands')).toBe(0);
    // Only the admin's fresh sign-in on this PC; none of the cloud's sessions came along.
    expect(n.prepare('SELECT COUNT(*) AS c FROM sessions WHERE token = ?').get(cloudToken)).toEqual({ c: 0 });
  });

  it('cannot enrol against an installed PC', async () => {
    const r = await ctx.api.post('/api/sync/nodes').set(nodeHdr()).send({ name: 'Chained' });
    expect(r.status).toBe(409);
  });
});

describe('syncing over HTTP', () => {
  it('merges offline and cloud work both ways', async () => {
    const n = await ctx.api.post(`/api/inventory/${itemId}/adjust`).set(nodeHdr()).send({ change: -6, reason: 'Offline' });
    expect(n.status).toBe(200);
    await ctx.api.post(`/api/inventory/${itemId}/adjust`).set(cloudHdr()).send({ change: 4, reason: 'Online' });

    const r = await sync.syncWithCloud(NODE);
    expect(r.pushed.map((p) => p.state)).toEqual(['confirmed']);
    expect(qty(cloudDb(), itemId)).toBe(18);
    expect(qty(nodeDb(), itemId)).toBe(18);
    expect(sync.pendingCommands(NODE)).toHaveLength(0);
  });

  it('never streams secret settings to the PC, while ordinary settings do sync', async () => {
    dbmod.withTenant('default', () => {
      dbmod.setSetting('ai_api_key', 'v1:AI-SECRET');
      dbmod.setSetting('company_name_test', 'Acme Plant 2');
    });
    await sync.syncWithCloud(NODE);
    const n = nodeDb();
    expect(n.prepare("SELECT value FROM settings WHERE key = 'company_name_test'").get()).toEqual({ value: '"Acme Plant 2"' });
    expect(n.prepare("SELECT key FROM settings WHERE key = 'ai_api_key'").get()).toBeUndefined();
  });

  it('a second round with nothing new changes nothing', async () => {
    const r = await sync.syncWithCloud(NODE);
    expect(r).toMatchObject({ pushed: [], rebase: { applied: 0, undone: 0 } });
  });

  it('"Sync now" runs a round, and the status pill sees the connection', async () => {
    await ctx.api.post(`/api/inventory/${itemId}/adjust`).set(nodeHdr()).send({ change: 1, reason: 'Sync now' });
    const r = await ctx.api.post('/api/sync/now').set(nodeHdr());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, sent: 1 });
    const s = await ctx.api.get('/api/sync/status').set(nodeHdr());
    expect(s.body).toMatchObject({ mode: 'node', online: true, pending_total: 0, last_error: null });
    expect(Date.parse(s.body.last_sync_at)).toBeGreaterThan(Date.now() - 60_000);
    expect(qty(cloudDb(), itemId)).toBe(19);
  });
});

describe('node authentication', () => {
  it('refuses missing, wrong and revoked tokens', async () => {
    expect((await ctx.api.get('/api/sync/pull')).status).toBe(401);
    expect((await ctx.api.get('/api/sync/pull').set('X-Sync-Node-Token', 'nope')).status).toBe(401);
    const second = await ctx.api.post('/api/sync/nodes').set(cloudHdr()).send({ name: 'Spare laptop' });
    expect(second.body.node_no).toBe(2);
    const tok = second.body.node_token as string;
    expect((await ctx.api.get('/api/sync/pull').set('X-Sync-Node-Token', tok)).status).toBe(200);
    expect((await ctx.api.post('/api/sync/nodes/2/revoke').set(cloudHdr())).status).toBe(200);
    expect((await ctx.api.get('/api/sync/pull').set('X-Sync-Node-Token', tok)).status).toBe(401);
  });

  it('a PC cannot submit another PC\'s commands', async () => {
    const remote = sync.remoteOf(nodeDb())!;
    const forged = {
      id: '01FORGEDCOMMAND000000000000', node_no: 7, node_seq: 1, hlc: null, occurred_at: new Date().toISOString(),
      occurred_date: '2026-09-30', actor_user_id: 1, device_id: null, method: 'POST',
      path: `/api/inventory/${itemId}/adjust`, body: JSON.stringify({ change: -100 }), sync_class: 'physical',
      allocation_plan: '[]', app_version: '1.0.0', unattributed: 0,
    };
    const r = await ctx.api.post('/api/sync/commands').set('X-Sync-Node-Token', remote.nodeToken).send({ commands: [forged] });
    expect(r.status).toBe(200);
    expect(r.body.results).toMatchObject([{ state: 'rejected', response_status: 403 }]);
    expect(qty(cloudDb(), itemId)).toBe(19);
  });
});

describe('when the cloud is unreachable', () => {
  it('the round fails as "offline", the work stays pending, and the next round sends it', async () => {
    const remote = sync.remoteOf(nodeDb())!;
    await ctx.api.post(`/api/inventory/${itemId}/adjust`).set(nodeHdr()).send({ change: -1, reason: 'While offline' });
    nodeDb().prepare('UPDATE sync_remote SET cloud_url = ?').run('http://127.0.0.1:1'); // nothing listens there
    await expect(sync.syncWithCloud(NODE)).rejects.toBeInstanceOf(sync.SyncOfflineError);
    const st = await ctx.api.get('/api/sync/status').set(nodeHdr());
    expect(st.body).toMatchObject({ online: false, pending_total: 1 });
    expect(st.body.last_error).toMatch(/Cannot reach/);
    const now = await ctx.api.post('/api/sync/now').set(nodeHdr());
    expect(now.status).toBe(503);
    expect(now.body.error).toMatch(/safe on this PC/);
    expect(sync.pendingCommands(NODE)).toHaveLength(1);
    expect(qty(nodeDb(), itemId)).toBe(18); // still usable locally

    nodeDb().prepare('UPDATE sync_remote SET cloud_url = ?').run(remote.cloudUrl);
    await sync.syncWithCloud(NODE);
    expect(sync.pendingCommands(NODE)).toHaveLength(0);
    expect(qty(cloudDb(), itemId)).toBe(18);
  });
});
