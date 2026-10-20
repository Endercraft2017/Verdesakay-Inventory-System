import os,pathlib,tempfile,subprocess,socket,time,urllib.request,urllib.error,json,sqlite3,signal,shutil,hashlib
root=pathlib.Path(tempfile.mkdtemp(prefix='payroll-reports-',dir='work')).resolve()
env={'PATH':os.environ['PATH'],'NODE_ENV':'test','TZ':'Asia/Manila','DEPLOY_MODE':'cloud','BEHIND_PROXY':'true','ADMIN_PASSWORD':'Synthetic startup export password','DB_PATH':str(root/'default.db'),'DATA_DIR':str(root/'tenants'),'PLATFORM_DB_PATH':str(root/'platform.db'),'UPLOAD_DIR':str(root/'uploads'),'BACKUP_DIR':str(root/'backups')}
with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
env['PORT']=str(port)
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
  def request(path,body=None,token=None,extra={}):
   headers={**extra}
   if token:headers['Authorization']='Bearer '+token
   if body is not None:headers['Content-Type']='application/json'
   req=urllib.request.Request(base+path,data=json.dumps(body).encode() if body is not None else None,headers=headers,method='POST' if body is not None else 'GET')
   try:r=urllib.request.urlopen(req,timeout=15)
   except urllib.error.HTTPError as e:r=e
   with r:return r.status,json.load(r),dict(r.headers)
  status,login,_=request('/api/auth/login',{'username':'admin','password':env['ADMIN_PASSWORD']});assert status==200;token=login['token']
  ids=[]
  for i in range(2):
   status,employee,_=request('/api/hr/employees',{'employee_no':'REPORT-SMOKE-'+str(i),'name':'Report Smoke Twin','tin_no':'REPORT-TAX-'+str(i),'sss_no':'REPORT-SSS-'+str(i)},token);assert status==201
   ids.append(employee['id'])
  with sqlite3.connect(root/'default.db') as d:
   d.create_function('form_history_enabled',0,lambda:1)
   form=d.execute("SELECT id FROM form_definitions WHERE slug='hr_payroll'").fetchone()[0]
   for i,employee in enumerate(ids):
    data={'employee_id':employee,'employee_name':'Report Smoke Twin','pay_date':'2040-06-15','basic_salary':12000*(i+1),'total_earnings':12000*(i+1),'withholding_tax':100+i}
    d.execute("INSERT INTO form_records(form_def_id,number,data,status,created_by) VALUES(?,?,?,'paid',1)",(form,'REPORT-SMOKE-'+str(i),json.dumps(data)))
   before=d.execute('SELECT COUNT(*) FROM form_record_revisions').fetchone()
   mail_before=d.execute('SELECT COUNT(*) FROM mail_log').fetchone()
  status,report,headers=request('/api/accounting/bir-2316?year=2040',token=token);assert status==200 and 'no-store' in headers.get('Cache-Control','')
  assert [(r['employee_id'],r['tin_no'],r['figures']['basic_salary']) for r in report['rows']]==[(ids[0],'REPORT-TAX-0',12000),(ids[1],'REPORT-TAX-1',24000)]
  status,report,_=request('/api/accounting/bir-1601c?year=2040',token=token);assert status==200 and report['months'][5]['employee_count']==2 and report['totals']['tax_withheld']==201
  status,report,_=request('/api/accounting/contribution-schedule?month=2040-06',token=token);assert status==200 and [r['id_number'] for r in report['rows']]==['REPORT-SSS-0','REPORT-SSS-1']
  with sqlite3.connect(root/'default.db') as d:
   d.create_function('form_history_enabled',0,lambda:1)
   d.execute("INSERT INTO form_records(form_def_id,number,data,status,created_by) VALUES(?,?,?,'paid',1)",(form,'REPORT-SMOKE-UNRESOLVED',json.dumps({'employee_name':'Report Smoke Twin','pay_date':'2040-06-15','total_earnings':999})))
   before=d.execute('SELECT COUNT(*) FROM form_record_revisions').fetchone()
  for path in ['/api/accounting/bir-2316?year=2040','/api/accounting/bir-2316/'+str(ids[0])+'?year=2040','/api/accounting/bir-1604c?year=2040','/api/accounting/bir-alphalist?year=2040','/api/accounting/contribution-schedule?month=2040-06&format=csv','/api/hr/thirteenth-month?year=2040','/api/hr/final-pay/'+str(ids[0])+'?separation_date=2040-06-30']:
   status,report,headers=request(path,token=token);assert status==409 and 'Payroll report blocked' in report['error'] and 'no-store' in headers.get('Cache-Control','')
  assert request('/api/accounting/bir-2316?year=2041',token=token)[0]==200
  assert request('/api/accounting/bir-2316?year=2040')[0]==401
  with sqlite3.connect(root/'default.db') as d:
   assert d.execute('SELECT COUNT(*) FROM form_record_revisions').fetchone()==before
   assert d.execute('SELECT COUNT(*) FROM mail_log').fetchone()==mail_before
  print('PASS: actual server.ts keeps same-name certificates, government IDs, contribution bases and monthly headcount separate by stable employee ID.')
  print('PASS: affected annual/monthly/detail/CSV/HR reports return 409 and no-store for ambiguous ownership; another year remains usable; anonymous access denied.')
  print('PASS: report reads do not alter payroll history or send mail. Disposable catalogs only; no deployment/provider/real-employee changes.')

finally:
 if server and server.poll() is None:
  os.killpg(server.pid,signal.SIGTERM)
  try:server.wait(timeout=5)
  except subprocess.TimeoutExpired:os.killpg(server.pid,signal.SIGKILL);server.wait()
 shutil.rmtree(root)
