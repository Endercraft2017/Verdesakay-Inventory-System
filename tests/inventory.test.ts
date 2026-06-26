/** Integration tests: inventory CRUD, stock movements, history, stats, low-stock. */
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

async function createItem(body: Record<string, unknown>) {
  const res = await ctx.api.post('/api/inventory').set(authHdr()).send(body);
  return res;
}

describe('inventory', () => {
  it('creates an item with initial stock and records a transaction', async () => {
    const res = await createItem({ name: 'Bond Paper A4', sku: 'PPR-A4', quantity: 50, min_quantity: 10, unit: 'reams' });
    expect(res.status).toBe(201);
    const id = res.body.id;

    const detail = await ctx.api.get(`/api/inventory/${id}`).set(authHdr());
    expect(detail.body.quantity).toBe(50);
    expect(detail.body.history).toHaveLength(1);
    expect(detail.body.history[0].reason).toBe('Initial stock');
  });

  it('rejects a duplicate SKU', async () => {
    await createItem({ name: 'Item One', sku: 'DUP-1', quantity: 1 });
    const res = await createItem({ name: 'Item Two', sku: 'DUP-1', quantity: 1 });
    expect(res.status).toBe(409);
  });

  it('stocks in and out, tracking the running balance', async () => {
    const { body } = await createItem({ name: 'Markers', quantity: 20 });
    const id = body.id;

    const out = await ctx.api.post(`/api/inventory/${id}/adjust`).set(authHdr()).send({ change: -5, reason: 'Released' });
    expect(out.status).toBe(200);
    expect(out.body.quantity).toBe(15);

    const inn = await ctx.api.post(`/api/inventory/${id}/adjust`).set(authHdr()).send({ change: 10, reason: 'Restock' });
    expect(inn.body.quantity).toBe(25);

    const detail = await ctx.api.get(`/api/inventory/${id}`).set(authHdr());
    expect(detail.body.history).toHaveLength(3); // initial + out + in
    expect(detail.body.history[0].balance_after).toBe(25); // newest first
  });

  it('refuses to take stock below zero', async () => {
    const { body } = await createItem({ name: 'Staplers', quantity: 3 });
    const res = await ctx.api.post(`/api/inventory/${body.id}/adjust`).set(authHdr()).send({ change: -10 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Only 3 available/);
  });

  it('rejects a zero adjustment (validation)', async () => {
    const { body } = await createItem({ name: 'Tape', quantity: 5 });
    const res = await ctx.api.post(`/api/inventory/${body.id}/adjust`).set(authHdr()).send({ change: 0 });
    expect(res.status).toBe(400);
  });

  it('filters low-stock items', async () => {
    await createItem({ name: 'LowItem', quantity: 2, min_quantity: 5 });
    const res = await ctx.api.get('/api/inventory?low=1').set(authHdr());
    expect(res.status).toBe(200);
    expect(res.body.every((i: { low_stock: number }) => i.low_stock === 1)).toBe(true);
    expect(res.body.some((i: { name: string }) => i.name === 'LowItem')).toBe(true);
  });

  it('searches by name/sku', async () => {
    await createItem({ name: 'Unique Widget XZ', sku: 'WID-XZ' });
    const res = await ctx.api.get('/api/inventory?q=widget%20xz').set(authHdr());
    expect(res.body.some((i: { sku: string }) => i.sku === 'WID-XZ')).toBe(true);
  });

  it('updates item details without touching quantity', async () => {
    const { body } = await createItem({ name: 'Old Name', quantity: 7 });
    const upd = await ctx.api.put(`/api/inventory/${body.id}`).set(authHdr()).send({ name: 'New Name', location: 'Shelf B' });
    expect(upd.status).toBe(200);
    const detail = await ctx.api.get(`/api/inventory/${body.id}`).set(authHdr());
    expect(detail.body.name).toBe('New Name');
    expect(detail.body.location).toBe('Shelf B');
    expect(detail.body.quantity).toBe(7);
  });

  it('deletes an item', async () => {
    const { body } = await createItem({ name: 'ToDelete' });
    const del = await ctx.api.delete(`/api/inventory/${body.id}`).set(authHdr());
    expect(del.status).toBe(200);
    const detail = await ctx.api.get(`/api/inventory/${body.id}`).set(authHdr());
    expect(detail.status).toBe(404);
  });

  it('reports dashboard stats', async () => {
    const res = await ctx.api.get('/api/inventory/stats').set(authHdr());
    expect(res.status).toBe(200);
    expect(typeof res.body.items).toBe('number');
    expect(res.body.items).toBeGreaterThan(0);
  });

  it('filters by category and lists distinct categories', async () => {
    await createItem({ name: 'Cat Item A', category: 'Stationery' });
    await createItem({ name: 'Cat Item B', category: 'Stationery' });
    await createItem({ name: 'Cat Item C', category: 'Hardware' });

    const filtered = await ctx.api.get('/api/inventory?category=Stationery').set(authHdr());
    expect(filtered.status).toBe(200);
    expect(filtered.body.length).toBeGreaterThanOrEqual(2);
    expect(filtered.body.every((i: { category: string }) => i.category === 'Stationery')).toBe(true);

    const cats = await ctx.api.get('/api/inventory/categories').set(authHdr());
    expect(cats.status).toBe(200);
    expect(cats.body).toContain('Stationery');
    expect(cats.body).toContain('Hardware');
    // distinct — 'Stationery' appears once despite two items
    expect(cats.body.filter((c: string) => c === 'Stationery')).toHaveLength(1);
  });
});

describe('inventory: extended attributes (ECOUNT-style fields)', () => {
  it('stores and returns attributes as a parsed object on create + get', async () => {
    const res = await createItem({
      name: 'Attr Item',
      sku: 'ATTR-1',
      attributes: { item_category: 'Merchandise', sale_price: '199.00', purchase_price_tax_incl: true },
    });
    expect(res.status).toBe(201);

    const detail = await ctx.api.get(`/api/inventory/${res.body.id}`).set(authHdr());
    expect(detail.body.attributes).toMatchObject({
      item_category: 'Merchandise',
      sale_price: '199.00',
      purchase_price_tax_incl: true,
    });

    const list = await ctx.api.get('/api/inventory?q=Attr%20Item').set(authHdr());
    const found = list.body.find((i: { sku: string }) => i.sku === 'ATTR-1');
    expect(found.attributes.item_category).toBe('Merchandise');
  });

  it('updates attributes and defaults to an empty object when never set', async () => {
    const { body } = await createItem({ name: 'Plain Item' });
    const detail0 = await ctx.api.get(`/api/inventory/${body.id}`).set(authHdr());
    expect(detail0.body.attributes).toEqual({});

    await ctx.api.put(`/api/inventory/${body.id}`).set(authHdr())
      .send({ attributes: { barcode: '4006381333931' } });
    const detail = await ctx.api.get(`/api/inventory/${body.id}`).set(authHdr());
    expect(detail.body.attributes.barcode).toBe('4006381333931');
  });
});

describe('inventory: item form-config', () => {
  it('returns null before anything is saved', async () => {
    const res = await ctx.api.get('/api/inventory/form-config').set(authHdr());
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });

  it('lets an admin save the layout and reads it back', async () => {
    const payload = [
      { key: 'sku', visible: true, required: true, default: null },
      { key: 'barcode', visible: false, required: false, default: '' },
    ];
    const put = await ctx.api.put('/api/inventory/form-config').set(authHdr()).send(payload);
    expect(put.status).toBe(200);

    const res = await ctx.api.get('/api/inventory/form-config').set(authHdr());
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toMatchObject({ key: 'sku', visible: true, required: true });
    expect(res.body[1]).toMatchObject({ key: 'barcode', visible: false });
  });

  it('forbids a non-admin from saving the layout', async () => {
    const emp = await createEmployee(ctx.api, token);
    const res = await ctx.api
      .put('/api/inventory/form-config')
      .set({ Authorization: `Bearer ${emp.token}` })
      .send([{ key: 'sku', visible: true, required: false }]);
    expect(res.status).toBe(403);
  });
});
