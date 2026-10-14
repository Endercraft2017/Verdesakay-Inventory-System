/** Approval and shortage planning must use the same warehouse, holds and durable demand. */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { setupApp, cleanup, login, type TestContext } from './helpers';
let ctx: TestContext, token: string;
let db: typeof import('../src/shared/db');
let home: number, other: number;
const H = () => ({ Authorization: `Bearer ${token}` });
beforeAll(async () => {
  ctx = await setupApp(); token = await login(ctx.api); db = await import('../src/shared/db');
  home = db.queryOne<{ id: number }>('SELECT id FROM locations WHERE is_default = 1')!.id;
  other = (await ctx.api.post('/api/locations').set(H()).send({ name: 'Planning other warehouse', type: 'warehouse' })).body.id;
});
afterAll(() => cleanup(ctx));
async function item(name: string, quantity = 0) {
  const r = await ctx.api.post('/api/inventory').set(H()).send({ name, quantity }); expect(r.status).toBe(201); return r.body.id as number;
}
async function sale(items: { item_id: number; name: string; quantity: number }[], location_id = home) {
  const r = await ctx.api.post('/api/orders').set(H()).send({ type: 'sale', location_id, items }); expect(r.status).toBe(201); return r.body.id as number;
}
async function bom(product: number, part: number, quantity = 1) {
  expect((await ctx.api.put(`/api/finished-products/${product}`).set(H()).send({ components: [{ component_item_id: part, quantity }] })).status).toBe(200);
}
const av = async (id: number) => (await ctx.api.get(`/api/orders/${id}/availability`).set(H())).body;
const produce = (id: number, body = {}) => ctx.api.post(`/api/orders/${id}/produce-shortfall`).set(H()).send(body);
const purchase = (id: number, body = {}) => ctx.api.post(`/api/orders/${id}/purchase-shortfall`).set(H()).send(body);

