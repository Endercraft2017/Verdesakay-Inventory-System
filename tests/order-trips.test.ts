import { beforeAll,afterAll,it,expect } from 'vitest';
import { setupApp,cleanup,login,type TestContext } from './helpers';
let ctx:TestContext,token:string;
const H=()=>({Authorization:'Bearer '+token});
beforeAll(async()=>{ctx=await setupApp();token=await login(ctx.api);await ctx.api.put('/api/release-slips/policy').set(H()).send({authorization_required:false});});
afterAll(()=>cleanup(ctx));
async function order(qty=5){const item=(await ctx.api.post('/api/inventory').set(H()).send({name:'Trip stock',quantity:qty,unit_cost:4})).body.id;
 const sale=(await ctx.api.post('/api/orders').set(H()).send({type:'sale',status:'approved',items:[{item_id:item,name:'Trip stock',quantity:qty,unit_price:10}]})).body.id;
 await ctx.api.post(`/api/orders/${sale}/accept-release`).set(H());const row=(await ctx.api.get(`/api/orders/${sale}`).set(H())).body.items[0];return {item,sale,line:row.id};}
async function authorize(sale:number){return(await ctx.api.post(`/api/release-slips/orders/${sale}/authorizations`).set(H()).send({mode:'delivery',recipient_name:'Driver',partial_allowed:true})).body.token;}
async function get(sale:number){return(await ctx.api.get(`/api/orders/${sale}`).set(H())).body;}
it('ships two vehicle loads on one sales order; remainder is unavailable until its own trip',async()=>{
 const {item,sale,line}=await order();const auth=await authorize(sale);
 await ctx.api.post(`/api/orders/${sale}/release`).set(H()).send({bulk:[{item_id:item,order_item_id:line,quantity:5}]});
 const d1=(await ctx.api.post('/api/deliveries').set(H()).send({order_id:sale})).body.id;
 const first=await ctx.api.post(`/api/orders/${sale}/release-slip`).set(H()).set('Idempotency-Key','trip-first').send({collected_by:'Driver',authorization_token:auth,previous_slip_id:null,lines:[{order_item_id:line,quantity:3}]});
 expect(first.status,JSON.stringify(first.body)).toBe(201);expect(first.body.backorder).toBeNull();expect(first.body.remaining).toBe(2);
 expect((await get(sale)).items[0]).toMatchObject({quantity:5,released_qty:5,dispatched_qty:3});
 expect((await ctx.api.get(`/api/inventory/${item}`).set(H())).body).toMatchObject({quantity:2,available_quantity:0,reserved_for_sales:2});
 expect((await ctx.api.get(`/api/deliveries/${d1}`).set(H())).body.items.map((x:any)=>x.quantity)).toEqual([3]);
 expect((await ctx.api.post(`/api/deliveries/${d1}/complete`).set(H()).send({outcome:'delivered'})).status).toBe(200);
 expect((await get(sale)).fulfillment.state).toBe('partially_fulfilled');
 const d2=(await ctx.api.post('/api/deliveries').set(H()).send({order_id:sale})).body.id;
 expect(d2).not.toBe(d1);expect((await ctx.api.get(`/api/deliveries/${d2}`).set(H())).body.items).toEqual([]);
 expect((await ctx.api.post(`/api/deliveries/${d2}/complete`).set(H()).send({outcome:'delivered'})).body.code).toBe('release_required');
 const auth2=await authorize(sale);
 const second=await ctx.api.post(`/api/orders/${sale}/release-slip`).set(H()).send({collected_by:'Driver',authorization_token:auth2,previous_slip_id:first.body.id,lines:[{order_item_id:line,quantity:2}]});
 expect(second.status,JSON.stringify(second.body)).toBe(201);expect(second.body.id).not.toBe(first.body.id);
 expect((await ctx.api.get(`/api/deliveries/${d2}`).set(H())).body).toMatchObject({order_id:sale,release_slip_id:second.body.id,items:[{quantity:2}]});
 expect((await ctx.api.get(`/api/inventory/${item}`).set(H())).body.quantity).toBe(0);
 await ctx.api.post(`/api/deliveries/${d2}/complete`).set(H()).send({outcome:'delivered'});
 expect((await get(sale)).fulfillment).toMatchObject({state:'fulfilled',dispatched:5,delivered:5,remaining:0});
 expect((await get(sale)).trips).toHaveLength(2);
});
it('keeps unbuilt demand committed and releases only the customer-cancelled remainder',async()=>{
 const {item,sale,line}=await order(5);const auth=await authorize(sale);
 await ctx.api.post(`/api/orders/${sale}/release`).set(H()).send({bulk:[{item_id:item,order_item_id:line,quantity:2}]});
 const shipped=await ctx.api.post(`/api/orders/${sale}/release-slip`).set(H()).send({collected_by:'Driver',authorization_token:auth});expect(shipped.status).toBe(201);
 const other=(await ctx.api.post('/api/orders').set(H()).send({type:'sale',items:[{item_id:item,name:'Other sale',quantity:1,unit_price:10}]})).body.id;
 const av=(await ctx.api.get(`/api/orders/${other}/availability`).set(H())).body;expect(av.lines[0]).toMatchObject({on_hand:3,committed_elsewhere:3,available:0});
 expect((await ctx.api.post(`/api/orders/${sale}/status`).set(H()).send({status:'completed',force:true})).status).toBe(409);
 const before=await get(sale);
 expect((await ctx.api.post(`/api/orders/${sale}/cancel-remainder`).set(H()).send({reason:'Customer cancelled',expected_revision:'stale'})).status).toBe(409);
 const cancelled=await ctx.api.post(`/api/orders/${sale}/cancel-remainder`).set(H()).send({reason:'Customer cancelled remainder',expected_revision:before.revision});expect(cancelled.status,JSON.stringify(cancelled.body)).toBe(200);
 expect((await get(sale)).items[0]).toMatchObject({quantity:5,dispatched_qty:2,cancelled_qty:3});
 expect((await ctx.api.get(`/api/inventory/${item}`).set(H())).body).toMatchObject({quantity:3,available_quantity:3,reserved_for_sales:0});
 expect((await get(sale)).total).toBe(20);
 expect((await ctx.api.post(`/api/orders/${sale}/status`).set(H()).send({status:"completed",force:true})).status).toBe(409);
});
it('rejects stale trip creation and cannot undo goods already shipped',async()=>{
 const {item,sale,line}=await order(3);const auth=await authorize(sale);
 await ctx.api.post(`/api/orders/${sale}/release`).set(H()).send({bulk:[{item_id:item,order_item_id:line,quantity:3}]});
 const payload={collected_by:'Driver',authorization_token:auth,previous_slip_id:null,lines:[{order_item_id:line,quantity:1}]};
 const first=await ctx.api.post(`/api/orders/${sale}/release-slip`).set(H()).set('Idempotency-Key','trip-replay').send(payload);expect(first.status).toBe(201);
 const replay=await ctx.api.post(`/api/orders/${sale}/release-slip`).set(H()).set('Idempotency-Key','trip-replay').send(payload);expect(replay.body.id).toBe(first.body.id);
 expect((await ctx.api.post(`/api/orders/${sale}/release-slip`).set(H()).send(payload)).body.code).toBe('trip_changed');
 expect((await ctx.api.post(`/api/orders/${sale}/release/unreserve`).set(H()).send({bulk:[{item_id:item,order_item_id:line,quantity:3}]})).status).toBe(409);
 expect((await ctx.api.get(`/api/inventory/${item}`).set(H())).body.quantity).toBe(2);
});

