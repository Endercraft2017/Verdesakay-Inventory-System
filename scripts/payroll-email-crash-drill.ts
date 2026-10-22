/** Isolated local experiment. Runs the real server.ts worker; never uses a live tenant. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn,type ChildProcess} from 'node:child_process';
import assert from 'node:assert/strict';
import {setTimeout as pause} from 'node:timers/promises';
import {setupApp,cleanup,login} from '../tests/helpers';
import {smtpCapture} from '../tests/helpers/smtp-capture';
process.env.NODE_ENV='test';process.env.VDS_TEST_ADMIN_PASSWORD='admin123-test-only';
const ctx=await setupApp(),token=await login(ctx.api),db=await import('../src/shared/db'),peer=await smtpCapture();
const output=path.resolve('work/payroll-email-crash');fs.mkdirSync(output,{recursive:true});
const env={...process.env,NODE_ENV:'production',BEHIND_PROXY:'true',TZ:'Asia/Manila',NODE_EXTRA_CA_CERTS:peer.cert,DEPLOY_MODE:'cloud',BACKUP_DIR:path.join(ctx.tmpDir,'backups')};
const results:any[]=[];const children=new Set<ChildProcess>();let child:ChildProcess|undefined,n=0;
const {hashPassword}=await import('../src/shared/password-hash');
const user=Number(db.run("INSERT INTO users(username,full_name,role,password_hash,email) VALUES('drill-mail','Synthetic Crash Recipient','csr',?,'crash-recipient@example.test')",hashPassword('Synthetic crash recipient password')).lastInsertRowid);
const employee=Number(db.run("INSERT INTO employees(employee_no,name,user_id) VALUES('CRASH-MAIL','Synthetic Crash Recipient',?)",user).lastInsertRowid),form=db.queryOne<{id:number}>("SELECT id FROM form_definitions WHERE slug='hr_payroll'")!.id;
const {saveMailSettings}=await import('../src/shared/mailer');saveMailSettings({transport:'smtp',from_name:'Synthetic Crash Payroll',from_email:'payroll@example.test',reply_to:'',smtp_host:'127.0.0.1',smtp_port:peer.port,smtp_secure:true,smtp_user:''});
const h={Authorization:`Bearer ${token}`};
async function until(check:()=>boolean|Promise<boolean>,label:string,ms=20_000){const end=Date.now()+ms;while(Date.now()<end){if(await check())return;await pause(40);}throw new Error('Timed out: '+label);}
function start(port=4327,hook?:string){
 const log=fs.openSync(path.join(output,`server-${++n}.txt`),'w');
 const c=spawn(process.execPath,['--import','tsx',...(hook?['--import',hook]:[]),'server.ts'],{cwd:process.cwd(),env:{...env,PORT:String(port)},stdio:['ignore',log,log]});fs.closeSync(log);children.add(c);c.once('exit',()=>children.delete(c));return c;
}
async function stop(c=child){if(!c||c.exitCode!==null||c.signalCode!==null)return;const done=new Promise<void>(r=>c.once('exit',()=>r()));c.kill('SIGKILL');await done;}
const release=(id:string)=>db.queryOne<any>('SELECT id,state,revision,content_hash,message_id,outcome_code,confirmed_at,claimed_at FROM payroll_email_releases WHERE id=?',id)!;
const events=(id:string)=>db.queryAll('SELECT state,code FROM payroll_email_events WHERE release_id=? ORDER BY id',id);
async function reset(){await stop();peer.reset();db.run('DROP TRIGGER IF EXISTS crash_after_accept');db.run('DELETE FROM payroll_email_events');db.run('DELETE FROM payroll_email_releases');db.run('DELETE FROM form_records WHERE form_def_id=?',form);const {markFreshVerification}=await import('../src/shared/step-up');markFreshVerification(1,token);}
async function prepare(){const record=Number(db.run("INSERT INTO form_records(form_def_id,number,data,status,created_by) VALUES(?,?,?,'paid',1)",form,'CRASH-DRILL-'+n,JSON.stringify({employee_id:employee,employee_name:'Synthetic Crash Recipient',net_pay:1000})).lastInsertRowid);const base=`/api/hr/payroll/${record}/email`,p=await ctx.api.get(base).set(h),r=await ctx.api.post(base+'/review').set(h).send({source_stamp:p.body.source_stamp});assert.equal(r.status,200,r.text);return {record,base,review:r.body,body:{review_id:r.body.id,review_token:r.body.review_token}};}
async function queue(){const p=await prepare(),r=await ctx.api.post(p.base+'/confirm').set(h).send(p.body);assert.equal(r.status,202,r.text);assert.equal(release(p.review.id).state,'queued');return p;}
function record(name:string,id:string,extra={}){results.push({name,release:release(id),events:events(id),smtp_messages:JSON.parse(JSON.stringify(peer.messages)),...extra});}
async function quietRestart(id:string,expected:string,count:number){child=start();await until(()=>release(id).state===expected,'restart state '+expected);await pause(5400);assert.equal(peer.messages.length,count);assert.equal(release(id).state,expected);await stop();}
try{
 await reset();let p=await queue();child=start();await until(()=>release(p.review.id).state==='accepted','queued work resumed');assert.equal(peer.messages.length,1);await stop();await quietRestart(p.review.id,'accepted',1);record('committed queue survives restart; accepted outcome is not resent',p.review.id);
 await reset();p=await queue();peer.setMode('hold-greeting');child=start();await until(()=>peer.connections.count===1&&release(p.review.id).state==='sending','durable claim before greeting');await stop();db.run('UPDATE payroll_email_releases SET claimed_at=? WHERE id=?',Date.now()-120_001,p.review.id);peer.setMode('accept');await quietRestart(p.review.id,'unknown',0);record('SIGKILL after claim before SMTP greeting',p.review.id,{lease_age_accelerated:true});
 await reset();p=await queue();peer.setMode('hold-data');child=start();await until(()=>peer.messages.length===1,'peer retained DATA before 250');assert.equal(release(p.review.id).state,'sending');await stop();db.run('UPDATE payroll_email_releases SET claimed_at=? WHERE id=?',Date.now()-120_001,p.review.id);peer.setMode('accept');await quietRestart(p.review.id,'unknown',1);record('SIGKILL after DATA before final SMTP acknowledgement',p.review.id,{lease_age_accelerated:true});
 await reset();p=await queue();const hook=path.join(output,'kill-hook.ts');
 fs.writeFileSync(hook,`import {getDb,DB_PATH} from '../../src/shared/db';\nif(!DB_PATH.startsWith(${JSON.stringify(os.tmpdir()+path.sep)})||!DB_PATH.includes('vds-test-'))throw new Error('Synthetic DB required');\ngetDb().function('payroll_email_test_kill',()=>{process.kill(process.pid,'SIGKILL');return 0;});\n`);
 // This trigger fires only after SMTP resolves acceptance, before SQLite commits its outcome.
 db.run("CREATE TRIGGER crash_after_accept BEFORE UPDATE OF state ON payroll_email_releases WHEN NEW.state='accepted' BEGIN SELECT payroll_email_test_kill(); END");child=start(4327,hook);await until(()=>child!.signalCode==='SIGKILL','kill between SMTP acknowledgement and SQLite outcome');assert.equal(peer.messages.length,1);assert.equal(release(p.review.id).state,'sending');db.run('DROP TRIGGER crash_after_accept');db.run('UPDATE payroll_email_releases SET claimed_at=? WHERE id=?',Date.now()-120_001,p.review.id);await quietRestart(p.review.id,'unknown',1);record('SIGKILL after SMTP 250 before outcome commit',p.review.id,{lease_age_accelerated:true});
 await reset();p=await prepare();const dropHook=path.join(output,'drop-reply-hook.ts');
 fs.writeFileSync(dropHook,`import http from 'node:http';\nimport {DB_PATH} from '../../src/shared/db';\nif(!DB_PATH.includes('vds-test-'))throw new Error('Synthetic DB required');\nconst end=http.ServerResponse.prototype.end;let dropped=false;http.ServerResponse.prototype.end=function(...args){if(!dropped&&(this.req?.originalUrl||this.req?.url)?.endsWith('/email/confirm')&&this.statusCode===202){dropped=true;this.socket?.destroy();return this;}return end.apply(this,args);};\n`);
 child=start(4327,dropHook);await until(async()=>{try{return(await fetch('http://127.0.0.1:4327/api/health')).ok;}catch{return false;}},'server ready');let lost=false;try{await fetch('http://127.0.0.1:4327'+p.base+'/confirm',{method:'POST',headers:{...h,'Content-Type':'application/json'},body:JSON.stringify(p.body)});}catch{lost=true;}assert.equal(lost,true);assert.equal(release(p.review.id).state,'queued');
 const replay=await fetch('http://127.0.0.1:4327'+p.base+'/confirm',{method:'POST',headers:{...h,'Content-Type':'application/json'},body:JSON.stringify(p.body)});assert.equal(replay.status,202);assert.equal((await replay.json()).id,p.review.id);await until(()=>release(p.review.id).state==='accepted','lost HTTP response work submitted');assert.equal(peer.messages.length,1);await stop();record('committed confirmation loses HTTP response; same confirmation safely recovers',p.review.id,{lost_response:true,replay_status:202});
 await reset();p=await queue();const a=start(4327),b=start(4328);child=a;await until(()=>release(p.review.id).state==='accepted','competing real process workers');await pause(5400);assert.equal(peer.messages.length,1);await stop(a);await stop(b);record('two real server processes claim one durable attempt',p.review.id);
 fs.writeFileSync(path.join(output,'schema.sql'),db.queryAll<{sql:string}>("SELECT sql FROM sqlite_master WHERE name LIKE 'payroll_email_%' AND sql IS NOT NULL ORDER BY type,name").map(x=>x.sql+';').join('\n')+'\n');
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({environment:{node:process.version,sqlite:db.queryOne('SELECT sqlite_version() AS version'),journal:db.queryOne('PRAGMA journal_mode'),synchronous:db.queryOne('PRAGMA synchronous')},base_commit:'e7cf902f2c225fe8bd1a7964d403c8647483eb37',cases:results},null,2)+'\n');console.log(JSON.stringify({passed:results.length,results:path.join(output,'results.json')}));
}catch(error){fs.writeFileSync(path.join(output,'failed.json'),JSON.stringify({error:String(error),completed:results},null,2)+'\n');throw error;}
finally{for(const c of [...children])await stop(c);await peer.close();cleanup(ctx);}
