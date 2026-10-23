import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {setupSiteTrio,type SiteTrio} from './sync-helpers';
import {cleanup} from './helpers';
let trio:SiteTrio;
const periods:number[]=[];
beforeAll(async()=>{
 trio=await setupSiteTrio(async({api,cloudHdr})=>{
  expect((await api.post('/api/accounting/ledger/setup').set(cloudHdr()).send({fiscal_year_start:'2026-01-01'})).status).toBe(201);
  const d=await import('../src/shared/db'),employee=Number(d.run("INSERT INTO employees(employee_no,name) VALUES('GL-SYNC-RETRY','Synthetic offline posting')").lastInsertRowid);
  const form=d.queryOne<{id:number}>("SELECT id FROM form_definitions WHERE slug='hr_payroll'")!.id;
  for(let i=0;i<8;i++){
   const label='GL-SYNC-RETRY-'+i,id=Number(d.run("INSERT INTO attendance_periods(label,start_date,end_date) VALUES(?,'2026-07-01','2026-07-15')",label).lastInsertRowid);
   d.run("INSERT INTO form_records(form_def_id,number,data,status,period,created_by) VALUES(?,?,?,'draft',?,1)",form,label,JSON.stringify({employee_id:employee,employee_name:'Synthetic offline posting',cutoff_id:id,payroll_period:label,pay_date:'2026-07-15',total_earnings:1000,net_pay:1000}),label);
   periods.push(id);
  }
 });
 expect((await trio.ctx.api.put('/api/sync/sites').set(trio.cloudHdr()).send({main_host:trio.hostNo})).status).toBe(200);
 await trio.hostRound();trio.cutOff('host');
},90000);
afterAll(()=>{trio?.close();if(trio)cleanup(trio.ctx);});
const p=(i:number)=>({id:periods[i]!,label:'GL-SYNC-RETRY-'+i});
const post=(i:number,key?:string)=>{const s=p(i),request=trio.ctx.api.post(`/api/hr/periods/${s.id}/post-payroll-gl`).set(trio.hostHdr());if(key)request.set('Idempotency-Key',key);return request.send({payroll_period:s.label});};
const journals=(i:number)=>trio.hostDb().prepare("SELECT id,number FROM journal_entries WHERE source_type='payroll_run' AND source_id=?").all(p(i).id);
const commands=(i:number)=>trio.hostDb().prepare("SELECT id,state FROM sync_commands WHERE path=?").all(`/api/hr/periods/${p(i).id}/post-payroll-gl`);
function commandId(r:{headers:Record<string,string|undefined>}):string{const id=r.headers['x-sync-command'];expect(typeof id).toBe('string');if(!id)throw new Error('Expected durable command header');return id;}

