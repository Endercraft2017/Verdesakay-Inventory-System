import {beforeAll,afterAll,afterEach,it,expect,vi} from 'vitest';
import {setupApp,cleanup,login,createEmployee,type TestContext} from './helpers';
const mail=vi.hoisted(()=>({send:vi.fn(async()=>({ok:true,id:'synthetic-release-mail'}))}));
vi.mock('../src/shared/mailer',async original=>({...await original<typeof import('../src/shared/mailer')>(),sendMail:mail.send}));
let ctx:TestContext,admin:string,clerk:string,owner:string,other:string,employee:number,form:number,seq=0,db:typeof import('../src/shared/db');
const h=(t=admin)=>({Authorization:`Bearer ${t}`});
beforeAll(async()=>{
 process.env.TENANT_PATH_HOST='release.example.test';ctx=await setupApp();admin=await login(ctx.api);db=await import('../src/shared/db');
 const user=await createEmployee(ctx.api,admin,{role:'csr',email:'release-owner@example.test'});owner=user.token;
 const outsider=await createEmployee(ctx.api,admin,{role:'csr'});clerk=outsider.token;other=clerk;
 employee=Number(db.run("INSERT INTO employees(employee_no,name,user_id) VALUES('REL-EMP','Synthetic Release Owner',?)",user.id).lastInsertRowid);
 db.run("INSERT INTO employees(employee_no,name,user_id) VALUES('REL-OTHER','Synthetic Other Employee',?)",outsider.id);
 form=db.queryOne<{id:number}>("SELECT id FROM form_definitions WHERE slug='hr_payroll'")!.id;
});
afterAll(()=>{delete process.env.TENANT_PATH_HOST;cleanup(ctx);});
afterEach(()=>{db.run('DELETE FROM form_records WHERE form_def_id=?',form);db.run("DELETE FROM attendance_periods WHERE label LIKE 'REL-%'");mail.send.mockClear();});
function cutoff(){const label='REL-'+(++seq);return {label,id:Number(db.run("INSERT INTO attendance_periods(label,start_date,end_date) VALUES(?,'2034-07-01','2034-07-15')",label).lastInsertRowid)};}
function slip(p=cutoff(),extra:Record<string,unknown>={},status='draft'){
 return {period:p,id:Number(db.run('INSERT INTO form_records(form_def_id,number,data,status,period,created_by) VALUES(?,?,?,?,?,1)',form,'REL-SLIP-'+(++seq),JSON.stringify({employee_id:employee,employee_name:'Synthetic Release Owner',cutoff_id:p.id,pay_date:'2034-07-16',basic_salary:1000,total_earnings:1000,net_pay:1000,...extra}),status,p.label).lastInsertRowid)};
}
const mark=(id:number)=>ctx.api.post(`/api/hr/payroll/${id}/mark-paid`).set(h()).send({});
const send=(id:number)=>ctx.api.post(`/api/hr/payroll/${id}/email`).set(h()).send({});
const raw=(id:number)=>db.queryOne<Record<string,unknown>>('SELECT * FROM form_records WHERE id=?',id)!;
it('refuses marking duplicate sources paid without status, timestamp or paid-history writes',async()=>{
 const a=slip();slip(a.period);const before=raw(a.id),history=db.queryAll('SELECT * FROM payslip_paid_history');const r=await mark(a.id);expect(r.status).toBe(409);expect(raw(a.id)).toEqual(before);expect(db.queryAll('SELECT * FROM payslip_paid_history')).toEqual(history);
});
it('refuses emailing a draft before mailbox/provider activity',async()=>{const a=slip();expect((await send(a.id)).status).toBe(409);expect(mail.send).not.toHaveBeenCalled();});
it('withholds duplicate paid rows from employee list, PDF and timekeeping',async()=>{
 const a=slip(cutoff(),{},'paid');slip(a.period,{},'paid');const list=await ctx.api.get('/api/me/payslips').set(h(owner));expect(list.status).toBe(200);expect(list.body.map((r:{id:number})=>r.id)).not.toContain(a.id);
 for(const suffix of ['pdf','timekeeping']){const r=await ctx.api.get(`/api/me/payslips/${a.id}/${suffix}`).set(h(owner));expect(r.status).toBe(404);expect(r.body).toEqual({error:'Payslip not found'});}
 expect((await send(a.id)).status).toBe(409);expect(mail.send).not.toHaveBeenCalled();
});
it('accepts valid draft payment and permits only its owner to download the resulting paid slip',async()=>{
 const a=slip();expect((await mark(a.id)).status).toBe(200);expect((await ctx.api.get(`/api/me/payslips/${a.id}/pdf`).set(h(owner))).status).toBe(200);expect((await ctx.api.get(`/api/me/payslips/${a.id}/pdf`).set(h(other))).status).toBe(404);
 expect((await send(a.id)).status).toBe(409);expect(mail.send).not.toHaveBeenCalled(); // email requires a separate exact-content review
});
it('holds malformed payloads, invalid explicit cutoff/owner IDs and unsupported statuses',async()=>{
 for(const extra of [{cutoff_id:'broken'},{employee_id:'broken'}]){const a=slip(cutoff(),extra);expect((await mark(a.id)).status).toBe(409);}
 const a=slip();db.run("UPDATE form_records SET data='[]' WHERE id=?",a.id);expect((await mark(a.id)).status).toBe(409);
 expect((await mark(slip(cutoff(),{},'rejected').id)).status).toBe(409);
});
it('rejects invalid numeric shapes and impossible pay dates without silently coercing them',async()=>{
 for(const extra of [{net_pay:{}},{total_earnings:true},{total_deductions:'NaN'},{pay_date:'2034-02-30'}]){const a=slip(cutoff(),extra);expect((await mark(a.id)).status).toBe(409);}
});
it('holds ambiguous unstamped cutoff labels and never chooses one duplicate as a winner',async()=>{
 const p=cutoff();db.run("INSERT INTO attendance_periods(label,start_date,end_date) VALUES(?,'2034-07-16','2034-07-31')",p.label);const a=slip(p,{cutoff_id:null});expect((await mark(a.id)).status).toBe(409);
});
it('holds invalid siblings under a recorded custom alias instead of checking only the canonical cutoff label',async()=>{
 const a=slip(),bad=slip(a.period,{cutoff_id:'broken'});db.run("UPDATE form_records SET period='REL-CUSTOM-ALIAS' WHERE id IN (?,?)",a.id,bad.id);expect((await mark(a.id)).status).toBe(409);
});
it('accepts one concurrent paid transition with one paid-history row',async()=>{
 const a=slip();const results=await Promise.all([mark(a.id),mark(a.id)]);expect(results.map(r=>r.status).sort()).toEqual([200,400]);expect(db.queryAll("SELECT * FROM payslip_paid_history WHERE record_id=? AND action='paid'",a.id)).toHaveLength(1);
});
it('keeps historical unique legacy records compatible while checking normalized ownership',async()=>{
 const p={id:999999,label:'REL-LEGACY-UNKNOWN'},a=slip(p,{cutoff_id:null,employee_id:null,employee_name:' synthetic release owner '});expect((await mark(a.id)).status).toBe(200);expect((await ctx.api.get(`/api/me/payslips/${a.id}/pdf`).set(h(owner))).status).toBe(200);
});
it('does not let unrelated corrupt JSON crash the employee list or expose record details',async()=>{
 const a=slip(cutoff(),{},'paid'),bad=slip();db.run("UPDATE form_records SET data='broken-json' WHERE id=?",bad.id);const r=await ctx.api.get('/api/me/payslips').set(h(owner));expect(r.status).toBe(200);expect(r.body.map((x:{id:number})=>x.id)).toContain(a.id);expect(r.text).not.toContain('broken-json');
});
it('rechecks source state at download/send time after an earlier valid list',async()=>{
 const a=slip(cutoff(),{},'paid');expect((await ctx.api.get('/api/me/payslips').set(h(owner))).body.some((x:{id:number})=>x.id===a.id)).toBe(true);slip(a.period);
 expect((await ctx.api.get(`/api/me/payslips/${a.id}/pdf`).set(h(owner))).status).toBe(404);expect((await send(a.id)).status).toBe(409);expect(mail.send).not.toHaveBeenCalled();
});
it('requires payroll management on both staff operations and preserves employee isolation',async()=>{
 const a=slip();for(const path of ['mark-paid','email']){expect((await ctx.api.post(`/api/hr/payroll/${a.id}/${path}`).send({})).status).toBe(401);expect((await ctx.api.post(`/api/hr/payroll/${a.id}/${path}`).set(h(clerk)).send({})).status).toBe(403);}
});
it('rolls back payment status when the paid audit write fails',async()=>{
 const a=slip(),before=raw(a.id);db.run(`CREATE TRIGGER rel_history_fail BEFORE INSERT ON payslip_paid_history WHEN NEW.record_id=${a.id} BEGIN SELECT RAISE(ABORT,'synthetic payment history failure'); END`);
 try{expect((await mark(a.id)).status).toBe(500);expect(raw(a.id)).toEqual(before);}finally{db.run('DROP TRIGGER rel_history_fail');}
});
it('returns only the established self-service projection with private no-store responses',async()=>{
 const a=slip(cutoff(),{},'paid'),r=await ctx.api.get('/api/me/payslips').set(h(owner));expect(r.headers['cache-control']).toContain('no-store');const row=r.body.find((x:{id:number})=>x.id===a.id);expect(Object.keys(row).sort()).toEqual(['id','number','period','status','data','created_at','updated_at','finalized','finalized_at','download_url'].sort());
});
it('keeps matching record IDs in separate real tenants scoped to their own source and session',async()=>{
 const a=slip(cutoff(),{},'paid');const {createTenant}=await import('../src/platform/provisioning');createTenant({slug:'releaseforeign',name:'Synthetic Release Foreign',admin_username:'release-foreign',admin_password:'Synthetic foreign release password',plan:'unlimited'});
 db.withTenant('releaseforeign',()=>{
  const f=db.queryOne<{id:number}>("SELECT id FROM form_definitions WHERE slug='hr_payroll'")!;
  const e=Number(db.run("INSERT INTO employees(employee_no,name,user_id) VALUES('REL-FOREIGN','Foreign Scoped Employee',1)").lastInsertRowid);
  db.run("INSERT INTO form_records(id,form_def_id,number,data,status,created_by) VALUES(?,?,?,?,'paid',1)",a.id,f.id,'FOREIGN-RELEASE',JSON.stringify({employee_id:e,employee_name:'Foreign Scoped Employee',net_pay:333}));
 });
 const login=await ctx.api.post('/releaseforeign/api/auth/login').set('Host','release.example.test').send({username:'release-foreign',password:'Synthetic foreign release password'});expect(login.status).toBe(200);
 const r=await ctx.api.get('/releaseforeign/api/me/payslips').set('Host','release.example.test').set(h(login.body.token));expect(r.status).toBe(200);expect(r.body.map((x:{number:string})=>x.number)).toEqual(['FOREIGN-RELEASE']);expect(r.body[0].data.net_pay).toBe(333);
 expect((await ctx.api.get(`/releaseforeign/api/me/payslips/${a.id}/pdf`).set('Host','release.example.test').set(h(owner))).status).toBe(401);
});
