import {beforeAll,afterAll,afterEach,it,expect} from 'vitest';
import {setupApp,cleanup,login,createEmployee,type TestContext} from './helpers';
let ctx:TestContext,admin:string,viewer:string,clerk:string,form:number,employee:number,seq=0,db:typeof import('../src/shared/db');
const h=(token=admin)=>({Authorization:`Bearer ${token}`});
beforeAll(async()=>{
 process.env.TENANT_PATH_HOST='copy.example.test';ctx=await setupApp();admin=await login(ctx.api);db=await import('../src/shared/db');
 await ctx.api.post('/api/roles').set(h()).send({label:'Copy Reader',permissions:['payroll.view']});
 viewer=(await createEmployee(ctx.api,admin,{role:'copy_reader'})).token;
 clerk=(await createEmployee(ctx.api,admin,{role:'csr'})).token;
 form=db.queryOne<{id:number}>("SELECT id FROM form_definitions WHERE slug='hr_payroll'")!.id;
 employee=Number(db.run("INSERT INTO employees(employee_no,name) VALUES('COPY-EMP','Synthetic Copy Employee')").lastInsertRowid);
});
afterAll(()=>{delete process.env.TENANT_PATH_HOST;cleanup(ctx);});
afterEach(()=>{db.run('DELETE FROM form_records WHERE form_def_id=?',form);db.run("DELETE FROM attendance_periods WHERE label LIKE 'COPY-%'");});
function slip(status='draft',p?:{id:number;label:string},extra:Record<string,unknown>={}){
 p??={label:'COPY-'+(++seq),id:0};if(!p.id)p.id=Number(db.run("INSERT INTO attendance_periods(label,start_date,end_date) VALUES(?,'2036-01-01','2036-01-15')",p.label).lastInsertRowid);
 return {period:p,id:Number(db.run('INSERT INTO form_records(form_def_id,number,data,status,period,created_by) VALUES(?,?,?,?,?,1)',form,'COPY-SLIP-'+(++seq),JSON.stringify({employee_id:employee,employee_name:'Synthetic Copy Employee',cutoff_id:p.id,net_pay:1000,total_earnings:1000,_calculation_snapshot:'private unused breakdown',...extra}),status,p.label).lastInsertRowid)};
}
const copy=(ids:number[],expected?:string,token=admin)=>ctx.api.get('/api/hr/payroll/copy').set(h(token)).query({form_id:form,ids:ids.join(','),...(expected?{expected}:{})});
it('lets a payroll reader reload saved values with a bounded private projection and draft notice',async()=>{
 const a=slip(),r=await copy([a.id],undefined,viewer);expect(r.status).toBe(200);expect(r.headers['cache-control']).toContain('no-store');expect(r.body.records[0].data.net_pay).toBe(1000);expect(r.body.records[0].data).not.toHaveProperty('_calculation_snapshot');expect(Object.keys(r.body.records[0]).sort()).toEqual(['id','number','period','status','data','created_at','updated_at','revision'].sort());expect(r.body.notice).toContain('DRAFT');expect(r.body.snapshot).toMatch(/^[a-f0-9]{64}$/);
});
it('requires authentication and payroll viewing independently of HR/form permissions',async()=>{
 const a=slip();expect((await ctx.api.get('/api/hr/payroll/copy').query({form_id:form,ids:a.id})).status).toBe(401);expect((await copy([a.id],undefined,clerk)).status).toBe(403);
});
it('blocks the whole requested batch for a duplicate even when its sibling is not selected',async()=>{
 const a=slip(),b=slip();slip('paid',a.period);const r=await copy([a.id,b.id]);expect(r.status).toBe(409);expect(r.body).not.toHaveProperty('records');expect(r.body.error).toContain('duplicate');
});
it('refuses corrupt source, invalid identity, invalid money and unsupported status',async()=>{
 for(const extra of [{employee_id:'bad'},{cutoff_id:'bad'},{net_pay:{}}]){const a=slip('draft',undefined,extra);expect((await copy([a.id])).status).toBe(409);}
 const a=slip();db.run("UPDATE form_records SET data='broken' WHERE id=?",a.id);expect((await copy([a.id])).status).toBe(409);expect((await copy([slip('completed').id])).status).toBe(409);
});
it('accepts an unchanged preview precondition and rejects changed saved money/status/revision',async()=>{
 const a=slip(),r=await copy([a.id]);expect(r.status).toBe(200);expect((await copy([a.id],r.body.snapshot)).status).toBe(200);
 db.run("UPDATE form_records SET data=json_set(data,'$.net_pay',2000) WHERE id=?",a.id);const changed=await copy([a.id],r.body.snapshot);expect(changed.status).toBe(409);expect(changed.body.error).toContain('changed');expect(changed.body).not.toHaveProperty('records');
});
it('revalidates source holds at print time even with the original matching preview hash',async()=>{
 const a=slip(),r=await copy([a.id]);slip('draft',a.period);expect((await copy([a.id],r.body.snapshot)).status).toBe(409);
});
it('checks cutoff metadata changes as part of the preview precondition',async()=>{
 const a=slip(),r=await copy([a.id]);db.run("UPDATE attendance_periods SET end_date='2036-01-16' WHERE id=?",a.period.id);expect((await copy([a.id],r.body.snapshot)).status).toBe(409);
});
it('refuses missing/nonpayroll IDs without returning a partial batch',async()=>{
 const a=slip();expect((await copy([a.id,999999])).status).toBe(404);
 const f=db.queryOne<{id:number}>("SELECT id FROM form_definitions WHERE slug!='hr_payroll' LIMIT 1")!;
 const other=Number(db.run("INSERT INTO form_records(form_def_id,number,data,status,created_by) VALUES(?,'COPY-OTHER','{}','draft',1)",f.id).lastInsertRowid);
 try{expect((await copy([a.id,other])).status).toBe(404);expect((await ctx.api.get('/api/hr/payroll/copy').set(h()).query({form_id:f.id,ids:other})).status).toBe(404);}finally{db.run('DELETE FROM form_records WHERE id=?',other);}
});
it('bounds batches and strictly validates IDs, repeated parameters and snapshot hashes',async()=>{
 const a=slip();for(const q of [{ids:''},{ids:'0'},{ids:'1e2'},{ids:'1,1'},{ids:'9007199254740992'},{ids:Array.from({length:201},(_,i)=>i+1).join(',')},{ids:[String(a.id),String(a.id)]},{ids:String(a.id),expected:'bad'},{ids:String(a.id),extra:'unexpected'}]){
  expect((await ctx.api.get('/api/hr/payroll/copy').set(h()).query({form_id:form,...q})).status).toBe(400);
 }
});
it('labels Paid-only copies separately and never treats a mixed selection as finalized',async()=>{
 const a=slip('paid'),b=slip();expect((await copy([a.id])).body.notice).toContain('PAID RECORD COPY');expect((await copy([a.id,b.id])).body.notice).toContain('DRAFT');
});
it('preserves requested order and changes the snapshot when the selected set changes',async()=>{
 const a=slip(),b=slip(),one=await copy([a.id]),two=await copy([b.id,a.id]);expect(two.body.records.map((r:{id:number})=>r.id)).toEqual([b.id,a.id]);expect(two.body.snapshot).not.toBe(one.body.snapshot);
});

