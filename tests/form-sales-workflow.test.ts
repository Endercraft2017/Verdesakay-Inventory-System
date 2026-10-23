import {beforeAll,afterAll,it,expect} from 'vitest';
import {setupApp,cleanup,login,createEmployee,type TestContext} from './helpers';
let ctx:TestContext,token:string,product:number,customer:number,form:number,draft:number;
const auth=(value=token)=>({Authorization:'Bearer '+value});
const fields=[{key:'customer',label:'Customer',type:'reference',source:'customer',required:true},{key:'items',label:'Products',type:'line_items',required:true},{key:'subtotal',label:'Subtotal',type:'calculated',calculation:{operator:'sum',operands:['items.line_total']}},{key:'tax_rate',label:'Tax percent',type:'number',default:'12'},{key:'tax',label:'Tax',type:'calculated',calculation:{operator:'percent',operands:['subtotal','tax_rate']}},{key:'total',label:'Total',type:'calculated',calculation:{operator:'sum',operands:['subtotal','tax']}}];
const actions=[{type:'create_sales_draft',run_on:'submitted',customer_field:'customer',items_field:'items',tax_field:'tax_rate',total_field:'total'}];
const row=(extra={})=>({row_id:'row-one',product_id:product,quantity:2,unit_price:50,...extra});
const body=(status='draft',extra={})=>({form_def_id:form,status,data:{customer,items:[row()],tax_rate:12,total:1,...extra}});
beforeAll(async()=>{
 ctx=await setupApp();token=await login(ctx.api);
 product=(await ctx.api.post('/api/inventory').set(auth()).send({name:'Invoice product',sku:'INV',unit:'box',quantity:20,attributes:{sale_price:75}})).body.id;
 customer=(await ctx.api.post('/api/customers').set(auth()).send({name:'Invoice customer'})).body.id;
 const result=await ctx.api.post('/api/form-definitions').set(auth()).send({name:'Custom sales invoice',slug:'custom_sales_invoice',number_prefix:'CSI',scope:'inventory',fields,actions});expect(result.status).toBe(201);form=result.body.id;
});
afterAll(()=>cleanup(ctx));
it('calculates trustworthy row, subtotal, tax and total values while keeping manual prices',async()=>{
 const response=await ctx.api.post('/api/form-records').set(auth()).send(body());expect(response.status).toBe(201);draft=response.body.id;expect(response.body.sales_order).toBeNull();
 const record=(await ctx.api.get('/api/form-records/'+draft).set(auth())).body;
 expect(record.data).toMatchObject({subtotal:100,tax:12,total:112,items:[{name:'Invoice product',unit:'box',unit_price:50,line_total:100}]});
});
it('submits atomically into one open sales order, retains original values and leaves stock unchanged',async()=>{
 const before=(await ctx.api.get('/api/form-records/'+draft).set(auth())).body;
 const submitted=await ctx.api.put('/api/form-records/'+draft).set(auth()).send({data:before.data,status:'submitted',expected_revision:before.revision});expect(submitted.status).toBe(200);
 const saved=(await ctx.api.get('/api/form-records/'+draft).set(auth())).body;expect(saved.sales_order.order_id).toBeGreaterThan(0);
 const order=await ctx.api.get('/api/orders/'+saved.sales_order.order_id).set(auth());expect(order.body).toMatchObject({type:'sale',status:'open',customer_id:customer,total:112,items:[{item_id:product,unit_price:50,quantity:2}]});
 const db=await import('../src/shared/db');expect(db.queryOne<{quantity:number}>('SELECT quantity FROM inventory_items WHERE id=?',product)!.quantity).toBe(20);
 expect((await ctx.api.put('/api/form-records/'+draft).set(auth()).send({data:saved.data,status:'submitted'})).status).toBe(200);
 expect(db.queryOne<{n:number}>('SELECT COUNT(*) AS n FROM form_sales_links WHERE record_id=?',draft)!.n).toBe(1);
 expect((await ctx.api.put('/api/form-records/'+draft).set(auth()).send({data:{...saved.data,tax_rate:20}})).status).toBe(409);
 expect((await ctx.api.delete('/api/form-records/'+draft).set(auth())).status).toBe(409);
 expect((await ctx.api.delete('/api/orders/'+saved.sales_order.order_id).set(auth())).status).toBe(409);
});
it('replays a lost successful response with the same key without duplicating records or orders',async()=>{
 const key='form-invoice-success-123';const send=()=>ctx.api.post('/api/form-records').set(auth()).set('Idempotency-Key',key).send(body('submitted'));
 const one=await send(),two=await send();expect(one.status).toBe(201);expect(two.status).toBe(201);expect(two.body).toEqual(one.body);expect(two.headers['idempotency-replayed']).toBe('true');
});
it('rejects invalid quantities, prices, forged products and duplicate row IDs without creating orders',async()=>{
 for(const extra of [{quantity:0},{quantity:-1},{unit_price:-1},{unit_price:'Infinity'},{product_id:999999},{quantity:1e30}])expect((await ctx.api.post('/api/form-records').set(auth()).send(body('submitted',{items:[row(extra)]}))).status).toBe(400);
 expect((await ctx.api.post('/api/form-records').set(auth()).send(body('submitted',{items:[row(),row()]}))).status).toBe(400);
});
it('rolls the submission back when sales permissions or customer availability fail',async()=>{
 const person=await createEmployee(ctx.api,token,{role:'admin_staff',permission_overrides:{'orders.create':false}});
 await ctx.api.put('/api/users/'+person.id+'/permissions').set(auth()).send({overrides:{'forms.manage.inventory':true,'orders.create':false}});
 const denied=await ctx.api.post('/api/form-records').set(auth(person.token)).send(body('submitted'));expect(denied.status).toBe(403);
 const archived=(await ctx.api.post('/api/customers').set(auth()).send({name:'Archived customer',archived:true})).body.id;
 expect((await ctx.api.post('/api/form-records').set(auth()).send(body('submitted',{customer:archived}))).status).toBe(400);
});
it('rejects calculation cycles and invalid workflow mappings at definition time',async()=>{
 const bad=[{key:'a',label:'A',type:'calculated',calculation:{operator:'sum',operands:['b']}},{key:'b',label:'B',type:'calculated',calculation:{operator:'sum',operands:['a']}}];
 expect((await ctx.api.post('/api/form-definitions').set(auth()).send({name:'Cycle',slug:'cycle',fields:bad,scope:'inventory'})).status).toBe(400);
 expect((await ctx.api.post('/api/form-definitions').set(auth()).send({name:'Bad workflow',slug:'bad_workflow',fields,actions:[{...actions[0],customer_field:'missing'}],scope:'inventory'})).status).toBe(400);
});

