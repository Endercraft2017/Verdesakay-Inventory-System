import {beforeAll,afterAll,it,expect} from 'vitest';
import {setupApp,cleanup,login,createEmployee,type TestContext} from './helpers';
let ctx:TestContext,token:string,other:string,clerk:string,employee:number,form:number;
let db:typeof import('../src/shared/db');let fresh:typeof import('../src/shared/step-up').markFreshVerification;
const hdr=(t=token)=>({Authorization:`Bearer ${t}`});
beforeAll(async()=>{
 process.env.TENANT_PATH_HOST='repair.example.test';ctx=await setupApp();token=await login(ctx.api);db=await import('../src/shared/db');fresh=(await import('../src/shared/step-up')).markFreshVerification;
 other=(await createEmployee(ctx.api,token,{role:'admin',username:'repair-admin'})).token;
 clerk=(await createEmployee(ctx.api,token,{role:'csr'})).token;
 const user=await createEmployee(ctx.api,token,{role:'csr',email:'repair-owner@example.test'});
 employee=Number(db.run("INSERT INTO employees(employee_no,name,user_id) VALUES('REPAIR-A','Repair Current',?)",user.id).lastInsertRowid);
 db.run("INSERT INTO employees(employee_no,name) VALUES('REPAIR-B','Repair Old')");
 db.run("INSERT INTO employee_profile_changes(employee_id,field,old_value,new_value,source) VALUES(?,'name','Repair Old','Repair Current','hr_edit')",employee);
 form=db.queryOne<{id:number}>("SELECT id FROM form_definitions WHERE slug='hr_payroll'")!.id;
});
afterAll(()=>{delete process.env.TENANT_PATH_HOST;cleanup(ctx);});
function slip(extra:Record<string,unknown>={},status='paid'){
 return Number(db.run("INSERT INTO form_records(form_def_id,number,data,status,created_by,updated_at) VALUES(?,?,?,?,1,'2026-01-01 00:00:00')",form,'REPAIR-'+Math.random(),JSON.stringify({employee_name:'Repair Old',net_pay:5000,_calculation_snapshot:'kept',...extra}),status).lastInsertRowid);
}
const read=(id:number)=>db.queryOne<Record<string,unknown>>('SELECT * FROM form_records WHERE id=?',id)!;
async function review(id:number,body:Record<string,unknown>={}){fresh(1,token);return ctx.api.post(`/api/hr/payroll/${id}/identity/review`).set(hdr()).send({employee_id:employee,expected_revision:read(id).revision,reason:'Verified original employment records',evidence_reference:'CASE-TEST-001',verified_records:true,...body});}
const confirm=(id:number,t:string,actor=token)=>ctx.api.post(`/api/hr/payroll/${id}/identity/confirm`).set(hdr(actor)).send({review_token:t});
it('lists bounded employee identity and denies non-managers/anonymous callers',async()=>{
 const id=slip();const r=await ctx.api.get(`/api/hr/payroll/${id}/identity`).set(hdr());expect(r.status).toBe(200);expect(r.headers['cache-control']).toContain('no-store');expect(r.body.resolved_employee_id).toBeNull();expect(Object.keys(r.body.employees[0]).sort()).toEqual(['id','employee_no','name','status'].sort());
 expect((await ctx.api.get(`/api/hr/payroll/${id}/identity`).set(hdr(clerk))).status).toBe(403);
 expect((await ctx.api.get(`/api/hr/payroll/${id}/identity`)).status).toBe(401);
 for(const path of ['review','confirm'])expect((await ctx.api.post(`/api/hr/payroll/${id}/identity/${path}`).set(hdr(clerk)).send({})).status).toBe(403);
});
it('requires fresh verification before issuing or confirming a review',async()=>{
 const id=slip(),r=await review(id);expect(r.status).toBe(200);
 db.run("UPDATE session_stepups SET verified_at=datetime('now','-6 minutes') WHERE token_hash=?",db.tokenDigest(token));
 expect((await confirm(id,r.body.review_token)).body.step_up_required).toBe(true);
 expect((await ctx.api.post(`/api/hr/payroll/${id}/identity/review`).set(hdr()).send({})).body.step_up_required).toBe(true);
});
it('preserves paid financial data, timestamps and history while granting the correct employee access',async()=>{
 const id=slip();const before=read(id),r=await review(id);expect(r.status).toBe(200);
 const result=await confirm(id,r.body.review_token);expect(result.status).toBe(200);const after=read(id);
 for(const key of Object.keys(before).filter(k=>!['data','revision'].includes(k)))expect(after[key]).toEqual(before[key]);
 expect(JSON.parse(String(after.data))).toEqual({...JSON.parse(String(before.data)),employee_id:employee});expect(after.revision).toBe(Number(before.revision)+1);
 const audit=db.queryOne<{source:string;reason:string;changed_by:number}>('SELECT * FROM form_record_revisions WHERE record_id=? AND revision=?',id,after.revision)!;
 expect(audit.source).toBe('payroll-identity-repair');expect(audit.changed_by).toBe(1);expect(JSON.parse(audit.reason)).toMatchObject({employee_id:employee,evidence_reference:'CASE-TEST-001'});
 expect((await confirm(id,r.body.review_token)).status).toBe(409);
});
it('rejects tampering and body overrides',async()=>{
 const id=slip(),r=await review(id);expect((await confirm(id,r.body.review_token.slice(0,-5)+'aaaaa')).status).toBe(409);
 expect((await ctx.api.post(`/api/hr/payroll/${id}/identity/confirm`).set(hdr()).send({review_token:r.body.review_token,employee_id:999})).status).toBe(400);
});
it('binds the review to the exact actor/session, record and employee/account state',async()=>{
 const id=slip(),r=await review(id);const {queryOne}=db;
 const user=queryOne<{id:number}>("SELECT id FROM users WHERE username='repair-admin'")!;fresh(user.id,other);
 expect((await confirm(id,r.body.review_token,other)).status).toBe(409);
 expect((await confirm(slip(),r.body.review_token)).status).toBe(409);
 db.run("UPDATE employees SET position='changed' WHERE id=?",employee); // unrelated excluded field: significant identity remains unchanged
 db.run("UPDATE users SET email='changed-owner@example.test' WHERE id=(SELECT user_id FROM employees WHERE id=?)",employee);
 expect((await confirm(id,r.body.review_token)).status).toBe(409);
});
it('rejects expired reviews and stale record revisions',async()=>{
 const id=slip(),r=await review(id);const {decryptSecret,encryptSecret}=await import('../src/shared/secrets');
 const value=JSON.parse(decryptSecret(r.body.review_token));value.expires_at=Date.now()-1;
 expect((await confirm(id,encryptSecret(JSON.stringify(value)))).status).toBe(409);
 db.run("UPDATE form_records SET data=json_set(data,'$.net_pay',6000) WHERE id=?",id);
 expect((await confirm(id,r.body.review_token)).status).toBe(409);
 expect((await review(id,{expected_revision:1})).status).toBe(409);
});
it('refuses resolved-owner transfers and invalid employee references',async()=>{
 expect((await review(slip({employee_id:employee}))).status).toBe(409);
 expect((await review(slip(),{employee_id:999999})).status).toBe(409);
 expect((await review(slip(),{verified_records:false})).status).toBe(400);
});
it('requires an explanation and reference, rather than accepting an automatic name match',async()=>{
 for(const body of [{reason:''},{evidence_reference:''},{extra_field:'ignored?'}])expect((await review(slip(),body)).status).toBe(400);
});
it('rolls back the identity change when revision history cannot be persisted',async()=>{
 const id=slip(),before=read(id),r=await review(id);
 db.run(`CREATE TRIGGER repair_test_failure BEFORE INSERT ON form_record_revisions WHEN NEW.record_id=${id} AND NEW.source='payroll-identity-repair' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END`);
 try{expect((await confirm(id,r.body.review_token)).status).toBe(500);expect(read(id)).toEqual(before);}finally{db.run('DROP TRIGGER repair_test_failure');}
});

