import path from 'node:path';
import { createServer, type Socket } from 'node:net';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import { beforeAll, beforeEach, afterEach, afterAll, it, expect, vi } from 'vitest';
import { setupApp, cleanup, type TestContext } from './helpers';
let ctx: TestContext, platform: typeof import('../src/platform/platform'), mail: typeof import('../src/platform/platform-mail'), queue: typeof import('../src/platform/owner-alert-outbox');
const settings = { transport: 'brevo' as const, from_email: 'alerts@example.test', alert_to: 'owner@example.test', alert_signup: true };
const password = 'Synthetic owner outbox password';
const enqueue = () => queue.enqueueSignupAlert('outbox-fixture', 'Synthetic signup alert', ['Synthetic private contact']);
const row = () => platform.platformDb().prepare('SELECT * FROM platform_owner_outbox').get()!;
const due = () => platform.platformDb().prepare('UPDATE platform_owner_outbox SET next_attempt_at=0').run();
beforeAll(async () => {
  process.env.PLATFORM_CONSOLE='true'; process.env.SIGNUPS_OPEN='true'; ctx=await setupApp();
  platform=await import('../src/platform/platform'); mail=await import('../src/platform/platform-mail'); queue=await import('../src/platform/owner-alert-outbox');
  (await import('../src/platform/provisioning')).createTenant({slug:'outbox-fixture',name:'Outbox fixture',admin_username:'owner',admin_password:password,is_sandbox:true});
});
beforeEach(() => { platform.platformDb().exec('DELETE FROM platform_owner_outbox'); mail._testOutbox.length=0; mail.savePlatformMail(settings,'synthetic-outbox-secret'); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(() => { delete process.env.PLATFORM_CONSOLE; delete process.env.SIGNUPS_OPEN; cleanup(ctx); });

it('persists intent without sending, then records acceptance exactly once locally', async () => {
  enqueue(); expect(row().state).toBe('pending'); expect(mail._testOutbox).toHaveLength(0);
  platform._resetPlatformDb(); expect(await queue.processOneOwnerAlert()).toBe(true);
  expect(row().state).toBe('accepted'); expect(row().attempts).toBe(1); expect(mail._testOutbox).toHaveLength(1);
  expect(await queue.processOneOwnerAlert()).toBe(false); expect(mail._testOutbox).toHaveLength(1);
});
it.each([{transport:'off' as const},{alert_to:''},{alert_signup:false}])('does not enqueue disabled alerts %j or send them after enabling later', async patch => {
  mail.savePlatformMail(patch); enqueue(); expect(queue.ownerAlertStatus()).toEqual([]);
  mail.savePlatformMail(settings); expect(await queue.processOneOwnerAlert()).toBe(false);
});
it('blocks incomplete configuration without transmitting or retrying', async () => {
  mail.savePlatformMail({},''); enqueue(); await queue.processOneOwnerAlert();
  expect(row()).toMatchObject({state:'blocked',error_code:'mail_not_ready'}); expect(mail._testOutbox).toHaveLength(0);
});
it.each([{alert_to:'different@example.test'},{alert_signup:false},{from_name:'Changed sender'}])('cancels old mail after settings change %j', async patch => {
  enqueue(); mail.savePlatformMail(patch); await queue.processOneOwnerAlert();
  expect(row()).toMatchObject({state:'cancelled',error_code:'configuration_changed'}); expect(mail._testOutbox).toHaveLength(0);
});
it('cancels when credential generation changes', async () => {
  enqueue(); mail.savePlatformMail({},'different-synthetic-secret'); await queue.processOneOwnerAlert();
  expect(row().state).toBe('cancelled'); expect(mail._testOutbox).toHaveLength(0);
});
it('cancels an unavailable workspace before sending', async () => {
  enqueue(); platform.setTenantStatus('outbox-fixture','purged');
  try { await queue.processOneOwnerAlert(); expect(row().error_code).toBe('workspace_unavailable'); expect(mail._testOutbox).toHaveLength(0); }
  finally { platform.setTenantStatus('outbox-fixture','active'); }
});
it('only one concurrent worker claims a pending event', async () => {
  enqueue(); expect(await Promise.all([queue.processOneOwnerAlert(),queue.processOneOwnerAlert()])).toEqual([true,false]);
  expect(mail._testOutbox).toHaveLength(1); expect(row().attempts).toBe(1);
});
it('retries explicit Brevo rate-limit rejection with persisted backoff and stops at five attempts', async () => {
  enqueue(); vi.stubEnv('NODE_ENV','production'); const send=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(null,{status:429}));
  for(let attempt=1;attempt<=5;attempt++) {
    due(); await queue.processOneOwnerAlert(); expect(row().attempts).toBe(attempt);
    if(attempt<5) { expect(row().state).toBe('retry'); expect(Number(row().next_attempt_at)).toBeGreaterThan(Date.now()); }
  }
  expect(row()).toMatchObject({state:'blocked',error_code:'retry_limit'}); due(); expect(await queue.processOneOwnerAlert()).toBe(false); expect(send).toHaveBeenCalledTimes(5);
});
it.each(['3600',new Date(Date.now()+7_200_000).toUTCString()])('persists a provider Retry-After delay %s', async retryAfter => {
  enqueue(); vi.stubEnv('NODE_ENV','production');
  vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(null,{status:429,headers:{'Retry-After':retryAfter}}));
  const before=Date.now(); await queue.processOneOwnerAlert(); expect(row().state).toBe('retry');
  expect(Number(row().next_attempt_at)).toBeGreaterThanOrEqual(before+3_600_000);
});
it.each([500,202,302])('does not retry uncertain HTTP status %i or expose its body', async status => {
  enqueue(); vi.stubEnv('NODE_ENV','production'); const send=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('synthetic-private-provider-detail',{status}));
  await queue.processOneOwnerAlert(); expect(row()).toMatchObject({state:'unknown',error_code:'provider_outcome_unknown'});
  due(); expect(await queue.processOneOwnerAlert()).toBe(false); expect(send).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(queue.ownerAlertStatus())).not.toContain('synthetic-private-provider-detail');
});
it('blocks definitive provider rejection without blind retries', async () => {
  enqueue(); vi.stubEnv('NODE_ENV','production'); vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(null,{status:401}));
  await queue.processOneOwnerAlert(); expect(row()).toMatchObject({state:'blocked',error_code:'provider_rejected'});
});
it('treats lost provider response as uncertain and logs no raw exception', async () => {
  enqueue(); vi.stubEnv('NODE_ENV','production'); vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('synthetic-private-api-key'));
  await queue.processOneOwnerAlert(); expect(row().state).toBe('unknown');
  expect(JSON.stringify(mail.platformMailLog())).not.toContain('synthetic-private-api-key');
});
it('does not resend a partially accepted SMTP recipient list', async () => {
  mail.savePlatformMail({transport:'smtp',smtp_host:'smtp.example.test',alert_to:'owner@example.test,second@example.test'}); enqueue();
  vi.stubEnv('NODE_ENV','production');
  vi.spyOn(nodemailer,'createTransport').mockReturnValue({sendMail:vi.fn(async()=>({accepted:['owner@example.test'],rejected:['second@example.test']})),close:vi.fn()} as unknown as ReturnType<typeof nodemailer.createTransport>);
  await queue.processOneOwnerAlert(); expect(row()).toMatchObject({state:'unknown',error_code:'recipient_outcome_unknown'});
  expect(nodemailer.createTransport).toHaveBeenCalledWith(expect.objectContaining({requireTLS:true,socketTimeout:15000}));
});
it('accepts all SMTP recipients and destroys its owned socket', async () => {
  mail.savePlatformMail({transport:'smtp',smtp_host:'smtp.example.test'}); enqueue(); vi.stubEnv('NODE_ENV','production');
  vi.spyOn(nodemailer,'createTransport').mockReturnValue({sendMail:vi.fn(async()=>({accepted:['owner@example.test'],rejected:[]})),close:vi.fn()} as unknown as ReturnType<typeof nodemailer.createTransport>);
  await queue.processOneOwnerAlert(); expect(row().state).toBe('accepted');
  const options=vi.mocked(nodemailer.createTransport).mock.calls[0]![0] as unknown as {socket:import('node:net').Socket};
  expect(options.socket.destroyed).toBe(true);
});
it('bounds an indefinitely stalled SMTP send and preserves uncertainty', async () => {
  mail.savePlatformMail({transport:'smtp',smtp_host:'smtp.example.test'}); enqueue(); vi.stubEnv('NODE_ENV','production'); vi.useFakeTimers();
  const close=vi.fn(); vi.spyOn(nodemailer,'createTransport').mockReturnValue({sendMail:vi.fn(()=>new Promise(()=>{})),close} as unknown as ReturnType<typeof nodemailer.createTransport>);
  const running=queue.processOneOwnerAlert(); await vi.advanceTimersByTimeAsync(45_001); await running;
  expect(row().state).toBe('unknown'); expect(close).toHaveBeenCalled();
  const options=vi.mocked(nodemailer.createTransport).mock.calls[0]![0] as unknown as {socket:import('node:net').Socket};
  expect(options.socket.destroyed).toBe(true);
});
it('destroys a real stalled SMTP TCP connection at the adapter deadline', async () => {
  let peer: Socket | undefined, signalBlocked: () => void = () => {}, signalClosed: () => void = () => {};
  const blocked=new Promise<void>(resolve=>{signalBlocked=resolve;});
  const closed=new Promise<void>(resolve=>{signalClosed=resolve;});
  const server=createServer(socket=>{
    peer=socket; socket.on('error',()=>{}); socket.once('close',signalClosed);
    socket.write('220 synthetic.example.test SMTP\r\n');
    socket.on('data',data=>{if(data.toString().includes('EHLO')) { socket.write('250-synthetic.example.test\r\n'); signalBlocked(); }});
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const address=server.address() as {port:number};
    mail.savePlatformMail({transport:'smtp',smtp_host:'127.0.0.1',smtp_port:address.port,smtp_secure:false,smtp_user:''}); enqueue();
    vi.stubEnv('NODE_ENV','production'); vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
    const running=queue.processOneOwnerAlert(); await blocked;
    await vi.advanceTimersByTimeAsync(45_001); await running; vi.useRealTimers();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([closed,new Promise<never>((_,reject)=>{deadline=setTimeout(()=>reject(new Error('SMTP peer stayed open')),1000);})]); }
    finally { if(deadline)clearTimeout(deadline); }
    expect(peer!.destroyed).toBe(true); expect(row()).toMatchObject({state:'unknown',error_code:'provider_outcome_unknown'});
  } finally { vi.useRealTimers(); peer?.destroy(); await new Promise<void>(resolve=>server.close(()=>resolve())); }
});
it('preserves a claim after acknowledgement storage fails and marks it uncertain instead of resending', async () => {
  enqueue(); const d=platform.platformDb(); d.exec("CREATE TRIGGER outbox_ack_failure BEFORE INSERT ON platform_mail_log BEGIN SELECT RAISE(ABORT,'synthetic acknowledgement storage failure'); END");
  try { await expect(queue.processOneOwnerAlert()).rejects.toThrow('synthetic acknowledgement'); }
  finally { d.exec('DROP TRIGGER outbox_ack_failure'); }
  expect(row().state).toBe('inflight'); expect(mail._testOutbox).toHaveLength(1);
  d.prepare('UPDATE platform_owner_outbox SET claimed_at=?').run(Date.now()-120_001); await queue.processOneOwnerAlert();
  expect(row()).toMatchObject({state:'unknown',error_code:'interrupted_send'}); expect(mail._testOutbox).toHaveLength(1);
});
it('expires unsent work and prunes terminal payload without deleting duplicate-prevention metadata', async () => {
  enqueue(); const d=platform.platformDb(); d.prepare('UPDATE platform_owner_outbox SET created_at=?').run(Date.now()-7*86_400_000-1);
  await queue.processOneOwnerAlert(); expect(row()).toMatchObject({state:'cancelled',error_code:'event_expired',body:null,recipients:null,configuration_stamp:null});
  expect(row().event_key).toBe('signup:outbox-fixture'); expect(mail._testOutbox).toHaveLength(0);
});
it('prunes terminal message contents after one day while preserving state and event identity', async () => {
  enqueue(); await queue.processOneOwnerAlert();
  platform.platformDb().prepare('UPDATE platform_owner_outbox SET updated_at=?').run(Date.now()-86_400_001);
  queue.maintainOwnerAlerts(); expect(row()).toMatchObject({state:'accepted',event_key:'signup:outbox-fixture',body:null,recipients:null,subject:null,configuration_stamp:null});
});
it('stores no event, catalog or invoice when durable enqueue fails; same-key corrected retry enqueues once', async () => {
  const body={slug:'outbox-rollback',company_name:'Outbox rollback',admin_username:'owner',admin_password:password,admin_email:'owner@example.test',modules:['hr'],seats:3};
  const key=randomUUID(), d=platform.platformDb();
  (await import('../src/platform/billing')).setBillingSettings({module_prices:{hr:100},seat_price:20});
  d.exec("CREATE TRIGGER outbox_enqueue_failure BEFORE INSERT ON platform_owner_outbox BEGIN SELECT RAISE(ABORT,'synthetic enqueue failure'); END");
  try {
    expect((await ctx.api.post('/api/signup').set('Idempotency-Key',key).send(body)).status).toBe(500);
    expect(platform.getTenant(body.slug)).toBeNull(); expect(fs.existsSync(path.join(process.env.DATA_DIR!,body.slug+'.db'))).toBe(false);
    expect(d.prepare('SELECT * FROM platform_creation_receipts WHERE tenant_slug=?').all(body.slug)).toEqual([]);
    expect(d.prepare('SELECT * FROM billing_invoices WHERE tenant_slug=?').all(body.slug)).toEqual([]);
  } finally { d.exec('DROP TRIGGER outbox_enqueue_failure'); }
  expect((await ctx.api.post('/api/signup').set('Idempotency-Key',key).send(body)).status).toBe(201);
  expect((await ctx.api.post('/api/signup').set('Idempotency-Key',key).send(body)).headers['idempotency-replayed']).toBe('true');
  expect(queue.ownerAlertStatus()).toHaveLength(1); expect(mail._testOutbox).toHaveLength(0);
});
it('exposes redacted operational state only to an authenticated console operator', async () => {
  enqueue(); const denied=await ctx.api.get('/_platform/api/mail'); expect(denied.status).toBe(401); expect(denied.headers['cache-control']).toBe('no-store');
  const users=await import('../src/platform/platform-users'); users.upsertPlatformUser('outbox-operator',password);
  const login=await ctx.api.post('/_platform/api/login').send({username:'outbox-operator',password});
  const response=await ctx.api.get('/_platform/api/mail').set('Authorization','Bearer '+login.body.token);
  expect(response.status).toBe(200); expect(response.headers['cache-control']).toBe('no-store'); expect(response.body.outbox[0]).toMatchObject({state:'pending',attempts:0});
  expect(response.body.outbox[0].body).toBeUndefined(); expect(response.body.outbox[0].configuration_stamp).toBeUndefined();
  expect(JSON.stringify(response.body)).not.toContain('synthetic-outbox-secret');
});