it('preserves list prices and discounts while matching the draft order net prices and totals',async()=>{
 const response=await ctx.api.post('/api/form-records').set(auth()).send(body('submitted',{items:[row({unit_price:100,discount_percent:10})]}));expect(response.status).toBe(201);
 const saved=(await ctx.api.get('/api/form-records/'+response.body.id).set(auth())).body;
 expect(saved.data).toMatchObject({subtotal:180,tax:21.6,total:201.6,items:[{unit_price:100,discount_percent:10,discount_amount:20,line_total:180}]});
 const order=(await ctx.api.get('/api/orders/'+saved.sales_order.order_id).set(auth())).body;expect(order.total).toBe(201.6);expect(order.items[0].unit_price).toBe(90);
 expect((await ctx.api.post('/api/form-records').set(auth()).send(body('submitted',{items:[row({discount_percent:101})]}))).status).toBe(400);
});

it('rejects invalid workflow statuses and archived customers while preserving duplicate stock lines',async()=>{
 expect((await ctx.api.post('/api/form-records').set(auth()).send(body('approved'))).status).toBe(400);
 const repeated=await ctx.api.post('/api/form-records').set(auth()).send(body('submitted',{items:[row(),row({row_id:'different'})]}));
 expect(repeated.status).toBe(201);
 const linked=(await ctx.api.get('/api/form-records/'+repeated.body.id).set(auth())).body.sales_order.order_id;
 expect((await ctx.api.get('/api/orders/'+linked).set(auth())).body.items).toHaveLength(2);
 const disposable=(await ctx.api.post('/api/customers').set(auth()).send({name:'Temporary customer'})).body.id;
 const created=await ctx.api.post('/api/form-records').set(auth()).send(body('draft',{customer:disposable}));expect(created.status).toBe(201);
 const saved=(await ctx.api.get('/api/form-records/'+created.body.id).set(auth())).body;
 await ctx.api.put('/api/customers/'+disposable).set(auth()).send({archived:true,version:1});
 expect((await ctx.api.put('/api/form-records/'+created.body.id).set(auth()).send({data:saved.data,status:'submitted',expected_revision:saved.revision})).status).toBe(400);
 const unchanged=(await ctx.api.get('/api/form-records/'+created.body.id).set(auth())).body;expect(unchanged.status).toBe('draft');expect(unchanged.revision).toBe(saved.revision);expect(unchanged.sales_order).toBeNull();
});

