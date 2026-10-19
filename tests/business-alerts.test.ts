import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { beforeAll, beforeEach, afterAll, expect, it, vi } from 'vitest';
import { setupApp, cleanup, type TestContext } from './helpers';
let ctx: TestContext, token: string;
let platform: typeof import('../src/platform/platform'), billing: typeof import('../src/platform/billing'), inquiries: typeof import('../src/platform/inquiries'), queue: typeof import('../src/platform/owner-alert-outbox'), mail: typeof import('../src/platform/platform-mail');
const host='alerts.example.test', slug='alert-pay', password='Synthetic business alert password';
const inquiry={name:'Synthetic contact',company:'Synthetic inquiry',email:'contact@example.test',message:'Synthetic private question'};
const png=Buffer.from('89504e470d0a1a0a0000000d49484452','hex');
const auth=()=>({Host:host,Authorization:'Bearer '+token});
const ask=(body:object=inquiry)=>ctx.api.post('/site/inquiry').set('Host',host).send(body);
const issue=()=>billing.createInvoice(slug,{kind:'other',description:'Synthetic reported transfer',amount_centavos:10000,due_on:'2099-01-01'},'fixture');
const report=(id:number,second=false)=>{
  const req=ctx.api.post(`/${slug}/api/tenant/billing/invoices/${id}/payments`).set(auth())
    .field('channel','gcash').field('reference_no','synthetic-bank-reference').field('amount','100').field('paid_on',new Date().toISOString().slice(0,10))
    .attach('proof',png,{filename:'proof.png',contentType:'image/png'});
  if(second)req.attach('form_2307',Buffer.from('synthetic invalid file'),{filename:'bad.txt',contentType:'text/plain'});
  return req;
};
const count=(table:string)=>Number(platform.platformDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);
beforeAll(async()=>{
  Object.assign(process.env,{TENANT_PATH_HOST:host,PLATFORM_CONSOLE:'true'});ctx=await setupApp();
  platform=await import('../src/platform/platform');billing=await import('../src/platform/billing');inquiries=await import('../src/platform/inquiries');
  queue=await import('../src/platform/owner-alert-outbox');mail=await import('../src/platform/platform-mail');
  (await import('../src/platform/provisioning')).createTenant({slug,name:'Synthetic payments',admin_username:'owner',admin_password:password,is_sandbox:true});
  (await import('../src/platform/provisioning')).createTenant({slug:'alert-other',name:'Synthetic other',admin_username:'owner',admin_password:password,is_sandbox:true});
  const login=await ctx.api.post(`/${slug}/api/auth/login`).set('Host',host).send({username:'owner',password});
  expect(login.status).toBe(200);token=login.body.token;
  billing.getBillingSettings();inquiries.listInquiries();
});
beforeEach(()=>{
  platform.platformDb().exec('DELETE FROM platform_owner_outbox; DELETE FROM platform_business_outbox');mail._testOutbox.length=0;
  mail.savePlatformMail({transport:'brevo',from_email:'alerts@example.test',alert_to:'owner@example.test',alert_inquiry:true,alert_payment:true},'synthetic-business-mail-key');
});
afterAll(()=>{delete process.env.TENANT_PATH_HOST;delete process.env.PLATFORM_CONSOLE;cleanup(ctx);});