async function produced(serialized:boolean){
 const item=(await ctx.api.post('/api/inventory').set(H()).send({name:serialized?'Trip serial':'Trip batch'})).body.id;
 const part=(await ctx.api.post('/api/inventory').set(H()).send({name:'Trip production component',quantity:10})).body.id;
 await ctx.api.put(`/api/finished-products/${item}`).set(H()).send({components:[{component_item_id:part,quantity:1}]});
 const jo=(await ctx.api.post('/api/job-orders').set(H()).send({product_item_id:item,qty_ordered:4,qc_stages:serialized?1:0})).body.id;
 await ctx.api.post(`/api/job-orders/${jo}/approve`).set(H());
 await ctx.api.post('/api/job-orders/warehouse-accept').set(H()).send({job_order_ids:[jo]});
 await ctx.api.post('/api/job-orders/prepare').set(H()).send({job_orders:[{id:jo}]});
 await ctx.api.post(`/api/job-orders/${jo}/release`).set(H());await ctx.api.post(`/api/job-orders/${jo}/accept`).set(H());
 let ids:number[]=[];
 if(serialized){const {addSerializedUnits}=await import('./helpers');ids=await addSerializedUnits(ctx.api,token,jo,4,'TRIP');await ctx.api.post(`/api/job-orders/${jo}/units/inspect`).set(H()).send({unit_ids:ids,result:'pass'});}
 else await ctx.api.post(`/api/job-orders/${jo}/progress`).set(H()).send({done_delta:4});
 const rec=(await ctx.api.get(`/api/job-orders/${jo}/receivable`).set(H())).body;
 const batch=serialized?null:rec.batches[0].id;
 expect((await ctx.api.post(`/api/job-orders/${jo}/products-in`).set(H()).send({location_id:rec.output_location_id,...(serialized?{unit_ids:ids}:{batch_id:batch,quantity:4})})).status).toBe(201);
 const sale=(await ctx.api.post('/api/orders').set(H()).send({type:'sale',status:'approved',location_id:rec.output_location_id,items:[{item_id:item,name:'Trip product',quantity:4,unit_price:10}]})).body.id;
 await ctx.api.post(`/api/orders/${sale}/accept-release`).set(H());const line=(await get(sale)).items[0].id;
 return {item,sale,line,ids,batch};
}
it('keeps exact serialized identities on their individual trip manifests',async()=>{
 const {item,sale,line,ids}=await produced(true),auth=await authorize(sale);
 expect((await ctx.api.post(`/api/orders/${sale}/release`).set(H()).send({unit_ids:ids})).status).toBe(200);
 const base={collected_by:'Driver',authorization_token:auth,previous_slip_id:null};
 expect((await ctx.api.post(`/api/orders/${sale}/release-slip`).set(H()).send({...base,lines:[{order_item_id:line,quantity:2}]})).body.code).toBe('trip_serial_required');
 const first=await ctx.api.post(`/api/orders/${sale}/release-slip`).set(H()).send({...base,lines:[{order_item_id:line,quantity:2,unit_ids:[ids[1],ids[3]]}]});expect(first.status,JSON.stringify(first.body)).toBe(201);
 const c=(await ctx.api.get(`/api/release-slips/orders/${sale}/context`).set(H())).body;
 expect(c.units.filter((u:any)=>u.status==='reserved').map((u:any)=>u.id)).toEqual([ids[0],ids[2]]);
 const second=await ctx.api.post(`/api/orders/${sale}/release-slip`).set(H()).send({collected_by:'Driver',authorization_token:await authorize(sale),previous_slip_id:first.body.id,lines:[{order_item_id:line,quantity:2,unit_ids:[ids[0],ids[2]]}]});expect(second.status,JSON.stringify(second.body)).toBe(201);
 const returns=(await ctx.api.get(`/api/sales-returns/slips/${first.body.id}/context`).set(H())).body;
 expect(returns.units.map((u:any)=>u.id).sort()).toEqual([ids[1],ids[3]].sort());
 expect((await ctx.api.get(`/api/inventory/${item}`).set(H())).body.quantity).toBe(0);
});
it('splits a reserved batch without losing its remaining hold or trip identity',async()=>{
 const {item,sale,line,batch}=await produced(false),auth=await authorize(sale);
 expect((await ctx.api.post(`/api/orders/${sale}/release`).set(H()).send({bulk:[{item_id:item,order_item_id:line,batch_id:batch,quantity:4}]})).status).toBe(200);
 const before=(await ctx.api.get(`/api/release-slips/orders/${sale}/context`).set(H())).body.batch_allocations[0];
 const first=await ctx.api.post(`/api/orders/${sale}/release-slip`).set(H()).send({collected_by:'Driver',authorization_token:auth,lines:[{order_item_id:line,quantity:1,batches:[{allocation_id:before.id,quantity:1}]}]});expect(first.status,JSON.stringify(first.body)).toBe(201);
 const allocations=(await ctx.api.get(`/api/release-slips/orders/${sale}/context`).set(H())).body.batch_allocations;
 expect(allocations).toEqual(expect.arrayContaining([expect.objectContaining({id:before.id,state:'reserved',quantity:3}),expect.objectContaining({state:'shipped',quantity:1,release_slip_id:first.body.id})]));
 const detail=(await ctx.api.get('/api/inventory/lookup').query({code:'VDS:BATCH:'+batch}).set(H())).body;
 expect(detail.batch.balances[0]).toMatchObject({on_hand:3,reserved:3,available:0});
 const second=await ctx.api.post(`/api/orders/${sale}/release-slip`).set(H()).send({collected_by:'Driver',authorization_token:await authorize(sale),previous_slip_id:first.body.id,lines:[{order_item_id:line,quantity:3,batches:[{allocation_id:before.id,quantity:3}]}]});expect(second.status,JSON.stringify(second.body)).toBe(201);
 const {queryAll}=await import('../src/shared/db');
 expect(queryAll<{quantity:number;release_slip_id:number}>('SELECT quantity,release_slip_id FROM production_batch_allocations WHERE order_id=? ORDER BY release_slip_id',sale)).toEqual([{quantity:1,release_slip_id:first.body.id},{quantity:3,release_slip_id:second.body.id}]);
});
it('keeps extra CKD components held while shipping complete kits on two trips',async()=>{
 const product=(await ctx.api.post('/api/inventory').set(H()).send({name:'Trip CKD'})).body.id;
 const frame=(await ctx.api.post('/api/inventory').set(H()).send({name:'Trip frame',quantity:2})).body.id;
 const wheel=(await ctx.api.post('/api/inventory').set(H()).send({name:'Trip wheel',quantity:4})).body.id;
 await ctx.api.put(`/api/finished-products/${product}`).set(H()).send({components:[{component_item_id:frame,quantity:1},{component_item_id:wheel,quantity:2}]});
 const sale=(await ctx.api.post('/api/orders').set(H()).send({type:'sale',status:'approved',items:[{item_id:product,name:'Trip kit',quantity:2,unit_price:100,fulfillment_mode:'ckd'}]})).body.id;
 await ctx.api.post(`/api/orders/${sale}/accept-release`).set(H());const lines=(await get(sale)).items;const f=lines[1].id,w=lines[2].id;
 await ctx.api.post(`/api/orders/${sale}/release`).set(H()).send({bulk:[{item_id:frame,quantity:2},{item_id:wheel,quantity:4}]});
 const base={collected_by:'Driver',authorization_token:await authorize(sale)};
 expect((await ctx.api.post(`/api/orders/${sale}/release-slip`).set(H()).send({...base,lines:[{order_item_id:f,quantity:1},{order_item_id:w,quantity:1}]})).status).toBe(409);
 const first=await ctx.api.post(`/api/orders/${sale}/release-slip`).set(H()).send({...base,lines:[{order_item_id:f,quantity:1},{order_item_id:w,quantity:2}]});expect(first.status,JSON.stringify(first.body)).toBe(201);
 expect((await get(sale)).items.map((l:any)=>[l.quantity,l.dispatched_qty])).toEqual([[2,1],[2,1],[4,2]]);
 const second=await ctx.api.post(`/api/orders/${sale}/release-slip`).set(H()).send({collected_by:'Driver',authorization_token:await authorize(sale),previous_slip_id:first.body.id});expect(second.status,JSON.stringify(second.body)).toBe(201);
 expect((await get(sale)).items.map((l:any)=>[l.quantity,l.dispatched_qty])).toEqual([[2,2],[2,2],[4,4]]);
 expect((await get(sale)).total).toBe(200);
});
it('posts only the additional physical trip cost on each slip and never on replay',async()=>{
 expect((await ctx.api.post('/api/accounting/ledger/setup').set(H()).send({fiscal_year_start:'2026-01-01'})).status).toBe(201);
 const {item,sale,line}=await order(5),auth=await authorize(sale);
 await ctx.api.post(`/api/orders/${sale}/release`).set(H()).send({bulk:[{item_id:item,quantity:5}]});
 const first=await ctx.api.post(`/api/orders/${sale}/release-slip`).set(H()).set('Idempotency-Key','trip-cogs-one').send({collected_by:'Driver',authorization_token:auth,lines:[{order_item_id:line,quantity:2}]});expect(first.status).toBe(201);
 const {queryOne}=await import('../src/shared/db');
 const cost=()=>queryOne<{n:number}>("SELECT SUM(jl.debit) AS n FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id WHERE je.source_type='sale_cogs' AND je.source_id=?",sale)!.n;
 expect(cost()).toBe(8);
 const second=await ctx.api.post(`/api/orders/${sale}/release-slip`).set(H()).send({collected_by:'Driver',authorization_token:await authorize(sale),previous_slip_id:first.body.id});expect(second.status).toBe(201);expect(cost()).toBe(20);
 const {postFulfilledSaleCogs}=await import('../src/modules/accounting/accounting-autopost');postFulfilledSaleCogs(sale,1);expect(cost()).toBe(20);
});

