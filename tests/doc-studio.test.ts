import fs from 'node:fs';
import vm from 'node:vm';
import {describe,it,expect,beforeAll,afterAll} from 'vitest';
import {setupApp,cleanup,login,createEmployee,type TestContext} from './helpers';
import {mergeSnapshots} from '../src/core/doc-studio-merge';
let ctx:TestContext,admin:string,other:string,employee:string,id:number;
const h=(token:string)=>({Authorization:'Bearer '+token});
const doc=()=>'/api/templates/studio/documents/template:'+id;
const snapshot=(body='<p><!--doc-sync:a-->One</p><!--doc-sync:b--><p>Two</p>')=>({name:'Shared',type:'generic',period:'',body,copiesPerRecord:1,recordsPerPage:1,tileFill:'blank',continuous:false,repeatCount:1});
beforeAll(async()=>{ctx=await setupApp();admin=await login(ctx.api);employee=(await createEmployee(ctx.api,admin)).token;const user=await ctx.api.post('/api/users').set(h(admin)).send({username:'studio_editor',password:'StudioEditor!73952',full_name:'Other editor',role:'admin'});expect(user.status).toBe(201);other=await login(ctx.api,'studio_editor','StudioEditor!73952');const created=await ctx.api.post('/api/templates').set(h(admin)).send({name:'Shared',type:'generic',body:snapshot().body});id=created.body.id;});
afterAll(()=>cleanup(ctx));
describe('server studio recovery, library and collaboration',()=>{
 it('records original and subsequent saved versions without leaking another template history',async()=>{
  const before=await ctx.api.get(doc()+'/history').set(h(admin));expect(before.body.length).toBeGreaterThan(0);const current=(await ctx.api.get('/api/templates/'+id).set(h(admin))).body;
  const saved=await ctx.api.put('/api/templates/'+id).set(h(admin)).send({name:'Shared',type:'generic',body:'<p>Next save</p>',expected_revision:current.revision});expect(saved.status).toBe(200);
  const list=await ctx.api.get(doc()+'/history').set(h(admin));expect(list.body.length).toBeGreaterThan(before.body.length);
  const original=await ctx.api.get(doc()+'/history/'+before.body[0].id).set(h(admin));expect(original.body.body).toBe(snapshot().body);
  const elsewhere=await ctx.api.post('/api/templates').set(h(admin)).send({name:'Other',body:'Other'});expect((await ctx.api.get('/api/templates/studio/documents/template:'+elsewhere.body.id+'/history/'+before.body[0].id).set(h(admin))).status).toBe(404);
 });
 it('keeps drafts private and uses version checks across devices',async()=>{
  const first=await ctx.api.put(doc()+'/draft').set(h(admin)).send({snapshot:snapshot('My draft'),expected_version:0});expect(first.status).toBe(200);expect(first.body.version).toBe(1);
  expect((await ctx.api.get(doc()+'/draft').set(h(other))).body).toBeNull();
  expect((await ctx.api.put(doc()+'/draft').set(h(admin)).send({snapshot:snapshot('Stale device'),expected_version:0})).status).toBe(409);
  expect((await ctx.api.get(doc()+'/draft').set(h(admin))).body.snapshot.body).toBe('My draft');
  expect((await ctx.api.delete(doc()+'/draft?version=2').set(h(admin))).status).toBe(409);expect((await ctx.api.delete(doc()+'/draft?version=1').set(h(admin))).status).toBe(200);
 });
 it('requires document editing permissions for private recovery and shared comments',async()=>{
  for(const path of ['/draft','/history','/room','/comments'])expect((await ctx.api.get(doc()+path).set(h(employee))).status).toBe(403);
 });
 it('shares company assets while restricting writes and stale deletions',async()=>{
  const created=await ctx.api.post('/api/templates/studio/library').set(h(admin)).send({kind:'brand',name:'Company brand',value:{color:'#234567',fontFamily:'Arial'}});expect(created.status).toBe(201);
  const list=await ctx.api.get('/api/templates/studio/library').set(h(other));expect(list.body.find((x:any)=>x.id===created.body.id).value.color).toBe('#234567');
  expect((await ctx.api.post('/api/templates/studio/library').set(h(employee)).send({kind:'asset',name:'Forbidden',value:{html:'<p>x</p>'}})).status).toBe(403);
  const updated=await ctx.api.put('/api/templates/studio/library/'+created.body.id).set(h(admin)).send({kind:'brand',name:'Brand revised',value:{color:'#111'},expected_version:1});expect(updated.body.version).toBe(2);
  expect((await ctx.api.delete('/api/templates/studio/library/'+created.body.id+'?version=1').set(h(admin))).status).toBe(409);
  expect((await ctx.api.delete('/api/templates/studio/library/'+created.body.id+'?version=2').set(h(admin))).status).toBe(200);
 });
 it('merges simultaneous edits to different blocks and refuses same-block overwrites',async()=>{
  const initial=snapshot('<!--doc-sync:a--><p>One</p><!--doc-sync:b--><p>Two</p>');
  const joined=await ctx.api.put(doc()+'/room').set(h(admin)).send({snapshot:initial,base:initial,expected_version:0,client_id:'client_one'});expect(joined.status).toBe(200);
  const left={...initial,body:initial.body.replace('One','First editor')};const right={...initial,body:initial.body.replace('Two','Second editor')};
  expect((await ctx.api.put(doc()+'/room').set(h(admin)).send({snapshot:left,base:initial,expected_version:1,client_id:'client_one'})).status).toBe(200);
  const merged=await ctx.api.put(doc()+'/room').set(h(other)).send({snapshot:right,base:initial,expected_version:1,client_id:'client_two'});expect(merged.status).toBe(200);expect(merged.body.snapshot.body).toContain('First editor');expect(merged.body.snapshot.body).toContain('Second editor');
  const conflict=await ctx.api.put(doc()+'/room').set(h(other)).send({snapshot:{...initial,body:initial.body.replace('One','Conflicting edit')},base:initial,expected_version:1,client_id:'client_two'});expect(conflict.status).toBe(409);expect(conflict.body.conflicts).toContain('block:a');
 });
 it('publishes only the current shared version and advances the saved revision',async()=>{
  const template=(await ctx.api.get('/api/templates/'+id).set(h(admin))).body;const room=(await ctx.api.get(doc()+'/room').set(h(admin))).body;
  const payload={name:'Shared',type:'generic',body:room.snapshot.body,expected_revision:template.revision};
  expect((await ctx.api.put('/api/templates/'+id).set(h(admin)).send({...payload,studio_version:room.version-1})).status).toBe(409);
  const saved=await ctx.api.put('/api/templates/'+id).set(h(admin)).send({...payload,studio_version:room.version});expect(saved.status).toBe(200);
  const next=(await ctx.api.get(doc()+'/room').set(h(other))).body;expect(next.saved_revision).toBe(saved.body.revision);expect(next.room_saved_revision).toBe(saved.body.revision);expect(next.version).toBe(room.version+1);
 });
 it('supports shared comments, block anchors, resolution and author-only deletion',async()=>{
  const created=await ctx.api.post(doc()+'/comments').set(h(admin)).send({body:'Please check this amount',block_id:'a'});expect(created.status).toBe(201);
  const list=await ctx.api.get(doc()+'/comments').set(h(other));expect(list.body[0].block_id).toBe('a');expect(list.body[0].full_name).toBeTruthy();
  expect((await ctx.api.put(doc()+'/comments/'+created.body.id).set(h(other)).send({resolved:true})).status).toBe(200);
  expect((await ctx.api.delete(doc()+'/comments/'+created.body.id).set(h(other))).status).toBe(403);
  expect((await ctx.api.delete(doc()+'/comments/'+created.body.id).set(h(admin))).status).toBe(200);
 });
 it('uses one canonical room for alternate spellings of the same template ID',async()=>{
  const actual=(await ctx.api.get(doc()+'/room').set(h(admin))).body;
  const alias=(await ctx.api.get('/api/templates/studio/documents/template:00'+id+'/room').set(h(admin))).body;
  expect(alias.version).toBe(actual.version);expect(alias.snapshot).toEqual(actual.snapshot);
 });
 it('keeps form recovery scoped and migrates it to the linked template on first publish',async()=>{
  const hr=(await createEmployee(ctx.api,admin,{role:'hr',username:'studio_hr'})).token;
  const form=await ctx.api.post('/api/form-definitions').set(h(admin)).send({name:'Studio HR Form',slug:'studio_hr_form',scope:'hr',fields:[{key:'reason',label:'Reason',type:'text'}]});expect(form.status).toBe(201);
  const initial=(await ctx.api.get('/api/form-definitions/'+form.body.id).set(h(admin))).body;
  await ctx.api.delete('/api/templates/'+initial.template_id).set(h(admin));
  const key='/api/templates/studio/documents/form:'+form.body.id;
  expect((await ctx.api.get(key+'/draft').set(h(employee))).status).toBe(403);
  await ctx.api.put(key+'/draft').set(h(hr)).send({snapshot:snapshot('Form draft'),expected_version:0});
  const room=await ctx.api.put(key+'/room').set(h(hr)).send({snapshot:snapshot('Form draft'),base:snapshot('Form draft'),expected_version:0,client_id:'form_editor'});expect(room.status).toBe(200);
  const stale=await ctx.api.put('/api/form-definitions/'+form.body.id+'/template-body').set(h(hr)).send({name:'Form print',body:'Form draft',studio_version:0});expect(stale.status).toBe(409);
  const saved=await ctx.api.put('/api/form-definitions/'+form.body.id+'/template-body').set(h(hr)).send({name:'Form print',body:'Form draft',studio_version:room.body.version});expect(saved.status).toBe(201);
  const draft=await ctx.api.get('/api/templates/studio/documents/template:'+saved.body.id+'/draft').set(h(hr));expect(draft.body.snapshot.body).toBe('Form draft');
  expect((await ctx.api.get(key+'/history').set(h(hr))).body.length).toBeGreaterThan(0);
 });
 it('purges studio state when its template is deleted',async()=>{
  const made=await ctx.api.post('/api/templates').set(h(admin)).send({name:'Disposable',body:'Body'});const key='/api/templates/studio/documents/template:'+made.body.id;
  await ctx.api.put(key+'/draft').set(h(admin)).send({snapshot:snapshot('Draft'),expected_version:0});await ctx.api.post(key+'/comments').set(h(admin)).send({body:'Comment'});
  await ctx.api.delete('/api/templates/'+made.body.id).set(h(admin));
  const db=await import('../src/shared/db');for(const table of ['doc_studio_drafts','doc_studio_rooms','doc_studio_comments','doc_studio_presence'])expect(db.queryOne<{n:number}>(`SELECT COUNT(*) n FROM ${table} WHERE document_key=?`,'template:'+made.body.id)!.n).toBe(0);
  expect(db.queryOne<{n:number}>('SELECT COUNT(*) n FROM doc_studio_versions WHERE template_id=?',made.body.id)!.n).toBe(0);
 });
 it('tracks multiple editors with authenticated identity rather than submitted user IDs',async()=>{
  await ctx.api.post(doc()+'/presence').set(h(admin)).send({client_id:'client_one'});const joined=await ctx.api.post(doc()+'/presence').set(h(other)).send({client_id:'client_two',user_id:999});expect(joined.body).toHaveLength(2);expect(joined.body.every((x:any)=>x.user_id!==999)).toBe(true);
 });
});
describe('merge behavior',()=>{
 it('combines metadata edits and detects concurrent structural edits',()=>{const base={name:'Original',body:'<!--doc-sync:a--><p>A</p><!--doc-sync:b--><p>B</p>'};expect(mergeSnapshots(base,{...base,name:'Renamed'},{...base,period:'October'}).snapshot).toMatchObject({name:'Renamed',period:'October'});expect(mergeSnapshots(base,{...base,body:base.body+'<p>Added</p>'},{...base,body:base.body.replace('doc-sync:b','doc-sync:c')}).conflicts).toContain('body');});
});