describe('location-scoped approval and planning', () => {
  it('refuses to promise another warehouse stock and does not subtract its sales commitments', async () => {
    const i = await item('Location proof', 12);
    const remoteSale = await sale([{ item_id: i, name: 'Location proof', quantity: 8 }]);
    expect((await ctx.api.post(`/api/orders/${remoteSale}/status`).set(H()).send({ status: 'approved' })).status).toBe(200);
    const id = await sale([{ item_id: i, name: 'Location proof', quantity: 3 }], other);
    const snapshot = await av(id);
    expect(snapshot).toMatchObject({ location_id: other, ok: false });
    expect(snapshot.lines[0]).toMatchObject({ on_hand: 0, elsewhere_on_hand: 12, committed_elsewhere: 0, shortfall: 3 });
    expect((await ctx.api.post(`/api/orders/${id}/status`).set(H()).send({ status: 'approved' })).status).toBe(409);
  });
  it('deducts draft kit picks and repair holds at the source, not holds elsewhere', async () => {
    const part = await item('Held stock', 10), product = await item('Holding product'); await bom(product, part);
    const jo = Number(db.run("INSERT INTO job_orders(number, product_item_id, product_name, qty_ordered, source_location_id, output_location_id) VALUES ('HOLD-FIXTURE', ?, 'Holding product', 1, ?, ?)", product, home, home).lastInsertRowid);
    db.run("INSERT INTO job_order_components(job_order_id, component_item_id, component_name, qty_per_unit, qty_planned, qty_picked) VALUES (?, ?, 'Held stock', 1, 3, 3)", jo, part);
    const u = Number(db.run('INSERT INTO job_order_units(job_order_id, product_item_id) VALUES (?, ?)', jo, product).lastInsertRowid);
    const request = Number(db.run("INSERT INTO repair_part_requests(number, unit_id, component_item_id, component_name, quantity) VALUES ('HOLD-REQ', ?, ?, 'Held stock', 2)", u, part).lastInsertRowid);
    db.run('INSERT INTO repair_part_holds(request_id, item_id, location_id, quantity) VALUES (?, ?, ?, 2)', request, part, home);
    const id = await sale([{ item_id: part, name: 'Held stock', quantity: 6 }]);
    expect((await av(id)).lines[0]).toMatchObject({ kit_held: 3, repair_held: 2, available: 5, shortfall: 1 });
    db.run('UPDATE repair_part_holds SET location_id = ? WHERE request_id = ?', other, request);
    expect((await av(id)).lines[0]).toMatchObject({ repair_held: 0, available: 7, shortfall: 0 });
  });
  it('does not double-count shared production materials and sale lines for those materials', async () => {
    const raw = await item('Shared raw', 5), a = await item('Built A'), b = await item('Built B'); await bom(a, raw, 2); await bom(b, raw, 2);
    const id = await sale([{ item_id: a, name: 'Built A', quantity: 2 }, { item_id: b, name: 'Built B', quantity: 2 }, { item_id: raw, name: 'Shared raw', quantity: 1 }]);
    const snapshot = await av(id);
    expect(snapshot.lines[0].buildable).toBe(true);
    expect(snapshot.lines[1].buildable).toBe(false);
    expect(snapshot.purchase_requirements).toEqual([expect.objectContaining({ item_id: raw, shortage: 4, to_purchase: 4 })]);
    const r = await purchase(id); expect(r.status).toBe(200);
    const po = (await ctx.api.get(`/api/orders/${r.body.created[0].id}`).set(H())).body;
    expect(po.items[0]).toMatchObject({ item_id: raw, quantity: 4 });
  });
  it('keeps passed-but-unreceived production covered even when the job is completed', async () => {
    const product = await item('Pending receipt'), part = await item('Pending part', 10); await bom(product, part);
    const id = await sale([{ item_id: product, name: 'Pending receipt', quantity: 2 }]);
    const first = await produce(id); expect(first.status).toBe(200);
    const jo = first.body.created[0].job_order_id;
    db.run("UPDATE job_orders SET status = 'completed', qty_done = 2 WHERE id = ?", jo);
    expect((await av(id)).lines[0]).toMatchObject({ shortfall: 2, linked_job_orders: [expect.objectContaining({ id: jo, remaining: 2 })] });
    expect((await produce(id)).body.created).toEqual([]);
    db.run('UPDATE job_orders SET qty_scrapped = 1, qty_done = 1 WHERE id = ?', jo);
    expect((await produce(id)).body.created[0].qty).toBe(1);
  });
  it('uses linked draft job snapshots after the product BOM changes', async () => {
    const p = await item('Snapshot product'), oldPart = await item('Snapshot old'), newPart = await item('Snapshot new'); await bom(p, oldPart, 2);
    const id = await sale([{ item_id: p, name: 'Snapshot product', quantity: 3 }]); await produce(id); await bom(p, newPart, 7);
    expect((await av(id)).purchase_requirements).toEqual([expect.objectContaining({ item_id: oldPart, to_purchase: 6 })]);
  });
  it('retains existing job requirements even if the current product recipe is removed', async () => {
    const p = await item('Removed recipe'), raw = await item('Saved recipe raw'); await bom(p, raw, 2);
    const id = await sale([{ item_id: p, name: 'Removed recipe', quantity: 2 }]); await produce(id);
    db.run('DELETE FROM bom_components WHERE product_item_id = ?', p);
    db.run('UPDATE inventory_items SET is_finished_product = 0 WHERE id = ?', p);
    expect((await av(id)).purchase_requirements).toEqual([expect.objectContaining({ item_id: raw, to_purchase: 4 })]);
  });
  it('does not repurchase parts already issued to a linked job', async () => {
    const p = await item('Issued product'), raw = await item('Issued raw'); await bom(p, raw);
    const id = await sale([{ item_id: p, name: 'Issued product', quantity: 2 }]); const jo = (await produce(id)).body.created[0].job_order_id;
    db.run("UPDATE job_orders SET status = 'released' WHERE id = ?", jo);
    expect((await av(id)).purchase_requirements).toEqual([]);
    expect((await purchase(id)).body.created).toEqual([]);
  });
});