it('keeps matching IDs and snapshot checks scoped to the authenticated tenant',async()=>{
 const a=slip(),{createTenant}=await import('../src/platform/provisioning');
 createTenant({slug:'copyforeign',name:'Synthetic Copy Foreign',admin_username:'copy-foreign',admin_password:'Synthetic foreign copy password',plan:'unlimited'});
 let foreignForm=0;
 db.withTenant('copyforeign',()=>{
  foreignForm=db.queryOne<{id:number}>("SELECT id FROM form_definitions WHERE slug='hr_payroll'")!.id;
  const e=Number(db.run("INSERT INTO employees(employee_no,name) VALUES('COPY-FOREIGN','Synthetic Foreign Copy')").lastInsertRowid);
  db.run("INSERT INTO form_records(id,form_def_id,number,data,status,created_by) VALUES(?,?,?,?,'paid',1)",a.id,foreignForm,'FOREIGN-COPY',JSON.stringify({employee_id:e,net_pay:333}));
 });
 const signed=await ctx.api.post('/copyforeign/api/auth/login').set('Host','copy.example.test').send({username:'copy-foreign',password:'Synthetic foreign copy password'});expect(signed.status).toBe(200);
 const r=await ctx.api.get('/copyforeign/api/hr/payroll/copy').set('Host','copy.example.test').set(h(signed.body.token)).query({form_id:foreignForm,ids:a.id});expect(r.status).toBe(200);expect(r.body.records[0].number).toBe('FOREIGN-COPY');expect(r.body.records[0].data.net_pay).toBe(333);
 expect((await ctx.api.get('/copyforeign/api/hr/payroll/copy').set('Host','copy.example.test').set(h()).query({form_id:foreignForm,ids:a.id})).status).toBe(401);
});

it('invalidates a preview when status, record revision or form fields change',async()=>{
 const a=slip(),first=await copy([a.id]);db.run("UPDATE form_records SET status='paid' WHERE id=?",a.id);expect((await copy([a.id],first.body.snapshot)).status).toBe(409);
 const paid=await copy([a.id]);db.run('UPDATE form_records SET revision=revision+1 WHERE id=?',a.id);expect((await copy([a.id],paid.body.snapshot)).status).toBe(409);
 const before=db.queryOne<{name:string}>('SELECT name FROM form_definitions WHERE id=?',form)!,latest=await copy([a.id]);
 try{db.run("UPDATE form_definitions SET name='Synthetic changed payroll title' WHERE id=?",form);expect((await copy([a.id],latest.body.snapshot)).status).toBe(409);}finally{db.run('UPDATE form_definitions SET name=? WHERE id=?',before.name,form);}
});
it('keeps staff payroll search usable when unrelated saved JSON is corrupt and holds that corrupt copy',async()=>{
 const a=slip(),bad=slip();db.run("UPDATE form_records SET data='broken-json' WHERE id=?",bad.id);
 const search=await ctx.api.get(`/api/form-definitions/${form}/records`).set(h()).query({q:'Synthetic Copy Employee'});expect(search.status).toBe(200);expect(search.body.map((r:{id:number})=>r.id)).toContain(a.id);expect(search.text).not.toContain('broken-json');
 const badNumber=db.queryOne<{number:string}>('SELECT number FROM form_records WHERE id=?',bad.id)!.number;
 const review=await ctx.api.get(`/api/form-definitions/${form}/records`).set(h()).query({q:badNumber});expect(review.status).toBe(200);expect(review.body.map((r:{id:number})=>r.id)).toContain(bad.id);expect((await copy([bad.id])).status).toBe(409);
});
