import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {setupApp,cleanup,type TestContext} from './helpers';
let ctx:TestContext,platform:typeof import('../src/platform/platform'),source:typeof import('../src/platform/inquiries'),receipts:typeof import('../src/platform/inquiry-receipts');
const host='inquiry-retry.example.test';
const body={name:'Synthetic contact',company:'Synthetic company',email:'contact@example.test',phone:'',employees:'',modules:['hr'],message:'Synthetic private inquiry'};
const input={...body,phone:null,employees:null};
const count=(table:string)=>Number(platform.platformDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);
function send(key?:string,data:object=body,url='/site/inquiry',site=host){const r=ctx.api.post(url).set('Host',site);if(key!==undefined)r.set('Idempotency-Key',key);return r.send(data);}
beforeAll(async()=>{
  process.env.TENANT_PATH_HOST=host;ctx=await setupApp();platform=await import('../src/platform/platform');source=await import('../src/platform/inquiries');receipts=await import('../src/platform/inquiry-receipts');
  (await import('../src/platform/platform-mail')).savePlatformMail({transport:'brevo',from_email:'alerts@example.test',alert_to:'owner@example.test'},'synthetic-inquiry-retry-secret');
});
afterAll(()=>{delete process.env.TENANT_PATH_HOST;cleanup(ctx);});
it('replays only public acknowledgement after reopen without another inquiry or alert',async()=>{
  const key=randomUUID(),first=await send(key);expect(first.status).toBe(201);expect(first.body).toEqual({ok:true});
  const before={sources:count('inquiries'),events:count('platform_business_outbox')};platform._resetPlatformDb();
  const replay=await send(key.toUpperCase(),{...body,email:'CONTACT@EXAMPLE.TEST',company:' Synthetic company ',unknown:'ignored'});
  expect(replay.status).toBe(201);expect(replay.headers['idempotency-replayed']).toBe('true');expect(replay.headers['cache-control']).toBe('no-store');expect(replay.body).toEqual({ok:true});
  expect({sources:count('inquiries'),events:count('platform_business_outbox')}).toEqual(before);
  const row=platform.platformDb().prepare('SELECT * FROM platform_inquiry_receipts').get()!;expect(row.verifier).toMatch(/^scrypt\$v1\$/);
  const stored=JSON.stringify(row);for(const value of [key,body.name,body.email,body.message])expect(stored).not.toContain(value);
});
it.each(['name','company','email','phone','employees','modules','message'])('rejects same-key changed %s without revealing original data',async field=>{
  const key=randomUUID();expect((await send(key)).status).toBe(201);const changed={...body,[field]:field==='email'?'other@example.test':field==='phone'?'09171234567':field==='employees'?'1-20':field==='modules'?['inventory']:'Different'};
  const r=await send(key,changed);expect(r.status).toBe(409);expect(JSON.stringify(r.body)).not.toContain(body.message);
});
it('honors host, schema and honeypot checks before replay',async()=>{
  const key=randomUUID();expect((await send(key)).status).toBe(201);const before=count('inquiries');
  expect((await send(key,body,'/site/inquiry','wrong.example.test')).status).toBe(404);expect((await send(key,{...body,email:'invalid'})).status).toBe(400);
  const bot=await send(key,{...body,website:'synthetic bot'});expect(bot.status).toBe(201);expect(bot.headers['idempotency-replayed']).toBeUndefined();expect(count('inquiries')).toBe(before);
});
it.each(['','predictable','11111111-1111-1111-1111-111111111111'])('refuses malformed key %j before source creation',async key=>{
  const before=count('inquiries');expect((await send(key)).status).toBe(400);expect(count('inquiries')).toBe(before);
});
it('does not create receipt/source/alert for a honeypot even with malformed key',async()=>{
  const before=count('platform_inquiry_receipts');expect((await send('invalid',{...body,website:'bot'})).status).toBe(201);expect(count('platform_inquiry_receipts')).toBe(before);
});
it('keeps no-key and distinct-key behavior explicit',async()=>{
  const before=count('inquiries');expect((await send()).status).toBe(201);expect((await send()).status).toBe(201);
  expect((await send(randomUUID())).status).toBe(201);expect((await send(randomUUID())).status).toBe(201);expect(count('inquiries')).toBe(before+4);
});
it('binds case-insensitive and trailing-slash site aliases to the same receipt',async()=>{
  const key=randomUUID();expect((await send(key,body,'/SITE/INQUIRY/')).status).toBe(201);
  expect((await send(key)).headers['idempotency-replayed']).toBe('true');expect((await send(key,{...body,message:'Changed'})).status).toBe(409);
});
it('rolls source and alert back if receipt storage fails, then permits corrected same-key retry',async()=>{
  const key=randomUUID(),d=platform.platformDb(),before={sources:count('inquiries'),events:count('platform_business_outbox'),receipts:count('platform_inquiry_receipts')};
  d.exec("CREATE TRIGGER inquiry_receipt_failure BEFORE INSERT ON platform_inquiry_receipts BEGIN SELECT RAISE(ABORT,'synthetic-private-receipt-detail'); END");
  try{const r=await send(key);expect(r.status).toBe(500);expect(r.body).toEqual({error:'Internal server error',request_id:r.headers['x-request-id']});}finally{d.exec('DROP TRIGGER inquiry_receipt_failure');}
  expect({sources:count('inquiries'),events:count('platform_business_outbox'),receipts:count('platform_inquiry_receipts')}).toEqual(before);
  expect((await send(key,{...body,company:'Corrected company'})).status).toBe(201);expect((await send(key,{...body,company:'Corrected company'})).headers['idempotency-replayed']).toBe('true');
});
it('rolls receipt and source back if enabled alert insertion fails',async()=>{
  const key=randomUUID(),d=platform.platformDb(),before=count('platform_inquiry_receipts');
  d.exec("CREATE TRIGGER inquiry_alert_failure BEFORE INSERT ON platform_business_outbox BEGIN SELECT RAISE(ABORT,'synthetic inquiry alert failure'); END");
  try{expect((await send(key)).status).toBe(500);expect(count('platform_inquiry_receipts')).toBe(before);}finally{d.exec('DROP TRIGGER inquiry_alert_failure');}
  expect((await send(key)).status).toBe(201);
});
it('rolls back a stale competing candidate source instead of duplicating',async()=>{
  const key=randomUUID(),candidate=await receipts.prepareInquiryReceipt(key,input);expect((await send(key)).status).toBe(201);const before=count('inquiries');
  expect(()=>source.createInquiry(input,row=>receipts.saveInquiryReceipt(candidate,row.id))).toThrow('Another request completed');expect(count('inquiries')).toBe(before);
});
it('expires verifier while retaining a tombstone and refuses source deletion replay',async()=>{
  const key=randomUUID();expect((await send(key)).status).toBe(201);const row=platform.platformDb().prepare('SELECT * FROM platform_inquiry_receipts ORDER BY inquiry_id DESC LIMIT 1').get()!;
  platform.platformDb().prepare('UPDATE platform_inquiry_receipts SET expires_at=0 WHERE key_hash=?').run(String(row.key_hash));receipts.pruneInquiryReceipts();
  expect(platform.platformDb().prepare('SELECT verifier FROM platform_inquiry_receipts WHERE key_hash=?').get(String(row.key_hash))!.verifier).toBeNull();expect((await send(key)).status).toBe(409);
  const other=randomUUID();expect((await send(other)).status).toBe(201);const latest=platform.platformDb().prepare('SELECT inquiry_id FROM platform_inquiry_receipts ORDER BY inquiry_id DESC LIMIT 1').get()!;
  platform.platformDb().prepare('DELETE FROM inquiries WHERE id=?').run(Number(latest.inquiry_id));expect((await send(other)).status).toBe(409);
});
it('does not save validation failures and accepts corrected same-key data',async()=>{
  const key=randomUUID();expect((await send(key,{...body,email:'bad'})).status).toBe(400);expect((await send(key)).status).toBe(201);
});
it.each(['before','after'])('recovers a real process exit %s source/receipt commit',phase=>{
  const root=path.join(ctx.tmpDir,'inquiry-exit-'+phase);fs.mkdirSync(root);const key=randomUUID();
  const env={PATH:process.env.PATH,NODE_ENV:'test',ADMIN_PASSWORD:'Synthetic inquiry startup password',DB_PATH:path.join(root,'default.db'),DATA_DIR:path.join(root,'data'),PLATFORM_DB_PATH:path.join(root,'platform.db'),UPLOAD_DIR:path.join(root,'uploads'),BACKUP_DIR:path.join(root,'backups')};
  const imports=`import {platformDb} from './src/platform/platform.ts';import {createInquiry,listInquiries} from './src/platform/inquiries.ts';import {prepareInquiryReceipt,saveInquiryReceipt} from './src/platform/inquiry-receipts.ts';const input=${JSON.stringify(input)};`;
  const first=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',imports+`const receipt=await prepareInquiryReceipt('${key}',input);platformDb().function('inquiry_exit',()=>process.exit(73));if('${phase}'==='before')platformDb().exec("CREATE TRIGGER exit_receipt AFTER INSERT ON platform_inquiry_receipts BEGIN SELECT inquiry_exit(); END");createInquiry(input,row=>saveInquiryReceipt(receipt,row.id));process.exit(73);`],{cwd:process.cwd(),env,encoding:'utf8',timeout:20000});expect(first.status,first.stderr).toBe(73);
  const second=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',imports+`const receipt=await prepareInquiryReceipt('${key}',input);if('${phase}'==='after'){if(!receipt.replay||listInquiries().length!==1)process.exit(74);}else{platformDb().exec('DROP TRIGGER exit_receipt');if(receipt.replay||listInquiries().length)process.exit(75);createInquiry(input,row=>saveInquiryReceipt(receipt,row.id));}process.exit(0);`],{cwd:process.cwd(),env,encoding:'utf8',timeout:20000});expect(second.status,second.stderr).toBe(0);
});