it('keeps source history intact through order corrections, cancellation, approval and partial fulfillment',async()=>{
 const make=async()=>{const made=await ctx.api.post('/api/form-records').set(auth()).send(body('submitted'));expect(made.status).toBe(201);return {recordId:made.body.id,orderId:made.body.sales_order.order_id};};
 const cancelled=await make();let order=(await ctx.api.get('/api/orders/'+cancelled.orderId).set(auth())).body;
 expect((await ctx.api.put('/api/orders/'+order.id).set(auth()).send({notes:'Reviewed correction',expected_revision:order.revision})).status).toBe(200);
 expect((await ctx.api.post('/api/orders/'+order.id+'/status').set(auth()).send({status:'cancelled'})).status).toBe(200);
 expect((await ctx.api.get('/api/form-records/'+cancelled.recordId).set(auth())).body).toMatchObject({status:'submitted',data:{total:112},sales_order:{order_id:order.id}});
 const shipped=await make();order=(await ctx.api.get('/api/orders/'+shipped.orderId).set(auth())).body;
 expect((await ctx.api.post('/api/orders/'+order.id+'/status').set(auth()).send({status:'approved'})).status).toBe(200);
 expect((await ctx.api.put('/api/orders/'+order.id).set(auth()).send({items:[{item_id:product,name:'Invoice product',quantity:2,unit_price:1}]})).status).toBe(200);
 expect((await ctx.api.get('/api/orders/'+order.id).set(auth())).body.items[0].unit_price).toBe(50);
 expect((await ctx.api.post('/api/orders/'+order.id+'/accept-release').set(auth())).status).toBe(200);
 for(let step=0;step<2;step++)expect((await ctx.api.post('/api/orders/'+order.id+'/release').set(auth()).send({bulk:[{item_id:product,quantity:1}]})).status).toBe(200);
 const complete=(await ctx.api.get('/api/orders/'+order.id).set(auth())).body;expect(complete.status).toBe('released');expect(complete.items[0].released_qty).toBe(2);
 expect((await ctx.api.post('/api/orders/'+order.id+'/release').set(auth()).send({bulk:[{item_id:product,quantity:1}]})).status).toBe(400);
 expect((await ctx.api.put('/api/release-slips/policy').set(auth()).send({authorization_required:false})).status).toBe(200);
 const release=()=>ctx.api.post('/api/orders/'+order.id+'/release-slip').set(auth()).set('Idempotency-Key','invoice-final-release').send({collected_by:'Audit driver',vehicle_plate:'TEST'});
 const first=await release();expect(first.status).toBe(201);const again=await release();expect(again.status).toBe(201);expect(again.body.id).toBe(first.body.id);
 const db=await import('../src/shared/db');expect(db.queryOne<{quantity:number}>('SELECT quantity FROM inventory_items WHERE id=?',product)!.quantity).toBe(18);
 expect((await ctx.api.get('/api/orders/'+order.id).set(auth())).body.status).toBe('confirmed');
 const original=(await ctx.api.get('/api/form-records/'+shipped.recordId).set(auth())).body;expect(original.data.total).toBe(112);expect(original.data.items[0].unit_price).toBe(50);expect(original.status).toBe('submitted');
});
