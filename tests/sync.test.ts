/**
 * Offline-first sync, phase 1 (docs/OFFLINE-FIRST.md): the command foundation end to end.
 * The `default` tenant plays the cloud (node 0); a snapshot of it, imported as tenant
 * `plant-a`, plays an installed PC (node 7). Sync rounds run in-process (`syncOnce`) — the
 * HTTP transport between them is phase 3.
 */
import path from 'node:path';
import express from 'express';
import supertest from 'supertest';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, type TestContext } from './helpers';

let ctx: TestContext;
let sync: typeof import('../src/sync');
let dbmod: typeof import('../src/shared/db');
let ctxmod: typeof import('../src/shared/sync-context');
let push: typeof import('../src/shared/push');
let cloudToken: string;
let nodeToken: string;

const NODE = 'plant-a';
const NODE_NO = 7;
const BASE7 = NODE_NO * 2 ** 37;
const cloudHdr = () => ({ Authorization: `Bearer ${cloudToken}` });
const nodeHdr = () => ({ Authorization: `Bearer ${nodeToken}`, 'X-Tenant': NODE });
const cloudDb = () => dbmod.getDb('default');
const nodeDb = () => dbmod.getDb(NODE);
const syncRound = () => sync.syncOnce(NODE, 'default', NODE_NO);

async function newItem(qty: number, extra: Record<string, unknown> = {}): Promise<number> {
  const r = await ctx.api.post('/api/inventory').set(cloudHdr()).send({ name: 'Sync ' + Math.random(), quantity: qty, ...extra });
  expect(r.status).toBe(201);
  return r.body.id as number;
}
const qtyOn = (conn: import('node:sqlite').DatabaseSync, id: number) =>
  (conn.prepare('SELECT quantity FROM inventory_items WHERE id = ?').get(id) as { quantity: number } | undefined)?.quantity;
const txOn = (conn: import('node:sqlite').DatabaseSync, id: number) =>
  conn.prepare('SELECT id, change, balance_after, reason, created_at FROM inventory_transactions WHERE item_id = ? ORDER BY id').all(id);

/** Snapshot the cloud and enrol it as the node — everything created on the cloud before this
 *  exists on the node; everything after arrives as effects. */
async function enrolNode(): Promise<void> {
  const provisioning = await import('../src/platform/provisioning');
  const file = path.join(ctx.tmpDir, 'enrol.db');
  sync.snapshotForNode('default', file);
  provisioning.importTenant({ slug: NODE, name: 'Plant A', sourceFile: file });
  sync.enableSync(nodeDb(), { role: 'node', nodeNo: NODE_NO });
  const r = await ctx.api.post('/api/auth/login').set('X-Tenant', NODE).send({ username: 'admin', password: 'admin123' });
  expect(r.status).toBe(200); // sign-in only writes node-local tables, so it works on a node
  nodeToken = r.body.token as string;
}

let itemA: number; // created before enrolment
let itemB: number;

beforeAll(async () => {
  ctx = await setupApp();
  sync = await import('../src/sync');
  dbmod = await import('../src/shared/db');
  ctxmod = await import('../src/shared/sync-context');
  push = await import('../src/shared/push');
  cloudToken = await login(ctx.api);
  sync.enableSync(cloudDb(), { role: 'cloud', nodeNo: 0 });
  itemA = await newItem(10, { min_quantity: 3 });
  itemB = await newItem(50);
  await enrolNode();
});
afterAll(() => cleanup(ctx));

