import os,pathlib,tempfile,subprocess,socket,time,urllib.request,urllib.error,json,sqlite3,signal,shutil,hashlib
root=pathlib.Path(tempfile.mkdtemp(prefix='payroll-repair-',dir='work')).resolve()
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
  status,user,_=request('/api/users',{'username':'repair-target','password':'Synthetic repair target password','full_name':'Synthetic repair target','role':'csr'},token);assert status==201
  status,employee,_=request('/api/hr/employees',{'employee_no':'REPAIR-SMOKE-A','name':'Repair Current','user_id':user['id']},token);assert status==201
  assert request('/api/hr/employees',{'employee_no':'REPAIR-SMOKE-B','name':'Repair Old'},token)[0]==201
  with sqlite3.connect(root/'default.db') as d:
   d.create_function('form_history_enabled',0,lambda:1)
   d.execute("INSERT INTO employee_profile_changes(employee_id,field,old_value,new_value,source) VALUES(?,'name','Repair Old','Repair Current','hr_edit')",(employee['id'],))
   form=d.execute("SELECT id FROM form_definitions WHERE slug='hr_payroll'").fetchone()[0]
   record=d.execute("INSERT INTO form_records(form_def_id,number,data,status,created_by,updated_at) VALUES(?,? ,?,'paid',1,'2026-01-01 00:00:00')",(form,'REPAIR-SMOKE',json.dumps({'employee_name':'Repair Old','net_pay':4567}))).lastrowid
   before=d.execute('SELECT data,status,updated_at,revision FROM form_records WHERE id=?',(record,)).fetchone()
   mail_before=d.execute('SELECT COUNT(*) FROM mail_log').fetchone()
   d.execute("UPDATE session_stepups SET verified_at=datetime('now','-6 minutes')")
  path='/api/hr/payroll/'+str(record)+'/identity'
  body={'employee_id':employee['id'],'expected_revision':before[3],'reason':'Verified original employment records','evidence_reference':'CASE-SMOKE-001','verified_records':True}
  assert request(path+'/review',body,token,{'Idempotency-Key':'repair-smoke-review'})[0]==403
  assert request('/api/auth/step-up',{'password':env['ADMIN_PASSWORD']},token)[0]==200
  status,review,headers=request(path+'/review',body,token,{'Idempotency-Key':'repair-smoke-review'});assert status==200
  assert request(path+'/confirm',{'review_token':review['review_token']},token,{'Idempotency-Key':'repair-smoke-confirm'})[0]==200
  assert request(path+'/confirm',{'review_token':review['review_token']},token,{'Idempotency-Key':'repair-smoke-confirm'})[0]==409
  with sqlite3.connect(root/'default.db') as d:
   after=d.execute('SELECT data,status,updated_at,revision FROM form_records WHERE id=?',(record,)).fetchone()
   assert json.loads(after[0])=={**json.loads(before[0]),'employee_id':employee['id']}
   assert after[1:3]==before[1:3] and after[3]==before[3]+1
   audit=d.execute('SELECT changed_by,source,reason FROM form_record_revisions WHERE record_id=? AND revision=?',(record,after[3])).fetchone()
   assert audit[0]==1 and audit[1]=='payroll-identity-repair' and json.loads(audit[2])['evidence_reference']=='CASE-SMOKE-001'
   assert d.execute('SELECT COUNT(*) FROM mail_log').fetchone()==mail_before
   assert d.execute("SELECT COUNT(*) FROM idempotency_keys WHERE path LIKE '%/identity/%'").fetchone()==(0,)
  status,session,_=request('/api/auth/login',{'username':'repair-target','password':'Synthetic repair target password'});assert status==200
  status,rows,_=request('/api/me/payslips',token=session['token']);assert status==200 and any(r['id']==record and r['finalized'] for r in rows)
 print('PASS: actual server.ts requires fresh proof, executes the reviewed repair once, preserves paid data/timestamps, retains attributed revision history and grants the correct employee access.')
 print('PASS: no mail send; disposable synthetic catalogs only. No deployment, provider write or real employee modification.')

finally:
 if server and server.poll() is None:
  os.killpg(server.pid,signal.SIGTERM)
  try:server.wait(timeout=5)
  except subprocess.TimeoutExpired:os.killpg(server.pid,signal.SIGKILL);server.wait()
 shutil.rmtree(root)
