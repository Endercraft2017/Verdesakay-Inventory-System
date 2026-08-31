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

  it('allows multiple items with a blank SKU (stored as null, not "")', async () => {
    const a = await createItem({ name: 'No SKU A', sku: '', quantity: 1 });
    const b = await createItem({ name: 'No SKU B', sku: '   ', quantity: 1 });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);

    const detail = await ctx.api.get(`/api/inventory/${b.body.id}`).set(authHdr());
    expect(detail.body.sku).toBeNull();
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

  it('searches by spec (stored in attributes JSON)', async () => {
    await createItem({ name: 'Bottled Water', sku: 'BW-1', attributes: { spec: '500ml Clear PET' } });
    const res = await ctx.api.get('/api/inventory?q=500ml').set(authHdr());
    expect(res.status).toBe(200);
    expect(res.body.some((i: { sku: string }) => i.sku === 'BW-1')).toBe(true);
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

  it('refuses to delete an item that still has stock', async () => {
    const { body } = await createItem({ name: 'StockedItem', quantity: 12 });
    const blocked = await ctx.api.delete(`/api/inventory/${body.id}`).set(authHdr());
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/in stock/i);

    // zero it out, then it deletes
    await ctx.api.post(`/api/inventory/${body.id}/adjust`).set(authHdr())
      .send({ change: -12, reason: 'clear before delete' });
    expect((await ctx.api.delete(`/api/inventory/${body.id}`).set(authHdr())).status).toBe(200);
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

describe('inventory: product group (variants)', () => {
  it('stores product_group, round-trips on update, and lists it in /product-groups', async () => {
    const chair = await createItem({ name: 'Office Chair - Red', product_group: 'Office Chair' });
    expect(chair.status).toBe(201);
    const detail = await ctx.api.get(`/api/inventory/${chair.body.id}`).set(authHdr());
    expect(detail.body.product_group).toBe('Office Chair');

    await createItem({ name: 'Office Chair - Blue', product_group: 'Office Chair' });

    const groups = await ctx.api.get('/api/inventory/product-groups').set(authHdr());
    expect(groups.body).toContain('Office Chair');

    // Update can change or clear it.
    await ctx.api.put(`/api/inventory/${chair.body.id}`).set(authHdr()).send({ product_group: 'Seating' });
    const updated = await ctx.api.get(`/api/inventory/${chair.body.id}`).set(authHdr());
    expect(updated.body.product_group).toBe('Seating');
  });

  it('is filterable via ?product_group= and searchable via ?q=', async () => {
    await createItem({ name: 'Widget A', product_group: 'Widget Family' });
    await createItem({ name: 'Widget B', product_group: 'Widget Family' });
    await createItem({ name: 'Unrelated Thing', product_group: 'Something Else' });

    const filtered = await ctx.api.get('/api/inventory?product_group=Widget%20Family').set(authHdr());
    expect(filtered.body.length).toBeGreaterThanOrEqual(2);
    expect(filtered.body.every((i: { product_group: string }) => i.product_group === 'Widget Family')).toBe(true);

    // Typing the group name in the general search surfaces every variant, even ones whose
    // own name doesn't repeat it.
    const searched = await ctx.api.get('/api/inventory?q=Widget%20Family').set(authHdr());
    expect(searched.body.some((i: { name: string }) => i.name === 'Widget A')).toBe(true);
    expect(searched.body.some((i: { name: string }) => i.name === 'Widget B')).toBe(true);
  });

  it('a variant with its own spec attribute is fully independent stock — its own row, own quantity', async () => {
    const red = await createItem({ name: 'Mug - Red', product_group: 'Mug', quantity: 10, attributes: { spec: 'Red' } });
    const blue = await createItem({ name: 'Mug - Blue', product_group: 'Mug', quantity: 5, attributes: { spec: 'Blue' } });
    expect(red.body.id).not.toBe(blue.body.id);

    const redDetail = await ctx.api.get(`/api/inventory/${red.body.id}`).set(authHdr());
    const blueDetail = await ctx.api.get(`/api/inventory/${blue.body.id}`).set(authHdr());
    expect(redDetail.body.quantity).toBe(10);
    expect(blueDetail.body.quantity).toBe(5);
    expect(redDetail.body.attributes.spec).toBe('Red');
    expect(blueDetail.body.attributes.spec).toBe('Blue');
  });
});

describe('inventory: supplier link', () => {
  async function mkSupplier(name: string) {
    const r = await ctx.api.post('/api/suppliers').set(authHdr()).send({ name });
    return r.body.id as number;
  }

  it('stores supplier_id on create and returns supplier_name in list + detail', async () => {
    const sid = await mkSupplier('Widget Works');
    const { body } = await createItem({ name: 'Sourced Widget', sku: 'SRC-1', quantity: 3, supplier_id: sid });

    const detail = await ctx.api.get(`/api/inventory/${body.id}`).set(authHdr());
    expect(detail.body.supplier_id).toBe(sid);
    expect(detail.body.supplier_name).toBe('Widget Works');

    const list = await ctx.api.get('/api/inventory?q=Sourced%20Widget').set(authHdr());
    expect(list.body[0].supplier_name).toBe('Widget Works');
  });

  it('filters the item list by supplier_id', async () => {
    const a = await mkSupplier('Supplier Filter A');
    const b = await mkSupplier('Supplier Filter B');
    await createItem({ name: 'SF item a', sku: 'SF-A', supplier_id: a });
    await createItem({ name: 'SF item b', sku: 'SF-B', supplier_id: b });

    const res = await ctx.api.get(`/api/inventory?supplier_id=${a}`).set(authHdr());
    expect(res.body.some((i: { sku: string }) => i.sku === 'SF-A')).toBe(true);
    expect(res.body.some((i: { sku: string }) => i.sku === 'SF-B')).toBe(false);
  });

  it('can clear the supplier link via update (supplier_id = null)', async () => {
    const sid = await mkSupplier('Temp Supplier');
    const { body } = await createItem({ name: 'Unlink me', sku: 'UNL-1', supplier_id: sid });
    await ctx.api.put(`/api/inventory/${body.id}`).set(authHdr()).send({ supplier_id: null });
    const detail = await ctx.api.get(`/api/inventory/${body.id}`).set(authHdr());
    expect(detail.body.supplier_id).toBeNull();
  });
});

describe('inventory: per-location stock', () => {
  const defaultLoc = async () =>
    (await ctx.api.get('/api/locations').set(authHdr())).body.find((l: { is_default: number }) => l.is_default === 1);
  const mkLoc = async (name: string, type = 'warehouse') =>
    (await ctx.api.post('/api/locations').set(authHdr()).send({ name, type })).body.id as number;

  it('initial stock lands at the default location and shows in the breakdown', async () => {
    const def = await defaultLoc();
    const { body } = await createItem({ name: 'PL Item 1', quantity: 12 });

    const stock = await ctx.api.get(`/api/inventory/${body.id}/stock`).set(authHdr());
    expect(stock.status).toBe(200);
    const here = stock.body.find((s: { location_id: number }) => s.location_id === def.id);
    expect(here.quantity).toBe(12);

    const detail = await ctx.api.get(`/api/inventory/${body.id}`).set(authHdr());
    expect(detail.body.quantity).toBe(12); // grand total cache still right
    expect(detail.body.stock[0].location_id).toBe(def.id);
    expect(detail.body.stock[0].quantity).toBe(12);
  });

  it('adjust at a chosen location moves both the location qty and the grand total', async () => {
    const loc = await mkLoc('PL Branch');
    const { body } = await createItem({ name: 'PL Item 2', quantity: 0 });

    const inn = await ctx.api.post(`/api/inventory/${body.id}/adjust`).set(authHdr())
      .send({ change: 7, reason: 'Receive at branch', location_id: loc });
    expect(inn.status).toBe(200);
    expect(inn.body.location_quantity).toBe(7);
    expect(inn.body.quantity).toBe(7);

    const short = await ctx.api.post(`/api/inventory/${body.id}/adjust`).set(authHdr())
      .send({ change: -10, location_id: loc });
    expect(short.status).toBe(400);
    expect(short.body.error).toMatch(/Only 7 available/);
  });

  it('transfers stock between locations without changing the grand total', async () => {
    const a = await mkLoc('PL Warehouse A');
    const b = await mkLoc('PL Warehouse B');
    const { body } = await createItem({ name: 'PL Item 3', quantity: 20, location_id: a });

    const t = await ctx.api.post(`/api/inventory/${body.id}/transfer`).set(authHdr())
      .send({ from_location_id: a, to_location_id: b, amount: 8, reason: 'Rebalance' });
    expect(t.status).toBe(200);
    expect(t.body.from).toBe(12);
    expect(t.body.to).toBe(8);

    const detail = await ctx.api.get(`/api/inventory/${body.id}`).set(authHdr());
    expect(detail.body.quantity).toBe(20); // total unchanged
    const byLoc = Object.fromEntries(detail.body.stock.map((s: { location_id: number; quantity: number }) => [s.location_id, s.quantity]));
    expect(byLoc[a]).toBe(12);
    expect(byLoc[b]).toBe(8);
    // two paired transactions were logged
    expect(detail.body.history.filter((h: { reason: string }) => /Transfer/.test(h.reason || '')).length).toBe(2);
  });

  it('rejects an over-sized or same-location transfer', async () => {
    const a = await mkLoc('PL X');
    const b = await mkLoc('PL Y');
    const { body } = await createItem({ name: 'PL Item 4', quantity: 3, location_id: a });
    expect((await ctx.api.post(`/api/inventory/${body.id}/transfer`).set(authHdr())
      .send({ from_location_id: a, to_location_id: b, amount: 5 })).status).toBe(400);
    expect((await ctx.api.post(`/api/inventory/${body.id}/transfer`).set(authHdr())
      .send({ from_location_id: a, to_location_id: a, amount: 1 })).status).toBe(400);
  });

  it('filters the item list and the movements feed by location', async () => {
    const loc = await mkLoc('PL Only Here');
    const { body } = await createItem({ name: 'PL Item 5', sku: 'PL-5', quantity: 6, location_id: loc });

    const list = await ctx.api.get(`/api/inventory?location_id=${loc}`).set(authHdr());
    expect(list.body.some((i: { sku: string }) => i.sku === 'PL-5')).toBe(true);

    const moves = await ctx.api.get(`/api/inventory/movements?location_id=${loc}`).set(authHdr());
    expect(moves.body.rows.every((r: { location_name: string }) => r.location_name === 'PL Only Here')).toBe(true);
    expect(moves.body.rows[0].location_balance_after).toBe(6);
  });
});

describe('inventory: cross-item movements feed', () => {
  it('lists movements across every item, newest first, with item + user names', async () => {
    const a = await createItem({ name: 'Feed Item A', sku: 'FEED-A', quantity: 10 });
    const b = await createItem({ name: 'Feed Item B', sku: 'FEED-B', quantity: 0 });
    await ctx.api.post(`/api/inventory/${a.body.id}/adjust`).set(authHdr()).send({ change: -3, reason: 'Released' });
    await ctx.api.post(`/api/inventory/${b.body.id}/adjust`).set(authHdr()).send({ change: 5, reason: 'Purchase' });

    const res = await ctx.api.get('/api/inventory/movements').set(authHdr());
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(3); // A initial + A out + B in
    const first = res.body.rows[0];
    expect(first.item_name).toBe('Feed Item B');
    expect(first.change).toBe(5);
    expect(first.user_name).toBeTruthy();
  });

  it('filters by direction and item', async () => {
    const c = await createItem({ name: 'Feed Item C', sku: 'FEED-C', quantity: 20 });
    await ctx.api.post(`/api/inventory/${c.body.id}/adjust`).set(authHdr()).send({ change: -4, reason: 'out1' });
    await ctx.api.post(`/api/inventory/${c.body.id}/adjust`).set(authHdr()).send({ change: 2, reason: 'in1' });

    const out = await ctx.api.get(`/api/inventory/movements?item_id=${c.body.id}&dir=out`).set(authHdr());
    expect(out.body.rows.every((r: { change: number }) => r.change < 0)).toBe(true);
    expect(out.body.rows.some((r: { reason: string }) => r.reason === 'out1')).toBe(true);

    const ins = await ctx.api.get(`/api/inventory/movements?item_id=${c.body.id}&dir=in`).set(authHdr());
    expect(ins.body.rows.every((r: { change: number }) => r.change > 0)).toBe(true);
  });
});

describe('inventory: item image', () => {
  it('uploads, serves, and clears an item photo', async () => {
    const { body } = await createItem({ name: 'Photographed Item', quantity: 1 });

    const up = await ctx.api
      .post(`/api/inventory/${body.id}/image`)
      .set(authHdr())
      .attach('image', Buffer.from('fake-png-bytes'), 'photo.png');
    expect(up.status).toBe(200);
    expect(up.body.image_path).toMatch(/^item-.*\.png$/);

    const detail = await ctx.api.get(`/api/inventory/${body.id}`).set(authHdr());
    expect(detail.body.image_path).toBe(up.body.image_path);

    const img = await ctx.api.get(`/api/inventory/${body.id}/image`).set(authHdr());
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toContain('image/png');

    const del = await ctx.api.delete(`/api/inventory/${body.id}/image`).set(authHdr());
    expect(del.status).toBe(200);
    const after = await ctx.api.get(`/api/inventory/${body.id}/image`).set(authHdr());
    expect(after.status).toBe(404);
  });

  it('rejects a non-image upload', async () => {
    const { body } = await createItem({ name: 'No Photo Item', quantity: 1 });
    const up = await ctx.api
      .post(`/api/inventory/${body.id}/image`)
      .set(authHdr())
      .attach('image', Buffer.from('just text'), 'notes.txt');
    expect(up.status).toBe(400);
  });

  it('404s uploading a photo to a missing item', async () => {
    const up = await ctx.api
      .post('/api/inventory/999999/image')
      .set(authHdr())
      .attach('image', Buffer.from('x'), 'x.png');
    expect(up.status).toBe(404);
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

describe('inventory: RBAC on mutations', () => {
  it('a role with none of the inventory.* permissions (hr) is rejected on create/update/adjust/delete', async () => {
    const item = await createItem({ name: 'RBAC Test Item', quantity: 5, unit: 'pcs', min_quantity: 1 });
    const hr = await createEmployee(ctx.api, token, { username: 'rbac_hr', role: 'hr' });
    const hdr = { Authorization: `Bearer ${hr.token}` };
    expect((await ctx.api.post('/api/inventory').set(hdr).send({ name: 'x', quantity: 1, unit: 'pcs', min_quantity: 0 })).status).toBe(403);
    expect((await ctx.api.put(`/api/inventory/${item.body.id}`).set(hdr).send({ name: 'y' })).status).toBe(403);
    expect((await ctx.api.post(`/api/inventory/${item.body.id}/adjust`).set(hdr).send({ change: 1 })).status).toBe(403);
    expect((await ctx.api.delete(`/api/inventory/${item.body.id}`).set(hdr)).status).toBe(403);
  });

  it('admin_staff (no inventory.delete by default) can create/edit/adjust but not delete', async () => {
    const staff = await createEmployee(ctx.api, token, { username: 'rbac_staff', role: 'admin_staff' });
    const hdr = { Authorization: `Bearer ${staff.token}` };
    const created = await ctx.api.post('/api/inventory').set(hdr).send({ name: 'Staff Item', quantity: 2, unit: 'pcs', min_quantity: 0 });
    expect(created.status).toBe(201);
    expect((await ctx.api.put(`/api/inventory/${created.body.id}`).set(hdr).send({ name: 'Staff Item 2' })).status).toBe(200);
    expect((await ctx.api.post(`/api/inventory/${created.body.id}/adjust`).set(hdr).send({ change: 1 })).status).toBe(200);
    expect((await ctx.api.delete(`/api/inventory/${created.body.id}`).set(hdr)).status).toBe(403);
  });
});
