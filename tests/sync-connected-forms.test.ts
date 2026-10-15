import {beforeAll,afterAll,it,expect} from 'vitest';
import {setupSiteTrio,type SiteTrio} from './sync-helpers';
import {cleanup} from './helpers';
let pair:SiteTrio,product:number,customer:number,form:number,operatorId:number;
beforeAll(async()=>{
 pair=await setupSiteTrio(async ({api,cloudHdr})=>{
 const auth=cloudHdr();
 operatorId=(await api.post('/api/users').set(auth).send({username:'offline_invoice_operator',full_name:'Offline Invoice Operator',password:'offline-test-123',role:'admin_staff'})).body.id;
 await api.put('/api/users/'+operatorId+'/permissions').set(auth).send({overrides:{'forms.manage.inventory':true,'inventory.view':true,'orders.view':true,'orders.create':true}});
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

it('recovers a disconnected LAN submission once after concurrent cloud activity and repeated retries',async()=>{
 pair.cutOff('lan');
 const payload={_form_reference_snapshot:{form_id:form,definition_version:1,values:{items:[{row_id:'offline-one',product_id:product,name:'FORGED SNAPSHOT',quantity:2,unit_price:73}]}},form_def_id:form,status:'submitted',data:{customer,items:[{row_id:'offline-one',product_id:product,quantity:2,unit_price:73}]}};
 const send=()=>pair.ctx.api.post('/api/form-records').set(pair.lanHdr()).set('Idempotency-Key','offline-invoice-recovery').send(payload);
 try{
  const created=await send();expect(created.status).toBe(201);const recordId=created.body.id,orderId=created.body.sales_order.order_id;
  expect(pair.cloudDb().prepare('SELECT id FROM form_records WHERE id=?').get(recordId)).toBeUndefined();
  expect((await send()).body).toEqual(created.body);
  const concurrent=await pair.ctx.api.post('/api/form-records').set(pair.cloudHdr()).send({...payload,data:{...payload.data,items:[{...payload.data.items[0],row_id:'cloud-one',unit_price:90}]}});expect(concurrent.status).toBe(201);
  await expect(pair.lanRound()).rejects.toThrow(/Cannot reach/);expect(pair.cloudDb().prepare('SELECT id FROM form_records WHERE id=?').get(recordId)).toBeUndefined();
  pair.reconnect('lan');await pair.hostRound();await pair.lanRound();await pair.hostRound();await pair.lanRound();await pair.hostRound();
  const read=(conn:ReturnType<typeof pair.cloudDb>)=>({record:conn.prepare('SELECT number,data,status FROM form_records WHERE id=?').get(recordId),link:conn.prepare('SELECT order_id,order_number FROM form_sales_links WHERE record_id=?').get(recordId),order:conn.prepare('SELECT number,status,total FROM orders WHERE id=?').get(orderId)});
  expect(read(pair.lanDb())).toEqual(read(pair.cloudDb()));expect(read(pair.cloudDb()).order).toMatchObject({total:146,status:'open'});
  expect(JSON.stringify(read(pair.cloudDb()).record)).not.toContain('FORGED SNAPSHOT');
  expect(pair.cloudDb().prepare('SELECT COUNT(*) AS n FROM form_sales_links WHERE record_id=?').get(recordId)).toEqual({n:1});
  expect(pair.cloudDb().prepare('SELECT COUNT(*) AS n FROM form_records WHERE id IN (?,?)').get(recordId,concurrent.body.id)).toEqual({n:2});
  expect(pair.cloudDb().prepare('PRAGMA foreign_key_check').all()).toEqual([]);
 }finally{pair.reconnect('lan');}
},60_000);

it('retains agreed prices and captured product details when catalog data changes while a LAN record is pending',async()=>{
 pair.cutOff('lan');
 try{
  const created=await pair.ctx.api.post('/api/form-records').set(pair.lanHdr()).send({form_def_id:form,status:'submitted',data:{customer,items:[{row_id:'historical',product_id:product,quantity:1,unit_price:71}]}});expect(created.status).toBe(201);
  const id=created.body.id,original=(await pair.ctx.api.get('/api/form-records/'+id).set(pair.lanHdr())).body;
  const changed=await pair.ctx.api.put('/api/inventory/'+product).set(pair.hostHdr()).send({name:'Changed after offline entry',unit:'pack',attributes:{sale_price:999,currency:'PHP'}});expect(changed.status).toBe(200);await pair.hostRound();
  pair.reconnect('lan');await pair.lanRound();await pair.hostRound();await pair.lanRound();
  const synced=(await pair.ctx.api.get('/api/form-records/'+id).set(pair.cloudHdr())).body;
  expect(synced.data.items[0]).toMatchObject({name:original.data.items[0].name,unit:original.data.items[0].unit,sale_price:original.data.items[0].sale_price,unit_price:71,line_total:71});
 }finally{pair.reconnect('lan');}
},60_000);


it('rechecks source permission revocation instead of trusting the originating account’s old access',async()=>{
 const login=await pair.ctx.api.post('/api/auth/login').set('X-Tenant',pair.lanSlug).send({username:'offline_invoice_operator',password:'offline-test-123'});expect(login.status).toBe(200);
 const hdr={Authorization:'Bearer '+login.body.token,'X-Tenant':pair.lanSlug};pair.cutOff('lan');
 try{
  const created=await pair.ctx.api.post('/api/form-records').set(hdr).send({form_def_id:form,status:'submitted',data:{customer,items:[{row_id:'permission',product_id:product,quantity:1,unit_price:70}]}});expect(created.status).toBe(201);
  await pair.ctx.api.put('/api/users/'+operatorId+'/permissions').set(pair.cloudHdr()).send({overrides:{'forms.manage.inventory':true,'inventory.view':false,'orders.view':true,'orders.create':true}});
  pair.reconnect('lan');await pair.lanRound();const result=await pair.hostRound();await pair.lanRound();
  expect(result.pushed.some(entry=>entry.state==='rejected'&&entry.response_status===403)).toBe(true);
  expect(pair.cloudDb().prepare('SELECT id FROM form_records WHERE id=?').get(created.body.id)).toBeUndefined();
  expect(pair.cloudDb().prepare('SELECT record_id FROM form_sales_links WHERE record_id=?').get(created.body.id)).toBeUndefined();
 }finally{pair.reconnect('lan');}
},60_000);