it('does not allow the generic record editor to bypass ownership review',async()=>{
 const id=slip({},'draft');const data=JSON.parse(String(read(id).data));
 const r=await ctx.api.put(`/api/form-records/${id}`).set(hdr()).send({data:{...data,employee_name:'Repair Current'},expected_revision:read(id).revision});
 expect(r.status).toBe(409);expect(JSON.parse(String(read(id).data)).employee_name).toBe('Repair Old');
});

it('allows only one concurrent confirmation and redacts the review credential from request logs',async()=>{
 const id=slip(),r=await review(id);const results=await Promise.all([confirm(id,r.body.review_token),confirm(id,r.body.review_token)]);
 expect(results.map(r=>r.status).sort()).toEqual([200,409]);
 const logs=db.queryAll<{meta:string|null}>("SELECT meta FROM activity_log WHERE path LIKE '%/identity/confirm'");expect(JSON.stringify(logs)).not.toContain(r.body.review_token);
});
it('does not accept another fresh session belonging to the same operator',async()=>{
 const id=slip(),r=await review(id);const second=await login(ctx.api);fresh(1,second);expect((await confirm(id,r.body.review_token,second)).status).toBe(409);
});
it('rejects the default-company review at a different real tenant path',async()=>{
 const id=slip(),r=await review(id);const {createTenant}=await import('../src/platform/provisioning');
 createTenant({slug:'repairforeign',name:'Synthetic Foreign',admin_username:'repair-foreign',admin_password:'Foreign repair test-only password',plan:'unlimited'});
 db.withTenant('repairforeign',()=>{
  const f=db.queryOne<{id:number}>("SELECT id FROM form_definitions WHERE slug='hr_payroll'")!;
  db.run("INSERT INTO form_records(id,form_def_id,number,data,status,created_by) VALUES(?,?,?,'{}','paid',1)",id,f.id,'FOREIGN-REPAIR');
 });
 const login=await ctx.api.post('/repairforeign/api/auth/login').set('Host','repair.example.test').send({username:'repair-foreign',password:'Foreign repair test-only password'});expect(login.status).toBe(200);
 const result=await ctx.api.post(`/repairforeign/api/hr/payroll/${id}/identity/confirm`).set('Host','repair.example.test').set(hdr(login.body.token)).send({review_token:r.body.review_token});expect(result.status).toBe(409);
});
it('preserves malformed legacy IDs during ordinary editing instead of reviving name fallback',async()=>{
 const id=slip({employee_id:'broken-id',employee_name:'Repair Current'},'draft');const data=JSON.parse(String(read(id).data));
 const result=await ctx.api.put(`/api/form-records/${id}`).set(hdr()).send({data,expected_revision:read(id).revision});expect(result.status).toBe(200);
 const saved=JSON.parse(String(read(id).data));expect(saved.employee_id).toBe('broken-id');
 expect((await import('../src/modules/payroll/payslip-owner')).payslipOwnerResolver().idOf(saved)).toBeNull();
});
it('never caches review credentials or bypasses fresh proof through an HTTP retry key',async()=>{
 const id=slip();fresh(1,token);const body={employee_id:employee,expected_revision:read(id).revision,reason:'Verified original employment records',evidence_reference:'CASE-CACHE-001',verified_records:true};
 const path=`/api/hr/payroll/${id}/identity/review`;
 expect((await ctx.api.post(path).set(hdr()).set('Idempotency-Key','repair-review-test-key').send(body)).status).toBe(200);
 expect(db.queryAll("SELECT 1 FROM idempotency_keys WHERE path LIKE '%/identity/%'")).toEqual([]);
 db.run("UPDATE session_stepups SET verified_at=datetime('now','-6 minutes') WHERE token_hash=?",db.tokenDigest(token));
 const denied=await ctx.api.post(path).set(hdr()).set('Idempotency-Key','repair-review-test-key').send(body);expect(denied.status).toBe(403);expect(denied.body.step_up_required).toBe(true);
});
it('refuses review and confirmation on an installed office node without queuing a repair',async()=>{
 const id=slip(),r=await review(id);const sync=await import('../src/sync');const conn=db.getDb('default');const before=read(id);
 sync.enableSync(conn,{role:'node',nodeNo:19,isHost:true});
 try{
  expect((await ctx.api.get(`/api/hr/payroll/${id}/identity`).set(hdr())).status).toBe(503);
  for(const [path,body] of [['review',{}],['confirm',{review_token:r.body.review_token}]] as const){const denied=await ctx.api.post(`/api/hr/payroll/${id}/identity/${path}`).set(hdr()).send(body);expect(denied.status).toBe(503);expect(denied.body.sync).toBe('online');}
  expect(read(id)).toEqual(before);expect(conn.prepare('SELECT COUNT(*) AS n FROM sync_commands').get()?.n).toBe(0);
 }finally{sync.enableSync(conn,{role:'cloud',nodeNo:0});}
});
