/** In-app bug reporting (/api/bug-reports) — any signed-in user can file a report
 *  with up to 5 screenshots; only users.manage can list/view/resolve them. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';

let ctx: TestContext;
let adminToken: string;
let warehouse: { id: number; token: string };

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const PNG = Buffer.from('fake-png-bytes');

beforeAll(async () => {
  ctx = await setupApp();
  adminToken = await login(ctx.api);
  warehouse = await createEmployee(ctx.api, adminToken, { username: 'wh_bug', role: 'warehouse' });
});
afterAll(() => cleanup(ctx));

describe('bug reports', () => {
  it('lets any signed-in user file a report with screenshots, without users.manage', async () => {
    const res = await ctx.api.post('/api/bug-reports').set(bearer(warehouse.token))
      .field('title', 'Save button does nothing')
      .field('steps_to_reproduce', '1. Open an item\n2. Click Save\n3. Nothing happens')
      .field('description', 'Expected the item to save; instead the button just spins.')
      .field('page_context', 'Inventory › All Items')
      .attach('screenshots', PNG, 'shot1.png')
      .attach('screenshots', PNG, 'shot2.png');
    expect(res.status).toBe(201);
    expect(res.body.screenshots).toBe(2);
  });

  it('requires a title and steps to reproduce', async () => {
    const noTitle = await ctx.api.post('/api/bug-reports').set(bearer(warehouse.token))
      .field('title', '').field('steps_to_reproduce', 'do a thing');
    expect(noTitle.status).toBe(400);

    const noSteps = await ctx.api.post('/api/bug-reports').set(bearer(warehouse.token))
      .field('title', 'Something broke').field('steps_to_reproduce', '');
    expect(noSteps.status).toBe(400);
  });

  it('caps screenshots at 5 per report', async () => {
    const req = ctx.api.post('/api/bug-reports').set(bearer(warehouse.token))
      .field('title', 'Too many screenshots').field('steps_to_reproduce', 'attach 6 images');
    for (let i = 0; i < 6; i++) req.attach('screenshots', PNG, `shot${i}.png`);
    const res = await req;
    expect(res.status).toBe(400);
  });

  it('blocks a non-admin from listing, viewing or resolving reports', async () => {
    expect((await ctx.api.get('/api/bug-reports').set(bearer(warehouse.token))).status).toBe(403);
    expect((await ctx.api.get('/api/bug-reports/1').set(bearer(warehouse.token))).status).toBe(403);
    expect((await ctx.api.put('/api/bug-reports/1').set(bearer(warehouse.token)).send({ status: 'resolved' })).status).toBe(403);
    expect((await ctx.api.get('/api/bug-reports/open-count').set(bearer(warehouse.token))).status).toBe(403);
  });

  it('lets an admin list, view (with screenshots), and resolve/reopen a report', async () => {
    const list = await ctx.api.get('/api/bug-reports').set(bearer(adminToken));
    expect(list.status).toBe(200);
    const row = list.body.find((r: { title: string }) => r.title === 'Save button does nothing');
    expect(row).toBeTruthy();
    expect(row.reporter_name).toBeTruthy();
    expect(row.screenshot_count).toBe(2);
    expect(row.status).toBe('open');

    const before = (await ctx.api.get('/api/bug-reports/open-count').set(bearer(adminToken))).body.count;
    expect(before).toBeGreaterThan(0);

    const detail = await ctx.api.get(`/api/bug-reports/${row.id}`).set(bearer(adminToken));
    expect(detail.status).toBe(200);
    expect(detail.body.steps_to_reproduce).toContain('Click Save');
    expect(detail.body.screenshots).toHaveLength(2);

    const img = await ctx.api.get(`/api${detail.body.screenshots[0].url}`).set(bearer(adminToken));
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toContain('image/png');

    const resolve = await ctx.api.put(`/api/bug-reports/${row.id}`).set(bearer(adminToken)).send({ status: 'resolved' });
    expect(resolve.status).toBe(200);
    const after = (await ctx.api.get('/api/bug-reports/open-count').set(bearer(adminToken))).body.count;
    expect(after).toBe(before - 1);

    const filtered = await ctx.api.get('/api/bug-reports?status=resolved').set(bearer(adminToken));
    expect(filtered.body.some((r: { id: number }) => r.id === row.id)).toBe(true);

    const reopen = await ctx.api.put(`/api/bug-reports/${row.id}`).set(bearer(adminToken)).send({ status: 'open' });
    expect(reopen.status).toBe(200);
    expect((await ctx.api.get('/api/bug-reports/open-count').set(bearer(adminToken))).body.count).toBe(before);
  });
});
