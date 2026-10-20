import os,pathlib,tempfile,subprocess,socket,time,urllib.request,urllib.error,json,sqlite3,signal,shutil
root=pathlib.Path(tempfile.mkdtemp(prefix='payroll-reconcile-',dir='work')).resolve()
env={'PATH':os.environ['PATH'],'NODE_ENV':'test','TZ':'Asia/Manila','DEPLOY_MODE':'cloud','BEHIND_PROXY':'true','ADMIN_PASSWORD':'Synthetic reconciliation password','DB_PATH':str(root/'default.db'),'DATA_DIR':str(root/'tenants'),'PLATFORM_DB_PATH':str(root/'platform.db'),'UPLOAD_DIR':str(root/'uploads'),'BACKUP_DIR':str(root/'backups')}
with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
env['PORT']=str(port);base=f'http://127.0.0.1:{port}';server=None;log=None;child=None

def stop():
 global server,log
 if server and server.poll() is None:
  os.killpg(server.pid,signal.SIGTERM)
  try:server.wait(timeout=5)
  except subprocess.TimeoutExpired:os.killpg(server.pid,signal.SIGKILL);server.wait()
 if log:log.close();log=None

def start():
 global server,log
 log=open(root/'server.log','a');server=subprocess.Popen(['node','--import','tsx','server.ts'],env=env,stdout=log,stderr=log,start_new_session=True)
 until=time.monotonic()+25
 while True:
  if server.poll() is not None:raise RuntimeError('Disposable server exited before health check')
  try:
   with urllib.request.urlopen(base+'/api/health',timeout=1) as r:assert r.status==200
   return
  except OSError:
   if time.monotonic()>until:raise
   time.sleep(.15)

def request(path,body=None,token=None):
 headers={}
 if token:headers['Authorization']='Bearer '+token
 if body is not None:headers['Content-Type']='application/json'
 req=urllib.request.Request(base+path,data=json.dumps(body).encode() if body is not None else None,headers=headers,method='POST' if body is not None else 'GET')
 try:r=urllib.request.urlopen(req,timeout=15)
 except urllib.error.HTTPError as e:r=e
 with r:return r.status,json.load(r),dict(r.headers)

def login():
 status,session,_=request('/api/auth/login',{'username':'admin','password':env['ADMIN_PASSWORD']});assert status==200;return session['token']

def ledger_snapshot():
 with sqlite3.connect(root/'default.db') as d:
  return [d.execute("SELECT * FROM journal_entries WHERE source_type='payroll_run' ORDER BY id").fetchall(),d.execute("SELECT * FROM journal_lines WHERE entry_id IN(SELECT id FROM journal_entries WHERE source_type='payroll_run') ORDER BY id").fetchall(),d.execute("SELECT value FROM settings WHERE key='je_number'").fetchone()]
try:
 start();token=login();assert request('/api/accounting/ledger/setup',{'fiscal_year_start':'2026-01-01'},token)[0]==201
 status,employee,_=request('/api/hr/employees',{'employee_no':'RECON-SMOKE','name':'Synthetic Reconciliation Employee'},token);assert status==201
 status,period,_=request('/api/hr/periods',{'label':'RECON-SMOKE','start_date':'2026-07-01','end_date':'2026-07-15'},token);assert status==201
 assert request('/api/hr/periods/'+str(period['id'])+'/employees',{'employee_id':employee['id']},token)[0] in (200,201)
 with sqlite3.connect(root/'default.db') as d:
  d.create_function('form_history_enabled',0,lambda:1)
  form=d.execute("SELECT id FROM form_definitions WHERE slug='hr_payroll'").fetchone()[0]
  data={'employee_id':employee['id'],'employee_name':'Synthetic Reconciliation Employee','cutoff_id':period['id'],'pay_date':'2026-07-15','basic_salary':1000,'total_earnings':1000,'net_pay':1000}
  d.execute("INSERT INTO form_records(form_def_id,number,data,status,period,created_by) VALUES(?,?,?,'draft','RECON-SMOKE',1)",(form,'RECON-SMOKE',json.dumps(data)))
  mail_before=d.execute('SELECT COUNT(*) FROM mail_log').fetchone()
 path='/api/hr/periods/'+str(period['id']);posting=path+'/post-payroll-gl';comparison=path+'/payroll-reconciliation'
 status,report,headers=request(comparison,token=token);assert status==200 and report['ledger']['state']=='missing' and 'no-store' in headers.get('Cache-Control','')
 assert request(posting,{'payroll_period':'RECON-SMOKE'},token)[0]==201
 assert request(comparison,token=token)[1]['ledger']['state']=='matches'
 before=ledger_snapshot();stop()
 with open(root/'crash.log','w') as crashlog:
  child=subprocess.Popen(['node','--import','tsx','work/payroll-reconcile-crash-child.ts'],env=env,stdout=crashlog,stderr=crashlog,start_new_session=True)
  assert child.wait(timeout=20)==-signal.SIGKILL
 assert 'INJECTED PROCESS TERMINATION AFTER REVERSAL' in (root/'crash.log').read_text()
 assert ledger_snapshot()==before,'Reversal, replacement lines or journal sequence survived interrupted outer transaction'
 start();token=login()
 status,report,_=request(comparison,token=token);assert status==200 and report['ledger']['state']=='differs' and report['source']['net_pay_total']==1200
 assert request(posting,{'payroll_period':'RECON-SMOKE'},token)[0]==201
 assert request(comparison,token=token)[1]['ledger']['state']=='matches'
 with sqlite3.connect(root/'default.db') as d:
  assert d.execute("SELECT COUNT(*) FROM journal_entries WHERE source_type='payroll_run'").fetchone()==(3,)
  d.create_function('form_history_enabled',0,lambda:1)
  data=d.execute("SELECT data FROM form_records WHERE number='RECON-SMOKE'").fetchone()[0]
  d.execute("INSERT INTO form_records(form_def_id,number,data,status,period,created_by) VALUES(?,?,?,'draft','RECON-SMOKE',1)",(form,'RECON-SMOKE-DUP',data))
 before=ledger_snapshot();assert request(posting,{'payroll_period':'RECON-SMOKE'},token)[0]==409
 assert request(path+'/generate-payslips',{'payroll_period':'RECON-SMOKE'},token)[0]==409
 status,report,_=request(comparison,token=token);assert status==200 and report['ledger']['state']=='blocked' and report['source']['net_pay_total'] is None and report['payment_verification']=='not_linked'
 assert ledger_snapshot()==before and request(comparison)[0]==401
 with sqlite3.connect(root/'default.db') as d:assert d.execute('SELECT COUNT(*) FROM mail_log').fetchone()==mail_before
 print('PASS: real server.ts creates and compares a payroll journal; duplicate sources stop generation/posting without altering journals.')
 print('PASS: SIGKILL after the inner reversal release preserves original entries, lines and sequence on recovery; restart detects changed sources, and explicit repost commits one reversal/replacement pair.')
 print('PASS: private no-store/read-only permission boundary and separate payment-evidence status; no mail, provider write, deployment or real employee modification. Disposable catalogs only.')
finally:
 stop()
 if child:
  try:os.killpg(child.pid,signal.SIGTERM)
  except ProcessLookupError:pass
 shutil.rmtree(root)
