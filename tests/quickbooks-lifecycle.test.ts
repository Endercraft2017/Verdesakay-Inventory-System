import {beforeAll,beforeEach,afterAll,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {setupApp,cleanup,login,type TestContext} from './helpers';
import type {Order} from '../src/shared/types';
let ctx:TestContext,db:typeof import('../src/shared/db'),qbo:typeof import('../src/modules/quickbooks/quickbooks');
let encrypt:typeof import('../src/shared/secrets').encryptSecret;
const defaultTokens=()=>({access_token:'synthetic-access',refresh_token:'synthetic-refresh-'+randomUUID(),expires_in:3600});
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
function order(id=1){return {id,type:'sale',customer_name:'Customer '+id,number:'SALE-'+id,total:10,tax_amount:0,notes:''} as Order;}
function expired(){db.setSetting('qbo_tokens',encrypt(JSON.stringify({access_token:'expired-access',refresh_token:'synthetic-refresh',expires_at:0})));}
function reply(method:string,p:string,realm='111'){
 if(p.startsWith('companyinfo/'))return {CompanyInfo:{CompanyName:'Company '+realm}};
 if(p.startsWith('query'))return {QueryResponse:{}};
 const kind=p==='invoice'?'Invoice':p==='bill'?'Bill':p==='customer'?'Customer':'Vendor';
 return {[kind]:{Id:realm+'-'+p,SyncToken:'1',DocNumber:'REMOTE-'+realm}};
}
function transport(){qbo.__qboMock.transport=async(m,p,_body,r)=>new Response(JSON.stringify(reply(m,p,r)),{status:200});}
beforeAll(async()=>{ctx=await setupApp();db=await import('../src/shared/db');qbo=await import('../src/modules/quickbooks/quickbooks');encrypt=(await import('../src/shared/secrets')).encryptSecret;});
beforeEach(async()=>{
 qbo.__qboMock.transport=null;qbo.__qboMock.tokenResponder=defaultTokens;
 for(const table of ['qbo_company_links','qbo_write_attempts','qbo_export_locks','qbo_refresh_locks','qbo_links'])db.run(`DELETE FROM ${table}`);
 qbo.disconnect();transport();await qbo.completeConnect('synthetic-code','111');qbo.__qboMock.reset();
});
afterAll(()=>cleanup(ctx));
it('shares one rotating refresh across simultaneous exports',async()=>{
 expired();const wait=deferred<ReturnType<typeof defaultTokens>>();qbo.__qboMock.tokenResponder=()=>wait.promise;
 const a=qbo.pushOrder(order(1),[]),b=qbo.pushOrder(order(2),[]);
 await vi.waitFor(()=>expect(qbo.__qboMock.tokenCalls).toEqual(['refresh_token']));wait.resolve(defaultTokens());
 expect((await Promise.all([a,b])).map(x=>x.qbo_type)).toEqual(['Invoice','Invoice']);
 expect(qbo.__qboMock.tokenCalls).toHaveLength(1);
});
it('disconnect during refresh cannot restore credentials or send a write',async()=>{
 expired();const wait=deferred<ReturnType<typeof defaultTokens>>();qbo.__qboMock.tokenResponder=()=>wait.promise;
 const result=qbo.pushOrder(order(),[]).catch(e=>e);await vi.waitFor(()=>expect(qbo.__qboMock.tokenCalls).toHaveLength(1));
 qbo.disconnect();wait.resolve(defaultTokens());expect(await result).toMatchObject({status:409});
 expect(db.getSetting('qbo_tokens')).toBe('');expect(qbo.qboConnected()).toBe(false);expect(qbo.__qboMock.calls).toEqual([]);
});
it('a delayed old refresh cannot replace a newer connection',async()=>{
 expired();const wait=deferred<ReturnType<typeof defaultTokens>>();qbo.__qboMock.tokenResponder=(grant)=>grant==='refresh_token'?wait.promise:defaultTokens();
 const result=qbo.pushOrder(order(),[]).catch(e=>e);await vi.waitFor(()=>expect(qbo.__qboMock.tokenCalls).toHaveLength(1));
 await qbo.completeConnect('new-code','222');const current=db.getSetting('qbo_tokens');wait.resolve(defaultTokens());
 expect(await result).toMatchObject({status:409});expect(db.getSetting('qbo_tokens')).toBe(current);expect(qbo.getQboStatus().realm_id).toBe('222');
});
it('does not overwrite a token rotated by a different process during refresh',async()=>{
 expired();const wait=deferred<ReturnType<typeof defaultTokens>>();qbo.__qboMock.tokenResponder=()=>wait.promise;
 const result=qbo.pushOrder(order(),[]).catch(e=>e);await vi.waitFor(()=>expect(qbo.__qboMock.tokenCalls).toHaveLength(1));
 const replacement=encrypt(JSON.stringify({access_token:'newer-access',refresh_token:'newer-refresh',expires_at:Date.now()+3600000}));db.setSetting('qbo_tokens',replacement);
 wait.resolve(defaultTokens());expect(await result).toMatchObject({status:409});expect(db.getSetting('qbo_tokens')).toBe(replacement);
});
it('a late 401 uses the newer credential without clearing it or refreshing again',async()=>{
 const wait=deferred<Response>();let first=true;
 qbo.__qboMock.transport=async(m,p,_body,r)=>{if(first&&p.startsWith('query')){first=false;return wait.promise;}return new Response(JSON.stringify(reply(m,p,r)));};
 const pending=qbo.pushOrder(order(),[]);await vi.waitFor(()=>expect(first).toBe(false));
 const replacement=encrypt(JSON.stringify({access_token:'already-rotated',refresh_token:'still-valid',expires_at:Date.now()+3600000}));db.setSetting('qbo_tokens',replacement);
 wait.resolve(new Response('',{status:401}));expect((await pending).qbo_id).toBe('111-invoice');expect(db.getSetting('qbo_tokens')).toBe(replacement);expect(qbo.__qboMock.tokenCalls).toEqual([]);
});
it('a failed refresh releases admission and a later valid retry succeeds',async()=>{
 expired();qbo.__qboMock.tokenResponder=()=>{throw new Error('synthetic network failure');};
 await expect(qbo.pushOrder(order(),[])).rejects.toMatchObject({status:502});
 qbo.__qboMock.tokenResponder=defaultTokens;expect((await qbo.pushOrder(order(),[])).qbo_type).toBe('Invoice');expect(qbo.__qboMock.tokenCalls).toHaveLength(2);
});
it('respects another process refresh lock without sending a second refresh',async()=>{
 expired();db.run('INSERT INTO qbo_refresh_locks(connection_id,lock_id) VALUES(?,?)',db.getSetting<string>('qbo_connection_id')!,randomUUID());
 await expect(qbo.pushOrder(order(),[])).rejects.toMatchObject({status:409});expect(qbo.__qboMock.tokenCalls).toEqual([]);
 await qbo.completeConnect('reconnect','111');expect((await qbo.pushOrder(order(),[])).qbo_type).toBe('Invoice');
});
it('serializes the entire order export, including different concurrent payloads',async()=>{
 const wait=deferred<Response>();qbo.__qboMock.transport=async(m,p,_body,r)=>p==='invoice'?wait.promise:new Response(JSON.stringify(reply(m,p,r)));
 const pending=qbo.pushOrder(order(),[]);await vi.waitFor(()=>expect(qbo.__qboMock.calls.some(c=>c.path==='invoice')).toBe(true));
 await expect(qbo.pushOrder({...order(),total:20},[])).rejects.toMatchObject({status:409});
 wait.resolve(new Response(JSON.stringify(reply('POST','invoice'))));await pending;
 expect(qbo.__qboMock.calls.filter(c=>c.path==='invoice')).toHaveLength(1);expect(db.queryOne<{n:number}>('SELECT COUNT(*) n FROM qbo_export_locks')!.n).toBe(0);
});
it('persists uncertain writes across reconnect and blocks blind duplicates',async()=>{
 qbo.__qboMock.transport=async(m,p,_body,r)=>{if(p==='invoice')throw new Error('timeout after remote acceptance');return new Response(JSON.stringify(reply(m,p,r)));};
 await expect(qbo.pushOrder(order(),[])).rejects.toMatchObject({status:502});
 expect(db.queryOne<{state:string}>("SELECT state FROM qbo_write_attempts WHERE operation_key='order:1'")!.state).toBe('uncertain');
 qbo.disconnect();transport();await qbo.completeConnect('reconnect','111');qbo.__qboMock.reset();
 await expect(qbo.pushOrder(order(),[])).rejects.toMatchObject({status:409});expect(qbo.__qboMock.calls).toEqual([]);
});
it('a malformed success response is uncertain, not permission to create another invoice',async()=>{
 qbo.__qboMock.transport=async(m,p,_body,r)=>new Response(JSON.stringify(p==='invoice'?{}:reply(m,p,r)));
 await expect(qbo.pushOrder(order(),[])).rejects.toMatchObject({status:502});await expect(qbo.pushOrder(order(),[])).rejects.toMatchObject({status:409});
 expect(qbo.orderLink(1)).toBeNull();
});
it('does not create a party when a lookup is malformed or ambiguous',async()=>{
 for(const response of [{},{QueryResponse:{Customer:[{Id:'one'},{Id:'two'}]}},{QueryResponse:{Customer:[{}]}}]){
  qbo.__qboMock.transport=async()=>new Response(JSON.stringify(response));
  await expect(qbo.pushOrder(order(),[])).rejects.toMatchObject({status:502});
 }
 expect(qbo.__qboMock.calls.every(c=>c.method==='GET')).toBe(true);
});
it('a definite provider rejection is retryable and its raw body never escapes',async()=>{
 qbo.__qboMock.transport=async(m,p,_body,r)=>p==='invoice'?new Response('PRIVATE_PROVIDER_BODY',{status:400}):new Response(JSON.stringify(reply(m,p,r)));
 const error=await qbo.pushOrder(order(),[]).catch(e=>e);expect(error.message).not.toContain('PRIVATE_PROVIDER_BODY');
 expect(db.queryOne<{state:string}>("SELECT state FROM qbo_write_attempts WHERE operation_key='order:1'")!.state).toBe('failed');
 transport();expect((await qbo.pushOrder(order(),[])).qbo_id).toBe('111-invoice');
});
it('does not save a stale party query or continue export after reconnect',async()=>{
 const wait=deferred<Response>();qbo.__qboMock.transport=async(m,p,_body,r)=>p.startsWith('query')?wait.promise:new Response(JSON.stringify(reply(m,p,r)));
 const pending=qbo.pushOrder(order(),[]).catch(e=>e);await vi.waitFor(()=>expect(qbo.__qboMock.calls.some(c=>c.path.startsWith('query'))).toBe(true));
 await qbo.completeConnect('new-code','222');wait.resolve(new Response(JSON.stringify({QueryResponse:{Customer:[{Id:'old-party'}]}})));
 expect(await pending).toMatchObject({status:409});expect(qbo.__qboMock.calls.some(c=>c.path==='invoice')).toBe(false);
 expect(db.queryOne<{n:number}>('SELECT COUNT(*) n FROM qbo_company_links')!.n).toBe(0);
});
it('late invoice acceptance cannot attach an old company record to the new company',async()=>{
 const wait=deferred<Response>();qbo.__qboMock.transport=async(m,p,_body,r)=>p==='invoice'?wait.promise:new Response(JSON.stringify(reply(m,p,r)));
 const pending=qbo.pushOrder(order(),[]).catch(e=>e);await vi.waitFor(()=>expect(qbo.__qboMock.calls.some(c=>c.path==='invoice')).toBe(true));
 qbo.disconnect();transport();await qbo.completeConnect('new-code','222');wait.resolve(new Response(JSON.stringify(reply('POST','invoice','111'))));
 expect(await pending).toMatchObject({status:409});expect(qbo.orderLink(1)).toBeNull();
 expect((await qbo.pushOrder(order(),[])).qbo_id).toBe('222-invoice');
});
it('keeps record IDs separate across companies and safely reuses them on returning',async()=>{
 expect((await qbo.pushOrder(order(),[])).qbo_id).toBe('111-invoice');
 await qbo.completeConnect('other','222');expect(qbo.orderLink(1)).toBeNull();qbo.__qboMock.reset();
 expect((await qbo.pushOrder(order(),[])).qbo_id).toBe('222-invoice');
 expect(qbo.__qboMock.calls.find(c=>c.path==='invoice')!.body).not.toHaveProperty('Id');
 await qbo.completeConnect('return','111');expect(qbo.orderLink(1)!.qbo_id).toBe('111-invoice');qbo.__qboMock.reset();
 expect((await qbo.pushOrder(order(),[])).updated).toBe(true);expect(qbo.__qboMock.calls.find(c=>c.path==='invoice')!.body).toHaveProperty('Id','111-invoice');
});
it('retains and quarantines unbound legacy record IDs before any external write',async()=>{
 db.run("INSERT INTO qbo_links(entity,local_id,qbo_type,qbo_id) VALUES('order','1','Invoice','unbound-record')");
 await expect(qbo.pushOrder(order(),[])).rejects.toMatchObject({status:409});expect(qbo.__qboMock.calls).toEqual([]);
 expect(db.queryOne<{qbo_id:string}>('SELECT qbo_id FROM qbo_links')!.qbo_id).toBe('unbound-record');
});
it('uses a successful durable response to update a missing local link instead of creating a duplicate',async()=>{
 await qbo.pushOrder(order(),[]);db.run("DELETE FROM qbo_company_links WHERE entity='order'");qbo.__qboMock.reset();
 expect((await qbo.pushOrder({...order(),total:20},[])).qbo_id).toBe('111-invoice');expect(qbo.__qboMock.calls.find(c=>c.path==='invoice')!.body).toHaveProperty('Id','111-invoice');
});
it('rolls back credentials, company and generation together on a failed connection commit',async()=>{
 const original={tokens:db.getSetting('qbo_tokens'),config:db.getSetting('qbo_config'),id:db.getSetting('qbo_connection_id')};
 db.run("CREATE TRIGGER reject_qbo_config BEFORE UPDATE ON settings WHEN NEW.key='qbo_config' BEGIN SELECT RAISE(ABORT,'synthetic storage failure'); END");
 try {await expect(qbo.completeConnect('new-code','222')).rejects.toThrow('synthetic storage failure');}
 finally {db.run('DROP TRIGGER reject_qbo_config');}
 expect({tokens:db.getSetting('qbo_tokens'),config:db.getSetting('qbo_config'),id:db.getSetting('qbo_connection_id')}).toEqual(original);
});
it('never expires an interrupted export lock automatically',async()=>{
 db.run("INSERT INTO qbo_export_locks(company_key,order_id,lock_id,started_at) VALUES('sandbox:111',1,?,datetime('now','-2 days'))",randomUUID());
 await expect(qbo.pushOrder(order(),[])).rejects.toMatchObject({status:409});expect(qbo.__qboMock.calls).toEqual([]);
});
it('invalid token responses fail closed and cannot replace the current connection',async()=>{
 const original=db.getSetting('qbo_tokens');
 for(const invalid of [{refresh_token:'x'},{access_token:'x'},{access_token:'x',refresh_token:'y',expires_in:Infinity},{access_token:'x',refresh_token:'y',expires_in:1e100}]){
  qbo.__qboMock.tokenResponder=()=>invalid;await expect(qbo.completeConnect('code','222')).rejects.toMatchObject({status:502});expect(db.getSetting('qbo_tokens')).toBe(original);
 }
 await expect(qbo.completeConnect('code','invalid/realm')).rejects.toMatchObject({status:400});
});
it('keeps delayed operations and refresh admission isolated between tenant databases',async()=>{
 const wait=deferred<ReturnType<typeof defaultTokens>>();expired();qbo.__qboMock.tokenResponder=(grant)=>grant==='refresh_token'?wait.promise:defaultTokens();
 const pending=qbo.pushOrder(order(),[]);await vi.waitFor(()=>expect(qbo.__qboMock.tokenCalls).toHaveLength(1));
 await db.withTenant('other',async()=>{await qbo.completeConnect('other-code','222');expect((await qbo.pushOrder(order(),[])).qbo_id).toBe('222-invoice');});
 wait.resolve(defaultTokens());expect((await pending).qbo_id).toBe('111-invoice');expect(qbo.orderLink(1)!.qbo_id).toBe('111-invoice');
 await db.withTenant('other',async()=>expect(qbo.orderLink(1)!.qbo_id).toBe('222-invoice'));
});
it('cannot replay an old HTTP success as an export into a newer company connection',async()=>{
 const token=await login(ctx.api),key=randomUUID();
 const created=await ctx.api.post('/api/orders').set('Authorization',`Bearer ${token}`).send({type:'sale',customer_name:'HTTP cache company',items:[{name:'Item',quantity:1,unit_price:10}]});expect(created.status).toBe(201);
 const endpoint=`/api/quickbooks/push/order/${created.body.id}`;
 expect((await ctx.api.post(endpoint).set('Authorization',`Bearer ${token}`).set('Idempotency-Key',key)).status).toBe(200);
 qbo.disconnect();await qbo.completeConnect('new-code','222');qbo.__qboMock.reset();
 const replay=await ctx.api.post(endpoint).set('Authorization',`Bearer ${token}`).set('Idempotency-Key',key);
 expect(replay.status).toBe(409);expect(replay.headers['idempotency-replayed']).toBeUndefined();expect(qbo.__qboMock.calls).toEqual([]);
});
it('does not cache a temporary accounting conflict after the operation becomes available',async()=>{
 const token=await login(ctx.api),key=randomUUID();
 const created=await ctx.api.post('/api/orders').set('Authorization',`Bearer ${token}`).send({type:'sale',customer_name:'HTTP retry customer',items:[{name:'Item',quantity:1,unit_price:10}]});expect(created.status).toBe(201);
 const id=created.body.id,endpoint=`/api/quickbooks/push/order/${id}`;
 db.run('INSERT INTO qbo_export_locks(company_key,order_id,lock_id) VALUES(?,?,?)','sandbox:111',id,randomUUID());
 expect((await ctx.api.post(endpoint).set('Authorization',`Bearer ${token}`).set('Idempotency-Key',key)).status).toBe(409);
 db.run('DELETE FROM qbo_export_locks WHERE order_id=?',id);
 expect((await ctx.api.post(endpoint).set('Authorization',`Bearer ${token}`).set('Idempotency-Key',key)).status).toBe(200);
});
it('strips accounting links, attempts and locks from the node snapshot',async()=>{
 await qbo.pushOrder(order(),[]);const sync=await import('../src/sync');sync.enableSync(db.getDb('default'),{role:'cloud',nodeNo:0});
 const file=path.join(ctx.tmpDir,'qbo-sanitized.db');(await import('../src/sync/transport')).buildNodeSnapshot('default',file);
 const snapshot=new DatabaseSync(file);try{for(const table of ['qbo_company_links','qbo_write_attempts','qbo_export_locks','qbo_refresh_locks']){expect(sync.isNodeLocalTable(table)).toBe(true);expect((snapshot.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as {n:number}).n).toBe(0);}}finally{snapshot.close();}
});
