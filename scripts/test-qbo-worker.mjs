// Run from the repository with node scripts/test-qbo-worker.mjs. All data is disposable.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qbo-worker-smoke-'));
const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const env={PATH:process.env.PATH,NODE_ENV:'test',TZ:'Asia/Manila',BEHIND_PROXY:'true',DEPLOY_MODE:'cloud',PORT:String(port),VDS_TEST_ADMIN_PASSWORD:randomUUID(),DB_PATH:path.join(dir,'data.db'),DATA_DIR:path.join(dir,'data'),PLATFORM_DB_PATH:path.join(dir,'platform.db'),UPLOAD_DIR:path.join(dir,'uploads'),BACKUP_DIR:path.join(dir,'backups')};
let child,db;
try {
 const seed=`const db=await import('./src/shared/db.ts');db.init();const q=await import('./src/modules/quickbooks/quickbooks.ts');await q.completeConnect('synthetic-code','111');q.setAutoPush(true);const id=Number(db.run("INSERT INTO orders(number,type,customer_name,total) VALUES('WORKER-SMOKE','sale','Synthetic startup customer',10)").lastInsertRowid);(await import('./src/modules/quickbooks/export-jobs.ts')).enqueueOrderExport(id);db.closeAllConnections();`;
 execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',seed],{env,cwd:path.resolve(import.meta.dirname,'..'),stdio:'pipe'});
 db=new DatabaseSync(env.DB_PATH);if(db.prepare('SELECT state FROM qbo_export_jobs').get()?.state!=='queued')throw Error('Seed was not durable');
 child=spawn(process.execPath,['--import','tsx','server.ts'],{env,cwd:path.resolve(import.meta.dirname,'..'),stdio:'ignore'});
 const until=Date.now()+15000;let state;
 do {state=db.prepare('SELECT state FROM qbo_export_jobs').get()?.state;if(state==='succeeded')break;await new Promise(resolve=>setTimeout(resolve,100));}while(Date.now()<until);
 if(state!=='succeeded')throw Error('Startup worker did not complete persisted intent: '+state);
 console.log('PASS: actual server startup consumed previously committed export intent using mocked provider responses.');
}finally{
 if(child){const ended=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await Promise.race([ended,new Promise(resolve=>setTimeout(resolve,2000))]);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
 db?.close();fs.rmSync(dir,{recursive:true,force:true});
}
