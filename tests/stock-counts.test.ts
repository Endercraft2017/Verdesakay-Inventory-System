import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, addSerializedUnits, type TestContext } from './helpers';

let ctx:TestContext;
let admin:string;
let warehouse:string;
const H=(token:string)=>({Authorization:`Bearer ${token}`});
beforeAll(async()=>{
  ctx=await setupApp();
  admin=await login(ctx.api);
  warehouse=(await createEmployee(ctx.api,admin,{role:'warehouse'})).token;
});
afterAll(()=>cleanup(ctx));
const item=async(name:string,quantity=0)=>(await ctx.api.post('/api/inventory').set(H(admin)).send({name,quantity})).body.id as number;
const context=async(id:number,location=1,mode='assembled')=>(await ctx.api.get(
  `/api/inventory/stock-counts/context?item_id=${id}&location_id=${location}&build_mode=${mode}`).set(H(warehouse))).body;
const submit=async(c:any,changes:Record<string,unknown>={})=>ctx.api.post('/api/inventory/stock-counts').set(H(warehouse)).send({
  item_id:c.item_id,location_id:c.location_id,build_mode:c.build_mode,expected_quantity:c.book_quantity,
  expected_serial_ids:c.serials.map((s:any)=>s.id),
  expected_batches:c.batches.map((b:any)=>({batch_id:b.batch_id,quantity:b.quantity})),
  counted_untracked:c.untracked_quantity,
  counted_serial_codes:c.serials.map((s:any)=>s.code),
  counted_batches:c.batches.map((b:any)=>({batch_id:b.batch_id,quantity:b.quantity})),
  note:'Counted the exact warehouse shelf',...changes,
});

