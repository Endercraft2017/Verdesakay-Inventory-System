import {beforeAll,afterAll,it,expect} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {setupSiteTrio,type SiteTrio} from './sync-helpers';
import {cleanup} from './helpers';
let trio:SiteTrio;const periods:number[]=[];
beforeAll(async()=>{
 trio=await setupSiteTrio(async({api,cloudHdr})=>{
  expect((await api.post('/api/accounting/ledger/setup').set(cloudHdr()).send({fiscal_year_start:'2026-01-01'})).status).toBe(201);
  const d=await import('../src/shared/db'),e=Number(d.run("INSERT INTO employees(employee_no,name) VALUES('GL-REPLAY','Synthetic cloud replay')").lastInsertRowid),f=d.queryOne<{id:number}>("SELECT id FROM form_definitions WHERE slug='hr_payroll'")!.id;
  for(let i=0;i<14;i++){const label='GL-REPLAY-'+i,id=Number(d.run("INSERT INTO attendance_periods(label,start_date,end_date) VALUES(?,'2026-07-01','2026-07-15')",label).lastInsertRowid);periods.push(id);
   d.run("INSERT INTO form_records(form_def_id,number,data,status,period,created_by) VALUES(?,?,?,'draft',?,1)",f,label,JSON.stringify({employee_id:e,employee_name:'Synthetic cloud replay',cutoff_id:id,pay_date:'2026-07-15',total_earnings:1000,net_pay:1000}),label);}
 });
 expect((await trio.ctx.api.put('/api/sync/sites').set(trio.cloudHdr()).send({main_host:trio.hostNo})).status).toBe(200);await trio.hostRound();trio.cutOff('host');
},90000);
afterAll(()=>{trio?.close();if(trio)cleanup(trio.ctx);});
const cloud=()=>trio.cloudDb(),journals=(i:number,db=cloud())=>db.prepare("SELECT id,number,reverses_id FROM journal_entries WHERE source_type='payroll_run' AND source_id=? ORDER BY id").all(periods[i]!);
const row=(id:string)=>cloud().prepare('SELECT state,authority_seq,response_status FROM sync_commands WHERE id=?').get(id);
const effects=(id:string)=>cloud().prepare('SELECT authority_seq,command_id FROM sync_effects WHERE command_id=?').all(id);
async function command(i:number,key='gl-replay-test-'+i){
 const r=await trio.ctx.api.post(`/api/hr/periods/${periods[i]!}/post-payroll-gl`).set(trio.hostHdr()).set('Idempotency-Key',key).send({payroll_period:'GL-REPLAY-'+i});expect(r.status,r.text).toBe(201);
 const c=trio.sync.pendingCommands(trio.hostSlug).find(c=>c.id===r.headers['x-sync-command']);expect(c).toBeTruthy();return c!;
}
it('converges office, cloud and LAN journals through normal post and explicit re-post',async()=>{
 await command(0);trio.reconnect('host');expect((await trio.hostRound()).pushed.every(x=>x.state==='confirmed')).toBe(true);await trio.lanRound();
 expect(journals(0)).toHaveLength(1);expect(journals(0,trio.hostDb())).toEqual(journals(0));expect(journals(0,trio.lanDb())).toEqual(journals(0));
 trio.cutOff('host');const again=await command(0,'gl-replay-explicit-repost');trio.reconnect('host');await trio.hostRound();await trio.lanRound();
 expect(row(again.id)).toMatchObject({state:'confirmed',response_status:201});expect(journals(0)).toHaveLength(3);expect(journals(0,trio.hostDb())).toEqual(journals(0));expect(journals(0,trio.lanDb())).toEqual(journals(0));trio.cutOff('host');
 // A LAN desk can use the existing main-site claim while its host is reachable.
 const lan=await trio.ctx.api.post(`/api/hr/periods/${periods[12]!}/post-payroll-gl`).set(trio.lanHdr()).set('Idempotency-Key','gl-replay-lan-origin').send({payroll_period:'GL-REPLAY-12'});expect(lan.status,lan.text).toBe(201);
 await trio.lanRound();expect(trio.lanDb().prepare('SELECT state FROM sync_commands WHERE id=?').get(lan.headers['x-sync-command']!)).toEqual({state:'host_confirmed'});
 trio.reconnect('host');await trio.hostRound();await trio.lanRound();expect(journals(12)).toHaveLength(1);expect(journals(12,trio.hostDb())).toEqual(journals(12));expect(journals(12,trio.lanDb())).toEqual(journals(12));trio.cutOff('host');
});
for(const [i,fault] of ['effect','verdict'].entries())it(`rolls back source/effect on ${fault} persistence failure and retries the original command`,async()=>{
 const p=i+1,cmd=await command(p),conn=cloud();conn.exec(fault==='effect'?"CREATE TRIGGER replay_fault BEFORE INSERT ON sync_effects WHEN NEW.command_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'private synthetic effect fault'); END":"CREATE TRIGGER replay_fault BEFORE UPDATE ON sync_commands WHEN NEW.state='confirmed' BEGIN SELECT RAISE(ABORT,'private synthetic verdict fault'); END");
 try{await expect(trio.sync.acceptCommand('default',cmd)).rejects.toMatchObject({status:503});}finally{conn.exec('DROP TRIGGER replay_fault');}
 expect(journals(p)).toHaveLength(0);expect(effects(cmd.id)).toHaveLength(0);expect(row(cmd.id)).toMatchObject({state:'received',authority_seq:null,response_status:null});expect(journals(p,trio.hostDb())).toHaveLength(1);
 expect((await trio.sync.acceptCommand('default',cmd)).state).toBe('confirmed');expect(journals(p)).toHaveLength(1);expect(effects(cmd.id)).toHaveLength(1);
 const first=journals(p);await trio.sync.acceptCommand('default',cmd);trio.sync.pullFor('default',trio.hostNo,0);trio.sync.flushEffects(conn,null);expect(journals(p)).toEqual(first);expect(effects(cmd.id)).toHaveLength(1);
});
it('serializes repeated concurrent commands into one journal, effect and verdict',async()=>{
 const cmd=await command(3),r=await Promise.all(Array.from({length:12},()=>trio.sync.acceptCommand('default',cmd)));
 expect(r.every(x=>x.state==='confirmed')).toBe(true);expect(new Set(r.map(x=>x.authority_seq)).size).toBe(1);expect(journals(3)).toHaveLength(1);expect(effects(cmd.id)).toHaveLength(1);
});
it('rejects reuse of a decided command ID with changed immutable fields',async()=>{
 const cmd=await command(4);await trio.sync.acceptCommand('default',cmd);const before=journals(4);
 for(const altered of [{body:'{}'},{actor_user_id:999},{allocation_plan:'[]'},{context:'{}'},{method:'DELETE'},{path:'/api/notes'},{path:cmd.path.replace('/post-payroll-gl','/POST-PAYROLL-GL')}]){
  await expect(trio.sync.acceptCommand('default',{...cmd,...altered})).rejects.toMatchObject({status:409});
 }
 expect(journals(4)).toEqual(before);expect(effects(cmd.id)).toHaveLength(1);
});
it('holds an old undecided command even when no payroll journal is visible',async()=>{
 const cmd=await command(5),{insertCommand}=await import('../src/sync/commands');insertCommand(cloud(),cmd,{state:'received'});
 await expect(trio.sync.acceptCommand('default',cmd)).rejects.toMatchObject({status:409});expect(row(cmd.id)).toMatchObject({state:'received'});expect(journals(5)).toHaveLength(0);expect(journals(5,trio.hostDb())).toHaveLength(1);
 expect(cloud().prepare('SELECT 1 FROM sync_payroll_replays WHERE command_id=?').get(cmd.id)).toBeUndefined();
});
it('preserves historical financial evidence for an uncertain legacy received command',async()=>{
 const cmd=await command(6),{insertCommand}=await import('../src/sync/commands'),{drainRecorder}=await import('../src/sync/node');insertCommand(cloud(),cmd,{state:'received'});
 const original=cloud().prepare("SELECT * FROM journal_entries WHERE source_type='payroll_run' ORDER BY id LIMIT 1").get()!;delete original.id;original.source_id=periods[6]!;original.number='JV-SYNTHETIC-LEGACY';
 cloud().prepare(`INSERT INTO journal_entries(${Object.keys(original).join(',')}) VALUES(${Object.keys(original).map(()=>'?').join(',')})`).run(...Object.values(original));drainRecorder(cloud()); // Simulate old durable data after its recorder was lost.
 const before=journals(6);await expect(trio.sync.acceptCommand('default',cmd)).rejects.toMatchObject({status:409});expect(journals(6)).toEqual(before);expect(effects(cmd.id)).toHaveLength(0);
});
it('retains a tombstone hold if a decided command row is trimmed',async()=>{
 const cmd=await command(7);await trio.sync.acceptCommand('default',cmd);cloud().prepare('DELETE FROM sync_commands WHERE id=?').run(cmd.id);
 await expect(trio.sync.acceptCommand('default',cmd)).rejects.toMatchObject({status:409});expect(journals(7)).toHaveLength(1);expect(effects(cmd.id)).toHaveLength(1);
 await expect(trio.sync.acceptCommand('default',{...cmd,method:'DELETE',path:'/api/notes'})).rejects.toMatchObject({status:409});
});
it('preserves a received command if a changed method attempts to bypass its payroll binding',async()=>{
 const cmd=await command(11),{preparePayrollReplay}=await import('../src/sync/payroll-replay');preparePayrollReplay(cloud(),cmd);
 await expect(trio.sync.acceptCommand('default',{...cmd,method:'DELETE'})).rejects.toMatchObject({status:409});expect(row(cmd.id)).toMatchObject({state:'received'});expect(journals(11)).toHaveLength(0);
 expect((await trio.sync.acceptCommand('default',cmd)).state).toBe('confirmed');expect(journals(11)).toHaveLength(1);
});
it('rejects revoked replay permission before executing payroll',async()=>{
 const cmd=await command(8);cloud().prepare("UPDATE users SET role='csr' WHERE id=1").run();
 try{expect(await trio.sync.acceptCommand('default',cmd)).toMatchObject({state:'rejected',response_status:403,authority_seq:null});}finally{cloud().prepare("UPDATE users SET role='admin' WHERE id=1").run();}
 expect(journals(8)).toHaveLength(0);expect(effects(cmd.id)).toHaveLength(0);
});
it('records a genuine validation refusal with no new journal/effect',async()=>{
 const cmd=await command(9),r=cloud().prepare('SELECT id,data FROM form_records WHERE period=?').get('GL-REPLAY-9') as {id:number;data:string};
 cloud().prepare('UPDATE form_records SET data=? WHERE id=?').run(JSON.stringify({...JSON.parse(r.data),net_pay:999}),r.id);
 expect(await trio.sync.acceptCommand('default',cmd)).toMatchObject({state:'rejected',response_status:400,authority_seq:null});expect(journals(9)).toHaveLength(0);expect(effects(cmd.id)).toHaveLength(0);
});
it('keeps unrelated recorder changes and never republishes a successful payroll effect',async()=>{
 const cmd=await command(10),conn=cloud();conn.prepare("INSERT INTO notes(user_id,body) VALUES(1,'Synthetic before payroll replay')").run();
 await trio.sync.acceptCommand('default',cmd);conn.prepare("INSERT INTO notes(user_id,body) VALUES(1,'Synthetic after payroll replay')").run();
 const pull=trio.sync.pullFor('default',trio.hostNo,0);expect(pull.effects.filter(x=>x.command_id===cmd.id)).toHaveLength(1);
 expect(pull.effects.filter(x=>x.command_id===null).length).toBeGreaterThanOrEqual(2);expect(conn.isTransaction).toBe(false);expect(journals(10)).toHaveLength(1);
});
it('scrubs server-owned protocol markers from a real node snapshot',async()=>{
 const file=path.join(trio.ctx.tmpDir,'atomic-payroll-snapshot.db');expect(cloud().prepare('SELECT COUNT(*) AS n FROM sync_payroll_replays').get()).not.toEqual({n:0});trio.sync.buildNodeSnapshot('default',file);
 const conn=new DatabaseSync(file);try{expect(conn.prepare('SELECT COUNT(*) AS n FROM sync_payroll_replays').get()).toEqual({n:0});}finally{conn.close();}
});
it('retains a newly confirmed old-clock command while preserving payroll business time',async()=>{
 const original=await command(13),cmd={...original,occurred_at:'2010-01-01T00:00:00Z',occurred_date:'2010-01-01'},started=Date.now();
 expect((await trio.sync.acceptCommand('default',cmd)).state).toBe('confirmed');
 const verdict=cloud().prepare('SELECT updated_at FROM sync_commands WHERE id=?').get(cmd.id) as {updated_at:string};
 const effect=cloud().prepare('SELECT created_at FROM sync_effects WHERE command_id=?').get(cmd.id) as {created_at:string};
 expect(effect.created_at).toBe(verdict.updated_at);expect(Date.parse(verdict.updated_at.replace(' ','T')+'Z')).toBeGreaterThanOrEqual(started);
 const business=cloud().prepare("SELECT created_at FROM journal_entries WHERE source_type='payroll_run' AND source_id=?").get(periods[13]!) as {created_at:string};expect(business.created_at).toMatch(/^2010-01-01/);
 const {compactCommands}=await import('../src/sync/maintenance');expect(compactCommands(cloud(),30)).toBe(0);expect(row(cmd.id)).toMatchObject({state:'confirmed'});
});
