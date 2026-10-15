import { beforeAll, afterAll, it, expect } from 'vitest';
import { setupApp, cleanup, login, type TestContext } from './helpers';
let ctx: TestContext, token: string, product: number, mo: number, loc: number, batch: {
    id: number;
    number: string;
};
const H = () => ({ Authorization: `Bearer ${token}` });
beforeAll(async () => {
    ctx = await setupApp();
    token = await login(ctx.api);
    product = (await ctx.api.post('/api/inventory').set(H()).send({ name: 'QR batch product', sku: 'QR-PROD' })).body.id;
    const part = (await ctx.api.post('/api/inventory').set(H()).send({ name: 'QR component', quantity: 100 })).body.id;
    await ctx.api.put(`/api/finished-products/${product}`).set(H()).send({ components: [{ component_item_id: part, quantity: 1 }] });
    mo = (await ctx.api.post('/api/job-orders').set(H()).send({ product_item_id: product, qty_ordered: 20, qc_stages: 0 })).body.id;
    await ctx.api.post(`/api/job-orders/${mo}/approve`).set(H());
    await ctx.api.post('/api/job-orders/warehouse-accept').set(H()).send({ job_order_ids: [mo] });
    await ctx.api.post('/api/job-orders/prepare').set(H()).send({ job_orders: [{ id: mo }] });
    await ctx.api.post(`/api/job-orders/${mo}/release`).set(H());
    await ctx.api.post(`/api/job-orders/${mo}/accept`).set(H());
    expect((await ctx.api.post(`/api/job-orders/${mo}/progress`).set(H()).send({ done_delta: 10 })).status).toBe(200);
    expect((await ctx.api.post(`/api/job-orders/${mo}/progress`).set(H()).send({ done_delta: 10 })).status).toBe(200);
    const rec = (await ctx.api.get(`/api/job-orders/${mo}/receivable`).set(H())).body;
    loc = rec.output_location_id;
    batch = rec.batches[0];
    expect((await ctx.api.post(`/api/job-orders/${mo}/products-in`).set(H()).set('Idempotency-Key', 'batch-receive-exact').send({ location_id: loc, batch_id: batch.id, quantity: 10 })).status).toBe(201);
    expect((await ctx.api.post(`/api/job-orders/${mo}/products-in`).set(H()).send({location_id:loc,batch_id:rec.batches[1].id,quantity:10})).status).toBe(201);
});
afterAll(() => cleanup(ctx));
async function sale(qty: number, mode = 'assembled', location = loc) {
    const r = await ctx.api.post('/api/orders').set(H()).send({ type: 'sale', customer_name: 'Batch customer', location_id: location, status: 'open', items: [{ item_id: product, name: 'QR batch product', quantity: qty, unit_price: 10, fulfillment_mode: mode }] });
    expect(r.status).toBe(201);
    // Deliberately allow adversarial shortage/build fixtures to reach release validation.
    const { run } = await import('../src/shared/db');
    run("UPDATE orders SET status='approved' WHERE id=?", r.body.id);
    await ctx.api.post(`/api/orders/${r.body.id}/accept-release`).set(H());
    return r.body.id as number;
}
async function lookup() { return (await ctx.api.get('/api/inventory/lookup').query({ code: batch.number }).set(H())).body; }
it('identifies the batch, reserves its exact quantity once, and releases the reservation on undo', async () => {
    const so = await sale(3);
    const preview = await ctx.api.get(`/api/release-slips/orders/${so}/unit`).query({ code: batch.number }).set(H());
    expect((await ctx.api.get('/api/inventory/lookup').query({code:'VDS:BATCH:'+batch.id}).set(H())).body.batch.id).toBe(batch.id);
    expect((await ctx.api.get(`/api/release-slips/orders/${so}/unit`).query({code:'VDS:BATCH:'+batch.id}).set(H())).body.batch.id).toBe(batch.id);
    expect(preview.body).toMatchObject({ state: 'batch_available', batch: { id: batch.id, available: 3, product_item_id: product } });
    const path = `/api/orders/${so}/release`, body = { bulk: [{ item_id: product, batch_id: batch.id, quantity: 3 }] };
    expect((await ctx.api.post(path).set(H()).set('Idempotency-Key', 'batch-pick-exact').send(body)).status).toBe(200);
    expect((await ctx.api.post(path).set(H()).set('Idempotency-Key', 'batch-pick-exact').send(body)).status).toBe(200);
    expect((await lookup()).batch.balances).toEqual([expect.objectContaining({ on_hand: 10, reserved: 3, available: 7 })]);
    const c = (await ctx.api.get(`/api/release-slips/orders/${so}/context`).set(H())).body;
    expect(c.batch_allocations).toHaveLength(1);
    expect((await ctx.api.post(`/api/orders/${so}/release/unreserve`).set(H()).send({ bulk: [{ item_id: product, quantity: 3 }] })).status).toBe(200);
    expect((await lookup()).batch.balances[0]).toMatchObject({ on_hand: 10, reserved: 0, available: 10 });
});
it('refuses wrong build, wrong location, repeated batch entries and excess quantity without reserving stock', async () => {
    const semi = await sale(1, 'semi_built');
    expect((await ctx.api.post(`/api/orders/${semi}/release`).set(H()).send({ bulk: [{ item_id: product, batch_id: batch.id, quantity: 1 }] })).status).toBe(409);
    const other = (await ctx.api.post('/api/locations').set(H()).send({ name: 'QR other warehouse', type: 'warehouse' })).body.id;
    const away = await sale(1, 'assembled', other);
    expect((await ctx.api.get(`/api/release-slips/orders/${away}/unit`).query({ code: batch.number }).set(H())).body.state).toBe('batch_unavailable');
    expect((await ctx.api.post(`/api/orders/${away}/release`).set(H()).send({ bulk: [{ item_id: product, batch_id: batch.id, quantity: 1 }] })).status).toBe(409);
    const so = await sale(20);
    expect((await ctx.api.post(`/api/orders/${so}/release`).set(H()).send({ bulk: [{ item_id: product, batch_id: batch.id, quantity: 6 }, { item_id: product, batch_id: batch.id, quantity: 6 }] })).status).toBe(409);
    expect((await lookup()).batch.balances[0].reserved).toBe(0);
    // Remove unfulfilled test demand so later availability checks are independent.
    const { run } = await import('../src/shared/db');
    run("UPDATE orders SET status='cancelled' WHERE id IN (?,?,?)", semi, away, so);
});
it('keeps reservations through stock adjustment, ships the same batch, reverses it and transfers its identity', async () => {
    const so = await sale(2);
    expect((await ctx.api.post(`/api/orders/${so}/release`).set(H()).send({ bulk: [{ item_id: product, batch_id: batch.id, quantity: 2 }] })).status).toBe(200);
    expect((await ctx.api.post(`/api/inventory/${product}/adjust`).set(H()).send({ location_id: loc, change: -19, reason: 'Cannot remove held lots' })).status).toBe(409);
    const { db } = await import('../src/shared/db');
    const { shipBatches } = await import('../src/modules/inventory/batch-stock');
    db.exec('BEGIN');
    expect(shipBatches(so, product, true)).toBe(2);
    db.exec('COMMIT');
    expect((await lookup()).batch.balances[0]).toMatchObject({ on_hand: 8, reserved: 0, available: 8 });
    db.exec('BEGIN');
    expect(shipBatches(so, product, false)).toBe(2);
    db.exec('COMMIT');
    expect((await lookup()).batch.balances[0]).toMatchObject({ on_hand: 10, reserved: 2, available: 8 });
    await ctx.api.post(`/api/orders/${so}/release/unreserve`).set(H()).send({ bulk: [{ item_id: product, quantity: 2 }] });
    const dest = (await ctx.api.post('/api/locations').set(H()).send({ name: 'QR destination', type: 'warehouse' })).body.id;
    expect((await ctx.api.post(`/api/inventory/${product}/transfer`).set(H()).send({ from_location_id: loc, to_location_id: dest, amount: 4 })).status).toBe(200);
    expect((await lookup()).batch.balances).toEqual(expect.arrayContaining([expect.objectContaining({ location_id: loc, on_hand: 6 }), expect.objectContaining({ location_id: dest, on_hand: 4 })]));
});
it('atomically consumes the reserved batch on warehouse-out and shows its sale in QR lookup', async () => {
    const so = await sale(1);
    expect((await ctx.api.post(`/api/orders/${so}/release`).set(H()).send({ bulk: [{ item_id: product, batch_id: batch.id, quantity: 1 }] })).status).toBe(200);
    const before = (await lookup()).batch.balances.find((b: any) => b.location_id === loc).on_hand;
    const auth = await ctx.api.post(`/api/release-slips/orders/${so}/authorizations`).set(H()).send({ mode: 'pickup', recipient_name: 'Batch recipient' });
    expect(auth.status).toBe(201);
    const handoff = { collected_by: 'Batch recipient', authorization_token: auth.body.token, acknowledged: true, seal_tag: 'BATCH-TAG' };
    const slip = await ctx.api.post(`/api/orders/${so}/release-slip`).set(H()).set('Idempotency-Key', 'batch-final-handoff').send(handoff);
    expect(slip.status, JSON.stringify(slip.body)).toBe(201);
    const after = await lookup();
    expect(after.batch.balances.find((b: any) => b.location_id === loc).on_hand).toBe(before - 1);
    expect(after.batch.allocations).toEqual(expect.arrayContaining([expect.objectContaining({ quantity: 1, state: 'shipped' })]));
    expect((await ctx.api.post(`/api/orders/${so}/release-slip`).set(H()).set('Idempotency-Key', 'batch-final-handoff').send(handoff)).status).toBe(201);
    expect((await lookup()).batch.balances.find((b: any) => b.location_id === loc).on_hand).toBe(before - 1);
    const issued=(await ctx.api.get(`/api/release-slips/${slip.body.id}`).set(H())).body;
    const proof=await ctx.api.post('/api/attachments').set(H()).field('kind','sales_return_proof').field('ref_id',String(slip.body.id)).attach('image',Buffer.from('batch return photo'),'return.png');
    expect(proof.status).toBe(201);
    const returned=await ctx.api.post('/api/sales-returns').set(H()).send({slip_id:slip.body.id,slip_item_id:issued.items[0].id,quantity:1,reason:'Batch unit returned unopened',evidence_ids:[proof.body.id]});
    expect(returned.status).toBe(201);expect(returned.body.batch_id).toBe(batch.id);
    expect((await ctx.api.post(`/api/sales-returns/${returned.body.id}/inspect`).set(H()).send({decision:'restock',condition_note:'Verified original lot sticker and condition',location_id:loc})).status).toBe(200);
    expect((await lookup()).batch.balances.find((b:any)=>b.location_id===loc).on_hand).toBe(before);
});
it('requires a current verified count within warehouse stock for legacy reconciliation', async () => {
    const info = await lookup(), balance = info.batch.balances.find((b: any) => b.location_id === loc);
    const path = `/api/rts/batches/${batch.id}/count`, body = { location_id: loc, quantity: balance.on_hand, expected_quantity: balance.on_hand, reason: 'Physical lot counted against attached stickers' };
    expect((await ctx.api.post(path).set(H()).send({ ...body, quantity: 1000 })).status).toBe(409);
    expect((await ctx.api.post(`/api/inventory/${product}/adjust`).set(H()).send({location_id:loc,change:2,reason:'Other untracked stock'})).status).toBe(200);
    expect((await ctx.api.post(path).set(H()).send({...body,quantity:balance.on_hand+1})).status).toBe(409);
    expect((await ctx.api.post(path).set(H()).send({ ...body, expected_quantity: 999 })).status).toBe(409);
    expect((await ctx.api.post(path).set(H()).send(body)).status).toBe(200);
    expect((await lookup()).batch.balances.find((b: any) => b.location_id === loc).on_hand).toBe(balance.on_hand);
    const { queryOne } = await import('../src/shared/db');
    expect(queryOne<{
        n: number;
    }>('SELECT COUNT(*) AS n FROM production_batch_counts WHERE batch_id=?', batch.id)?.n).toBe(1);
});

