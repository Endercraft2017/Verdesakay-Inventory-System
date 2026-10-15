import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {setupApp,cleanup,login,createEmployee,type TestContext} from './helpers';
let ctx:TestContext,token:string,restricted:string,product:number,form:number,record:number;
const auth=(value=token)=>({Authorization:'Bearer '+value});
const fields=[{key:'product',label:'Product',type:'reference',source:'product',required:true},{key:'unit',label:'Unit',type:'text',binding:{field:'product',property:'unit',editable:false}},{key:'price',label:'Price',type:'number',required:true,binding:{field:'product',property:'sale_price',editable:true}},{key:'company',label:'Company',type:'system',source:'company',property:'name'}];
const definition={name:'Connected invoice',slug:'connected_invoice',number_prefix:'CI',scope:'inventory',fields,actions:[]};
beforeAll(async()=>{
 ctx=await setupApp();token=await login(ctx.api);
 restricted=(await createEmployee(ctx.api,token,{role:'releasing_clerk'})).token;
 const created=await ctx.api.post('/api/inventory').set(auth()).send({name:'Connected product',sku:'CP',unit:'box',attributes:{sale_price:125.5},unit_cost:20});expect(created.status).toBe(201);product=created.body.id;
 const response=await ctx.api.post('/api/form-definitions').set(auth()).send(definition);expect(response.status).toBe(201);form=response.body.id;
});
afterAll(()=>cleanup(ctx));
it('offers safe source fields and enforces source permissions independently of form access',async()=>{
 const catalog=await ctx.api.get('/api/data-forms/sources').set(auth());expect(catalog.status).toBe(200);
 expect(catalog.body.find((s:any)=>s.key==='product').fields).toContain('sale_price');expect(catalog.body.find((s:any)=>s.key==='product').fields).not.toContain('unit_cost');
 expect((await ctx.api.get('/api/data-forms/sources/product').set(auth(restricted))).status).toBe(403);
 expect((await ctx.api.get('/api/data-forms/sources/secret_table').set(auth())).status).toBe(404);
 expect((await ctx.api.get('/api/data-forms/sources/product?id=-1').set(auth())).status).toBe(400);
});
it('searches products and returns sale price without exposing cost or raw attributes',async()=>{
 const response=await ctx.api.get('/api/data-forms/sources/product?q=CP').set(auth());expect(response.status).toBe(200);
 expect(response.body).toContainEqual(expect.objectContaining({id:product,name:'Connected product',unit:'box',sale_price:125.5}));expect(response.body[0]).not.toHaveProperty('unit_cost');expect(response.body[0]).not.toHaveProperty('attributes');
});
it('resolves trusted snapshots, prevents spoofed locked values and permits explicit editable amounts',async()=>{
 const response=await ctx.api.post('/api/form-records').set(auth()).send({form_def_id:form,data:{product:{id:product,name:'Spoofed',sale_price:1},unit:'wrong',price:99,company:'Spoofed company'}});expect(response.status).toBe(201);record=response.body.id;
 const saved=(await ctx.api.get('/api/form-records/'+record).set(auth())).body;
 expect(saved.data.product).toMatchObject({id:product,name:'Connected product',sale_price:125.5});expect(saved.data.unit).toBe('box');expect(saved.data.price).toBe(99);expect(saved.data.company).not.toBe('Spoofed company');
});
it('retains original snapshots and manually agreed prices after catalog changes',async()=>{
 const db=await import('../src/shared/db');db.run('UPDATE inventory_items SET name=?,unit=?,attributes=? WHERE id=?','Renamed product','piece',JSON.stringify({sale_price:300}),product);
 const before=(await ctx.api.get('/api/form-records/'+record).set(auth())).body;
 const response=await ctx.api.put('/api/form-records/'+record).set(auth()).send({expected_revision:before.revision,data:{...before.data,product:{id:product,name:'Injected'},unit:'tampered'}});expect(response.status).toBe(200);
 const saved=(await ctx.api.get('/api/form-records/'+record).set(auth())).body.data;
 expect(saved.product.name).toBe('Connected product');expect(saved.unit).toBe('box');expect(saved.price).toBe(99);
});
it('rejects missing, deleted and forged record selections',async()=>{
 for(const value of ['',-4,999999,{id:product+999999,name:'Fake'}]){
  expect((await ctx.api.post('/api/form-records').set(auth()).send({form_def_id:form,data:{product:value}})).status).toBe(400);
 }
});
it('validates binding paths and dependency references instead of accepting arbitrary system paths',async()=>{
 for(const binding of [{field:'missing',property:'unit',editable:false},{field:'product',property:'unit_cost',editable:false}]) {
  expect((await ctx.api.post('/api/form-definitions').set(auth()).send({...definition,slug:'bad_binding',fields:[fields[0],{...fields[1],binding}]})).status).toBe(400);
 }
});
it('requires a price when a product has no configured sale price; zero remains valid',async()=>{
 const empty=await ctx.api.post('/api/inventory').set(auth()).send({name:'Unpriced',unit:'unit'});
 expect((await ctx.api.post('/api/form-records').set(auth()).send({form_def_id:form,data:{product:empty.body.id}})).status).toBe(400);
 expect((await ctx.api.post('/api/form-records').set(auth()).send({form_def_id:form,data:{product:empty.body.id,price:0}})).status).toBe(201);
});