it('admits one same-key winner under concurrent HTTP requests and replays after a conflict',async()=>{
  const key=randomUUID(),before=count('inquiries');const outcomes=await Promise.all([send(key),send(key)]);
  expect(outcomes.map(r=>r.status).sort()).toEqual([201,409]);expect(count('inquiries')).toBe(before+1);expect((await send(key)).headers['idempotency-replayed']).toBe('true');
});
it('refuses a saturated shared work queue with safe retry guidance and no source/receipt',async()=>{
  const work=await import('../src/shared/password-work');let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  const active=work.withPasswordWork(()=>gate),waiting=Array.from({length:8},()=>work.withPasswordWork(async()=>true));const before=count('inquiries');
  try{const r=await send(randomUUID());expect(r.status).toBe(503);expect(r.headers['retry-after']).toBe('5');expect(r.body.error).toBe('Inquiry processing is busy. Try again shortly.');expect(count('inquiries')).toBe(before);}
  finally{release();await Promise.all([active,...waiting]);}
});
it.each(['source','expiry'])('rechecks %s after awaited verifier work',async kind=>{
  const key=randomUUID();expect((await send(key)).status).toBe(201);const row=platform.platformDb().prepare('SELECT * FROM platform_inquiry_receipts ORDER BY inquiry_id DESC LIMIT 1').get()!;
  const work=await import('../src/shared/password-work');let release!:()=>void;const active=work.withPasswordWork(()=>new Promise<void>(resolve=>{release=resolve;}));
  const pending=send(key).then(r=>r);
  try{
    const deadline=Date.now()+2000;while(work.passwordWorkState().queued===0&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));expect(work.passwordWorkState().queued).toBe(1);
    if(kind==='source')platform.platformDb().prepare('DELETE FROM inquiries WHERE id=?').run(Number(row.inquiry_id));
    else{platform.platformDb().prepare('UPDATE platform_inquiry_receipts SET expires_at=0 WHERE key_hash=?').run(String(row.key_hash));receipts.pruneInquiryReceipts();}
  }finally{release();await active;}
  expect((await pending).status).toBe(409);
});
it('retains the production five-per-hour limiter even for matching replays',async()=>{
  const key=randomUUID(),before=count('inquiries');vi.stubEnv('NODE_ENV','production');
  try{for(let i=0;i<5;i++)expect((await send(key)).status).toBe(201);expect((await send(key)).status).toBe(429);expect(count('inquiries')).toBe(before+1);}
  finally{vi.unstubAllEnvs();}
});
