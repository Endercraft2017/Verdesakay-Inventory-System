import {beforeAll,beforeEach,afterAll,it,expect,vi} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {setupApp,cleanup,login,createEmployee,type TestContext} from './helpers';
let ctx:TestContext,db:typeof import('../src/shared/db'),q:typeof import('../src/modules/quickbooks/quickbooks'),jobs:typeof import('../src/modules/quickbooks/export-jobs'),token:string;
const h=()=>({Authorization:`Bearer ${token}`});
async function create(){const r=await ctx.api.post('/api/orders').set(h()).send({type:'sale',customer_name:'Job customer',items:[{name:'Work',quantity:1,unit_price:10}]});expect(r.status).toBe(201);return r.body.id as number;}
function job(id:number){return db.queryOne<any>('SELECT * FROM qbo_export_jobs WHERE order_id=? ORDER BY updated_at DESC',id)!;}
beforeAll(async()=>{ctx=await setupApp();db=await import('../src/shared/db');q=await import('../src/modules/quickbooks/quickbooks');jobs=await import('../src/modules/quickbooks/export-jobs');token=await login(ctx.api);});
beforeEach(async()=>{for(const t of ['qbo_export_jobs','qbo_company_links','qbo_write_attempts','qbo_export_locks','qbo_refresh_locks','qbo_links'])db.run(`DELETE FROM ${t}`);q.__qboMock.transport=null;q.disconnect();await q.completeConnect('test-code','111');q.setAutoPush(true);q.__qboMock.reset();});
afterAll(()=>cleanup(ctx));
it('commits export intent with an order and never sends from its save handler',async()=>{
 const id=await create();expect(job(id).state).toBe('queued');expect(q.__qboMock.calls).toEqual([]);
 expect(await jobs.processOneExport()).toBe(true);expect(job(id)).toMatchObject({state:'succeeded',version:1,completed_version:1});
});
it('rolls back the entire save if durable intent cannot be persisted',async()=>{
 const before=db.queryOne<{n:number}>('SELECT COUNT(*) n FROM orders')!.n;
 db.run("CREATE TRIGGER reject_export_intent BEFORE INSERT ON qbo_export_jobs BEGIN SELECT RAISE(ABORT,'synthetic queue failure'); END");
 try{const r=await ctx.api.post('/api/orders').set(h()).send({type:'sale',items:[{name:'Work',quantity:1,unit_price:10}]});expect(r.status).toBe(500);}finally{db.run('DROP TRIGGER reject_export_intent');}
 expect(db.queryOne<{n:number}>('SELECT COUNT(*) n FROM orders')!.n).toBe(before);expect(q.__qboMock.calls).toEqual([]);
});
it('coalesces later edits made while an earlier snapshot is exporting',async()=>{
 const id=await create();let release!:(v:unknown)=>void;const original=q.__qboMock.responder;let blocked=false;
 q.__qboMock.transport=async(m,p,b)=>{if(p==='invoice'&&!blocked){blocked=true;await new Promise(resolve=>{release=resolve;});}return new Response(JSON.stringify(original(m,p,b)));};
 const pending=jobs.processOneExport();await vi.waitFor(()=>expect(blocked).toBe(true));
 const changed=await ctx.api.put('/api/orders/'+id).set(h()).send({items:[{name:'Work revised',quantity:1,unit_price:20}]});expect(changed.status).toBe(200);expect(job(id).version).toBe(2);
 expect(await jobs.processOneExport()).toBe(false);release(null);await pending;expect(job(id)).toMatchObject({state:'queued',completed_version:1,version:2});
 await jobs.processOneExport();expect(job(id)).toMatchObject({state:'succeeded',completed_version:2});
 const writes=q.__qboMock.calls.filter(c=>c.path==='invoice');expect(writes).toHaveLength(2);expect(writes[1]!.body).toHaveProperty('Id');
});
it('retries a read-side network failure with a persisted bounded delay',async()=>{
 const id=await create();q.__qboMock.transport=async()=>{throw new Error('network down');};await jobs.processOneExport();
 expect(job(id)).toMatchObject({state:'retry',attempts:1,error_code:'temporary_failure'});expect(await jobs.processOneExport()).toBe(false);
 db.run("UPDATE qbo_export_jobs SET next_attempt_at=datetime('now','-1 second')");q.__qboMock.transport=null;await jobs.processOneExport();expect(job(id).state).toBe('succeeded');
});
it('does not retry an uncertain sent write, even after another order save',async()=>{
 const id=await create(),original=q.__qboMock.responder;q.__qboMock.transport=async(m,p,b)=>{if(p==='invoice')throw new Error('remote acceptance unknown');return new Response(JSON.stringify(original(m,p,b)));};
 await jobs.processOneExport();expect(job(id)).toMatchObject({state:'blocked',error_code:'outcome_unknown'});jobs.enqueueOrderExport(id);expect(job(id).state).toBe('blocked');expect(await jobs.processOneExport()).toBe(false);
});
it('never retargets queued intent after a company reconnect',async()=>{
 const id=await create();await q.completeConnect('new-code','222');q.__qboMock.reset();await jobs.processOneExport();
 expect(job(id)).toMatchObject({state:'blocked',error_code:'connection_changed'});expect(q.__qboMock.calls).toEqual([]);
});
it('holds interrupted claims rather than stealing them based on age',async()=>{
 const id=await create();db.run("UPDATE qbo_export_jobs SET state='running',updated_at=datetime('now','-2 days')");expect(await jobs.processOneExport()).toBe(false);expect(job(id).state).toBe('running');
});
it('stops at the retry limit and obeys disabled automatic export',async()=>{
 const id=await create();db.run('UPDATE qbo_export_jobs SET attempts=4');q.__qboMock.transport=async()=>{throw new Error('offline');};await jobs.processOneExport();expect(job(id)).toMatchObject({state:'blocked',error_code:'retry_limit'});
 q.__qboMock.transport=null;db.run("UPDATE qbo_export_jobs SET state='queued'");q.setAutoPush(false);q.__qboMock.reset();await jobs.processOneExport();expect(job(id).error_code).toBe('automatic_export_disabled');expect(q.__qboMock.calls).toEqual([]);
});
it('exposes statuses only to administrators without worker IDs or credentials',async()=>{
 const id=await create();const r=await ctx.api.get('/api/quickbooks/exports').set(h());expect(r.status).toBe(200);expect(r.body.jobs.find((x:any)=>x.order_id===id)).not.toHaveProperty('worker_id');expect(r.body.counts.queued).toBe(1);expect(r.headers['cache-control']).toBe('no-store');
 const employee=await createEmployee(ctx.api,token,{role:'warehouse'});expect((await ctx.api.get('/api/quickbooks/exports').set('Authorization',`Bearer ${employee.token}`)).status).toBe(403);
});
it('retains durable pending intent on another connection to the database',async()=>{
 const id=await create(),other=new DatabaseSync(process.env.DB_PATH!);try{expect((other.prepare('SELECT state FROM qbo_export_jobs WHERE order_id=?').get(id) as {state:string}).state).toBe('queued');}finally{other.close();}
});
it('excludes pending export intent from sanitized node snapshots',async()=>{
 await create();const sync=await import('../src/sync');sync.enableSync(db.getDb('default'),{role:'cloud',nodeNo:0});const file=path.join(ctx.tmpDir,'jobs-snapshot.db');(await import('../src/sync/transport')).buildNodeSnapshot('default',file);
 const snapshot=new DatabaseSync(file);try{expect((snapshot.prepare('SELECT COUNT(*) n FROM qbo_export_jobs').get() as {n:number}).n).toBe(0);}finally{snapshot.close();}
});
it('allows fresh administrator resume only for safe failures on the original connection',async()=>{
 const id=await create(),scope=q.qboExportScope()!;
 db.run("UPDATE qbo_export_jobs SET state='blocked',error_code='outcome_unknown'");
 const endpoint=`/api/quickbooks/exports/${scope.connection_id}/${id}/retry`;
 expect((await ctx.api.post(endpoint).set(h())).status).toBe(409);expect(job(id).state).toBe('blocked');
 db.run("UPDATE qbo_export_jobs SET error_code='automatic_export_disabled'");
 expect((await ctx.api.post(endpoint).set(h())).status).toBe(200);await jobs.processOneExport();expect(job(id).state).toBe('succeeded');
});
it('does not enqueue or process cloud integration work on an installed node',async()=>{
 const id=await create();db.run('DELETE FROM qbo_export_jobs');const old=process.env.DEPLOY_MODE;process.env.DEPLOY_MODE='node';
 try{jobs.enqueueOrderExport(id);expect(await jobs.processOneExport()).toBe(false);expect(db.queryOne('SELECT 1 FROM qbo_export_jobs')).toBeUndefined();}finally{if(old===undefined)delete process.env.DEPLOY_MODE;else process.env.DEPLOY_MODE=old;}
});