describe('a DB without a sync role', () => {
  it('is untouched: ordinary ids, no guard, no provisional numbers', async () => {
    const provisioning = await import('../src/platform/provisioning');
    provisioning.createTenant({ slug: 'plain', name: 'Plain', admin_username: 'owner', admin_password: 'plainpass1' });
    const t = (await ctx.api.post('/api/auth/login').set('X-Tenant', 'plain').send({ username: 'owner', password: 'plainpass1' })).body.token;
    const r = await ctx.api.post('/api/inventory').set({ Authorization: `Bearer ${t}`, 'X-Tenant': 'plain' }).send({ name: 'Plain item', quantity: 1 });
    expect(r.status).toBe(201);
    expect(r.body.id).toBeLessThan(1000);
    expect(sync.syncConfigOf(dbmod.getDb('plain'))).toBeNull();
    expect(dbmod.withTenant('plain', () => dbmod.nextSequence('order_seq_sale', 'SO'))).toBe('SO-00001');
  });
});

describe('the node', () => {
  it('refuses writes from routes with no sync class (they would never sync)', async () => {
    const r = await ctx.api.post('/api/inventory').set(nodeHdr()).send({ name: 'Offline new item', quantity: 1 });
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/internet/i);
    expect(nodeDb().prepare("SELECT COUNT(*) AS n FROM inventory_items WHERE name = 'Offline new item'").get()).toEqual({ n: 0 });
  });

  it('records a classed action as a command, applies it at once, and gives new rows node-7 ids', async () => {
    const r = await ctx.api.post(`/api/inventory/${itemA}/adjust`).set(nodeHdr()).send({ change: -5, reason: 'Released offline' });
    expect(r.status).toBe(200);
    expect(r.body.quantity).toBe(5);
    expect(qtyOn(nodeDb(), itemA)).toBe(5);
    expect(qtyOn(cloudDb(), itemA)).toBe(10); // nothing has synced yet

    const cmds = sync.pendingCommands(NODE);
    expect(cmds).toHaveLength(1);
    const cmd = cmds[0]!;
    expect(cmd).toMatchObject({ method: 'POST', path: `/api/inventory/${itemA}/adjust`, sync_class: 'physical', node_no: 7, node_seq: 1 });
    expect(cmd.actor_user_id).toBeGreaterThan(0);
    const plan = JSON.parse(cmd.allocation_plan) as Array<{ t: string; table: string; id: number }>;
    const txPlan = plan.find((e) => e.table === 'inventory_transactions')!;
    expect(txPlan.id).toBeGreaterThanOrEqual(BASE7);
    expect(txPlan.id).toBeLessThan(BASE7 + 2 ** 37);
    expect(txOn(nodeDb(), itemA).at(-1)).toMatchObject({ id: txPlan.id, change: -5 });
  });

  it('makes a second offline movement on the same item', async () => {
    const r = await ctx.api.post(`/api/inventory/${itemA}/adjust`).set(nodeHdr()).send({ change: -3, reason: 'Second offline' });
    expect(r.status).toBe(200);
    expect(r.body.quantity).toBe(2);
  });
});

