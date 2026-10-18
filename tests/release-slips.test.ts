/** Sale-order releasing, warehouse side: approved SO → warehouse accepts → pick/release →
 *  release slip (numbered record of what left, with photos). Issuing the slip confirms the SO,
 *  which is when stock goes out — even with the general ledger off (no COGS then). */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, addSerializedUnits, type TestContext } from './helpers';

let ctx: TestContext;
let token: string;
const H = () => ({ Authorization: `Bearer ${token}` });
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const PNG = Buffer.from('fake-png-bytes');

beforeAll(async () => {
  ctx = await setupApp();
  token = await login(ctx.api);
  // These tests cover the slip itself; release authorizations are tests/release-auth.test.ts.
  await ctx.api.put('/api/release-slips/policy').set(H()).send({ authorization_required: false });
});
afterAll(() => cleanup(ctx));

const mkItem = async (body: Record<string, unknown>) =>
  (await ctx.api.post('/api/inventory').set(H()).send(body)).body.id as number;
const onHand = async (id: number) =>
  (await ctx.api.get(`/api/inventory/${id}`).set(H())).body.quantity as number;
const saleOrder = async (lines: Array<Record<string, unknown>>, status = 'approved') =>
  (await ctx.api.post('/api/orders').set(H()).send({ type: 'sale', customer_name: 'ACME', status, items: lines })).body.id as number;
const getOrder = async (id: number) => (await ctx.api.get(`/api/orders/${id}`).set(H())).body;
const queue = async () => (await ctx.api.get('/api/release-slips/queue').set(H())).body as {
  to_accept: Array<{ id: number }>; releasing: Array<{ id: number; qty_ordered: number; qty_released: number }>;
};

/** A finished product with `qty` received, in-stock serialized units labelled PFX-SN-n. */
async function productWithUnits(prefix: string, qty: number) {
  const product = await mkItem({ name: `${prefix} Product`, unit_cost: 10 });
  const part = await mkItem({ name: `${prefix} Part`, quantity: 1000 });
  await ctx.api.put(`/api/finished-products/${product}`).set(H())
    .send({ components: [{ component_item_id: part, quantity: 1 }] });
  const mo = (await ctx.api.post('/api/job-orders').set(H())
    .send({ product_item_id: product, qty_ordered: qty, qc_stages: 1 })).body.id;
  await ctx.api.post(`/api/job-orders/${mo}/approve`).set(H());
  await ctx.api.post(`/api/job-orders/warehouse-accept`).set(H()).send({ job_order_ids: [mo] });
  await ctx.api.post(`/api/job-orders/prepare`).set(H()).send({ job_orders: [{ id: mo }] });
  await ctx.api.post(`/api/job-orders/${mo}/release`).set(H());
  await ctx.api.post(`/api/job-orders/${mo}/accept`).set(H());
  await addSerializedUnits(ctx.api, token, mo, qty, prefix);
  const pending = (await ctx.api.get(`/api/job-orders/${mo}/units`).set(H())).body as Array<{ id: number }>;
  const codes: string[] = [];
  for (let i = 0; i < pending.length; i++) {
    const code = `${prefix}-SN-${i + 1}`;
    await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(H())
      .send({ unit_ids: [pending[i]!.id], result: 'pass', identifier: code });
    codes.push(code);
  }
  const receivable = (await ctx.api.get(`/api/job-orders/${mo}/receivable`).set(H())).body;
  if (receivable.units?.length) {
    await ctx.api.post(`/api/job-orders/${mo}/products-in`).set(H())
      .send({ location_id: receivable.output_location_id, unit_ids: receivable.units.map((u: { id: number }) => u.id) });
  }
  return { product, codes };
}

