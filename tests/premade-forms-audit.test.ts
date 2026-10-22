/** Exercise every seeded form and every Quick Add definition against the actual API/schema. */
import {describe,it,expect,beforeAll,afterAll} from 'vitest';
import fs from 'node:fs';
import ts from 'typescript';
import {execFileSync} from 'node:child_process';
import {setupApp,cleanup,login,createEmployee,type TestContext} from './helpers';
import {formDefinitionSchema} from '../src/shared/validation';
let ctx:TestContext,admin:string,employeeToken:string,employeeId:number;
const h=()=>({Authorization:'Bearer '+admin});
const employeeName='Premade audit employee';
const fieldsData=(fields:any[])=>Object.fromEntries(fields.map(f=>[f.key,f.key==='leave_dates'?'2026-11-10':f.type==='employee'?employeeName:f.type==='number'?1:f.type==='date'?'2026-11-10':f.type==='time'?'09:30':f.type==='checkbox'?true:f.type==='select'?f.options[0]:'Audit '+f.key]));
function quickAddDefinitions():any[]{
 const source=fs.readFileSync(new URL('../public/js/modules/core/form-builder.js',import.meta.url),'utf8');
 const tree=ts.createSourceFile('form-builder.js',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);let literal='';
 const visit=(node:ts.Node)=>{if(ts.isVariableDeclaration(node)&&node.name.getText(tree)==='FORM_TEMPLATES')literal=node.initializer!.getText(tree);ts.forEachChild(node,visit);};visit(tree);
 return new Function("const req=(key,label,type,opts)=>({key,label,type,required:true,options:opts||[],default:''});const opt=(key,label,type,opts)=>({key,label,type,required:false,options:opts||[],default:''});return "+literal)();
}
beforeAll(async()=>{ctx=await setupApp();admin=await login(ctx.api);const acc=await createEmployee(ctx.api,admin,{role:'warehouse',username:'premade_audit_employee'});employeeToken=acc.token;const emp=await ctx.api.post('/api/hr/employees').set(h()).send({employee_no:'PREMADE-AUDIT',name:employeeName,user_id:acc.id});expect(emp.status).toBe(201);employeeId=emp.body.id;});
afterAll(()=>cleanup(ctx));
describe('all premade forms',()=>{
 it('round-trips every seeded definition and creates records with correctly rendered defaults',async()=>{
  const {renderDocument}=await import('../src/shared/doc-render');
  const {REQUEST_SLUGS}=await import('../src/core/me.routes');
  const forms=(await ctx.api.get('/api/form-definitions').set(h())).body;
  expect(forms.length).toBeGreaterThanOrEqual(16);
  for(const form of forms){
   expect(formDefinitionSchema.safeParse(form).success,form.slug).toBe(true);
   const update=await ctx.api.put('/api/form-definitions/'+form.id).set(h()).send(form);expect(update.status,form.slug).toBe(200);
   const links=(await ctx.api.get(`/api/form-definitions/${form.id}/templates`).set(h())).body;
   expect(links.filter((t:any)=>t.is_default).map((t:any)=>t.id),form.slug).toEqual([form.template_id]);
   const tpl=(await ctx.api.get('/api/templates/'+form.template_id).set(h())).body;
   const data=fieldsData(form.fields);
   if(form.slug==='rest_day_change'){data.original_rest_day='2026-11-08';data.new_rest_day='2026-11-10';}
   if(form.slug==='rest_day_work_request')data.work_date='2026-11-08';
   if(form.slug==='information_change')data.requested_value='Corrected Legal Name';
   if(form.slug==='schedule_change'){
    data.work_date='2026-12-17';
    const current=await ctx.api.post('/api/hr/shifts').set(h()).send({name:'Audit morning',start_time:'08:00',end_time:'17:00'});
    const requested=await ctx.api.post('/api/hr/shifts').set(h()).send({name:'Audit late',start_time:'10:00',end_time:'19:00'});
    const cutoff=await ctx.api.post('/api/hr/periods').set(h()).send({label:'Audit schedule',start_date:data.work_date,end_date:data.work_date});
    expect(cutoff.status).toBe(201);
    await ctx.api.post(`/api/hr/periods/${cutoff.body.id}/employees`).set(h()).send({employee_id:employeeId});
    const roster=await ctx.api.put(`/api/hr/periods/${cutoff.body.id}/attendance`).set(h()).send({employee_id:employeeId,days:[{work_date:data.work_date,shift_id:current.body.id,time_in:'',time_out:'',notes:''}]});
    expect(roster.status).toBe(200);
    data.requested_shift_id=String(requested.body.id);
   }
   const recordAuth=form.slug==='information_change'?{Authorization:'Bearer '+employeeToken}:h();
   const created=await ctx.api.post('/api/form-records').set(recordAuth).send({form_def_id:form.id,data,status:'submitted'});expect(created.status,form.slug+' '+JSON.stringify(created.body)).toBe(201);expect(Array.isArray(created.body.action_warnings),form.slug).toBe(true);
   const record=(await ctx.api.get('/api/form-records/'+created.body.id).set(h())).body;
   expect(record.form_def_id).toBe(form.id);const entered=Object.fromEntries(Object.entries(data).filter(([key])=>!['employee_id','employee_name','department','position','employee_no','name','current_value','approved_hours','approved_by'].includes(key)).map(([key,value])=>[key,REQUEST_SLUGS.includes(form.slug)&&typeof value==='boolean'?(value?'Yes':'No'):value]));expect(record.data,form.slug).toMatchObject(entered);
   const html=renderDocument(tpl.body,{...record.data,number:record.number,today:'2026-11-10',record:{number:record.number,status:record.status,created_at:record.created_at},company:{name:'Audit Company'}},tpl.id);
   expect(html,form.slug).not.toMatch(/\{\{/);expect(html,form.slug).toContain(form.slug==='hr_payroll'?data.employee_name:'Audit Company');
   if(form.slug!=='hr_payroll')expect(html,form.slug).toContain(record.number);
  }
 });
 it('validates and creates every Quick Add preset with complete field-to-template mappings',async()=>{
  const presets=quickAddDefinitions();expect(presets).toHaveLength(15);
  for(const preset of presets){
   const payload={...preset,scope:'hr',slug:'audit_preset_'+preset.key};expect(formDefinitionSchema.safeParse(payload).success,preset.key).toBe(true);
   const create=await ctx.api.post('/api/form-definitions').set(h()).send(payload);expect(create.status,preset.key).toBe(201);
   const form=(await ctx.api.get('/api/form-definitions/'+create.body.id).set(h())).body;const tpl=(await ctx.api.get('/api/templates/'+form.template_id).set(h())).body;
   for(const field of preset.fields)expect(tpl.body,preset.key+':'+field.key).toContain('{{'+field.key+'}}');
   expect(form.fields.map((f:any)=>f.type)).toEqual(preset.fields.map((f:any)=>f.type));
  }
  for(const slug of ['offset_form','lunch_offset_form']){const form=(await ctx.api.get('/api/form-definitions').set(h())).body.find((f:any)=>f.slug===slug);expect(form.fields.some((f:any)=>f.type==='time')).toBe(true);}
 });
 it('exposes every seeded employee request with its supported fields through self-service',async()=>{
  const {REQUEST_SLUGS}=await import('../src/core/me.routes');const forms=(await ctx.api.get('/api/form-definitions').set(h())).body;
  const types=await ctx.api.get('/api/me/request-types').set({Authorization:'Bearer '+employeeToken});expect(types.status).toBe(200);
  for(const form of forms.filter((f:any)=>REQUEST_SLUGS.includes(f.slug)))expect(types.body.some((t:any)=>t.id===form.id),form.slug).toBe(true);
  const overtime=types.body.find((f:any)=>f.slug==='overtime_request');expect(overtime.fields.some((f:any)=>f.key==='approved_hours')).toBe(false);
 });
 it('keeps native document assignments stable across renames and requires replacement before deletion',async()=>{
  const defaults=(await ctx.api.get('/api/templates/defaults').set(h())).body;expect(defaults).toHaveLength(6);
  for(const item of defaults){
   const tpl=(await ctx.api.get('/api/templates/defaults/'+item.key).set(h())).body;expect(tpl.id).toBe(item.template_id);expect(tpl.body).toBeTruthy();
   const renamed=await ctx.api.put('/api/templates/'+tpl.id).set(h()).send({...tpl,name:'Audited '+tpl.name,grid_gap_x_mm:0,grid_gap_y_mm:2.5,expected_revision:tpl.revision});expect(renamed.status).toBe(200);expect((await ctx.api.get('/api/templates/'+tpl.id).set(h())).body).toMatchObject({grid_gap_x_mm:0,grid_gap_y_mm:2.5});
   expect((await ctx.api.get('/api/templates/defaults/'+item.key).set(h())).body.id).toBe(tpl.id);
   expect((await ctx.api.delete('/api/templates/'+tpl.id).set(h())).status).toBe(409);
   const copy=await ctx.api.post('/api/templates').set(h()).send({...tpl,name:'Replacement '+tpl.name,source_template_id:tpl.id,source_revision:renamed.body.revision});expect(copy.status).toBe(201);
   expect((await ctx.api.put('/api/templates/defaults/'+item.key).set(h()).send({template_id:copy.body.id})).status).toBe(200);
   expect((await ctx.api.get('/api/templates/defaults/'+item.key).set(h())).body.id).toBe(copy.body.id);
  }
  const employeeId=(await ctx.api.get('/api/templates/defaults/employee_id').set(h())).body;
  expect((await ctx.api.put('/api/templates/defaults/employee_id').set({Authorization:'Bearer '+employeeToken}).send({template_id:employeeId.id})).status).toBe(403);
  const sale=(await ctx.api.get('/api/templates/defaults/sale_order').set(h())).body;
  expect((await ctx.api.put('/api/templates/defaults/employee_id').set(h()).send({template_id:sale.id})).status).toBe(400);
 });
 it('uses the shared renderer for archived notices, with escaped values, loops and custom variables',async()=>{
  const form=(await ctx.api.get('/api/form-definitions').set(h())).body.find((f:any)=>f.slug==='nte');const tpl=(await ctx.api.get('/api/templates/'+form.template_id).set(h())).body;
  await ctx.api.post('/api/templates/variables').set(h()).send({scope:'template',template_id:tpl.id,key:'notice_brand',label:'Brand',source_type:'constant',value:'Audit brand'});
  await ctx.api.put('/api/templates/'+tpl.id).set(h()).send({...tpl,expected_revision:tpl.revision,body:'<p>{{record.number}} {{notice_brand}}</p>{{#if show}}<p>{{details}}</p>{{/if}}<ul>{{#entries}}<li>{{label}}</li>{{/entries}}</ul>'});
  const issued=await ctx.api.post('/api/form-records').set(h()).send({form_def_id:form.id,status:'submitted',data:{employee_name:employeeName,show:true,details:'<img src=x onerror=alert(1)>',entries:[{label:'Loop entry'}],response_deadline:'2026-11-10'}});expect(issued.status).toBe(201);expect(issued.body.action_warnings).toEqual([]);
  const docs=(await ctx.api.get(`/api/hr/employees/${employeeId}/documents`).set(h())).body;const doc=docs.find((d:any)=>d.title.includes(issued.body.number));expect(doc).toBeTruthy();
  const file=await ctx.api.get(`/api/hr/employees/${employeeId}/documents/${doc.id}/download`).set(h());expect(file.status).toBe(200);expect(file.text).toContain('Audit brand');expect(file.text).toContain('Loop entry');expect(file.text).toContain('&lt;img src=x onerror=alert(1)&gt;');expect(file.text).not.toContain('<img src=x');expect(file.text).not.toContain('{{');
 });
 it('restores links for recreated seeded forms while preserving intentional unlinking on restart',async()=>{
  const forms=(await ctx.api.get('/api/form-definitions').set(h())).body;const offset=forms.find((f:any)=>f.slug==='offset_form'),memo=forms.find((f:any)=>f.slug==='no_work_memo');
  await ctx.api.delete('/api/form-definitions/'+offset.id).set(h());await ctx.api.delete(`/api/form-definitions/${memo.id}/templates/${memo.template_id}`).set(h());
  const {DB_PATH}=await import('../src/shared/db');
  const restart=()=>execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',"const db=await import('./src/shared/db.ts');db.init();"],{cwd:process.cwd(),env:{...process.env,DB_PATH},stdio:'pipe'});
  restart();const next=(await ctx.api.get('/api/form-definitions').set(h())).body;const recreated=next.find((f:any)=>f.slug==='offset_form');expect(recreated.id).toBeGreaterThan(0);expect(recreated.template_id).toBeGreaterThan(0);
  expect((await ctx.api.get(`/api/form-definitions/${recreated.id}/templates`).set(h())).body).toHaveLength(1);
  expect(next.find((f:any)=>f.id===memo.id).template_id).toBeNull();
  const count=(await ctx.api.get('/api/templates').set(h())).body.length;restart();expect((await ctx.api.get('/api/templates').set(h())).body).toHaveLength(count);
 });
});
