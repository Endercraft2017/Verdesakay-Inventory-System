import os,pathlib,tempfile,subprocess,socket,time,urllib.request,json,sqlite3,signal,shutil
root=pathlib.Path(tempfile.mkdtemp(prefix='signup-budget-',dir='work')).resolve()
env={'PATH':os.environ['PATH'],'NODE_ENV':'test','TZ':'Asia/Manila','DEPLOY_MODE':'cloud','BEHIND_PROXY':'true','SIGNUPS_OPEN':'true','TENANT_PATH_HOST':'127.0.0.1',
'ADMIN_PASSWORD':'Synthetic startup signup password','DB_PATH':str(root/'default.db'),'DATA_DIR':str(root/'tenants'),'PLATFORM_DB_PATH':str(root/'platform.db'),'UPLOAD_DIR':str(root/'uploads'),'BACKUP_DIR':str(root/'backups')}
with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
env['PORT']=str(port)
seed="""import {savePlatformMail} from './src/platform/platform-mail.ts';import {setBillingSettings} from './src/platform/billing.ts';savePlatformMail({transport:'brevo',from_email:'alerts@example.test',alert_to:'owner@example.test'},'synthetic-startup-mail');setBillingSettings({module_prices:{hr:100},seat_price:20});"""
subprocess.run(['node','--import','tsx','--input-type=module','-e',seed],env=env,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=20)
server=None
try:
 with open(root/'server.log','w') as log:
  server=subprocess.Popen(['node','--import','tsx','server.ts'],env=env,stdout=log,stderr=log,start_new_session=True)
  base=f'http://127.0.0.1:{port}'
  until=time.monotonic()+25
  while True:
   if server.poll() is not None:raise RuntimeError('Disposable server exited before health check')
   try:
    with urllib.request.urlopen(base+'/api/health',timeout=1) as r:assert r.status==200
    break
   except OSError:
    if time.monotonic()>until:raise
    time.sleep(.15)
  def post(url,body,headers={}):
   request=urllib.request.Request(base+url,data=json.dumps(body).encode(),headers={'Content-Type':'application/json',**headers},method='POST')
   with urllib.request.urlopen(request,timeout=15) as r:return r.status,json.load(r),dict(r.headers)
  body={'slug':'startup-budget','company_name':'Synthetic startup budget','admin_username':'owner','admin_password':'Synthetic public startup password','modules':['hr'],'seats':2}
  headers={'Idempotency-Key':'33333333-3333-4333-8333-333333333333'}
  first=post('/api/signup',body,headers);assert first[0]==201 and first[1]['slug']=='startup-budget'
  replay=post('/api/signup',body,headers);assert replay[0]==201 and replay[1]==first[1] and any(k.lower()=='idempotency-replayed' and v=='true' for k,v in replay[2].items())
  login=post('/startup-budget/api/auth/login',{'username':'owner','password':body['admin_password']});assert login[0]==200
  until=time.monotonic()+25
  while True:
   with sqlite3.connect(root/'platform.db') as d:
    accepted=d.execute("SELECT COUNT(*) FROM platform_owner_outbox WHERE state='accepted'").fetchone()[0]
   if accepted==1:break
   if time.monotonic()>until:raise RuntimeError('Actual timer did not process synthetic signup alert')
   time.sleep(.15)
  with sqlite3.connect(root/'platform.db') as d:
   assert d.execute("SELECT COUNT(*) FROM tenants WHERE slug='startup-budget'").fetchone()==(1,)
   assert d.execute("SELECT COUNT(*) FROM platform_creation_receipts WHERE tenant_slug='startup-budget'").fetchone()==(1,)
   assert d.execute("SELECT COUNT(*) FROM billing_invoices WHERE tenant_slug='startup-budget'").fetchone()==(1,)
   assert d.execute("SELECT COUNT(*) FROM platform_mail_log WHERE kind='signup'").fetchone()==(1,)
   assert d.execute('SELECT outcome FROM platform_owner_alert_worker').fetchone()[0] in ('processed','idle')
 print('PASS: actual server.ts accepted async public signup, replayed its committed acknowledgement and authenticated the chosen owner password.')
 print('PASS: exactly one workspace, creation receipt, invoice and signup alert; actual timer recorded one synthetic acceptance and completed heartbeat.')
 print('Disposable catalogs and NODE_ENV=test transport only; no real provider/customer email or hosting change.')
finally:
 if server and server.poll() is None:
  os.killpg(server.pid,signal.SIGTERM)
  try:server.wait(timeout=5)
  except subprocess.TimeoutExpired:os.killpg(server.pid,signal.SIGKILL);server.wait()
 shutil.rmtree(root)
