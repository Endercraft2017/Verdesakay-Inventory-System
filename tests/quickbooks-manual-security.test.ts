import {beforeAll,beforeEach,afterEach,afterAll,it,expect,vi} from 'vitest';
import {setupApp,cleanup,login,createEmployee,type TestContext} from './helpers';
import type {Order} from '../src/shared/types';
let ctx:TestContext,db:typeof import('../src/shared/db'),qbo:typeof import('../src/modules/quickbooks/quickbooks'),token:string,adminHash:string;
const h=()=>({Authorization:'Bearer '+token});
const preview=(id:number)=>ctx.api.get('/api/quickbooks/order/'+id+'/preview').set(h());
const push=async(id:number)=>{const p=await preview(id);expect(p.status).toBe(200);return ctx.api.post('/api/quickbooks/push/order/'+id).set(h()).send({connection_id:p.body.connection_id,order_stamp:p.body.order_stamp});};
async function order(){const r=await ctx.api.post('/api/orders').set(h()).send({type:'sale',customer_name:'Synthetic guarded customer',items:[{name:'Commercial item',quantity:1,unit_price:100}]});expect(r.status).toBe(201);return Number(r.body.id);}
function reply(method:string,p:string){if(p.startsWith('query'))return {QueryResponse:{}};const type=p==='invoice'?'Invoice':p==='customer'?'Customer':p==='bill'?'Bill':'Vendor';return {[type]:{Id:'synthetic-'+p,SyncToken:'1'}};}
beforeAll(async()=>{ctx=await setupApp();db=await import('../src/shared/db');qbo=await import('../src/modules/quickbooks/quickbooks');adminHash=db.queryOne<{password_hash:string}>("SELECT password_hash FROM users WHERE username='admin'")!.password_hash;});
beforeEach(async()=>{db.run("UPDATE users SET active=1,role='admin',permission_overrides='{}',password_hash=? WHERE username='admin'",adminHash);qbo.__qboMock.tokenResponder=()=>({access_token:'synthetic-access',refresh_token:'synthetic-refresh',expires_in:3600});qbo.__qboMock.reset();qbo.__qboMock.transport=null;qbo.disconnect();await qbo.completeConnect('synthetic','111');qbo.__qboMock.reset();for(const t of ['qbo_company_links','qbo_write_attempts','qbo_export_locks'])db.run('DELETE FROM '+t);token=await login(ctx.api);});
afterEach(()=>vi.restoreAllMocks());
afterAll(()=>cleanup(ctx));
it('requires recent proof before any provider call',async()=>{
 const id=await order();db.run("UPDATE session_stepups SET verified_at=datetime('now','-6 minutes')");const r=await push(id);expect(r.status).toBe(403);expect(r.body.step_up_required).toBe(true);expect(qbo.__qboMock.calls).toEqual([]);
});
it('exports CKD commercial parents once without pricing component rows a second time',async()=>{
 const id=await order();db.run("UPDATE order_items SET fulfillment_mode='ckd' WHERE order_id=?",id);const parent=db.queryOne<{id:number}>('SELECT id FROM order_items WHERE order_id=?',id)!.id;db.run("INSERT INTO order_items(order_id,name,quantity,unit_price,line_total,fulfillment_mode,parent_order_item_id) VALUES(?,'Synthetic CKD component',1,100,100,'ckd_component',?)",id,parent);
 expect((await push(id)).status).toBe(200);const post=qbo.__qboMock.calls.find(c=>c.path==='invoice')!;expect((post.body as any).Line).toHaveLength(1);expect((post.body as any).Line[0].Amount).toBe(100);
});

