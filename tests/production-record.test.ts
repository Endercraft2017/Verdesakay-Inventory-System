/** Unit / batch dossier (GET /api/production/record) + editable label templates. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, addSerializedUnits, type TestContext } from './helpers';

let ctx: TestContext;
let token: string;
const H = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  ctx = await setupApp();
  token = await login(ctx.api);
});
afterAll(() => cleanup(ctx));

const mkItem = async (name: string, quantity = 0) =>
  (await ctx.api.post('/api/inventory').set(H()).send({ name, quantity })).body.id as number;
const PNG = Buffer.from('fake-png-bytes');

describe('production record — unit dossier', () => {
  it('assembles product, job order, QC, repairs and movements for a produced unit', async () => {
    const product = await mkItem('Dossier Bike');
    const frame = await mkItem('Dossier Frame', 100);
    const bolt = await mkItem('Dossier Bolt', 100);
    await ctx.api.put(`/api/finished-products/${product}`).set(H())
      .send({ components: [{ component_item_id: frame, quantity: 1 }] });

    const mo = (await ctx.api.post('/api/job-orders').set(H())
      .send({ product_item_id: product, qty_ordered: 1, qc_stages: 1 })).body.id;
    await ctx.api.post(`/api/job-orders/${mo}/approve`).set(H());
    await ctx.api.post(`/api/job-orders/warehouse-accept`).set(H()).send({ job_order_ids: [mo] });
    await ctx.api.post(`/api/job-orders/prepare`).set(H()).send({ job_orders: [{ id: mo }] });
    await ctx.api.post(`/api/job-orders/${mo}/release`).set(H());
    await ctx.api.post(`/api/job-orders/${mo}/accept`).set(H());
    await addSerializedUnits(ctx.api, token, mo, 1, 'DOSSIER');
    const unit = (await ctx.api.get(`/api/job-orders/${mo}/units`).set(H())).body[0];

    // fail → repair → request a part → accept → re-pass
    await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(H())
      .send({ unit_ids: [unit.id], result: 'fail', disposition: 'repair', remarks: 'loose bolt' });
    const rpr = await ctx.api.post(`/api/production/units/${unit.id}/repairs`).set(H())
      .send({ kind: 'replace', component_item_id: bolt, quantity: 1, fault: 'assembler' });
    await ctx.api.post(`/api/production/repairs/${rpr.body.id}/accept`).set(H()).send({});
    await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(H())
      .send({ unit_ids: [unit.id], result: 'pass', identifier: 'BIKE-001' });

    // A final QC pass queues the unit for Products In — receive it before it counts as stock.
    const receivable = (await ctx.api.get(`/api/job-orders/${mo}/receivable`).set(H())).body;
    const recv = await ctx.api.post(`/api/job-orders/${mo}/products-in`).set(H())
      .send({ location_id: receivable.output_location_id, unit_ids: [unit.id] });
    expect(recv.status).toBe(201);

    const photo = await ctx.api.post('/api/attachments').set(H())
      .field('kind', 'qc_unit').field('ref_id', String(unit.id)).attach('image', PNG, 'bike.png');
    expect(photo.status).toBe(201);

    const rec = await ctx.api.get(`/api/production/record?unit=${unit.id}`).set(H());
    expect(rec.status).toBe(200);
    expect(rec.body.kind).toBe('unit');
    expect(rec.body.product.name).toBe('Dossier Bike');
    expect(rec.body.unit.identifier).toBe('BIKE-001');
    expect(rec.body.unit.status).toBe('in_stock');
    expect(rec.body.job_order.number).toMatch(/^MO-\d{5}$/);
    expect(rec.body.qc.length).toBeGreaterThanOrEqual(2);       // fail + pass
    expect(rec.body.qc.some((q: { result: string; disposition: string }) => q.result === 'fail' && q.disposition === 'repair')).toBe(true);
    expect(rec.body.repairs.length).toBe(1);
    expect(rec.body.repairs[0].status).toBe('accepted');
    expect(rec.body.movements.some((m: { reason: string }) => /produced|passed QC|received/i.test(m.reason))).toBe(true);
    expect(rec.body.photos).toHaveLength(2); // the off-the-line photo sent with the unit + this one
    expect(rec.body.photos[1].url).toBe(photo.body.url);
  });

  it('assembles a batch dossier with its units + QC sign-off', async () => {
    const product = await mkItem('Dossier Widget');
    const part = await mkItem('Dossier Part', 100);
    await ctx.api.put(`/api/finished-products/${product}`).set(H())
      .send({ components: [{ component_item_id: part, quantity: 1 }] });
    const mo = (await ctx.api.post('/api/job-orders').set(H())
      .send({ product_item_id: product, qty_ordered: 3, qc_stages: 0 })).body.id;
    await ctx.api.post(`/api/job-orders/${mo}/approve`).set(H());
    await ctx.api.post(`/api/job-orders/warehouse-accept`).set(H()).send({ job_order_ids: [mo] });
    await ctx.api.post(`/api/job-orders/prepare`).set(H()).send({ job_orders: [{ id: mo }] });
    await ctx.api.post(`/api/job-orders/${mo}/release`).set(H());
    await ctx.api.post(`/api/job-orders/${mo}/accept`).set(H());
    await ctx.api.post(`/api/job-orders/${mo}/progress`).set(H()).send({ done_delta: 3, batch_label: 'LOT-Z' });
    const batch = (await ctx.api.get('/api/production/batches?job_order=' + mo).set(H())).body[0];
    await ctx.api.post(`/api/production/batches/${batch.id}/inspect`).set(H())
      .send({ result: 'pass', remarks: 'lot ok' });

    const rec = await ctx.api.get(`/api/production/record?batch=${batch.id}`).set(H());
    expect(rec.status).toBe(200);
    expect(rec.body.kind).toBe('batch');
    expect(rec.body.batch.number).toBe(batch.number);
    expect(rec.body.batch.identifier).toBe('LOT-Z');
    expect(rec.body.qc.length).toBe(1);
    expect(rec.body.qc[0].result).toBe('pass');
    expect(rec.body.product.name).toBe('Dossier Widget');
  });

  it('400s with neither id, 404s an unknown id', async () => {
    expect((await ctx.api.get('/api/production/record').set(H())).status).toBe(400);
    expect((await ctx.api.get('/api/production/record?unit=999999').set(H())).status).toBe(404);
  });
});

describe('label templates', () => {
  it('returns defaults, saves overrides, and resets on empty', async () => {
    const def = await ctx.api.get('/api/production/label-templates').set(H());
    expect(def.body.unit).toContain('{{qr_src}}');
    expect(def.body.batch).toContain('{{batch.number}}');

    const saved = await ctx.api.put('/api/production/label-templates').set(H())
      .send({ unit: '<div>{{product.name}} — {{code}}</div>' });
    expect(saved.body.unit).toBe('<div>{{product.name}} — {{code}}</div>');
    expect((await ctx.api.get('/api/production/label-templates').set(H())).body.unit)
      .toBe('<div>{{product.name}} — {{code}}</div>');

    const reset = await ctx.api.put('/api/production/label-templates').set(H()).send({ unit: '' });
    expect(reset.body.unit).toBe(def.body.unit);
  });
});