describe('a sync round', () => {
  it('merges offline and cloud changes to the same item without losing either (git-style rebase)', async () => {
    // Meanwhile on the cloud: +10 received.
    const c = await ctx.api.post(`/api/inventory/${itemA}/adjust`).set(cloudHdr()).send({ change: 10, reason: 'GRN on cloud' });
    expect(c.body.quantity).toBe(20);

    const { pushed, rebase } = await syncRound();
    expect(pushed.map((p) => p.state)).toEqual(['confirmed', 'confirmed']);
    // 10 − 5 − 3 (node) + 10 (cloud) = 12 on both copies.
    expect(qtyOn(cloudDb(), itemA)).toBe(12);
    expect(qtyOn(nodeDb(), itemA)).toBe(12);
    expect(rebase).toMatchObject({ undone: 2, confirmed: 2, rerun: 0, conflicts: 0 });
    expect(sync.pendingCommands(NODE)).toHaveLength(0);
  });

  it('sends a push notification once, from the cloud — never from the offline run', async () => {
    const id = await newItem(5, { min_quantity: 3 });
    await syncRound();
    for (const conn of [cloudDb(), nodeDb()]) {
      conn.prepare("INSERT OR IGNORE INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (1, 'https://push.test/x', 'k', 'a')").run();
    }
    const lowStock = () => push.__sentPush.filter((p) => p.payload.title === 'Low stock').length;
    push.__sentPush.length = 0;
    // 5 → 2 crosses the reorder point of 3 on the node…
    await ctx.api.post(`/api/inventory/${id}/adjust`).set(nodeHdr()).send({ change: -3, reason: 'Crosses reorder point' });
    await new Promise((res) => setTimeout(res, 20));
    expect(lowStock()).toBe(0); // …but the node stays quiet
    await syncRound();
    await new Promise((res) => setTimeout(res, 20));
    expect(lowStock()).toBe(1); // the cloud's replay crosses it too, and notifies once
  });

  it('leaves both copies with identical rows — including the node-7 ids the device showed', () => {
    const cloudTx = txOn(cloudDb(), itemA);
    expect(txOn(nodeDb(), itemA)).toEqual(cloudTx);
    expect(cloudTx.filter((t) => (t as { id: number }).id >= BASE7)).toHaveLength(2);
    const stock = (conn: import('node:sqlite').DatabaseSync) => conn.prepare('SELECT * FROM inventory_stock ORDER BY id').all();
    expect(stock(nodeDb())).toEqual(stock(cloudDb()));
  });

  it("keeps the time the action happened on the device, not the time it synced", async () => {
    await ctx.api.post(`/api/inventory/${itemB}/adjust`).set(nodeHdr()).send({ change: -1, reason: 'Backdated' });
    const cmd = sync.pendingCommands(NODE)[0]!;
    // Pretend it was made yesterday morning while offline.
    nodeDb().prepare("UPDATE sync_commands SET occurred_at = '2026-09-29T00:45:00.000Z' WHERE id = ?").run(cmd.id);
    await syncRound();
    const row = (conn: import('node:sqlite').DatabaseSync) =>
      conn.prepare("SELECT created_at FROM inventory_transactions WHERE item_id = ? AND reason = 'Backdated'").get(itemB);
    expect(row(cloudDb())).toEqual({ created_at: '2026-09-29 00:45:00' });
    expect(row(nodeDb())).toEqual(row(cloudDb()));
  });

  it('rebases a pending command onto new cloud changes before it is even pushed', async () => {
    await ctx.api.post(`/api/inventory/${itemB}/adjust`).set(nodeHdr()).send({ change: -4, reason: 'Pending' });
    await ctx.api.post(`/api/inventory/${itemB}/adjust`).set(cloudHdr()).send({ change: 7, reason: 'Cloud' });
    // Pull only (no push): the node takes the cloud's +7, then re-runs its −4 on top.
    const pull = sync.pullFor('default', NODE_NO, sync.lastAuthoritySeq(NODE));
    const summary = await sync.applyConfirmed(NODE, pull);
    expect(summary).toMatchObject({ undone: 1, rerun: 1, conflicts: 0 });
    expect(qtyOn(cloudDb(), itemB)).toBe(56); // 50 − 1 + 7
    expect(qtyOn(nodeDb(), itemB)).toBe(52); // … − 4 still pending here
    expect(sync.pendingCommands(NODE)).toHaveLength(1);

    await syncRound();
    expect(qtyOn(cloudDb(), itemB)).toBe(52);
    expect(qtyOn(nodeDb(), itemB)).toBe(52);
  });

  it('brings cloud-made rows to the node (a new item appears offline too)', async () => {
    const id = await newItem(8);
    await syncRound();
    expect(qtyOn(nodeDb(), id)).toBe(8);
    expect(id).toBeLessThan(2 ** 37); // the cloud allocates from node 0's range
  });

  it('rejects and undoes the offline work of someone disabled on the cloud meanwhile', async () => {
    const id = await newItem(9);
    const u = await ctx.api.post('/api/users').set(cloudHdr())
      .send({ username: 'wh-offline', full_name: 'Warehouse Offline', password: 'whpass1', role: 'warehouse' });
    expect(u.status).toBe(201);
    await syncRound(); // the user (and password hash) reach the node, so they can sign in there
    const wl = await ctx.api.post('/api/auth/login').set('X-Tenant', NODE).send({ username: 'wh-offline', password: 'whpass1' });
    expect(wl.status).toBe(200);
    const r = await ctx.api.post(`/api/inventory/${id}/adjust`)
      .set({ Authorization: `Bearer ${wl.body.token}`, 'X-Tenant': NODE }).send({ change: -2, reason: 'Before being disabled' });
    expect(r.status).toBe(200);
    expect(qtyOn(nodeDb(), id)).toBe(7);

    const off = await ctx.api.put(`/api/users/${u.body.id}`).set(cloudHdr()).send({ active: false });
    expect(off.status).toBe(200);

    const { pushed } = await syncRound();
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({ state: 'rejected', response_status: 401 });
    expect(qtyOn(nodeDb(), id)).toBe(9); // the offline −2 is undone on the node
    expect(qtyOn(cloudDb(), id)).toBe(9);
    expect(nodeDb().prepare('SELECT state FROM sync_commands WHERE id = ?').get(pushed[0]!.id)).toEqual({ state: 'rejected' });
  });

  it('accepting the same command twice applies it once', async () => {
    await ctx.api.post(`/api/inventory/${itemB}/adjust`).set(nodeHdr()).send({ change: -1, reason: 'Twice' });
    const cmd = sync.pendingCommands(NODE)[0]!;
    const first = await sync.acceptCommand('default', cmd);
    const again = await sync.acceptCommand('default', cmd);
    expect(again).toEqual(first);
    await syncRound();
    expect(qtyOn(cloudDb(), itemB)).toBe(51);
    expect(qtyOn(nodeDb(), itemB)).toBe(51);
  });

  it('refuses a pull that no longer fits this copy instead of half-applying it', async () => {
    await ctx.api.post(`/api/inventory/${itemB}/adjust`).set(cloudHdr()).send({ change: 1, reason: 'Diverge' });
    // Corrupt the node behind sync's back.
    nodeDb().prepare('UPDATE inventory_items SET quantity = 999 WHERE id = ?').run(itemB);
    const before = sync.lastAuthoritySeq(NODE);
    const pull = sync.pullFor('default', NODE_NO, before);
    await expect(sync.applyConfirmed(NODE, pull)).rejects.toBeInstanceOf(sync.SyncDivergenceError);
    expect(qtyOn(nodeDb(), itemB)).toBe(999);
    expect(sync.lastAuthoritySeq(NODE)).toBe(before);
    nodeDb().prepare('UPDATE inventory_items SET quantity = 51 WHERE id = ?').run(itemB); // repair for later tests
    await syncRound();
    expect(qtyOn(nodeDb(), itemB)).toBe(52);
  });
});