it('saves website inquiry and intent together without sending, then delivers after catalog reopen',async()=>{
  const response=await ask();expect(response.status).toBe(201);expect(mail._testOutbox).toHaveLength(0);
  expect(queue.ownerAlertStatus()[0]).toMatchObject({kind:'inquiry',tenant_slug:'',state:'pending'});
  platform._resetPlatformDb();await queue.processOneOwnerAlert();
  expect(mail._testOutbox).toHaveLength(1);expect(mail._testOutbox[0]!.text).toContain(inquiry.message);
  expect(mail.platformMailLog()[0]).toMatchObject({kind:'inquiry',status:'sent'});
  expect(await queue.processOneOwnerAlert()).toBe(false);
});
it('rolls an inquiry back if enqueue fails and returns only a generic correlated error',async()=>{
  const before=count('inquiries'),d=platform.platformDb();
  d.exec("CREATE TRIGGER inquiry_enqueue_failure BEFORE INSERT ON platform_business_outbox BEGIN SELECT RAISE(ABORT,'synthetic-private-inquiry-failure'); END");
  try {const r=await ask();expect(r.status).toBe(500);expect(r.body).toEqual({error:'Internal server error',request_id:r.headers['x-request-id']});expect(count('inquiries')).toBe(before);expect(queue.ownerAlertStatus()).toEqual([]);}
  finally{d.exec('DROP TRIGGER inquiry_enqueue_failure');}
  expect((await ask()).status).toBe(201);expect(queue.ownerAlertStatus()).toHaveLength(1);
});
it('stores no source or intent for a bot honeypot or invalid inquiry',async()=>{
  const before=count('inquiries');expect((await ask({...inquiry,website:'synthetic bot'})).status).toBe(201);
  expect((await ask({...inquiry,email:'invalid'})).status).toBe(400);expect(count('inquiries')).toBe(before);expect(queue.ownerAlertStatus()).toEqual([]);
});
it('preserves disabled inquiry policy without creating historical backlog',async()=>{
  mail.savePlatformMail({alert_inquiry:false});expect((await ask()).status).toBe(201);expect(queue.ownerAlertStatus()).toEqual([]);
  mail.savePlatformMail({alert_inquiry:true});expect(await queue.processOneOwnerAlert()).toBe(false);
});
it('cancels missing inquiry intent rather than treating it as a workspace',async()=>{
  await ask();const status=queue.ownerAlertStatus()[0]!;platform.platformDb().prepare('DELETE FROM inquiries WHERE id=?').run(status.source_id!);
  await queue.processOneOwnerAlert();expect(queue.ownerAlertStatus()[0]).toMatchObject({state:'cancelled',error_code:'source_unavailable'});expect(mail._testOutbox).toHaveLength(0);
});

