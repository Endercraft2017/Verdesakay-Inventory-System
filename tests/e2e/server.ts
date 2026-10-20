// Browser tests must never read development or production data.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import {manualUsername,manualPassword,manualToken} from './manual-export-fixture';
import { stepUpUsername, stepUpPassword, stepUpSessionToken, stepUpRecoveryCode } from './step-up-fixture';
import { recoveryUsername, recoveryFixtureToken, cancellationId, cancellationNonce } from './recovery-fixture';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-playwright-'));
Object.assign(process.env, {
  VDS_TEST_ADMIN_PASSWORD: 'admin123-test-only', NODE_ENV: 'test', TZ: 'Asia/Manila',
  DB_PATH: path.join(dir, 'app.db'), DATA_DIR: path.join(dir, 'data'),
  PLATFORM_DB_PATH: path.join(dir, 'platform.db'), UPLOAD_DIR: path.join(dir, 'uploads'),
  BACKUP_DIR: path.join(dir, 'backups'),
});
for (const key of ['APP_DOMAIN', 'TENANT_PATH_HOST', 'DEFAULT_TENANT_REDIRECT', 'PLATFORM_CONSOLE', 'ADMIN_PASSWORD', 'DEPLOY_MODE']) delete process.env[key];
process.env.PLATFORM_CONSOLE = 'true';
process.env.TENANT_PATH_HOST = 'localhost';
process.env.SIGNUPS_OPEN = 'true';
process.env.PLATFORM_WEBAUTHN_ORIGIN = 'http://localhost:4173';
const { upsertPlatformUser } = await import('../../src/platform/platform-users');
upsertPlatformUser('browser-operator', 'Synthetic browser operator password', 'Browser Operator');
const db = await import('../../src/shared/db');
db.init();
const { hashPassword } = await import('../../src/shared/password-hash');
const disclosureUsers = ['original', 'reused'].map(kind => Number(db.run("INSERT INTO users(username,full_name,role,password_hash) VALUES(?,?,'csr',?)",'payslip-'+kind,'Synthetic payslip '+kind,hashPassword('payslip-browser-test-only')).lastInsertRowid));
const disclosureEmployees = ['Synthetic Payroll New', 'Synthetic Payroll Old'].map((name,i) => Number(db.run('INSERT INTO employees(employee_no,name,user_id) VALUES(?,?,?)','DISC-BROWSER-'+i,name,disclosureUsers[i]).lastInsertRowid));
db.run("INSERT INTO employee_profile_changes(employee_id,field,old_value,new_value,source) VALUES(?,'name','Synthetic Payroll Old','Synthetic Payroll New','hr_edit')",disclosureEmployees[0]);
const disclosureForm = db.queryOne<{id:number}>("SELECT id FROM form_definitions WHERE slug='hr_payroll'")!;
for (const [number,data] of [['DISC-BROWSER-LEGACY',{employee_name:'Synthetic Payroll Old'}],['DISC-BROWSER-STAMP',{employee_name:'Synthetic Payroll Old',employee_id:disclosureEmployees[0]}],['DISC-BROWSER-TEXT',{employee_name:'Synthetic Payroll Old',employee_id:String(disclosureEmployees[0])}]] as const) db.run("INSERT INTO form_records(form_def_id,number,data,status,created_by) VALUES(?,?,?,'paid',1)",disclosureForm.id,number,JSON.stringify({...data,net_pay:7654}));
// Synthetic accounting-only identity: verify tax printing without general HR/pay access.
db.run("INSERT INTO users(username,full_name,role,password_hash) VALUES('tax-privacy-accountant','Synthetic Tax Accountant','accounting',?)",hashPassword('tax-privacy-browser-test-only'));
db.run("INSERT INTO employees(employee_no,name,position,tin_no,birth_date,daily_rate,photo) VALUES('TAX-PRIVACY-BROWSER','Synthetic Browser Tax Employee','Clerk','SYNTHETIC-TAX-TIN','1991-03-07',1234,'private-browser-photo.jpg')");
const { credentialStamp } = await import('../../src/shared/account-recovery');
const { encryptSecret } = await import('../../src/shared/secrets');
const { newTotpSecret } = await import('../../src/shared/totp');
const stepUpUser=Number(db.run("INSERT INTO users(username,full_name,role,password_hash) VALUES(?,?,'admin',?)",stepUpUsername,'Browser verification owner',hashPassword(stepUpPassword)).lastInsertRowid);
db.run("INSERT INTO sessions(token,sid,user_id,expires_at) VALUES(?,?,?,datetime('now','+1 hour'))",db.tokenDigest(stepUpSessionToken),randomUUID(),stepUpUser);
db.run("INSERT INTO user_mfa(user_id,secret,enabled_at) VALUES(?,?,datetime('now'))",stepUpUser,encryptSecret(newTotpSecret()));
db.run('INSERT INTO user_mfa_recovery(user_id,code_hash) VALUES(?,?)',stepUpUser,createHash('sha256').update(stepUpRecoveryCode).digest('hex'));
const { markFreshVerification } = await import('../../src/shared/step-up');
markFreshVerification(stepUpUser,stepUpSessionToken);
db.run("UPDATE session_stepups SET verified_at=datetime('now','-6 minutes') WHERE token_hash=?",db.tokenDigest(stepUpSessionToken));

