import {beforeAll,afterAll,beforeEach,describe,it,expect,vi} from 'vitest';
import {setupApp,cleanup,login,createEmployee,type TestContext} from './helpers';
const mail=vi.hoisted(()=>({send:vi.fn(async()=>({ok:true,id:'synthetic-mail'}))}));
vi.mock('../src/shared/mailer',async original=>({...await original<typeof import('../src/shared/mailer')>(),sendMail:mail.send}));
let ctx:TestContext,admin:string,a:{id:number;token:string},b:{id:number;token:string},c:{id:number;token:string};
let aid:number,bid:number,cid:number,legacy:number,stamped:number,dangling:number,unique:number,textStamp:number;
let run:typeof import('../src/shared/db').run;
const hdr=(token:string)=>({Authorization:`Bearer ${token}`});
beforeAll(async()=>{
 ctx=await setupApp();admin=await login(ctx.api);({run}=await import('../src/shared/db'));
 a=await createEmployee(ctx.api,admin,{role:'csr',email:'old-owner@example.test'});
 b=await createEmployee(ctx.api,admin,{role:'csr',email:'new-holder@example.test'});
 c=await createEmployee(ctx.api,admin,{role:'csr',email:'unique-owner@example.test'});
 const employee=(no:string,name:string,user:number)=>Number(run('INSERT INTO employees(employee_no,name,user_id) VALUES(?,?,?)',no,name,user).lastInsertRowid);
 aid=employee('DISC-A','Ada New',a.id);bid=employee('DISC-B','Ada Old',b.id);cid=employee('DISC-C','Cara New',c.id);
 for(const [id,name] of [[aid,'Ada Old'],[cid,'Cara Old']] as const)run("INSERT INTO employee_profile_changes(employee_id,field,old_value,new_value,source) VALUES(?,'name',?,?,'hr_edit')",id,name,id===aid?'Ada New':'Cara New');
 const form=(await import('../src/shared/db')).queryOne<{id:number}>("SELECT id FROM form_definitions WHERE slug='hr_payroll'")!;
 const slip=(number:string,data:Record<string,unknown>)=>Number(run("INSERT INTO form_records(form_def_id,number,data,status,created_by) VALUES(?,?,?,'paid',1)",form.id,number,JSON.stringify({...data,net_pay:12345})).lastInsertRowid);
 textStamp=slip('DISC-TEXT-ID',{employee_name:'Ada Old',employee_id:String(aid)});
 legacy=slip('DISC-LEGACY',{employee_name:'Ada Old'});stamped=slip('DISC-STAMP',{employee_name:'Ada Old',employee_id:aid});
 dangling=slip('DISC-DANGLING',{employee_name:'Ada Old',employee_id:999999});unique=slip('DISC-UNIQUE',{employee_name:'Cara Old'});
});
afterAll(()=>cleanup(ctx));beforeEach(()=>mail.send.mockClear());
describe('payslip disclosure identity',()=>{
 it('does not show a legacy reused name to either employee',async()=>{
  for(const user of [a,b]){const res=await ctx.api.get('/api/me/payslips').set(hdr(user.token));expect(res.status).toBe(200);expect(res.body.map((r:{id:number})=>r.id)).not.toContain(legacy);}
 });
 it('refuses PDF and timekeeping disclosure for ambiguous legacy names',async()=>{
  for(const user of [a,b])for(const suffix of ['pdf','timekeeping'])expect((await ctx.api.get(`/api/me/payslips/${legacy}/${suffix}`).set(hdr(user.token))).status).toBe(404);
 });
 it('keeps a stamped renamed payslip scoped to its original employee',async()=>{
  for(const id of [stamped,textStamp]){
   expect((await ctx.api.get(`/api/me/payslips/${id}/pdf`).set(hdr(a.token))).status).toBe(200);
   expect((await ctx.api.get(`/api/me/payslips/${id}/pdf`).set(hdr(b.token))).status).toBe(404);
  }
  expect((await ctx.api.get(`/api/me/payslips/${stamped}/pdf`).set(hdr(b.token))).status).toBe(404);
 });
 it('does not email an ambiguous legacy name to the current name holder',async()=>{
  const res=await ctx.api.post(`/api/hr/payroll/${legacy}/email`).set(hdr(admin));
  expect(res.status).toBe(409);expect(res.body.error).toMatch(/unresolved employee ownership/);expect(mail.send).not.toHaveBeenCalled();
 });
 it('does not fall back to a name when a stamped employee no longer exists',async()=>{
  expect((await ctx.api.post(`/api/hr/payroll/${dangling}/email`).set(hdr(admin))).status).toBe(409);expect(mail.send).not.toHaveBeenCalled();
 });
 it('emails stamped and uniquely resolved former names to the correct linked account',async()=>{
  for(const [id,email] of [[stamped,'old-owner@example.test'],[unique,'unique-owner@example.test']] as const){expect((await ctx.api.post(`/api/hr/payroll/${id}/email`).set(hdr(admin))).status).toBe(200);expect(mail.send).toHaveBeenLastCalledWith(expect.objectContaining({to:email}),expect.any(Number));}
 });
 it('retains a unique legacy former-name download',async()=>{
  expect((await ctx.api.get(`/api/me/payslips/${unique}/pdf`).set(hdr(c.token))).status).toBe(200);
 });
 it('does not grant an employee payroll email authority',async()=>{
  expect((await ctx.api.post(`/api/hr/payroll/${stamped}/email`).set(hdr(a.token))).status).toBe(403);expect(mail.send).not.toHaveBeenCalled();
 });
 it('refuses duplicate normalized current names and shared historical aliases',async()=>{
  run("INSERT INTO employees(employee_no,name) VALUES('DISC-D',' duplicate Name '),('DISC-E','DUPLICATE NAME')");
  run("INSERT INTO employee_profile_changes(employee_id,field,old_value,source) VALUES(?,'name','Shared Alias','hr_edit'),(?,'name','Shared Alias','hr_edit')",aid,cid);
  const owner=(await import('../src/modules/payroll/payslip-owner')).payslipOwnerResolver();
  expect(owner.idOf({employee_name:'duplicate name'})).toBeNull();expect(owner.idOf({employee_name:'Shared Alias'})).toBeNull();
 });
 it('treats malformed explicit identity as unresolved instead of coercing or falling back',async()=>{
  const owner=(await import('../src/modules/payroll/payslip-owner')).payslipOwnerResolver();
  for(const id of [0,-1,'',true,[cid],{},1.5,'not-an-id',999999])expect(owner.idOf({employee_id:id,employee_name:'Cara New'})).toBeNull();
  expect(owner.idOf({employee_id:String(cid),employee_name:'Wrong Name'})).toBe(cid);
 });
 for(const kind of ['ambiguous','dangling'])it(`blocks payroll generation before writes for ${kind} cutoff identity`,async()=>{
  const {queryOne}=await import('../src/shared/db');
  const label='Identity Hold '+kind;
  const period=Number(run("INSERT INTO attendance_periods(label,start_date,end_date) VALUES(?,'2026-09-01','2026-09-01')",label).lastInsertRowid);
  run("INSERT INTO attendance_records(period_id,employee_id,work_date) VALUES(?,?,'2026-09-01')",period,aid);
  const form=queryOne<{id:number}>("SELECT id FROM form_definitions WHERE slug='hr_payroll'")!;
  const data=JSON.stringify({employee_name:'Ada Old',...(kind==='dangling'?{employee_id:999999}:{}),cutoff_id:period,net_pay:7777});
  const record=Number(run("INSERT INTO form_records(form_def_id,number,data,status,period,created_by) VALUES(?,?,?,'paid',?,1)",form.id,'DISC-HOLD-'+kind,data,label).lastInsertRowid);
  const before=queryOne<{n:number}>('SELECT COUNT(*) AS n FROM form_records')!.n;
  const res=await ctx.api.post(`/api/hr/periods/${period}/generate-payslips`).set(hdr(admin)).send({payroll_period:label});
  expect(res.status).toBe(409);expect(res.body.unresolved_record_ids).toContain(record);
  expect(queryOne<{n:number}>('SELECT COUNT(*) AS n FROM form_records')!.n).toBe(before);
  expect(queryOne<{data:string}>('SELECT data FROM form_records WHERE id=?',record)!.data).toBe(data);
 });

});
