/** Synthetic CSR workflow; all writes go to setupApp's disposable SQLite DB. */
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';
let ctx: TestContext, admin: string, a: {id:number;token:string}, b: {id:number;token:string}, outsider: string;
let customer: number;
const hdr = (token = a.token) => ({Authorization:`Bearer ${token}`});
const get = (path: string, token = a.token) => ctx.api.get('/api'+path).set(hdr(token));
const post = (path: string, body: object, token = a.token) => ctx.api.post('/api'+path).set(hdr(token)).send(body);
const readCase = async (id:number) => (await get('/customer-cases/'+id)).body;
const draft = (extra: Record<string,unknown> = {}) => ({customer_id:customer,kind:'inquiry',summary:'Synthetic Messenger inquiry',status:'open',owner_id:a.id,next_action:'Reply with availability',due_at:'2026-10-23T09:00:00+08:00',sale_order_id:null,resolution:null,request_key:crypto.randomUUID(),...extra});
const makeCase = async(extra: Record<string,unknown> = {}) => {
  const r=await post('/customer-cases',draft(extra));expect(r.status,JSON.stringify(r.body)).toBe(201);return r.body.id as number;
};
const save = (id:number,body:object,token=a.token)=>ctx.api.put('/api/customer-cases/'+id).set(hdr(token)).send(body);
const sale = (extra: Record<string,unknown> = {}) => ({type:'sale',customer_id:customer,customer_name:'',customer_contact:'',status:'open',items:[{name:'Synthetic product',quantity:1,unit_price:125}],...extra});
beforeAll(async()=>{
  ctx=await setupApp();admin=await login(ctx.api);
  a=await createEmployee(ctx.api,admin,{role:'csr',username:'csr_a'});
  b=await createEmployee(ctx.api,admin,{role:'csr',username:'csr_b'});
  outsider=(await createEmployee(ctx.api,admin,{role:'hr',username:'outsider'})).token;
  const c=await post('/customers',{name:'Synthetic customer',phone:'+63 (912) 345-6789',email:' BUYER@EXAMPLE.TEST ',facebook_name:'Synthetic FB'});
  expect(c.status).toBe(201);customer=c.body.id;
});
afterAll(()=>cleanup(ctx));

describe('customer reliability',()=>{
  it('fills blank sale fields and rejects invalid customer IDs without saving an order',async()=>{
    const r=await post('/orders',sale());expect(r.status).toBe(201);
    expect((await get('/orders/'+r.body.id)).body).toMatchObject({customer_id:customer,customer_name:'Synthetic customer',customer_contact:'+63 (912) 345-6789'});
    const invalid=await post('/orders',sale({customer_id:999999}));expect(invalid.status).toBe(400);
  });
  it('preserves historical sale contact snapshots when the profile changes',async()=>{
    const c=await post('/customers',{name:'Original synthetic name',phone:'09000000001'});
    const order=await post('/orders',sale({customer_id:c.body.id}));
    expect((await ctx.api.put('/api/customers/'+c.body.id).set(hdr()).send({version:1,name:'Updated name',phone:'09000000002'})).status).toBe(200);
    expect((await get('/orders/'+order.body.id)).body).toMatchObject({customer_name:'Original synthetic name',customer_contact:'09000000001'});
  });
  it('suggests normalized and archived matches without merging separate people',async()=>{
    const c=(await get('/customers/'+customer)).body;
    expect((await ctx.api.put('/api/customers/'+customer).set(hdr()).send({version:c.version,archived:true})).status).toBe(200);
    expect((await get('/customers/matches?phone=09123456789')).body.map((x:{id:number})=>x.id)).toContain(customer);
    expect((await get('/customers/matches?email=buyer%40example.test')).body.map((x:{id:number})=>x.id)).toContain(customer);
    const separate=await post('/customers',{name:'Synthetic customer',phone:'09123456789'});expect(separate.body.id).not.toBe(customer);
    expect((await get('/customers?q=09123456789&archived=1')).body.length).toBe(2);
    const stale=await ctx.api.put('/api/customers/'+customer).set(hdr()).send({version:c.version,name:'Stale overwrite'});expect(stale.status).toBe(409);
  });
});

