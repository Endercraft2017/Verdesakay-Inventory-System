import {beforeAll,afterAll,it,expect} from 'vitest';
import {setupApp,cleanup,login,createEmployee,type TestContext} from './helpers';
let ctx:TestContext,admin:string,entry:{id:number;token:string;username:string;password:string},other:{id:number;token:string;username:string;password:string},form:number,record:number;
const auth=(token=admin)=>({Authorization:'Bearer '+token});
beforeAll(async()=>{ctx=await setupApp();admin=await login(ctx.api);entry=await createEmployee(ctx.api,admin,{role:'csr'});other=await createEmployee(ctx.api,admin,{role:'csr'});
 for(const user of [entry,other])expect((await ctx.api.put('/api/users/'+user.id+'/permissions').set(auth()).send({overrides:{'forms.fill.inventory':true,'forms.manage.inventory':false,'templates.view':false,'orders.view':false,'purchasing.view':false,'forms.view':false}})).status).toBe(200);
 for(const user of [entry,other])user.token=await login(ctx.api,user.username,user.password);
 form=(await ctx.api.post('/api/form-definitions').set(auth()).send({name:'Restricted entry',slug:'restricted_entry',scope:'inventory',fields:[{key:'amount',label:'Amount',type:'number',format:'currency',currency:'PHP'}]})).body.id;
 record=(await ctx.api.post('/api/form-records').set(auth()).send({form_def_id:form,data:{amount:10},status:'draft'})).body.id;
});
afterAll(()=>cleanup(ctx));
async function grant(roles:string[],users:number[]){const value=await ctx.api.get(`/api/form-definitions/${form}/access`).set(auth());return ctx.api.put(`/api/form-definitions/${form}/access`).set(auth()).send({roles,users,expected_revision:value.body.revision});}
it('denies entry without a grant, allows a selected account to see records from other authors, and keeps design private',async()=>{
 expect((await ctx.api.get('/api/form-records/'+record).set(auth(entry.token))).status).toBe(403);
 expect((await grant([],[entry.id])).status).toBe(200);
 expect((await ctx.api.get(`/api/form-definitions/${form}/records`).set(auth(entry.token))).body.some((r:any)=>r.id===record)).toBe(true);
 expect((await ctx.api.get('/api/form-records/'+record+'/revisions').set(auth(entry.token))).status).toBe(200);
 expect((await ctx.api.get('/api/form-records/'+record).set(auth(other.token))).status).toBe(403);
 const definition=(await ctx.api.get('/api/form-definitions/'+form).set(auth(entry.token))).body;expect(definition.records_allowed).toBe(true);expect(definition.entry_access).toBeUndefined();
 expect((await ctx.api.put('/api/form-definitions/'+form).set(auth(entry.token)).send({...definition,name:'Stolen design'})).status).toBe(403);
 expect((await ctx.api.put(`/api/form-definitions/${form}/access`).set(auth(entry.token)).send({roles:['csr'],users:[],expected_revision:2})).status).toBe(403);
 expect((await ctx.api.put(`/api/form-definitions/${form}/template`).set(auth(entry.token)).send({template_id:null})).status).toBe(403);
 expect((await ctx.api.get(`/api/form-definitions/${form}/templates`).set(auth(entry.token))).status).toBe(200);
 expect((await ctx.api.get('/api/templates/'+definition.template_id).set(auth(entry.token))).status).toBe(200);
 expect((await ctx.api.get('/api/templates?template_id='+definition.template_id).set(auth(entry.token))).status).toBe(403);
 const unrelatedTemplate=(await ctx.api.post('/api/templates').set(auth()).send({name:'Unassigned layout',type:'generic',body:'Private design'})).body.id;
 expect((await ctx.api.get('/api/templates/'+unrelatedTemplate).set(auth(entry.token))).status).toBe(403);
});
it('allows draft edits and one submission, rejecting approval, submitted edits, deletes and cross-form access',async()=>{
 expect((await ctx.api.put('/api/form-records/'+record).set(auth(entry.token)).send({data:{amount:'99'},status:'approved'})).status).toBe(403);
 expect((await ctx.api.put('/api/form-records/'+record).set(auth(entry.token)).send({data:{amount:'99'},status:'draft'})).status).toBe(200);
 expect((await ctx.api.get('/api/form-records/'+record).set(auth(entry.token))).body.data.amount).toBe(99);
 expect((await ctx.api.delete('/api/form-records/'+record).set(auth(entry.token))).status).toBe(403);
 expect((await ctx.api.put('/api/form-records/'+record).set(auth(entry.token)).send({data:{amount:99},status:'submitted'})).status).toBe(200);
 expect((await ctx.api.put('/api/form-records/'+record).set(auth(entry.token)).send({data:{amount:88},status:'draft'})).status).toBe(403);
 expect((await ctx.api.post('/api/form-records').set(auth(entry.token)).send({form_def_id:form,data:{amount:0},status:'approved'})).status).toBe(403);
 const made=await ctx.api.post('/api/form-records').set(auth(entry.token)).send({form_def_id:form,data:{amount:'0'},status:'draft'});expect(made.status).toBe(201);expect((await ctx.api.get('/api/form-records/'+made.body.id).set(auth(entry.token))).body.data.amount).toBe(0);
 const unrelated=(await ctx.api.post('/api/form-definitions').set(auth()).send({name:'Other form',slug:'unrelated_entry',scope:'inventory'})).body.id;
 expect((await ctx.api.get(`/api/form-definitions/${unrelated}/records`).set(auth(entry.token))).status).toBe(403);
});
it('supports role grants, immediate revocation, permission overrides and conflict-safe access updates',async()=>{
 expect((await grant(['csr'],[])).status).toBe(200);expect((await ctx.api.get('/api/form-records/'+record).set(auth(other.token))).status).toBe(200);
 const before=(await ctx.api.get(`/api/form-definitions/${form}/access`).set(auth())).body;
 expect((await ctx.api.put(`/api/form-definitions/${form}/access`).set(auth()).send({roles:['missing_role'],users:[],expected_revision:before.revision})).status).toBe(400);
 expect((await grant([],[])).status).toBe(200);expect((await ctx.api.get('/api/form-records/'+record).set(auth(entry.token))).status).toBe(403);
 expect((await ctx.api.put(`/api/form-definitions/${form}/access`).set(auth()).send({roles:['csr'],users:[],expected_revision:before.revision})).status).toBe(409);
 expect((await grant(['csr'],[])).status).toBe(200);await ctx.api.put('/api/users/'+other.id+'/permissions').set(auth()).send({overrides:{'forms.fill.inventory':false}});
 expect((await ctx.api.get('/api/form-records/'+record).set(auth(other.token))).status).toBe(401);
 other.token=await login(ctx.api,other.username,other.password);
 expect((await ctx.api.get('/api/form-records/'+record).set(auth(other.token))).status).toBe(403);
});

