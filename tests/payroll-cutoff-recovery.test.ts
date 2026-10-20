import {beforeAll,afterAll,afterEach,it,expect} from 'vitest';
import {setupApp,cleanup,login,createEmployee,type TestContext} from './helpers';
let ctx:TestContext,token:string,other:string,clerk:string,employee:number,form:number,seq=0;
let db:typeof import('../src/shared/db');let fresh:typeof import('../src/shared/step-up').markFreshVerification;
const hdr=(t=token)=>({Authorization:`Bearer ${t}`});
beforeAll(async()=>{
 process.env.TENANT_PATH_HOST='cutoff.example.test';ctx=await setupApp();token=await login(ctx.api);db=await import('../src/shared/db');fresh=(await import('../src/shared/step-up')).markFreshVerification;
 other=(await createEmployee(ctx.api,token,{role:'admin',username:'cutoff-admin'})).token;
 clerk=(await createEmployee(ctx.api,token,{role:'csr'})).token;
 employee=Number(db.run("INSERT INTO employees(employee_no,name) VALUES('CUTOFF-EMP','Synthetic Cutoff Owner')").lastInsertRowid);
 form=db.queryOne<{id:number}>("SELECT id FROM form_definitions WHERE slug='hr_payroll'")!.id;
});
afterAll(()=>{delete process.env.TENANT_PATH_HOST;cleanup(ctx);});
afterEach(()=>{
 db.run('DELETE FROM form_records WHERE form_def_id=?',form);
 db.run("DELETE FROM journal_entries WHERE source_type='payroll_run'");
 db.run("DELETE FROM attendance_periods WHERE label LIKE 'CUTOFF-%'");
 db.run("DELETE FROM accounting_periods WHERE name LIKE 'CUTOFF-%'");
 db.run("DELETE FROM mail_log WHERE subject LIKE 'Payslip — CUTOFF-%'");
});
function cutoff(){const label='CUTOFF-'+(++seq);return {label,id:Number(db.run("INSERT INTO attendance_periods(label,start_date,end_date) VALUES(?,'2032-07-01','2032-07-15')",label).lastInsertRowid)};}
function slip(p=cutoff(),extra:Record<string,unknown>={},status='draft'){
 const id=Number(db.run("INSERT INTO form_records(form_def_id,number,data,status,period,created_by,updated_at) VALUES(?,?,?,?,?,1,'2032-07-16 00:00:00')",form,'CUTOFF-SLIP-'+(++seq),JSON.stringify({employee_id:employee,employee_name:'Synthetic Cutoff Owner',cutoff_id:'broken',payroll_period:p.label,pay_date:'2032-07-16',total_earnings:1000,basic_salary:1000,net_pay:1000,_calculation_snapshot:JSON.stringify({version:1,period_label:p.label,totals:{basic_salary:1000}}),...extra}),status,p.label).lastInsertRowid);
 return {...p,record_id:id};
}
const read=(id:number)=>db.queryOne<Record<string,unknown>>('SELECT * FROM form_records WHERE id=?',id)!;
const url=(id:number)=>`/api/hr/payroll/${id}/cutoff-recovery`;
async function review(p:ReturnType<typeof slip>,body:Record<string,unknown>={}){fresh(1,token);return ctx.api.post(url(p.record_id)+'/review').set(hdr()).send({cutoff_id:p.id,expected_revision:read(p.record_id).revision,reason:'Verified original attendance and payroll records',evidence_reference:'CASE-CUTOFF-001',verified_records:true,...body});}
const confirm=(p:ReturnType<typeof slip>,t:string,actor=token)=>ctx.api.post(url(p.record_id)+'/confirm').set(hdr(actor)).send({review_token:t});
it('recovers only the stamp, preserves financial/history fields and unblocks scoped reports without posting or sending',async()=>{
 const p=slip(),before=read(p.record_id);
 const report='/api/accounting/contribution-schedule?month=2032-07';
 expect((await ctx.api.get(report).set(hdr())).status).toBe(409);
 const journals=db.queryAll('SELECT * FROM journal_entries'),mails=db.queryAll('SELECT * FROM mail_log');
 const r=await review(p);expect(r.status).toBe(200);expect(read(p.record_id)).toEqual(before);
 expect(Object.keys(r.body.employee).sort()).toEqual(['employee_no','id','name']);
 const result=await confirm(p,r.body.review_token);expect(result.status).toBe(200);
 const after=read(p.record_id);for(const key of Object.keys(before).filter(k=>!['data','revision'].includes(k)))expect(after[key]).toEqual(before[key]);
 expect(JSON.parse(String(after.data))).toEqual({...JSON.parse(String(before.data)),cutoff_id:p.id});expect(after.revision).toBe(Number(before.revision)+1);
 const audit=db.queryOne<{reason:string;changed_by:number;source:string}>('SELECT * FROM form_record_revisions WHERE record_id=? AND revision=?',p.record_id,after.revision)!;
 expect(audit).toMatchObject({changed_by:1,source:'payroll-cutoff-recovery'});expect(JSON.parse(audit.reason)).toMatchObject({cutoff_id:p.id,previous_cutoff:'broken',evidence_reference:'CASE-CUTOFF-001'});
 expect((await ctx.api.get(report).set(hdr())).status).toBe(200);expect(db.queryAll('SELECT * FROM journal_entries')).toEqual(journals);expect(db.queryAll('SELECT * FROM mail_log')).toEqual(mails);
 expect((await confirm(p,r.body.review_token)).status).toBe(409);
});
it('projects a bounded preflight and enforces management permission and private no-store',async()=>{
 const p=slip(),r=await ctx.api.get(url(p.record_id)).set(hdr());expect(r.status).toBe(200);expect(r.headers['cache-control']).toContain('no-store');expect(r.body.hold).toBeNull();expect(r.body.cutoff.id).toBe(p.id);expect(r.body.record).not.toHaveProperty('data');
 expect((await ctx.api.get(url(p.record_id))).status).toBe(401);expect((await ctx.api.get(url(p.record_id)).set(hdr(clerk))).status).toBe(403);
 for(const action of ['review','confirm'])expect((await ctx.api.post(url(p.record_id)+'/'+action).set(hdr(clerk)).send({})).status).toBe(403);
});
it('accepts missing/null/invalid stamps while refusing a valid numeric or canonical string stamp',async()=>{
 for(const stamp of [null,undefined,'broken',{id:1},0,-1,1.5,'01',Number.MAX_SAFE_INTEGER+1]){const p=slip(cutoff(),{cutoff_id:stamp});const r=await review(p);expect(r.status).toBe(200);expect((await confirm(p,r.body.review_token)).status).toBe(200);}
 for(const text of [false,true]){const p=cutoff();const r=await review(slip(p,{cutoff_id:text?String(p.id):p.id}));expect(r.status).toBe(409);expect(r.body.error).toContain('valid cutoff');}
});
it('requires fresh verification for review and confirmation',async()=>{
 const p=slip(),r=await review(p);db.run("UPDATE session_stepups SET verified_at=datetime('now','-6 minutes') WHERE token_hash=?",db.tokenDigest(token));
 expect((await confirm(p,r.body.review_token)).body.step_up_required).toBe(true);
 expect((await ctx.api.post(url(p.record_id)+'/review').set(hdr()).send({})).body.step_up_required).toBe(true);
});
it('refuses paid, ever-paid and previously paid revision history even after unmarking',async()=>{
 expect((await review(slip(cutoff(),{},'paid'))).status).toBe(409);
 const p=slip();db.run("INSERT INTO payslip_paid_history(record_id,action,by_user_id,at) VALUES(?,'paid',1,datetime('now'))",p.record_id);expect((await review(p)).status).toBe(409);
 const q=slip(cutoff(),{},'paid');db.run("UPDATE form_records SET status='draft' WHERE id=?",q.record_id);expect((await review(q)).status).toBe(409);
});
it('refuses recovery when another employee in the same cutoff has paid history',async()=>{
 const p=slip(),otherEmployee=Number(db.run("INSERT INTO employees(employee_no,name) VALUES('CUTOFF-OTHER','Other synthetic employee')").lastInsertRowid);
 slip(p,{employee_id:otherEmployee,cutoff_id:p.id},'paid');expect((await review(p)).body.error).toContain('paid history');
});
it('refuses duplicate destinations, including a valid-stamped sibling not originally grouped with an invalid stamp',async()=>{
 const p=slip();slip(p,{cutoff_id:p.id});const before=read(p.record_id);expect((await review(p)).body.error).toContain('duplicate');expect(read(p.record_id)).toEqual(before);
});
it('refuses unresolved ownership and malformed current data',async()=>{
 expect((await review(slip(cutoff(),{employee_id:'broken'}))).body.error).toContain('owner');
 const p=slip();db.run("UPDATE form_records SET data='[]' WHERE id=?",p.record_id);expect((await review(p)).body.error).toContain('Unreadable');
});
it('refuses another cutoff, reused/unknown labels and conflicts with a saved calculation',async()=>{
 const p=slip(),other=cutoff();expect((await review(p,{cutoff_id:other.id})).status).toBe(409);
 db.run("INSERT INTO attendance_periods(label,start_date,end_date) VALUES(?,'2032-07-16','2032-07-31')",p.label);expect((await review(p)).status).toBe(409);
 const q=slip();db.run("UPDATE form_records SET period='CUTOFF-UNKNOWN' WHERE id=?",q.record_id);expect((await review(q)).status).toBe(409);
 const bad=slip(cutoff(),{_calculation_snapshot:JSON.stringify({period_label:other.label})});expect((await review(bad)).status).toBe(409);
 expect((await review(slip(cutoff(),{_calculation_snapshot:'broken'}))).status).toBe(409);
 expect((await review(slip(cutoff(),{payroll_period:other.label}))).status).toBe(409);
});
it('refuses a historical transfer even when its current stamp has become invalid',async()=>{
 const p=cutoff(),old=cutoff(),r=slip(p,{cutoff_id:old.id});db.run("UPDATE form_records SET data=json_set(data,'$.cutoff_id','broken') WHERE id=?",r.record_id);expect((await review(r)).body.error).toContain('previously identified');
});
it('refuses any journal history, including draft and reversed originals',async()=>{
 for(const status of ['draft','posted']){const p=slip();db.run("INSERT INTO journal_entries(number,entry_date,book,source_type,source_id,status) VALUES(?,'2032-07-16','payroll','payroll_run',?,?)",'CUTOFF-JE-'+p.id,p.id,status);expect((await review(p)).body.error).toContain('journal history');}
});
it('refuses closed cutoff ranges, closed pay dates and malformed dates',async()=>{
 const p=slip();db.run("INSERT INTO accounting_periods(name,start_date,end_date,status) VALUES('CUTOFF-CLOSED','2032-07-04','2032-07-05','closed')");expect((await review(p)).body.error).toContain('closed');db.run("DELETE FROM accounting_periods WHERE name='CUTOFF-CLOSED'");
 db.run("INSERT INTO accounting_periods(name,start_date,end_date,status) VALUES('CUTOFF-CLOSED','2032-07-16','2032-07-31','closed')");expect((await review(p)).body.error).toContain('pay date');db.run("DELETE FROM accounting_periods WHERE name='CUTOFF-CLOSED'");
 expect((await review(slip(cutoff(),{pay_date:'2032-02-30'}))).body.error).toContain('pay date');
 const q=slip();db.run("UPDATE attendance_periods SET end_date='2032-02-30' WHERE id=?",q.id);expect((await review(q)).body.error).toContain('cutoff dates');
});
it('holds a matching email attempt of any outcome without revealing the recipient',async()=>{
 const p=slip();db.run("INSERT INTO mail_log(to_addr,subject,status) VALUES('synthetic-private@example.test',?,'failed')",'Payslip — '+p.label);const r=await review(p);expect(r.status).toBe(409);expect(r.body.error).toContain('email attempt');expect(r.text).not.toContain('synthetic-private');
});
it('requires a reason, reference, explicit attestation and an exact schema',async()=>{
 const p=slip();for(const body of [{reason:''},{evidence_reference:''},{verified_records:false},{cutoff_id:0},{extra:true}])expect((await review(p,body)).status).toBe(400);
 const r=await review(p);expect((await ctx.api.post(url(p.record_id)+'/confirm').set(hdr()).send({review_token:r.body.review_token,cutoff_id:123})).status).toBe(400);
});
it('binds the credential to actor, session and record and rejects tampering/expiry',async()=>{
 const p=slip(),q=slip(),r=await review(p);const otherId=db.queryOne<{id:number}>("SELECT id FROM users WHERE username='cutoff-admin'")!.id;fresh(otherId,other);
 expect((await confirm(p,r.body.review_token,other)).status).toBe(409);expect((await confirm(q,r.body.review_token)).status).toBe(409);
 const second=await login(ctx.api);fresh(1,second);expect((await confirm(p,r.body.review_token,second)).status).toBe(409);
 expect((await confirm(p,r.body.review_token.slice(0,-5)+'aaaaa')).status).toBe(409);
 const {decryptSecret,encryptSecret}=await import('../src/shared/secrets');const intent=JSON.parse(decryptSecret(r.body.review_token));intent.expires_at=Date.now()-1;expect((await confirm(p,encryptSecret(JSON.stringify(intent)))).status).toBe(409);
});
it('rejects another review purpose and a stale submitted revision',async()=>{
 const p=slip(),r=await review(p);const {decryptSecret,encryptSecret}=await import('../src/shared/secrets');const intent=JSON.parse(decryptSecret(r.body.review_token));intent.purpose='payroll-identity-v1';expect((await confirm(p,encryptSecret(JSON.stringify(intent)))).status).toBe(409);
 db.run("UPDATE form_records SET data=json_set(data,'$.net_pay',900) WHERE id=?",p.record_id);expect((await review(p,{expected_revision:1})).status).toBe(409);
});
it('invalidates review on source, cutoff, employee or other payroll changes',async()=>{
 for(const change of ['source','cutoff','employee','other']){
  const p=slip(),q=slip(),r=await review(p);
  if(change==='source')db.run("UPDATE form_records SET data=json_set(data,'$.net_pay',900) WHERE id=?",p.record_id);
  if(change==='cutoff')db.run("UPDATE attendance_periods SET end_date='2032-07-14' WHERE id=?",p.id);
  if(change==='employee')db.run("UPDATE employees SET name=name||' updated' WHERE id=?",employee);
  if(change==='other')db.run("UPDATE form_records SET data=json_set(data,'$.net_pay',900) WHERE id=?",q.record_id);
  expect((await confirm(p,r.body.review_token)).status).toBe(409);
 }
});
it('rechecks new journal, closed-period, paid and email history at execution',async()=>{
 for(const change of ['journal','closed','paid','mail']){
  const p=slip(),r=await review(p);
  if(change==='journal')db.run("INSERT INTO journal_entries(number,entry_date,book,source_type,source_id,status) VALUES(?,'2032-07-16','payroll','payroll_run',?,'draft')",'CUTOFF-LATE-'+p.id,p.id);
  if(change==='closed')db.run("INSERT INTO accounting_periods(name,start_date,end_date,status) VALUES('CUTOFF-LATE-CLOSED','2032-07-01','2032-07-31','closed')");
  if(change==='paid')db.run("INSERT INTO payslip_paid_history(record_id,action,by_user_id,at) VALUES(?,'paid',1,datetime('now'))",p.record_id);
  if(change==='mail')db.run("INSERT INTO mail_log(to_addr,subject,status) VALUES('test@example.test',?,'sent')",'Payslip — '+p.label);
  const before=read(p.record_id);expect((await confirm(p,r.body.review_token)).status).toBe(409);expect(read(p.record_id)).toEqual(before);
  db.run("DELETE FROM accounting_periods WHERE name='CUTOFF-LATE-CLOSED'");
 }
});
it('rolls back the correction if mandatory revision history cannot be saved',async()=>{
 const p=slip(),before=read(p.record_id),r=await review(p);
 db.run(`CREATE TRIGGER cutoff_test_failure BEFORE INSERT ON form_record_revisions WHEN NEW.record_id=${p.record_id} AND NEW.source='payroll-cutoff-recovery' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END`);
 try{expect((await confirm(p,r.body.review_token)).status).toBe(500);expect(read(p.record_id)).toEqual(before);}finally{db.run('DROP TRIGGER cutoff_test_failure');}
});
it('accepts only one concurrent confirmation and redacts review credentials from logs',async()=>{
 const p=slip(),r=await review(p);const results=await Promise.all([confirm(p,r.body.review_token),confirm(p,r.body.review_token)]);expect(results.map(r=>r.status).sort()).toEqual([200,409]);
 expect(JSON.stringify(db.queryAll("SELECT meta FROM activity_log WHERE path LIKE '%/cutoff-recovery/confirm'"))).not.toContain(r.body.review_token);
});
it('does not persist ephemeral reviews or bypass freshness through HTTP retry receipts',async()=>{
 const p=slip();fresh(1,token);const body={cutoff_id:p.id,expected_revision:read(p.record_id).revision,reason:'Verified original attendance and payroll records',evidence_reference:'CASE-RECEIPT',verified_records:true};
 const r=await ctx.api.post(url(p.record_id)+'/review').set(hdr()).set('Idempotency-Key','cutoff-review-test-key').send(body);expect(r.status).toBe(200);expect(db.queryAll('SELECT 1 FROM idempotency_keys')).toEqual([]);
 db.run("UPDATE session_stepups SET verified_at=datetime('now','-6 minutes') WHERE token_hash=?",db.tokenDigest(token));expect((await ctx.api.post(url(p.record_id)+'/review').set(hdr()).set('Idempotency-Key','cutoff-review-test-key').send(body)).status).toBe(403);
 fresh(1,token);expect((await ctx.api.post(url(p.record_id)+'/confirm').set(hdr()).set('Idempotency-Key','cutoff-confirm-test-key').send({review_token:r.body.review_token})).status).toBe(200);expect(db.queryAll('SELECT 1 FROM idempotency_keys')).toEqual([]);
 db.run("UPDATE session_stepups SET verified_at=datetime('now','-6 minutes') WHERE token_hash=?",db.tokenDigest(token));const retry=await ctx.api.post(url(p.record_id)+'/confirm').set(hdr()).set('Idempotency-Key','cutoff-confirm-test-key').send({review_token:r.body.review_token});expect(retry.status).toBe(403);expect(retry.headers['idempotency-replayed']).toBeUndefined();
});
it('refuses foreign tenant and installed-node execution without queueing a repair',async()=>{
 const p=slip(),r=await review(p);const {createTenant}=await import('../src/platform/provisioning');createTenant({slug:'cutoffforeign',name:'Synthetic Cutoff Foreign',admin_username:'cutoff-foreign',admin_password:'Foreign cutoff test-only password',plan:'unlimited'});
 db.withTenant('cutoffforeign',()=>{const f=db.queryOne<{id:number}>("SELECT id FROM form_definitions WHERE slug='hr_payroll'")!;db.run("INSERT INTO form_records(id,form_def_id,number,data,status,created_by) VALUES(?,?,?,'{}','draft',1)",p.record_id,f.id,'FOREIGN-CUTOFF');});
 const login=await ctx.api.post('/cutoffforeign/api/auth/login').set('Host','cutoff.example.test').send({username:'cutoff-foreign',password:'Foreign cutoff test-only password'});expect(login.status).toBe(200);
 expect((await ctx.api.post('/cutoffforeign'+url(p.record_id)+'/confirm').set('Host','cutoff.example.test').set(hdr(login.body.token)).set('Idempotency-Key','cutoff-foreign-test-key').send({review_token:r.body.review_token})).status).toBe(409);
 db.withTenant('cutoffforeign',()=>expect(db.queryAll('SELECT 1 FROM idempotency_keys')).toEqual([]));
 const sync=await import('../src/sync'),conn=db.getDb('default');sync.enableSync(conn,{role:'node',nodeNo:21,isHost:true});
 try{expect((await ctx.api.get(url(p.record_id)).set(hdr())).status).toBe(503);for(const [action,body] of [['review',{}],['confirm',{review_token:r.body.review_token}]] as const){const denied=await ctx.api.post(url(p.record_id)+'/'+action).set(hdr()).send(body);expect(denied.status).toBe(503);expect(denied.body.sync).toBe('online');}expect(conn.prepare('SELECT COUNT(*) AS n FROM sync_commands').get()?.n).toBe(0);}finally{sync.enableSync(conn,{role:'cloud',nodeNo:0});}
});