it.each([
  ['blob','platform_durable_files','INSERT','1'],
  ['payment','billing_payments','INSERT','1'],
  ['audit','provisioning_log','INSERT',"NEW.action='billing'"],
  ['invoice','billing_invoices','UPDATE',"NEW.status='payment_submitted'"],
  ['intent','platform_business_outbox','INSERT','1'],
])('rolls payment/proof/invoice/audit/intent back on %s failure and permits one complete retry',async(_phase,table,operation,condition)=>{
  const invoice=issue(),d=platform.platformDb(),beforeBlobs=count('platform_durable_files');
  const beforeLogs=platform.listProvisioningLog(slug);
  d.exec(`CREATE TRIGGER payment_phase_failure BEFORE ${operation} ON ${table} WHEN ${condition} BEGIN SELECT RAISE(ABORT,'synthetic-private-payment-failure'); END`);
  try {
    const result=await report(invoice.id);expect(result.status).toBe(500);expect(result.body.error).toBe('Internal server error');expect(result.body.request_id).toBe(result.headers['x-request-id']);
    expect(billing.invoiceView(billing.getInvoice(invoice.id)!).payments).toEqual([]);expect(billing.getInvoice(invoice.id)!.status).toBe('open');
    expect(count('platform_durable_files')).toBe(beforeBlobs);expect(queue.ownerAlertStatus()).toEqual([]);expect(platform.listProvisioningLog(slug)).toEqual(beforeLogs);
    expect(fs.existsSync(billing.billingFilesDir(slug))).toBe(false);expect(mail._testOutbox).toHaveLength(0);
  }finally{d.exec('DROP TRIGGER payment_phase_failure');}
  const retried=await report(invoice.id);expect(retried.status).toBe(201);expect(retried.body.payments).toHaveLength(1);expect(queue.ownerAlertStatus()).toHaveLength(1);
});
it('does not keep an orphan proof when the second upload is invalid',async()=>{
  const invoice=issue(),before=count('platform_durable_files');expect((await report(invoice.id,true)).status).toBe(400);
  expect(count('platform_durable_files')).toBe(before);expect(billing.getInvoice(invoice.id)!.status).toBe('open');expect(queue.ownerAlertStatus()).toEqual([]);
});
it('commits proof bytes before notification and recreates a private download cache from them',async()=>{
  const invoice=issue();const result=await report(invoice.id);expect(result.status).toBe(201);expect(mail._testOutbox).toHaveLength(0);
  const payment=billing.getPayment(result.body.payments[0].id)!;
  expect(fs.existsSync(path.join(billing.billingFilesDir(slug),payment.proof_file!))).toBe(false);
  const row=platform.platformDb().prepare('SELECT data FROM platform_durable_files WHERE slug=? AND name=?').get(slug,payment.proof_file!)!;
  expect(Buffer.from(row.data as Uint8Array)).toEqual(png);
  const download=await ctx.api.get(`/${slug}/api/tenant/billing/payments/${payment.id}/files/proof`).set(auth());expect(download.status).toBe(200);expect(download.body).toEqual(png);
  if(process.platform!=='win32')expect(fs.statSync(billing.resolveBillingFile(slug,payment.proof_file!)!).mode&0o777).toBe(0o600);
  fs.unlinkSync(billing.resolveBillingFile(slug,payment.proof_file!)!);
  expect(fs.readFileSync(billing.resolveBillingFile(slug,payment.proof_file!)!)).toEqual(png);
  await queue.processOneOwnerAlert();expect(queue.ownerAlertStatus()[0]).toMatchObject({kind:'payment',source_id:payment.id,state:'accepted'});
  expect(mail._testOutbox[0]!.subject).toContain(invoice.reference);expect(mail._testOutbox[0]!.text).toContain('Amount: ₱100.00');expect(mail.platformMailLog()[0]).toMatchObject({kind:'payment'});
});
it('gives two same-millisecond submissions different immutable proof names',async()=>{
  const invoice=issue();const clock=vi.spyOn(Date,'now').mockReturnValue(Date.now());
  try {expect((await report(invoice.id)).status).toBe(201);expect((await report(invoice.id)).status).toBe(201);}
  finally{clock.mockRestore();}
  const payments=billing.invoiceView(billing.getInvoice(invoice.id)!).payments;
  expect(payments).toHaveLength(2);expect(billing.getPayment(payments[0]!.id)!.proof_file).not.toBe(billing.getPayment(payments[1]!.id)!.proof_file);
  // These are two distinct reports, not an HTTP idempotency guarantee.
  expect(queue.ownerAlertStatus()).toHaveLength(2);
});
it('rejects unauthorized/wrong-company reports without a durable blob or event',async()=>{
  const invoice=issue(),before=count('platform_durable_files');
  expect((await ctx.api.post(`/${slug}/api/tenant/billing/invoices/${invoice.id}/payments`).set('Host',host)).status).toBe(401);
  const other=billing.createInvoice('alert-other',{kind:'other',description:'Synthetic other invoice',amount_centavos:10000,due_on:'2099-01-01'},'fixture');
  expect((await report(other.id)).status).toBe(404);expect(count('platform_durable_files')).toBe(before);expect(queue.ownerAlertStatus()).toEqual([]);
});
it('cancels reviewed payment alerts and cannot cross a source workspace',async()=>{
  const invoice=issue(),r=await report(invoice.id);const payment=billing.getPayment(r.body.payments[0].id)!;
  billing.rejectPayment(payment.id,'fixture','Synthetic reviewed transfer');await queue.processOneOwnerAlert();expect(queue.ownerAlertStatus()[0]!.state).toBe('cancelled');
  const second=await report(issue().id);const pending=second.body.payments[0].id;
  platform.platformDb().exec('DELETE FROM platform_owner_outbox; DELETE FROM platform_business_outbox');queue.enqueueOwnerAlert('payment',pending,'alert-other','Synthetic wrong scope',['Synthetic']);
  await queue.processOneOwnerAlert();expect(queue.ownerAlertStatus()[0]!.state).toBe('cancelled');expect(mail._testOutbox).toHaveLength(0);
});
it('queues no payment alert when that category is disabled',async()=>{
  mail.savePlatformMail({alert_payment:false});expect((await report(issue().id)).status).toBe(201);expect(queue.ownerAlertStatus()).toEqual([]);
});