function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
it.each(['session','freshness','role','active','password','order','line'])('stops further calls when live %s changes during party lookup',async change=>{
 const id=await order(),wait=deferred<Response>();qbo.__qboMock.transport=async(m,p)=>p.startsWith('query')?wait.promise:new Response(JSON.stringify(reply(m,p)));
 const pending=push(id).then(r=>r);await vi.waitFor(()=>expect(qbo.__qboMock.calls.some(c=>c.path.startsWith('query'))).toBe(true));
 if(change==='session')db.run("UPDATE sessions SET ended_at=datetime('now') WHERE token=?",db.tokenDigest(token));
 if(change==='freshness')db.run("UPDATE session_stepups SET verified_at=datetime('now','-6 minutes')");
 if(change==='role')db.run("UPDATE users SET role='warehouse' WHERE username='admin'");
 if(change==='active')db.run("UPDATE users SET active=0 WHERE username='admin'");
 if(change==='password')db.run("UPDATE users SET password_hash='changed-credential' WHERE username='admin'");
 if(change==='order')db.run("UPDATE orders SET customer_name='Changed customer' WHERE id=?",id);
 if(change==='line')db.run('UPDATE order_items SET line_total=999 WHERE order_id=?',id);
 wait.resolve(new Response(JSON.stringify({QueryResponse:{}})));const r=await pending;expect(r.status).toBe(409);expect(r.body.error).toContain('authorization or order changed');
 expect(qbo.__qboMock.calls.filter(c=>c.method==='POST')).toEqual([]);expect(db.queryAll('SELECT * FROM qbo_export_locks')).toEqual([]);expect(db.queryAll("SELECT * FROM qbo_write_attempts WHERE state='pending'")).toEqual([]);
});
it('preserves an accepted party receipt but refuses the next financial write after revocation',async()=>{
 const id=await order(),wait=deferred<Response>();qbo.__qboMock.transport=async(m,p)=>p==='customer'?wait.promise:new Response(JSON.stringify(reply(m,p)));
 const pending=push(id).then(r=>r);await vi.waitFor(()=>expect(qbo.__qboMock.calls.some(c=>c.path==='customer')).toBe(true));db.run("UPDATE sessions SET ended_at=datetime('now') WHERE token=?",db.tokenDigest(token));
 wait.resolve(new Response(JSON.stringify({Customer:{Id:'accepted-party',SyncToken:'0'}})));expect((await pending).status).toBe(409);expect(qbo.__qboMock.calls.some(c=>c.path==='invoice')).toBe(false);
 expect(db.queryOne<{state:string}>("SELECT state FROM qbo_write_attempts WHERE operation_key LIKE 'customer:%'")!.state).toBe('succeeded');
 token=await login(ctx.api);qbo.__qboMock.transport=async(m,p)=>new Response(JSON.stringify(reply(m,p)));expect((await push(id)).status).toBe(200);expect(qbo.__qboMock.calls.filter(c=>c.path==='customer')).toHaveLength(1);
});
it('records a financial acceptance received after session revocation without inventing an unknown outcome',async()=>{
 const id=await order(),wait=deferred<Response>();qbo.__qboMock.transport=async(m,p)=>p==='invoice'?wait.promise:new Response(JSON.stringify(reply(m,p)));
 const pending=push(id).then(r=>r);await vi.waitFor(()=>expect(qbo.__qboMock.calls.some(c=>c.path==='invoice')).toBe(true));db.run("UPDATE sessions SET ended_at=datetime('now') WHERE token=?",db.tokenDigest(token));
 wait.resolve(new Response(JSON.stringify({Invoice:{Id:'accepted-invoice',SyncToken:'1'}})));const r=await pending;expect(r.status).toBe(200);expect(r.body.qbo_id).toBe('accepted-invoice');expect(db.queryOne<{state:string}>('SELECT state FROM qbo_write_attempts WHERE operation_key=?','order:'+id)!.state).toBe('succeeded');expect(qbo.orderLink(id)!.qbo_id).toBe('accepted-invoice');
});
it('rechecks authorization after token refresh, before transmitting any order or party data',async()=>{
 const id=await order(),wait=deferred<{access_token:string;refresh_token:string;expires_in:number}>();const encrypt=(await import('../src/shared/secrets')).encryptSecret;
 db.setSetting('qbo_tokens',encrypt(JSON.stringify({access_token:'expired',refresh_token:'synthetic-refresh',expires_at:0})));qbo.__qboMock.tokenResponder=()=>wait.promise;
 const pending=push(id).then(r=>r);await vi.waitFor(()=>expect(qbo.__qboMock.tokenCalls).toContain('refresh_token'));db.run("UPDATE sessions SET ended_at=datetime('now') WHERE token=?",db.tokenDigest(token));wait.resolve({access_token:'rotated-access',refresh_token:'rotated-refresh',expires_in:3600});
 expect((await pending).status).toBe(409);expect(qbo.__qboMock.calls).toEqual([]);expect(db.getSetting('qbo_tokens')).toBeTruthy();
});
it('does not retry a rejected financial POST after its actor was revoked during refresh',async()=>{
 const id=await order(),wait=deferred<{access_token:string;refresh_token:string;expires_in:number}>();qbo.__qboMock.tokenResponder=()=>wait.promise;
 qbo.__qboMock.transport=async(m,p)=>p==='customer'?new Response('{}',{status:401}):new Response(JSON.stringify(reply(m,p)));
 const pending=push(id).then(r=>r);await vi.waitFor(()=>expect(qbo.__qboMock.tokenCalls).toContain('refresh_token'));db.run("UPDATE sessions SET ended_at=datetime('now') WHERE token=?",db.tokenDigest(token));wait.resolve({access_token:'rotated-access',refresh_token:'rotated-refresh',expires_in:3600});
 expect((await pending).status).toBe(409);expect(qbo.__qboMock.calls.filter(c=>c.path==='customer')).toHaveLength(1);expect(qbo.__qboMock.calls.some(c=>c.path==='invoice')).toBe(false);expect(db.queryOne<{state:string}>("SELECT state FROM qbo_write_attempts WHERE operation_key LIKE 'customer:%'")!.state).toBe('uncertain');
});
it('permission denial precedes fresh-proof challenges and cannot be bypassed by forged flags',async()=>{
 const id=await order(),user=await createEmployee(ctx.api,token,{role:'admin_staff',permission_overrides:{'orders.edit':false}});const r=await ctx.api.post('/api/quickbooks/push/order/'+id).set('Authorization','Bearer '+user.token).send({verified:true,step_up_required:false});expect(r.status).toBe(403);expect(r.body.step_up_required).toBeUndefined();expect(qbo.__qboMock.calls).toEqual([]);
});
it.each(['purchase','job'])('protects %s exports and permits verified exact-action retry',async type=>{
 const id=await order();db.run('UPDATE orders SET type=? WHERE id=?',type,id);db.run("UPDATE session_stepups SET verified_at=datetime('now','-6 minutes')");expect((await push(id)).body.step_up_required).toBe(true);
 expect((await ctx.api.post('/api/auth/step-up').set(h()).send({password:'admin123-test-only'})).status).toBe(200);expect((await push(id)).body.qbo_type).toBe(type==='purchase'?'Bill':'Invoice');
});

