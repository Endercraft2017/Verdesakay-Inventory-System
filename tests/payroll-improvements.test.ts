import { beforeAll, afterAll, it, expect } from 'vitest';
import { reviewPayrollSummaryCsv } from '../src/modules/payroll/hr-payroll-import';
import { setupApp, cleanup, login, type TestContext } from './helpers';
let ctx:TestContext,token:string,employeeId:number,formId:number,earlyId:number,lateId:number,earlyPeriod:number,latePeriod:number;
const auth=()=>({Authorization:`Bearer ${token}`});
beforeAll(async()=>{
  ctx=await setupApp();token=await login(ctx.api);
  await ctx.api.put('/api/hr/payroll-policy').set(auth()).send({pay_frequency:'semi_monthly',auto_statutory:true,default_rest_days:[]});
  employeeId=(await ctx.api.post('/api/hr/employees').set(auth()).send({employee_no:'MONTH-UX',name:'Monthly override',daily_rate:1800})).body.id;
  const shift=(await ctx.api.post('/api/hr/shifts').set(auth()).send({name:'Monthly UX',start_time:'08:00',end_time:'17:00',is_default:false})).body.id;
  const make=async(date:string,label:string)=>{
    const period=(await ctx.api.post('/api/hr/periods').set(auth()).send({label,start_date:date,end_date:date})).body.id;
    await ctx.api.post(`/api/hr/periods/${period}/employees`).set(auth()).send({employee_id:employeeId});
    await ctx.api.put(`/api/hr/periods/${period}/attendance`).set(auth()).send({employee_id:employeeId,days:[{work_date:date,time_in:'08:00',time_out:'17:00',shift_id:shift,notes:''}]});
    const gen=await ctx.api.post(`/api/hr/periods/${period}/generate-payslips`).set(auth()).send({payroll_period:label});expect(gen.status).toBe(201);formId=gen.body.form_id;
    const rows=(await ctx.api.get(`/api/form-definitions/${formId}/records?period=${encodeURIComponent(label)}`).set(auth())).body;
    return {period,record:rows[0].id};
  };
  const early=await make('2026-08-06','Monthly early');earlyId=early.record;earlyPeriod=early.period;
  const late=await make('2026-08-26','Monthly late');lateId=late.record;latePeriod=late.period;
});
afterAll(()=>cleanup(ctx));
const record=async(id:number)=>(await ctx.api.get(`/api/form-records/${id}`).set(auth())).body;
it('records actor, previous/new amounts and optional reasons, never previews or no-op saves',async()=>{
  const before=await record(earlyId);
  await ctx.api.post(`/api/hr/payroll/${earlyId}/preview-deductions`).set(auth()).send({statutory_overrides:{sss:100,pagibig:10}});
  expect((await ctx.api.get(`/api/hr/payroll/${earlyId}/deductions-history`).set(auth())).body).toEqual([]);
  const save=await ctx.api.put(`/api/hr/payroll/${earlyId}/deductions`).set(auth()).send({statutory_overrides:{sss:100,pagibig:10},expected_revision:before.revision,change_reason:'Verified against contribution remittance'});expect(save.status).toBe(200);
  expect(save.body.later_cutoffs).toContainEqual(expect.objectContaining({id:lateId,label:'Monthly late'}));
  const entries=(await ctx.api.get(`/api/hr/payroll/${earlyId}/deductions-history`).set(auth())).body;
  expect(entries).toHaveLength(1);expect(entries[0]).toMatchObject({changed_by_name:'System Administrator',reason:'Verified against contribution remittance',before_values:{sss:before.data.sss},after_values:{sss:100,pagibig:10}});
  const saved=await record(earlyId);
  expect((await ctx.api.put(`/api/hr/payroll/${earlyId}/deductions`).set(auth()).send({statutory_overrides:{sss:100,pagibig:10},expected_revision:saved.revision})).status).toBe(200);
  expect((await ctx.api.get(`/api/hr/payroll/${earlyId}/deductions-history`).set(auth())).body).toHaveLength(1);
});
it('reconciles later automatic SSS/Pag-IBIG from earlier manual deductions without rewriting earlier slips',async()=>{
  const originalLate=await record(lateId),early=await record(earlyId);
  const history=(await ctx.api.get(`/api/hr/payroll/${earlyId}/deductions-history`).set(auth())).body[0];
  const preview=await ctx.api.post(`/api/hr/payroll/${lateId}/preview-deductions`).set(auth()).send({});expect(preview.status).toBe(200);
  expect(preview.body.sss).toBeCloseTo(Math.max(0,originalLate.data.sss+history.before_values.sss-100),2);
  expect(preview.body.pagibig).toBeCloseTo(Math.max(0,originalLate.data.pagibig+history.before_values.pagibig-10),2);
  const regen=await ctx.api.post(`/api/hr/periods/${latePeriod}/generate-payslips`).set(auth()).send({payroll_period:'Monthly late'});expect(regen.status).toBe(201);
  const after=await record(lateId);expect(after.data.sss).toBe(preview.body.sss);expect(after.data.pagibig).toBe(preview.body.pagibig);
  expect((await record(earlyId)).data).toEqual(early.data);
  await ctx.api.put(`/api/hr/payroll/${lateId}/deductions`).set(auth()).send({statutory_overrides:{sss:25}});
  await ctx.api.post(`/api/hr/periods/${latePeriod}/generate-payslips`).set(auth()).send({payroll_period:'Monthly late'});
  expect((await record(lateId)).data.sss).toBe(25);
});
it('preserves employer contributions and rejects stale edits and paid-slip changes',async()=>{
  const before=await record(earlyId);
  const saved=await ctx.api.put(`/api/hr/payroll/${earlyId}/deductions`).set(auth()).send({statutory_overrides:{sss:0},expected_revision:before.revision});expect(saved.status).toBe(200);
  expect(saved.body.employer_contributions).toEqual(before.data.employer_contributions);
  expect((await ctx.api.put(`/api/hr/payroll/${earlyId}/deductions`).set(auth()).send({statutory_overrides:{sss:500},expected_revision:before.revision})).status).toBe(409);
  await ctx.api.post(`/api/hr/payroll/${earlyId}/mark-paid`).set(auth()).send({});
  expect((await ctx.api.put(`/api/hr/payroll/${earlyId}/deductions`).set(auth()).send({statutory_overrides:{sss:500}})).status).toBe(400);
  const final=await record(earlyId);
  await ctx.api.post(`/api/hr/periods/${earlyPeriod}/generate-payslips`).set(auth()).send({payroll_period:'Monthly early'});
  expect((await record(earlyId)).data).toEqual(final.data);
});
it('reviews rejected CSV rows, keeps explanations, and requires explicit partial import',async()=>{
  const csv='Mixed import\nNo.,Employee Name,Total Days Work,Daily Rate,BASIC PAY,TOTAL DEDUCTIONS,Total Salary\n1,Good employee,1,600,600,0,600\n2,Needs correction,1,bad,600,0,600\n';
  const upload=(extra:Record<string,string>)=>{let req=ctx.api.post(`/api/form-definitions/${formId}/import`).set(auth()).field('period','Mixed import');for(const[key,value]of Object.entries(extra))req=req.field(key,value);return req.attach('file',Buffer.from(csv),'summary.csv');};
  const review=await upload({dry_run:'1'});expect(review.status).toBe(200);expect(review.body).toMatchObject({count:1,rejected_count:1});expect(review.body.rejected_csv).toContain('Needs correction');expect(review.body.rejected_csv).toContain('Invalid numeric value in: Daily Rate');
  expect((await upload({})).status).toBe(409);
  const imported=await upload({allow_partial:'1'});expect(imported.status).toBe(201);expect(imported.body).toMatchObject({created:1,rejected_count:1});
  const rows=(await ctx.api.get(`/api/form-definitions/${formId}/records?period=Mixed%20import`).set(auth())).body;expect(rows).toHaveLength(1);expect(rows[0].data.employee_name).toBe('Good employee');
});

it('excludes every split-rate row for a rejected employee and makes corrected downloads reimportable',()=>{
  const text='Split rows\nNo.,Employee Name,Total Days Work,Daily Rate,BASIC PAY,Total Salary\n1,Split employee,1,600,600,600\n,,1,broken,650,650\n2,Unaffected employee,1,700,700,700\n';
  const review=reviewPayrollSummaryCsv(text);
  expect(review.slips.map(s=>s.employee_name)).toEqual(['Unaffected employee']);
  expect(review.rejected).toHaveLength(2);
  const recovered=reviewPayrollSummaryCsv(review.rejected_csv.replace('broken','650'));
  expect(recovered.rejected).toEqual([]);
  expect(recovered.slips).toHaveLength(2);
  expect(recovered.slips.every(s=>s.employee_name==='Split employee')).toBe(true);
  expect(recovered.slips.reduce((sum,s)=>sum+s.basic_salary,0)).toBe(1250);
});