describe('complete shared CSR workflow',()=>{
  it('records inquiry → one sale → complaint → handover → resolution under one customer',async()=>{
    const inquiry=await makeCase();
    const payload=sale({case_id:inquiry,case_version:1,request_key:crypto.randomUUID()});
    const [first,retry]=await Promise.all([post('/orders',payload),post('/orders',payload)]);
    expect([first.status,retry.status].sort()).toEqual([200,201]);expect(retry.body.id).toBe(first.body.id);
    expect((await readCase(inquiry)).version).toBe(2);
    const complaint=await makeCase({kind:'complaint',summary:'Synthetic delivery concern',sale_order_id:first.body.id});
    const before=await readCase(complaint);
    expect((await save(complaint,{...before,owner_id:b.id,note:'Customer expects a call; handover to CSR B'})).status).toBe(200);
    expect((await get('/customer-cases',b.token)).body.some((c:{id:number})=>c.id===complaint)).toBe(true);
    expect((await get('/customer-cases')).body.some((c:{id:number})=>c.id===complaint)).toBe(false);
    expect((await save(complaint,{...before,summary:'Old owner edit'})).status).toBe(403);
    const handed=await readCase(complaint);
    expect((await save(complaint,{...handed,status:'resolved',resolution:'Customer confirmed replacement received'},b.token)).status).toBe(200);
    const resolved=await readCase(complaint);expect(resolved.next_action).toBeNull();expect(resolved.due_at).toBeNull();
    const history=(await get('/customers/'+customer+'/history')).body;
    expect(history.some((e:{kind:string})=>e.kind==='sale')).toBe(true);
    expect(history.some((e:{event_type:string;actor_name:string;created_at?:string;occurred_at:string})=>e.event_type==='handover'&&e.actor_name&&e.occurred_at)).toBe(true);
    expect((await get('/customers/'+customer+'/cases')).body.some((c:{id:number})=>c.id===complaint)).toBe(true);
    expect((await ctx.api.delete('/api/customers/'+customer).set(hdr(admin))).status).toBe(409);
    expect((await ctx.api.delete('/api/orders/'+first.body.id).set(hdr(admin))).status).toBe(409);
    expect((await get('/customers/'+customer)).body.archived).toBe(1);
    expect((await get('/tasks',b.token)).body).toEqual([]);
  });
  it('requires ownership, due time and next action, and a reason when closing',async()=>{
    for(const extra of [{next_action:''},{due_at:null},{due_at:'not-a-date'},{status:'resolved',resolution:''}]){
      expect((await post('/customer-cases',draft(extra))).status).toBe(400);
    }
    expect((await post('/customer-cases',draft({owner_id:999999}),admin)).status).toBe(400);
    expect((await post('/customer-cases',draft({owner_id:b.id}))).status).toBe(403);
  });
  it('rejects one of two simultaneous edits and preserves its history',async()=>{
    const id=await makeCase(), original=await readCase(id);
    const responses=await Promise.all([save(id,{...original,note:'first'}),save(id,{...original,note:'second'})]);
    expect(responses.map(r=>r.status).sort()).toEqual([200,409]);
    expect((await get('/customer-cases/'+id+'/events')).body).toHaveLength(2);
  });
  it('retries case creation safely and rejects changed payload with the same key',async()=>{
    const body=draft();const first=await post('/customer-cases',body);const retry=await post('/customer-cases',body);
    expect(retry.body.id).toBe(first.body.id);expect(retry.body.replayed).toBe(true);
    expect((await post('/customer-cases',{...body,summary:'changed'})).status).toBe(409);
  });
  it('rolls back a failed case save and a failed sale link with their history',async()=>{
    const {db,queryOne}=await import('../src/shared/db');
    const id=await makeCase(), before=await readCase(id);
    db.exec("CREATE TRIGGER fail_case_event BEFORE INSERT ON customer_case_events BEGIN SELECT RAISE(ABORT,'Synthetic event failure'); END");
    try{
      expect((await save(id,{...before,summary:'Must roll back'})).status).toBe(500);
      expect((await readCase(id)).summary).toBe(before.summary);
      const count=queryOne<{n:number}>('SELECT count(*) AS n FROM orders')!.n;
      expect((await post('/orders',sale({case_id:id,case_version:1}))).status).toBe(500);
      expect(queryOne<{n:number}>('SELECT count(*) AS n FROM orders')!.n).toBe(count);
      expect((await readCase(id)).sale_order_id).toBeNull();
    } finally {db.exec('DROP TRIGGER fail_case_event');}
    expect((await post('/orders',sale({case_id:id,case_version:1}))).status).toBe(201);
  });
  it('supports linking an existing sale and rejects sales of another customer',async()=>{
    const order=await post('/orders',sale());
    expect((await get('/customers/'+customer+'/sales?q='+order.body.number)).body.map((o:{id:number})=>o.id)).toContain(order.body.id);
    const id=await makeCase(); const c=await readCase(id);
    expect((await save(id,{...c,sale_order_id:order.body.id})).status).toBe(200);
    const other=await post('/customers',{name:'Another synthetic customer'});
    expect((await post('/customer-cases',draft({customer_id:other.body.id,sale_order_id:order.body.id}))).status).toBe(400);
    const current=await readCase(id);
    expect((await save(id,{...current,sale_order_id:null})).status).toBe(409);
  });
  it('deduplicates ordinary sale requests with a stable request key and rejects changed retries',async()=>{
    const body=sale({request_key:crypto.randomUUID()});const first=await post('/orders',body),retry=await post('/orders',body);
    expect(retry.body.id).toBe(first.body.id);
    expect((await post('/orders',{...body,notes:'different request'})).status).toBe(409);
  });
  it('enforces current permissions on cases, history, team queue and authenticated images',async()=>{
    const id=await makeCase();
    expect((await get('/customer-cases/'+id,outsider)).status).toBe(403);
    expect((await get('/customer-cases/'+id+'/events',outsider)).status).toBe(403);
    expect((await get('/customer-cases?scope=team')).status).toBe(403);
    expect((await get('/customer-cases?scope=team',admin)).status).toBe(200);
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT1kAAAAASUVORK5CYII=','base64');
    const attachment=await ctx.api.post('/api/attachments').set(hdr()).field('kind','customer_case').field('ref_id',id).attach('image',png,'receipt.png');
    expect(attachment.status).toBe(201);
    expect((await get('/attachments/'+attachment.body.id+'/image',outsider)).status).toBe(403);
    expect((await ctx.api.get('/api/attachments/'+attachment.body.id+'/image')).status).toBe(401);
    expect((await get('/attachments?kind=customer_case&ref_id='+id,b.token)).status).toBe(200);
    expect((await ctx.api.delete('/api/attachments/'+attachment.body.id).set(hdr(b.token))).status).toBe(403);
    const {run}=await import('../src/shared/db');
    run('UPDATE users SET permission_overrides=? WHERE id=?',JSON.stringify({'cases.view':false}),a.id);
    try {
      const r=await ctx.api.get('/api/customers/'+customer+'/history').set(hdr());
      expect(r.body.every((e:{kind:string})=>e.kind==='sale')).toBe(true);
      expect((await get('/customer-cases/'+id)).status).toBe(403);
      expect((await get('/attachments/'+attachment.body.id+'/image')).status).toBe(403);
    }finally{run("UPDATE users SET permission_overrides='{}' WHERE id=?",a.id);}
  });
  it('does not allow replay headers to bypass current authorization and keeps case events immutable',async()=>{
    const body=draft();
    const created=await ctx.api.post('/api/customer-cases/').set(hdr()).set('Idempotency-Key','synthetic-replay-key').send(body);
    expect(created.status).toBe(201);
    expect((await ctx.api.post('/api/customer-cases/').set(hdr(outsider)).set('Idempotency-Key','synthetic-replay-key').send(body)).status).toBe(403);
    const orderBody=sale({request_key:crypto.randomUUID()});
    const order=await ctx.api.post('/api/orders/').set(hdr()).set('Idempotency-Key','synthetic-order-key').send(orderBody);
    expect(order.status).toBe(201);
    expect((await ctx.api.post('/api/orders/').set('Idempotency-Key','synthetic-order-key').send(orderBody)).status).toBe(401);
    const {run}=await import('../src/shared/db');
    expect(()=>run('DELETE FROM customer_case_events WHERE case_id=?',created.body.id)).toThrow(/append-only/);
    expect(()=>run("UPDATE customer_case_events SET note='overwritten' WHERE case_id=?",created.body.id)).toThrow(/append-only/);
  });
  it('keeps due work visible without push subscriptions, including inactive-owner exceptions',async()=>{
    const id=await makeCase({due_at:'2020-01-01T00:00:00Z'});
    expect((await get('/customer-cases?before=2021-01-01T00:00:00Z')).body.some((c:{id:number})=>c.id===id)).toBe(true);
    const {run}=await import('../src/shared/db');run('UPDATE users SET active=0 WHERE id=?',a.id);
    try {
      expect((await get('/customer-cases?scope=team',admin)).body.some((c:{id:number;owner_inactive:number})=>c.id===id&&c.owner_inactive===1)).toBe(true);
      const c=(await get('/customer-cases/'+id,admin)).body;
      expect((await save(id,{...c,owner_id:b.id},admin)).status).toBe(200);
    }finally{run('UPDATE users SET active=1 WHERE id=?',a.id);}
  });
});
