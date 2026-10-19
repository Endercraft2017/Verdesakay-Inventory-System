import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { setupApp, cleanup, type TestContext } from './helpers';
let ctx: TestContext, token: string, otherToken: string;
let platform: typeof import('../src/platform/platform'), billing: typeof import('../src/platform/billing'), receipts: typeof import('../src/platform/payment-report-receipts');
const slug='report-receipts', password='Synthetic payment retry password', proof=Buffer.from('synthetic receipt bytes');
const date=new Date().toISOString().slice(0,10);
const input=()=>({channel:'bank',reference_no:'Synthetic private reference',amount_centavos:10000,paid_on:date,note:'Synthetic private note',proof:{buffer:proof,mimetype:'image/png',originalname:'receipt.png'}});
const issue=()=>billing.createInvoice(slug,{kind:'other',description:'Synthetic retry invoice',amount_centavos:10000,due_on:'2099-01-01'},'fixture');
function report(id:number,key?:string,patch:Record<string,string>={},bytes=proof,actor=token,mime='image/png',filename='receipt.png') {
  const request=ctx.api.post('/api/tenant/billing/invoices/'+id+'/payments').set({'X-Tenant':slug,Authorization:'Bearer '+actor});
  if(key!==undefined)request.set('Idempotency-Key',key);
  for(const [k,v] of Object.entries({channel:'bank',reference_no:'Synthetic private reference',amount:'100',paid_on:date,note:'Synthetic private note',...patch}))request.field(k,v);
  return request.attach('proof',bytes,{filename,contentType:mime});
}
const count=(table:string)=>Number(platform.platformDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);
beforeAll(async()=>{
  ctx=await setupApp();platform=await import('../src/platform/platform');billing=await import('../src/platform/billing');receipts=await import('../src/platform/payment-report-receipts');
  (await import('../src/platform/provisioning')).createTenant({slug,name:'Synthetic report retries',admin_username:'owner',admin_password:password,is_sandbox:true});
  const db=await import('../src/shared/db');const hash=(await import('../src/shared/password-hash')).hashPassword;
  db.withTenant(slug,()=>db.run("INSERT INTO users(username,full_name,role,password_hash) VALUES('second-owner','Synthetic second owner','admin',?)",hash(password)));
  token=(await ctx.api.post('/api/auth/login').set('X-Tenant',slug).send({username:'owner',password})).body.token;
  otherToken=(await ctx.api.post('/api/auth/login').set('X-Tenant',slug).send({username:'second-owner',password})).body.token;
  expect(token).toBeTruthy();expect(otherToken).toBeTruthy();
  (await import('../src/platform/platform-mail')).savePlatformMail({transport:'brevo',from_email:'alerts@example.test',alert_to:'owner@example.test'},'synthetic-retry-key');
});
afterAll(()=>cleanup(ctx));
it('replays the original 201 after catalog reopen without a second report/proof/audit/intent',async()=>{
  const invoice=issue(),key=randomUUID();const first=await report(invoice.id,key);expect(first.status).toBe(201);
  const before={payments:count('billing_payments'),blobs:count('platform_durable_files'),events:count('platform_business_outbox'),audits:count('provisioning_log')};
  platform._resetPlatformDb();const replay=await report(invoice.id,key.toUpperCase(),{amount:'100.00',reference_no:' Synthetic private reference '},proof,token,'image/png','renamed.png');
  expect(replay.status).toBe(201);expect(replay.headers['idempotency-replayed']).toBe('true');expect(replay.headers['cache-control']).toBe('no-store');expect(replay.body).toEqual(first.body);
  expect({payments:count('billing_payments'),blobs:count('platform_durable_files'),events:count('platform_business_outbox'),audits:count('provisioning_log')}).toEqual(before);
  const row=platform.platformDb().prepare('SELECT * FROM platform_payment_report_receipts WHERE payment_id=?').get(first.body.payments[0].id)!;
  expect(row.verifier).toMatch(/^scrypt\$v1\$/);expect(JSON.stringify(row)).not.toContain(key);expect(JSON.stringify(row)).not.toContain('synthetic receipt bytes');
});
it.each(['reference_no','amount','paid_on','note','channel','proof','mime','invoice','2307'])('conflicts when the same key changes %s',async field=>{
  const invoice=issue(),key=randomUUID();expect((await report(invoice.id,key)).status).toBe(201);
  const patch:Record<string,string>={};if(field==='reference_no')patch.reference_no='Different';if(field==='amount')patch.amount='99';if(field==='paid_on')patch.paid_on='2020-01-01';if(field==='note')patch.note='Different';if(field==='channel')patch.channel='gcash';
  const id=field==='invoice'?issue().id:invoice.id;
  let retry=report(id,key,patch,field==='proof'?Buffer.from('different'):proof,token,field==='mime'?'application/pdf':'image/png');
  if(field==='2307')retry=retry.attach('form_2307',proof,{filename:'tax.pdf',contentType:'application/pdf'});
  expect((await retry).status).toBe(409);expect(billing.invoiceView(billing.getInvoice(invoice.id)!).payments).toHaveLength(1);
});
it('enforces current authentication and permission before receipt replay',async()=>{
  const invoice=issue(),key=randomUUID();expect((await report(invoice.id,key)).status).toBe(201);
  expect((await ctx.api.post('/api/tenant/billing/invoices/'+invoice.id+'/payments').set('X-Tenant',slug).set('Idempotency-Key',key)).status).toBe(401);
  const db=await import('../src/shared/db');
  db.withTenant(slug,()=>db.run("UPDATE users SET role='warehouse' WHERE username='owner'"));
  try{expect((await report(invoice.id,key)).status).toBe(403);}finally{db.withTenant(slug,()=>db.run("UPDATE users SET role='admin' WHERE username='owner'"));}
});
it('uses parsed receipts on Express case-insensitive and trailing-slash route aliases',async()=>{
  const invoice=issue(),key=randomUUID();
  const send=(bytes:Buffer)=>ctx.api.post('/api/Tenant/Billing/Invoices/'+invoice.id+'/Payments/').set({'X-Tenant':slug,Authorization:'Bearer '+token,'Idempotency-Key':key})
    .field('reference_no','Synthetic alias reference').field('amount','100').field('paid_on',date).attach('proof',bytes,{filename:'proof.png',contentType:'image/png'});
  expect((await send(proof)).status).toBe(201);expect((await send(Buffer.from('changed alias proof'))).status).toBe(409);
  const replay=await send(proof);expect(replay.status).toBe(201);expect(replay.headers['idempotency-replayed']).toBe('true');
  expect(billing.invoiceView(billing.getInvoice(invoice.id)!).payments).toHaveLength(1);
});
it('keeps administrators separate instead of disclosing another actors receipt',async()=>{
  const invoice=issue(),key=randomUUID();const first=await report(invoice.id,key);expect(first.status).toBe(201);
  const other=await report(invoice.id,key,{},proof,otherToken);expect(other.status).toBe(201);expect(other.headers['idempotency-replayed']).toBeUndefined();expect(other.body.payments).toHaveLength(2);
});
it.each(['','predictable','11111111-1111-1111-1111-111111111111'])('refuses malformed key %j without a payment',async key=>{
  const invoice=issue();expect((await report(invoice.id,key)).status).toBe(400);expect(billing.invoiceView(invoice).payments).toHaveLength(0);
});
it('refuses old generic multipart cache entries instead of replaying or reapplying them',async()=>{
  const {createHash}=await import('node:crypto');const db=await import('../src/shared/db');
  const invoice=issue(),key=randomUUID(),scoped='v2:'+createHash('sha256').update(JSON.stringify([1,key])).digest('hex');
  db.withTenant(slug,()=>db.run('INSERT INTO idempotency_keys(key,user_id,method,path,status_code,response) VALUES(?,1,?,?,201,?)',scoped,'POST','legacy-unbound-multipart','{"private":"old response"}'));
  const refused=await report(invoice.id,key);expect(refused.status).toBe(409);expect(refused.body.error).toContain('predates');expect(refused.body.private).toBeUndefined();expect(billing.invoiceView(invoice).payments).toHaveLength(0);
});
it('does not store validation failures and permits corrected same-key retry',async()=>{
  const invoice=issue(),key=randomUUID();expect((await report(invoice.id,key,{amount:'0'})).status).toBe(400);
  expect((await report(invoice.id,key)).status).toBe(201);expect((await report(invoice.id,key)).headers['idempotency-replayed']).toBe('true');
});
it('scopes identical keys to their current tenant',async()=>{
  const other='report-other';(await import('../src/platform/provisioning')).createTenant({slug:other,name:'Synthetic other',admin_username:'owner',admin_password:password,is_sandbox:true});
  const key=randomUUID(),invoice=issue();expect((await report(invoice.id,key)).status).toBe(201);
  const login=await ctx.api.post('/api/auth/login').set('X-Tenant',other).send({username:'owner',password});
  const target=billing.createInvoice(other,{kind:'other',description:'Synthetic other',amount_centavos:10000,due_on:'2099-01-01'},'fixture');
  const request=ctx.api.post('/api/tenant/billing/invoices/'+target.id+'/payments').set({'X-Tenant':other,Authorization:'Bearer '+login.body.token,'Idempotency-Key':key})
    .field('channel','bank').field('reference_no','Other private reference').field('amount','100').field('paid_on',date).attach('proof',proof,{filename:'proof.png',contentType:'image/png'});
  const result=await request;expect(result.status).toBe(201);expect(result.headers['idempotency-replayed']).toBeUndefined();expect(result.body.tenant_slug).toBe(other);
});
it('keeps legacy no-key behavior explicit',async()=>{
  const invoice=issue();expect((await report(invoice.id)).status).toBe(201);expect((await report(invoice.id)).status).toBe(201);
  expect(billing.invoiceView(billing.getInvoice(invoice.id)!).payments).toHaveLength(2);
});
it('rolls payment/proof/audit/invoice/intent back on receipt storage failure and permits retry',async()=>{
  const invoice=issue(),key=randomUUID(),d=platform.platformDb();const before={payments:count('billing_payments'),blobs:count('platform_durable_files'),events:count('platform_business_outbox'),audits:count('provisioning_log')};
  d.exec("CREATE TRIGGER report_receipt_failure BEFORE INSERT ON platform_payment_report_receipts BEGIN SELECT RAISE(ABORT,'synthetic private receipt failure'); END");
  try{const failed=await report(invoice.id,key);expect(failed.status).toBe(500);expect(failed.body).toEqual({error:'Internal server error',request_id:failed.headers['x-request-id']});}finally{d.exec('DROP TRIGGER report_receipt_failure');}
  expect(billing.getInvoice(invoice.id)!.status).toBe('open');expect({payments:count('billing_payments'),blobs:count('platform_durable_files'),events:count('platform_business_outbox'),audits:count('provisioning_log')}).toEqual(before);
  expect((await report(invoice.id,key)).status).toBe(201);expect((await report(invoice.id,key)).headers['idempotency-replayed']).toBe('true');
});
it('a stale competing candidate rolls its source writes back instead of duplicating',async()=>{
  const invoice=issue(),key=randomUUID();const candidate=receipts.preparePaymentReportReceipt(slug,1,key,invoice.id,input());
  expect((await report(invoice.id,key)).status).toBe(201);
  expect(()=>billing.submitPayment(slug,invoice.id,input(),'fixture',payment=>receipts.savePaymentReportReceipt(candidate,payment.id,{}))).toThrow('Another request completed');
  expect(billing.invoiceView(billing.getInvoice(invoice.id)!).payments).toHaveLength(1);
});
it('replays after review without recording another payment but current GET shows the reviewed state',async()=>{
  const invoice=issue(),key=randomUUID(),first=await report(invoice.id,key);expect(first.status).toBe(201);
  billing.confirmPayment(first.body.payments[0].id,'fixture');
  const replay=await report(invoice.id,key);expect(replay.status).toBe(201);expect(replay.body).toEqual(first.body);
  const current=await ctx.api.get('/api/tenant/billing').set({'X-Tenant':slug,Authorization:'Bearer '+token});expect(current.body.invoices.find((i:{id:number})=>i.id===invoice.id).status).toBe('paid');
});
it('expires sensitive receipt payload but keeps a tombstone that cannot reapply',async()=>{
  const invoice=issue(),key=randomUUID(),first=await report(invoice.id,key);expect(first.status).toBe(201);
  platform.platformDb().prepare('UPDATE platform_payment_report_receipts SET expires_at=0 WHERE payment_id=?').run(first.body.payments[0].id);
  receipts.prunePaymentReportReceipts();const row=platform.platformDb().prepare('SELECT verifier,response FROM platform_payment_report_receipts WHERE payment_id=?').get(first.body.payments[0].id);
  expect(row).toEqual({verifier:null,response:null});expect((await report(invoice.id,key)).status).toBe(409);expect(billing.invoiceView(billing.getInvoice(invoice.id)!).payments).toHaveLength(1);
});
it('refuses replay if original source ownership changes',async()=>{
  const invoice=issue(),key=randomUUID();expect((await report(invoice.id,key)).status).toBe(201);
  platform.platformDb().prepare("UPDATE billing_invoices SET tenant_slug='different' WHERE id=?").run(invoice.id);
  expect((await report(invoice.id,key)).status).toBe(409);
});
it.each(['before','after'])('handles real process exit %s receipt commit',phase=>{
  const root=path.join(ctx.tmpDir,'report-exit-'+phase);fs.mkdirSync(root);const key=randomUUID();
  const env={PATH:process.env.PATH,NODE_ENV:'test',DEPLOY_MODE:'cloud',ADMIN_PASSWORD:password,DB_PATH:path.join(root,'default.db'),DATA_DIR:path.join(root,'tenants'),PLATFORM_DB_PATH:path.join(root,'platform.db'),UPLOAD_DIR:path.join(root,'uploads'),BACKUP_DIR:path.join(root,'backups')};
  const imports=`import {platformDb} from './src/platform/platform.ts';import {createTenant} from './src/platform/provisioning.ts';import {createInvoice,submitPayment,invoiceView,getInvoice} from './src/platform/billing.ts';import {preparePaymentReportReceipt,savePaymentReportReceipt} from './src/platform/payment-report-receipts.ts';const input=${JSON.stringify({...input(),proof:null})};input.proof={buffer:Buffer.from('synthetic receipt bytes'),mimetype:'image/png',originalname:'receipt.png'};`;
  const first=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',imports+`createTenant({slug:'crash-report',name:'Synthetic',admin_username:'owner',admin_password:'${password}',is_sandbox:true});createInvoice('crash-report',{kind:'other',description:'Synthetic',amount_centavos:10000,due_on:'2099-01-01'},'fixture');const receipt=preparePaymentReportReceipt('crash-report',1,'${key}',1,input);platformDb().function('exit_receipt',()=>process.exit(73));if('${phase}'==='before')platformDb().exec("CREATE TRIGGER exit_report AFTER INSERT ON platform_payment_report_receipts BEGIN SELECT exit_receipt(); END");submitPayment('crash-report',1,input,'fixture',payment=>savePaymentReportReceipt(receipt,payment.id,invoiceView(getInvoice(1))));process.exit(73);`],{cwd:process.cwd(),env,encoding:'utf8',timeout:20000});expect(first.status,first.stderr).toBe(73);
  const second=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',imports+`const receipt=preparePaymentReportReceipt('crash-report',1,'${key}',1,input);if('${phase}'==='after'){if(!receipt.replay||invoiceView(getInvoice(1)).payments.length!==1)process.exit(74);}else{platformDb().exec('DROP TRIGGER exit_report');if(receipt.replay||invoiceView(getInvoice(1)).payments.length||platformDb().prepare('SELECT COUNT(*) AS n FROM platform_durable_files').get().n)process.exit(75);submitPayment('crash-report',1,input,'fixture',payment=>savePaymentReportReceipt(receipt,payment.id,invoiceView(getInvoice(1))));}process.exit(0);`],{cwd:process.cwd(),env,encoding:'utf8',timeout:20000});expect(second.status,second.stderr).toBe(0);
});