it('permits an exact non-serialized batch when the product also has serialized history', async()=>{
  const {run}=await import('../src/shared/db');
  // A unit from another run must not change the identity of this non-serialized lot.
  const serializedJob=(await ctx.api.post('/api/job-orders').set(H()).send({product_item_id:product,qty_ordered:1,qc_stages:1})).body.id;
  run("INSERT INTO job_order_units(job_order_id,product_item_id,identifier,status) VALUES(?,?,?,'passed')",serializedJob,product,'OTHER-SERIAL-HISTORY');
  const so=await sale(1);
  expect((await ctx.api.post(`/api/orders/${so}/release`).set(H()).send({bulk:[{item_id:product,quantity:1}]})).status).toBe(409);
  const exact=await ctx.api.post(`/api/orders/${so}/release`).set(H()).send({bulk:[{item_id:product,batch_id:batch.id,quantity:1}]});
  expect(exact.status,JSON.stringify(exact.body)).toBe(200);
  expect((await ctx.api.get(`/api/release-slips/orders/${so}/context`).set(H())).body.batch_allocations).toEqual([expect.objectContaining({batch_id:batch.id,quantity:1})]);
});

it('resolves a batch QR against the physical CKD component line',async()=>{
  const parent=(await ctx.api.post('/api/inventory').set(H()).send({name:'QR CKD parent'})).body.id;
  await ctx.api.put(`/api/finished-products/${parent}`).set(H()).send({components:[{component_item_id:product,quantity:1}]});
  const sale=await ctx.api.post('/api/orders').set(H()).send({type:'sale',customer_name:'CKD batch buyer',location_id:loc,items:[{item_id:parent,name:'QR kit',quantity:1,unit_price:20,fulfillment_mode:'ckd'}]});
  expect(sale.status).toBe(201);
  const {run}=await import('../src/shared/db');run("UPDATE orders SET status='approved' WHERE id=?",sale.body.id);
  await ctx.api.post(`/api/orders/${sale.body.id}/accept-release`).set(H());
  const preview=await ctx.api.get(`/api/release-slips/orders/${sale.body.id}/unit`).query({code:'VDS:BATCH:'+batch.id}).set(H());
  expect(preview.body.state,JSON.stringify(preview.body)).toBe('batch_available');
  const {queryOne}=await import('../src/shared/db');const serial=queryOne<{id:number}>("SELECT id FROM job_order_units WHERE product_item_id=? AND identifier='OTHER-SERIAL-HISTORY'",product)!;
  expect((await ctx.api.get(`/api/release-slips/orders/${sale.body.id}/unit`).query({code:'VDS:UNIT:'+serial.id}).set(H())).body.state).toBe('unavailable');
  expect((await ctx.api.post(`/api/orders/${sale.body.id}/release`).set(H()).send({bulk:[{item_id:product,batch_id:batch.id,quantity:1}]})).status).toBe(200);
});
