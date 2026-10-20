import os,pathlib,tempfile,subprocess,socket,time,urllib.request,urllib.error,json,sqlite3,signal,shutil,hashlib
root=pathlib.Path(tempfile.mkdtemp(prefix='payslip-identity-',dir='work')).resolve()
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
  accounts=[]
  for kind,name in [('original','Synthetic New Name'),('reused','Synthetic Old Name')]:
   password='Synthetic payroll '+kind+' password'
   status,user,_=request('/api/users',{'username':'payroll-'+kind,'password':password,'full_name':'Synthetic '+kind,'role':'csr','email':kind+'@example.test'},token);assert status==201
   status,employee,_=request('/api/hr/employees',{'employee_no':'SMOKE-'+kind,'name':name,'user_id':user['id']},token);assert status==201
   status,session,_=request('/api/auth/login',{'username':'payroll-'+kind,'password':password});assert status==200
   accounts.append((employee['id'],session['token']))
  with sqlite3.connect(root/'default.db') as d:
   # Enable the same revision triggers for fixture inserts; do not disable history.
   d.create_function('form_history_enabled',0,lambda:1)
   d.execute("INSERT INTO employee_profile_changes(employee_id,field,old_value,new_value,source) VALUES(?,'name','Synthetic Old Name','Synthetic New Name','hr_edit')",(accounts[0][0],))
   form=d.execute("SELECT id FROM form_definitions WHERE slug='hr_payroll'").fetchone()[0]
   slips=[]
   for number,data in [('SMOKE-LEGACY',{'employee_name':'Synthetic Old Name'}),('SMOKE-STAMP',{'employee_name':'Synthetic Old Name','employee_id':accounts[0][0]}),('SMOKE-DANGLING',{'employee_name':'Synthetic Old Name','employee_id':999999}),('SMOKE-TEXT',{'employee_name':'Synthetic Old Name','employee_id':str(accounts[0][0])})]:
    slips.append(d.execute("INSERT INTO form_records(form_def_id,number,data,status,created_by) VALUES(?,?,?,'paid',1)",(form,number,json.dumps(data))).lastrowid)
   cutoff=d.execute("INSERT INTO attendance_periods(label,start_date,end_date) VALUES('SMOKE-IDENTITY-HOLD','2026-09-01','2026-09-01')").lastrowid
   d.execute("INSERT INTO attendance_records(period_id,employee_id,work_date) VALUES(?,?,'2026-09-01')",(cutoff,accounts[0][0]))
   hold=d.execute("INSERT INTO form_records(form_def_id,number,data,status,period,created_by) VALUES(?,?,?,'paid','SMOKE-IDENTITY-HOLD',1)",(form,'SMOKE-HOLD',json.dumps({'employee_name':'Synthetic Old Name','cutoff_id':cutoff}))).lastrowid
   before_generation=d.execute('SELECT COUNT(*) FROM form_records').fetchone()
  status,held,_=request('/api/hr/periods/'+str(cutoff)+'/generate-payslips',{'payroll_period':'SMOKE-IDENTITY-HOLD'},token);assert status==409 and hold in held['unresolved_record_ids']
  with sqlite3.connect(root/'default.db') as d:assert d.execute('SELECT COUNT(*) FROM form_records').fetchone()==before_generation
  for i,(_,bearer) in enumerate(accounts):
   status,rows,headers=request('/api/me/payslips',token=bearer);assert status==200
   ids=[r['id'] for r in rows];assert slips[0] not in ids and slips[2] not in ids
   assert (slips[1] in ids)==(i==0) and (slips[3] in ids)==(i==0)
   for suffix in ['pdf','timekeeping']:assert request('/api/me/payslips/'+str(slips[0])+'/'+suffix,token=bearer)[0]==404
  for slip in [slips[0],slips[2]]:
   status,result,_=request('/api/hr/payroll/'+str(slip)+'/email',{},token);assert status==400 and 'ownership cannot be verified' in result['error']
  with sqlite3.connect(root/'default.db') as d:assert d.execute('SELECT COUNT(*) FROM mail_log').fetchone()==(0,)
 print('PASS: actual server.ts hides ambiguous and dangling legacy payroll from both linked accounts, keeps numeric/text stamped ownership, refuses PDF/timekeeping and unresolved email without mail-log side effects; generation returns 409 and creates no duplicate records.')
 print('Disposable synthetic cloud-mode catalogs only; no external mail, employee data, provider or hosting change.')

finally:
 if server and server.poll() is None:
  os.killpg(server.pid,signal.SIGTERM)
  try:server.wait(timeout=5)
  except subprocess.TimeoutExpired:os.killpg(server.pid,signal.SIGKILL);server.wait()
 shutil.rmtree(root)
