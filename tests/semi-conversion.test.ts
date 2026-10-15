import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, addSerializedUnits, createEmployee, type TestContext } from './helpers';

let ctx: TestContext;
let token: string;
const H = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => { ctx = await setupApp(); token = await login(ctx.api); });
afterAll(() => cleanup(ctx));

async function semiPackage(prefix: string) {
  const product = (await ctx.api.post('/api/inventory').set(H()).send({ name: `${prefix} bike` })).body.id as number;
  const part = (await ctx.api.post('/api/inventory').set(H()).send({ name: `${prefix} part`, quantity: 1, unit_cost: 25 })).body.id as number;
  await ctx.api.put(`/api/finished-products/${product}`).set(H()).send({ components: [{ component_item_id: part, quantity: 1 }] });
  const location = (await ctx.api.get('/api/locations').set(H())).body.find((l: { is_default: number }) => l.is_default).id as number;
  const mo = (await ctx.api.post('/api/job-orders').set(H()).send({ product_item_id: product, qty_ordered: 1,
    build_mode: 'semi_built', qc_stages: 1 })).body.id as number;
  await ctx.api.post(`/api/job-orders/${mo}/approve`).set(H());
  await ctx.api.post('/api/job-orders/warehouse-accept').set(H()).send({ job_order_ids: [mo] });
  await ctx.api.post('/api/job-orders/prepare').set(H()).send({ job_orders: [{ id: mo }] });
  await ctx.api.post(`/api/job-orders/${mo}/release`).set(H());
  await ctx.api.post(`/api/job-orders/${mo}/accept`).set(H());
  const [unit] = await addSerializedUnits(ctx.api, token, mo, 1, prefix);
  expect((await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(H()).send({ unit_ids: [unit], result: 'pass' })).status).toBe(200);
  expect((await ctx.api.post(`/api/job-orders/${mo}/products-in`).set(H()).send({ location_id: location, unit_ids: [unit] })).status).toBe(201);
  return { product, part, location, unit };
}

