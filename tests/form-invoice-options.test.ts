import {beforeAll,afterAll,it,expect} from 'vitest';
import {setupApp,cleanup,login,type TestContext} from './helpers';
let ctx:TestContext,token:string,product:number,usd:number,customer:number,form:number;
const auth=()=>({Authorization:'Bearer '+token});
const fields=(currency='PHP')=>[
 {key:'customer',label:'Customer',type:'reference',source:'customer',required:true},
 {key:'billing',label:'Billing address',type:'textarea',binding:{field:'customer',property:'address',editable:true}},
 {key:'invoice_date',label:'Invoice date',type:'date',required:true},{key:'due_date',label:'Due date',type:'date'},
 {key:'items',label:'Items',type:'line_items',required:true,currency},
 {key:'total',label:'Total due',type:'calculated',format:'currency',currency,calculation:{operator:'sum',operands:['items.line_total']}},
 {key:'terms',label:'Payment terms',type:'textarea'}];
const actions=(currency='PHP')=>[{type:'create_sales_draft',run_on:'submitted',customer_field:'customer',items_field:'items',total_field:'total',date_field:'invoice_date',due_field:'due_date',notes_field:'terms',currency}];
const payload=(extra={})=>({form_def_id:form,status:'submitted',data:{customer,invoice_date:'2026-10-16',due_date:'2026-10-30',terms:'Net 14',items:[{row_id:'one',product_id:product,quantity:2,unit_price:99}],...extra}});
beforeAll(async()=>{
 ctx=await setupApp();token=await login(ctx.api);
 product=(await ctx.api.post('/api/inventory').set(auth()).send({name:'PHP product',attributes:{sale_price:100,currency:'PHP'}})).body.id;
 usd=(await ctx.api.post('/api/inventory').set(auth()).send({name:'USD product',attributes:{sale_price:40,currency:'USD'}})).body.id;
 customer=(await ctx.api.post('/api/customers').set(auth()).send({name:'Invoice customer',address:'Saved address'})).body.id;
 const saved=await ctx.api.post('/api/form-definitions').set(auth()).send({name:'Invoice option test',slug:'invoice_option',scope:'inventory',fields:fields(),actions:actions()});expect(saved.status).toBe(201);form=saved.body.id;
});
afterAll(()=>cleanup(ctx));
it('keeps money numeric, maps dates and terms to the order, and renders currency amounts consistently',async()=>{
 const made=await ctx.api.post('/api/form-records').set(auth()).send(payload());expect(made.status).toBe(201);
 const saved=(await ctx.api.get('/api/form-records/'+made.body.id).set(auth())).body;expect(saved.data.total).toBe(198);expect(saved.data.billing).toBe('Saved address');
 const order=(await ctx.api.get('/api/orders/'+saved.sales_order.order_id).set(auth())).body;expect(order).toMatchObject({currency:'PHP',order_date:'2026-10-16',total:198});expect(order.notes).toContain('Net 14');expect(order.notes).toContain('2026-10-30');
 const definition=(await ctx.api.get('/api/form-definitions/'+form).set(auth())).body,template=(await ctx.api.get('/api/templates/'+definition.template_id).set(auth())).body;
 const {renderDocument}=await import('../src/shared/doc-render');const output=renderDocument(template.body,{...saved.data,fields:saved.data},definition.template_id);
 expect(output.replaceAll('\u00a0',' ')).toContain('PHP 198.00');expect(output.replaceAll('\u00a0',' ')).toContain('PHP 99.00');expect(output).toContain('<td>2</td>');
});
it('rejects invalid or backwards dates atomically',async()=>{
 const db=await import('../src/shared/db');const count=()=>db.queryOne<{n:number}>("SELECT COUNT(*) AS n FROM orders")!.n,before=count();
 for(const dates of [{invoice_date:''},{invoice_date:'2026-02-30'},{due_date:'2026-10-15'},{due_date:'2026-13-01'}])expect((await ctx.api.post('/api/form-records').set(auth()).send(payload(dates))).status).toBe(400);
 expect(count()).toBe(before);
});
it('supports an explicit matching USD workflow and refuses cross-currency catalog selections or totals',async()=>{
 const made=await ctx.api.post('/api/form-definitions').set(auth()).send({name:'USD Invoice',slug:'usd_invoice',scope:'inventory',fields:fields('USD'),actions:actions('USD')});expect(made.status).toBe(201);
 const request=payload({items:[{row_id:'usd',product_id:usd,quantity:0.5,unit_price:40}]});request.form_def_id=made.body.id;
 const saved=await ctx.api.post('/api/form-records').set(auth()).send(request);expect(saved.status).toBe(201);expect((await ctx.api.get('/api/orders/'+saved.body.sales_order.order_id).set(auth())).body).toMatchObject({currency:'USD',total:20});
 expect((await ctx.api.post('/api/form-records').set(auth()).send(payload({items:[{row_id:'wrong',product_id:usd,catalog_currency:'PHP',unit_price:40,quantity:1}]}))).status).toBe(400);
 expect((await ctx.api.post('/api/form-definitions').set(auth()).send({name:'Wrong currency',slug:'wrong_currency',scope:'inventory',fields:fields('USD'),actions:actions('PHP')})).status).toBe(400);
});
it('validates money configuration rather than formatting arbitrary text or accepting injected currency codes',async()=>{
 for(const field of [{key:'x',label:'Bad',type:'text',format:'currency'},{key:'x',label:'Bad',type:'number',format:'currency',currency:'php'},{key:'x',label:'Bad',type:'number',currency:'PHP"'}])expect((await ctx.api.post('/api/form-definitions').set(auth()).send({name:'Bad',slug:'bad_money',scope:'inventory',fields:[field]})).status).toBe(400);
});


it('allocates distinct record numbers for different forms using the same prefix and ignores HTTP snapshot spoofing',async()=>{
 const made=await ctx.api.post('/api/form-definitions').set(auth()).send({name:'Another shared prefix',slug:'another_shared_prefix',scope:'inventory',fields:fields(),actions:actions()});expect(made.status).toBe(201);
 const request={...payload(),form_def_id:made.body.id,_form_reference_snapshot:{form_id:made.body.id,definition_version:1,values:{customer:{id:customer,name:'FORGED'}}}};
 const saved=await ctx.api.post('/api/form-records').set(auth()).send(request);expect(saved.status).toBe(201);
 const record=(await ctx.api.get('/api/form-records/'+saved.body.id).set(auth())).body;expect(record.data.customer.name).toBe('Invoice customer');
 const original=(await ctx.api.get('/api/form-definitions/'+form+'/records').set(auth())).body;expect(original.every((entry:any)=>entry.number!==record.number)).toBe(true);
});