it.each([['inquiry','before'],['payment','before'],['inquiry','after'],['payment','after']])('recovers a real process exit for %s %s commit',(kind,phase)=>{
  const root=path.join(ctx.tmpDir,'business-crash-'+kind+'-'+phase);fs.mkdirSync(root);
  const env={PATH:process.env.PATH,NODE_ENV:'test',DEPLOY_MODE:'cloud',ADMIN_PASSWORD:password,DB_PATH:path.join(root,'default.db'),DATA_DIR:path.join(root,'tenants'),PLATFORM_DB_PATH:path.join(root,'platform.db'),UPLOAD_DIR:path.join(root,'uploads'),BACKUP_DIR:path.join(root,'backups')};
  const imports=`import {platformDb} from './src/platform/platform.ts';import {createInquiry,listInquiries} from './src/platform/inquiries.ts';
    import {createInvoice,submitPayment,listPayments,billingFilesDir} from './src/platform/billing.ts';import {createTenant} from './src/platform/provisioning.ts';
    import {savePlatformMail,_testOutbox} from './src/platform/platform-mail.ts';import {prepareOwnerAlerts,enqueueOwnerAlert,processOneOwnerAlert,ownerAlertStatus} from './src/platform/owner-alert-outbox.ts';`;
  const setup=`savePlatformMail({transport:'brevo',from_email:'alerts@example.test',alert_to:'owner@example.test'},'synthetic');prepareOwnerAlerts();
    createTenant({slug:'crash-pay',name:'Synthetic crash',admin_username:'owner',admin_password:'${password}',is_sandbox:true});
    const invoice=createInvoice('crash-pay',{kind:'other',description:'Synthetic',amount_centavos:10000,due_on:'2099-01-01'},'fixture');`;
  const action=kind==='inquiry'?`createInquiry({name:'Synthetic',company:'Synthetic',email:'contact@example.test'},row=>enqueueOwnerAlert('inquiry',row.id,'','Synthetic',['Synthetic']));`:
    `submitPayment('crash-pay',invoice.id,{channel:'bank',reference_no:'Synthetic',amount_centavos:10000,paid_on:new Date().toISOString().slice(0,10),proof:{buffer:Buffer.from('synthetic'),mimetype:'image/png',originalname:'proof.png'}},'fixture',row=>enqueueOwnerAlert('payment',row.id,'crash-pay','Synthetic',['Synthetic']));`;
  const first=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',imports+setup+`
    platformDb().function('exit_intent',()=>process.exit(73));if(${JSON.stringify(phase)}==='before')platformDb().exec("CREATE TRIGGER exit_business AFTER INSERT ON platform_business_outbox BEGIN SELECT exit_intent(); END");`+action+'process.exit(73);'],{cwd:process.cwd(),env,encoding:'utf8',timeout:20000});
  expect(first.status,first.stderr).toBe(73);
  const second=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',imports+`
    if(${JSON.stringify(phase)}==='before') {
      if(listInquiries().length||listPayments(1).length||ownerAlertStatus().length||platformDb().prepare('SELECT COUNT(*) AS n FROM platform_durable_files').get().n!==0)process.exit(74);
      if(await processOneOwnerAlert())process.exit(75);
    } else {
      if(ownerAlertStatus().length!==1||ownerAlertStatus()[0].kind!==${JSON.stringify(kind)})process.exit(76);
      if(${JSON.stringify(kind)}==='payment'&&platformDb().prepare('SELECT COUNT(*) AS n FROM platform_durable_files').get().n!==1)process.exit(77);
      await processOneOwnerAlert();
      if(ownerAlertStatus()[0].state!=='accepted'||_testOutbox.length!==1)process.exit(78);
    }
    process.exit(0);`],{cwd:process.cwd(),env,encoding:'utf8',timeout:20000});
  expect(second.status,second.stderr).toBe(0);
});

it('legacy signup-worker selection cannot claim new inquiry/payment events',async()=>{
  await ask();await report(issue().id);
  expect(platform.platformDb().prepare("SELECT * FROM platform_owner_outbox WHERE state IN ('pending','retry') AND next_attempt_at<=?").all(Date.now())).toEqual([]);
  expect(count('platform_business_outbox')).toBe(2);
  await queue.processOneOwnerAlert();await queue.processOneOwnerAlert();
  expect(mail._testOutbox).toHaveLength(2);expect(queue.ownerAlertStatus().every(row=>row.state==='accepted')).toBe(true);
});
it('keeps uncertain business acknowledgement inflight, then unknown, without resending',async()=>{
  await ask();const d=platform.platformDb();d.exec("CREATE TRIGGER business_ack_failure BEFORE INSERT ON platform_mail_log BEGIN SELECT RAISE(ABORT,'synthetic acknowledgement failure'); END");
  try{await expect(queue.processOneOwnerAlert()).rejects.toThrow('synthetic acknowledgement');}finally{d.exec('DROP TRIGGER business_ack_failure');}
  expect(mail._testOutbox).toHaveLength(1);expect(queue.ownerAlertStatus()[0]!.state).toBe('inflight');
  d.prepare('UPDATE platform_business_outbox SET claimed_at=?').run(Date.now()-120001);
  await queue.processOneOwnerAlert();expect(queue.ownerAlertStatus()[0]!.state).toBe('unknown');expect(mail._testOutbox).toHaveLength(1);
});