describe('document numbers', () => {
  const run = <T>(slug: string, c: import('../src/shared/sync-context').SyncContext, fn: () => T) =>
    dbmod.withTenant(slug, () => ctxmod.syncStore.run(c, fn));

  it('a node issues provisional numbers; rebase reuses them; the cloud issues the real one', () => {
    const rec = { mode: 'record' as const, plan: [], cursor: { id: 0, seq: 0 } };
    const n1 = run(NODE, rec, () => dbmod.nextSequence('order_seq_sale', 'SO'));
    const n2 = run(NODE, rec, () => dbmod.nextSequence('order_seq_sale', 'SO'));
    expect(n1).toBe('SO-P7-0001');
    expect(n2).toBe('SO-P7-0002');
    expect(rec.plan).toEqual([
      { t: 'seq', key: 'order_seq_sale', value: 'SO-P7-0001', provisional: true },
      { t: 'seq', key: 'order_seq_sale', value: 'SO-P7-0002', provisional: true },
    ]);
    const rebase = { mode: 'rebase' as const, plan: rec.plan, cursor: { id: 0, seq: 0 } };
    expect(run(NODE, rebase, () => dbmod.nextSequence('order_seq_sale', 'SO'))).toBe('SO-P7-0001');
    const before = dbmod.withTenant('default', () => dbmod.getSetting<number>('order_seq_sale') ?? 0);
    const replay = { mode: 'replay' as const, plan: rec.plan, cursor: { id: 0, seq: 0 } };
    expect(run('default', replay, () => dbmod.nextSequence('order_seq_sale', 'SO')))
      .toBe(`SO-${String(before + 1).padStart(5, '0')}`);
  });

  it('the cloud keeps a planned non-provisional number and moves its counter past it', () => {
    const replay = {
      mode: 'replay' as const,
      plan: [{ t: 'seq' as const, key: 'order_seq_job', value: 'JO-00500', provisional: false }],
      cursor: { id: 0, seq: 0 },
    };
    expect(run('default', replay, () => dbmod.nextSequence('order_seq_job', 'JO'))).toBe('JO-00500');
    expect(dbmod.withTenant('default', () => dbmod.nextSequence('order_seq_job', 'JO'))).toBe('JO-00501');
  });
});

