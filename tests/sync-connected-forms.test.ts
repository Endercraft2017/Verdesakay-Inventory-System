import {beforeAll,afterAll,it,expect} from 'vitest';
import {setupSiteTrio,type SiteTrio} from './sync-helpers';
import {cleanup} from './helpers';
let pair:SiteTrio,product:number,customer:number,form:number;
beforeAll(async()=>{
 pair=await setupSiteTrio(async ({api,cloudHdr})=>{
 const auth=cloudHdr();
 product=(await api.post('/api/inventory').set(auth).send({name:'Synced product',unit:'box',attributes:{sale_price:80}})).body.id;
 customer=(await api.post('/api/customers').set(auth).send({name:'Synced customer'})).body.id;
 const definition=await api.post('/api/form-definitions').set(auth).send({name:'Synced invoice',slug:'synced_invoice',number_prefix:'SI',scope:'inventory',fields:[{key:'customer',label:'Customer',type:'reference',source:'customer',required:true},{key:'items',label:'Items',type:'line_items',required:true}],actions:[{type:'create_sales_draft',run_on:'submitted',customer_field:'customer',items_field:'items'}]});expect(definition.status).toBe(201);form=definition.body.id;
 });
 await pair.ctx.api.put('/api/sync/sites').set(pair.cloudHdr()).send({main_host:pair.hostNo});await pair.hostRound();await pair.lanRound();
},90_000);
afterAll(()=>{pair?.close();cleanup(pair.ctx);});
it('synchronizes a submitted invoice, its history and exactly one linked draft without changing stock',async()=>{
 const response=await pair.ctx.api.post('/api/form-records').set(pair.lanHdr()).set('Idempotency-Key','sync-connected-submit-1').send({form_def_id:form,status:'submitted',data:{customer,items:[{row_id:'one',product_id:product,quantity:3,unit_price:75}]}});expect(response.status).toBe(201);
 const recordId=response.body.id,orderId=response.body.sales_order.order_id;
 await pair.lanRound();await pair.hostRound();await pair.lanRound();
 const read=(conn:ReturnType<typeof pair.cloudDb>)=>({record:conn.prepare('SELECT number,data,status,revision FROM form_records WHERE id=?').get(recordId),link:conn.prepare('SELECT * FROM form_sales_links WHERE record_id=?').get(recordId),order:conn.prepare('SELECT number,status,total FROM orders WHERE id=?').get(orderId)});
 expect(read(pair.lanDb())).toEqual(read(pair.cloudDb()));
 expect(read(pair.cloudDb()).order).toMatchObject({status:'open',total:225});
 expect(pair.cloudDb().prepare('SELECT COUNT(*) AS n FROM form_sales_links WHERE record_id=?').get(recordId)).toEqual({n:1});
 expect(pair.cloudDb().prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

it('creates a connected form and its initial print layout on the site authority and synchronizes both',async()=>{
 const response=await pair.ctx.api.post('/api/form-definitions').set(pair.hostHdr()).send({name:'Offline connected form',slug:'offline_connected',number_prefix:'OC',scope:'inventory',fields:[{key:'product',label:'Product',type:'reference',source:'product'}]});
 expect(response.status).toBe(201);const id=response.body.id;
 await pair.hostRound();await pair.lanRound();
 const read=(conn:ReturnType<typeof pair.cloudDb>)=>conn.prepare('SELECT f.name,f.fields,f.template_id,t.body FROM form_definitions f JOIN doc_templates t ON t.id=f.template_id WHERE f.id=?').get(id);
 expect(read(pair.lanDb())).toEqual(read(pair.cloudDb()));expect(read(pair.cloudDb())).toBeTruthy();
 expect(pair.cloudDb().prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});
