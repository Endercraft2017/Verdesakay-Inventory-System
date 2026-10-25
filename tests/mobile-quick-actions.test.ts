import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {setupApp,cleanup,login,createEmployee,type TestContext} from './helpers';
let ctx:TestContext,token:string,other:string,otherId:number;
const hdr=(t=token)=>({Authorization:`Bearer ${t}`});
beforeAll(async()=>{ctx=await setupApp();token=await login(ctx.api);const inspector=await createEmployee(ctx.api,token,{role:'qc_inspector'});other=inspector.token;otherId=inspector.id;});
afterAll(()=>cleanup(ctx));
it('starts with no saved selection and supplies only permitted choices',async()=>{
 const admin=await ctx.api.get('/api/mobile/quick-actions').set(hdr());expect(admin.status).toBe(200);expect(admin.body.shortcuts).toBeNull();expect(admin.body.options).toContain('qa');
 const me=await ctx.api.get('/api/mobile/quick-actions').set(hdr(other));expect(me.status).toBe(200);expect(me.body.options).toContain('qc');expect(me.body.options).not.toContain('qa');
});
it('saves up to three distinct work shortcuts for this account across sessions',async()=>{
 const legacy=await ctx.api.put('/api/mobile/quick-actions').set(hdr()).send({shortcuts:['qc','qa']});expect(legacy.body.shortcuts).toEqual(['qc','qa']);
 const saved=await ctx.api.put('/api/mobile/quick-actions').set(hdr()).send({shortcuts:['qc','qa','scan']});expect(saved.status).toBe(200);expect(saved.body.shortcuts).toEqual(['qc','qa','scan']);
 const fresh=await login(ctx.api);expect((await ctx.api.get('/api/mobile/quick-actions').set(hdr(fresh))).body.shortcuts).toEqual(['qc','qa','scan']);
 expect((await ctx.api.get('/api/mobile/quick-actions').set(hdr(other))).body.shortcuts).toBeNull();
});
it('rejects excess, duplicate, missing and forged owner fields without changing saved choices',async()=>{
 for(const body of [{shortcuts:[]},{shortcuts:['qc','qa','scan','counts']},{shortcuts:['qc','qc']},{shortcuts:['qc'],user_id:1},{shortcuts:'qc'}])expect((await ctx.api.put('/api/mobile/quick-actions').set(hdr()).send(body)).status).toBe(400);
 expect((await ctx.api.put('/api/mobile/quick-actions').set(hdr()).send({shortcuts:['missing']})).status).toBe(403);
 expect((await ctx.api.get('/api/mobile/quick-actions').set(hdr())).body.shortcuts).toEqual(['qc','qa','scan']);
});
it('checks the specific inspection permission when saving and never changes permissions',async()=>{
 expect((await ctx.api.put('/api/mobile/quick-actions').set(hdr(other)).send({shortcuts:['qa']})).status).toBe(403);
 expect((await ctx.api.put('/api/mobile/quick-actions').set(hdr(other)).send({shortcuts:['qc']})).status).toBe(200);
 expect((await ctx.api.get('/api/auth/me').set(hdr(other))).body.user.permissions).not.toContain('production.inspect_qa');
});
it('requires an authenticated account with phone access',async()=>{
 expect((await ctx.api.get('/api/mobile/quick-actions')).status).toBe(401);
 const denied=await createEmployee(ctx.api,token,{role:'employee'});
 await ctx.api.put('/api/users/'+denied.id+'/permissions').set(hdr()).send({overrides:{'mobile.access':false}});
 expect((await ctx.api.get('/api/mobile/quick-actions').set(hdr(denied.token))).status).toBe(403);
});

it('retains saved choices but refuses access after permission revocation',async()=>{
 await ctx.api.put('/api/users/'+otherId+'/permissions').set(hdr()).send({overrides:{'production.inspect_qc':false}});
 const read=await ctx.api.get('/api/mobile/quick-actions').set(hdr(other));expect(read.body.shortcuts).toEqual(['qc']);expect(read.body.options).not.toContain('qc');
 expect((await ctx.api.put('/api/mobile/quick-actions').set(hdr(other)).send({shortcuts:['qc']})).status).toBe(403);
});
it('omits disabled workspace modules and rejects a shortcut into them',async()=>{
 const modules=await import('../src/shared/modules');const enabled=modules.moduleEnabled;
 const spy=vi.spyOn(modules,'moduleEnabled').mockImplementation((m,...rest)=>m==='manufacturing'?false:enabled(m,...rest));
 try{const read=await ctx.api.get('/api/mobile/quick-actions').set(hdr());expect(read.body.options).not.toContain('qc');expect(read.body.options).toContain('scan');expect((await ctx.api.put('/api/mobile/quick-actions').set(hdr()).send({shortcuts:['qc']})).status).toBe(403);}finally{spy.mockRestore();}
});

it('offers sales follow-up only with both order viewing and a sales workflow permission',async()=>{
 const sales=await createEmployee(ctx.api,token,{role:'employee'});await ctx.api.put('/api/users/'+sales.id+'/permissions').set(hdr()).send({overrides:{'orders.view':true,'orders.edit':true}});
 expect((await ctx.api.get('/api/mobile/quick-actions').set(hdr(sales.token))).body.options).toContain('sales');expect((await ctx.api.put('/api/mobile/quick-actions').set(hdr(sales.token)).send({shortcuts:['sales']})).status).toBe(200);
 await ctx.api.put('/api/users/'+sales.id+'/permissions').set(hdr()).send({overrides:{'orders.view':false}});
 expect((await ctx.api.get('/api/mobile/quick-actions').set(hdr(sales.token))).body.options).not.toContain('sales');expect((await ctx.api.put('/api/mobile/quick-actions').set(hdr(sales.token)).send({shortcuts:['sales']})).status).toBe(403);
});

it('matches the Sales route module requirements when inventory is disabled',async()=>{
 const modules=await import('../src/shared/modules');const enabled=modules.moduleEnabled;
 const spy=vi.spyOn(modules,'moduleEnabled').mockImplementation((m,...rest)=>m==='inventory'?false:enabled(m,...rest));
 try{const read=await ctx.api.get('/api/mobile/quick-actions').set(hdr());expect(read.body.options).not.toContain('sales');expect(read.body.options).toContain('qc');expect((await ctx.api.put('/api/mobile/quick-actions').set(hdr()).send({shortcuts:['sales']})).status).toBe(403);}finally{spy.mockRestore();}
});