describe('row ids', () => {
  it('every INSERT shape lands in the node range while recording, and is planned', () => {
    const rec = { mode: 'record' as const, plan: [] as import('../src/shared/sync-context').PlanEntry[], cursor: { id: 0, seq: 0 } };
    const ids = dbmod.withTenant(NODE, () => ctxmod.syncStore.run(rec, () => {
      const a = Number(dbmod.run('INSERT INTO departments (name) VALUES (?)', 'Dept A').lastInsertRowid);
      dbmod.run("INSERT INTO departments (name) VALUES ('Dept B'), ('Dept C')");
      return [a, ...dbmod.queryAll<{ id: number }>("SELECT id FROM departments WHERE name IN ('Dept B', 'Dept C') ORDER BY id").map((r) => r.id)];
    }));
    expect(ids.every((id) => id >= BASE7 && id < BASE7 + 2 ** 37)).toBe(true);
    expect(rec.plan.filter((e) => e.t === 'id' && e.table === 'departments')).toHaveLength(3);
  });

  it('the cloud never allocates into a node range, even after node rows arrive', async () => {
    await syncRound(); // nothing new, but make sure the cloud has seen node-7 rows
    const id = await newItem(1);
    expect(id).toBeLessThan(2 ** 37);
  });
});

describe('unattributed (anonymous-channel) commands', () => {
  it('carry no actor, device, node, sequence, time or planned ids — and a date-only id', async () => {
    // A throwaway route on a mini app bound to the node DB, classed like an anonymous report.
    const mini = express();
    mini.use(express.json());
    mini.use((req, _res, next) => dbmod.tenantStore.run({ db: nodeDb(), slug: NODE }, next));
    mini.use(sync.syncRequestMiddleware);
    mini.post('/anon', sync.syncClass('merge', { unattributed: true }), (_req, res) => {
      dbmod.run('INSERT INTO departments (name) VALUES (?)', 'Anon dept ' + Math.random());
      res.json({ ok: true });
    });
    const r = await supertest(mini).post('/anon').set('X-Device-Id', 'dev-abc').send({ body: 'secret' });
    expect(r.status).toBe(200);
    const row = nodeDb().prepare('SELECT * FROM sync_commands WHERE unattributed = 1').get() as Record<string, unknown>;
    expect(row).toMatchObject({
      node_no: null, node_seq: null, hlc: null, occurred_at: null, actor_user_id: null, device_id: null,
      allocation_plan: '[]', state: 'local',
    });
    const day = row.occurred_date as string;
    const { ulid } = await import('../src/sync/ids-util');
    expect((row.id as string).slice(0, 10)).toBe(ulid(Date.parse(day)).slice(0, 10));
  });
});
