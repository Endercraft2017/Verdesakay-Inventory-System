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

    const img = await ctx.api.get(up.body.url).set(H());
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toContain('image/png');

    // scoped to the exact record
    expect((await ctx.api.get('/api/attachments?kind=qc_unit&ref_id=99').set(H())).body).toHaveLength(0);
    expect((await ctx.api.get('/api/attachments?kind=damage&ref_id=42').set(H())).body).toHaveLength(0);

    expect((await ctx.api.delete('/api/attachments/' + up.body.id).set(H())).status).toBe(200);
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

  it('gates qc_unit / damage on inventory perms, per kind', async () => {
    const hr = await createEmployee(ctx.api, token, { role: 'hr' }); // no inventory.*
    const wh = await createEmployee(ctx.api, token, { role: 'warehouse' }); // has inventory.adjust/view

    const asHr = await ctx.api.post('/api/attachments').set({ Authorization: `Bearer ${hr.token}` })
      .field('kind', 'qc_unit').field('ref_id', '1').attach('image', PNG, 'x.png');
    expect(asHr.status).toBe(403);

    const asWh = await ctx.api.post('/api/attachments').set({ Authorization: `Bearer ${wh.token}` })
      .field('kind', 'qc_unit').field('ref_id', '1').attach('image', PNG, 'x.png');
    expect(asWh.status).toBe(201);
    expect((await ctx.api.get('/api/attachments?kind=qc_unit&ref_id=1')
      .set({ Authorization: `Bearer ${hr.token}` })).status).toBe(403);

    // a `delivery` photo needs delivery.run, not inventory.*
    expect((await ctx.api.post('/api/attachments').set({ Authorization: `Bearer ${wh.token}` })
      .field('kind', 'delivery').field('ref_id', '1').attach('image', PNG, 'x.png')).status).toBe(201);
    expect((await ctx.api.post('/api/attachments').set({ Authorization: `Bearer ${hr.token}` })
      .field('kind', 'delivery').field('ref_id', '1').attach('image', PNG, 'x.png')).status).toBe(403);
  });
});

it('never uses an executable original extension for an image', async () => {
  const res = await ctx.api.post('/api/attachments').set(H()).field('kind', 'problem').field('ref_id', '77')
    .attach('image', Buffer.from('<script>alert(1)</script>'), { filename: 'payload.html', contentType: 'image/png' });
  expect(res.status).toBe(201);
  const image = await ctx.api.get(res.body.url).set(H());
  expect(image.type).toBe('image/png');
  expect(image.headers['x-content-type-options']).toBe('nosniff');
});
