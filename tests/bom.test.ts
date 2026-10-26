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

const mkCosted = async (name: string, cost: number, quantity = 0) =>
  (await ctx.api.post('/api/inventory').set(authHdr())
    .send({ name, quantity, attributes: { standard_cost: cost } })).body.id as number;

const setBom = (product: number, components: { component_item_id: number; quantity: number }[]) =>
  ctx.api.put(`/api/finished-products/${product}`).set(authHdr()).send({ components });

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

  it('allows a finished product with an empty BOM', async () => {
    const product = await mkItem('No-BOM Product');
    const put = await ctx.api.put(`/api/finished-products/${product}`).set(authHdr()).send({ components: [] });
    expect(put.status).toBe(200);
    const list = await ctx.api.get('/api/finished-products').set(authHdr());
    const row = list.body.find((p: { id: number }) => p.id === product);
    expect(row).toBeTruthy();
    expect(row.component_count).toBe(0);
  });

  it('stores optional standard labor + overhead and adds them to the rolled-up cost', async () => {
    const product = await mkItem('Costed FG');
    const part = await mkCosted('Costed Part', 30, 100);
    const put = await ctx.api.put(`/api/finished-products/${product}`).set(authHdr()).send({
      components: [{ component_item_id: part, quantity: 2 }],
      std_labor_cost: 15,
      std_overhead_cost: 5,
    });
    expect(put.status).toBe(200);

    const detail = await ctx.api.get(`/api/finished-products/${product}`).set(authHdr());
    expect(detail.body.std_labor_cost).toBe(15);
    expect(detail.body.std_overhead_cost).toBe(5);

    const cost = await ctx.api.get(`/api/finished-products/${product}/cost`).set(authHdr());
    expect(cost.body.unit_material_cost).toBe(60); // 2 × 30
    expect(cost.body.unit_labor_cost).toBe(15);
    expect(cost.body.unit_overhead_cost).toBe(5);
    expect(cost.body.unit_total_cost).toBe(80);

    // clearing with null removes them from the roll-up
    await ctx.api.put(`/api/finished-products/${product}`).set(authHdr()).send({
      components: [{ component_item_id: part, quantity: 2 }],
      std_labor_cost: null, std_overhead_cost: null,
    });
    const cleared = await ctx.api.get(`/api/finished-products/${product}/cost`).set(authHdr());
    expect(cleared.body.unit_total_cost).toBe(60);
  });

  it('suggests a selling price from complete BOM cost and configured markup without changing catalog price', async () => {
    const product = await mkItem('Suggested-price FG');
    const part = await mkCosted('Suggested-price part', 30);
    const save = await ctx.api.put(`/api/finished-products/${product}`).set(authHdr()).send({
      components: [{ component_item_id: part, quantity: 2 }],
      std_labor_cost: 15, std_overhead_cost: 5, selling_markup_percent: 25,
    });
    expect(save.status).toBe(200);
    const price = await ctx.api.get(`/api/finished-products/${product}/price-suggestion`).set(authHdr());
    expect(price.body).toMatchObject({ available: true, suggested_unit_price: 100, markup_percent: 25, currency: 'PHP' });
    expect(price.body).not.toHaveProperty('unit_total_cost');
    const detail = await ctx.api.get(`/api/finished-products/${product}`).set(authHdr());
    expect(detail.body.selling_markup_percent).toBe(25);
    expect(detail.body.attributes.sale_price).toBeUndefined();

    const invalid = await ctx.api.put(`/api/finished-products/${product}`).set(authHdr()).send({
      components: [{ component_item_id: part, quantity: 2 }], selling_markup_percent: -1,
    });
    expect(invalid.status).toBe(400);
    await ctx.api.put(`/api/finished-products/${product}`).set(authHdr()).send({
      components: [{ component_item_id: part, quantity: 2 }], selling_markup_percent: null,
    });
    expect((await ctx.api.get(`/api/finished-products/${product}/price-suggestion`).set(authHdr())).body.available).toBe(false);
  });

  it('does not suggest a price from a BOM with missing component cost', async () => {
    const product = await mkItem('Uncosted FG');
    const part = await mkItem('Uncosted part');
    await ctx.api.put(`/api/finished-products/${product}`).set(authHdr()).send({
      components: [{ component_item_id: part, quantity: 1 }], selling_markup_percent: 30,
    });
    const price = await ctx.api.get(`/api/finished-products/${product}/price-suggestion`).set(authHdr());
    expect(price.body).toMatchObject({ available: false, reason: 'BOM or component standard costs need review' });
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

    // an item can only be deleted once its stock is zeroed
    await ctx.api.post(`/api/inventory/${gone}/adjust`).set(authHdr())
      .send({ change: -10, reason: 'clear before delete' });
    expect((await ctx.api.delete(`/api/inventory/${gone}`).set(authHdr())).status).toBe(200);

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

describe('multi-level BOM: explode / cost / where-used', () => {
  // Bike ─ 2× Wheel(sub) ─ [1× Rim@100, 32× Spoke@2] ; 1× Frame@500 ; 2× Spoke@2
  let bike = 0, wheel = 0, rim = 0, spoke = 0, frame = 0;

  beforeAll(async () => {
    bike = await mkItem('ML Bicycle');
    wheel = await mkItem('ML Wheel');
    rim = await mkCosted('ML Rim', 100, 50);
    spoke = await mkCosted('ML Spoke', 2, 5000);
    frame = await mkCosted('ML Frame', 500, 10);
    await setBom(wheel, [
      { component_item_id: rim, quantity: 1 },
      { component_item_id: spoke, quantity: 32 },
    ]);
    await setBom(bike, [
      { component_item_id: wheel, quantity: 2 },
      { component_item_id: frame, quantity: 1 },
      { component_item_id: spoke, quantity: 2 },
    ]);
  });

  it('explodes the whole tree to raw materials', async () => {
    const res = await ctx.api.get(`/api/finished-products/${bike}/explode?qty=10`).set(authHdr());
    expect(res.status).toBe(200);
    const byName = Object.fromEntries(res.body.materials.map((m: { name: string }) => [m.name, m]));
    expect(byName['ML Spoke'].total_qty).toBe(660); // (2×32 + 2) × 10
    expect(byName['ML Rim'].total_qty).toBe(20);
    expect(byName['ML Frame'].total_qty).toBe(10);
    expect(res.body.subassemblies).toEqual([{ item_id: wheel, name: 'ML Wheel', total_qty: 20 }]);
    expect(res.body.material_cost).toBe(8320); // 832 per bike × 10
  });

  it('rolls sub-assembly cost up in /cost', async () => {
    const res = await ctx.api.get(`/api/finished-products/${bike}/cost`).set(authHdr());
    expect(res.status).toBe(200);
    const wheelLine = res.body.lines.find((l: { item_id: number }) => l.item_id === wheel);
    expect(wheelLine.unit_cost).toBe(164); // 100 + 32×2
    expect(wheelLine.is_subassembly).toBe(true);
    expect(res.body.unit_material_cost).toBe(832);
  });

  it('reports where a component is used, direct vs indirect', async () => {
    const res = await ctx.api.get(`/api/inventory/${rim}/where-used`).set(authHdr());
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.map((r: { id: number; indirect: boolean }) => [r.id, r.indirect]));
    expect(byId[wheel]).toBe(false); // direct
    expect(byId[bike]).toBe(true);   // only via Wheel
  });

  it('404s explode for a missing item', async () => {
    expect((await ctx.api.get('/api/finished-products/999999/explode').set(authHdr())).status).toBe(404);
  });
});

it('rejects a stale reviewed definition and safely recovers an identical save', async () => {
  const product = await mkItem('Concurrent mobile BOM');
  const component = await mkItem('Concurrent part', 42);
  const line = (quantity: number) => [{ component_item_id: component, quantity, notes: null }];
  await ctx.api.put(`/api/finished-products/${product}`).set(authHdr()).send({ components: line(1), std_labor_cost: 7 });
  const before = (await ctx.api.get(`/api/finished-products/${product}`).set(authHdr())).body;
  const save = await ctx.api.put(`/api/finished-products/${product}`).set(authHdr()).send({ components: line(2), expected_components: line(1) });
  expect(save.status).toBe(200);
  const recovered = await ctx.api.put(`/api/finished-products/${product}`).set(authHdr()).send({ components: line(2), expected_components: line(1) });
  expect(recovered.status).toBe(200);
  const stale = await ctx.api.put(`/api/finished-products/${product}`).set(authHdr()).send({ components: line(3), expected_components: line(1) });
  expect(stale.status).toBe(409); expect(stale.body.code).toBe('bom_changed');
  const after = (await ctx.api.get(`/api/finished-products/${product}`).set(authHdr())).body;
  expect(after.bom[0].quantity).toBe(2);
  expect(after.quantity).toBe(before.quantity);expect(after.std_labor_cost).toBe(7);
  expect(after.qc_checklist_qa_id).toBe(before.qc_checklist_qa_id);expect(after.qc_checklist_qc_id).toBe(before.qc_checklist_qc_id);
  expect((await ctx.api.get(`/api/inventory/${component}`).set(authHdr())).body.quantity).toBe(42);
  const metadata = await ctx.api.put(`/api/finished-products/${product}`).set(authHdr()).send({ components: line(2), expected_components: line(1), std_labor_cost: 99 });
  expect(metadata.status).toBe(409);
});

it('requires current configuration access and validates reviewed component quantities', async () => {
  const product = await mkItem('Protected mobile BOM');const c = await mkItem('Protected part', 5);
  await ctx.api.post('/api/roles').set(authHdr()).send({key:'bom_reader',label:'BOM reader',permissions:['production.view']});
  const reader=await createEmployee(ctx.api,token,{role:'bom_reader'});
  expect((await ctx.api.get(`/api/finished-products/${product}`).set({Authorization:`Bearer ${reader.token}`})).status).toBe(200);
  expect((await ctx.api.put(`/api/finished-products/${product}`).set({Authorization:`Bearer ${reader.token}`}).send({components:[],expected_components:[]})).status).toBe(403);
  expect((await ctx.api.put(`/api/finished-products/${product}`).set(authHdr()).send({components:[{component_item_id:c,quantity:1.5}],expected_components:[]})).status).toBe(400);
  expect((await ctx.api.put(`/api/finished-products/${product}`).set(authHdr()).send({components:[],expected_components:[{component_item_id:c,quantity:-1}]})).status).toBe(400);
});


it('does not confirm an empty save after a concurrent product removal', async () => {
  const product=await mkItem('Removed product definition'),part=await mkItem('Removed definition part',8);
  const original=[{component_item_id:part,quantity:1}];await setBom(product,original);
  expect((await ctx.api.delete(`/api/finished-products/${product}`).set(authHdr())).status).toBe(200);
  const retry=await ctx.api.put(`/api/finished-products/${product}`).set(authHdr()).send({components:[],expected_components:original});
  expect(retry.status).toBe(409);expect(retry.body.code).toBe('bom_changed');
});