const manualUser=Number(db.run("INSERT INTO users(username,full_name,password_hash,role) VALUES(?,?,?,'admin')",manualUsername,'Synthetic manual export operator',hashPassword(manualPassword)).lastInsertRowid);
db.run("INSERT INTO sessions(token,sid,user_id,expires_at) VALUES(?,?,?,datetime('now','+1 hour'))",db.tokenDigest(manualToken),randomUUID(),manualUser);
markFreshVerification(manualUser,manualToken);
db.run("UPDATE session_stepups SET verified_at=datetime('now','-6 minutes') WHERE token_hash=?",db.tokenDigest(manualToken));
const manualOrder=Number(db.run("INSERT INTO orders(number,type,customer_name,total) VALUES('MANUAL-E2E-GUARDED','sale','Synthetic manual customer',100)").lastInsertRowid);
const manualParent=Number(db.run("INSERT INTO order_items(order_id,name,quantity,unit_price,line_total,fulfillment_mode) VALUES(?,'Synthetic CKD commercial parent',1,100,100,'ckd')",manualOrder).lastInsertRowid);
db.run("INSERT INTO order_items(order_id,name,quantity,unit_price,line_total,fulfillment_mode,parent_order_item_id) VALUES(?,'Synthetic CKD component',1,100,100,'ckd_component',?)",manualOrder,manualParent);

const oldHash = hashPassword(randomUUID());
const recovered = db.run("INSERT INTO users(username,full_name,password_hash,role,email) VALUES(?,?,?,'warehouse','browser-recovery@example.test')", recoveryUsername, 'Browser recovery', oldHash);
const recoveredId = Number(recovered.lastInsertRowid);
const digest = createHash('sha256').update(recoveryFixtureToken).digest('hex');
db.run("INSERT INTO password_resets(token_hash,user_id,expires_at) VALUES(?,?,datetime('now','+15 minutes'))", digest, recoveredId);
db.run("INSERT INTO account_recoveries(token_hash,user_id,requested_by,approved_by,reason,verification_reference,contact_email,credential_hash) VALUES(?,?,'platform:1','platform:2','Synthetic independently approved browser recovery','E2E-RECOVERY','browser-recovery@example.test',?)", digest, recoveredId, credentialStamp(oldHash));
// Only the public cancellation boundary is exercised here; API tests create real approval cases.
const { platformDb } = await import('../../src/platform/platform');
platformDb().exec('CREATE TABLE platform_recovery_approvals(id TEXT PRIMARY KEY,cancel_hash TEXT,slug TEXT,state TEXT,expires_at TEXT)');
platformDb().prepare("INSERT INTO platform_recovery_approvals VALUES(?,?,'default','pending',datetime('now','+48 hours'))").run(cancellationId, credentialStamp(cancellationNonce));
// A synthetic interrupted/unknown export for the actual administrator status screen.
const exportOrder=Number(db.run("INSERT INTO orders(number,type,customer_name,total) VALUES('AUTO-E2E-ATTENTION','sale','Synthetic export customer',10)").lastInsertRowid);
db.run("INSERT INTO qbo_export_jobs(connection_id,company_key,order_id,state,error_code) VALUES(?, 'sandbox:111',?,'blocked','outcome_unknown')",randomUUID(),exportOrder);
const qbo=await import('../../src/modules/quickbooks/quickbooks');
await qbo.completeConnect('synthetic-browser-code','111');qbo.setAutoPush(true);
const safeRetryOrder=Number(db.run("INSERT INTO orders(number,type,customer_name,total) VALUES('AUTO-E2E-SAFE-RETRY','sale','Synthetic retry customer',10)").lastInsertRowid);
db.run("INSERT INTO qbo_export_jobs(connection_id,company_key,order_id,state,error_code) VALUES(?, 'sandbox:111',?,'blocked','retry_limit')",qbo.qboExportScope()!.connection_id,safeRetryOrder);
// Isolated support workspace and a real, narrowly scoped SQLite failure for browser checks.
const { createTenant } = await import('../../src/platform/provisioning');
createTenant({ slug: 'browser-support', name: 'Browser support fixture', plan: 'complete', admin_username: 'owner', admin_password: 'Synthetic support browser password' });
const { listSupport } = await import('../../src/platform/owner-analytics');
listSupport('browser-support');
platformDb().exec(`CREATE TRIGGER browser_support_failure BEFORE INSERT ON tenant_support
  WHEN NEW.slug='browser-support' AND NEW.subject='Browser failure injection'
  BEGIN SELECT RAISE(ABORT, 'synthetic-browser-private-storage-detail'); END`);
