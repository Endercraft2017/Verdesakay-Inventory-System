/**
 * Offline-first sync, phase 3b (docs/OFFLINE-FIRST.md §2.4): what people see. Responses from
 * an action saved only on the PC are marked; /api/sync/status feeds the top-bar pill;
 * /api/sync/activity lists what waits and what needs attention, scoped to the person.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cleanup } from './helpers';
import { setupSyncPair, type SyncPair } from './sync-helpers';

let P: SyncPair;
let itemId: number;
let clerkNodeToken: string;
const api = () => P.ctx.api;
const clerkHdr = () => ({ Authorization: `Bearer ${clerkNodeToken}`, 'X-Tenant': P.nodeSlug });

beforeAll(async () => {
  P = await setupSyncPair('plant-c', 11);
  itemId = (await api().post('/api/inventory').set(P.cloudHdr()).send({ name: 'Status item', quantity: 10 })).body.id;
  const u = await api().post('/api/users').set(P.cloudHdr())
    .send({ username: 'clerk-s', full_name: 'Clerk S', password: 'clerkpass1', role: 'warehouse' });
  expect(u.status).toBe(201);
  await P.enrol(); // the clerk exists on the PC from its snapshot
  const r = await api().post('/api/auth/login').set('X-Tenant', P.nodeSlug).send({ username: 'clerk-s', password: 'clerkpass1' });
  expect(r.status).toBe(200);
  clerkNodeToken = r.body.token as string;
});
afterAll(() => cleanup(P.ctx));

describe('marking results that are only on this PC', () => {
  it('an action recorded on the PC says so; the same action on the cloud does not', async () => {
    const n = await api().post(`/api/inventory/${itemId}/adjust`).set(P.nodeHdr()).send({ change: -1 });
    expect(n.headers['x-sync-state']).toBe('local');
    expect(n.headers['x-sync-command']).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(P.sync.pendingCommands(P.nodeSlug).map((c) => c.id)).toContain(n.headers['x-sync-command']);
    const c = await api().post(`/api/inventory/${itemId}/adjust`).set(P.cloudHdr()).send({ change: -1 });
    expect(c.headers['x-sync-state']).toBeUndefined();
    const g = await api().get(`/api/inventory/${itemId}`).set(P.nodeHdr());
    expect(g.headers['x-sync-state']).toBeUndefined();
    await P.round();
  });
});

describe('GET /api/sync/status', () => {
  it('reports the mode: cloud for the workspace, node for the PC', async () => {
    const c = await api().get('/api/sync/status').set(P.cloudHdr());
    expect(c.body).toMatchObject({ mode: 'cloud', discrepancies_open: 0, pcs: 0 });
    const n = await api().get('/api/sync/status').set(P.nodeHdr());
    expect(n.body).toMatchObject({ mode: 'node', node_no: 11, online: null, pending_total: 0, pending: 0, attention: 0 });
  });

  it('counts what waits — per person, with a PC-wide total', async () => {
    await api().post(`/api/inventory/${itemId}/adjust`).set(P.nodeHdr()).send({ change: -1, reason: 'admin' });
    await api().post(`/api/inventory/${itemId}/adjust`).set(clerkHdr()).send({ change: -1, reason: 'clerk' });
    const clerk = await api().get('/api/sync/status').set(clerkHdr());
    expect(clerk.body).toMatchObject({ pending_total: 2, pending: 1 });
    const admin = await api().get('/api/sync/status').set(P.nodeHdr());
    expect(admin.body).toMatchObject({ pending_total: 2, pending: 2 }); // users.manage sees everyone's

    const mine = await api().get('/api/sync/activity?view=pending').set(clerkHdr());
    expect(mine.body).toHaveLength(1);
    expect(mine.body[0]).toMatchObject({ method: 'POST', path: `/api/inventory/${itemId}/adjust`, body: { change: -1, reason: 'clerk' }, state: 'local' });
    const all = await api().get('/api/sync/activity?view=pending').set(P.nodeHdr());
    expect(all.body.map((c: { actor_name: string }) => c.actor_name).sort()).toEqual(['Clerk S', 'System Administrator'].sort());
    await P.round();
    expect((await api().get('/api/sync/status').set(P.nodeHdr())).body.pending_total).toBe(0);
  });

  it('a workspace without sync says "off"', async () => {
    const provisioning = await import('../src/platform/provisioning');
    provisioning.createTenant({ slug: 'plain-s', name: 'Plain', admin_username: 'owner', admin_password: 'plainpass1' });
    const t = (await api().post('/api/auth/login').set('X-Tenant', 'plain-s').send({ username: 'owner', password: 'plainpass1' })).body.token;
    const r = await api().get('/api/sync/status').set({ Authorization: `Bearer ${t}`, 'X-Tenant': 'plain-s' });
    expect(r.body).toMatchObject({ mode: 'off' });
  });
});

describe('needs attention', () => {
  it('lists an action the cloud rejected, with the reason, until it is dismissed', async () => {
    await api().post('/api/inventory').set(P.cloudHdr()).send({ name: 'Cloud SKU', sku: 'ST-1', quantity: 0 });
    const made = await api().post('/api/inventory').set(clerkHdr()).send({ name: 'Clerk SKU', sku: 'ST-1', quantity: 0 });
    expect(made.status).toBe(201);
    await P.round();

    const st = await api().get('/api/sync/status').set(clerkHdr());
    expect(st.body.attention).toBe(1);
    const att = await api().get('/api/sync/activity?view=attention').set(clerkHdr());
    expect(att.body).toMatchObject([{ state: 'rejected', response_status: 409, error: 'An item with that SKU already exists', body: { sku: 'ST-1' } }]);

    // Someone else can't dismiss it…
    const u2 = await api().post('/api/users').set(P.cloudHdr())
      .send({ username: 'clerk-t2', full_name: 'Clerk T2', password: 'clerkpass1', role: 'warehouse' });
    expect(u2.status).toBe(201);
    await P.round();
    const t2 = (await api().post('/api/auth/login').set('X-Tenant', P.nodeSlug).send({ username: 'clerk-t2', password: 'clerkpass1' })).body.token;
    const other = await api().post(`/api/sync/activity/${att.body[0].id}/dismiss`).set({ Authorization: `Bearer ${t2}`, 'X-Tenant': P.nodeSlug });
    expect(other.status).toBe(404);
    // …the person who made it can.
    const ok = await api().post(`/api/sync/activity/${att.body[0].id}/dismiss`).set(clerkHdr());
    expect(ok.status).toBe(200);
    expect((await api().get('/api/sync/status').set(clerkHdr())).body.attention).toBe(0);
    expect((await api().get('/api/sync/activity?view=attention').set(clerkHdr())).body).toEqual([]);
  });

  it('counts open stock discrepancies for people who can see inventory', async () => {
    await api().post(`/api/inventory/${itemId}/adjust`).set(P.nodeHdr()).send({ change: -50, reason: 'Short' });
    await P.round();
    expect((await api().get('/api/sync/status').set(P.nodeHdr())).body.discrepancies_open).toBe(1);
    expect((await api().get('/api/sync/status').set(P.cloudHdr())).body.discrepancies_open).toBe(1);
  });
});
