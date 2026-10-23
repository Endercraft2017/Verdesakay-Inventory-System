import {beforeAll,afterAll,it,expect} from 'vitest';
import {setupApp,cleanup,login,createEmployee,type TestContext} from './helpers';
let ctx:TestContext,token:string,other:string,db:typeof import('../src/shared/db');
const id='01M5KSTATUS0000000000000001';
beforeAll(async()=>{
 ctx=await setupApp();token=await login(ctx.api);other=(await createEmployee(ctx.api,token,{role:'warehouse'})).token;db=await import('../src/shared/db');
 const s=await import('../src/sync');s.enableSync(db.activeDb(),{role:'cloud',nodeNo:0});
 const {insertCommand}=await import('../src/sync/commands');insertCommand(db.activeDb(),{id,node_no:9,node_seq:1,hlc:null,occurred_at:'2026-10-23T00:00:00Z',occurred_date:'2026-10-23',actor_user_id:1,device_id:null,method:'POST',path:'/api/hr/periods/1/post-payroll-gl',body:'{}',sync_class:'claim',allocation_plan:'[]',app_version:'1.0.0',unattributed:0},{state:'received'});
});
afterAll(()=>cleanup(ctx));
const get=(command=id,actor=token)=>ctx.api.get('/api/sync/command/'+command).auth(actor,{type:'bearer'});
it('returns the durable received state rather than invented cloud confirmation',async()=>{const r=await get();expect(r.status).toBe(200);expect(r.body).toEqual({state:'received'});});
it('returns not found for an unknown cloud command',async()=>{expect((await get('unknown-payroll-command')).status).toBe(404);});
it('does not reveal another operator’s command state without management permission',async()=>{expect((await get(id,other)).status).toBe(404);});
it('requires an authenticated session',async()=>{expect((await ctx.api.get('/api/sync/command/'+id)).status).toBe(401);});
it('represents the actual rejected verdict and reason',async()=>{db.run("UPDATE sync_commands SET state='rejected',error='Synthetic validation refusal' WHERE id=?",id);expect((await get()).body).toEqual({state:'rejected',error:'Synthetic validation refusal'});});
it('preserves the successful cloud response shape for a decided command',async()=>{db.run("UPDATE sync_commands SET state='confirmed',error=NULL WHERE id=?",id);expect((await get()).body).toEqual({state:'confirmed'});});
