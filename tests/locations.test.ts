/** Locations registry + the single-default rule + delete guards. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';

let ctx: TestContext;
let token: string;
const authHdr = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  ctx = await setupApp();
  token = await login(ctx.api);
});
afterAll(() => cleanup(ctx));

const mkLoc = (body: Record<string, unknown>) =>
  ctx.api.post('/api/locations').set(authHdr()).send(body);

describe('locations', () => {
  it('seeds a default location on a fresh install', async () => {
    const res = await ctx.api.get('/api/locations').set(authHdr());
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].is_default).toBe(1);
  });

  it('creates a location; only one can be default at a time', async () => {
    const seededDefault = (await ctx.api.get('/api/locations').set(authHdr())).body[0];

    const branch = await mkLoc({ name: 'Cebu Branch', type: 'branch', address: '1 Osmeña Blvd' });
    expect(branch.status).toBe(201);

    const truck = await mkLoc({ name: 'Delivery Truck 1', type: 'truck', is_default: true });
    expect(truck.status).toBe(201);

    const list = (await ctx.api.get('/api/locations').set(authHdr())).body;
    const defaults = list.filter((l: { is_default: number }) => l.is_default === 1);
    expect(defaults.length).toBe(1);
    expect(defaults[0].id).toBe(truck.body.id);
    expect(list.find((l: { id: number }) => l.id === seededDefault.id).is_default).toBe(0);
  });

  it('validates the type enum and requires a name', async () => {
    expect((await mkLoc({ type: 'warehouse' })).status).toBe(400);
    expect((await mkLoc({ name: 'Bad Type', type: 'spaceship' })).status).toBe(400);
  });

  it('supports optional sublocations through level five and stocks the selected level', async () => {
    const root = (await mkLoc({ name: 'Hierarchy Warehouse' })).body.id;
    const room = (await mkLoc({ name: 'Room A', parent_id: root })).body.id;
    expect((await mkLoc({ name: 'room a', parent_id: root })).status).toBe(409);
    const section = (await mkLoc({ name: 'Section B', parent_id: room })).body.id;
    const shelf = (await mkLoc({ name: 'Shelf 4', parent_id: section })).body.id;
    const bin = (await mkLoc({ name: 'Bin 3', parent_id: shelf })).body.id;
    const six = await mkLoc({ name: 'Too Deep', parent_id: bin });
    expect(six.status).toBe(400);
    const list = (await ctx.api.get('/api/locations').set(authHdr())).body;
    expect(list.find((l: { id: number }) => l.id === bin)).toMatchObject({
      parent_id: shelf, depth: 5, path: 'Hierarchy Warehouse / Room A / Section B / Shelf 4 / Bin 3',
    });
    const item = await ctx.api.post('/api/inventory').set(authHdr()).send({ name: 'Hierarchy Part', quantity: 7, location_id: bin });
    expect(item.status).toBe(201);
    const stock = (await ctx.api.get(`/api/inventory/${item.body.id}/stock`).set(authHdr())).body;
    expect(stock.find((s: { location_id: number }) => s.location_id === bin).quantity).toBe(7);
    expect((await ctx.api.delete(`/api/locations/${shelf}`).set(authHdr())).status).toBe(409);
    expect((await ctx.api.put(`/api/locations/${root}`).set(authHdr()).send({ parent_id: bin })).status).toBe(400);
    expect((await ctx.api.put(`/api/locations/${room}`).set(authHdr()).send({ parent_id: null })).status).toBe(200);
    expect((await ctx.api.get(`/api/locations/${bin}`).set(authHdr())).body.path).toBe('Room A / Section B / Shelf 4 / Bin 3');
  });

  it('creates new levels with an item atomically and keeps parent totals separate', async () => {
    const warehouse = (await mkLoc({ name: 'Inline Warehouse' })).body.id;
    const created = await ctx.api.post('/api/inventory').set(authHdr()).send({
      name: 'Inline Part', quantity: 6, location_id: warehouse,
      new_location_levels: ['Room 1', 'Section A', 'Shelf 2', 'Bin 7'],
    });
    expect(created.status).toBe(201);
    const bin = created.body.preferred_location_id;
    const item = (await ctx.api.get(`/api/inventory/${created.body.id}`).set(authHdr())).body;
    expect(item.preferred_location_id).toBe(bin);
    const locations = (await ctx.api.get('/api/locations').set(authHdr())).body;
    expect(locations.find((l: { id: number }) => l.id === bin).path)
      .toBe('Inline Warehouse / Room 1 / Section A / Shelf 2 / Bin 7');
    const found = (await ctx.api.get('/api/locations?q=Inline%20Warehouse%20%2F%20Room%201').set(authHdr())).body;
    expect(found.some((l: { id: number }) => l.id === bin)).toBe(true);
    expect(locations.find((l: { id: number }) => l.id === warehouse))
      .toMatchObject({ total_units: 0, subtree_units: 6, item_count: 0, subtree_item_count: 1 });
    expect((await ctx.api.get(`/api/locations/${warehouse}`).set(authHdr())).body.items).toEqual([]);
    expect((await ctx.api.post(`/api/inventory/${created.body.id}/adjust`).set(authHdr()).send({
      change: 2, location_id: warehouse, reason: 'Parent-level stock',
    })).status).toBe(200);
    const afterParentStock = (await ctx.api.get(`/api/locations/${warehouse}`).set(authHdr())).body;
    expect(afterParentStock).toMatchObject({ total_units: 2, subtree_units: 8, item_count: 1, subtree_item_count: 1 });
    expect((await ctx.api.get(`/api/locations/${bin}`).set(authHdr())).body)
      .toMatchObject({ total_units: 6, subtree_units: 6 });

    const before = locations.length;
    const failed = await ctx.api.post('/api/inventory').set(authHdr()).send({
      name: 'Inline Part', sku: 'INLINE-ROLLBACK', quantity: 1, location_id: warehouse,
      new_location_levels: ['Room 1'],
    });
    expect(failed.status).toBe(409);
    expect((await ctx.api.get('/api/locations').set(authHdr())).body).toHaveLength(before);
    expect((await ctx.api.get('/api/inventory?sku=INLINE-ROLLBACK').set(authHdr())).body
      .some((i: { sku: string }) => i.sku === 'INLINE-ROLLBACK')).toBe(false);

    const zero = await ctx.api.post('/api/inventory').set(authHdr()).send({ name: 'Zero-stock Bin Part', quantity: 0, location_id: bin });
    expect(zero.status).toBe(201);
    expect((await ctx.api.get(`/api/inventory/${zero.body.id}`).set(authHdr())).body.preferred_location_id).toBe(bin);
    expect((await ctx.api.post('/api/inventory').set(authHdr()).send({
      name: 'Sixth-level Part', quantity: 1, location_id: bin, new_location_levels: ['Too deep'],
    })).status).toBe(400);
    expect((await ctx.api.post('/api/inventory').set(authHdr()).send({
      name: 'Unanchored Part', quantity: 1, new_location_levels: ['Orphan Shelf'],
    })).status).toBe(400);
    expect((await ctx.api.post('/api/inventory').set(authHdr()).send({
      name: 'Negative Starting Stock', quantity: -1, location_id: bin,
    })).status).toBe(400);
  });

  it('keeps same-named shelves separate through transfers and kit picks', async () => {
    const a = (await mkLoc({ name: 'Pick Warehouse A' })).body.id;
    const b = (await mkLoc({ name: 'Pick Warehouse B' })).body.id;
    const shelfA = (await mkLoc({ name: 'Shared Shelf', parent_id: a })).body.id;
    const shelfB = (await mkLoc({ name: 'Shared Shelf', parent_id: b })).body.id;
    const part = (await ctx.api.post('/api/inventory').set(authHdr()).send({
      name: 'Two-shelf Part', quantity: 3, location_id: shelfA,
    })).body.id;
    expect((await ctx.api.post(`/api/inventory/${part}/transfer`).set(authHdr()).send({
      from_location_id: shelfA, to_location_id: shelfB, amount: 2,
    })).status).toBe(200);
    const stock = (await ctx.api.get(`/api/inventory/${part}/stock`).set(authHdr())).body;
    expect(stock.find((s: { location_id: number }) => s.location_id === shelfA))
      .toMatchObject({ quantity: 1, location_name: 'Pick Warehouse A / Shared Shelf' });
    expect(stock.find((s: { location_id: number }) => s.location_id === shelfB))
      .toMatchObject({ quantity: 2, location_name: 'Pick Warehouse B / Shared Shelf' });
    const product = (await ctx.api.post('/api/inventory').set(authHdr()).send({
      name: 'Two-shelf Product', quantity: 0, location_id: shelfA,
    })).body.id;
    await ctx.api.put(`/api/finished-products/${product}`).set(authHdr()).send({
      components: [{ component_item_id: part, quantity: 1 }],
    });
    const job = (await ctx.api.post('/api/job-orders').set(authHdr()).send({
      product_item_id: product, qty_ordered: 2, source_location_id: shelfA,
    })).body.id;
    await ctx.api.post(`/api/job-orders/${job}/approve`).set(authHdr()).send({});
    await ctx.api.post('/api/job-orders/warehouse-accept').set(authHdr()).send({ job_order_ids: [job] });
    const blocked = await ctx.api.post('/api/job-orders/prepare').set(authHdr()).send({ job_orders: [{ id: job }] });
    expect(blocked.status).toBe(400);
    expect(blocked.body.shortfalls[0]).toMatchObject({ available: 1, picking: 2 });
    expect((await ctx.api.post(`/api/inventory/${part}/transfer`).set(authHdr()).send({
      from_location_id: shelfB, to_location_id: shelfA, amount: 1,
    })).status).toBe(200);
    expect((await ctx.api.post('/api/job-orders/prepare').set(authHdr()).send({ job_orders: [{ id: job }] })).status).toBe(200);
  });

  it('set-as-default endpoint moves the flag', async () => {
    const a = await mkLoc({ name: 'Default Test A' });
    const set = await ctx.api.post(`/api/locations/${a.body.id}/default`).set(authHdr());
    expect(set.status).toBe(200);
    const list = (await ctx.api.get('/api/locations').set(authHdr())).body;
    expect(list.filter((l: { is_default: number }) => l.is_default === 1).map((l: { id: number }) => l.id)).toEqual([a.body.id]);
  });

  it('blocks deleting a location that still holds stock, allows it once emptied', async () => {
    const loc = await mkLoc({ name: 'Holds Stock' });
    const item = await ctx.api.post('/api/inventory').set(authHdr())
      .send({ name: 'Loc Item', quantity: 4, location_id: loc.body.id });
    expect(item.status).toBe(201);

    const blocked = await ctx.api.delete(`/api/locations/${loc.body.id}`).set(authHdr());
    expect(blocked.status).toBe(409);

    // move it all out to the default location, then delete succeeds
    const def = (await ctx.api.get('/api/locations').set(authHdr())).body.find((l: { is_default: number }) => l.is_default === 1);
    await ctx.api.post(`/api/inventory/${item.body.id}/transfer`).set(authHdr())
      .send({ from_location_id: loc.body.id, to_location_id: def.id, amount: 4 });
    const ok = await ctx.api.delete(`/api/locations/${loc.body.id}`).set(authHdr());
    expect(ok.status).toBe(200);
  });

  it('blocks deleting the default location while other locations exist', async () => {
    const def = (await ctx.api.get('/api/locations').set(authHdr())).body.find((l: { is_default: number }) => l.is_default === 1);
    const res = await ctx.api.delete(`/api/locations/${def.id}`).set(authHdr());
    expect(res.status).toBe(409);
  });

  it('is write-gated on inventory permissions', async () => {
    const hr = await createEmployee(ctx.api, token, { role: 'hr', username: 'loc_hr_user' });
    const res = await ctx.api.post('/api/locations').set('Authorization', `Bearer ${hr.token}`).send({ name: 'Nope' });
    expect(res.status).toBe(403);
  });
});
