/** Oracles: runtime-support-contract.md admission order, official LTS/API records, unchanged files. */
import {it,expect} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

function inventory(dir:string):Record<string,string>{
 const result:Record<string,string>={};
 function visit(root:string){for(const item of fs.readdirSync(root,{withFileTypes:true})){const file=path.join(root,item.name);if(item.isDirectory())visit(file);else result[path.relative(dir,file)]=createHash('sha256').update(fs.readFileSync(file)).digest('hex');}}
 visit(dir);return result;
}
function run(entry:string,version?:string){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-admission-'));
 try{
  for(const name of ['tenant.db','platform.db']){const db=new DatabaseSync(path.join(dir,name));db.exec("CREATE TABLE runtime_sentinel(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO runtime_sentinel VALUES(1,'synthetic original')");db.close();}
  const before=inventory(dir);
  const child=spawnSync(process.execPath,['--import','tsx','tests/helpers/runtime-startup-worker.ts',entry],{encoding:'utf8',timeout:20000,maxBuffer:1024*1024,
   env:{...process.env,NODE_ENV:'test',DEPLOY_MODE:'node',TZ:'Asia/Manila',DB_PATH:path.join(dir,'tenant.db'),PLATFORM_DB_PATH:path.join(dir,'platform.db'),DATA_DIR:path.join(dir,'tenants'),UPLOAD_DIR:path.join(dir,'uploads'),BACKUP_DIR:path.join(dir,'backups'),LAN_TLS_DIR:path.join(dir,'tls'),RUNTIME_TEST_VERSION:version??''}});
  const after=inventory(dir),line=child.stdout.split('\n').find(l=>l.startsWith('RUNTIME_RESULT '));
  const record={entry,version:version??process.versions.node,status:child.status,signal:child.signal,error:child.error?.message,result:line?JSON.parse(line.slice(15)):null,before,after,stdout:child.stdout,stderr:child.stderr};
  const evidence=process.env.RUNTIME_EVIDENCE_DIR;
  if(evidence){fs.mkdirSync(evidence,{recursive:true});fs.writeFileSync(path.join(evidence,entry+'-'+(version??'actual')+'.json'),JSON.stringify(record,null,2)+'\n');}
  expect(child.error,child.stderr).toBeUndefined();return record;
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
}
for(const entry of ['tenant','catalog','server','maintenance']){
 it('refuses Node 22.13 before '+entry+' touches files or binds HTTP',()=>{
  const r=run(entry,'22.13.0');expect(r.status,r.stdout+'\n'+r.stderr).toBe(1);
  expect(r.result).toMatchObject({state:'refused',code:'UNSUPPORTED_NODE_RUNTIME'});expect(r.after).toEqual(r.before);
 });
}
for(const version of ['22.21.9','24.18.9','23.11.0','25.2.0','26.0.0','24.19.0-pre']){
 it('does not infer production support for '+version,()=>{
  const r=run('tenant',version);expect(r.status,r.stdout+'\n'+r.stderr).toBe(1);expect(r.result).toMatchObject({code:'UNSUPPORTED_NODE_RUNTIME'});expect(r.after).toEqual(r.before);
 });
}
it('admits the actual supported runtime and initializes usable tenant data',()=>{
 const r=run('tenant');expect(r.status,r.stdout+'\n'+r.stderr).toBe(0);expect(r.result).toMatchObject({state:'admitted'});expect(r.after).not.toEqual(r.before);
});