describe('repeat-safe supply and revision checks', () => {
  it('creates only incremental demand, survives PO line replacements, and reopens cancelled cover', async () => {
    const i = await item('Retry purchased'); const id = await sale([{ item_id: i, name: 'Retry purchased', quantity: 5 }]);
    const first = await purchase(id); expect(first.body.created).toHaveLength(1); const po = first.body.created[0].id;
    expect((await purchase(id)).body.created).toEqual([]);
    expect((await av(id)).lines[0].shortfall).toBe(5); // a draft never becomes stock
    expect((await ctx.api.put(`/api/orders/${po}`).set(H()).send({ items: [{ item_id: i, name: 'Retry purchased', quantity: 3 }] })).status).toBe(200);
    const increment = await purchase(id); expect(increment.body.created).toHaveLength(1);
    expect((await ctx.api.get(`/api/orders/${increment.body.created[0].id}`).set(H())).body.items[0].quantity).toBe(2);
    expect((await purchase(id)).body.created).toEqual([]);
    await ctx.api.put(`/api/orders/${po}`).set(H()).send({ status: 'cancelled' });
    expect((await av(id)).purchase_requirements[0]).toMatchObject({ pending_purchase: 2, to_purchase: 3 });
  });
  it('subtracts partial receipts from pending cover while received stock satisfies demand', async () => {
    const i = await item('Partially received'); const id = await sale([{ item_id: i, name: 'Partially received', quantity: 5 }]);
    const po = (await purchase(id)).body.created[0].id;
    const line = (await ctx.api.get(`/api/orders/${po}`).set(H())).body.items[0];
    const receipt = await ctx.api.post(`/api/purchasing/orders/${po}/receipts`).set(H()).send({ location_id: home, lines: [{ order_item_id: line.id, item_id: i, name: line.name, quantity: 2 }] });
    expect(receipt.status).toBe(201);
    expect((await av(id)).purchase_requirements[0]).toMatchObject({ shortage: 3, pending_purchase: 3, to_purchase: 0 });
    expect((await purchase(id)).body.created).toEqual([]);
  });
  it('rejects stale review decisions and shortage actions without changing anything', async () => {
    const i = await item('Stale demand'); const id = await sale([{ item_id: i, name: 'Stale demand', quantity: 2 }]); const review = await av(id);
    await ctx.api.put(`/api/orders/${id}`).set(H()).send({ notes: 'Changed after review' });
    for (const endpoint of ['status', 'purchase-shortfall', 'produce-shortfall']) {
      const r = await ctx.api.post(`/api/orders/${id}/${endpoint}`).set(H()).send({ expected_revision: review.revision, status: 'approved', force: true });
      expect(r.status).toBe(409); expect(r.body.code).toBe('stale_order');
    }
    expect((await ctx.api.get(`/api/orders/${id}`).set(H())).body.status).toBe('open');
  });
  it('rechecks stock at approval even when the order revision remains valid', async () => {
    const i = await item('Concurrent stock', 5), id = await sale([{ item_id: i, name: 'Concurrent stock', quantity: 5 }]); const review = await av(id);
    await ctx.api.post(`/api/inventory/${i}/adjust`).set(H()).send({ change: -3, location_id: home });
    const result = await ctx.api.post(`/api/orders/${id}/status`).set(H()).send({ status: 'approved', expected_revision: review.revision });
    expect(result.status).toBe(409); expect(result.body.availability.lines[0].shortfall).toBe(3);
  });
  it('does not create supply for cancelled or fulfilled sales', async () => {
    const i = await item('Inactive demand'); const id = await sale([{ item_id: i, name: 'Inactive demand', quantity: 3 }]);
    await ctx.api.post(`/api/orders/${id}/status`).set(H()).send({ status: 'cancelled' });
    expect((await purchase(id)).status).toBe(409); expect((await produce(id)).status).toBe(409);
  });
  it('recognizes historical exact shortfall references without creating duplicate supply', async () => {
    const i = await item('Legacy purchased'); const id = await sale([{ item_id: i, name: 'Legacy purchased', quantity: 2 }]);
    const detail = (await ctx.api.get(`/api/orders/${id}`).set(H())).body;
    const legacy = await ctx.api.post('/api/orders').set(H()).send({ type: 'purchase', notes: `Shortfall for ${detail.number}`, items: [{ item_id: i, name: 'Legacy purchased', quantity: 2 }] });
    expect(legacy.status).toBe(201); expect((await purchase(id)).body.created).toEqual([]);
  });
  it('retains fractional material purchasing quantities', async () => {
    const i = await item('Measured material', 1); const id = await sale([{ item_id: i, name: 'Measured material', quantity: 2.25 }]);
    const r = await purchase(id); const po = (await ctx.api.get(`/api/orders/${r.body.created[0].id}`).set(H())).body;
    expect(po.items[0].quantity).toBe(1.25);
  });
  it('keeps a small measured shortage positive instead of rounding it away', async () => {
    const i = await item('Fine measured material'); const id = await sale([{ item_id: i, name: 'Fine measured material', quantity: 0.00001 }]);
    expect((await av(id)).lines[0]).toMatchObject({ available: 0, shortfall: 0.00001 });
    const r = await purchase(id); expect(r.body.created).toHaveLength(1);
    const po = (await ctx.api.get(`/api/orders/${r.body.created[0].id}`).set(H())).body;
    expect(po.items[0].quantity).toBe(0.00001);
    expect((await purchase(id)).body.created).toEqual([]);
  });
  it('rolls back every supplier draft when a later supplier fails', async () => {
    const a = await item('Atomic A'), b = await item('Atomic B');
    const sup = (await ctx.api.post('/api/suppliers').set(H()).send({ name: 'Failing supplier' })).body.id;
    db.run('UPDATE inventory_items SET supplier_id = ? WHERE id = ?', sup, b);
    const id = await sale([{ item_id: a, name: 'Atomic A', quantity: 1 }, { item_id: b, name: 'Atomic B', quantity: 1 }]);
    const before = db.queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM orders WHERE type = 'purchase'")!.n;
    db.db.exec(`CREATE TRIGGER fail_planning_po BEFORE INSERT ON orders WHEN NEW.supplier_id = ${sup} BEGIN SELECT RAISE(ABORT, 'planning fixture failure'); END`);
    try { expect((await purchase(id)).status).toBe(500); } finally { db.db.exec('DROP TRIGGER fail_planning_po'); }
    expect(db.queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM orders WHERE type = 'purchase'")!.n).toBe(before);
    expect(db.queryAll('SELECT * FROM sale_shortfall_purchases WHERE source_order_id = ?', id)).toEqual([]);
  });
});
