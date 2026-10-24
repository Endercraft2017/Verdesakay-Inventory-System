import {afterAll,beforeAll,expect,it} from 'vitest';
import {setupApp,cleanup,login,createEmployee,type TestContext} from './helpers';
let ctx:TestContext,token:string;
const hdr=(t=token)=>({Authorization:`Bearer ${t}`});
beforeAll(async()=>{ctx=await setupApp();token=await login(ctx.api);});afterAll(()=>cleanup(ctx));
async function item(body:any={}){const r=await ctx.api.post('/api/inventory').set(hdr()).send({name:'Label fixture',quantity:0,...body});expect(r.status).toBe(201);return r.body.id;}
it('replays creation without a SKU and applies initial stock once',async()=>{
 const payload={name:'No-SKU retry',quantity:7,unit:'pcs'},key='item-setup-create-once';
 const first=await ctx.api.post('/api/inventory').set(hdr()).set('Idempotency-Key',key).send(payload);
 const replay=await ctx.api.post('/api/inventory').set(hdr()).set('Idempotency-Key',key).send(payload);
 expect(first.status).toBe(201);expect(replay.status).toBe(201);expect(replay.body).toEqual(first.body);expect(replay.headers['idempotency-replayed']).toBe('true');
 const saved=(await ctx.api.get('/api/inventory/'+first.body.id).set(hdr())).body;expect(saved.quantity).toBe(7);expect(saved.history).toHaveLength(1);
 const {queryOne}=await import('../src/shared/db');expect(queryOne<any>("SELECT COUNT(*) n FROM inventory_items WHERE name='No-SKU retry'")!.n).toBe(1);
 expect((await ctx.api.post('/api/inventory').set(hdr()).set('Idempotency-Key',key).send({...payload,quantity:8})).status).toBe(409);
});
it('rolls back item, stock and receipt together when receipt persistence fails',async()=>{
 const {db,queryOne}=await import('../src/shared/db');db.exec("CREATE TEMP TRIGGER reject_setup_receipt BEFORE INSERT ON idempotency_keys WHEN NEW.key='item-setup-failed-receipt' BEGIN SELECT RAISE(ABORT, 'receipt failure'); END");
 try{expect((await ctx.api.post('/api/inventory').set(hdr()).set('Idempotency-Key','item-setup-failed-receipt').send({name:'Rollback setup item',quantity:4})).status).toBe(500);expect(queryOne("SELECT id FROM inventory_items WHERE name='Rollback setup item'")).toBeUndefined();}finally{db.exec('DROP TRIGGER reject_setup_receipt');}
});
it('merges only the generated barcode and leaves stock, costs and current metadata intact',async()=>{
 const id=await item({quantity:8,attributes:{spec:'M8',tags:'Parts',unit_cost:99}});
 await ctx.api.put('/api/inventory/'+id).set(hdr()).send({attributes:{spec:'Updated M8',tags:'Parts',unit_cost:99,notes:'Concurrent edit'}});
 const first=await ctx.api.put('/api/inventory/'+id+'/barcode').set(hdr()).set('Idempotency-Key','item-setup-barcode-once').send({barcode:'DEMO-SETUP-'+id});expect(first.status).toBe(200);expect(first.body).toEqual({id,barcode:'DEMO-SETUP-'+id});
 const replay=await ctx.api.put('/api/inventory/'+id+'/barcode').set(hdr()).set('Idempotency-Key','item-setup-barcode-once').send({barcode:'DEMO-SETUP-'+id});expect(replay.body).toEqual(first.body);
 const saved=(await ctx.api.get('/api/inventory/'+id).set(hdr())).body;expect(saved.attributes).toEqual({spec:'Updated M8',tags:'Parts',unit_cost:99,notes:'Concurrent edit',barcode:'DEMO-SETUP-'+id});expect(saved.quantity).toBe(8);expect(saved.history).toHaveLength(1);
});
it('cannot replace an existing label, collide with another item, or change unrelated fields',async()=>{
 const a=await item({sku:'DEMO-EXISTING-SETUP'}),b=await item();
 expect((await ctx.api.put('/api/inventory/'+a+'/barcode').set(hdr()).send({barcode:'REPLACE'})).status).toBe(409);
 expect((await ctx.api.put('/api/inventory/'+b+'/barcode').set(hdr()).send({barcode:'demo-existing-setup'})).status).toBe(409);
 expect((await ctx.api.put('/api/inventory/'+b+'/barcode').set(hdr()).send({barcode:'NEW',quantity:100})).status).toBe(400);
 expect((await ctx.api.put('/api/inventory/'+b+'/barcode').set(hdr()).send({barcode:''})).status).toBe(400);
});
it('keeps item creation, initial stock, location reads and barcode editing under their existing grants',async()=>{
 const creator=await createEmployee(ctx.api,token,{role:'employee'}),labeler=await createEmployee(ctx.api,token,{role:'employee'});
 await ctx.api.put('/api/users/'+creator.id+'/permissions').set(hdr()).send({overrides:{'inventory.create':true,'inventory.adjust':false,'inventory.view':false,'inventory.edit':false}});
 await ctx.api.put('/api/users/'+labeler.id+'/permissions').set(hdr()).send({overrides:{'inventory.adjust':true,'inventory.view':true,'inventory.edit':false}});
 expect((await ctx.api.post('/api/inventory').set(hdr(creator.token)).send({name:'Zero-only creation',quantity:0})).status).toBe(201);
 expect((await ctx.api.post('/api/inventory').set(hdr(creator.token)).send({name:'Forbidden stock',quantity:1})).status).toBe(403);
 expect((await ctx.api.get('/api/locations').set(hdr(creator.token))).status).toBe(403);
 const id=await item();expect((await ctx.api.put('/api/inventory/'+id+'/barcode').set(hdr(labeler.token)).send({barcode:'FORBIDDEN'})).status).toBe(403);
});
it('retains authority checks when replaying a creation receipt after access changes',async()=>{
 const user=await createEmployee(ctx.api,token,{role:'employee'});await ctx.api.put('/api/users/'+user.id+'/permissions').set(hdr()).send({overrides:{'inventory.create':true}});
 const body={name:'Original limited creator',quantity:0};expect((await ctx.api.post('/api/inventory').set(hdr(user.token)).set('Idempotency-Key','setup-access-change').send(body)).status).toBe(201);
 await ctx.api.put('/api/users/'+user.id+'/permissions').set(hdr()).send({overrides:{'inventory.create':false}});
 const replay=await ctx.api.post('/api/inventory').set(hdr(user.token)).set('Idempotency-Key','setup-access-change').send(body);expect(replay.status).toBe(409);expect(replay.body.code).toBe('saved_access_changed');
});