it('courier collection closes custody without reporting customer delivery or completing the SO',async()=>{
 const {item,sale,line}=await order(1),auth=await authorize(sale);
 await ctx.api.post(`/api/orders/${sale}/release`).set(H()).send({bulk:[{item_id:item,quantity:1}]});
 const d=(await ctx.api.post('/api/deliveries').set(H()).send({order_id:sale,delivery_mode:'courier',courier_name:'Parcel carrier'})).body.id;
 expect((await ctx.api.post(`/api/orders/${sale}/release-slip`).set(H()).send({collected_by:'Collector',authorization_token:auth,lines:[{order_item_id:line,quantity:1}]})).status).toBe(201);
 expect((await ctx.api.post(`/api/deliveries/${d}/complete`).set(H()).send({outcome:'courier_handoff'})).status).toBe(200);
 expect((await get(sale)).fulfillment).toMatchObject({dispatched:1,delivered:0,state:'awaiting_delivery'});
 expect((await get(sale)).status).not.toBe('completed');
});
it('corrects one exact batch reservation while leaving other reservations and stock intact',async()=>{
 const {item,sale,line,batch}=await produced(false);
 for(const quantity of [1,3])expect((await ctx.api.post(`/api/orders/${sale}/release`).set(H()).send({bulk:[{item_id:item,order_item_id:line,batch_id:batch,quantity}]})).status).toBe(200);
 const before=(await ctx.api.get(`/api/release-slips/orders/${sale}/context`).set(H())).body.batch_allocations;
 const correction={bulk:[{item_id:item,order_item_id:line,allocation_id:before[0].id,quantity:1}]};
 expect((await ctx.api.post(`/api/orders/${sale}/release/unreserve`).set(H()).send(correction)).status).toBe(200);
 const after=(await ctx.api.get(`/api/release-slips/orders/${sale}/context`).set(H())).body.batch_allocations;
 expect(after).toHaveLength(1);expect(after[0]).toMatchObject({id:before[1].id,quantity:3,state:'reserved'});
 expect((await ctx.api.post(`/api/orders/${sale}/release/unreserve`).set(H()).send(correction)).status).toBe(409);
 expect((await ctx.api.get(`/api/inventory/${item}`).set(H())).body.quantity).toBe(4);
});
