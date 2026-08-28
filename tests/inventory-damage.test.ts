/** Damage reporting: POST /api/inventory/:id/damage moves units into an auto-created
 *  "damage twin" (a category='Damage' copy), and the twin is hidden from the normal list. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';

let ctx: TestContext;
let token: string;
const hdr = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  ctx = await setupApp();
  token = await login(ctx.api);
});
afterAll(() => cleanup(ctx));

const mk = (body: Record<string, unknown>) =>
  ctx.api.post('/api/inventory').set(hdr()).send(body).then((r) => r.body.id as number);

describe('inventory: damage reporting', () => {
  it('first report creates a linked twin; second report tops up the same twin', async () => {
    const id = await mk({ name: 'Ceramic Mug', sku: 'MUG-1', quantity: 30, unit: 'pcs' });

    const first = await ctx.api.post(`/api/inventory/${id}/damage`).set(hdr()).send({ quantity: 3, reason: 'cracked' });
    expect(first.status).toBe(200);
    expect(first.body.source_quantity).toBe(27);
    expect(first.body.twin_quantity).toBe(3);
    const twinId = first.body.twin_id as number;

    const second = await ctx.api.post(`/api/inventory/${id}/damage`).set(hdr()).send({ quantity: 2 });
    expect(second.body.twin_id).toBe(twinId); // same twin, not a new row
    expect(second.body.twin_quantity).toBe(5);
    expect(second.body.source_quantity).toBe(25);

    const twin = await ctx.api.get(`/api/inventory/${twinId}`).set(hdr());
    expect(twin.body.category).toBe('Damage');
    expect(twin.body.sku).toBeNull();
    expect(twin.body.attributes.damaged_of).toBe(id);
    expect(twin.body.quantity).toBe(5);
  });

  it('hides twins from the list unless include_damaged / damaged=only is set', async () => {
    const id = await mk({ name: 'Glass Panel', sku: 'GLS-1', quantity: 10 });
    await ctx.api.post(`/api/inventory/${id}/damage`).set(hdr()).send({ quantity: 4 });

    const normal = await ctx.api.get('/api/inventory?q=Glass Panel').set(hdr());
    expect(normal.body.map((i: { category: string }) => i.category)).not.toContain('Damage');

    const withDamaged = await ctx.api.get('/api/inventory?q=Glass Panel&include_damaged=1').set(hdr());
    expect(withDamaged.body.some((i: { category: string }) => i.category === 'Damage')).toBe(true);

    const onlyDamaged = await ctx.api.get('/api/inventory?damaged=only').set(hdr());
    expect(onlyDamaged.body.length).toBeGreaterThan(0);
    expect(onlyDamaged.body.every((i: { category: string }) => i.category === 'Damage')).toBe(true);
  });

  it('keeps stats and the category list free of damage twins', async () => {
    const before = (await ctx.api.get('/api/inventory/stats').set(hdr())).body;
    const id = await mk({ name: 'Stats Probe', quantity: 8, category: 'Probe' });
    await ctx.api.post(`/api/inventory/${id}/damage`).set(hdr()).send({ quantity: 8 });
    const after = (await ctx.api.get('/api/inventory/stats').set(hdr())).body;

    // one real item added, the twin doesn't count
    expect(after.items).toBe(before.items + 1);
    // total units unchanged: 8 left the source, 8 entered the twin, twin excluded from the sum
    expect(after.total_units).toBe(before.total_units);

    const cats = (await ctx.api.get('/api/inventory/categories').set(hdr())).body;
    expect(cats).not.toContain('Damage');
  });

  it('rejects damaging more than is on hand, and damaging a twin', async () => {
    const id = await mk({ name: 'Short Stock', quantity: 2 });
    const over = await ctx.api.post(`/api/inventory/${id}/damage`).set(hdr()).send({ quantity: 5 });
    expect(over.status).toBe(400);
    expect(over.body.error).toMatch(/Only 2 available/);

    const ok = await ctx.api.post(`/api/inventory/${id}/damage`).set(hdr()).send({ quantity: 1 });
    const twinId = ok.body.twin_id as number;
    const onTwin = await ctx.api.post(`/api/inventory/${twinId}/damage`).set(hdr()).send({ quantity: 1 });
    expect(onTwin.status).toBe(400);
    expect(onTwin.body.error).toMatch(/already a damage record/);
  });

  it('needs inventory.adjust', async () => {
    const id = await mk({ name: 'RBAC Damage', quantity: 5 });
    const hr = await createEmployee(ctx.api, token, { username: 'dmg_hr', role: 'hr' });
    const res = await ctx.api
      .post(`/api/inventory/${id}/damage`)
      .set({ Authorization: `Bearer ${hr.token}` })
      .send({ quantity: 1 });
    expect(res.status).toBe(403);
  });
});
