/** Disposable real server.ts processes, synthetic payroll, no external provider. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as pause} from 'node:timers/promises';
import {setupApp,cleanup,login} from '../tests/helpers';
process.env.NODE_ENV='test';process.env.VDS_TEST_ADMIN_PASSWORD='admin123-test-only';
const baseline=process.env.PAYROLL_POST_EXPECT_BASELINE==='1';
const root=path.resolve(process.env.PAYROLL_POST_SERVER_ROOT||'.');
const output=path.resolve(baseline?'work/payroll-post-crash-before':'work/payroll-post-crash');fs.mkdirSync(output,{recursive:true});
// A repeated drill must never inherit an already-open concurrency barrier or a
// stale failure report. Preserve previous runs outside this disposable directory.
for(const file of ['failed.json','results.json','barrier'])fs.rmSync(path.join(output,file),{recursive:true,force:true});
const ctx=await setupApp(),token=await login(ctx.api),d=await import('../src/shared/db');
const headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
assert.equal((await ctx.api.post('/api/accounting/ledger/setup').set(headers).send({fiscal_year_start:'2026-01-01'})).status,201);
const employee=Number(d.run("INSERT INTO employees(employee_no,name) VALUES('GL-CRASH','Synthetic GL crash audit')").lastInsertRowid);
const form=d.queryOne<{id:number}>("SELECT id FROM form_definitions WHERE slug='hr_payroll'")!.id;
const children=new Set<ChildProcess>(),cases:Record<string,unknown>[]=[];let sequence=0,starts=0;
const env={...process.env,NODE_ENV:'production',DEPLOY_MODE:'cloud',BEHIND_PROXY:'true',TZ:'Asia/Manila',BACKUP_DIR:path.join(ctx.tmpDir,'backups')};
for(const key of ['APP_DOMAIN','TENANT_PATH_HOST','PLATFORM_CONSOLE','DEFAULT_TENANT_REDIRECT','ADMIN_PASSWORD'])delete env[key as keyof typeof env];
async function until(test:()=>boolean|Promise<boolean>,label:string){const deadline=Date.now()+20_000;while(Date.now()<deadline){if(await test())return;await pause(25);}throw new Error('Timed out: '+label);}
function source(){const label='GL-CRASH-'+(++sequence),id=Number(d.run("INSERT INTO attendance_periods(label,start_date,end_date) VALUES(?,'2026-07-01','2026-07-15')",label).lastInsertRowid);
 d.run("INSERT INTO form_records(form_def_id,number,data,status,period,created_by) VALUES(?,?,?,'draft',?,1)",form,label,JSON.stringify({employee_id:employee,employee_name:'Synthetic GL crash audit',cutoff_id:id,payroll_period:label,pay_date:'2026-07-15',total_earnings:1000,net_pay:1000}),label);return{id,label};}
const rows=(id:number)=>d.queryAll('SELECT id,number,reverses_id FROM journal_entries WHERE source_type=\'payroll_run\' AND source_id=? ORDER BY id',id);
function start(port:number,hook?:string){const file=fs.openSync(path.join(output,`server-${port}-${++starts}.txt`),'w');const child=spawn(process.execPath,['--import','tsx',...(hook?['--import',hook]:[]),'server.ts'],{cwd:root,env:{...env,PORT:String(port)},stdio:['ignore',file,file]});fs.closeSync(file);children.add(child);child.once('exit',()=>children.delete(child));return child;}
async function ready(port:number,child:ChildProcess){await until(async()=>{if(child.exitCode!==null||child.signalCode!==null)throw Error('Server exited during startup');try{return(await fetch(`http://127.0.0.1:${port}/api/health`,{signal:AbortSignal.timeout(500)})).ok;}catch{return false;}},'server health');}
async function stop(child:ChildProcess){if(child.exitCode!==null||child.signalCode!==null)return;const exited=once(child,'exit');child.kill('SIGKILL');await exited;}
async function post(port:number,p:{id:number;label:string},key:string){try{const r=await fetch(`http://127.0.0.1:${port}/api/hr/periods/${p.id}/post-payroll-gl`,{method:'POST',headers:{...headers,'Idempotency-Key':key},body:JSON.stringify({payroll_period:p.label}),signal:AbortSignal.timeout(20_000)});return{status:r.status,body:await r.json(),command:r.headers.get('x-sync-command'),state:r.headers.get('x-sync-state')};}catch{return{status:null,body:null,command:null,state:null};}}
function hook(name:string,code:string){const file=path.join(output,name+'.mjs');fs.writeFileSync(file,code);return file;}
const killHook=hook('kill-sql',`import {init,activeDb} from ${JSON.stringify(path.join(root,'src/shared/db.ts'))};init();activeDb().function('gl_audit_kill',()=>{process.kill(process.pid,'SIGKILL');return 0;});`);
const endHook=hook('kill-end',`import http from 'node:http';const end=http.ServerResponse.prototype.end;http.ServerResponse.prototype.end=function(...args){if(this.req.method==='POST'&&this.req.url.endsWith('/post-payroll-gl'))process.kill(process.pid,'SIGKILL');return end.apply(this,args);};`);
try{
 for(const timing of ['BEFORE','AFTER']){
  const p=source(),key='gl-crash-receipt-'+timing;
  d.db.exec(`CREATE TRIGGER gl_audit_receipt ${timing} INSERT ON idempotency_keys BEGIN SELECT gl_audit_kill(); END`);
  let child=start(4381,killHook);await ready(4381,child);const exited=once(child,'exit');const first=await post(4381,p,key);await exited;
  const interrupted=rows(p.id);assert.equal(interrupted.length,baseline?1:0);
  d.db.exec('DROP TRIGGER gl_audit_receipt');child=start(4381);await ready(4381,child);const retry=await post(4381,p,key);assert.equal(retry.status,201);assert.equal(rows(p.id).length,baseline?3:1);
  cases.push({name:timing.toLowerCase()+' receipt insert SIGKILL',contract_satisfied:!baseline,first_status:first.status,interrupted_rows:interrupted,retry_status:retry.status,final_rows:rows(p.id)});await stop(child);
 }
 {
  const p=source(),key='gl-crash-after-commit';let child=start(4381,endHook);await ready(4381,child);const exited=once(child,'exit');const first=await post(4381,p,key);await exited;assert.equal(rows(p.id).length,1);
  child=start(4381);await ready(4381,child);const retry=await post(4381,p,key);assert.equal(retry.status,201);assert.equal(rows(p.id).length,1);
  cases.push({name:'committed response lost to SIGKILL',contract_satisfied:true,first_status:first.status,retry_status:retry.status,final_rows:rows(p.id)});await stop(child);
 }
 {
  const p=source(),key='gl-two-server-cache-miss',gate=path.join(output,'barrier');fs.mkdirSync(gate,{recursive:true});
  const barrier=hook('barrier',`import fs from 'node:fs';import {DatabaseSync} from 'node:sqlite';const prepare=DatabaseSync.prototype.prepare;let marked=false;DatabaseSync.prototype.prepare=function(sql,...args){const stmt=prepare.call(this,sql,...args);if(/SELECT\\s+(?:status_code|user_id).*FROM\\s+idempotency_keys/i.test(sql)){const get=stmt.get.bind(stmt);stmt.get=(...a)=>{const row=get(...a);if(!row&&!marked){marked=true;fs.writeFileSync(${JSON.stringify(gate)}+'/'+process.env.PORT+'.ready','ready');const until=Date.now()+15000;while(!fs.existsSync(${JSON.stringify(gate)}+'/'+process.env.PORT+'.go')){if(Date.now()>until)throw Error('Audit barrier expired');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);}}return row;};}return stmt;};`);
  const a=start(4381,barrier),b=start(4382,barrier);await Promise.all([ready(4381,a),ready(4382,b)]);
  const first=post(4381,p,key),second=post(4382,p,key);await until(()=>[4381,4382].every(port=>fs.existsSync(path.join(gate,port+'.ready'))),'both cache misses');
  fs.writeFileSync(path.join(gate,'4381.go'),'go');const r1=await first;assert.equal(r1.status,201);
  fs.writeFileSync(path.join(gate,'4382.go'),'go');const r2=await second;assert.equal(r2.status,201);assert.equal(rows(p.id).length,baseline?3:1);
  cases.push({name:'two real processes after concurrent cache misses',contract_satisfied:!baseline,statuses:[r1.status,r2.status],final_rows:rows(p.id)});await stop(a);await stop(b);
 }
 {
  const {enableSync}=await import('../src/sync/node');enableSync(d.activeDb(),{role:'node',nodeNo:1,isHost:true});d.setSetting('sync_main_host',1);
  const p=source(),key='gl-crash-node-command';d.db.exec("CREATE TRIGGER gl_audit_command BEFORE INSERT ON sync_commands WHEN NEW.path LIKE '%/post-payroll-gl' BEGIN SELECT gl_audit_kill(); END");
  let child=start(4381,killHook);await ready(4381,child);const exited=once(child,'exit');const first=await post(4381,p,key);await exited;assert.equal(rows(p.id).length,baseline?1:0);
  d.db.exec('DROP TRIGGER gl_audit_command');child=start(4381);await ready(4381,child);const retry=await post(4381,p,key);assert.equal(retry.status,201);assert.equal(rows(p.id).length,1);
  const command=retry.command?d.queryOne('SELECT id,state FROM sync_commands WHERE id=?',retry.command):null;assert.equal(!!command,!baseline);
  cases.push({name:'originating node command insert SIGKILL',contract_satisfied:!baseline,first_status:first.status,retry_status:retry.status,command:command??null,final_rows:rows(p.id)});await stop(child);
 }
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({mode:baseline?'before-fix reproduction':'fixed source',node:process.version,journal_mode:d.queryOne('PRAGMA journal_mode'),synchronous:d.queryOne('PRAGMA synchronous'),cases},null,2)+'\n');
 console.log(JSON.stringify({experiments:cases.length,contract_satisfied:cases.filter(c=>c.contract_satisfied).length,results:path.join(output,'results.json')}));
}catch(error){fs.writeFileSync(path.join(output,'failed.json'),JSON.stringify({error:String(error),completed:cases},null,2)+'\n');throw error;}
finally{for(const child of [...children])await stop(child);cleanup(ctx);}
