import {beforeAll,afterAll,it,expect} from 'vitest';
import {setupApp,cleanup,login,createEmployee,addSerializedUnits,type TestContext} from './helpers';
let ctx:TestContext,token:string;
const H=(t=token)=>({Authorization:'Bearer '+t});
beforeAll(async()=>{ctx=await setupApp();token=await login(ctx.api);await ctx.api.put('/api/release-slips/policy').set(H()).send({authorization_required:false});});afterAll(()=>cleanup(ctx));
async function product(){
 const p=(await ctx.api.post('/api/inventory').set(H()).send({name:'Scope return product'})).body.id,part=(await ctx.api.post('/api/inventory').set(H()).send({name:'Scope component',quantity:5})).body.id;
 await ctx.api.put(`/api/finished-products/${p}`).set(H()).send({components:[{component_item_id:part,quantity:1}]});
 const jo=(await ctx.api.post('/api/job-orders').set(H()).send({product_item_id:p,qty_ordered:1,qc_stages:1})).body.id;
 await ctx.api.post(`/api/job-orders/${jo}/approve`).set(H());await ctx.api.post('/api/job-orders/warehouse-accept').set(H()).send({job_order_ids:[jo]});await ctx.api.post('/api/job-orders/prepare').set(H()).send({job_orders:[{id:jo}]});await ctx.api.post(`/api/job-orders/${jo}/release`).set(H());await ctx.api.post(`/api/job-orders/${jo}/accept`).set(H());
 const [unit]=await addSerializedUnits(ctx.api,token,jo,1,'SCOPED');return {p,jo,unit};
}
it('supplies finishing context to managers without granting inventory or commercial reads',async()=>{
 const manager=await createEmployee(ctx.api,token,{role:'production_manager'}),qc=await createEmployee(ctx.api,token,{role:'qc_inspector'});
 const response=await ctx.api.get('/api/job-orders/convert-semi/context').set(H(manager.token));expect(response.status).toBe(200);expect(response.body).toHaveProperty('products');expect(response.body).toHaveProperty('locations');expect(JSON.stringify(response.body)).not.toMatch(/unit_price|customer_name|customer_contact/);
 expect((await ctx.api.get('/api/orders?type=sale').set(H(manager.token))).status).toBe(403);
 expect((await ctx.api.get('/api/job-orders/convert-semi/context').set(H(qc.token))).status).toBe(403);
});
it('gives whole-job issue management an explicit job-filtered operator path',async()=>{
 const {jo,unit}=await product(),lead=await createEmployee(ctx.api,token,{role:'production_lead'});
 expect((await ctx.api.post('/api/production-issues').set(H(lead.token)).send({job_order_id:jo,category:'Kit issue',description:'Wrong package quantity'})).status).toBe(201);
 await ctx.api.post('/api/production-issues').set(H()).send({job_order_id:jo,unit_id:unit,category:'Serial issue',description:'Separate unit finding'});
 const list=await ctx.api.get(`/api/production-issues?job_order_id=${jo}&whole_job=1`).set(H(lead.token));expect(list.status).toBe(200);expect(list.body).toHaveLength(1);expect(list.body[0].unit_id).toBeNull();
});
it('limits inspector return reads to serialized repair work and keeps stock decisions warehouse-only',async()=>{
 const {p,jo,unit}=await product(),qc=await createEmployee(ctx.api,token,{role:'qc_inspector'});
 await ctx.api.post(`/api/job-orders/${jo}/units/inspect`).set(H()).send({unit_ids:[unit],result:'pass'});const rec=(await ctx.api.get(`/api/job-orders/${jo}/receivable`).set(H())).body;await ctx.api.post(`/api/job-orders/${jo}/products-in`).set(H()).send({location_id:rec.output_location_id,unit_ids:[unit]});
 const sale=(await ctx.api.post('/api/orders').set(H()).send({type:'sale',status:'approved',customer_name:'Private buyer',items:[{item_id:p,name:'Scoped product',quantity:1,unit_price:99}]})).body.id;
 await ctx.api.post(`/api/orders/${sale}/accept-release`).set(H());await ctx.api.post(`/api/orders/${sale}/release`).set(H()).send({unit_ids:[unit]});const slip=(await ctx.api.post(`/api/orders/${sale}/release-slip`).set(H()).send({collected_by:'Buyer'})).body.id;
 const line=(await ctx.api.get(`/api/release-slips/${slip}`).set(H())).body.items[0].id;
 const proof=(await ctx.api.post('/api/attachments').set(H()).field('kind','sales_return_proof').field('ref_id',String(slip)).attach('image',Buffer.from('proof'),'proof.png')).body.id;
 const received=await ctx.api.post('/api/sales-returns').set(H()).send({slip_id:slip,slip_item_id:line,unit_id:unit,quantity:1,reason:'Customer found damage',evidence_ids:[proof]});expect(received.status).toBe(201);const id=received.body.id;
 expect((await ctx.api.get(`/api/sales-returns/${id}`).set(H(qc.token))).status).toBe(403);
 await ctx.api.post(`/api/sales-returns/${id}/inspect`).set(H()).send({decision:'reject',condition_note:'Needs repair before restock'});await ctx.api.post(`/api/sales-returns/${id}/disposition`).set(H()).send({decision:'repair',note:'Repair the serialized goods'});
 const result=await ctx.api.get(`/api/sales-returns/${id}`).set(H(qc.token));expect(result.status).toBe(200);expect(result.body.unit_id).toBe(unit);expect(result.body).not.toHaveProperty('customer_name');expect(result.body).not.toHaveProperty('order_id');expect(result.body).not.toHaveProperty('unit_cost');
 expect((await ctx.api.get('/api/sales-returns').set(H(qc.token))).status).toBe(403);expect((await ctx.api.get('/api/sales-returns/repair-queue').set(H(qc.token))).body.some((r:any)=>r.id===id)).toBe(true);
 expect((await ctx.api.post(`/api/sales-returns/${id}/reinspect`).set(H(qc.token)).send({decision:'restock',condition_note:'Attempted unauthorized stock-in'})).status).toBe(403);
});