describe('finish the same complete semi-built package', () => {
  it('chooses semi RTS despite a CKD parts shortage, preserves serial, and waits for QC and Products In', async () => {
    const { product, part, location, unit } = await semiPackage('convert-pass');
    const sale = (await ctx.api.post('/api/orders').set(H()).send({ type: 'sale', customer_name: 'Buyer',
      items: [{ item_id: product, name: 'Bike', quantity: 1, unit_price: 100, fulfillment_mode: 'assembled' }] })).body.id as number;
    const before = (await ctx.api.get(`/api/orders/${sale}/availability`).set(H())).body;
    expect(before.lines[0]).toMatchObject({ shortfall: 1, semi_built_available: 1, buildable: false });
    const manager = await createEmployee(ctx.api, token, { role: 'production_manager' });
    const HM = () => ({ Authorization: `Bearer ${manager.token}` });
    expect((await ctx.api.get('/api/orders?type=sale').set(HM())).status).toBe(403);
    const demand = (await ctx.api.get('/api/job-orders/convert-semi/demand').set(HM())).body;
    expect(demand).toMatchObject([{ order_id: sale, product_item_id: product, semi_built_available: 1 }]);
    const source = (await ctx.api.get(`/api/job-orders/convert-semi/options?product_item_id=${product}&location_id=${location}`).set(HM())).body;
    expect(source.units.some((u: { id: number }) => u.id === unit)).toBe(true);
    const identifier = source.units.find((u: { id: number }) => u.id === unit).identifier as string;
    const noPhoto = await ctx.api.post('/api/job-orders/convert-semi').set(H()).send({
      product_item_id: product, source_location_id: location, output_location_id: location,
      source_unit_id: unit, identifier,
    });
    expect(noPhoto.status).toBe(400);
    const create = await ctx.api.post('/api/job-orders/convert-semi').set(HM()).set('Idempotency-Key', 'semi-finish-serial-test-1')
      .field('product_item_id', String(product)).field('order_id', String(sale))
      .field('source_location_id', String(location)).field('output_location_id', String(location))
      .field('source_unit_id', String(unit)).field('identifier', identifier).field('finishing_cost', '5')
      .field('confirmed_complete_kit', 'true')
      .attach('image', Buffer.from('package-photo'), 'package.png');
    expect(create.status).toBe(201);
    const retry = await ctx.api.post('/api/job-orders/convert-semi').set(HM()).set('Idempotency-Key', 'semi-finish-serial-test-1')
      .field('product_item_id', String(product)).field('order_id', String(sale))
      .field('source_location_id', String(location)).field('output_location_id', String(location))
      .field('source_unit_id', String(unit)).field('identifier', identifier).field('finishing_cost', '5')
      .field('confirmed_complete_kit', 'true')
      .attach('image', Buffer.from('package-photo'), 'package.png');
    expect(retry.status).toBe(201);
    expect(retry.body.id).toBe(create.body.id);
    const job = create.body.id as number;
    expect(create.body.job_order.components).toEqual([]);
    expect(create.body.job_order.conversion_source_unit_id).toBe(unit);
    expect((await ctx.api.get(`/api/inventory/${product}/stock`).set(H())).body
      .find((row: { location_id: number }) => row.location_id === location).semi_built_quantity).toBe(0);
    expect((await ctx.api.get(`/api/inventory/${part}`).set(H())).body.quantity).toBe(0);
    expect((await ctx.api.get(`/api/orders/${sale}/availability`).set(H())).body.lines[0].linked_job_orders[0].id).toBe(job);
    const output = (await ctx.api.get(`/api/job-orders/${job}/units`).set(H())).body[0];
    expect(output).toMatchObject({ status: 'pending', identifier, conversion_source_unit_id: unit });
    expect((await ctx.api.put(`/api/job-orders/${job}/units/${output.id}/identifier`).set(H()).send({ identifier: 'WRONG-ID' })).status).toBe(409);
    expect((await ctx.api.post(`/api/job-orders/${job}/units/inspect`).set(H())
      .send({ unit_ids: [output.id], result: 'pass', identifier: 'WRONG-ID' })).status).toBe(409);
    expect((await ctx.api.post(`/api/job-orders/${job}/progress`).set(H()).send({ done_delta: 1 })).status).toBe(409);
    expect((await ctx.api.post(`/api/job-orders/${job}/products-in`).set(H()).send({ location_id: location, unit_ids: [output.id] })).status).toBe(409);
    expect((await ctx.api.post(`/api/job-orders/${job}/units/inspect`).set(H()).send({ unit_ids: [output.id], result: 'pass' })).status).toBe(200);
    expect((await ctx.api.post(`/api/job-orders/${job}/products-in`).set(H()).send({ location_id: location, unit_ids: [output.id] })).status).toBe(201);
    expect((await ctx.api.get(`/api/orders/${sale}/availability`).set(H())).body.lines[0].shortfall).toBe(0);
    expect((await ctx.api.get(`/api/inventory/${part}`).set(H())).body.quantity).toBe(0);
    expect((await ctx.api.get(`/api/inventory/${product}`).set(H())).body.unit_cost).toBe(30);
  });

  it('finishes an untracked semi-built package with a new physical identifier', async () => {
    const product = (await ctx.api.post('/api/inventory').set(H()).send({ name: 'Bulk semi bicycle' })).body.id as number;
    const part = (await ctx.api.post('/api/inventory').set(H()).send({ name: 'Bulk semi kit', quantity: 1, unit_cost: 20 })).body.id as number;
    await ctx.api.put(`/api/finished-products/${product}`).set(H()).send({ components: [{ component_item_id: part, quantity: 1 }] });
    const location = (await ctx.api.get('/api/locations').set(H())).body.find((l: { is_default: number }) => l.is_default).id as number;
    const mo = (await ctx.api.post('/api/job-orders').set(H()).send({ product_item_id: product, qty_ordered: 1,
      build_mode: 'semi_built', qc_stages: 0 })).body.id as number;
    await ctx.api.post(`/api/job-orders/${mo}/approve`).set(H());
    await ctx.api.post('/api/job-orders/warehouse-accept').set(H()).send({ job_order_ids: [mo] });
    await ctx.api.post('/api/job-orders/prepare').set(H()).send({ job_orders: [{ id: mo }] });
    await ctx.api.post(`/api/job-orders/${mo}/release`).set(H());
    await ctx.api.post(`/api/job-orders/${mo}/accept`).set(H());
    await ctx.api.post(`/api/job-orders/${mo}/progress`).set(H()).send({ done_delta: 1, scrapped_delta: 0 });
    const batch = (await ctx.api.get(`/api/job-orders/${mo}/receivable`).set(H())).body.batches[0];
    expect((await ctx.api.post(`/api/job-orders/${mo}/products-in`).set(H()).send({ location_id: location,
      batches: [{ batch_id: batch.id, quantity: 1 }] })).status).toBe(201);
    const options = (await ctx.api.get(`/api/job-orders/convert-semi/options?product_item_id=${product}&location_id=${location}`).set(H())).body;
    expect(options.bulk_available).toBe(1);
    const start = await ctx.api.post('/api/job-orders/convert-semi').set(H())
      .field('product_item_id', String(product)).field('source_location_id', String(location))
      .field('output_location_id', String(location)).field('identifier', 'BULK-001')
      .field('confirmed_complete_kit', 'true')
      .attach('image', Buffer.from('bulk-package'), 'package.png');
    expect(start.status).toBe(201);
    const output = (await ctx.api.get(`/api/job-orders/${start.body.id}/units`).set(H())).body[0];
    expect(output.identifier).toBe('BULK-001');
    expect((await ctx.api.post(`/api/job-orders/${start.body.id}/units/inspect`).set(H()).send({ unit_ids: [output.id], result: 'pass' })).status).toBe(200);
    expect((await ctx.api.post(`/api/job-orders/${start.body.id}/products-in`).set(H()).send({ location_id: location, unit_ids: [output.id] })).status).toBe(201);
    const stock = (await ctx.api.get(`/api/inventory/${product}/stock`).set(H())).body.find((row: { location_id: number }) => row.location_id === location);
    expect(stock).toMatchObject({ assembled_quantity: 1, semi_built_quantity: 0 });
    expect((await ctx.api.get(`/api/inventory/${part}`).set(H())).body.quantity).toBe(0);
  });

  it('can cancel before inspection and return the same package to semi-built RTS', async () => {
    const { product, location, unit } = await semiPackage('convert-cancel');
    const identifier = (await ctx.api.get(`/api/job-orders/convert-semi/options?product_item_id=${product}&location_id=${location}`).set(H())).body.units[0].identifier;
    const start = await ctx.api.post('/api/job-orders/convert-semi').set(H())
      .field('product_item_id', String(product)).field('source_location_id', String(location))
      .field('output_location_id', String(location)).field('source_unit_id', String(unit))
      .field('identifier', identifier).field('confirmed_complete_kit', 'true')
      .attach('image', Buffer.from('photo'), 'package.png');
    expect(start.status).toBe(201);
    expect((await ctx.api.post(`/api/job-orders/${start.body.id}/cancel`).set(H()).send({})).status).toBe(400);
    expect((await ctx.api.post(`/api/job-orders/${start.body.id}/cancel`).set(H())
      .send({ confirmed_repacked: true, reason: 'Complete kit counted and repacked' })).status).toBe(200);
    const after = (await ctx.api.get(`/api/job-orders/convert-semi/options?product_item_id=${product}&location_id=${location}`).set(H())).body;
    expect(after.units.some((u: { id: number }) => u.id === unit)).toBe(true);
  });

  it('keeps order-specific price overrides and fee lines in the commercial total', async () => {
    const create = await ctx.api.post('/api/orders').set(H()).send({ type: 'sale', customer_name: 'Price buyer',
      items: [{ name: 'Bicycle', quantity: 2, unit_price: 100 },
        { name: 'Shipping fee', description: 'Order fee', quantity: 1, unit_price: 15 }] });
    expect(create.status).toBe(201);
    const order = (await ctx.api.get(`/api/orders/${create.body.id}`).set(H())).body;
    expect(order.total).toBe(215);
    const update = await ctx.api.put(`/api/orders/${order.id}`).set(H()).send({
      items: [{ name: 'Bicycle', quantity: 2, unit_price: 85 },
        { name: 'Admin fee', description: 'Order fee', quantity: 1, unit_price: 7 }],
    });
    expect(update.status).toBe(200);
    expect((await ctx.api.get(`/api/orders/${order.id}`).set(H())).body.total).toBe(177);
  });
});
