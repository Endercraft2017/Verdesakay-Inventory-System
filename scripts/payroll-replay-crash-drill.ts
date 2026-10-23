/** Synthetic cloud payroll replay through actual server processes. Never a live target. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as pause} from 'node:timers/promises';
import {setupSiteTrio} from '../tests/sync-helpers';
import {cleanup} from '../tests/helpers';
process.env.NODE_ENV='test';process.env.VDS_TEST_ADMIN_PASSWORD='admin123-test-only';
const baseline=process.env.PAYROLL_REPLAY_EXPECT_BASELINE==='1',root=path.resolve(process.env.PAYROLL_REPLAY_SERVER_ROOT||'.');
const onlyCase=process.env.PAYROLL_REPLAY_ONLY_CASE;
const output=path.resolve((baseline?'work/payroll-replay-crash-before':'work/payroll-replay-crash')+(onlyCase==null?'':'-case-'+onlyCase));fs.mkdirSync(output,{recursive:true});
for(const file of ['results.json','failed.json','barrier'])fs.rmSync(path.join(output,file),{recursive:true,force:true});
const periods:number[]=[];
const trio=await setupSiteTrio(async({api,cloudHdr})=>{
 assert.equal((await api.post('/api/accounting/ledger/setup').set(cloudHdr()).send({fiscal_year_start:'2026-01-01'})).status,201);
 const d=await import('../src/shared/db'),e=Number(d.run("INSERT INTO employees(employee_no,name) VALUES('GL-REPLAY-KILL','Synthetic replay crash')").lastInsertRowid),f=d.queryOne<{id:number}>("SELECT id FROM form_definitions WHERE slug='hr_payroll'")!.id;
 for(let i=0;i<6;i++){const label='GL-REPLAY-KILL-'+i,id=Number(d.run("INSERT INTO attendance_periods(label,start_date,end_date) VALUES(?,'2026-07-01','2026-07-15')",label).lastInsertRowid);periods.push(id);
 d.run("INSERT INTO form_records(form_def_id,number,data,status,period,created_by) VALUES(?,?,?,'draft',?,1)",f,label,JSON.stringify({employee_id:e,employee_name:'Synthetic replay crash',cutoff_id:id,pay_date:'2026-07-15',total_earnings:1000,net_pay:1000}),label);}
});
assert.equal((await trio.ctx.api.put('/api/sync/sites').set(trio.cloudHdr()).send({main_host:trio.hostNo})).status,200);await trio.hostRound();trio.cutOff('host');
const cloud=trio.cloudDb(),children=new Set<ChildProcess>(),cases:Record<string,unknown>[]=[];let starts=0;
const enrolled=trio.sync.remoteOf(trio.hostDb());assert(enrolled,'Expected enrolled host connection');const remote=enrolled;
const env={...process.env,NODE_ENV:'production',DEPLOY_MODE:'cloud',BEHIND_PROXY:'true',TZ:'Asia/Manila',BACKUP_DIR:path.join(trio.ctx.tmpDir,'backups')};
for(const key of ['APP_DOMAIN','TENANT_PATH_HOST','PLATFORM_CONSOLE','DEFAULT_TENANT_REDIRECT','ADMIN_PASSWORD'])delete env[key as keyof typeof env];
const hook=(name:string,code:string)=>{const file=path.join(output,name+'.mjs');fs.writeFileSync(file,code);return file;};
const killSql=hook('kill-sql',`import {init,activeDb} from ${JSON.stringify(path.join(root,'src/shared/db.ts'))};init();activeDb().function('gl_replay_kill',()=>{process.kill(process.pid,'SIGKILL');return 0;});`);
const killInternal=hook('kill-internal-response',`import http from 'node:http';const end=http.ServerResponse.prototype.end;http.ServerResponse.prototype.end=function(...args){if(this.req.headers['x-sync-mode']==='replay'&&this.req.url.endsWith('/post-payroll-gl'))process.kill(process.pid,'SIGKILL');return end.apply(this,args);};`);
const killOuter=hook('kill-outer-response',`import http from 'node:http';const end=http.ServerResponse.prototype.end;http.ServerResponse.prototype.end=function(...args){if(this.req.method==='POST'&&this.req.originalUrl==='/api/sync/commands')process.kill(process.pid,'SIGKILL');return end.apply(this,args);};`);
async function until(test:()=>boolean|Promise<boolean>,label:string){const deadline=Date.now()+25_000;while(Date.now()<deadline){if(await test())return;await pause(25);}throw new Error('Timeout: '+label);}
function start(port:number,preload?:string){const file=fs.openSync(path.join(output,`server-${port}-${++starts}.txt`),'w');const child=spawn(process.execPath,['--import','tsx',...(preload?['--import',preload]:[]),'server.ts'],{cwd:root,env:{...env,PORT:String(port)},stdio:['ignore',file,file]});fs.closeSync(file);children.add(child);child.once('exit',()=>children.delete(child));return child;}
async function ready(port:number,c:ChildProcess){await until(async()=>{if(c.exitCode!==null||c.signalCode!==null)throw Error('Server exited');try{return(await fetch(`http://127.0.0.1:${port}/api/health`,{signal:AbortSignal.timeout(500)})).ok;}catch{return false;}},'server health');}
async function stop(c:ChildProcess){if(c.exitCode!==null||c.signalCode!==null)return;const p=once(c,'exit');c.kill('SIGKILL');await p;}
async function command(i:number){const r=await trio.ctx.api.post(`/api/hr/periods/${periods[i]!}/post-payroll-gl`).set(trio.hostHdr()).set('Idempotency-Key','gl-replay-kill-'+i).send({payroll_period:'GL-REPLAY-KILL-'+i});assert.equal(r.status,201);const c=trio.sync.pendingCommands(trio.hostSlug).find(c=>c.id===r.headers['x-sync-command']);assert(c);return c;}
async function send(port:number,cmd:Awaited<ReturnType<typeof command>>){try{const r=await fetch(`http://127.0.0.1:${port}/api/sync/commands`,{method:'POST',headers:{'content-type':'application/json','x-sync-node-token':remote.nodeToken},body:JSON.stringify({commands:[cmd]}),signal:AbortSignal.timeout(25_000)});return{status:r.status,body:await r.json().catch(()=>null)};}catch{return{status:null,body:null};}}
function state(i:number,id:string){return{journals:cloud.prepare("SELECT id,number,reverses_id FROM journal_entries WHERE source_type='payroll_run' AND source_id=? ORDER BY id").all(periods[i]!),command:cloud.prepare('SELECT state,authority_seq,response_status FROM sync_commands WHERE id=?').get(id),effects:cloud.prepare('SELECT authority_seq,command_id FROM sync_effects WHERE command_id=?').all(id)};}
async function converge(i:number){try{const pull=trio.sync.pullFor('default',trio.hostNo,trio.sync.lastAuthoritySeq(trio.hostSlug));await trio.sync.applyConfirmed(trio.hostSlug,pull);const host=trio.hostDb().prepare("SELECT id,number,reverses_id FROM journal_entries WHERE source_type='payroll_run' AND source_id=? ORDER BY id").all(periods[i]!);return{converged:JSON.stringify(host)===JSON.stringify(cloud.prepare("SELECT id,number,reverses_id FROM journal_entries WHERE source_type='payroll_run' AND source_id=? ORDER BY id").all(periods[i]!)),host_journals:host};}catch(e){return{converged:false,error_type:(e as Error).name};}}
try{
 const faults=[{name:'before command effect insert',sql:"CREATE TRIGGER gl_replay_fault BEFORE INSERT ON sync_effects WHEN NEW.command_id IS NOT NULL BEGIN SELECT gl_replay_kill(); END"},{name:'before confirmed verdict update',sql:"CREATE TRIGGER gl_replay_fault BEFORE UPDATE ON sync_commands WHEN NEW.state='confirmed' BEGIN SELECT gl_replay_kill(); END"},{name:'after confirmed verdict update before commit',sql:"CREATE TRIGGER gl_replay_fault AFTER UPDATE ON sync_commands WHEN NEW.state='confirmed' BEGIN SELECT gl_replay_kill(); END"}];
 for(let i=0;i<5;i++){
  if(onlyCase!=null&&Number(onlyCase)!==i)continue;
  const cmd=await command(i),fault=faults[i],preload=fault?killSql:i===3?killInternal:killOuter;if(fault)cloud.exec(fault.sql);
  let child=start(4391,preload);await ready(4391,child);const died=once(child,'exit');const first=await send(4391,cmd);
  fs.writeFileSync(path.join(output,'progress.json'),JSON.stringify({case:i,first,observed:state(i,cmd.id)},null,2)+'\n');
  await Promise.race([died,pause(5000).then(()=>{throw Error('Expected child termination was not observed: '+JSON.stringify(first));})]);
  const interrupted=state(i,cmd.id);if(fault)cloud.exec('DROP TRIGGER gl_replay_fault');
  if(!baseline){assert.equal(interrupted.journals.length,i<3?0:1);assert.equal(interrupted.effects.length,i<3?0:1);assert.equal(interrupted.command?.state,i<3?'received':'confirmed');}
  child=start(4391);await ready(4391,child);const retry=await send(4391,cmd),final=state(i,cmd.id);const replica=await converge(i);
  const correct=retry.status===200&&final.journals.length===1&&final.effects.length===1&&final.command?.state==='confirmed'&&replica.converged;
  if(!baseline)assert(correct,JSON.stringify({case:i,retry,final,replica}));
  cases.push({name:fault?.name??(i===3?'internal response lost after handler commit':'outer command response lost after complete decision'),contract_satisfied:correct,first_status:first.status,interrupted,retry_status:retry.status,final,replica});await stop(child);
 }
 if(onlyCase==null||Number(onlyCase)===5){
  const i=5,cmd=await command(i),{preparePayrollReplay}=await import('../src/sync/payroll-replay');preparePayrollReplay(cloud,cmd);
  const gate=path.join(output,'barrier');fs.mkdirSync(gate,{recursive:true});
  const barrier=hook('barrier',`import fs from 'node:fs';import {DatabaseSync} from 'node:sqlite';const prepare=DatabaseSync.prototype.prepare;let marked=false;DatabaseSync.prototype.prepare=function(sql,...rest){const stmt=prepare.call(this,sql,...rest);if(/SELECT \\* FROM sync_commands WHERE id/.test(sql)){const get=stmt.get.bind(stmt);stmt.get=(...args)=>{const row=get(...args);if(row?.state==='received'&&!marked){marked=true;fs.writeFileSync(${JSON.stringify(gate)}+'/'+process.env.PORT+'.ready','ready');const until=Date.now()+20000;while(!fs.existsSync(${JSON.stringify(gate)}+'/'+process.env.PORT+'.go')){if(Date.now()>until)throw Error('Barrier expired');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);}}return row;};}return stmt;};`);
  // Isolate request concurrency from unrelated schema/seed startup lock contention.
  const a=start(4391,barrier);await ready(4391,a);const b=start(4392,barrier);await ready(4392,b);
  const first=send(4391,cmd),second=send(4392,cmd);await until(()=>[4391,4392].every(p=>fs.existsSync(path.join(gate,p+'.ready'))),'two received lookups');fs.writeFileSync(path.join(gate,'4391.go'),'go');const r1=await first;fs.writeFileSync(path.join(gate,'4392.go'),'go');const r2=await second;
  const final=state(i,cmd.id),replica=await converge(i),correct=r1.status===200&&r2.status===200&&final.journals.length===1&&final.effects.length===1&&replica.converged;if(!baseline)assert(correct,JSON.stringify({r1,r2,final,replica}));
  cases.push({name:'two processes observing the same received command',contract_satisfied:correct,statuses:[r1.status,r2.status],final,replica});await stop(a);await stop(b);
 }
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({mode:baseline?'unchanged baseline':'fixed source',node:process.version,sqlite:cloud.prepare('SELECT sqlite_version() AS version').get(),journal_mode:cloud.prepare('PRAGMA journal_mode').get(),synchronous:cloud.prepare('PRAGMA synchronous').get(),cases},null,2)+'\n');console.log(JSON.stringify({experiments:cases.length,contract_satisfied:cases.filter(c=>c.contract_satisfied).length,output}));
}catch(e){fs.writeFileSync(path.join(output,'failed.json'),JSON.stringify({error:String(e),completed:cases},null,2)+'\n');throw e;}
finally{for(const c of [...children])await stop(c);trio.close();cleanup(trio.ctx);}
