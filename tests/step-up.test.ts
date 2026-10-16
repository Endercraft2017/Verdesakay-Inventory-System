import { beforeAll,beforeEach,afterAll,it,expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { setupApp,cleanup,login,type TestContext } from './helpers';
import { passwordWorkState } from '../src/shared/password-work';
let ctx:TestContext,db:typeof import('../src/shared/db'),auth:typeof import('../src/shared/auth');
let token:string,originalHash:string;const password='admin123-test-only';
const h=(t=token)=>({Authorization:`Bearer ${t}`});
const stale=()=>db.run("UPDATE session_stepups SET verified_at=datetime('now','-6 minutes') WHERE token_hash=?",db.tokenDigest(token));
const creation=()=>({username:'fresh-'+randomUUID().slice(0,8),full_name:'Fresh account',password:randomUUID(),role:'warehouse'});
beforeAll(async()=>{ctx=await setupApp();db=await import('../src/shared/db');auth=await import('../src/shared/auth');originalHash=db.queryOne<{password_hash:string}>('SELECT password_hash FROM users WHERE id=1')!.password_hash;});
beforeEach(async()=>{
  db.run("UPDATE users SET password_hash=?,active=1,permission_overrides='{}',mfa_recovery_required=0 WHERE id=1",originalHash);
  for(const table of ['user_mfa_recovery','user_mfa','mfa_enrollments'])db.run(`DELETE FROM ${table} WHERE user_id=1`);
  db.setSetting('security_policy',{require_mfa_privileged:false});token=await login(ctx.api);
});
afterAll(()=>cleanup(ctx));
async function enable(){
  const setup=await ctx.api.post('/api/auth/mfa/setup').set(h()).send({password});expect(setup.status).toBe(200);
  const {totpCode}=await import('../src/shared/totp');
  const enabled=await ctx.api.post('/api/auth/mfa/enable').set(h()).send({code:totpCode(setup.body.secret,Math.floor(Date.now()/30000))});
  expect(enabled.status).toBe(200);return enabled.body.recovery_codes as string[];
}
it('fresh login permits account changes; a stale session cannot create users or roles',async()=>{
  expect((await ctx.api.post('/api/users').set(h()).send(creation())).status).toBe(201);
  stale();const body=creation();
  const denied=await ctx.api.post('/api/users').set(h()).send(body);
  expect(denied.status).toBe(403);expect(denied.body.step_up_required).toBe(true);
  expect(db.queryOne('SELECT id FROM users WHERE username=?',body.username)).toBeUndefined();
  expect((await ctx.api.post('/api/roles').set(h()).send({label:'Fresh '+randomUUID().slice(0,8),permissions:[]})).body.step_up_required).toBe(true);
  expect((await ctx.api.post('/api/auth/step-up').set(h()).send({password:'wrong'})).status).toBe(403);
  expect((await ctx.api.post('/api/auth/step-up').set(h()).send({password})).status).toBe(200);
  expect((await ctx.api.post('/api/users').set(h()).send(body)).status).toBe(201);
});
it('requires an existing factor and enforces one-use recovery codes',async()=>{
  const codes=await enable();stale();
  const denied=await ctx.api.post('/api/users').set(h()).send(creation());expect(denied.body.mfa_required).toBe(true);
  expect((await ctx.api.post('/api/auth/step-up').set(h()).send({password})).status).toBe(403);
  expect((await ctx.api.post('/api/auth/step-up').set(h()).send({password,code:'bad-code'})).status).toBe(403);
  const verified=await ctx.api.post('/api/auth/step-up').set(h()).send({password,code:codes[0]});expect(verified.status).toBe(200);expect(verified.headers['cache-control']).toBe('no-store');
  expect((await ctx.api.post('/api/users').set(h()).send(creation())).status).toBe(201);
  stale();expect((await ctx.api.post('/api/auth/step-up').set(h()).send({password,code:codes[0]})).status).toBe(403);
});
it('proof belongs only to its session, and ordinary session revocation cannot refresh it',async()=>{
  const other=auth.createSession(1);
  expect((await ctx.api.post('/api/users').set(h(other)).send(creation())).body.step_up_required).toBe(true);
  stale();expect((await ctx.api.post('/api/auth/sessions/revoke-others').set(h()).send({})).status).toBe(200);
  expect((await ctx.api.post('/api/users').set(h()).send(creation())).body.step_up_required).toBe(true);
});
it('policy changes require fresh proof and cannot extend its authentication time',async()=>{
  await enable();db.run("UPDATE session_stepups SET verified_at=datetime('now','-4 minutes') WHERE token_hash=?",db.tokenDigest(token));
  const before=db.queryOne<{verified_at:string}>('SELECT verified_at FROM session_stepups WHERE token_hash=?',db.tokenDigest(token))!.verified_at;
  expect((await ctx.api.put('/api/users/security-policy').set(h()).send({require_mfa_privileged:true})).status).toBe(200);
  const after=db.queryOne<{verified_at:string}>('SELECT verified_at FROM session_stepups WHERE token_hash=?',db.tokenDigest(token))!.verified_at;expect(after).toBe(before);
  expect((await ctx.api.post('/api/users').set(h()).send(creation())).status).toBe(201);
  stale();expect((await ctx.api.put('/api/users/security-policy').set(h()).send({require_mfa_privileged:false})).body.step_up_required).toBe(true);
});
it('changed permissions invalidate proof, and a live session cannot grant proof to another session',async()=>{
  db.run('UPDATE users SET permission_overrides=? WHERE id=1',JSON.stringify({'inventory.view':false}));
  expect((await ctx.api.post('/api/users').set(h()).send(creation())).body.step_up_required).toBe(true);
  expect((await ctx.api.post('/api/auth/step-up').set(h()).send({password})).status).toBe(200);
  expect((await ctx.api.post('/api/users').set(h(auth.createSession(1))).send(creation())).body.step_up_required).toBe(true);
});
it('ending a session during verification cannot consume a factor or create fresh proof',async()=>{
  const codes=await enable();stale();
  const pending=ctx.api.post('/api/auth/step-up').set(h()).send({password,code:codes[0]}).then(r=>r);
  const until=Date.now()+5000;while(!passwordWorkState().active&&Date.now()<until)await new Promise(resolve=>setImmediate(resolve));expect(passwordWorkState().active).toBe(1);
  auth.destroySession(token);expect((await pending).status).toBe(401);
  const {checkMfaCode}=await import('../src/shared/mfa');expect(checkMfaCode(1,codes[0]!)).toBe(true);
});
it('a stale session cannot enroll another trusted office PC',async()=>{
  stale();const denied=await ctx.api.post('/api/sync/nodes').set(h()).send({name:'Unverified office PC'});
  expect(denied.status).toBe(403);expect(denied.body.step_up_required).toBe(true);
  const sync=await import('../src/sync');expect(sync.syncConfigOf(db.getDb('default'))).toBeNull();
});
it('a stale session cannot change mail, AI or accounting configuration',async()=>{
  stale();
  for(const [method,url] of [
    ['put','/api/mail/settings'],['post','/api/mail/test'],
    ['put','/api/ai/config'],['post','/api/ai/reset-usage'],
    ['get','/api/quickbooks/connect'],['post','/api/quickbooks/disconnect'],
    ['put','/api/quickbooks/auto-push'],
  ] as const){
    const response=await ctx.api[method](url).set(h()).send({});
    expect(response.status,url).toBe(403);expect(response.body.step_up_required,url).toBe(true);
  }
});
it('verification metadata never leaves the cloud in a node snapshot',async()=>{
  const sync=await import('../src/sync');expect(sync.isNodeLocalTable('session_stepups')).toBe(true);
  expect(db.queryOne<{n:number}>('SELECT COUNT(*) AS n FROM session_stepups')!.n).toBeGreaterThan(0);
  sync.enableSync(db.getDb('default'),{role:'cloud',nodeNo:0});
  const file=path.join(ctx.tmpDir,'step-up-node.db');(await import('../src/sync/transport')).buildNodeSnapshot('default',file);const snapshot=new DatabaseSync(file);
  try {if(snapshot.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_stepups'").get())expect((snapshot.prepare('SELECT COUNT(*) AS n FROM session_stepups').get() as {n:number}).n).toBe(0);}finally{snapshot.close();}
});
