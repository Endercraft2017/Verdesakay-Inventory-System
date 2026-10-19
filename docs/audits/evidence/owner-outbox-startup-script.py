import os, pathlib, tempfile, subprocess, socket, time, urllib.request, sqlite3, signal, shutil
root=pathlib.Path(tempfile.mkdtemp(prefix='owner-alert-startup-',dir='work')).resolve()
env={'PATH':os.environ['PATH'],'NODE_ENV':'test','TZ':'Asia/Manila','DEPLOY_MODE':'cloud','BEHIND_PROXY':'true',
     'ADMIN_PASSWORD':'Synthetic startup receipt password','DB_PATH':str(root/'default.db'),'DATA_DIR':str(root/'tenants'),
     'PLATFORM_DB_PATH':str(root/'platform.db'),'UPLOAD_DIR':str(root/'uploads'),'BACKUP_DIR':str(root/'backups')}
with socket.socket() as s: s.bind(('127.0.0.1',0)); port=s.getsockname()[1]
env['PORT']=str(port)
seed="""import {platformDb} from './src/platform/platform.ts';
import {savePlatformMail} from './src/platform/platform-mail.ts';
import {prepareOwnerAlerts,enqueueSignupAlert} from './src/platform/owner-alert-outbox.ts';
import {createTenant} from './src/platform/provisioning.ts';
savePlatformMail({transport:'brevo',from_email:'alerts@example.test',alert_to:'owner@example.test'},'synthetic-startup-secret');
prepareOwnerAlerts();
createTenant({slug:'startup-alert',name:'Synthetic startup',admin_username:'owner',admin_password:'Synthetic startup alert password',is_sandbox:true},slug=>enqueueSignupAlert(slug,'Synthetic startup alert',['Synthetic']));
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
        deadline=time.monotonic()+15
        while True:
            with sqlite3.connect(root/'platform.db') as db:
                row=db.execute("SELECT state,attempts FROM platform_owner_outbox WHERE event_key='signup:startup-alert'").fetchone()
            if row==('accepted',1): break
            if time.monotonic()>deadline: raise RuntimeError('Startup worker did not process committed intent')
            time.sleep(.15)
        with sqlite3.connect(root/'platform.db') as db:
            assert db.execute("SELECT state,error_code FROM platform_owner_outbox WHERE id='stale-startup'").fetchone()==('unknown','interrupted_send')
            assert db.execute("SELECT COUNT(*) FROM platform_mail_log WHERE kind='signup'").fetchone()==(1,)
    print('PASS: actual server.ts startup consumed a previously committed signup alert; one synthetic provider acceptance recorded.')
    print('PASS: a stale inflight claim became unknown and was not resent.')
    print('Disposable databases and NODE_ENV=test transport only; no real email, provider or deployment.')
finally:
    if server and server.poll() is None:
        os.killpg(server.pid,signal.SIGTERM)
        try: server.wait(timeout=5)
        except subprocess.TimeoutExpired: os.killpg(server.pid,signal.SIGKILL); server.wait()
    shutil.rmtree(root)