describe('warehouse acceptance', () => {
  it('keeps service-only sales out of the goods-release queue', async () => {
    const so = await saleOrder([{ name: 'Installation service', quantity: 1, unit_price: 500 }]);
    expect((await queue()).to_accept.some((o) => o.id === so)).toBe(false);
    const accept = await ctx.api.post(`/api/orders/${so}/accept-release`).set(H());
    expect(accept.status).toBe(409);
    expect(accept.body.error).toMatch(/no stock goods/i);
  });

  it('an approved SO waits in "to accept", then moves to "releasing" once accepted', async () => {
    const raw = await mkItem({ name: 'A1 Widget', quantity: 20 });
    const so = await saleOrder([{ name: 'A1 Widget', item_id: raw, quantity: 5, unit_price: 10 }]);
    expect((await queue()).to_accept.some((o) => o.id === so)).toBe(true);

    const acc = await ctx.api.post(`/api/orders/${so}/accept-release`).set(H());
    expect(acc.status).toBe(200);
    expect(acc.body.order.warehouse_accepted_at).toBeTruthy();
    const q = await queue();
    expect(q.to_accept.some((o) => o.id === so)).toBe(false);
    const row = q.releasing.find((o) => o.id === so)!;
    expect(row.qty_ordered).toBe(5);
    expect(row.qty_released).toBe(0);
    const context = (await ctx.api.get(`/api/release-slips/orders/${so}/context`).set(H())).body;
    expect(context.order.location_name).toBeTruthy();
    expect(context.availability).toEqual(expect.arrayContaining([expect.objectContaining({
      item_id: raw, free_to_allocate: 20, on_hand: 20,
    })]));
    expect((await getOrder(so)).warehouse_accepted_by_name).toBeTruthy();
  });

  it('refuses to accept an order that is not approved yet', async () => {
    const raw = await mkItem({ name: 'A2 Widget', quantity: 20 });
    const so = await saleOrder([{ name: 'A2 Widget', item_id: raw, quantity: 1, unit_price: 10 }], 'open');
    const r = await ctx.api.post(`/api/orders/${so}/accept-release`).set(H());
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/approved/i);
  });

  it('re-opening an order clears the acceptance', async () => {
    const raw = await mkItem({ name: 'A3 Widget', quantity: 20 });
    const so = await saleOrder([{ name: 'A3 Widget', item_id: raw, quantity: 1, unit_price: 10 }]);
    await ctx.api.post(`/api/orders/${so}/accept-release`).set(H());
    await ctx.api.post(`/api/orders/${so}/status`).set(H()).send({ status: 'open' });
    expect((await getOrder(so)).warehouse_accepted_at).toBeNull();
  });
});

