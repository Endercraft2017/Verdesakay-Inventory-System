import { beforeAll, afterAll, beforeEach, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { hashPassword } from '../src/shared/password-hash';
import { passwordWorkState, withPasswordWork } from '../src/shared/password-work';
import { setupApp, cleanup, type TestContext } from './helpers';
let ctx:TestContext,db:typeof import('../src/shared/db'),platform:typeof import('../src/platform/platform');
let id:number,oldHash:string,nextHash:string;const password=randomUUID(),replacement=randomUUID();
beforeAll(async()=>{
  process.env.PLATFORM_CONSOLE='true';ctx=await setupApp();db=await import('../src/shared/db');platform=await import('../src/platform/platform');
  oldHash=hashPassword(password);nextHash=hashPassword(replacement);
  id=Number(db.run("INSERT INTO users(username,full_name,role,password_hash) VALUES('login-race','Race','warehouse',?)",oldHash).lastInsertRowid);
  (await import('../src/platform/platform-users')).upsertPlatformUser('cpu-budget',password);
});
beforeEach(()=>{db.run("UPDATE users SET username='login-race',active=1,password_hash=?,password_change_required=0,temporary_password_expires_at=NULL WHERE id=?",oldHash,id);platform.platformDb().prepare("UPDATE platform_users SET password_hash=? WHERE username='cpu-budget'").run(oldHash);});
afterAll(()=>{delete process.env.PLATFORM_CONSOLE;cleanup(ctx);});
async function started(){const until=Date.now()+5000;while(!passwordWorkState().active&&Date.now()<until)await new Promise(resolve=>setImmediate(resolve));expect(passwordWorkState().active).toBe(1);}
function tenantLogin(){return ctx.api.post('/api/auth/login').send({username:'login-race',password}).then(r=>r);}
it('password replacement during hashing cannot open a tenant session',async()=>{
  const pending=tenantLogin();await started();db.run('UPDATE users SET password_hash=? WHERE id=?',nextHash,id);
  const result=await pending;expect(result.status).toBe(401);expect(result.body.token).toBeUndefined();
});
it('deactivation during hashing cannot open a tenant session',async()=>{
  const pending=tenantLogin();await started();db.run('UPDATE users SET active=0 WHERE id=?',id);expect((await pending).status).toBe(401);
});
it('renaming during hashing invalidates the original tenant username',async()=>{
  const pending=tenantLogin();await started();db.run("UPDATE users SET username='renamed-race' WHERE id=?",id);expect((await pending).status).toBe(401);
});
it('temporary-password expiry is rechecked after asynchronous verification',async()=>{
  db.run('UPDATE users SET password_change_required=1,temporary_password_expires_at=? WHERE id=?',new Date(Date.now()+60000).toISOString(),id);
  const pending=tenantLogin();await started();db.run('UPDATE users SET temporary_password_expires_at=? WHERE id=?',new Date(Date.now()-60000).toISOString(),id);
  expect((await pending).status).toBe(401);
});
it('malformed temporary-password expiry fails closed before opening a session',async()=>{
  db.run("UPDATE users SET password_change_required=1,temporary_password_expires_at='invalid' WHERE id=?",id);
  expect((await tenantLogin()).status).toBe(401);
});
it('password replacement during hashing cannot open a console session',async()=>{
  const pending=ctx.api.post('/_platform/api/login').send({username:'cpu-budget',password}).then(r=>r);
  await started();platform.platformDb().prepare("UPDATE platform_users SET password_hash=? WHERE username='cpu-budget'").run(nextHash);expect((await pending).status).toBe(401);
});
it('tenant and console public routes share the bound and return retry guidance',async()=>{
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),first=withPasswordWork(()=>gate),waiting=Array.from({length:8},()=>withPasswordWork(async()=>true));
  try {
    for(const [path,username] of [['/api/auth/login','login-race'],['/_platform/api/login','cpu-budget']]){
      const result=await ctx.api.post(path!).send({username,password});expect(result.status).toBe(503);expect(result.headers['retry-after']).toBe('5');expect(result.headers['set-cookie']).toBeUndefined();expect(JSON.stringify(result.body)).not.toContain(password);
    }
  } finally {release();await Promise.all([first,...waiting]);}
});
it('queued asynchronous logins preserve separate tenant database contexts',async()=>{
  const {createTenant}=await import('../src/platform/provisioning');const a=randomUUID(),b=randomUUID();
  for(const [slug,pw,name] of [['async-first',a,'First owner'],['async-second',b,'Second owner']]){
    createTenant({slug:slug!,name:name!,admin_username:'owner',admin_password:pw!});db.withTenant(slug!,()=>db.run('UPDATE users SET full_name=? WHERE id=1',name!));
  }
  const [first,second]=await Promise.all([ctx.api.post('/api/auth/login').set('X-Tenant','async-first').send({username:'owner',password:a}),ctx.api.post('/api/auth/login').set('X-Tenant','async-second').send({username:'owner',password:b})]);
  expect(first.status).toBe(200);expect(second.status).toBe(200);expect(first.body.user.full_name).toBe('First owner');expect(second.body.user.full_name).toBe('Second owner');
  expect((await ctx.api.get('/api/auth/me').set('X-Tenant','async-second').set('Authorization',`Bearer ${first.body.token}`)).status).toBe(401);
});