platformDb().exec(`CREATE TRIGGER browser_settings_failure BEFORE UPDATE ON tenants
  WHEN NEW.slug='browser-support' AND NEW.name='Browser settings failure'
  BEGIN SELECT RAISE(ABORT, 'module synthetic-private-settings-detail'); END`);
const billing = await import('../../src/platform/billing');
createTenant({slug:'browser-payment',name:'Synthetic payment retry',plan:'complete',admin_username:'owner',admin_password:'Synthetic payment browser password'});
billing.createInvoice('browser-payment',{kind:'other',description:'Browser lost-response invoice',amount_centavos:10000,due_on:'2099-01-01'},'fixture');
billing.createInvoice('browser-payment',{kind:'other',description:'Browser validation invoice',amount_centavos:10000,due_on:'2099-01-01'},'fixture');
const { MODULES } = await import('../../src/shared/modules');
billing.setBillingSettings({ module_prices: Object.fromEntries(MODULES.map(module => [module, 100])), seat_price: 20 });
let failSignupOnce = true;
platformDb().function('browser_signup_fault', () => {
  if (failSignupOnce) { failSignupOnce = false; throw new Error('Synthetic signup invoice failure'); }
  return 0;
});
platformDb().exec(`CREATE TRIGGER browser_signup_failure BEFORE INSERT ON billing_invoices
  WHEN NEW.tenant_slug='browser-atomic-failed' BEGIN SELECT browser_signup_fault(); END`);
// Synthetic unresolved alert: status UI must never offer a blind resend.
platformDb().prepare(`INSERT INTO platform_owner_outbox
  (id,event_key,tenant_slug,recipients,subject,body,configuration_stamp,state,attempts,next_attempt_at,error_code,created_at,updated_at)
  VALUES('browser-unknown-alert','signup:browser-support','browser-support','["owner@example.test"]',
    'Synthetic private subject','Synthetic private message','synthetic','unknown',1,0,'interrupted_send',?,?)`).run(Date.now(),Date.now());
// More than one page: old failures must remain discoverable beyond latest thirty.
const monitorNow=Date.now();
const monitorSeed=platformDb().prepare(`INSERT INTO platform_owner_outbox
(id,event_key,tenant_slug,state,attempts,next_attempt_at,created_at,updated_at)
VALUES(?,?,?, ?,1,0,?,?)`);
for(let i=1;i<=65;i++) monitorSeed.run('monitor-'+i,'signup:monitor-'+i,'browser-history-'+i,'accepted',monitorNow-i*1000,monitorNow-i*1000);
monitorSeed.run('browser-old-alert','signup:browser-old-failure','browser-old-failure','blocked',monitorNow-86400000,monitorNow-86400000);
(await import('../../src/platform/platform-mail')).savePlatformMail({transport:'brevo',from_email:'alerts@example.test',alert_to:'owner@example.test'},'synthetic-browser-business-key');
platformDb().exec(`CREATE TRIGGER browser_inquiry_alert_failure BEFORE INSERT ON platform_business_outbox
  WHEN NEW.subject='New inquiry: Browser inquiry failure'
  BEGIN SELECT RAISE(ABORT,'synthetic-private-inquiry-enqueue-detail'); END`);
const { createApp } = await import('../../src/app');
const { attachWebSocket } = await import('../../src/shared/ws');
const server = createApp().listen(Number(process.env.E2E_PORT || 4173), process.env.E2E_HOST || '127.0.0.1');
attachWebSocket(server);
function stop() {
  server.closeAllConnections();
  server.close(() => {
    db.closeAllConnections();
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 3000).unref();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
