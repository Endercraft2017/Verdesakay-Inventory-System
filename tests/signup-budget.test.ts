import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {beforeAll,afterAll,afterEach,it,expect,vi} from 'vitest';
import {setupApp,cleanup,type TestContext} from './helpers';
let ctx:TestContext,platform:typeof import('../src/platform/platform'),db:typeof import('../src/shared/db'),passwords:typeof import('../src/shared/password-hash'),work:typeof import('../src/shared/password-work'),provision:typeof import('../src/platform/provisioning');
const password='Synthetic signup admission password';
const input=(slug:string)=>({slug,company_name:slug,admin_username:'owner',admin_password:password,admin_email:'signup@example.test',modules:['hr'],seats:2});
const send=(body:object,key?:string)=>{const r=ctx.api.post('/api/signup');if(key!==undefined)r.set('Idempotency-Key',key);return r.send(body);};
const count=()=>Number(platform.platformDb().prepare('SELECT COUNT(*) AS n FROM tenants').get()!.n);
function hold(){let release!:()=>void;const active=work.withPasswordWork(()=>new Promise<void>(r=>{release=r;}));return {active,release:()=>release()};}
async function queued(){const until=Date.now()+2000;while(work.passwordWorkState().queued===0&&Date.now()<until)await new Promise(r=>setTimeout(r,5));expect(work.passwordWorkState().queued).toBe(1);}
beforeAll(async()=>{process.env.SIGNUPS_OPEN='true';ctx=await setupApp();platform=await import('../src/platform/platform');db=await import('../src/shared/db');passwords=await import('../src/shared/password-hash');work=await import('../src/shared/password-work');provision=await import('../src/platform/provisioning');});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
afterAll(()=>{delete process.env.SIGNUPS_OPEN;cleanup(ctx);});
it.each([true,false])('creates correct owner credentials without any synchronous hash, keyed=%s',async keyed=>{
 const slug='admission-'+(keyed?'keyed':'legacy'),spy=vi.spyOn(passwords,'hashPassword').mockImplementation(()=>{throw new Error('Synchronous hash is forbidden in public signup');});
 const r=await send({...input(slug),adminHash:'untrusted-client-hash'},keyed?randomUUID():undefined);expect(r.status).toBe(201);expect(r.headers['cache-control']).toBe('no-store');expect(spy).not.toHaveBeenCalled();
 const row=db.withTenant(slug,()=>db.queryOne<{username:string;password_hash:string;password_change_required:number}>('SELECT username,password_hash,password_change_required FROM users'))!;
 expect(row.username).toBe('owner');expect(row.password_change_required).toBe(0);expect(passwords.verifyPassword(password,row.password_hash)).toBe(true);expect(passwords.verifyPassword('untrusted-client-hash',row.password_hash)).toBe(false);
 expect(db.withTenant(slug,()=>db.queryOne<{n:number}>("SELECT COUNT(*) n FROM users WHERE username='admin'")!.n)).toBe(0);
});
it('keeps one active signup, refuses competing requests without a backlog and serves health during hashing wait',async()=>{
 const held=hold(),key=randomUUID(),body=input('admission-active'),first=send(body,key).then(r=>r);await queued();
 try{
  expect((await ctx.api.get('/api/health')).status).toBe(200);
  expect((await send({...body,admin_password:'bad'},randomUUID())).status).toBe(400);
  for(let i=0;i<3;i++){const busy=await send(input('admission-busy-'+i),randomUUID());expect(busy.status).toBe(503);expect(busy.headers['retry-after']).toBe('5');expect(busy.body.error).toBe('Registration is busy. Try again shortly.');}
  expect(work.passwordWorkState()).toEqual({active:1,queued:1});expect(platform.getTenant(body.slug)).toBeNull();expect(fs.existsSync(path.join(process.env.DATA_DIR!,body.slug+'.db'))).toBe(false);
 }finally{held.release();await held.active;}
 expect((await first).status).toBe(201);expect((await send(body,key)).headers['idempotency-replayed']).toBe('true');
});
it('refuses a saturated shared crypto queue without source, receipt or file and releases signup admission',async()=>{
 const held=hold(),waiting=Array.from({length:8},()=>work.withPasswordWork(async()=>true)),key=randomUUID(),body=input('admission-saturated'),before=count();
 try{const r=await send(body,key);expect(r.status).toBe(503);expect(r.headers['retry-after']).toBe('5');expect(count()).toBe(before);expect(fs.existsSync(path.join(process.env.DATA_DIR!,body.slug+'.db'))).toBe(false);expect(platform.platformDb().prepare('SELECT * FROM platform_creation_receipts WHERE tenant_slug=?').all(body.slug)).toEqual([]);}
 finally{held.release();await Promise.all([held.active,...waiting]);}
 expect((await send(body,key)).status).toBe(201);
});
it('releases admission after a real publication fault and accepts corrected same-key retry',async()=>{
 const d=platform.platformDb(),key=randomUUID(),body=input('admission-fault');d.exec("CREATE TRIGGER signup_admission_fault BEFORE INSERT ON provisioning_log WHEN NEW.action='create' BEGIN SELECT RAISE(ABORT,'PRIVATE signup fault'); END");
 try{const r=await send(body,key);expect(r.status).toBe(500);expect(r.body).toEqual({error:'Internal server error',request_id:r.headers['x-request-id']});expect(platform.getTenant(body.slug)).toBeNull();}
 finally{d.exec('DROP TRIGGER signup_admission_fault');}
 expect((await send({...body,company_name:'Corrected company'},key)).status).toBe(201);
});
it('revalidates a competing catalog publication after awaited owner hashing',async()=>{
 const held=hold(),slug='admission-race',candidate=provision.createTenantForPublicSignup({slug,name:'Candidate',admin_username:'owner',admin_password:password});await queued();
 try{provision.createTenant({slug,name:'Winner',admin_username:'winner',admin_password:'Synthetic competing owner password'});}
 finally{held.release();await held.active;}
 await expect(candidate).rejects.toThrow('already taken');expect(platform.getTenant(slug)!.name).toBe('Winner');expect(db.withTenant(slug,()=>db.queryOne<{username:string}>('SELECT username FROM users')!.username)).toBe('winner');
});
it.each(['expiry','verifier','response','source'])('rejects a replay whose live %s changed during verification',async kind=>{
 const key=randomUUID(),body=input('admission-live-'+kind);expect((await send(body,key)).status).toBe(201);const held=hold(),pending=send(body,key).then(r=>r);await queued();
 try{
  const d=platform.platformDb();
  if(kind==='expiry')d.prepare('UPDATE platform_creation_receipts SET expires_at=0 WHERE tenant_slug=?').run(body.slug);
  if(kind==='verifier')d.prepare('UPDATE platform_creation_receipts SET verifier=NULL WHERE tenant_slug=?').run(body.slug);
  if(kind==='response')d.prepare('UPDATE platform_creation_receipts SET response=? WHERE tenant_slug=?').run('{"slug":"different"}',body.slug);
  if(kind==='source')d.prepare("UPDATE tenants SET status='purged' WHERE slug=?").run(body.slug);
 }finally{held.release();await held.active;}
 expect((await pending).status).toBe(409);
});
it('public owner preparation yields to the event loop and snapshots mutable caller input',async()=>{
 const body={slug:'admission-snapshot',name:'Original company',admin_username:'owner',admin_password:password};const pending=provision.createTenantForPublicSignup(body);
 body.name='Changed company';body.admin_password='Changed synthetic password';
 expect(await Promise.race([pending.then(()=>'created'),new Promise(r=>setImmediate(()=>r('event loop')))])).toBe('event loop');await pending;
 expect(platform.getTenant(body.slug)!.name).toBe('Original company');const hash=db.withTenant(body.slug,()=>db.queryOne<{password_hash:string}>('SELECT password_hash FROM users')!.password_hash);expect(passwords.verifyPassword(password,hash)).toBe(true);
});
it('fresh initialization refuses default, existing, nonempty, symlink and malformed-hash targets',()=>{
 const hash=passwords.hashPassword(password),init=(slug:string,h=hash)=>db.initializeFreshTenant(slug,h,()=>undefined);
 expect(()=>init('default')).toThrow('fresh reservation');expect(()=>init('admission-keyed')).toThrow('fresh reservation');expect(()=>init('../escape')).toThrow('fresh reservation');
 const file=path.join(process.env.DATA_DIR!,'admission-notempty.db');fs.writeFileSync(file,'Synthetic existing bytes');expect(()=>init('admission-notempty')).toThrow('empty reserved');expect(fs.readFileSync(file,'utf8')).toBe('Synthetic existing bytes');
 const symlink=path.join(process.env.DATA_DIR!,'admission-link.db');fs.symlinkSync(file,symlink);expect(()=>init('admission-link')).toThrow('empty reserved');expect(()=>init('admission-invalid','malformed')).toThrow('Invalid prepared');
});
it('preserves private async failures and releases admission before a corrected retry',async()=>{
 const key=randomUUID(),body=input('admission-crypto-fault');vi.spyOn(passwords,'hashPasswordForPublicRequest').mockRejectedValueOnce(Object.assign(new Error('PRIVATE native crypto failure'),{status:422,expose:true}));
 const failed=await send(body,key);expect(failed.status).toBe(500);expect(failed.body).toEqual({error:'Internal server error',request_id:failed.headers['x-request-id']});expect(platform.getTenant(body.slug)).toBeNull();expect((await send(body,key)).status).toBe(201);
});
it('public async receipts survive a real process exit and remain readable by the old synchronous preparer',()=>{
 const root=path.join(ctx.tmpDir,'async-signup-exit');fs.mkdirSync(root);const key=randomUUID(),body=input('admission-restart');
 const env={PATH:process.env.PATH,NODE_ENV:'production',DEPLOY_MODE:'cloud',DB_PATH:path.join(root,'default.db'),DATA_DIR:path.join(root,'data'),PLATFORM_DB_PATH:path.join(root,'platform.db'),UPLOAD_DIR:path.join(root,'uploads'),BACKUP_DIR:path.join(root,'backups')};
 const prelude=`import {prepareSignupReceipt,prepareCreationReceipt,saveCreationReceipt} from './src/platform/onboarding-receipts.ts';import {createTenantForPublicSignup} from './src/platform/provisioning.ts';const input=${JSON.stringify(body)};`;
 const first=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',prelude+`const receipt=await prepareSignupReceipt('${key}',input);await createTenantForPublicSignup({slug:input.slug,name:input.company_name,admin_username:input.admin_username,admin_password:input.admin_password},slug=>saveCreationReceipt(receipt,slug,{slug}));process.exit(73);`],{cwd:process.cwd(),env,encoding:'utf8',timeout:20000});expect(first.status,first.stderr).toBe(73);
 const second=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',prelude+`const receipt=await prepareSignupReceipt('${key}',input);if(receipt?.replay?.slug!==input.slug||prepareCreationReceipt('signup:v1','${key}',input)?.replay?.slug!==input.slug)process.exit(74);process.exit(0);`],{cwd:process.cwd(),env,encoding:'utf8',timeout:20000});expect(second.status,second.stderr).toBe(0);
});
it('counts keyed replays under the existing production ten-per-hour limiter',async()=>{
 const key=randomUUID(),body=input('admission-rate'),before=count();vi.stubEnv('NODE_ENV','production');
 for(let i=0;i<10;i++)expect((await send(body,key)).status).toBe(201);
 expect((await send(body,key)).status).toBe(429);expect(count()).toBe(before+1);
});