it('returns a correlated generic error if immediate console test-mail logging fails after acceptance', async () => {
  const users=await import('../src/platform/platform-users'); users.upsertPlatformUser('mail-fault-operator',password);
  const login=await ctx.api.post('/_platform/api/login').send({username:'mail-fault-operator',password});
  const d=platform.platformDb();
  d.exec("CREATE TRIGGER test_mail_log_failure BEFORE INSERT ON platform_mail_log BEGIN SELECT RAISE(ABORT,'synthetic-private-test-mail-failure'); END");
  try {
    const response=await ctx.api.post('/_platform/api/mail/test').set('Authorization','Bearer '+login.body.token).send({});
    expect(response.status).toBe(500); expect(response.body).toEqual({error:'Internal server error',request_id:response.headers['x-request-id']});
    expect(mail._testOutbox).toHaveLength(1); expect(JSON.stringify(response.body)).not.toContain('synthetic-private');
  } finally { d.exec('DROP TRIGGER test_mail_log_failure'); }
});

it.each(['before-claim-commit','after-claim','after-provider-acceptance'])('recovers a real process exit at %s without blindly resending', phase => {
  const root=path.join(ctx.tmpDir,'outbox-process-'+phase); fs.mkdirSync(root);
  const env={PATH:process.env.PATH,NODE_ENV:'test',DEPLOY_MODE:'cloud',ADMIN_PASSWORD:password,
    DB_PATH:path.join(root,'default.db'),DATA_DIR:path.join(root,'tenants'),PLATFORM_DB_PATH:path.join(root,'platform.db'),UPLOAD_DIR:path.join(root,'uploads'),BACKUP_DIR:path.join(root,'backups')};
  const imports=`import {platformDb} from './src/platform/platform.ts'; import {createTenant} from './src/platform/provisioning.ts';
    import {savePlatformMail,_testOutbox} from './src/platform/platform-mail.ts';
    import {prepareOwnerAlerts,enqueueSignupAlert,processOneOwnerAlert,ownerAlertStatus} from './src/platform/owner-alert-outbox.ts';`;
  const first=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',imports+`
    savePlatformMail({transport:'brevo',from_email:'alerts@example.test',alert_to:'owner@example.test'},'synthetic'); prepareOwnerAlerts();
    createTenant({slug:'outbox-crashed',name:'Synthetic crash',admin_username:'owner',admin_password:'${password}',is_sandbox:true},slug=>enqueueSignupAlert(slug,'Synthetic crash alert',['Synthetic']));
    platformDb().function('exit_claim',()=>process.exit(73));
    if(${JSON.stringify(phase)}==='before-claim-commit') {
      platformDb().exec("CREATE TRIGGER exit_outbox AFTER UPDATE ON platform_owner_outbox WHEN NEW.state='inflight' BEGIN SELECT exit_claim(); END");
    } else {
      process.env.NODE_ENV='production';
      globalThis.fetch=async()=>{
        if(${JSON.stringify(phase)}==='after-claim')process.exit(73);
        return new Response(null,{status:201});
      };
      platformDb().exec("CREATE TRIGGER exit_outbox BEFORE INSERT ON platform_mail_log BEGIN SELECT exit_claim(); END");
    }
    await processOneOwnerAlert();`],{cwd:process.cwd(),env,encoding:'utf8',timeout:20000});
  // Before claim commit SQLite rolls back to pending; after claim commit uncertainty blocks replay.
  expect(first.status,first.stderr).toBe(73);
  const second=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',imports+`
    platformDb().exec('DROP TRIGGER exit_outbox');
    if(${JSON.stringify(phase)}==='before-claim-commit') {
      if(ownerAlertStatus()[0].state!=='pending')process.exit(74);
      await processOneOwnerAlert();
      if(ownerAlertStatus()[0].state!=='accepted'||_testOutbox.length!==1)process.exit(75);
    } else {
      if(ownerAlertStatus()[0].state!=='inflight')process.exit(76);
      platformDb().prepare('UPDATE platform_owner_outbox SET claimed_at=?').run(Date.now()-120001);
      await processOneOwnerAlert();
      if(ownerAlertStatus()[0].state!=='unknown'||_testOutbox.length!==0)process.exit(77);
    }
    process.exit(0);`],{cwd:process.cwd(),env,encoding:'utf8',timeout:20000});
  expect(second.status,second.stderr).toBe(0);
});
