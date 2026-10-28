if(process.argv.includes('--review=otom-theme')){const helpers=await import('./ui-scratch/build.mjs');await(await import('./otom-theme/preview.mjs')).generate(helpers);process.exit(0);}
// Rebuilds only the owned, ignored work/ui-scratch directory. UI code is copied
// verbatim; records are captured from an isolated real backend, then replayed offline.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright/test';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
process.chdir(repo);
const work=path.join(repo,'work'),out=path.join(work,'ui-scratch'),owner='otom-ui-scratch-v1';
for(const dir of [work,out])if(fs.existsSync(dir))assert(!fs.lstatSync(dir).isSymbolicLink(),'Refusing scratch cleanup through a symlink: '+dir);
if(fs.existsSync(out))assert.equal(fs.readFileSync(path.join(out,'.generated-owner'),'utf8'),owner,'Refusing to wipe a directory not owned by the scratch builder');
fs.rmSync(out,{recursive:true,force:true});fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'.generated-owner'),owner);
const manifest={generatedAt:new Date().toISOString(),entry:'index.html',source:'Current uncommitted app HTML/CSS/JS and image assets, copied verbatim',files:[],fixtures:{},limits:['Disposable backend records captured during build; browser preview replays GETs offline.','Notification markers, shortcut preferences and the sample BOM may change isolated memory. All other business writes are blocked.','Browser storage is in memory; reset/scenario changes discard drafts. No persistence, camera, GPS, hardware or live backend claim.']};
const scriptTag=code=>'<script>'+code.replace(/<\/script/gi,'<\\/script')+'</script>';
function readAsset(url){assert(url.startsWith('/')&&!url.includes('..'));const file=path.join(repo,'public',url);const text=fs.readFileSync(file,'utf8');manifest.files.push({path:'public'+url,sha256:createHash('sha256').update(text).digest('hex')});return text;}
const assets={};
function bundleImages(directory){for(const entry of fs.readdirSync(directory,{withFileTypes:true})){const file=path.join(directory,entry.name);if(entry.isDirectory()){bundleImages(file);continue;}const ext=path.extname(file).toLowerCase(),mime={'.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.avif':'image/avif'}[ext];if(!mime)continue;const bytes=fs.readFileSync(file),url='/'+path.relative(path.join(repo,'public'),file).split(path.sep).join('/');assets[url]='data:'+mime+';base64,'+bytes.toString('base64');manifest.files.push({path:'public'+url,sha256:createHash('sha256').update(bytes).digest('hex')});}}
bundleImages(path.join(repo,'public/mobile/icons'));
let app=readAsset('/mobile/index.html');
app=app.replace(/<script\s+src="([^"]+)"\s*><\/script>/g,(_all,url)=>scriptTag(readAsset(url)+'\n//# sourceURL=scratch-source'+url));
app=app.replace(/<link\s+rel="stylesheet"\s+href="([^"]+)"\s*\/?\s*>/g,(_all,url)=>'<style>'+readAsset(url).replace(/<\/style/gi,'<\\/style')+'</style>');
app=app.replace(/<link\s+rel="(?:manifest|apple-touch-icon)"[^>]*>/g,'');
const memoryDb=await build({stdin:{contents:"import * as db from 'fake-indexeddb';for(const [key,value] of Object.entries(db)){if(key.startsWith('IDB')||key==='indexedDB')Object.defineProperty(window,key,{configurable:true,value});}",resolveDir:repo},bundle:true,write:false,format:'iife',minify:true});
const runtime=fs.readFileSync(path.join(repo,'scripts/browser/ui-scratch-runtime.js'),'utf8');
const shell=fs.readFileSync(path.join(repo,'scripts/browser/ui-scratch.html'),'utf8');
let browser,server;const contexts=[];
const timer=setTimeout(()=>{server?.kill();process.exit(1);},300000);
try{
 server=spawn(process.execPath,['--import','tsx','--input-type=module','-e',"await import('./scripts/browser/editor-ux-server.ts');console.log('SCRATCH_DB='+process.env.DB_PATH)"],{cwd:repo,stdio:['ignore','pipe','pipe']});
 server.stderr.on('data',d=>fs.appendFileSync(path.join(out,'fixture.log'),d));
 const config=await new Promise((resolve,reject)=>{let log='';server.stdout.on('data',d=>{log+=d;const port=log.match(/EDITOR_UX_PORT=(\d+)/),db=log.match(/SCRATCH_DB=(.+)/);if(port&&db)resolve({port:port[1],db:db[1].trim()});});server.on('exit',code=>reject(Error('Scratch fixture exited '+code)));});
 const base='http://127.0.0.1:'+config.port;let admin;
 async function api(method,url,data,token=admin){const form=data instanceof FormData;const response=await fetch(base+'/api'+url,{method,headers:{Authorization:'Bearer '+(token||''),...(!form?{'Content-Type':'application/json'}:{})},...(data===undefined?{}:{body:form?data:JSON.stringify(data)})});const body=await response.json();assert(response.ok,url+': '+response.status+' '+JSON.stringify(body));return body;}
 admin=(await api('POST','/auth/login',{username:'admin',password:'admin123'},'')).token;
 async function user(key,name,permissions){await api('POST','/roles',{key,label:name+' · scratch',permissions:['mobile.access',...permissions]});await api('POST','/users',{username:key,full_name:name,password:'fixture-only-password',role:key});return (await api('POST','/auth/login',{username:key,password:'fixture-only-password'},'')).token;}
 const sales=await user('scratch_sales','Sales employee',['orders.view','orders.edit']);
 const warehouse=await user('scratch_warehouse','Parts and quality clerk',['orders.view','orders.release','production.kit_release','production.repairs','production.receive','production.inspect_qc','production.inspect_qa','inventory.view']);
 const basic=await user('scratch_basic','Employee',[]);
 const manager=await user('scratch_manager','HR manager',['hr.manage','inventory.view']);
 const managerId=(await api('GET','/auth/me',undefined,manager)).user.id;
 await api('POST','/hr/employees',{employee_no:'PREVIEW-HR-01',name:'Preview HR manager',user_id:managerId,daily_rate:500,rate_type:'daily',status:'regular'});
 const definitions=await api('GET','/form-definitions');
 if(!definitions.some(f=>f.slug==='leave_request'))await api('POST','/form-definitions',{name:'Leave Request',slug:'leave_request',number_prefix:'LV',icon:'calendar',scope:'hr',fields:[{key:'reason',label:'Reason',type:'text',required:true,options:[],default:''}]});
 const requester=await api('POST','/hr/employees',{employee_no:'PREVIEW-REQ-01',name:'Preview request employee',daily_rate:500,rate_type:'daily',status:'regular'});
 const leaveDefinition=(await api('GET','/form-definitions')).find(f=>f.slug==='leave_request');
 await api('POST','/form-records',{form_def_id:leaveDefinition.id,data:{employee_id:requester.id,reason:'Disposable request for refresh verification',leave_dates:'2026-11-09',employee_name:'Preview request employee'},status:'pending'});

 browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-features=BackForwardCache']});
 async function capture(key,token,details=false){
  const c=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,timezoneId:'Asia/Manila',serviceWorkers:'block'});contexts.push(c);const captured={},pending=new Set();
  c.on('response',response=>{if(!response.url().startsWith(base+'/api/')||response.request().method()!=='GET')return;const job=(async()=>{const url=new URL(response.url());url.searchParams.sort();try{captured[url.pathname+url.search]={status:response.status(),body:await response.json()};}catch{}})();pending.add(job);job.finally(()=>pending.delete(job));});
  await c.addInitScript(t=>{localStorage.setItem('vds_token',t);localStorage.setItem('vds_theme','dark');},token);
  const page=await c.newPage();page.setDefaultTimeout(9000);
  function quantities(){const db=new DatabaseSync(config.db,{readOnly:true});try{return db.prepare('SELECT id,quantity FROM inventory_items ORDER BY id').all();}finally{db.close();}}
  const stockBefore=['manager','administrator','warehouse'].includes(key)?quantities():null;
  async function workPage(){await page.goto(base+'/m#/work');await page.locator('[data-attention-refresh]').waitFor({state:'attached'});await page.waitForFunction(()=>document.querySelector('[data-attention-refresh]')?.disabled===false);}
  await workPage();
  if(details){const records=await page.locator('[data-work-attention] [data-work-record]').evaluateAll(rows=>rows.map(row=>({task:row.dataset.attention,record:row.dataset.workRecord})));for(const record of records){await page.goto(base+'/m#/work?task='+record.task+'&record='+encodeURIComponent(record.record));await page.waitForLoadState('networkidle');const action=page.locator('#work-open-action');if(await action.count()){await action.click();await page.waitForTimeout(200);}}}
  if(details&&key.startsWith('sales')){for(const order of await api('GET','/orders?type=sale',undefined,token)){await page.goto(base+'/m#/sales?id='+order.id);await page.waitForLoadState('networkidle');}}
  if(details&&key.startsWith('sales')){await page.goto(base+'/m#/sales?id=1&step=edit');await page.waitForLoadState('networkidle');}
  if(['administrator','warehouse','manager'].includes(key)){
   const routes=await page.evaluate(()=>MApp.routes());manifest.routes=routes;
   await page.evaluate(()=>{window.__captureReads=0;const get=API.get;API.get=function(...args){window.__captureReads++;return Promise.resolve(get.apply(this,args)).finally(()=>window.__captureReads--);};});
   const coverage=[];
   for(const route of routes){
    const allowed=await page.evaluate(route=>MApp.canOpen(route),route);
    if(!allowed&&key!=='administrator'){coverage.push({requested:route,allowed:false,state:'access boundary'});continue;}
    fs.appendFileSync(path.join(out,'fixture.log'),'Capture '+key+' '+route+'\n');
    await page.evaluate(route=>{mPersonalDraft.clear();window.__capturePrevious=document.querySelector('#m-view')?.firstElementChild;if(MApp.nav(route,{})===location.hash)MApp.render();else MApp.go(route);},route);
    await page.waitForFunction(()=>document.querySelector('#m-view')?.firstElementChild!==window.__capturePrevious);
    await page.waitForTimeout(100);await page.waitForFunction(()=>window.__captureReads===0);
    coverage.push(await page.evaluate(requested=>({requested,rendered:document.querySelector('#m-view')?.dataset.route,title:document.querySelector('#m-title')?.textContent,allowed:MApp.canOpen(requested)}),route));
   }
   manifest.routeCoverage=manifest.routeCoverage||{};manifest.routeCoverage[key]=coverage;
   if(['administrator','warehouse'].includes(key)){await page.goto(base+'/m?capture=kit-detail#/kit-release?id='+pickingJob.id);await page.waitForLoadState('networkidle');}
  }
  for(const route of ['approvals','directory','schedule','requests','time-fix','clock','payslips','inbox','settings','notes','guides']){await page.goto(base+'/m#/'+route);await page.waitForFunction(name=>document.querySelector('#m-view')?.dataset.route===name,route);await page.waitForLoadState('networkidle');}
  if(key.startsWith('sales')){const response=await fetch(base+'/api/customers',{headers:{Authorization:'Bearer '+token}}),body=await response.json();captured['/api/customers']={status:response.status,body};if(response.ok)for(const customer of body){const path='/customers/'+customer.id,r=await fetch(base+'/api'+path,{headers:{Authorization:'Bearer '+token}});captured['/api'+path]={status:r.status,body:await r.json()};}}
  if(key==='manager'){for(const route of ['low-stock','location','item?id='+part.id]){await page.goto(base+'/m#/'+route);await page.waitForFunction(name=>document.querySelector('#m-view')?.dataset.route===name,route.split('?')[0]);await page.waitForLoadState('networkidle');}}
  if(['administrator','warehouse'].includes(key)){for(const path of ['/locations','/finished-products',...((await api('GET','/finished-products',undefined,token)).map(p=>'/finished-products/'+p.id)),'/inventory?kind=all&q=Frame','/inventory?kind=all&q=Metro']){const response=await fetch(base+'/api'+path,{headers:{Authorization:'Bearer '+token}});captured['/api'+path]={status:response.status,body:await response.json()};}}
  // Capture the employee-scoped read contracts directly as well: a same-document
  // navigation can otherwise finish before its response body is recorded.
  for(const path of ['/me/approvals','/users','/me/schedule','/me/requests','/me/request-types','/me','/me/time-corrections','/hr/clock/my-status','/me/payslips']){const response=await fetch(base+'/api'+path,{headers:{Authorization:'Bearer '+token}});captured['/api'+path]={status:response.status,body:await response.json()};}
  if(key==='manager'){for(const path of ['/inventory?low=1','/locations','/inventory/'+part.id,'/inventory/'+product.id]){const response=await fetch(base+'/api'+path,{headers:{Authorization:'Bearer '+token}});captured['/api'+path]={status:response.status,body:await response.json()};}for(const location of captured['/api/locations'].body){const path='/locations/'+location.id,response=await fetch(base+'/api'+path,{headers:{Authorization:'Bearer '+token}});captured['/api'+path]={status:response.status,body:await response.json()};}}
  await page.goto(base+'/m#/notifications');await page.waitForLoadState('networkidle');var notices=await page.evaluate(()=>API.get('/notifications'));for(const notice of (notices.items||[]).slice(0,2))await page.evaluate(id=>API.get('/notifications/'+id),notice.id);
  await page.goto(base+'/m#/home');await page.locator('.v2-home').waitFor();await page.waitForLoadState('networkidle');
  await workPage();await page.getByRole('button',{name:'Open or move quick actions'}).click();await page.getByRole('button',{name:'Close quick actions',exact:true}).click();await page.locator('.v2-orbit-overlay').waitFor({state:'detached'});
  await Promise.all([...pending]);manifest.fixtures[key]={responses:Object.keys(captured).length,profile:captured['/api/auth/me']?.body?.user?.role};if(stockBefore){assert.deepEqual(quantities(),stockBefore,'Preview read capture changed inventory quantities');manifest.fixtures[key].inventoryQuantitiesUnchanged=true;}await c.close();return captured;
 }
 const fixtures={empty:await capture('empty',warehouse),basic:await capture('basic',basic)};
 for(const customer_name of ['Mendoza','Reyes']){const customer=await api('POST','/customers',{name:customer_name,notes:'Disposable preview customer'});await api('POST','/orders',{type:'sale',customer_id:customer.id,customer_name,items:[{name:'Service',quantity:1}]});}
 const part=await api('POST','/inventory',{name:'Frame component',quantity:40}),product=await api('POST','/inventory',{name:'Metro',quantity:0});
 await api('PUT','/finished-products/'+product.id,{components:[{component_item_id:part.id,quantity:1}]});
 async function makeJob(qty,stages,release=true){const j=await api('POST','/job-orders',{product_item_id:product.id,qty_ordered:qty,qc_stages:stages});await api('POST','/job-orders/'+j.id+'/approve');if(release){await api('POST','/job-orders/warehouse-accept',{job_order_ids:[j.id]});await api('POST','/job-orders/prepare',{job_orders:[{id:j.id}]});await api('POST','/job-orders/'+j.id+'/release');await api('POST','/job-orders/'+j.id+'/accept',{});}return j;}
 const job=await makeJob(3,2),png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6gAAAAABJRU5ErkJggg==','base64'),units=[];
 for(let i=0;i<3;i++){const fd=new FormData();fd.append('identifier','PREVIEW-UNIT-'+(i+1));fd.append('image',new Blob([png],{type:'image/png'}),'unit.png');units.push(await api('POST','/job-orders/'+job.id+'/units',fd));}
 for(const stage of [1,2])await api('POST','/job-orders/'+job.id+'/units/inspect',{unit_ids:[units[2].id],inspection_stage:stage,result:'pass'});
 const pickingJob=await makeJob(3,2,false);await api('POST','/job-orders/warehouse-accept',{job_order_ids:[pickingJob.id]});manifest.previewKitId=pickingJob.id;const bulk=await makeJob(5,0);await api('POST','/job-orders/'+bulk.id+'/progress',{done_delta:5});
 const w=new DatabaseSync(config.db);try{const id=(await api('GET','/auth/me',undefined,sales)).user.id;for(let i=0;i<43;i++)w.prepare('INSERT INTO notifications(user_id,title,body,url) VALUES(?,?,?,?)').run(id,i<42?'New HR request':'Request approved',i<22?'Leave request HR-0021':i<42?'Leave request HR-0022':'Your leave request',i<22?'#/approvals?id=21':i<42?'#/approvals?id=22':'#/notifications');}finally{w.close();}
 fixtures.sales=await capture('sales',sales,true);fixtures.warehouse=await capture('warehouse',warehouse,true);fixtures.manager=await capture('manager',manager);fixtures.administrator=await capture('administrator',admin);
 // A separate snapshot demonstrates actual pending and shortage facts without
 // changing the original two-open-order baseline used by Work regression checks.
 await api('POST','/orders',{type:'sale',status:'approved',customer_name:'Santos · waiting for warehouse',items:[{name:'Service arrangement',quantity:1}]});
 const unavailable=await api('POST','/inventory',{name:'Special-order component',quantity:0});
 await api('POST','/orders',{type:'sale',status:'approved',force:true,customer_name:'Garcia · special-order part',items:[{item_id:unavailable.id,name:'Special-order component',quantity:1}]});
 fixtures['sales-states']=await capture('sales-states',sales,true);
 const dbRead=new DatabaseSync(config.db,{readOnly:true});try{manifest.database={sales:dbRead.prepare("SELECT number,status,customer_name FROM orders WHERE type='sale'").all(),jobs:dbRead.prepare('SELECT number,status FROM job_orders').all(),unitCount:dbRead.prepare('SELECT COUNT(*) AS n FROM job_order_units').get().n};}finally{dbRead.close();}
 // No captured auth token/header is placed in the artifact. Only fixture GET bodies.
 const payload={app,assets,memoryDb:memoryDb.outputFiles[0].text,runtime,fixtures,manifest,license:fs.readFileSync('node_modules/fake-indexeddb/LICENSE','utf8')};
 const encoded=Buffer.from(JSON.stringify(payload)).toString('base64');
 fs.writeFileSync(path.join(out,'index.html'),shell.replace('__SCRATCH_PAYLOAD__',encoded));
 fs.writeFileSync(path.join(out,'source-manifest.json'),JSON.stringify(manifest,null,2));
 fs.writeFileSync(path.join(out,'fixture-responses.json'),JSON.stringify(fixtures,null,2));
 fs.copyFileSync('node_modules/fake-indexeddb/LICENSE',path.join(out,'fake-indexeddb-LICENSE'));
 console.log('Scratch preview rebuilt: '+path.join(out,'index.html'));
}finally{
 for(const c of contexts)await c.close().catch(()=>{});await browser?.close();
 if(server&&server.exitCode===null){const stopped=new Promise(resolve=>server.once('exit',resolve));server.kill();await stopped;}
 clearTimeout(timer);
}