it('keeps archived records read-only to entry users and does not extend grants to HR',async()=>{
 const draft=await ctx.api.post('/api/form-records').set(auth(entry.token)).send({form_def_id:form,status:'draft',data:{amount:1}});expect(draft.status).toBe(201);
 expect((await ctx.api.put(`/api/form-definitions/${form}/archive`).set(auth()).send({archived:true,reason:'Archive access test'})).status).toBe(200);
 expect((await ctx.api.put('/api/form-records/'+draft.body.id).set(auth(entry.token)).send({data:{amount:2},change_reason:'Cannot bypass archive'})).status).toBe(403);
 expect((await ctx.api.get('/api/form-records/'+draft.body.id).set(auth(entry.token))).status).toBe(200);
 expect((await ctx.api.post('/api/form-records').set(auth(entry.token)).send({form_def_id:form,status:'draft',data:{amount:1}})).status).toBe(409);
 const hr=(await ctx.api.post('/api/form-definitions').set(auth()).send({name:'HR remains scoped',slug:'hr_entry_isolation',scope:'hr'})).body.id;
 expect((await ctx.api.get(`/api/form-definitions/${hr}/records`).set(auth(entry.token))).status).toBe(403);
 expect((await ctx.api.put(`/api/form-definitions/${hr}/access`).set(auth()).send({expected_revision:1,roles:['csr'],users:[]})).status).toBe(400);
});
