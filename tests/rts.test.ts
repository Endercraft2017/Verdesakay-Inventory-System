/** RTS (ready-to-sell) desk, Figma 74:*: the cross-job-order queue (/api/rts/queue), the final
 *  pre-check (/api/rts/check), finished-goods lookup (/api/rts/lookup), and the protections
 *  products-in now applies — no second posting, no duplicate serial, no transit location, no
 *  posting while a product-data mismatch holds the unit. Every refusal changes no stock. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';

let ctx: TestContext;
let token: string;
let clerk: { id: number; token: string };
let product: number;
let jo: number;
let jo2: number;
let units: number[] = [];
let twin: number;
let warehouse: number;
let truck: number;
const H = () => ({ Authorization: `Bearer ${token}` });
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

async function unit(joId: number, identifier: string) {
  const r = await ctx.api.post(`/api/job-orders/${joId}/units`).set(H()).field('identifier', identifier)
    .attach('image', Buffer.from('unit-photo'), 'unit.png');
  expect(r.status).toBe(201);
  return r.body.id as number;
}
async function releasedJo(qty: number) {
  const id = (await ctx.api.post('/api/job-orders').set(H()).send({ product_item_id: product, qty_ordered: qty, qc_stages: 1 })).body.id;
  await ctx.api.post(`/api/job-orders/${id}/approve`).set(H());
  await ctx.api.post('/api/job-orders/warehouse-accept').set(H()).send({ job_order_ids: [id] });
  await ctx.api.post('/api/job-orders/prepare').set(H()).send({ job_orders: [{ id }] });
  await ctx.api.post(`/api/job-orders/${id}/release`).set(H());
  await ctx.api.post(`/api/job-orders/${id}/accept`).set(H()).send({});
  return id as number;
}
const stock = async () => (await ctx.api.get(`/api/inventory/${product}`).set(H())).body.quantity as number;

beforeAll(async () => {
  ctx = await setupApp();
  token = await login(ctx.api);
  clerk = await createEmployee(ctx.api, token, { role: 'receiving_clerk' });
  product = (await ctx.api.post('/api/inventory').set(H()).send({ name: 'E-Bike RTS', sku: 'EB-RTS-1', quantity: 0 })).body.id;
  const part = (await ctx.api.post('/api/inventory').set(H()).send({ name: 'Frame RTS', quantity: 100 })).body.id;
  await ctx.api.put(`/api/finished-products/${product}`).set(H()).send({ components: [{ component_item_id: part, quantity: 1 }] });
  warehouse = (await ctx.api.post('/api/locations').set(H()).send({ name: 'FG-A03', type: 'warehouse' })).body.id;
  truck = (await ctx.api.post('/api/locations').set(H()).send({ name: 'Truck 7', type: 'truck' })).body.id;
  jo = await releasedJo(3);
  units = [await unit(jo, 'RTS-001'), await unit(jo, 'RTS-002'), await unit(jo, 'RTS-003')];
  await ctx.api.post(`/api/job-orders/${jo}/units/inspect`).set(H()).send({ unit_ids: units, result: 'pass' });
  // A second job order produces a unit under a serial that will already be in stock.
  jo2 = await releasedJo(1);
  twin = await unit(jo2, 'rts-001 ');
  await ctx.api.post(`/api/job-orders/${jo2}/units/inspect`).set(H()).send({ unit_ids: [twin], result: 'pass' });
});
afterAll(() => cleanup(ctx));

describe('RTS desk', () => {
  it('queues passed units across job orders with their final pass record', async () => {
    const q = await ctx.api.get('/api/rts/queue').set(bearer(clerk.token));
    expect(q.status).toBe(200);
    const ids = q.body.units.map((u: { id: number }) => u.id);
    expect(ids).toEqual(expect.arrayContaining([...units, twin]));
    const u0 = q.body.units.find((u: { id: number }) => u.id === units[0]);
    expect(u0).toMatchObject({ identifier: 'RTS-001', sku: 'EB-RTS-1', job_order_id: jo, hold: null });
    expect(u0.final_pass).toMatchObject({ stage: 1 });
  });

  it('refuses a transit location with zero stock change', async () => {
    const before = await stock();
    const chk = await ctx.api.post('/api/rts/check').set(bearer(clerk.token)).send({ unit_ids: [units[0]], location_id: truck });
    expect(chk.body.location_error).toMatch(/storage location/);
    const r = await ctx.api.post(`/api/job-orders/${jo}/products-in`).set(bearer(clerk.token)).send({ location_id: truck, unit_ids: [units[0]] });
    expect(r.status).toBe(400);
    expect(r.body.location_error).toBe(true);
    expect(await stock()).toBe(before);
  });

  it('posts once, then blocks a second posting and a duplicate serial with the existing record', async () => {
    const ok = await ctx.api.post(`/api/job-orders/${jo}/products-in`).set(bearer(clerk.token)).send({ location_id: warehouse, unit_ids: [units[0]] });
    expect(ok.status).toBe(201);
    const after = await stock();
    const again = await ctx.api.post(`/api/job-orders/${jo}/products-in`).set(bearer(clerk.token)).send({ location_id: warehouse, unit_ids: [units[0]] });
    expect(again.status).toBe(409);
    expect(again.body.blockers[0]).toMatchObject({ reason: 'recorded', existing: { receipt_number: ok.body.number, location_name: 'FG-A03' } });
    const dup = await ctx.api.post(`/api/job-orders/${jo2}/products-in`).set(bearer(clerk.token)).send({ location_id: warehouse, unit_ids: [twin] });
    expect(dup.status).toBe(409);
    expect(dup.body.blockers[0]).toMatchObject({ reason: 'duplicate_serial', existing: { unit_id: units[0], receipt_number: ok.body.number } });
    expect(await stock()).toBe(after);
    const chk = await ctx.api.post('/api/rts/check').set(bearer(clerk.token)).send({ unit_ids: [units[1], twin], location_id: warehouse });
    expect(chk.body.blockers.map((b: { unit_id: number }) => b.unit_id)).toEqual([twin]);
    expect(chk.body.location_error).toBeNull();
    const mine = await ctx.api.get('/api/rts/queue').set(bearer(clerk.token));
    expect(mine.body.recorded[0]).toMatchObject({ identifier: 'RTS-001', receipt_number: ok.body.number, location_name: 'FG-A03' });
  });

  it('holds a unit with an open mismatch report until it is resolved', async () => {
    const issue = await ctx.api.post('/api/production-issues').set(bearer(clerk.token)).send({
      job_order_id: jo, unit_id: units[2], category: 'Product-data mismatch', severity: 'high',
      description: 'Model / color does not match physical unit — system: Red, physical: Black',
    });
    expect(issue.status).toBe(201);
    const q = await ctx.api.get('/api/rts/queue').set(bearer(clerk.token));
    expect(q.body.units.find((u: { id: number }) => u.id === units[2]).hold).toMatchObject({ id: issue.body.id });
    const blocked = await ctx.api.post(`/api/job-orders/${jo}/products-in`).set(bearer(clerk.token)).send({ location_id: warehouse, unit_ids: [units[2]] });
    expect(blocked.status).toBe(409);
    expect(blocked.body.blockers[0]).toMatchObject({ reason: 'held', issue_id: issue.body.id });
    const look = await ctx.api.get('/api/rts/lookup?status=hold').set(bearer(clerk.token));
    expect(look.body.units.map((u: { id: number }) => u.id)).toContain(units[2]);
    await ctx.api.post(`/api/production-issues/${issue.body.id}/resolve`).set(H()).send({ resolution: 'Record corrected' });
    const ok = await ctx.api.post(`/api/job-orders/${jo}/products-in`).set(bearer(clerk.token)).send({ location_id: warehouse, unit_ids: [units[2]] });
    expect(ok.status).toBe(201);
  });

  it('looks up recorded units by serial, SKU or receipt, with counts', async () => {
    const look = await ctx.api.get('/api/rts/lookup?q=rts-00').set(bearer(clerk.token));
    expect(look.status).toBe(200);
    expect(look.body.counts.ready).toBeGreaterThanOrEqual(2);
    expect(look.body.units.every((u: { state: string }) => ['ready', 'allocated', 'hold'].includes(u.state))).toBe(true);
    expect(look.body.units.map((u: { identifier: string }) => u.identifier)).toContain('RTS-001');
    const bySku = await ctx.api.get('/api/rts/lookup?q=EB-RTS-1&status=ready').set(bearer(clerk.token));
    expect(bySku.body.units.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps the desk to receiving roles', async () => {
    const qc = await createEmployee(ctx.api, token, { role: 'qc_inspector' });
    expect((await ctx.api.get('/api/rts/queue').set(bearer(qc.token))).status).toBe(403);
  });
});
