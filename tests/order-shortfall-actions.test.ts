/** Shortfall follow-ups on a sale order that can't be met from stock:
 *  - POST /orders/:id/purchase-shortfall — draft PO(s) for what has to be bought
 *  - GET /orders?backorder=1 + the `backordered` column — surface unfulfilled firm orders
 *  - POST /orders/:id/status — advance status only, same availability gate, force = backorder
 *  - POST /inventory/reorder-po — draft PO(s) for everything at/under its reorder level
 *  - the delivery-complete `order` hint that drives the mobile "mark it completed?" prompt
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, type TestContext } from './helpers';

let ctx: TestContext;
let token: string;
const H = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  ctx = await setupApp();
  token = await login(ctx.api);
});
afterAll(() => cleanup(ctx));

const mkSupplier = async (name: string) =>
  (await ctx.api.post('/api/suppliers').set(H()).send({ name })).body.id as number;
const mkItem = async (body: Record<string, unknown>) =>
  (await ctx.api.post('/api/inventory').set(H()).send(body)).body.id as number;
const so = async (items: Array<Record<string, unknown>>) =>
  (await ctx.api.post('/api/orders').set(H()).send({ type: 'sale', customer_name: 'ACME', items })).body.id as number;

describe('POST /api/orders/:id/purchase-shortfall', () => {
  it('drafts one PO per supplier for short bought lines', async () => {
    const supA = await mkSupplier('Bolt Co');
    const supB = await mkSupplier('Frame Co');
    const bolt = await mkItem({ name: 'PS Bolt', quantity: 2, unit_cost: 1.5, supplier_id: supA });
    const frame = await mkItem({ name: 'PS Frame', quantity: 0, unit_cost: 40, supplier_id: supB });
    const line = [
      { name: 'PS Bolt', item_id: bolt, quantity: 10, unit_price: 3 },
      { name: 'PS Frame', item_id: frame, quantity: 4, unit_price: 80 },
    ];
    const id = await so(line);

    const r = await ctx.api.post(`/api/orders/${id}/purchase-shortfall`).set(H()).send({});
    expect(r.status).toBe(200);
    expect(r.body.created).toHaveLength(2);
    const names = r.body.created.map((c: { supplier_name: string }) => c.supplier_name).sort();
    expect(names).toEqual(['Bolt Co', 'Frame Co']);
    for (const c of r.body.created) expect(c.number).toMatch(/^PR-\d{5}$/);

    // the drafts are real purchase orders, open, with the shortfall quantity
    const pos = (await ctx.api.get('/api/orders?type=purchase').set(H())).body as Array<{ id: number; number: string }>;
    const boltNo = r.body.created.find((c: { supplier_name: string }) => c.supplier_name === 'Bolt Co').number;
    const boltPo = (await ctx.api.get(`/api/orders/${pos.find((p) => p.number === boltNo)!.id}`).set(H())).body;
    expect(boltPo.status).toBe('open');
    expect(boltPo.items[0]).toMatchObject({ item_id: bolt, quantity: 8 }); // 10 ordered - 2 on hand
  });

  it('buys the missing BOM components for a short finished-product line', async () => {
    const sup = await mkSupplier('Resin Co');
    const widget = await mkItem({ name: 'PS Widget', unit_cost: 20 });
    const resin = await mkItem({ name: 'PS Resin', quantity: 1, unit_cost: 5, supplier_id: sup });
    await ctx.api.put(`/api/finished-products/${widget}`).set(H())
      .send({ components: [{ component_item_id: resin, quantity: 2 }] });

    const line = [{ name: 'PS Widget', item_id: widget, quantity: 3, unit_price: 50 }];
    const id = await so(line);

    const r = await ctx.api.post(`/api/orders/${id}/purchase-shortfall`).set(H()).send({});
    expect(r.status).toBe(200);
    expect(r.body.created).toHaveLength(1);
    expect(r.body.created[0].supplier_name).toBe('Resin Co');
    const po = (await ctx.api.get('/api/orders?type=purchase').set(H())).body[0];
    const full = (await ctx.api.get(`/api/orders/${po.id}`).set(H())).body;
    expect(full.items[0]).toMatchObject({ item_id: resin }); // need 2*3=6, have 1 -> short 5
    expect(full.items[0].quantity).toBe(5);
  });

  it('reports nothing to buy when the shortfall is all buildable', async () => {
    const widget = await mkItem({ name: 'PS Buildable', unit_cost: 20 });
    const part = await mkItem({ name: 'PS Plenty', quantity: 500, unit_cost: 1 });
    await ctx.api.put(`/api/finished-products/${widget}`).set(H())
      .send({ components: [{ component_item_id: part, quantity: 1 }] });
    const line = [{ name: 'PS Buildable', item_id: widget, quantity: 5, unit_price: 50 }];
    const id = await so(line);
    const r = await ctx.api.post(`/api/orders/${id}/purchase-shortfall`).set(H()).send({});
    expect(r.status).toBe(200);
    expect(r.body.created).toHaveLength(0);
    expect(r.body.note).toMatch(/nothing to purchase/i);
  });
});

describe('POST /api/job-orders/:id/purchase-shortfall', () => {
  it('keeps sale-linked jobs on the sale supply plan even after the sale drafts a PO', async () => {
    const product = await mkItem({ name: 'Sale Plan Product', quantity: 0 });
    const part = await mkItem({ name: 'Sale Plan Part', quantity: 0 });
    await ctx.api.put(`/api/finished-products/${product}`).set(H())
      .send({ components: [{ component_item_id: part, quantity: 1 }] });
    const sale = await so([{ name: 'Sale Plan Product', item_id: product, quantity: 2, unit_price: 20 }]);
    const jobDraft = await ctx.api.post(`/api/orders/${sale}/produce-shortfall`).set(H()).send({});
    expect(jobDraft.status).toBe(200);
    const job = jobDraft.body.created[0].job_order_id as number;
    const jobAvailability = (await ctx.api.get(`/api/job-orders/${job}/availability`).set(H())).body;
    const owner = jobAvailability.supply_planning_order;
    expect(owner).toMatchObject({ id: sale });
    expect(jobAvailability.purchase_requirements).toEqual([]);
    const salePurchase = await ctx.api.post(`/api/orders/${sale}/purchase-shortfall`).set(H()).send({});
    expect(salePurchase.body.created).toHaveLength(1);
    const jobPurchase = await ctx.api.post(`/api/job-orders/${job}/purchase-shortfall`).set(H()).send({});
    expect(jobPurchase.status).toBe(409);
    expect(jobPurchase.body).toMatchObject({ code: 'sale_supply_owner', supply_planning_order: { id: sale } });
    expect((await ctx.api.get('/api/orders?type=purchase').set(H())).body
      .filter((po: { id: number }) => po.id === salePurchase.body.created[0].id)).toHaveLength(1);
  });
  it('drafts POs for the components a draft MO can\'t cover, and /release reports them', async () => {
    const sup = await mkSupplier('MO Parts Co');
    const product = await mkItem({ name: 'MO Widget', unit_cost: 30 });
    const frame = await mkItem({ name: 'MO Frame', quantity: 1, unit_cost: 12, supplier_id: sup });
    await ctx.api.put(`/api/finished-products/${product}`).set(H())
      .send({ components: [{ component_item_id: frame, quantity: 1 }] });
    const mo = (await ctx.api.post('/api/job-orders').set(H())
      .send({ product_item_id: product, qty_ordered: 5 })).body.id;

    await ctx.api.post(`/api/job-orders/${mo}/approve`).set(H());
    await ctx.api.post(`/api/job-orders/warehouse-accept`).set(H()).send({ job_order_ids: [mo] });
    // The shortage now surfaces when the warehouse tries to pick the kit.
    const prep = await ctx.api.post(`/api/job-orders/prepare`).set(H()).send({ job_orders: [{ id: mo }] });
    expect(prep.status).toBe(400);
    expect(prep.body.shortfalls[0]).toMatchObject({ component_name: 'MO Frame', picking: 5, available: 1 });
    const av = (await ctx.api.get(`/api/job-orders/${mo}/availability`).set(H())).body;
    expect(av.shortfalls[0]).toMatchObject({ component_name: 'MO Frame', need: 5, have: 1, short: 4 });

    const r = await ctx.api.post(`/api/job-orders/${mo}/purchase-shortfall`).set(H()).send({});
    expect(r.status).toBe(200);
    expect(r.body.created).toHaveLength(1);
    expect(r.body.created[0].supplier_name).toBe('MO Parts Co');
    const pos = (await ctx.api.get('/api/orders?type=purchase').set(H())).body as Array<{ id: number; number: string }>;
    const full = (await ctx.api.get(`/api/orders/${pos.find((o) => o.number === r.body.created[0].number)!.id}`).set(H())).body;
    expect(full.items[0]).toMatchObject({ item_id: frame, quantity: 4 });
    const poId = r.body.created[0].id as number;
    expect((await ctx.api.post(`/api/job-orders/${mo}/purchase-shortfall`).set(H()).send({})).body.created).toEqual([]);
    expect((await ctx.api.get(`/api/job-orders/${mo}/availability`).set(H())).body.purchase_requirements[0])
      .toMatchObject({ short: 4, pending_purchase: 4, to_purchase: 0 });

    const picked = await ctx.api.post('/api/job-orders/prepare').set(H()).send({ job_orders: [{ id: mo,
      lines: [{ component_item_id: frame, qty_picked: 1 }] }] });
    expect(picked.status).toBe(200);
    expect(picked.body.job_orders[0].prepared_at).toBeNull();
    const home = av.source_location_id;
    const receipt = await ctx.api.post(`/api/purchasing/orders/${poId}/receipts`).set(H()).send({ location_id: home,
      lines: [{ order_item_id: full.items[0].id, item_id: frame, name: 'MO Frame', quantity: 2 }] });
    expect(receipt.status).toBe(201);
    expect((await ctx.api.get(`/api/job-orders/${mo}/availability`).set(H())).body.purchase_requirements[0])
      .toMatchObject({ short: 2, pending_purchase: 2, to_purchase: 0 });
    expect((await ctx.api.post(`/api/job-orders/${mo}/purchase-shortfall`).set(H()).send({})).body.created).toEqual([]);
    expect((await ctx.api.post('/api/job-orders/prepare').set(H()).send({ job_orders: [{ id: mo,
      lines: [{ component_item_id: frame, qty_picked: 3 }] }] })).status).toBe(200);

    expect((await ctx.api.post(`/api/purchasing/orders/${poId}/receipts`).set(H()).send({ location_id: home,
      lines: [{ order_item_id: full.items[0].id, item_id: frame, name: 'MO Frame', quantity: 2 }] })).status).toBe(201);
    expect((await ctx.api.post('/api/job-orders/prepare').set(H()).send({ job_orders: [{ id: mo,
      lines: [{ component_item_id: frame, qty_picked: 5 }] }] })).status).toBe(200);
    expect((await ctx.api.post(`/api/job-orders/${mo}/release`).set(H()).send({})).status).toBe(200);
    expect((await ctx.api.get(`/api/inventory/${frame}`).set(H())).body.quantity).toBe(0);
    expect((await ctx.api.post(`/api/job-orders/${mo}/purchase-shortfall`).set(H()).send({})).status).toBe(409);
  });

  it('replans only lost PO coverage after an edit or cancellation', async () => {
    const product = await mkItem({ name: 'MO Replan Product' });
    const part = await mkItem({ name: 'MO Replan Part', quantity: 0 });
    await ctx.api.put(`/api/finished-products/${product}`).set(H())
      .send({ components: [{ component_item_id: part, quantity: 1 }] });
    const mo = (await ctx.api.post('/api/job-orders').set(H())
      .send({ product_item_id: product, qty_ordered: 5 })).body.id as number;
    const first = await ctx.api.post(`/api/job-orders/${mo}/purchase-shortfall`).set(H()).send({});
    const poId = first.body.created[0].id as number;
    expect((await ctx.api.put(`/api/orders/${poId}`).set(H()).send({ items: [{ item_id: part, name: 'MO Replan Part', quantity: 3 }] })).status).toBe(200);
    const second = await ctx.api.post(`/api/job-orders/${mo}/purchase-shortfall`).set(H()).send({});
    expect(second.body.created).toHaveLength(1);
    const supplement = (await ctx.api.get(`/api/orders/${second.body.created[0].id}`).set(H())).body;
    expect(supplement.items[0].quantity).toBe(2);
    expect((await ctx.api.post(`/api/job-orders/${mo}/purchase-shortfall`).set(H()).send({})).body.created).toEqual([]);
    expect((await ctx.api.put(`/api/orders/${poId}`).set(H()).send({ status: 'cancelled' })).status).toBe(200);
    const replacement = await ctx.api.post(`/api/job-orders/${mo}/purchase-shortfall`).set(H()).send({});
    expect(replacement.body.created).toHaveLength(1);
    expect((await ctx.api.get(`/api/orders/${replacement.body.created[0].id}`).set(H())).body.items[0].quantity).toBe(3);
  });

  it('plans the second kit when the only on-hand part is picked for another job', async () => {
    const product = await mkItem({ name: 'MO Shared Product' });
    const part = await mkItem({ name: 'MO Shared Part', quantity: 1 });
    await ctx.api.put(`/api/finished-products/${product}`).set(H())
      .send({ components: [{ component_item_id: part, quantity: 1 }] });
    const first = (await ctx.api.post('/api/job-orders').set(H()).send({ product_item_id: product, qty_ordered: 1 })).body.id;
    const second = (await ctx.api.post('/api/job-orders').set(H()).send({ product_item_id: product, qty_ordered: 1 })).body.id;
    await ctx.api.post(`/api/job-orders/${first}/approve`).set(H());
    await ctx.api.post('/api/job-orders/warehouse-accept').set(H()).send({ job_order_ids: [first] });
    expect((await ctx.api.post('/api/job-orders/prepare').set(H()).send({ job_orders: [{ id: first }] })).status).toBe(200);
    const availability = (await ctx.api.get(`/api/job-orders/${second}/availability`).set(H())).body;
    expect(availability.shortfalls[0]).toMatchObject({ have: 1, held_elsewhere: 1, available: 0, short: 1 });
    expect(availability.purchase_requirements[0]).toMatchObject({ pending_purchase: 0, to_purchase: 1 });
    const drafted = await ctx.api.post(`/api/job-orders/${second}/purchase-shortfall`).set(H()).send({});
    expect(drafted.body.created).toHaveLength(1);
    expect((await ctx.api.get(`/api/orders/${drafted.body.created[0].id}`).set(H())).body.items[0].quantity).toBe(1);
  });

  it('keeps another location receipt outside the source kit stock check', async () => {
    const product = await mkItem({ name: 'MO Location Product' });
    const part = await mkItem({ name: 'MO Location Part', quantity: 0 });
    await ctx.api.put(`/api/finished-products/${product}`).set(H())
      .send({ components: [{ component_item_id: part, quantity: 1 }] });
    const mo = (await ctx.api.post('/api/job-orders').set(H()).send({ product_item_id: product, qty_ordered: 2 })).body.id;
    const first = await ctx.api.post(`/api/job-orders/${mo}/purchase-shortfall`).set(H()).send({});
    const poId = first.body.created[0].id;
    const po = (await ctx.api.get(`/api/orders/${poId}`).set(H())).body;
    const other = (await ctx.api.post('/api/locations').set(H()).send({ name: 'MO Remote Receipt', type: 'warehouse' })).body.id;
    expect((await ctx.api.post(`/api/purchasing/orders/${poId}/receipts`).set(H()).send({ location_id: other,
      lines: [{ order_item_id: po.items[0].id, item_id: part, name: 'MO Location Part', quantity: 1 }] })).status).toBe(201);
    const av = (await ctx.api.get(`/api/job-orders/${mo}/availability`).set(H())).body;
    expect(av.shortfalls[0]).toMatchObject({ have: 0, short: 2 });
    expect(av.purchase_requirements[0]).toMatchObject({ pending_purchase: 1, to_purchase: 1 });
    const supplement = await ctx.api.post(`/api/job-orders/${mo}/purchase-shortfall`).set(H()).send({});
    expect((await ctx.api.get(`/api/orders/${supplement.body.created[0].id}`).set(H())).body.items[0].quantity).toBe(1);
  });
});

describe('GET /api/orders?backorder=1', () => {
  it('lists only firm sale orders with an unreleased line, and flags them', async () => {
    const item = await mkItem({ name: 'BO Item', quantity: 1 });
    const line = [{ name: 'BO Item', item_id: item, quantity: 5, unit_price: 2 }];
    const id = await so(line);
    // force-approve into a backorder
    await ctx.api.put(`/api/orders/${id}`).set(H())
      .send({ customer_name: 'ACME', status: 'approved', items: line, force: true });

    const all = (await ctx.api.get('/api/orders?type=sale').set(H())).body as Array<{ id: number; backordered: number }>;
    expect(all.find((o) => o.id === id)!.backordered).toBeTruthy();

    const only = (await ctx.api.get('/api/orders?type=sale&backorder=1').set(H())).body as Array<{ id: number; backordered: number }>;
    expect(only.some((o) => o.id === id)).toBe(true);
    expect(only.every((o) => o.backordered)).toBe(true);                    // filter only returns flagged orders
    expect(only.length).toBe(all.filter((o) => o.backordered).length);     // ...and all of them
    const openOne = all.find((o) => !o.backordered);
    expect(openOne && only.some((o) => o.id === openOne.id)).toBeFalsy();   // a plain open order is excluded
  });
});

describe('POST /api/orders/:id/status', () => {
  it('advances status with no items body and honours the availability gate', async () => {
    const item = await mkItem({ name: 'ST Item', quantity: 2 });
    const line = [{ name: 'ST Item', item_id: item, quantity: 5, unit_price: 2 }];
    const id = await so(line);

    const blocked = await ctx.api.post(`/api/orders/${id}/status`).set(H()).send({ status: 'approved' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.availability.short_lines).toBe(1);
    expect((await ctx.api.get(`/api/orders/${id}`).set(H())).body.status).toBe('open');

    const forced = await ctx.api.post(`/api/orders/${id}/status`).set(H()).send({ status: 'approved', force: true });
    expect(forced.status).toBe(200);
    expect((await ctx.api.get(`/api/orders/${id}`).set(H())).body.status).toBe('approved');
  });

  it('is a no-op when the status is unchanged and 404s a non-sale order', async () => {
    const id = await so([{ name: 'ST Free', quantity: 1, unit_price: 1 }]);
    const same = await ctx.api.post(`/api/orders/${id}/status`).set(H()).send({ status: 'open' });
    expect(same.status).toBe(200);

    const po = (await ctx.api.post('/api/orders').set(H())
      .send({ type: 'purchase', customer_name: 'V', items: [{ name: 'x', quantity: 1, unit_price: 1 }] })).body.id;
    const bad = await ctx.api.post(`/api/orders/${po}/status`).set(H()).send({ status: 'completed' });
    expect(bad.status).toBe(404);
  });
});

describe('POST /api/inventory/reorder-po', () => {
  it('drafts POs for the given low-stock items, grouped by supplier, excluding finished products', async () => {
    const supA = await mkSupplier('RP Metals');
    const supB = await mkSupplier('RP Plastics');
    const steel = await mkItem({ name: 'RP Steel', quantity: 3, min_quantity: 10, unit_cost: 4, supplier_id: supA });
    const nuts = await mkItem({ name: 'RP Nuts', quantity: 0, min_quantity: 50, unit_cost: 0.2, supplier_id: supA });
    const pellets = await mkItem({ name: 'RP Pellets', quantity: 5, min_quantity: 20, unit_cost: 2, supplier_id: supB });
    const fine = await mkItem({ name: 'RP Fine', quantity: 100, min_quantity: 10, supplier_id: supA }); // not low
    const fp = await mkItem({ name: 'RP Assembly', quantity: 0, min_quantity: 5 });                     // low but a finished product
    await ctx.api.put(`/api/finished-products/${fp}`).set(H()).send({ components: [] });

    const r = await ctx.api.post('/api/inventory/reorder-po').set(H())
      .send({ item_ids: [steel, nuts, pellets, fine, fp] });
    expect(r.status).toBe(200);
    expect(r.body.considered).toBe(3);       // steel + nuts + pellets (fine not low, fp excluded)
    expect(r.body.created).toHaveLength(2);   // one per supplier

    const metals = r.body.created.find((c: { supplier_name: string }) => c.supplier_name === 'RP Metals');
    expect(metals.lines).toBe(2);
    const pos = (await ctx.api.get('/api/orders?type=purchase').set(H())).body as Array<{ id: number; number: string }>;
    const full = (await ctx.api.get(`/api/orders/${pos.find((o) => o.number === metals.number)!.id}`).set(H())).body;
    const steelLine = full.items.find((i: { name: string }) => i.name === 'RP Steel');
    expect(steelLine.quantity).toBe(17); // target 10*2=20, on hand 3
  });

  it('respects the multiplier', async () => {
    const sup = await mkSupplier('RP Solo');
    const a = await mkItem({ name: 'RP Pick A', quantity: 2, min_quantity: 4, unit_cost: 1, supplier_id: sup });

    const r = await ctx.api.post('/api/inventory/reorder-po').set(H()).send({ item_ids: [a], multiplier: 3 });
    expect(r.body.considered).toBe(1);
    expect(r.body.created).toHaveLength(1);
    const pos = (await ctx.api.get('/api/orders?type=purchase').set(H())).body as Array<{ id: number; number: string }>;
    const full = (await ctx.api.get(`/api/orders/${pos.find((o) => o.number === r.body.created[0].number)!.id}`).set(H())).body;
    expect(full.items[0]).toMatchObject({ name: 'RP Pick A', quantity: 10 }); // 4*3 - 2
  });

  it('reports nothing when the chosen items are all above their reorder level', async () => {
    const ok = await mkItem({ name: 'RP Healthy', quantity: 999, min_quantity: 1 });
    const r = await ctx.api.post('/api/inventory/reorder-po').set(H()).send({ item_ids: [ok] });
    expect(r.body.created).toHaveLength(0);
    expect(r.body.note).toMatch(/reorder level/i);
  });
});
