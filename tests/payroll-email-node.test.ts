/** An installed process must refuse email even before sync enrollment/configuration exists. */
import {beforeAll,afterAll,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {setupApp,cleanup,login,type TestContext} from './helpers';
let ctx:TestContext,token:string,id:number,db:typeof import('../src/shared/db'),preflight:any;
const h=()=>({Authorization:`Bearer ${token}`}),base=()=>`/api/hr/payroll/${id}/email`;
beforeAll(async()=>{
 process.env.DEPLOY_MODE='node';ctx=await setupApp();token=await login(ctx.api);db=await import('../src/shared/db');
 db.run("UPDATE users SET email='unconfigured-node@example.test' WHERE id=1");
 const employee=Number(db.run("INSERT INTO employees(employee_no,name,user_id) VALUES('NODE-EMAIL','Synthetic Unconfigured Node',1)").lastInsertRowid),form=db.queryOne<{id:number}>("SELECT id FROM form_definitions WHERE slug='hr_payroll'")!.id;
 id=Number(db.run("INSERT INTO form_records(form_def_id,number,data,status,created_by) VALUES(?,'NODE-EMAIL',?,'paid',1)",form,JSON.stringify({employee_id:employee,employee_name:'Synthetic Unconfigured Node',net_pay:1000})).lastInsertRowid);
 const {saveMailSettings}=await import('../src/shared/mailer');saveMailSettings({transport:'smtp',from_name:'Synthetic Node',from_email:'payroll@example.test',reply_to:'',smtp_host:'127.0.0.1',smtp_port:1,smtp_secure:true,smtp_user:''});
 preflight=await ctx.api.get(base()).set(h());
});
afterAll(()=>{delete process.env.DEPLOY_MODE;cleanup(ctx);});
it('refuses online preflight with no sync_node row',()=>{expect(preflight.status,preflight.text).toBe(503);expect(preflight.body.sync).toBe('online');});
it('cannot acknowledge queued work that this installed process will never submit',async()=>{
 const review=await ctx.api.post(base()+'/review').set(h()).send({source_stamp:preflight.body.source_stamp||'0'.repeat(64)});
 let confirmation:number|null=null;if(review.status===200){confirmation=(await ctx.api.post(base()+'/confirm').set(h()).send({review_id:review.body.id,review_token:review.body.review_token})).status;}
 const {processOnePayrollEmail}=await import('../src/modules/hr/payroll-email'),worker=await processOnePayrollEmail(),queued=db.queryAll("SELECT id,state FROM payroll_email_releases WHERE confirmed_at IS NOT NULL");
 console.log(JSON.stringify({case:'unconfigured-installed-process',preflight:preflight.status,review:review.status,confirmation,worker,queued}));
 expect(review.status).toBe(503);expect(worker).toBe(false);expect(queued).toHaveLength(0);
});
it('refuses legacy, confirmation and cancellation before reading their online state',async()=>{for(const path of ['', '/confirm', '/'+randomUUID()+'/cancel']){const r=await ctx.api.post(base()+path).set(h()).send({});expect(r.status,r.text).toBe(503);expect(r.body.sync).toBe('online');}});