describe('physical stock count',()=>{
  it('closes a linked discrepancy only after reconciliation and preserves the count reference on retry',async()=>{
    const itemId=await item('Discrepancy shelf item',5);
    const {run,queryOne}=await import('../src/shared/db');
    const source=Number(run(`INSERT INTO stock_discrepancies(item_id,location_id,change,location_balance_after,reason)
      VALUES(?,?,?,?,?)`,itemId,1,-1,5,'Offline stock-out needs verification').lastInsertRowid);
    const c=await context(itemId);
    const created=await submit(c,{source_kind:'discrepancy',source_id:source,counted_untracked:4});
    expect(created.status).toBe(201);
    const path=`/api/inventory/stock-counts/${created.body.id}`;
    const close=(token:string,note='Verified physical shelf and corrected one missing item')=>
      ctx.api.post(`${path}/close-source`).set(H(token)).send({note});
    expect((await close(admin)).status).toBe(409);
    expect((await ctx.api.post(`${path}/approve`).set(H(admin)).send({note:'Approved exact shelf observation'})).status).toBe(200);
    expect((await close(admin)).status).toBe(409);
    expect((await ctx.api.post(`${path}/apply`).set(H(admin)).send({})).status).toBe(200);
    expect((await ctx.api.post(`${path}/close-source`).send({note:'Verified physical shelf and corrected one missing item'})).status).toBe(401);
    expect((await close(admin)).body).toMatchObject({source_status:'resolved',source_close_note:'Verified physical shelf and corrected one missing item'});
    expect((await close(admin)).status).toBe(200);
    expect((await close(admin,'Different later decision')).status).toBe(409);
    const resolution=queryOne<{resolution_note:string;status:string}>(
      'SELECT resolution_note,status FROM stock_discrepancies WHERE id=?',source)!;
    expect(resolution).toMatchObject({status:'resolved',resolution_note:`Physical count #${created.body.id}: Verified physical shelf and corrected one missing item`});
    expect((await ctx.api.get(`/api/inventory/${itemId}`).set(H(admin))).body.quantity).toBe(4);
    expect((await submit(await context(itemId),{source_kind:'discrepancy',source_id:source})).status).toBe(409);
  });

  it('requires current physical evidence before linked issue closure',async()=>{
    const itemId=await item('Moving discrepancy item',3);
    const {run}=await import('../src/shared/db');
    const source=Number(run(`INSERT INTO stock_discrepancies(item_id,location_id,change,location_balance_after,reason)
      VALUES(?,?,?,?,?)`,itemId,1,-1,3,'Offline count finding').lastInsertRowid);
    const created=await submit(await context(itemId),{source_kind:'discrepancy',source_id:source,counted_untracked:2});
    const path=`/api/inventory/stock-counts/${created.body.id}`;
    await ctx.api.post(`${path}/approve`).set(H(admin)).send({note:'Approved after physical verification'});
    await ctx.api.post(`${path}/apply`).set(H(admin)).send({});
    await ctx.api.post(`/api/inventory/${itemId}/adjust`).set(H(admin)).send({change:1,reason:'A new box arrived'});
    const blocked=await ctx.api.post(`${path}/close-source`).set(H(admin))
      .send({note:'I reviewed the corrected shelf count'});
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('stale_count');
    expect((await ctx.api.get('/api/inventory/discrepancies').set(H(admin))).body
      .some((d:any)=>d.id===source)).toBe(true);
  });

  it('records a count, requires an independent reviewer, and applies only its untracked variance once',async()=>{
    const id=await item('Counted bolts',5),c=await context(id);
    expect(c).toMatchObject({book_quantity:5,untracked_quantity:5,serials:[],batches:[]});
    const created=await submit(c,{counted_untracked:3});
    expect(created.status).toBe(201);
    const countId=created.body.id;
    expect(created.body).toMatchObject({book_quantity:5,counted_quantity:3,variance:-2,status:'submitted'});
    expect((await ctx.api.post(`/api/inventory/stock-counts/${countId}/approve`).set(H(warehouse))
      .send({note:'Verified the shelf count and signed off'})).status).toBe(409);
    expect((await ctx.api.post(`/api/inventory/stock-counts/${countId}/apply`).set(H(admin)).send({})).status).toBe(409);
    expect((await ctx.api.post(`/api/inventory/stock-counts/${countId}/approve`).set(H(admin))
      .send({note:'Verified the shelf count and signed off'})).status).toBe(200);
    const applied=await ctx.api.post(`/api/inventory/stock-counts/${countId}/apply`).set(H(admin)).send({});
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({status:'applied',current_quantity:3});
    expect(applied.body.transaction_id).toBeTypeOf('number');
    expect((await ctx.api.post(`/api/inventory/stock-counts/${countId}/apply`).set(H(admin)).send({})).status).toBe(200);
    const detail=(await ctx.api.get(`/api/inventory/${id}`).set(H(admin))).body;
    expect(detail.quantity).toBe(3);
    expect(detail.history.filter((t:any)=>String(t.reason).startsWith(`Stock count #${countId}:`))).toHaveLength(1);
  });

  it('rejects stale counts before approval and rejects a stale snapshot at submission',async()=>{
    const id=await item('Moving washers',4),c=await context(id);
    const created=await submit(c,{counted_untracked:4});
    expect(created.status).toBe(201);
    await ctx.api.post(`/api/inventory/${id}/adjust`).set(H(admin)).send({change:1,reason:'Received another box'});
    const approve=await ctx.api.post(`/api/inventory/stock-counts/${created.body.id}/approve`).set(H(admin))
      .send({note:'Checked against a current count'});
    expect(approve.status).toBe(409);
    expect(approve.body.code).toBe('stale_count');
    const stale=await submit(c,{counted_untracked:4});
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('stale_count');
  });

  it('blocks generic correction when a serialized unit is missing from the count',async()=>{
    const product=await item('Tracked count product');
    const part=await item('Tracked count component',10);
    await ctx.api.put(`/api/finished-products/${product}`).set(H(admin))
      .send({components:[{component_item_id:part,quantity:1}]});
    const mo=(await ctx.api.post('/api/job-orders').set(H(admin))
      .send({product_item_id:product,qty_ordered:1,qc_stages:1})).body.id;
    await ctx.api.post(`/api/job-orders/${mo}/approve`).set(H(admin));
    await ctx.api.post('/api/job-orders/warehouse-accept').set(H(admin)).send({job_order_ids:[mo]});
    await ctx.api.post('/api/job-orders/prepare').set(H(admin)).send({job_orders:[{id:mo}]});
    await ctx.api.post(`/api/job-orders/${mo}/release`).set(H(admin));
    await ctx.api.post(`/api/job-orders/${mo}/accept`).set(H(admin));
    await addSerializedUnits(ctx.api,admin,mo,1,'COUNT-SERIAL');
    const pending=(await ctx.api.get(`/api/job-orders/${mo}/units`).set(H(admin))).body[0];
    await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(H(admin))
      .send({unit_ids:[pending.id],result:'pass',identifier:'COUNT-SERIAL-1'});
    const receivable=(await ctx.api.get(`/api/job-orders/${mo}/receivable`).set(H(admin))).body;
    await ctx.api.post(`/api/job-orders/${mo}/products-in`).set(H(admin))
      .send({location_id:receivable.output_location_id,unit_ids:receivable.units.map((u:any)=>u.id)});
    const c=await context(product,receivable.output_location_id);
    expect(c.serials).toHaveLength(1);
    const generic=await ctx.api.post(`/api/inventory/${product}/adjust`).set(H(admin))
      .send({location_id:receivable.output_location_id,change:-1,reason:'Count loss'});
    expect(generic.status).toBe(409);
    expect(generic.body.code).toBe('use_unit_workflow');
    const damage=await ctx.api.post(`/api/inventory/${product}/damage`).set(H(admin))
      .send({location_id:receivable.output_location_id,quantity:1,reason:'Missing unit'});
    expect(damage.status).toBe(409);
    expect(damage.body.code).toBe('use_unit_workflow');
    const created=await submit(c,{counted_serial_codes:[]});
    expect(created.status).toBe(201);
    const countId=created.body.id;
    expect((await ctx.api.post(`/api/inventory/stock-counts/${countId}/approve`).set(H(admin))
      .send({note:'Confirmed the serial was absent from the shelf'})).status).toBe(200);
    const blocked=await ctx.api.post(`/api/inventory/stock-counts/${countId}/apply`).set(H(admin)).send({});
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('tracked_resolution_required');
    expect((await ctx.api.get(`/api/inventory/${product}`).set(H(admin))).body.quantity).toBe(1);
  });

  it('corrects the exact named batch and links its movement to the approved count',async()=>{
    const product=await item('Tracked batch count product');
    const part=await item('Tracked batch count component',10);
    await ctx.api.put(`/api/finished-products/${product}`).set(H(admin))
      .send({components:[{component_item_id:part,quantity:1}]});
    const mo=(await ctx.api.post('/api/job-orders').set(H(admin))
      .send({product_item_id:product,qty_ordered:2,qc_stages:0})).body.id;
    await ctx.api.post(`/api/job-orders/${mo}/approve`).set(H(admin));
    await ctx.api.post('/api/job-orders/warehouse-accept').set(H(admin)).send({job_order_ids:[mo]});
    await ctx.api.post('/api/job-orders/prepare').set(H(admin)).send({job_orders:[{id:mo}]});
    await ctx.api.post(`/api/job-orders/${mo}/release`).set(H(admin));
    await ctx.api.post(`/api/job-orders/${mo}/accept`).set(H(admin));
    expect((await ctx.api.post(`/api/job-orders/${mo}/progress`).set(H(admin)).send({done_delta:2})).status).toBe(200);
    const receivable=(await ctx.api.get(`/api/job-orders/${mo}/receivable`).set(H(admin))).body;
    expect((await ctx.api.post(`/api/job-orders/${mo}/products-in`).set(H(admin))
      .send({location_id:receivable.output_location_id,batch_id:receivable.batches[0].id,quantity:2})).status).toBe(201);
    const c=await context(product,receivable.output_location_id);
    expect(c.batches).toEqual([expect.objectContaining({quantity:2})]);
    const created=await submit(c,{counted_batches:[{batch_id:c.batches[0].batch_id,quantity:1}]});
    expect(created.status).toBe(201);
    expect((await ctx.api.post(`/api/inventory/stock-counts/${created.body.id}/approve`).set(H(admin))
      .send({note:'Verified the lot sticker and count'})).status).toBe(200);
    const so=(await ctx.api.post('/api/orders').set(H(admin)).send({type:'sale',status:'approved',
      customer_name:'Count reservation',items:[{item_id:product,name:'Tracked batch count product',quantity:2,unit_price:10}]})).body.id;
    await ctx.api.post(`/api/orders/${so}/accept-release`).set(H(admin));
    expect((await ctx.api.post(`/api/orders/${so}/release`).set(H(admin))
      .send({bulk:[{item_id:product,batch_id:c.batches[0].batch_id,quantity:2}]})).status).toBe(200);
    const reserved=await ctx.api.post(`/api/inventory/stock-counts/${created.body.id}/apply`).set(H(admin)).send({});
    expect(reserved.status).toBe(409);
    expect(reserved.body.code).toBe('batch_reserved');
    await ctx.api.post(`/api/orders/${so}/release/unreserve`).set(H(admin)).send({bulk:[{item_id:product,quantity:2}]});
    const applied=await ctx.api.post(`/api/inventory/stock-counts/${created.body.id}/apply`).set(H(admin)).send({});
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({status:'applied',current_quantity:1,
      movements:[{batch_id:c.batches[0].batch_id,change:-1}]});
    const {batchBalances}=await import('../src/modules/inventory/batch-stock');
    expect(batchBalances(c.batches[0].batch_id)[0]?.on_hand).toBe(1);
    expect((await ctx.api.get(`/api/inventory/${product}`).set(H(admin))).body.quantity).toBe(1);
    const fresh=await context(product,receivable.output_location_id);
    const extra=await submit(fresh,{counted_batches:[{batch_id:fresh.batches[0].batch_id,quantity:3}]});
    expect(extra.status).toBe(201);
    await ctx.api.post(`/api/inventory/stock-counts/${extra.body.id}/approve`).set(H(admin))
      .send({note:'Checked the new reported batch count'});
    const provenance=await ctx.api.post(`/api/inventory/stock-counts/${extra.body.id}/apply`).set(H(admin)).send({});
    expect(provenance.status).toBe(409);
    expect(provenance.body.code).toBe('batch_provenance');
  });
});