describe('release slip', () => {
  it('closes a direct-sale audit from a reconciled count only for the captured ledger evidence', async () => {
    const {product}=await productWithUnits('AUDIT-COUNT',3);
    const so=await saleOrder([{name:'AUDIT-COUNT Product',item_id:product,quantity:1,unit_price:50}]);
    await ctx.api.post(`/api/orders/${so}/accept-release`).set(H());
    const unit=(await ctx.api.get(`/api/finished-products/${product}/units`).set(H())).body[0];
    expect((await ctx.api.post(`/api/finished-products/${product}/units/allocate`).set(H())
      .send({action:'sell',unit_ids:[unit.id],order_id:so})).status).toBe(200);
    expect((await ctx.api.post(`/api/orders/${so}/release-slip`).set(H()).send({collected_by:'Driver'})).status).toBe(201);
    const {queryOne}=await import('../src/shared/db');
    const {applyStockChange}=await import('../src/modules/inventory/inventory-stock');
    const reason=`Sold — ${(await getOrder(so)).number}`;
    const location=queryOne<{location_id:number}>(`SELECT location_id FROM inventory_transactions
      WHERE item_id=? AND reason=? ORDER BY id DESC LIMIT 1`,product,reason)!.location_id;
    applyStockChange({itemId:product,locationId:location,change:-1,reason,userId:null});
    const counter=(await createEmployee(ctx.api,token,{role:'warehouse'})).token;
    const countCase=async()=>{
      const c=(await ctx.api.get(`/api/inventory/stock-counts/context?item_id=${product}&location_id=${location}&build_mode=assembled`)
        .set(bearer(counter))).body;
      return ctx.api.post('/api/inventory/stock-counts').set(bearer(counter)).send({
        item_id:product,location_id:location,build_mode:'assembled',expected_quantity:c.book_quantity,
        expected_serial_ids:c.serials.map((s:any)=>s.id),expected_batches:c.batches.map((b:any)=>({batch_id:b.batch_id,quantity:b.quantity})),
        counted_untracked:0,counted_serial_codes:c.serials.map((s:any)=>s.code),
        counted_batches:c.batches.map((b:any)=>({batch_id:b.batch_id,quantity:b.quantity})),
        note:'Counted all labelled units on the production shelf',source_kind:'direct_sale',source_id:so,
      });
    };
    const first=await countCase();
    expect(first.status).toBe(201);
    expect(first.body.source_evidence_hash).toMatch(/^[a-f0-9]{64}$/);
    const path=`/api/inventory/stock-counts/${first.body.id}`;
    expect((await ctx.api.post(`${path}/approve`).set(H()).send({note:'Verified all present serial labels'})).status).toBe(200);
    expect((await ctx.api.post(`${path}/apply`).set(H()).send({})).status).toBe(200);
    expect((await onHand(product))).toBe(2);
    applyStockChange({itemId:product,locationId:location,change:-1,reason,userId:null});
    applyStockChange({itemId:product,locationId:location,change:1,reason:'Independent stock correction',userId:null});
    const stale=await ctx.api.post(`${path}/close-source`).set(H())
      .send({note:'Reviewed the direct-sale count and ledger'});
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('stale_source');
    const fresh=await countCase();
    expect(fresh.status).toBe(201);
    const freshPath=`/api/inventory/stock-counts/${fresh.body.id}`;
    await ctx.api.post(`${freshPath}/approve`).set(H()).send({note:'Rechecked labels and changed ledger'});
    await ctx.api.post(`${freshPath}/apply`).set(H()).send({});
    const closed=await ctx.api.post(`${freshPath}/close-source`).set(H())
      .send({note:'Reviewed new ledger and current physical count'});
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({source_status:'reviewed',source_close_note:'Reviewed new ledger and current physical count'});
    expect((await ctx.api.get('/api/inventory/direct-sale-audit').set(H())).body).toEqual([]);
    expect((await ctx.api.get('/api/inventory/direct-sale-audit?status=reviewed').set(H())).body[0].review.note)
      .toContain(`Physical count #${fresh.body.id}`);
    expect(await onHand(product)).toBe(2);
  });

  it('flags an older double stock-out, records a review without adjusting stock, and reopens on new evidence', async () => {
    const { product } = await productWithUnits('AUDIT-DIRECT', 3);
    const so = await saleOrder([{ name: 'AUDIT-DIRECT Product', item_id: product, quantity: 1, unit_price: 50 }]);
    await ctx.api.post(`/api/orders/${so}/accept-release`).set(H());
    const unit = (await ctx.api.get(`/api/finished-products/${product}/units`).set(H())).body[0];
    expect((await ctx.api.post(`/api/finished-products/${product}/units/allocate`).set(H())
      .send({ action: 'sell', unit_ids: [unit.id], order_id: so })).status).toBe(200);
    expect((await ctx.api.post(`/api/orders/${so}/release-slip`).set(H()).send({ collected_by: 'Driver' })).status).toBe(201);
    expect((await ctx.api.get('/api/inventory/direct-sale-audit').set(H())).body).toEqual([]);

    const { queryOne } = await import('../src/shared/db');
    const { applyStockChange } = await import('../src/modules/inventory/inventory-stock');
    const location = queryOne<{location_id:number}>(`SELECT location_id FROM inventory_transactions
      WHERE item_id=? AND reason=? ORDER BY id DESC LIMIT 1`, product, `Sold — ${(await getOrder(so)).number}`)!.location_id;
    const reason = `Sold — ${(await getOrder(so)).number}`;
    applyStockChange({itemId:product,locationId:location,change:-1,reason,userId:null});
    const stockAfterLegacy = await onHand(product);
    let rows = (await ctx.api.get('/api/inventory/direct-sale-audit').set(H())).body;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({order_id:so,item_id:product,shipped_quantity:1,removed_quantity:2,
      awaiting_slip_quantity:0,possible_extra_quantity:1,status:'open'});
    expect((await ctx.api.post(`/api/inventory/direct-sale-audit/${so}/${product}/review`).set(H())
      .send({evidence_hash:'0'.repeat(64),note:'Counted two units on the production shelf'})).status).toBe(409);
    const review = () => ctx.api.post(`/api/inventory/direct-sale-audit/${so}/${product}/review`).set(H())
      .send({evidence_hash:rows[0].evidence_hash,note:'Counted two units on the production shelf'});
    expect((await review()).status).toBe(200);
    expect((await review()).body.already_reviewed).toBe(true);
    expect(await onHand(product)).toBe(stockAfterLegacy);
    expect((await ctx.api.get('/api/inventory/direct-sale-audit?status=reviewed').set(H())).body[0].status).toBe('reviewed');
    applyStockChange({itemId:product,locationId:location,change:1,reason:'Count correction',userId:null});
    applyStockChange({itemId:product,locationId:location,change:-1,reason,userId:null});
    rows = (await ctx.api.get('/api/inventory/direct-sale-audit').set(H())).body;
    expect(rows[0]).toMatchObject({status:'open',possible_extra_quantity:2,review:{stale:true}});
  });
  it('deducts only remaining stock when a serialized unit was directly sold before the slip', async () => {
    const { product, codes } = await productWithUnits('DIRECT-SLIP', 3);
    const so = await saleOrder([{ name: 'DIRECT-SLIP Product', item_id: product, quantity: 3, unit_price: 50 }]);
    await ctx.api.post(`/api/orders/${so}/accept-release`).set(H());
    const units = (await ctx.api.get(`/api/finished-products/${product}/units`).set(H())).body;
    const direct = await ctx.api.post(`/api/finished-products/${product}/units/allocate`).set(H())
      .send({ action: 'sell', unit_ids: [units[0].id], order_id: so });
    expect(direct.status).toBe(200);
    expect(await onHand(product)).toBe(2);
    const pick = await ctx.api.post(`/api/orders/${so}/release`).set(H())
      .send({ codes: codes.filter((code) => code !== units[0].identifier) });
    expect(pick.status, JSON.stringify(pick.body)).toBe(200);
    const issue = () => ctx.api.post(`/api/orders/${so}/release-slip`).set(H())
      .set('Idempotency-Key', `direct-slip-${so}`).send({ collected_by: 'Driver' });
    const first = await issue();
    expect(first.status).toBe(201);
    expect((await issue()).status).toBe(201);
    expect(await onHand(product)).toBe(0);
    const issued = (await ctx.api.get(`/api/release-slips/${first.body.id}`).set(H())).body;
    expect(issued.items[0].unit_identifiers.split(', ')).toHaveLength(3);
  });

  it('refuses a trip manifest that omits a unit already sold directly', async () => {
    const { product } = await productWithUnits('DIRECT-OMIT', 1);
    const loose = await mkItem({ name: 'Direct omit loose part', quantity: 1 });
    const so = await saleOrder([
      { name: 'DIRECT-OMIT Product', item_id: product, quantity: 1, unit_price: 50 },
      { name: 'Direct omit loose part', item_id: loose, quantity: 1, unit_price: 10 },
    ]);
    const lines = (await getOrder(so)).items;
    const auth = await ctx.api.post(`/api/release-slips/orders/${so}/authorizations`).set(H())
      .send({ mode: 'pickup', recipient_name: 'Collector', partial_allowed: true });
    await ctx.api.post(`/api/orders/${so}/accept-release`).set(H());
    const unit = (await ctx.api.get(`/api/finished-products/${product}/units`).set(H())).body[0];
    expect((await ctx.api.post(`/api/finished-products/${product}/units/allocate`).set(H())
      .send({ action: 'sell', unit_ids: [unit.id], order_id: so })).status).toBe(200);
    expect((await ctx.api.post(`/api/orders/${so}/release`).set(H())
      .send({ bulk: [{ order_item_id: lines[1].id, item_id: loose, quantity: 1 }] })).status).toBe(200);
    const omitted = await ctx.api.post(`/api/orders/${so}/release-slip`).set(H())
      .send({ collected_by: 'Collector', authorization_token: auth.body.token,
        lines: [{ order_item_id: lines[1].id, quantity: 1 }] });
    expect(omitted.status).toBe(409);
    expect(omitted.body.code).toBe('direct_sale_required');
    expect(await onHand(product)).toBe(0);
    expect(await onHand(loose)).toBe(1);
    expect((await ctx.api.get(`/api/release-slips/orders/${so}/context`).set(H())).body.slips).toHaveLength(0);
  });

  it('issues a full slip for an accepted sale whose units were all sold directly', async () => {
    const { product } = await productWithUnits('DIRECT-FULL', 2);
    const so = await saleOrder([{ name: 'DIRECT-FULL Product', item_id: product, quantity: 2, unit_price: 50 }]);
    await ctx.api.post(`/api/orders/${so}/accept-release`).set(H());
    const units = (await ctx.api.get(`/api/finished-products/${product}/units`).set(H())).body;
    expect((await ctx.api.post(`/api/finished-products/${product}/units/allocate`).set(H())
      .send({ action: 'sell', unit_ids: units.map((u: { id: number }) => u.id), order_id: so })).status).toBe(200);
    expect(await onHand(product)).toBe(0);
    expect((await ctx.api.post(`/api/orders/${so}/status`).set(H()).send({ status: 'cancelled' })).body.code).toBe('already_shipped');
    expect((await ctx.api.delete(`/api/orders/${so}`).set(H())).body.code).toBe('already_shipped');
    const issued = await ctx.api.post(`/api/orders/${so}/release-slip`).set(H()).send({ collected_by: 'Driver' });
    expect(issued.status).toBe(201);
    expect(await onHand(product)).toBe(0);
    expect((await getOrder(so)).fulfilled_at).toBeTruthy();
    expect((await ctx.api.post(`/api/finished-products/${product}/units/allocate`).set(H())
      .send({ action: 'sell', unit_ids: units.map((u: { id: number }) => u.id), order_id: so })).body.code).toBe('already_shipped');
  });

  it('keeps a direct stock-out with the shipped portion of a partial sale', async () => {
    const { product } = await productWithUnits('DIRECT-PARTIAL', 2);
    const so = await saleOrder([{ name: 'DIRECT-PARTIAL Product', item_id: product, quantity: 2, unit_price: 50 }]);
    const authorization = await ctx.api.post(`/api/release-slips/orders/${so}/authorizations`).set(H())
      .send({ mode: 'pickup', recipient_name: 'Collector', partial_allowed: true });
    expect(authorization.status).toBe(201);
    await ctx.api.post(`/api/orders/${so}/accept-release`).set(H());
    const units = (await ctx.api.get(`/api/finished-products/${product}/units`).set(H())).body;
    expect((await ctx.api.post(`/api/finished-products/${product}/units/allocate`).set(H())
      .send({ action: 'sell', unit_ids: [units[0].id], order_id: so })).status).toBe(200);
    expect(await onHand(product)).toBe(1);
    const cancel = await ctx.api.post(`/api/orders/${so}/cancel-remainder`).set(H())
      .send({ reason: 'Customer changed order', expected_revision: (await getOrder(so)).revision });
    expect(cancel.body.code).toBe('direct_sale_required');
    const slip = await ctx.api.post(`/api/orders/${so}/release-slip`).set(H())
      .send({ collected_by: 'Collector', authorization_token: authorization.body.token });
    expect(slip.status, JSON.stringify(slip.body)).toBe(201);
    expect(slip.body.backorder).toBeNull();
    expect(await onHand(product)).toBe(1);
    expect((await getOrder(so)).items[0].quantity).toBe(2);
    expect((await getOrder(so)).items[0].dispatched_qty).toBe(1);
    expect(slip.body.remaining).toBe(1);
    expect((await ctx.api.post(`/api/finished-products/${product}/units/allocate`).set(H())
      .send({ action: 'sell', unit_ids: [units[1].id], order_id: so })).status).toBe(200);
    const secondAuthorization = await ctx.api.post(`/api/release-slips/orders/${so}/authorizations`).set(H())
      .send({ mode: 'pickup', recipient_name: 'Collector', partial_allowed: false });
    expect(secondAuthorization.status).toBe(201);
    const next = await ctx.api.post(`/api/orders/${so}/release-slip`).set(H())
      .send({ collected_by: 'Collector', previous_slip_id: slip.body.id, authorization_token: secondAuthorization.body.token });
    expect(next.status, JSON.stringify(next.body)).toBe(201);
    expect(await onHand(product)).toBe(0);
    expect((await getOrder(so)).items[0].dispatched_qty).toBe(2);
  });
  it('ships repeated SKU lines once as one stock pool while preserving both slip lines', async () => {
    const raw = await mkItem({ name: 'Shared SKU, two prices', quantity: 10, unit_cost: 4 });
    const so = await saleOrder([
      { name: 'Shared SKU, two prices', item_id: raw, quantity: 1, unit_price: 20 },
      { name: 'Shared SKU, two prices', item_id: raw, quantity: 2, unit_price: 18 },
    ]);
    const lines = (await getOrder(so)).items;
    expect((await ctx.api.post(`/api/orders/${so}/accept-release`).set(H())).status).toBe(200);
    expect((await ctx.api.post(`/api/orders/${so}/release`).set(H()).send({ bulk: [
      { item_id: raw, order_item_id: lines[0].id, quantity: 1 },
      { item_id: raw, order_item_id: lines[1].id, quantity: 2 },
    ] })).status).toBe(200);
    const issued = await ctx.api.post(`/api/orders/${so}/release-slip`).set(H()).send({ collected_by: 'Driver' });
    expect(issued.status).toBe(201);
    expect(await onHand(raw)).toBe(7);
    const slip = (await ctx.api.get(`/api/release-slips/${issued.body.id}`).set(H())).body;
    expect(slip.items.map((l: { order_item_id: number; quantity: number }) => [l.order_item_id, l.quantity]))
      .toEqual([[lines[0].id, 1], [lines[1].id, 2]]);
  });
  it('allows early dispatch but blocks delivered and sale completion until physical goods have a release slip', async () => {
    const raw = await mkItem({ name: 'Delivery release guard', quantity: 2 });
    const so = await saleOrder([{ name: 'Delivery release guard', item_id: raw, quantity: 2, unit_price: 20 }]);
    const rel = await createEmployee(ctx.api, token, { role: 'releasing' });
    const delivery = (await ctx.api.post('/api/deliveries').set(H())
      .send({ order_id: so, assigned_to: rel.id })).body.id;
    const earlyDispatch = await ctx.api.post(`/api/deliveries/${delivery}/status`).set(bearer(rel.token)).send({ status: 'out_for_delivery' });
    expect(earlyDispatch.status).toBe(200);
    const earlyProof = await ctx.api.post(`/api/deliveries/${delivery}/complete`).set(bearer(rel.token))
      .send({ outcome: 'delivered', recipient: 'Customer' });
    expect(earlyProof.status).toBe(409);
    expect(earlyProof.body.code).toBe('release_required');
    for (const body of [{ status: 'completed' }, { status: 'completed', force: true }]) {
      const blocked = await ctx.api.post(`/api/orders/${so}/status`).set(H()).send(body);
      expect(blocked.status).toBe(409);
      expect(blocked.body.code).toBe('release_required');
    }
    const edit = await ctx.api.put(`/api/orders/${so}`).set(H()).send({ status: 'completed' });
    expect(edit.status).toBe(409);
    expect(edit.body.code).toBe('release_required');
    expect(await onHand(raw)).toBe(2);
    await ctx.api.post(`/api/orders/${so}/accept-release`).set(H());
    await ctx.api.post(`/api/orders/${so}/release`).set(H()).send({ bulk: [{ item_id: raw, quantity: 2 }] });
    expect((await ctx.api.post(`/api/orders/${so}/release-slip`).set(H())
      .send({ collected_by: 'Customer' })).status).toBe(201);
    expect((await ctx.api.post(`/api/deliveries/${delivery}/status`).set(bearer(rel.token))
      .send({ status: 'out_for_delivery' })).status).toBe(200);
    const optionalProof = await ctx.api.post(`/api/deliveries/${delivery}/complete`).set(bearer(rel.token))
      .send({ outcome: 'delivered' });
    expect(optionalProof.status).toBe(200);
    expect((await ctx.api.post(`/api/orders/${so}/status`).set(H())
      .send({ status: 'completed' })).status).toBe(200);
    expect(await onHand(raw)).toBe(0);
  });

  it('records a failed pre-slip trip with a reason and no stock movement', async () => {
    const raw = await mkItem({ name: 'Failed early trip stock', quantity: 1 });
    const so = await saleOrder([{ name: 'Failed early trip stock', item_id: raw, quantity: 1, unit_price: 10 }]);
    const rel = await createEmployee(ctx.api, token, { role: 'releasing' });
    const delivery = (await ctx.api.post('/api/deliveries').set(H()).send({ order_id: so, assigned_to: rel.id })).body.id;
    expect((await ctx.api.post(`/api/deliveries/${delivery}/status`).set(bearer(rel.token)).send({ status: 'out_for_delivery' })).status).toBe(200);
    expect((await ctx.api.post(`/api/deliveries/${delivery}/complete`).set(bearer(rel.token)).send({ outcome: 'failed' })).status).toBe(400);
    expect((await ctx.api.post(`/api/deliveries/${delivery}/complete`).set(bearer(rel.token)).send({ outcome: 'failed', note: 'Collection rescheduled' })).status).toBe(200);
    expect(await onHand(raw)).toBe(1);
    expect((await ctx.api.get(`/api/release-slips/orders/${so}/context`).set(H())).body.slip).toBeNull();
  });

  it('replays a lost slip response without another stock movement', async () => {
    const raw = await mkItem({ name: 'Slip response loss stock', quantity: 1 });
    const so = await saleOrder([{ name: 'Slip response loss stock', item_id: raw, quantity: 1, unit_price: 20 }]);
    await ctx.api.post(`/api/orders/${so}/accept-release`).set(H());
    await ctx.api.post(`/api/orders/${so}/release`).set(H()).send({ bulk: [{ item_id: raw, quantity: 1 }] });
    const request = () => ctx.api.post(`/api/orders/${so}/release-slip`).set(H())
      .set('Idempotency-Key', `slip-response-loss-${so}`).send({ collected_by: 'Driver' });
    const first = await request();
    const retry = await request();
    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.headers['idempotency-replayed']).toBe('true');
    expect(retry.body.id).toBe(first.body.id);
    expect(await onHand(raw)).toBe(0);
    const context = await ctx.api.get(`/api/release-slips/orders/${so}/context`).set(H());
    expect(context.body.slip.id).toBe(first.body.id);
  });

  it('rolls back the slip, order and stock together when stock posting fails', async () => {
    const raw = await mkItem({ name: 'Atomic release widget', quantity: 2 });
    const so = await saleOrder([{ name: 'Atomic release widget', item_id: raw, quantity: 2, unit_price: 10 }]);
    await ctx.api.post(`/api/orders/${so}/accept-release`).set(H());
    await ctx.api.post(`/api/orders/${so}/release`).set(H()).send({ bulk: [{ item_id: raw, quantity: 2 }] });
    const { db } = await import('../src/shared/db');
    db.exec(`CREATE TRIGGER fail_atomic_release BEFORE INSERT ON inventory_transactions
      WHEN NEW.item_id = ${raw} BEGIN SELECT RAISE(ABORT, 'stock posting fixture failure'); END`);
    try {
      const failed = await ctx.api.post(`/api/orders/${so}/release-slip`).set(H()).send({ collected_by: 'Juan' });
      expect(failed.status).toBe(500);
      const order = await getOrder(so);
      expect(order.status).toBe('released');
      expect(order.fulfilled_at).toBeNull();
      expect(order.release_slip_id).toBeNull();
      expect(await onHand(raw)).toBe(2);
    } finally {
      db.exec('DROP TRIGGER fail_atomic_release');
    }
    const retry = await ctx.api.post(`/api/orders/${so}/release-slip`).set(H()).send({ collected_by: 'Juan' });
    expect(retry.status).toBe(201);
    expect(await onHand(raw)).toBe(0);
  });

  it('refuses a slip if warehouse stock changed after allocation', async () => {
    const raw = await mkItem({ name: 'S0 Widget', quantity: 2 });
    const so = await saleOrder([{ name: 'S0 Widget', item_id: raw, quantity: 2, unit_price: 10 }]);
    await ctx.api.post(`/api/orders/${so}/accept-release`).set(H());
    expect((await ctx.api.post(`/api/orders/${so}/release`).set(H())
      .send({ bulk: [{ item_id: raw, quantity: 2 }] })).status).toBe(200);
    expect((await ctx.api.post(`/api/inventory/${raw}/adjust`).set(H())
      .send({ change: -1, reason: 'Count correction' })).status).toBe(200);
    const slip = await ctx.api.post(`/api/orders/${so}/release-slip`).set(H()).send({ collected_by: 'Juan' });
    expect(slip.status).toBe(409);
    expect(slip.body.blocked).toBe('stock_changed');
    expect((await getOrder(so)).release_slip_id).toBeNull();
    expect(await onHand(raw)).toBe(1);
  });

  it('is refused until every line is released', async () => {
    const raw = await mkItem({ name: 'S1 Widget', quantity: 20 });
    const so = await saleOrder([{ name: 'S1 Widget', item_id: raw, quantity: 5, unit_price: 10 }]);
    await ctx.api.post(`/api/orders/${so}/accept-release`).set(H());
    await ctx.api.post(`/api/orders/${so}/release`).set(H()).send({ bulk: [{ item_id: raw, quantity: 3 }] });
    const r = await ctx.api.post(`/api/orders/${so}/release-slip`).set(H()).send({ collected_by: 'Juan' });
    expect(r.status).toBe(409);
  });

  it('records what left, confirms the order and draws stock down with the ledger off', async () => {
    const { product, codes } = await productWithUnits('S2', 2);
    const bulk = await mkItem({ name: 'S2 Cable', quantity: 40 });
    const productBefore = await onHand(product);
    const so = await saleOrder([
      { name: 'S2 Product', item_id: product, quantity: 2, unit_price: 100 },
      { name: 'S2 Cable', item_id: bulk, quantity: 6, unit_price: 5 },
      { name: 'Installation', quantity: 1, unit_price: 500 },   // free-text: nothing physical
    ]);
    await ctx.api.post(`/api/orders/${so}/accept-release`).set(H());
    await ctx.api.post(`/api/orders/${so}/release`).set(H()).send({ codes, bulk: [{ item_id: bulk, quantity: 6 }] });
    expect((await getOrder(so)).status).toBe('released');
    expect(await onHand(bulk)).toBe(40);                         // release alone moves nothing

    const noName = await ctx.api.post(`/api/orders/${so}/release-slip`).set(H()).send({});
    expect(noName.status).toBe(400);

    const r = await ctx.api.post(`/api/orders/${so}/release-slip`).set(H())
      .send({ collected_by: 'Juan Dela Cruz', vehicle_plate: 'ABC 1234', notes: 'Gate 2' });
    expect(r.status).toBe(201);
    expect(r.body.order.status).toBe('confirmed');
    expect(await onHand(bulk)).toBe(34);                         // stock out at the slip
    expect(await onHand(product)).toBe(productBefore - 2);
    const units = (await ctx.api.get(`/api/finished-products/${product}/units?status=all`).set(H())).body;
    expect(units.every((u: { status: string }) => u.status === 'sold')).toBe(true);

    const slip = (await ctx.api.get(`/api/release-slips/${r.body.id}`).set(H())).body;
    expect(slip.number).toMatch(/^RS-/);
    expect(slip.collected_by).toBe('Juan Dela Cruz');
    expect(slip.items).toHaveLength(2);                          // the free-text line is left off
    const unitLine = slip.items.find((i: { item_id: number }) => i.item_id === product);
    expect(unitLine.unit_identifiers).toBe(`${codes[0]}, ${codes[1]}`);
    expect((await getOrder(so)).release_slip_number).toBe(slip.number);

    // one slip per order, no un-picking after the goods left, and off the queue
    expect((await ctx.api.post(`/api/orders/${so}/release-slip`).set(H()).send({ collected_by: 'X' })).status).toBe(409);
    expect((await ctx.api.post(`/api/orders/${so}/release/unreserve`).set(H())
      .send({ bulk: [{ item_id: bulk, quantity: 1 }] })).status).toBe(409);
    const q = await queue();
    expect([...q.to_accept, ...q.releasing].some((o) => o.id === so)).toBe(false);
    const list = (await ctx.api.get('/api/release-slips?q=Juan').set(H())).body;
    expect(list.some((s: { id: number }) => s.id === r.body.id)).toBe(true);
  });

  it('refuses to cancel, reopen or delete a slipped sale and preserves stock-out', async () => {
    const raw = await mkItem({ name: 'S3 Widget', quantity: 10 });
    const so = await saleOrder([{ name: 'S3 Widget', item_id: raw, quantity: 4, unit_price: 10 }]);
    await ctx.api.post(`/api/orders/${so}/accept-release`).set(H());
    await ctx.api.post(`/api/orders/${so}/release`).set(H()).send({ bulk: [{ item_id: raw, quantity: 4 }] });
    await ctx.api.post(`/api/orders/${so}/release-slip`).set(H()).send({ collected_by: 'Pedro' });
    expect(await onHand(raw)).toBe(6);
    const cancel = await ctx.api.post(`/api/orders/${so}/status`).set(H()).send({ status: 'cancelled' });
    expect(cancel.status).toBe(409);
    expect(cancel.body.code).toBe('already_shipped');
    const reopen = await ctx.api.put(`/api/orders/${so}`).set(H()).send({ status: 'open' });
    expect(reopen.status).toBe(409);
    expect(reopen.body.code).toBe('already_shipped');
    const remove = await ctx.api.delete(`/api/orders/${so}`).set(H());
    expect(remove.status).toBe(409);
    expect(remove.body.code).toBe('already_shipped');
    expect(await onHand(raw)).toBe(6);
  });

  it('refuses direct confirmation of physical stock without a slip', async () => {
    const raw = await mkItem({ name: 'S4 Widget', quantity: 10 });
    const so = await saleOrder([{ name: 'S4 Widget', item_id: raw, quantity: 3, unit_price: 10 }]);
    const blocked = await ctx.api.post(`/api/orders/${so}/status`).set(H()).send({ status: 'confirmed' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('release_required');
    expect(await onHand(raw)).toBe(10);
  });
});

describe('releasing_clerk on the slip flow', () => {
  it('can accept, release, issue the slip and attach photos', async () => {
    const clerk = await createEmployee(ctx.api, token, { role: 'releasing_clerk' });
    const raw = await mkItem({ name: 'C1 Widget', quantity: 10 });
    const so = await saleOrder([{ name: 'C1 Widget', item_id: raw, quantity: 2, unit_price: 10 }]);
    const C = bearer(clerk.token);

    expect((await ctx.api.post(`/api/orders/${so}/accept-release`).set(C)).status).toBe(200);
    expect((await ctx.api.post(`/api/orders/${so}/release`).set(C).send({ bulk: [{ item_id: raw, quantity: 2 }] })).status).toBe(200);
    const slip = await ctx.api.post(`/api/orders/${so}/release-slip`).set(C).send({ collected_by: 'Driver' });
    expect(slip.status).toBe(201);

    const up = await ctx.api.post('/api/attachments').set(C)
      .field('kind', 'release').field('ref_id', String(slip.body.id)).attach('image', PNG, 'out.png');
    expect(up.status).toBe(201);
    const photos = (await ctx.api.get(`/api/attachments?kind=release&ref_id=${slip.body.id}`).set(H())).body;
    expect(photos).toHaveLength(1);
    expect((await ctx.api.get(`/api/release-slips/${slip.body.id}`).set(C)).body.photo_count).toBe(1);
    expect((await ctx.api.delete(`/api/attachments/${up.body.id}`).set(C)).status).toBe(409);
  });
});
