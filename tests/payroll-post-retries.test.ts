import {beforeAll,afterAll,it,expect} from 'vitest';
import crypto from 'node:crypto';
import {setupApp,cleanup,login,createEmployee,type TestContext} from './helpers';
let ctx:TestContext,token:string,db:typeof import('../src/shared/db'),form:number,employee:number,seq=0;
beforeAll(async()=>{process.env.TENANT_PATH_HOST='gl.example.test';ctx=await setupApp();token=await login(ctx.api);db=await import('../src/shared/db');
 employee=Number(db.run("INSERT INTO employees(employee_no,name) VALUES('GL-RETRY','Synthetic posting audit')").lastInsertRowid);
 form=db.queryOne<{id:number}>("SELECT id FROM form_definitions WHERE slug='hr_payroll'")!.id;
 expect((await ctx.api.post('/api/accounting/ledger/setup').auth(token,{type:'bearer'}).send({fiscal_year_start:'2026-01-01'})).status).toBe(201);
});
afterAll(()=>{delete process.env.TENANT_PATH_HOST;cleanup(ctx);});
function source(){const label='GL-RETRY-'+(++seq),id=Number(db.run("INSERT INTO attendance_periods(label,start_date,end_date) VALUES(?,'2026-07-01','2026-07-15')",label).lastInsertRowid);
 db.run("INSERT INTO form_records(form_def_id,number,data,status,period,created_by) VALUES(?,?,?,'draft',?,1)",form,label,JSON.stringify({employee_id:employee,employee_name:'Synthetic posting audit',cutoff_id:id,payroll_period:label,pay_date:'2026-07-15',total_earnings:1000,net_pay:1000}),label);return{id,label};}
const post=(p:{id:number;label:string},key?:string,actor=token,url=`/api/hr/periods/${p.id}/post-payroll-gl`)=>{
 const request=ctx.api.post(url).auth(actor,{type:'bearer'});if(key)request.set('Idempotency-Key',key);return request.send({payroll_period:p.label});
};
const journals=(p:{id:number})=>db.queryAll("SELECT id,number,reverses_id FROM journal_entries WHERE source_type='payroll_run' AND source_id=? ORDER BY id",p.id);
const receipt=(key:string,actor=1)=>'payroll-gl:v1:'+crypto.createHash('sha256').update(JSON.stringify([actor,key])).digest('hex');

