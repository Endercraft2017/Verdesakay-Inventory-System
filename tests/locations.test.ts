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
