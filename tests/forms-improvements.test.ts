import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';
let ctx:TestContext, admin:string, other:string, formId:number, recordId:number;
const auth=(token=admin)=>({Authorization:`Bearer ${token}`});
const definition={name:'Versioned consent',slug:'versioned_consent',number_prefix:'VC',scope:'inventory',fields:[{key:'consent',label:'Original consent',type:'checkbox',required:true}],actions:[]};
beforeAll(async()=>{
  ctx=await setupApp();admin=await login(ctx.api);
  other=(await createEmployee(ctx.api,admin,{username:'forms.other',role:'csr'})).token;
  const form=await ctx.api.post('/api/form-definitions').set(auth()).send(definition);expect(form.status).toBe(201);formId=form.body.id;
  const record=await ctx.api.post('/api/form-records').set(auth()).send({form_def_id:formId,data:{consent:true},status:'draft'});expect(record.status).toBe(201);recordId=record.body.id;
});
afterAll(()=>cleanup(ctx));
describe('form lifecycle and record meaning',()=>{
  it('keeps the original schema when required fields are added to the live form',async()=>{
    const updated=await ctx.api.put(`/api/form-definitions/${formId}`).set(auth()).send({...definition,expected_version:1,change_reason:'Collect department on new entries',fields:[{key:'consent',label:'New consent label',type:'checkbox',required:true},{key:'confirmation',label:'Additional consent',type:'checkbox',required:true}]});
    expect(updated.status).toBe(200);
    const record=await ctx.api.get(`/api/form-records/${recordId}`).set(auth());
    expect(record.body).toMatchObject({definition_version:1,revision:1,schema:{fields:[{key:'consent',label:'Original consent',type:'checkbox'}]}});
    const edit=await ctx.api.put(`/api/form-records/${recordId}`).set(auth()).send({data:{consent:true,notes:'Corrected'},expected_revision:1});expect(edit.status).toBe(200);
    expect((await ctx.api.post('/api/form-records').set(auth()).send({form_def_id:formId,expected_definition_version:1,data:{consent:true,confirmation:true}})).status).toBe(409);
    const missingNew=await ctx.api.post('/api/form-records').set(auth()).send({form_def_id:formId,data:{consent:true}});expect(missingNew.status).toBe(400);
    const newRecord=await ctx.api.post('/api/form-records').set(auth()).send({form_def_id:formId,data:{consent:true,confirmation:true}});expect(newRecord.status).toBe(201);
    expect((await ctx.api.get(`/api/form-records/${newRecord.body.id}`).set(auth())).body.definition_version).toBe(2);
    const versions=await ctx.api.get(`/api/form-definitions/${formId}/versions`).set(auth());expect(versions.body.map((v:{version:number})=>v.version)).toEqual([2,1]);expect(versions.body[0].reason).toBe('Collect department on new entries');
    expect((await ctx.api.put(`/api/form-definitions/${formId}`).set(auth()).send({...definition,expected_version:1})).status).toBe(409);
  });
  it('archives without losing layouts; corrections require a reason and retain revisions',async()=>{
    const before=(await ctx.api.get(`/api/form-definitions/${formId}`).set(auth())).body;
    expect((await ctx.api.delete(`/api/form-definitions/${formId}`).set(auth())).status).toBe(409);
    expect((await ctx.api.put(`/api/form-definitions/${formId}/archive`).set(auth()).send({archived:true,reason:'Retired workflow'})).status).toBe(200);
    const archived=(await ctx.api.get(`/api/form-definitions/${formId}`).set(auth())).body;
    expect(archived.archived_at).toBeTruthy();expect(archived.template_id).toBe(before.template_id);
    expect((await ctx.api.post('/api/form-records').set(auth()).send({form_def_id:formId,data:{consent:true,confirmation:true}})).status).toBe(409);
    expect((await ctx.api.put(`/api/form-records/${recordId}`).set(auth()).send({data:{consent:true}})).status).toBe(400);
    expect((await ctx.api.delete(`/api/form-records/${recordId}`).set(auth())).status).toBe(409);
    expect((await ctx.api.put(`/api/form-records/${recordId}`).set(auth()).send({data:{consent:true,notes:'Archived correction'},expected_revision:2,change_reason:'Correct transcription'})).status).toBe(200);
    const history=(await ctx.api.get(`/api/form-records/${recordId}/revisions`).set(auth())).body;
    expect(history.map((entry:{revision:number})=>entry.revision)).toEqual([3,2,1]);expect(history[0]).toMatchObject({reason:'Correct transcription',data:{notes:'Archived correction'}});expect(history[1].data.notes).toBe('Corrected');
    expect((await ctx.api.put(`/api/form-records/${recordId}`).set(auth()).send({data:{consent:true},expected_revision:2,change_reason:'Stale edit'})).status).toBe(409);
    expect((await ctx.api.put(`/api/form-definitions/${formId}/archive`).set(auth()).send({archived:false})).status).toBe(200);
  });
  it('keeps private record histories and archival writes behind section permissions',async()=>{
    expect((await ctx.api.get(`/api/form-records/${recordId}/revisions`).set(auth(other))).status).toBe(403);
    const publicDefinition=(await ctx.api.get(`/api/form-definitions/${formId}`).set(auth(other))).body;
    expect(publicDefinition).not.toHaveProperty('version_reason');expect(publicDefinition).not.toHaveProperty('archive_reason');
    expect((await ctx.api.put(`/api/form-definitions/${formId}/archive`).set(auth(other)).send({archived:true})).status).toBe(403);
  });
});
describe('account-owned form preferences',()=>{
  it('persists favorites, recent forms, columns and saved filters without sharing them',async()=>{
    for(const change of [{action:'favorite',enabled:true},{action:'recent'},{action:'columns',columns:['consent']},{action:'save_filter',filter:{id:'draft-view',name:'My drafts',q:'VC',status:'draft',period:''}}]) {
      expect((await ctx.api.put('/api/data-forms/preferences').set(auth()).send({...change,form_id:formId})).status).toBe(200);
    }
    const prefs=(await ctx.api.get('/api/data-forms/preferences').set(auth())).body;
    expect(prefs.favorites).toEqual([formId]);expect(prefs.recent[0].form_id).toBe(formId);expect(prefs.views[formId]).toMatchObject({columns:['consent'],filters:[{name:'My drafts',status:'draft'}]});
    expect((await ctx.api.get('/api/data-forms/preferences').set(auth(other))).body).toEqual({favorites:[],recent:[],views:{}});
    expect((await ctx.api.put('/api/data-forms/preferences').set(auth(other)).send({action:'favorite',form_id:formId,enabled:true})).status).toBe(403);
    await ctx.api.put('/api/data-forms/preferences').set(auth()).send({action:'delete_filter',form_id:formId,filter_id:'draft-view'});
    expect((await ctx.api.get('/api/data-forms/preferences').set(auth())).body.views[formId].filters).toEqual([]);
  });
});