it('does not accept a proof or session token from a different tenant',async()=>{
 const slug='manual-isolation';(await import('../src/platform/provisioning')).createTenant({slug,name:'Synthetic isolation',admin_username:'owner',admin_password:'Synthetic isolated owner password'});
 const other=await ctx.api.post('/api/auth/login').set('X-Tenant',slug).send({username:'owner',password:'Synthetic isolated owner password'});expect(other.status).toBe(200);
 const id=await order();expect((await ctx.api.post('/api/quickbooks/push/order/'+id).set('Authorization','Bearer '+other.body.token)).status).toBe(401);expect(qbo.__qboMock.calls).toEqual([]);
});

it.each(['different-company','same-company'])('refuses a destination changed before submission: %s',async kind=>{
 const id=await order(),prior=(await preview(id)).body;await qbo.completeConnect('synthetic-reconnect',kind==='different-company'?'222':'111');qbo.__qboMock.reset();
 const r=await ctx.api.post('/api/quickbooks/push/order/'+id).set(h()).send({connection_id:prior.connection_id,order_stamp:prior.order_stamp});expect(r.status).toBe(409);expect(qbo.__qboMock.calls).toEqual([]);
});
it.each([{},null,{connection_id:42},{connection_id:'invalid'}])('refuses missing or malformed destination binding %j',async body=>{
 const id=await order();expect((await ctx.api.post('/api/quickbooks/push/order/'+id).set(h()).set('Content-Type','application/json').send(body===null?'null':body)).status).toBe(400);expect(qbo.__qboMock.calls).toEqual([]);
});
it('permits an authorized exporter to see destination metadata without granting connection administration',async()=>{
 const id=await order(),user=await createEmployee(ctx.api,token,{role:'accounting'});const auth={Authorization:'Bearer '+user.token};const status=await ctx.api.get('/api/quickbooks/status').set(auth);expect(status.status).toBe(200);expect(status.body.connection_id).toBeTruthy();expect(JSON.stringify(status.body)).not.toContain('refresh_token');expect((await ctx.api.get('/api/quickbooks/connect').set(auth)).status).toBe(403);
 const p=await ctx.api.get('/api/quickbooks/order/'+id+'/preview').set(auth);expect(p.status).toBe(200);expect((await ctx.api.post('/api/quickbooks/push/order/'+id).set(auth).send({connection_id:status.body.connection_id,order_stamp:p.body.order_stamp})).status).toBe(200);
});

it('keeps displayed company and connection generation together across a status-read interleaving',async()=>{
 const before=qbo.getQboStatus(),original=db.queryOne;let changed=false;
 vi.spyOn(db,'queryOne').mockImplementation(((sql:string,...params:any[])=>{const row=original(sql,...params);if(sql.includes('AS configuration')&&!changed){changed=true;const c=db.getSetting<Record<string,unknown>>('qbo_config')!;db.setSetting('qbo_config',{...c,realm_id:'222',company_name:'Changed company'});db.setSetting('qbo_connection_id','44444444-4444-4444-8444-444444444444');}return row;}) as typeof db.queryOne);
 const observed=qbo.getQboStatus();expect(changed).toBe(true);expect(observed.connection_id).toBe(before.connection_id);expect(observed.company_name).toBe(before.company_name);expect(observed.realm_id).toBe('111');
});

it.each(['order','line'])('refuses a reviewed %s version changed before submission',async kind=>{
 const id=await order(),p=await preview(id);expect(p.status).toBe(200);expect(p.headers['cache-control']).toBe('no-store');
 if(kind==='order')db.run('UPDATE orders SET total=999 WHERE id=?',id);else db.run('UPDATE order_items SET line_total=999 WHERE order_id=?',id);
 const r=await ctx.api.post('/api/quickbooks/push/order/'+id).set(h()).send({connection_id:p.body.connection_id,order_stamp:p.body.order_stamp});expect(r.status).toBe(409);expect(qbo.__qboMock.calls).toEqual([]);
});
it('requires the reviewed order precondition rather than accepting a caller assertion',async()=>{
 const id=await order();const r=await ctx.api.post('/api/quickbooks/push/order/'+id).set(h()).send({connection_id:qbo.getQboStatus().connection_id});expect(r.status).toBe(400);expect(qbo.__qboMock.calls).toEqual([]);
});
