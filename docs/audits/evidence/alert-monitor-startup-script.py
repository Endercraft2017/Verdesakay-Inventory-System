import os, pathlib, tempfile, subprocess, socket, time, urllib.request, sqlite3, signal, shutil
root=pathlib.Path(tempfile.mkdtemp(prefix='alert-monitor-startup-',dir='work')).resolve()
env={'PATH':os.environ['PATH'],'NODE_ENV':'test','TZ':'Asia/Manila','DEPLOY_MODE':'cloud','BEHIND_PROXY':'true',
     'ADMIN_PASSWORD':'Synthetic startup receipt password','DB_PATH':str(root/'default.db'),'DATA_DIR':str(root/'tenants'),
     'PLATFORM_DB_PATH':str(root/'platform.db'),'UPLOAD_DIR':str(root/'uploads'),'BACKUP_DIR':str(root/'backups')}
with socket.socket() as s: s.bind(('127.0.0.1',0)); port=s.getsockname()[1]
env['PORT']=str(port)
seed="""import {platformDb} from './src/platform/platform.ts';
import {savePlatformMail} from './src/platform/platform-mail.ts';
import {prepareOwnerAlerts,enqueueOwnerAlert,enqueueSignupAlert} from './src/platform/owner-alert-outbox.ts';
import {createTenant} from './src/platform/provisioning.ts';
import {createInquiry} from './src/platform/inquiries.ts';
import {prepareInquiryReceipt,saveInquiryReceipt} from './src/platform/inquiry-receipts.ts';
import {preparePaymentReportReceipt,savePaymentReportReceipt} from './src/platform/payment-report-receipts.ts';
import {createInvoice,submitPayment,invoiceView} from './src/platform/billing.ts';
savePlatformMail({transport:'brevo',from_email:'alerts@example.test',alert_to:'owner@example.test'},'synthetic-startup-secret');
prepareOwnerAlerts();
createTenant({slug:'startup-alert',name:'Synthetic startup',admin_username:'owner',admin_password:'Synthetic startup alert password',is_sandbox:true},slug=>enqueueSignupAlert(slug,'Synthetic startup alert',['Synthetic']));
const inquiryInput={name:'Synthetic',company:'Synthetic startup',email:'contact@example.test'};const inquiryReceipt=await prepareInquiryReceipt('22222222-2222-4222-8222-222222222222',inquiryInput);createInquiry(inquiryInput,row=>{enqueueOwnerAlert('inquiry',row.id,'','Synthetic inquiry',['Synthetic']);saveInquiryReceipt(inquiryReceipt,row.id);});platformDb().exec('UPDATE platform_inquiry_receipts SET expires_at=0');
const invoice=createInvoice('startup-alert',{kind:'other',description:'Synthetic startup',amount_centavos:10000,due_on:'2099-01-01'},'fixture');
const input={channel:'bank',reference_no:'Synthetic',amount_centavos:10000,paid_on:new Date().toISOString().slice(0,10),proof:{buffer:Buffer.from('synthetic proof'),mimetype:'image/png',originalname:'proof.png'}};
const receipt=preparePaymentReportReceipt('startup-alert',1,'11111111-1111-4111-8111-111111111111',invoice.id,input);
submitPayment('startup-alert',invoice.id,input,'fixture',(row,inv)=>{enqueueOwnerAlert('payment',row.id,'startup-alert','Synthetic payment',['Synthetic']);savePaymentReportReceipt(receipt,row.id,invoiceView(inv));});
platformDb().exec('UPDATE platform_payment_report_receipts SET expires_at=0');
platformDb().prepare(`INSERT INTO platform_business_outbox(id,event_key,tenant_slug,state,attempts,next_attempt_at,claimed_at,created_at,updated_at)
VALUES('stale-business','payment:99999','startup-alert','inflight',1,0,?,?,?)`).run(Date.now()-120001,Date.now(),Date.now());
platformDb().prepare(`INSERT INTO platform_owner_outbox(id,event_key,tenant_slug,state,attempts,next_attempt_at,claimed_at,created_at,updated_at)
VALUES('stale-startup','signup:stale','startup-alert','inflight',1,0,?,?,?)`).run(Date.now()-120001,Date.now(),Date.now());
"""
subprocess.run(['node','--import','tsx','--input-type=module','-e',seed],env=env,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=20)
server=None
try:
    with open(root/'server.log','w') as log:
        server=subprocess.Popen(['node','--import','tsx','server.ts'],env=env,stdout=log,stderr=log,start_new_session=True)
        deadline=time.monotonic()+25
        while True:
            if server.poll() is not None: raise RuntimeError('Disposable server exited before health check')
            try:
                with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/health',timeout=1) as response: assert response.status==200
                break
            except OSError:
                if time.monotonic()>deadline: raise
                time.sleep(.15)
        deadline=time.monotonic()+45
        while True:
            with sqlite3.connect(root/'platform.db') as db:
                row=db.execute("SELECT COUNT(*) FROM (SELECT state FROM platform_owner_outbox UNION ALL SELECT state FROM platform_business_outbox) WHERE state='accepted'").fetchone()
            if row==(3,): break
            if time.monotonic()>deadline: raise RuntimeError('Startup worker did not process committed intent')
            time.sleep(.15)
        with sqlite3.connect(root/'platform.db') as db:
            assert db.execute("SELECT state,error_code FROM platform_owner_outbox WHERE id='stale-startup'").fetchone()==('unknown','interrupted_send')
            assert db.execute("SELECT state,error_code FROM platform_business_outbox WHERE id='stale-business'").fetchone()==('unknown','interrupted_send')
            assert db.execute("SELECT kind,COUNT(*) FROM platform_mail_log GROUP BY kind ORDER BY kind").fetchall()==[('inquiry',1),('payment',1),('signup',1)]
            assert db.execute("SELECT COUNT(*) FROM platform_durable_files").fetchone()==(1,)
            assert db.execute("SELECT verifier,response FROM platform_payment_report_receipts").fetchall()==[(None,None)]
            assert db.execute("SELECT verifier FROM platform_inquiry_receipts").fetchall()==[(None,)]
        with sqlite3.connect(root/'platform.db') as db:
            heartbeat=db.execute('SELECT started_at,finished_at,outcome,last_success_at FROM platform_owner_alert_worker WHERE id=1').fetchone()
            assert heartbeat and heartbeat[1]>=heartbeat[0] and heartbeat[2] in ('processed','idle') and heartbeat[3] is not None
    print('PASS: actual startup/timer persisted a completed worker heartbeat and last-success timestamp.')
    print('PASS: actual server.ts startup/timer processed committed signup, inquiry and payment intent; one synthetic acceptance per category.')
    print('PASS: stale claims in both queue tables became unknown without resend; payment proof bytes remained durable.')
    print('PASS: actual server startup pruned expired payment receipt payload/verifier while retaining its tombstone and proof.')
    print('PASS: actual startup pruned expired inquiry verifier and retained its source/receipt tombstone.')
    print('Disposable databases and NODE_ENV=test transport only; no real email, provider or deployment.')
finally:
    if server and server.poll() is None:
        os.killpg(server.pid,signal.SIGTERM)
        try: server.wait(timeout=5)
        except subprocess.TimeoutExpired: os.killpg(server.pid,signal.SIGKILL); server.wait()
    shutil.rmtree(root)