it('keeps the offline posting and explicit re-post through normal cloud replay',async()=>{
 const key='gl-sync-confirmed-replay',first=await post(6,key);expect(first.status).toBe(201);expect(first.headers['x-sync-state']).toBe('local');
 trio.reconnect('host');let round=await trio.hostRound();expect(round.pushed.filter(x=>x.state!=='confirmed')).toEqual([]);
 const same=await post(6,key);expect(same.status).toBe(201);expect(same.headers['x-sync-command']).toBe(first.headers['x-sync-command']);expect(same.headers['x-sync-state']).toBe('confirmed');expect(same.body.entry.id).toBe(first.body.entry.id);expect(journals(6)).toHaveLength(1);
 const cloudCount=()=>Number((trio.cloudDb().prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE source_type='payroll_run' AND source_id=?").get(p(6).id) as {n:number}).n);
 expect(cloudCount()).toBe(1);
 trio.cutOff('host');expect((await post(6,'gl-sync-explicit-repost')).status).toBe(201);expect(journals(6)).toHaveLength(3);
 trio.reconnect('host');round=await trio.hostRound();expect(round.pushed.filter(x=>x.state!=='confirmed')).toEqual([]);expect(cloudCount()).toBe(3);expect(journals(6)).toHaveLength(3);
 trio.cutOff('host');
});

it('rolls back local source, receipt and numbering when its command cannot be recorded',async()=>{
 const conn=trio.hostDb();conn.exec("CREATE TRIGGER gl_sync_retry_fail BEFORE INSERT ON sync_commands WHEN NEW.path LIKE '%/post-payroll-gl' BEGIN SELECT RAISE(ABORT,'private synthetic command fault'); END");
 let r;try{r=await post(0,'gl-sync-command-fault');}finally{conn.exec('DROP TRIGGER gl_sync_retry_fail');}
 expect(r.status).toBe(500);expect(r.text).not.toContain('private synthetic');expect(r.headers['x-sync-command']).toBeUndefined();expect(journals(0)).toHaveLength(0);expect(commands(0)).toHaveLength(0);
 const retry=await post(0,'gl-sync-command-fault');expect(retry.status).toBe(201);expect(journals(0)).toHaveLength(1);expect(commands(0)).toHaveLength(1);
});
it('returns the same durable local command for concurrent repeated submissions',async()=>{
 const r=await Promise.all(Array.from({length:6},()=>post(1,'gl-sync-concurrent')));
 expect(r.every(x=>x.status===201)).toBe(true);expect(r.every(x=>x.headers['x-sync-state']==='local')).toBe(true);
 expect(new Set(r.map(x=>x.headers['x-sync-command'])).size).toBe(1);expect(new Set(r.map(x=>x.body.entry.id)).size).toBe(1);expect(journals(1)).toHaveLength(1);expect(commands(1)).toHaveLength(1);
});
it('holds a missing original command instead of silently making a new one',async()=>{
 const first=await post(2,'gl-sync-missing-command');expect(first.status).toBe(201);
 trio.hostDb().prepare('DELETE FROM sync_commands WHERE id=?').run(commandId(first));
 const retry=await post(2,'gl-sync-missing-command');expect(retry.status).toBe(409);expect(retry.body.entry).toBeUndefined();expect(journals(2)).toHaveLength(1);expect(commands(2)).toHaveLength(0);
 // Restore the command is deliberately not attempted; this fixture remains isolated offline.
});
it('holds a conflicting command acknowledgement without re-posting',async()=>{
 const first=await post(3,'gl-sync-conflicting-command');expect(first.status).toBe(201);
 trio.hostDb().prepare("UPDATE sync_commands SET state='conflict' WHERE id=?").run(commandId(first));
 expect((await post(3,'gl-sync-conflicting-command')).status).toBe(409);expect(journals(3)).toHaveLength(1);expect(commands(3)).toHaveLength(1);
});
it('does not create a receipt or command when posting validation fails',async()=>{
 const conn=trio.hostDb(),row=conn.prepare('SELECT id,data FROM form_records WHERE period=?').get(p(4).label) as {id:number;data:string};
 conn.prepare('UPDATE form_records SET data=? WHERE id=?').run(JSON.stringify({...JSON.parse(row.data),net_pay:999}),row.id);
 const r=await post(4,'gl-sync-invalid-source');expect(r.status).toBe(400);expect(r.headers['x-sync-command']).toBeUndefined();expect(journals(4)).toHaveLength(0);expect(commands(4)).toHaveLength(0);
});
it('keeps raw retry keys out of the durable command and receipt',async()=>{
 const key='gl-sync-private-key-1122334455',r=await post(5,key);expect(r.status).toBe(201);
 const conn=trio.hostDb(),command=conn.prepare('SELECT * FROM sync_commands WHERE id=?').get(commandId(r));
 expect(JSON.stringify(command)).not.toContain(key);
 const receipts=conn.prepare("SELECT * FROM idempotency_keys WHERE key LIKE 'payroll-gl:v1:%'").all();expect(JSON.stringify(receipts)).not.toContain(key);
});
it('rechecks live permission after waiting for the capture lock',async()=>{
 const c=await import('../src/sync/commands'),conn=trio.hostDb(),original=c.lockSync,release=await original(conn);
 let entered!:()=>void;const waiting=new Promise<void>(r=>{entered=r;});
 const spy=vi.spyOn(c,'lockSync').mockImplementationOnce(db=>{entered();return original(db);});
 const pending=post(7,'gl-sync-access-wait').then(r=>r);
 try{
  await waiting;conn.prepare("UPDATE users SET role='csr' WHERE id=1").run();release();const r=await pending;
  expect(r.status).toBe(403);expect(r.headers['x-sync-command']).toBeUndefined();expect(journals(7)).toHaveLength(0);expect(commands(7)).toHaveLength(0);
 }finally{conn.prepare("UPDATE users SET role='admin' WHERE id=1").run();release();spy.mockRestore();}
});
