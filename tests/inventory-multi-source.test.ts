import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, createEmployee, login, setupApp, type TestContext } from './helpers';
let ctx:TestContext, token:string, first:number, second:number, seq=0;
const auth=()=>({Authorization:`Bearer ${token}`});
beforeAll(async()=>{ctx=await setupApp();token=await login(ctx.api);const locs=await ctx.api.get('/api/locations').set(auth());first=locs.body.find((l:{is_default:number})=>l.is_default).id;second=(await ctx.api.post('/api/locations').set(auth()).send({name:'Other warehouse',type:'warehouse'})).body.id;});
afterAll(()=>cleanup(ctx));
async function fixture(){const item=(await ctx.api.post('/api/inventory').set(auth()).send({name:'Split stock '+(++seq),quantity:8,unit:'pcs'})).body.id;expect((await ctx.api.post(`/api/inventory/${item}/adjust`).set(auth()).send({change:2,location_id:second})).status).toBe(200);return item;}
function body(){return {quantity:5,reason:'Issued for service',build_mode:'assembled',sources:[{location_id:first,quantity:3},{location_id:second,quantity:2}]};}
function send(id:number,payload:Record<string,any>,key='split-stock-'+(++seq)){return ctx.api.post(`/api/inventory/${id}/stock-out`).set(auth()).set('Idempotency-Key',key).send(payload);}
async function balances(id:number){return (await ctx.api.get(`/api/inventory/${id}`).set(auth())).body;}
describe('atomic optional Stock Out sources',()=>{
  it('deducts the explicit split and replays the original result once',async()=>{const id=await fixture(),key='split-retry-'+(++seq),payload=body();const r=await send(id,payload,key);expect(r.status).toBe(200);expect(r.body).toMatchObject({quantity:5,moved_quantity:5,sources:[{location_id:first,location_quantity:5},{location_id:second,location_quantity:0}]});const retry=await send(id,payload,key);expect(retry.status).toBe(200);expect(retry.headers['idempotency-replayed']).toBe('true');expect(retry.body).toEqual(r.body);expect((await balances(id)).history).toHaveLength(4);});
  it('deduplicates concurrent retries',async()=>{const id=await fixture(),payload=body(),key='split-concurrent-'+(++seq);const results=await Promise.all([send(id,payload,key),send(id,payload,key),send(id,payload,key)]);expect(results.map(r=>r.status)).toEqual([200,200,200]);expect((await balances(id)).quantity).toBe(5);expect((await balances(id)).history).toHaveLength(4);});
  it('rejects a changed body under the same key',async()=>{const id=await fixture(),key='split-changed-'+(++seq);expect((await send(id,body(),key)).status).toBe(200);expect((await send(id,{...body(),reason:'Changed'},key)).status).toBe(409);expect((await balances(id)).quantity).toBe(5);});
  it.each([
    ['below total',(p:any)=>({...p,quantity:6})],
    ['duplicate source',(p:any)=>({...p,sources:[{location_id:first,quantity:3},{location_id:first,quantity:2}]})],
    ['decimal',(p:any)=>({...p,quantity:5.5})],
    ['negative',(p:any)=>({...p,sources:[{location_id:first,quantity:6},{location_id:second,quantity:-1}]})],
    ['zero',(p:any)=>({...p,sources:[{location_id:first,quantity:5},{location_id:second,quantity:0}]})],
    ['empty',(p:any)=>({...p,sources:[]})],
  ])('rejects %s before stock changes',async(_name,mutate)=>{const id=await fixture();expect((await send(id,mutate(body()))).status).toBe(400);expect((await balances(id)).quantity).toBe(10);expect((await balances(id)).history).toHaveLength(2);});
  it('rejects an overdraw at either source even when the combined stock is enough',async()=>{const id=await fixture(),p=body();p.sources=[{location_id:first,quantity:2},{location_id:second,quantity:3}];expect((await send(id,p)).status).toBe(409);expect((await balances(id)).quantity).toBe(10);});
  it('validates every location before writing any source',async()=>{const id=await fixture(),p=body();p.sources[1]!.location_id=999999;expect((await send(id,p)).status).toBe(400);expect((await balances(id)).history).toHaveLength(2);});
  it('requires a durable key and the existing adjustment permission',async()=>{const id=await fixture();expect((await ctx.api.post(`/api/inventory/${id}/stock-out`).set(auth()).send(body())).status).toBe(400);const user=await createEmployee(ctx.api,token,{permissions:['inventory.view']});expect((await ctx.api.post(`/api/inventory/${id}/stock-out`).set('Authorization',`Bearer ${user.token}`).set('Idempotency-Key','split-forbidden-'+seq).send(body())).status).toBe(403);expect((await balances(id)).quantity).toBe(10);});
  it('hides semi-built behavior from parts and keeps finished-product build states separate',async()=>{const id=await fixture();expect((await send(id,{...body(),build_mode:'semi_built'})).status).toBe(400);const {run}=await import('../src/shared/db');run('UPDATE inventory_items SET is_finished_product=1 WHERE id=?',id);expect((await ctx.api.post(`/api/inventory/${id}/adjust`).set(auth()).send({change:4,location_id:first,build_mode:'semi_built'})).status).toBe(200);const r=await send(id,{...body(),quantity:4,build_mode:'semi_built',sources:[{location_id:first,quantity:4}]});expect(r.status).toBe(200);const detail=await balances(id);expect(detail.stock.find((s:any)=>s.location_id===first)).toMatchObject({assembled_quantity:8,semi_built_quantity:0});});
  it('rolls back earlier sources when a later write fails',async()=>{const id=await fixture(),{db}=await import('../src/shared/db');db.exec(`CREATE TRIGGER fail_second_source BEFORE UPDATE ON inventory_stock WHEN NEW.item_id=${id} AND NEW.location_id=${second} BEGIN SELECT RAISE(ABORT,'injected late source failure'); END;`);try{expect((await send(id,body())).status).toBe(500);}finally{db.exec('DROP TRIGGER fail_second_source');}expect((await balances(id)).quantity).toBe(10);expect((await balances(id)).history).toHaveLength(2);});
  it('rolls back stock if its retry receipt cannot be persisted',async()=>{const id=await fixture(),{db}=await import('../src/shared/db'),key='split-receipt-failure-'+(++seq);db.exec(`CREATE TRIGGER fail_stock_receipt BEFORE INSERT ON idempotency_keys WHEN NEW.key='${key}' BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END;`);try{expect((await send(id,body(),key)).status).toBe(500);}finally{db.exec('DROP TRIGGER fail_stock_receipt');}expect((await balances(id)).quantity).toBe(10);expect((await send(id,body(),key)).status).toBe(200);expect((await balances(id)).quantity).toBe(5);});
  it('publishes movable balances separately from on-hand stock',async()=>{const id=await fixture(),r=await ctx.api.get(`/api/inventory/${id}/stock`).set(auth());expect(r.status).toBe(200);expect(r.body.find((row:any)=>row.location_id===first)).toMatchObject({assembled_quantity:8,assembled_movable:8,semi_built_movable:0});});
  it('protects firm sale demand and counts reserved serial overlap once',async()=>{
    const id=await fixture(),{run}=await import('../src/shared/db');run('UPDATE inventory_items SET is_finished_product=1 WHERE id=?',id);
    const order=await ctx.api.post('/api/orders').set(auth()).send({type:'sale',status:'approved',location_id:first,customer_name:'Hold fixture',items:[{item_id:id,name:'Held fixture',quantity:3,unit_price:1}]});expect(order.status).toBe(201);
    const detail=(await ctx.api.get('/api/orders/'+order.body.id).set(auth())).body;
    const jo=Number(run("INSERT INTO job_orders(number,product_item_id,product_name,qty_ordered,status,output_location_id) VALUES(?,?,?,4,'completed',?)",'HOLD-JO-'+(++seq),id,'Hold fixture',first).lastInsertRowid);
    for(let i=0;i<4;i++)run("INSERT INTO job_order_units(job_order_id,product_item_id,identifier,status,location_id) VALUES(?,?,?,'in_stock',?)",jo,id,'HOLD-'+seq+'-'+i,first);
    let stock=(await ctx.api.get(`/api/inventory/${id}/stock`).set(auth())).body;expect(stock.find((r:any)=>r.location_id===first).assembled_movable).toBe(1);
    const blocked=await send(id,{...body(),quantity:4,sources:[{location_id:first,quantity:2},{location_id:second,quantity:2}]});expect(blocked.status).toBe(409);
    run("UPDATE job_order_units SET status='reserved',order_id=?,order_item_id=? WHERE id IN (SELECT id FROM job_order_units WHERE job_order_id=? ORDER BY id LIMIT 3)",order.body.id,detail.items[0].id,jo);
    stock=(await ctx.api.get(`/api/inventory/${id}/stock`).set(auth())).body;expect(stock.find((r:any)=>r.location_id===first).assembled_movable).toBe(4);
    expect((await send(id,body())).status).toBe(200);
  });

  it('requires JSON so every grouped request body is protected by its retry hash',async()=>{const id=await fixture();const r=await ctx.api.post(`/api/inventory/${id}/stock-out`).set(auth()).set('Idempotency-Key','split-form-'+(++seq)).type('form').send({quantity:5,reason:'Form body','sources[0][location_id]':first,'sources[0][quantity]':5});expect(r.status).toBe(415);expect((await balances(id)).quantity).toBe(10);});

});
