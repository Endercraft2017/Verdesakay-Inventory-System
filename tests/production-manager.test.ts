/** Production Manager role (production.manage): Lead capabilities plus pause / resume / close
 *  early — each with a required reason kept in job_order_events — without the warehouse's broad
 *  inventory.adjust (no release, cancel, delete or stock adjustment). */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';

let ctx: TestContext;
let token: string;
let manager: { id: number; token: string };
let lead: { id: number; token: string };
const H = () => ({ Authorization: `Bearer ${token}` });
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  ctx = await setupApp();
  token = await login(ctx.api);
  manager = await createEmployee(ctx.api, token, { role: 'production_manager' });
  lead = await createEmployee(ctx.api, token, { role: 'production_lead' });
});
afterAll(() => cleanup(ctx));

const mkItem = async (name: string, quantity = 0) =>
  (await ctx.api.post('/api/inventory').set(H()).send({ name, quantity })).body.id as number;

async function mo(prefix: string, release = true) {
  const product = await mkItem(`${prefix} Product`);
  const part = await mkItem(`${prefix} Part`, 100);
  await ctx.api.put(`/api/finished-products/${product}`).set(H()).send({ components: [{ component_item_id: part, quantity: 2 }] });
  const id = (await ctx.api.post('/api/job-orders').set(H()).send({ product_item_id: product, qty_ordered: 2 })).body.id as number;
  await ctx.api.post(`/api/job-orders/${id}/approve`).set(H());
  if (release) {
    await ctx.api.post('/api/job-orders/warehouse-accept').set(H()).send({ job_order_ids: [id] });
    await ctx.api.post('/api/job-orders/prepare').set(H()).send({ job_orders: [{ id }] });
    await ctx.api.post(`/api/job-orders/${id}/release`).set(H());
  }
  return id;
}

describe('production_manager role', () => {
  it('carries lead + line-decision permissions but not inventory.adjust, and HR may assign it', async () => {
    const { roleDefaults, HR_ASSIGNABLE_ROLES, HR_GRANTABLE_PERMISSIONS } = await import('../src/shared/permissions');
    const perms = roleDefaults('production_manager');
    expect(perms).toEqual(expect.arrayContaining(['production.record', 'production.pause', 'production.manage', 'inventory.mobile']));
    expect(perms).not.toContain('inventory.adjust');
    expect(HR_ASSIGNABLE_ROLES).toContain('production_manager');
    expect(HR_GRANTABLE_PERMISSIONS).toContain('production.manage');
  });

  it('pauses, resumes and closes early — each needs a reason and is recorded', async () => {
    const id = await mo('PM1');
    const m = bearer(manager.token);
    expect((await ctx.api.post(`/api/job-orders/${id}/pause`).set(m)).status).toBe(400);
    expect((await ctx.api.post(`/api/job-orders/${id}/pause`).set(m).send({ reason: '   ' })).status).toBe(400);
    expect((await ctx.api.post(`/api/job-orders/${id}/pause`).set(m).send({ reason: 'Priority rush order' })).status).toBe(200);
    expect((await ctx.api.post(`/api/job-orders/${id}/resume`).set(m)).status).toBe(400);
    expect((await ctx.api.post(`/api/job-orders/${id}/resume`).set(m).send({ reason: 'Rush order shipped' })).status).toBe(200);
    expect((await ctx.api.post(`/api/job-orders/${id}/close`).set(m)).status).toBe(400);
    const closed = await ctx.api.post(`/api/job-orders/${id}/close`).set(m).send({ reason: 'Customer cut the order to 1' });
    expect(closed.status).toBe(200);
    expect(closed.body.job_order.status).toBe('completed');

    const events = await ctx.api.get(`/api/job-orders/${id}/events`).set(m);
    expect(events.body.map((e: { action: string; reason: string }) => [e.action, e.reason])).toEqual([
      ['close_early', 'Customer cut the order to 1'],
      ['resume', 'Rush order shipped'],
      ['pause', 'Priority rush order'],
    ]);
    expect(events.body.every((e: { actor_name: string }) => !!e.actor_name)).toBe(true);
  });

  it('cannot release, cancel or delete, and a plain lead cannot close early', async () => {
    const draft = await mo('PM2', false);
    const m = bearer(manager.token);
    expect((await ctx.api.post(`/api/job-orders/${draft}/release`).set(m)).status).toBe(403);
    expect((await ctx.api.post(`/api/job-orders/${draft}/cancel`).set(m)).status).toBe(403);
    expect((await ctx.api.delete(`/api/job-orders/${draft}`).set(m)).status).toBe(403);
    const running = await mo('PM3');
    expect((await ctx.api.post(`/api/job-orders/${running}/close`).set(bearer(lead.token)).send({ reason: 'x' })).status).toBe(403);
  });

  it('keeps the reason optional for the broad inventory.adjust override, but still logs the event', async () => {
    const id = await mo('PM4');
    expect((await ctx.api.post(`/api/job-orders/${id}/pause`).set(H())).status).toBe(200);
    const events = await ctx.api.get(`/api/job-orders/${id}/events`).set(H());
    expect(events.body[0]).toMatchObject({ action: 'pause', reason: null });
  });
});
