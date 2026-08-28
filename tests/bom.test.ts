/** Finished products + bill of materials (bom_components). */
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

const mkItem = async (name: string, quantity = 0) =>
  (await ctx.api.post('/api/inventory').set(authHdr()).send({ name, quantity })).body.id as number;

describe('finished products + BOM', () => {
  it('marks an item as a finished product and stores its BOM', async () => {
    const product = await mkItem('Prado — Black');
    const bolt = await mkItem('Bolt M8', 500);
    const panel = await mkItem('Door Panel', 40);

    const put = await ctx.api.put(`/api/finished-products/${product}`).set(authHdr()).send({
      components: [
        { component_item_id: bolt, quantity: 24 },
        { component_item_id: panel, quantity: 4, notes: 'front + rear' },
      ],
    });
    expect(put.status).toBe(200);

    const list = await ctx.api.get('/api/finished-products').set(authHdr());
    const row = list.body.find((p: { id: number }) => p.id === product);
    expect(row.component_count).toBe(2);
    // buildable = min(floor(500/24)=20, floor(40/4)=10) = 10
    expect(row.max_buildable).toBe(10);

    const detail = await ctx.api.get(`/api/finished-products/${product}`).set(authHdr());
    expect(detail.body.max_buildable).toBe(10);
    const panelLine = detail.body.bom.find((c: { component_item_id: number }) => c.component_item_id === panel);
    expect(panelLine.component_name).toBe('Door Panel');
    expect(panelLine.component_on_hand).toBe(40);
    expect(panelLine.notes).toBe('front + rear');
  });

  it('replaces the BOM on a second PUT (not appends)', async () => {
    const product = await mkItem('Widget A');
    const c1 = await mkItem('Part 1', 10);
    const c2 = await mkItem('Part 2', 10);
    await ctx.api.put(`/api/finished-products/${product}`).set(authHdr())
      .send({ components: [{ component_item_id: c1, quantity: 1 }] });
    await ctx.api.put(`/api/finished-products/${product}`).set(authHdr())
      .send({ components: [{ component_item_id: c2, quantity: 2 }] });
    const detail = await ctx.api.get(`/api/finished-products/${product}`).set(authHdr());
    expect(detail.body.bom.map((c: { component_item_id: number }) => c.component_item_id)).toEqual([c2]);
  });

  it('rejects self-reference, duplicates and unknown components', async () => {
    const product = await mkItem('Self Ref');
    const c = await mkItem('A Part', 5);
    expect((await ctx.api.put(`/api/finished-products/${product}`).set(authHdr())
      .send({ components: [{ component_item_id: product, quantity: 1 }] })).status).toBe(400);
    expect((await ctx.api.put(`/api/finished-products/${product}`).set(authHdr())
      .send({ components: [{ component_item_id: c, quantity: 1 }, { component_item_id: c, quantity: 2 }] })).status).toBe(400);
    expect((await ctx.api.put(`/api/finished-products/${product}`).set(authHdr())
      .send({ components: [{ component_item_id: 999999, quantity: 1 }] })).status).toBe(400);
    expect((await ctx.api.put(`/api/finished-products/${product}`).set(authHdr())
      .send({ components: [{ component_item_id: c, quantity: 0 }] })).status).toBe(400);
  });

  it('unflag clears the BOM but keeps the item', async () => {
    const product = await mkItem('Temp Product');
    const c = await mkItem('Temp Part', 3);
    await ctx.api.put(`/api/finished-products/${product}`).set(authHdr())
      .send({ components: [{ component_item_id: c, quantity: 1 }] });

    const del = await ctx.api.delete(`/api/finished-products/${product}`).set(authHdr());
    expect(del.status).toBe(200);

    expect((await ctx.api.get('/api/finished-products').set(authHdr()))
      .body.some((p: { id: number }) => p.id === product)).toBe(false);
    // item still there, no longer flagged, no BOM
    const item = await ctx.api.get(`/api/inventory/${product}`).set(authHdr());
    expect(item.status).toBe(200);
    const detail = await ctx.api.get(`/api/finished-products/${product}`).set(authHdr());
    expect(detail.body.bom).toEqual([]);
  });

  it('deleting a component item drops it from BOMs (cascade)', async () => {
    const product = await mkItem('Cascade Product');
    const keep = await mkItem('Keep Part', 10);
    const gone = await mkItem('Gone Part', 10);
    await ctx.api.put(`/api/finished-products/${product}`).set(authHdr())
      .send({ components: [{ component_item_id: keep, quantity: 1 }, { component_item_id: gone, quantity: 1 }] });

    await ctx.api.delete(`/api/inventory/${gone}`).set(authHdr());

    const detail = await ctx.api.get(`/api/finished-products/${product}`).set(authHdr());
    expect(detail.body.bom.map((c: { component_item_id: number }) => c.component_item_id)).toEqual([keep]);
  });

  it('requires inventory.edit to change a BOM', async () => {
    const product = await mkItem('Guarded Product');
    const c = await mkItem('Guarded Part', 5);
    const acct = await createEmployee(ctx.api, token, { role: 'accounting', username: 'bom_acct' }); // inventory.view only
    const res = await ctx.api.put(`/api/finished-products/${product}`).set('Authorization', `Bearer ${acct.token}`)
      .send({ components: [{ component_item_id: c, quantity: 1 }] });
    expect(res.status).toBe(403);
  });
});
