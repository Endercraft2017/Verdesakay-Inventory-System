/** Photo attachments (/api/attachments) — hang images off a QC unit / damage /
 *  problem record; upload needs inventory.adjust, reads need inventory.view. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';

let ctx: TestContext;
let token: string;
const H = () => ({ Authorization: `Bearer ${token}` });
const PNG = Buffer.from('fake-png-bytes');

beforeAll(async () => {
  ctx = await setupApp();
  token = await login(ctx.api);
  const {run}=await import('../src/shared/db');
  const product=Number(run("INSERT INTO inventory_items(name) VALUES('Attachment unit')").lastInsertRowid);
  const job=Number(run("INSERT INTO job_orders(number,product_item_id,product_name,qty_ordered) VALUES('ATTACH-JOB',?,'Attachment unit',1)",product).lastInsertRowid);
  run("INSERT INTO job_order_units(id,job_order_id,product_item_id,status,stage) VALUES(42,?,?,'pending',0)",job,product);
});
afterAll(() => cleanup(ctx));

describe('attachments', () => {
  it('uploads, lists, serves and deletes an attachment', async () => {
    const up = await ctx.api.post('/api/attachments').set(H())
      .field('kind', 'qc_unit').field('ref_id', '42').field('caption', 'left corner scratch')
      .attach('image', PNG, 'defect.png');
    expect(up.status).toBe(201);
    expect(up.body.url).toBe(`/api/attachments/${up.body.id}/image`);

    const list = await ctx.api.get('/api/attachments?kind=qc_unit&ref_id=42').set(H());
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ caption: 'left corner scratch', url: up.body.url });
    expect(list.body[0].uploaded_by_name).toBeTruthy();

    const { queryOne } = await import('../src/shared/db');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const stored = queryOne<{ image_path: string }>('SELECT image_path FROM attachments WHERE id = ?', up.body.id)!;
    fs.unlinkSync(path.join(ctx.tmpDir, 'uploads', stored.image_path));

    const img = await ctx.api.get(up.body.url).set(H());
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toContain('image/png');

    // scoped to the exact record
    expect((await ctx.api.get('/api/attachments?kind=qc_unit&ref_id=99').set(H())).body).toHaveLength(0);
    expect((await ctx.api.get('/api/attachments?kind=damage&ref_id=42').set(H())).body).toHaveLength(0);

    expect((await ctx.api.delete('/api/attachments/' + up.body.id).set(H())).status).toBe(200);
    expect(queryOne('SELECT 1 FROM durable_uploads WHERE name = ?', stored.image_path)).toBeUndefined();
    expect((await ctx.api.get('/api/attachments?kind=qc_unit&ref_id=42').set(H())).body).toHaveLength(0);
    expect((await ctx.api.get(up.body.url).set(H())).status).toBe(404);
  });

  it('rejects an unknown kind, a missing file, and a bad ref_id', async () => {
    expect((await ctx.api.post('/api/attachments').set(H())
      .field('kind', 'nope').field('ref_id', '1').attach('image', PNG, 'x.png')).status).toBe(400);
    expect((await ctx.api.post('/api/attachments').set(H())
      .field('kind', 'damage').field('ref_id', '0').attach('image', PNG, 'x.png')).status).toBe(400);
    expect((await ctx.api.post('/api/attachments').set(H())
      .field('kind', 'damage').field('ref_id', '5')).status).toBe(400);
    expect((await ctx.api.get('/api/attachments').set(H())).status).toBe(400);
  });

  it('requires explicit production authority for unit photos and assigned delivery authority for proof', async () => {
    const hr = await createEmployee(ctx.api, token, { role: 'hr' }); // no inventory.*
    const wh = await createEmployee(ctx.api, token, { role: 'warehouse' }); // has inventory.adjust/view

    const asHr = await ctx.api.post('/api/attachments').set({ Authorization: `Bearer ${hr.token}` })
      .field('kind', 'qc_unit').field('ref_id', '1').attach('image', PNG, 'x.png');
    expect(asHr.status).toBe(403);

    const asWh = await ctx.api.post('/api/attachments').set({ Authorization: `Bearer ${wh.token}` })
      .field('kind', 'qc_unit').field('ref_id', '1').attach('image', PNG, 'x.png');
    expect(asWh.status).toBe(403);
    expect((await ctx.api.get('/api/attachments?kind=qc_unit&ref_id=1')
      .set({ Authorization: `Bearer ${hr.token}` })).status).toBe(403);

    await ctx.api.put(`/api/users/${wh.id}/permissions`).set(H()).send({overrides:{'delivery.run':true}});
    // A delivery photo needs delivery.run and assignment to the exact delivery.
    const del = await ctx.api.post('/api/deliveries').set(H())
      .send({ customer_name: 'Attachment access', assigned_to: wh.id });
    expect(del.status).toBe(201);
    expect((await ctx.api.post('/api/attachments').set({ Authorization: `Bearer ${wh.token}` })
      .field('kind', 'delivery').field('ref_id', String(del.body.id)).attach('image', PNG, 'x.png')).status).toBe(201);
    expect((await ctx.api.post('/api/attachments').set({ Authorization: `Bearer ${hr.token}` })
      .field('kind', 'delivery').field('ref_id', String(del.body.id)).attach('image', PNG, 'x.png')).status).toBe(403);
  });
});