it('queries every supported provider and applies accounting permissions and module entitlements',async()=>{
 const catalog=(await ctx.api.get('/api/data-forms/sources').set(auth())).body;
 for(const source of catalog){const response=await ctx.api.get('/api/data-forms/sources/'+source.key).set(auth());expect(response.status,source.key).toBe(200);if(response.body[0]?.id)expect((await ctx.api.get('/api/data-forms/sources/'+source.key+'?id='+response.body[0].id).set(auth())).status).toBe(200);}
 expect((await ctx.api.get('/api/data-forms/sources/account').set(auth(restricted))).status).toBe(403);
 const modules=await import('../src/shared/modules');const original=modules.moduleEnabled;const mock=vi.spyOn(modules,'moduleEnabled').mockImplementation((name,...rest)=>name==='inventory'?false:original(name,...rest));
 try{expect((await ctx.api.get('/api/data-forms/sources/product').set(auth())).status).toBe(403);}finally{mock.mockRestore();}
});
it('protects employee self-service forms from unsupported connected controls',async()=>{
 const forms=(await ctx.api.get('/api/form-definitions').set(auth())).body;let leave=forms.find((value:any)=>value.slug==='leave_request');
 if(!leave){const created=await ctx.api.post('/api/form-definitions').set(auth()).send({name:'Leave request',slug:'leave_request',number_prefix:'LR',scope:'hr',fields:[]});expect(created.status).toBe(201);leave={id:created.body.id,name:'Leave request',slug:'leave_request',number_prefix:'LR',scope:'hr',fields:[]};}
 expect((await ctx.api.put('/api/form-definitions/'+leave.id).set(auth()).send({...leave,fields:[...leave.fields,fields[0]]})).status).toBe(400);
});

it('keeps custom fields named company distinct from the system company in generated print layouts',async()=>{
 const saved=(await ctx.api.get('/api/form-records/'+record).set(auth())).body;
 const definition=(await ctx.api.get('/api/form-definitions/'+form).set(auth())).body;
 const template=(await ctx.api.get('/api/templates/'+definition.template_id).set(auth())).body;
 expect(template.body).toContain('{{fields.company}}');expect(template.body).toContain('<div>Received by</div>');expect(template.body).not.toContain('Received by (Employee)');
 const {renderDocument}=await import('../src/shared/doc-render');
 const output=renderDocument(template.body,{...saved.data,fields:{...saved.data,company:'Captured form company'},company:{name:'Current system company'}},definition.template_id);
 expect(output).toContain('Captured form company');expect(output).toContain('Current system company');expect(output).not.toContain('[object Object]');
});