it('rolls posting back when its mandatory keyed receipt cannot be saved',async()=>{
 const p=source();db.run("CREATE TRIGGER gl_retry_fail BEFORE INSERT ON idempotency_keys BEGIN SELECT RAISE(ABORT,'private synthetic receipt fault'); END");
 try{const r=await post(p,'gl-receipt-atomic');expect(r.status).toBe(500);expect(r.text).not.toContain('private synthetic');expect(journals(p)).toHaveLength(0);}
 finally{db.run('DROP TRIGGER gl_retry_fail');}
 expect((await post(p,'gl-receipt-atomic')).status).toBe(201);expect(journals(p)).toHaveLength(1);
});
it('replays a committed acknowledgement without reversal even after payroll changes',async()=>{
 const p=source(),key='gl-replay-current-source';const first=await post(p,key);expect(first.status).toBe(201);const before=journals(p);
 const row=db.queryOne<{id:number;data:string}>('SELECT id,data FROM form_records WHERE period=?',p.label)!;
 db.run('UPDATE form_records SET data=? WHERE id=?',JSON.stringify({...JSON.parse(row.data),net_pay:999}),row.id);
 const second=await post(p,key);expect(second.status).toBe(201);expect(second.headers['idempotency-replayed']).toBe('true');expect(second.body.entry).toEqual(first.body.entry);expect(second.body.replayed).toBe(true);expect(journals(p)).toEqual(before);
 const comparison=await ctx.api.get(`/api/hr/periods/${p.id}/payroll-reconciliation`).auth(token,{type:'bearer'});expect(comparison.body.ledger.state).toBe('unpostable');
});
it('serializes concurrent same-key submissions into one posting',async()=>{
 const p=source(),responses=await Promise.all(Array.from({length:12},()=>post(p,'gl-concurrent-same-key')));
 expect(responses.every(r=>r.status===201)).toBe(true);expect(new Set(responses.map(r=>r.body.entry.id)).size).toBe(1);expect(journals(p)).toHaveLength(1);
});
it('keeps explicit different-key and keyless re-posts compatible',async()=>{
 const p=source();expect((await post(p,'gl-explicit-first')).status).toBe(201);expect((await post(p,'gl-explicit-second')).status).toBe(201);expect(journals(p)).toHaveLength(3);
 const old=source();expect((await post(old)).status).toBe(201);expect((await post(old)).status).toBe(201);expect(journals(old)).toHaveLength(3);
});
it('rejects a changed body or cutoff under the same key before writing',async()=>{
 const p=source(),other=source(),key='gl-mismatched-request';expect((await post(p,key)).status).toBe(201);
 expect((await post({...p,label:p.label+' changed'},key)).status).toBe(409);expect((await post(other,key)).status).toBe(409);expect(journals(p)).toHaveLength(1);expect(journals(other)).toHaveLength(0);
});
it('checks current permission and session before returning a cached financial response',async()=>{
 const p=source(),actor=await createEmployee(ctx.api,token,{role:'hr'}),key='gl-current-actor';expect((await post(p,key,actor.token)).status).toBe(201);
 db.run("UPDATE users SET role='csr' WHERE id=?",actor.id);const denied=await post(p,key,actor.token);expect(denied.status).toBe(403);expect(denied.body.entry).toBeUndefined();expect(journals(p)).toHaveLength(1);
});
it('does not return a saved acknowledgement after its session is revoked',async()=>{
 const p=source(),actor=await createEmployee(ctx.api,token,{role:'hr'}),key='gl-revoked-session';expect((await post(p,key,actor.token)).status).toBe(201);
 db.run('DELETE FROM sessions WHERE user_id=?',actor.id);const denied=await post(p,key,actor.token);expect(denied.status).toBe(401);expect(denied.body.entry).toBeUndefined();expect(journals(p)).toHaveLength(1);
});
it('keeps identical actor IDs, period IDs and keys in separate tenant databases',async()=>{
 const p=source(),key='gl-cross-tenant-reference',first=await post(p,key);expect(first.status).toBe(201);
 const {createTenant}=await import('../src/platform/provisioning');createTenant({slug:'glforeign',name:'Synthetic GL Foreign',admin_username:'gl-foreign',admin_password:'Synthetic foreign GL password',plan:'unlimited'});
 db.withTenant('glforeign',()=>{
  const f=db.queryOne<{id:number}>("SELECT id FROM form_definitions WHERE slug='hr_payroll'")!.id,e=Number(db.run("INSERT INTO employees(employee_no,name) VALUES('GL-FOREIGN','Synthetic foreign GL')").lastInsertRowid);
  db.run("INSERT INTO attendance_periods(id,label,start_date,end_date) VALUES(?,?,'2026-07-01','2026-07-15')",p.id,p.label);
  db.run("INSERT INTO form_records(form_def_id,number,data,status,period,created_by) VALUES(?,?,?,'draft',?,1)",f,p.label,JSON.stringify({employee_id:e,cutoff_id:p.id,pay_date:'2026-07-15',total_earnings:2000,net_pay:2000}),p.label);
 });
 const signed=await ctx.api.post('/glforeign/api/auth/login').set('Host','gl.example.test').send({username:'gl-foreign',password:'Synthetic foreign GL password'});expect(signed.status).toBe(200);
 const base='/glforeign/api',headers={Host:'gl.example.test',Authorization:`Bearer ${signed.body.token}`,'Idempotency-Key':key};
 expect((await ctx.api.post(base+'/accounting/ledger/setup').set({Host:headers.Host,Authorization:headers.Authorization}).send({fiscal_year_start:'2026-01-01'})).status).toBe(201);
 const url=base+`/hr/periods/${p.id}/post-payroll-gl`;
 expect((await ctx.api.post(url).set({...headers,Authorization:`Bearer ${token}`}).send({payroll_period:p.label})).status).toBe(401);
 const foreign=await ctx.api.post(url).set(headers).send({payroll_period:p.label});expect(foreign.status).toBe(201);expect(foreign.headers['idempotency-replayed']).toBeUndefined();
 expect(db.withTenant('glforeign',()=>journals(p))).toHaveLength(1);expect(journals(p)).toHaveLength(1);
 expect((await post(p,key)).body.entry).toEqual(first.body.entry);
});
it('requires reconciliation of known legacy HTTP receipts instead of reposting',async()=>{
 for(const raw of [true,false]){const p=source(),key='gl-legacy-'+raw;
 const stored=raw?key:'v2:'+crypto.createHash('sha256').update(JSON.stringify([1,key])).digest('hex');
 db.run("INSERT INTO idempotency_keys(key,user_id,method,path,status_code,response) VALUES(?,1,'POST','old-binding',201,'{}')",stored);
 const r=await post(p,key);expect(r.status).toBe(409);expect(r.body.entry).toBeUndefined();expect(journals(p)).toHaveLength(0);}
});
it.each(['POST-PAYROLL-GL','post-payroll-gl/'])('handles Express alias %s without the generic cache intercepting',async suffix=>{
 const p=source(),key='gl-alias-'+(++seq),url=`/api/hr/periods/${p.id}/${suffix}`;
 db.run("INSERT INTO idempotency_keys(key,user_id,method,path,status_code,response) VALUES(?,1,'POST','bad-binding',201,'{\"private\":\"legacy marker\"}')",key);
 const r=await post(p,key,token,url);expect(r.status).toBe(409);expect(r.text).not.toContain('legacy marker');expect(journals(p)).toHaveLength(0);
});
it('retains financial receipt tombstones past the generic seven-day cleanup',async()=>{
 const p=source(),key='gl-retained-receipt';const first=await post(p,key);expect(first.status).toBe(201);
 db.run("UPDATE idempotency_keys SET created_at='2001-01-01' WHERE key=?",receipt(key));
 db.run("INSERT INTO idempotency_keys(key,user_id,method,path,status_code,response,created_at) VALUES('gl-old-generic',1,'POST','old',201,'{}','2001-01-01')");
 db.cleanupSessions();expect(db.queryOne('SELECT 1 FROM idempotency_keys WHERE key=?',receipt(key))).toBeTruthy();expect(db.queryOne("SELECT 1 FROM idempotency_keys WHERE key='gl-old-generic'")).toBeUndefined();
 expect((await post(p,key)).body.entry.id).toBe(first.body.entry.id);expect(journals(p)).toHaveLength(1);
});
it('holds a corrupt saved acknowledgement rather than executing it again',async()=>{
 const p=source(),key='gl-corrupt-receipt';expect((await post(p,key)).status).toBe(201);db.run("UPDATE idempotency_keys SET response='not json' WHERE key=?",receipt(key));
 expect((await post(p,key)).status).toBe(409);expect(journals(p)).toHaveLength(1);
});
it('stores neither the raw retry key nor the bearer in financial receipts',async()=>{
 const p=source(),key='gl-private-reference-'+crypto.randomBytes(16).toString('hex');expect((await post(p,key)).status).toBe(201);
 const row=db.queryOne('SELECT * FROM idempotency_keys WHERE key=?',receipt(key));expect(row).toBeTruthy();expect(JSON.stringify(row)).not.toContain(key);expect(JSON.stringify(row)).not.toContain(token);
});
it.each(['short','bad key with spaces'])('rejects malformed key %s without posting',async key=>{const p=source();expect((await post(p,key)).status).toBe(400);expect(journals(p)).toHaveLength(0);});