it('keeping a conflicting local block retains independent remote edits',()=>{
 const context={module:{exports:{} as any}};vm.runInNewContext(fs.readFileSync(new URL('../public/js/doc-studio.js',import.meta.url),'utf8'),context);
 const body=(a:string,b:string)=>`<!--doc-sync:a--><p>${a}</p><!--doc-sync:b--><p>${b}</p>`;
 const result=context.module.exports.merge({body:body('A','B')},{body:body('Local A','B')},{body:body('Remote A','Remote B')},true);
 expect(result.snapshot.body).toBe(body('Local A','Remote B'));expect(result.conflicts).toEqual(['block:a']);
});
it('rejects multipage grids in draft and shared writes without changing the working room',async()=>{const body='<div data-doc-design-page="a">A</div><div data-doc-design-page="b">B</div>',invalid={...snapshot(body),copiesPerRecord:2};const before=await ctx.api.get(doc()+'/room').set(h(admin));expect((await ctx.api.put(doc()+'/draft').set(h(admin)).send({snapshot:invalid,expected_version:0})).status).toBe(400);expect((await ctx.api.put(doc()+'/room').set(h(admin)).send({snapshot:invalid,base:before.body.snapshot,expected_version:before.body.version,client_id:'multipage-test'})).status).toBe(400);expect((await ctx.api.get(doc()+'/room').set(h(admin))).body.snapshot).toEqual(before.body.snapshot);});
