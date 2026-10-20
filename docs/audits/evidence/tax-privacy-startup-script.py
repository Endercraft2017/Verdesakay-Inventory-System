import os,pathlib,tempfile,subprocess,socket,time,urllib.request,urllib.error,json,sqlite3,signal,shutil,hashlib
root=pathlib.Path(tempfile.mkdtemp(prefix='tax-privacy-',dir='work')).resolve()
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
  status,employee,_=request('/api/hr/employees',{'employee_no':'STARTUP-TAX-PRIVACY','name':'Synthetic Startup Employee','daily_rate':1234,'birth_date':'1991-03-07','tin_no':'SYNTHETIC-TIN'},token);assert status==201
  status,user,_=request('/api/users',{'username':'startup-accountant','password':'Synthetic accounting startup password','full_name':'Synthetic Accountant','role':'accounting'},token);assert status==201
  status,accountant,_=request('/api/auth/login',{'username':'startup-accountant','password':'Synthetic accounting startup password'});assert status==200
  status,detail,headers=request('/api/accounting/bir-2316/'+str(employee['id'])+'?year=2026',token=accountant['token']);assert status==200
  expected={'id','employee_no','name','position','tin_no','birth_date','birth_date_mdy','sss_no','philhealth_no','pagibig_no','department_name'}
  assert set(detail['employee'])==expected
  assert detail['employee']['birth_date_mdy']=='03/07/1991'
  assert any(k.lower()=='cache-control' and 'no-store' in v for k,v in headers.items())
  assert request('/api/hr/employees',token=accountant['token'])[0]==403
  assert request('/api/accounting/bir-2316/'+str(employee['id']))[0]==401
 print('PASS: actual server.ts returns only the bounded BIR 2316 identity to accounting, preserves formatted birth date and no-store, refuses HR and anonymous access.')
 print('Disposable cloud-mode catalogs only; no hosted, provider, real employee or tax-filing changes.')

finally:
 if server and server.poll() is None:
  os.killpg(server.pid,signal.SIGTERM)
  try:server.wait(timeout=5)
  except subprocess.TimeoutExpired:os.killpg(server.pid,signal.SIGKILL);server.wait()
 shutil.rmtree(root)
