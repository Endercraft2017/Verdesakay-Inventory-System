import {describe,it,expect,beforeAll,afterAll} from 'vitest';
import {setupApp,cleanup,login,createEmployee,type TestContext} from './helpers';
let ctx:TestContext,admin:string,hr:string,inventory:string;
const h=(token:string)=>({Authorization:'Bearer '+token});
const create=async()=>{const r=await ctx.api.post('/api/form-definitions').set(h(hr)).send({name:'Layout form',slug:'layouts_'+Math.random().toString(36).slice(2),scope:'hr',fields:[{key:'reason',label:'Reason <img src=x>',type:'text'}]});expect(r.status).toBe(201);return (await ctx.api.get('/api/form-definitions/'+r.body.id).set(h(hr))).body;};
beforeAll(async()=>{ctx=await setupApp();admin=await login(ctx.api);hr=(await createEmployee(ctx.api,admin,{role:'hr',username:'layouts_hr'})).token;inventory=(await createEmployee(ctx.api,admin,{role:'warehouse',username:'layouts_inventory'})).token;});
afterAll(()=>cleanup(ctx));
describe('form print layout assignments',()=>{
 it('seeds all forms with linked defaults and explicitly assigns the payslip',async()=>{
  const forms=(await ctx.api.get('/api/form-definitions').set(h(admin))).body;
  expect(forms.length).toBeGreaterThan(0);for(const f of forms){expect(f.template_id).toBeGreaterThan(0);const links=await ctx.api.get(`/api/form-definitions/${f.id}/templates`).set(h(admin));expect(links.body.some((t:any)=>t.id===f.template_id&&t.is_default)).toBe(true);}
  const payroll=forms.find((f:any)=>f.slug==='hr_payroll');const tpl=(await ctx.api.get('/api/templates/'+payroll.template_id).set(h(admin))).body;expect(tpl.name).toBe('HR Payroll Slip');
  await ctx.api.put('/api/templates/'+tpl.id).set(h(admin)).send({...tpl,name:'Renamed payroll',expected_revision:tpl.revision});
  expect((await ctx.api.get('/api/form-definitions/'+payroll.id).set(h(admin))).body.template_id).toBe(tpl.id);
 });
 it('creates safe starter content and alternatives without changing the default',async()=>{
  const form=await create();const starter=(await ctx.api.get('/api/templates/'+form.template_id).set(h(hr))).body;expect(starter.body).toContain('Reason &lt;img src=x&gt;');
  const alt=await ctx.api.put(`/api/form-definitions/${form.id}/template-body`).set(h(hr)).send({template_id:null,name:'Alternative',body:'<p>{{reason}}</p>'});expect(alt.status).toBe(201);
  expect((await ctx.api.get('/api/form-definitions/'+form.id).set(h(hr))).body.template_id).toBe(form.template_id);
  const edited=await ctx.api.put(`/api/form-definitions/${form.id}/template-body`).set(h(hr)).send({template_id:alt.body.id,expected_revision:alt.body.revision,name:'Edited alternative',body:'<p>Changed {{reason}}</p>'});expect(edited.status).toBe(200);
  expect((await ctx.api.get('/api/templates/'+form.template_id).set(h(hr))).body.body).toBe(starter.body);
  expect((await ctx.api.get('/api/templates/studio/documents/template:'+alt.body.id+'/history').set(h(hr))).status).toBe(200);
  await ctx.api.put(`/api/form-definitions/${form.id}/template`).set(h(hr)).send({template_id:alt.body.id});
  const links=(await ctx.api.get(`/api/form-definitions/${form.id}/templates`).set(h(hr))).body;expect(links).toHaveLength(2);expect(links.filter((t:any)=>t.is_default).map((t:any)=>t.id)).toEqual([alt.body.id]);
  await ctx.api.delete(`/api/form-definitions/${form.id}/templates/${alt.body.id}`).set(h(hr));expect((await ctx.api.get('/api/form-definitions/'+form.id).set(h(hr))).body.template_id).toBe(form.template_id);expect((await ctx.api.get('/api/templates/'+alt.body.id).set(h(hr))).status).toBe(200);
 });
 it('copies source variables into independent alternatives and rejects stale sources',async()=>{
  const form=await create();const source=(await ctx.api.get('/api/templates/'+form.template_id).set(h(admin))).body;
  const variable=await ctx.api.post('/api/templates/variables').set(h(admin)).send({scope:'template',template_id:source.id,key:'brand',label:'Brand',source_type:'constant',value:'Acme'});expect(variable.status).toBe(201);
  const payload={template_id:null,name:'Copied',body:source.body,source_template_id:source.id,source_revision:source.revision};
  const copy=await ctx.api.put(`/api/form-definitions/${form.id}/template-body`).set(h(hr)).send(payload);expect(copy.status).toBe(201);
  expect((await ctx.api.get('/api/templates/variables?template_id='+copy.body.id).set(h(hr))).body.some((v:any)=>v.key==='brand'&&v.template_id===copy.body.id)).toBe(true);
  expect((await ctx.api.put(`/api/form-definitions/${form.id}/template-body`).set(h(hr)).send({...payload,source_revision:'a'.repeat(64)})).status).toBe(409);
 });
 it('enforces scope on links, edits and private new-layout drafts',async()=>{
  const form=await create(), path=`/api/form-definitions/${form.id}`;
  expect((await ctx.api.get(path+'/templates').set(h(inventory))).status).toBe(403);
  expect((await ctx.api.post(path+'/templates').set(h(inventory)).send({template_id:form.template_id})).status).toBe(403);
  expect((await ctx.api.delete(path+'/templates/'+form.template_id).set(h(inventory))).status).toBe(403);
  const other=await create();expect((await ctx.api.put(path+'/template-body').set(h(hr)).send({template_id:other.template_id,name:'Hijack',body:'Changed'})).status).toBe(400);
  const key='/api/templates/studio/documents/new-template:form-'+form.id+'-test';expect((await ctx.api.get(key+'/draft').set(h(hr))).status).toBe(200);expect((await ctx.api.get(key+'/draft').set(h(inventory))).status).toBe(403);
 });
});
