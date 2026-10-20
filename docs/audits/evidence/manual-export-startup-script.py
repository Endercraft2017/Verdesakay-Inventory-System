import os,pathlib,tempfile,subprocess,socket,time,urllib.request,urllib.error,json,sqlite3,signal,shutil,hashlib
root=pathlib.Path(tempfile.mkdtemp(prefix='manual-export-',dir='work')).resolve()
env={'PATH':os.environ['PATH'],'NODE_ENV':'test','TZ':'Asia/Manila','DEPLOY_MODE':'cloud','BEHIND_PROXY':'true','ADMIN_PASSWORD':'Synthetic startup export password','DB_PATH':str(root/'default.db'),'DATA_DIR':str(root/'tenants'),'PLATFORM_DB_PATH':str(root/'platform.db'),'UPLOAD_DIR':str(root/'uploads'),'BACKUP_DIR':str(root/'backups')}
with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
env['PORT']=str(port)
seed="import {completeConnect} from './src/modules/quickbooks/quickbooks.ts';await completeConnect('synthetic-startup','111');"
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
  def request(path,body=None,token=None,extra={}):
   headers={**extra}
   if token:headers['Authorization']='Bearer '+token
   if body is not None:headers['Content-Type']='application/json'
   req=urllib.request.Request(base+path,data=json.dumps(body).encode() if body is not None else None,headers=headers,method='POST' if body is not None else 'GET')
   try:r=urllib.request.urlopen(req,timeout=15)
   except urllib.error.HTTPError as e:r=e
   with r:return r.status,json.load(r),dict(r.headers)
  status,login,_=request('/api/auth/login',{'username':'admin','password':env['ADMIN_PASSWORD']});assert status==200;token=login['token']
  status,order,_=request('/api/orders',{'type':'sale','customer_name':'Synthetic startup customer','items':[{'name':'Commercial','quantity':1,'unit_price':100}]},token);assert status==201
  oid=order['id']
  with sqlite3.connect(root/'default.db') as d:
   parent=d.execute('SELECT id FROM order_items WHERE order_id=?',(oid,)).fetchone()[0]
   d.execute("UPDATE order_items SET fulfillment_mode='ckd' WHERE id=?",(parent,))
   d.execute("INSERT INTO order_items(order_id,name,quantity,unit_price,line_total,fulfillment_mode,parent_order_item_id) VALUES(?,'Component',1,100,100,'ckd_component',?)",(oid,parent))
   d.execute("UPDATE session_stepups SET verified_at=datetime('now','-6 minutes')")
  status,scope,_=request('/api/quickbooks/status',token=token);assert status==200 and scope['connection_id'];review=request('/api/quickbooks/order/'+str(oid)+'/preview',token=token);assert review[0]==200;body={'connection_id':scope['connection_id'],'order_stamp':review[1]['order_stamp']}
  path='/api/quickbooks/push/order/'+str(oid)
  status,denied,_=request(path,body,token);assert status==403 and denied['step_up_required']
  with sqlite3.connect(root/'default.db') as d:assert d.execute('SELECT COUNT(*) FROM qbo_write_attempts').fetchone()==(0,)
  assert request('/api/auth/step-up',{'password':env['ADMIN_PASSWORD']},token)[0]==200
  assert request(path,{},token)[0]==400
  headers={'Idempotency-Key':'66666666-6666-4666-8666-666666666666'}
  first=request(path,body,token,headers);assert first[0]==200 and first[1]['qbo_type']=='Invoice'
  replay=request(path,body,token,headers);assert replay[0]==200 and replay[1]==first[1] and any(k.lower()=='idempotency-replayed' and v=='true' for k,v in replay[2].items())
  with sqlite3.connect(root/'default.db') as d:
   party=d.execute("SELECT qbo_id FROM qbo_company_links WHERE entity='customer'").fetchone()[0]
   expected={'Line':[{'Amount':100,'DetailType':'SalesItemLineDetail','Description':'Commercial','SalesItemLineDetail':{'Qty':1,'UnitPrice':100}}],'DocNumber':order['number'][:21],'CustomerRef':{'value':party}}
   digest=hashlib.sha256(json.dumps(expected,separators=(',',':')).encode()).hexdigest()
   assert d.execute('SELECT state,payload_hash FROM qbo_write_attempts WHERE operation_key=?',('order:'+str(oid),)).fetchone()==('succeeded',digest)
   assert d.execute('SELECT COUNT(*) FROM qbo_export_locks').fetchone()==(0,)
 print('PASS: actual server.ts denied stale manual export and missing destination, accepted fresh proof and generation-bound export, and replayed the same HTTP receipt.')
 print('PASS: stored financial payload hash matches one commercial CKD parent, excluding the priced component; accepted invoice receipt retained and own lock released.')
 print('Disposable catalogs and NODE_ENV=test Intuit transport only; no real provider financial write or hosting change.')
finally:
 if server and server.poll() is None:
  os.killpg(server.pid,signal.SIGTERM)
  try:server.wait(timeout=5)
  except subprocess.TimeoutExpired:os.killpg(server.pid,signal.SIGKILL);server.wait()
 shutil.rmtree(root)
