/** Document templates: default seeds, admin-only CRUD, company profile. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';

let ctx: TestContext;
let admin: string;
let emp: { token: string };
const hdr = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  ctx = await setupApp();
  admin = await login(ctx.api);
  emp = await createEmployee(ctx.api, admin);
});
afterAll(() => cleanup(ctx));

describe('templates', () => {
  it('seeds default Sale and Job order templates on first run', async () => {
    const list = await ctx.api.get('/api/templates').set(hdr(admin));
    expect(list.body.some((t: { type: string }) => t.type === 'sale')).toBe(true);
    expect(list.body.some((t: { type: string }) => t.type === 'job')).toBe(true);
  });

  it('lets an admin create, edit and delete a template', async () => {
    const c = await ctx.api.post('/api/templates').set(hdr(admin))
      .send({ name: 'Custom', type: 'generic', body: 'Hi {{order.no}}' });
    expect(c.status).toBe(201);

    const revision = (await ctx.api.get('/api/templates/' + c.body.id).set(hdr(admin))).body.revision;
    const u = await ctx.api.put('/api/templates/' + c.body.id).set(hdr(admin))
      .send({ expected_revision: revision, name: 'Custom 2', type: 'generic', body: 'Bye {{order.no}}' });
    expect(u.status).toBe(200);

    const got = await ctx.api.get('/api/templates/' + c.body.id).set(hdr(admin));
    expect(got.body.name).toBe('Custom 2');

    expect((await ctx.api.delete('/api/templates/' + c.body.id).set(hdr(admin))).status).toBe(200);
  });

  it('rejects stale or missing revisions without overwriting a newer save', async () => {
    const created = await ctx.api.post('/api/templates').set(hdr(admin)).send({ name: 'Concurrent', body: '<p>Original</p>' });
    const opened = await ctx.api.get('/api/templates/' + created.body.id).set(hdr(admin));
    const fresh = await ctx.api.put('/api/templates/' + created.body.id).set(hdr(admin)).send({ name: 'Concurrent', body: '<p>First save</p>', expected_revision: opened.body.revision });
    expect(fresh.status).toBe(200); expect(fresh.body.revision).not.toBe(opened.body.revision);
    const stale = await ctx.api.put('/api/templates/' + created.body.id).set(hdr(admin)).send({ name: 'Concurrent', body: '<p>Stale save</p>', expected_revision: opened.body.revision });
    expect(stale.status).toBe(409);
    expect((await ctx.api.put('/api/templates/' + created.body.id).set(hdr(admin)).send({ name: 'Concurrent', body: 'Missing revision' })).status).toBe(428);
    expect((await ctx.api.get('/api/templates/' + created.body.id).set(hdr(admin))).body.body).toBe('<p>First save</p>');
  });

  it('copies print configuration and scoped variables on save', async () => {
    const created = await ctx.api.post('/api/templates').set(hdr(admin)).send({ name: 'Source', period: '2026-10', body: '<p>{{local_note}}</p>', copies_per_record: 2, records_per_page: 3, tile_fill: 'repeat', tile_continuous: true, repeat_count: 7 });
    await ctx.api.post('/api/templates/variables').set(hdr(admin)).send({ scope: 'template', template_id: created.body.id, key: 'local_note', label: 'Local note', source_type: 'constant', value: 'Keep me' });
    const source = (await ctx.api.get('/api/templates/' + created.body.id).set(hdr(admin))).body;
    const copy = await ctx.api.post('/api/templates').set(hdr(admin)).send({ ...source, name: 'Source (copy)', source_template_id: source.id, source_revision: source.revision });
    expect(copy.status).toBe(201); expect(copy.body.id).not.toBe(source.id);
    const saved = (await ctx.api.get('/api/templates/' + copy.body.id).set(hdr(admin))).body;
    expect(saved).toMatchObject({ body: source.body, period: '2026-10', copies_per_record: 2, records_per_page: 3, tile_fill: 'repeat', tile_continuous: 1, repeat_count: 7 });
    const variables = (await ctx.api.get('/api/templates/variables?template_id=' + copy.body.id).set(hdr(admin))).body;
    const local = variables.find((v: any) => v.key === 'local_note'); expect(local).toMatchObject({ template_id: copy.body.id, value: 'Keep me' });
    await ctx.api.delete('/api/templates/' + source.id).set(hdr(admin));
    expect((await ctx.api.get('/api/templates/variables?template_id=' + copy.body.id).set(hdr(admin))).body.some((v: any) => v.key === 'local_note')).toBe(true);
  });

  it('rejects style-only empty bodies', async () => {
    const res = await ctx.api.post('/api/templates').set(hdr(admin)).send({ name: 'Empty', body: '<style data-docpage>@page{size:210mm 297mm;margin:14mm}</style><p><br></p>' });
    expect(res.status).toBe(400);
  });

  it('forbids a non-admin from creating or deleting templates', async () => {
    const c = await ctx.api.post('/api/templates').set(hdr(emp.token))
      .send({ name: 'Nope', type: 'generic', body: 'x' });
    expect(c.status).toBe(403);
    // employees can still read
    expect((await ctx.api.get('/api/templates').set(hdr(emp.token))).status).toBe(200);
  });

  it('rejects an empty template body', async () => {
    const res = await ctx.api.post('/api/templates').set(hdr(admin)).send({ name: 'X', body: '' });
    expect(res.status).toBe(400);
  });

  it('defaults copies_per_record/records_per_page/tile_fill and lets an admin opt into N-up tiling', async () => {
    const c = await ctx.api.post('/api/templates').set(hdr(admin))
      .send({ name: 'Tiled', type: 'generic', body: 'Hi {{order.no}}' });
    const got = await ctx.api.get('/api/templates/' + c.body.id).set(hdr(admin));
    expect(got.body.copies_per_record).toBe(1);
    expect(got.body.records_per_page).toBe(1);
    expect(got.body.tile_fill).toBe('blank');
    // the list endpoint carries the fields too, so the UI can badge tiled templates
    const list = await ctx.api.get('/api/templates').set(hdr(admin));
    expect(list.body.find((t: { id: number }) => t.id === c.body.id)).toMatchObject({ copies_per_record: 1, records_per_page: 1, tile_fill: 'blank' });

    const u = await ctx.api.put('/api/templates/' + c.body.id).set(hdr(admin))
      .send({ expected_revision: got.body.revision, name: 'Tiled', type: 'generic', body: 'Hi {{order.no}}', copies_per_record: 2, records_per_page: 2, tile_fill: 'repeat' });
    expect(u.status).toBe(200);
    const got2 = await ctx.api.get('/api/templates/' + c.body.id).set(hdr(admin));
    expect(got2.body.copies_per_record).toBe(2);
    expect(got2.body.records_per_page).toBe(2);
    expect(got2.body.tile_fill).toBe('repeat');
  });

  it('rejects a copies x records-per-page combination over the 12-cell cap', async () => {
    const res = await ctx.api.post('/api/templates').set(hdr(admin))
      .send({ name: 'TooBig', type: 'generic', body: 'x', copies_per_record: 5, records_per_page: 5 });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid tile_fill value', async () => {
    const res = await ctx.api.post('/api/templates').set(hdr(admin))
      .send({ name: 'BadFill', type: 'generic', body: 'x', tile_fill: 'nonsense' });
    expect(res.status).toBe(400);
  });
});

describe('company profile', () => {
  it('returns a default (empty) profile and saves admin edits', async () => {
    const def = await ctx.api.get('/api/templates/company').set(hdr(admin));
    expect(def.status).toBe(200);
    expect(def.body).toHaveProperty('name');
    // image compression defaults on for a fresh workspace
    expect(def.body.compress_images).toBe(true);

    const put = await ctx.api.put('/api/templates/company').set(hdr(admin))
      .send({ name: 'Verdesakay Inc.', address: 'Cebu', phone: '123', email: 'a@b.c', logo_url: '' });
    expect(put.status).toBe(200);

    const got = await ctx.api.get('/api/templates/company').set(hdr(admin));
    expect(got.body.name).toBe('Verdesakay Inc.');
    // omitting the field on save keeps the default rather than clearing it
    expect(got.body.compress_images).toBe(true);
  });

  it('persists the compress_images toggle when turned off', async () => {
    const put = await ctx.api.put('/api/templates/company').set(hdr(admin))
      .send({ name: 'Verdesakay Inc.', compress_images: false });
    expect(put.status).toBe(200);

    const got = await ctx.api.get('/api/templates/company').set(hdr(admin));
    expect(got.body.compress_images).toBe(false);
  });

  it('forbids a non-admin from editing the company profile', async () => {
    const res = await ctx.api.put('/api/templates/company').set(hdr(emp.token)).send({ name: 'Hack' });
    expect(res.status).toBe(403);
  });
});

describe('template variables (registry)', () => {
  it('publishes a categorized data-source catalog', async () => {
    const res = await ctx.api.get('/api/templates/variables/catalog').set(hdr(admin));
    expect(res.status).toBe(200);
    const groups = res.body.map((g: { group: string }) => g.group);
    expect(groups).toContain('Company');
    expect(groups).toContain('Order');
    expect(res.body.find((g: { group: string }) => g.group === 'Order').items.some((i: { path: string }) => i.path === 'order.total')).toBe(true);
  });

  it('lets an admin create, edit and delete a global variable', async () => {
    const c = await ctx.api.post('/api/templates/variables').set(hdr(admin))
      .send({ scope: 'global', key: 'vat_percent', label: 'VAT %', category: 'Tax', source_type: 'constant', value: '12', data_type: 'number' });
    expect(c.status).toBe(201);

    const list = await ctx.api.get('/api/templates/variables').set(hdr(admin));
    expect(list.body.find((v: { key: string }) => v.key === 'vat_percent').label).toBe('VAT %');

    const u = await ctx.api.put('/api/templates/variables/' + c.body.id).set(hdr(admin))
      .send({ key: 'vat_percent', label: 'VAT rate', category: 'Tax', source_type: 'constant', value: '10', data_type: 'number' });
    expect(u.status).toBe(200);
    const list2 = await ctx.api.get('/api/templates/variables').set(hdr(admin));
    expect(list2.body.find((v: { key: string }) => v.key === 'vat_percent').label).toBe('VAT rate');

    expect((await ctx.api.delete('/api/templates/variables/' + c.body.id).set(hdr(admin))).status).toBe(200);
  });

  it('rejects a duplicate key in the same scope', async () => {
    await ctx.api.post('/api/templates/variables').set(hdr(admin)).send({ scope: 'global', key: 'dup_key', label: 'A', source_type: 'constant', value: '1' });
    const dup = await ctx.api.post('/api/templates/variables').set(hdr(admin)).send({ scope: 'global', key: 'dup_key', label: 'B', source_type: 'constant', value: '2' });
    expect(dup.status).toBe(409);
  });

  it('rejects an invalid key and forbids non-admins', async () => {
    expect((await ctx.api.post('/api/templates/variables').set(hdr(admin)).send({ scope: 'global', key: '9 bad key', label: 'x', source_type: 'constant' })).status).toBe(400);
    expect((await ctx.api.post('/api/templates/variables').set(hdr(emp.token)).send({ scope: 'global', key: 'nope', label: 'x', source_type: 'constant' })).status).toBe(403);
  });

  it('scopes template-local variables to their template', async () => {
    const tpl = await ctx.api.post('/api/templates').set(hdr(admin)).send({ name: 'VarTpl', type: 'generic', body: 'x' });
    const v = await ctx.api.post('/api/templates/variables').set(hdr(admin))
      .send({ scope: 'template', template_id: tpl.body.id, key: 'local_note', label: 'Local note', source_type: 'formula', formula: 'order.subtotal * 2', data_type: 'currency' });
    expect(v.status).toBe(201);
    // visible when asking for that template, hidden otherwise
    const withTpl = await ctx.api.get('/api/templates/variables?template_id=' + tpl.body.id).set(hdr(admin));
    expect(withTpl.body.some((x: { key: string }) => x.key === 'local_note')).toBe(true);
    const other = await ctx.api.get('/api/templates/variables?template_id=999999').set(hdr(admin));
    expect(other.body.some((x: { key: string }) => x.key === 'local_note')).toBe(false);
  });
});
