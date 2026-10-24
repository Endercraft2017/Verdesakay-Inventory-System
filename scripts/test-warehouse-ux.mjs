// Mobile warehouse task audit: disposable real API/DB fixtures, paired browser baselines and stock invariants.
// Independent database/API/browser oracle for Home's operational preview. No operational DB.
import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';import assert from 'node:assert/strict';import {spawn,execFileSync} from 'node:child_process';import {DatabaseSync} from 'node:sqlite';import {chromium} from 'playwright';
import { runWarehouseTasks } from './browser/warehouse-tasks.mjs';
import { runKitReleaseTasks } from './browser/kit-release-tasks.mjs';
const out=process.env.WAREHOUSE_UX_OUTPUT||'work/warehouse-ux/current';fs.mkdirSync(out,{recursive:true});const report={checks:[],failures:[],errors:[],oracles:[],profiles:[],cases:[],mutation:process.env.HOME_AUDIT_MUTATION||null,sourceHashes:{},mutationApplied:[]};
for(const file of ['public/mobile/modules/core/home.js','public/mobile/modules/hr/work.js','public/mobile/modules/manufacturing/receiving.js'])report.sourceHashes[file]=createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const network=new Map();let contextNumber=0,activeCase='fixture';
// Read the original committed browser assets without checking out or changing the working tree.
if(process.env.WAREHOUSE_UX_BASELINE==='1'){
 report.baselineRef=process.env.WAREHOUSE_UX_BASELINE_REF||'45d0201';report.baselineSourceHashes={};
 for(const file of ['public/mobile/lib/role-ui.js','public/mobile/mobile-v2.css','public/mobile/modules/manufacturing/repairs.js','public/mobile/modules/manufacturing/kit-release.js','public/mobile/modules/manufacturing/qc.js','public/mobile/modules/manufacturing/receiving.js','public/mobile/modules/inventory/so.js','public/mobile/modules/inventory/release-actions.js']){
  const dest='work/warehouse-ux/baseline-source/'+file;fs.mkdirSync(path.dirname(dest),{recursive:true});
  const source=execFileSync('git',['show',report.baselineRef+':'+file]);fs.writeFileSync(dest,source);report.baselineSourceHashes[file]=createHash('sha256').update(source).digest('hex');
 }
}
const slug=s=>s.toLowerCase().replace(/[^a-z0-9]+/g,'-').slice(0,95);
function databaseSnapshot(){return {stock:db.prepare('SELECT item_id,location_id,quantity FROM inventory_stock ORDER BY item_id,location_id').all(),units:db.prepare('SELECT id,status,stage FROM job_order_units ORDER BY id').all(),requests:db.prepare('SELECT id,status,decided_by FROM repair_part_requests ORDER BY id').all(),receipts:db.prepare('SELECT COUNT(*) AS n FROM production_receipts').get().n};}

const server=spawn(process.execPath,['--import','tsx','--input-type=module','-e',"await import('./scripts/browser/editor-ux-server.ts'); console.log('HOME_AUDIT_DB='+process.env.DB_PATH)"],{stdio:['ignore','pipe','pipe']});let browser,db,admin,base;const contexts=[];let p;
server.stderr.on('data',d=>fs.appendFileSync(out+'/server.log',d));const timer=setTimeout(()=>{server.kill();process.exit(1);},300000);
try{
 const config=await new Promise((resolve,reject)=>{let log='';server.stdout.on('data',d=>{log+=d;const port=log.match(/EDITOR_UX_PORT=(\d+)/),file=log.match(/HOME_AUDIT_DB=(.+)/);if(port&&file)resolve({port:port[1],file:file[1].trim()});});server.on('exit',n=>reject(Error('Fixture exited '+n)));});base='http://127.0.0.1:'+config.port;
 async function api(method,url,data,token=admin,status){const r=await fetch(base+'/api'+url,{method,headers:{Authorization:'Bearer '+(token||''),...(data instanceof FormData?{}:{'Content-Type':'application/json'})},...(data===undefined?{}:{body:data instanceof FormData?data:JSON.stringify(data)})});const b=await r.json();if(/\/(qc\/queue|qc\/holds|rts\/queue|production\/repairs|job-orders)/.test(url))fs.appendFileSync(out+'/api-events.jsonl',JSON.stringify({case:activeCase,method,path:url,status:r.status,response:method==='GET'?b:undefined})+'\n');assert(status?r.status===status:r.ok,url+': '+r.status+' '+JSON.stringify(b));return b;}
 const sql=(q,...args)=>db.prepare(q).all(...args);
 admin=(await api('POST','/auth/login',{username:'admin',password:'admin123'},'')).token;db=new DatabaseSync(config.file,{readOnly:true});
 async function user(name,permissions){await api('POST','/roles',{key:name,label:name,permissions:['mobile.access',...permissions]});const u=await api('POST','/users',{username:name,password:'fixture-password',full_name:name,role:name});const token=(await api('POST','/auth/login',{username:name,password:'fixture-password'},'')).token;const profile=(await api('GET','/auth/me',undefined,token)).user;report.profiles.push({id:profile.id,role:profile.role,permissions:profile.permissions,modules:profile.modules});return {...u,token};}
 const grants={kits:'production.kit_release',parts:'production.repairs',qc:'production.inspect_qc',qa:'production.inspect_qa',rts:'production.receive',holds:'production.qa_review'},users={};for(const [key,grant]of Object.entries(grants))users[key]=await user('home_audit_'+key,[grant]);users.basic=await user('home_audit_basic',[]);users.all=await user('home_audit_all',Object.values(grants));
 const part=await api('POST','/inventory',{name:'Audit replacement frame',quantity:30}),product=await api('POST','/inventory',{name:'Audit finished product',quantity:0});await api('PUT','/finished-products/'+product.id,{components:[{component_item_id:part.id,quantity:1}]});
 async function makeJob(qty,stages,release=true){const j=await api('POST','/job-orders',{product_item_id:product.id,qty_ordered:qty,qc_stages:stages});await api('POST','/job-orders/'+j.id+'/approve');if(release){await api('POST','/job-orders/warehouse-accept',{job_order_ids:[j.id]});await api('POST','/job-orders/prepare',{job_orders:[{id:j.id}]});await api('POST','/job-orders/'+j.id+'/release');await api('POST','/job-orders/'+j.id+'/accept',{});}return j;}
 const jo=await makeJob(5,2),units=[];const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6gAAAAABJRU5ErkJggg==','base64');
 for(let i=0;i<5;i++){const fd=new FormData();fd.append('identifier','AUDIT-UNIT-'+i);fd.append('image',new Blob([png],{type:'image/png'}),'unit.png');units.push(await api('POST','/job-orders/'+jo.id+'/units',fd));}
 async function evidence(unit){const fd=new FormData();fd.append('kind','qc_unit');fd.append('ref_id',String(unit.id));fd.append('image',new Blob([png],{type:'image/png'}),'defect.png');return (await api('POST','/attachments',fd)).id;}
 await api('POST','/job-orders/'+jo.id+'/units/inspect',{unit_ids:[units[1].id],inspection_stage:1,result:'fail',disposition:'repair',remarks:'Frame repair requires a part',evidence_ids:[await evidence(units[1])]});
 const repair=await api('POST','/production/units/'+units[1].id+'/repairs',{kind:'add',component_item_id:part.id,quantity:1,notes:'Audit requested part'});
 for(const stage of [1,2])await api('POST','/job-orders/'+jo.id+'/units/inspect',{unit_ids:[units[2].id,units[3].id],inspection_stage:stage,result:'pass'});
 await api('POST','/job-orders/'+jo.id+'/units/inspect',{unit_ids:[units[4].id],inspection_stage:2,result:'fail',disposition:'hold',remarks:'Appearance requires hold review',evidence_ids:[await evidence(units[4])]});
 const mismatch=await api('POST','/production-issues',{job_order_id:jo.id,unit_id:units[3].id,category:'Product-data mismatch',severity:'high',description:'Physical model differs from production record'});
 const bulk=await makeJob(10,0);await api('POST','/job-orders/'+bulk.id+'/progress',{done_delta:10});const rec=await api('GET','/job-orders/'+bulk.id+'/receivable'),batch=rec.batches[0],location=rec.output_location_id;
 await api('POST','/job-orders/'+bulk.id+'/products-in',{batch_id:batch.id,quantity:3,location_id:location});
 const kit=await makeJob(1,2,false),cancelled=await api('POST','/job-orders',{product_item_id:product.id,qty_ordered:1,qc_stages:2});await api('POST','/job-orders/'+cancelled.id+'/cancel',{reason:'Audit cancellation'});
 const releaser=await user('warehouse_ux_releasing',['orders.release']);
 const sale=await api('POST','/orders',{type:'sale',status:'open',customer_name:'Warehouse UX fixture',items:[{item_id:part.id,name:'Replacement frame',quantity:1,unit_price:100}]});
 await api('POST','/orders/'+sale.id+'/status',{status:'approved'});
 await api('POST','/release-slips/orders/'+sale.id+'/authorizations',{mode:'pickup',recipient_name:'Fixture recipient',valid_hours:8,partial_allowed:false});
 report.fixture={kit,repair,sale,batch,units};
 for(const file of ['public/mobile/lib/role-ui.js','public/mobile/modules/manufacturing/kit-release.js','public/mobile/modules/manufacturing/qc.js','public/mobile/modules/manufacturing/repairs.js','public/mobile/modules/inventory/so.js','public/mobile/modules/inventory/release-actions.js'])
   report.sourceHashes[file]=createHash('sha256').update(fs.readFileSync(file)).digest('hex');
 browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true});
 async function open(who,route,setup){
   const c=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:'block'});contexts.push(c);
   const events=[],label=String(++contextNumber).padStart(2,'0');network.set(c,{events,label});
   await c.tracing.start({screenshots:true,snapshots:true,sources:true});
   c.on('request',r=>{if(r.url().includes('/api/'))events.push({type:'request',method:r.method(),path:new URL(r.url()).pathname});});
   c.on('response',async r=>{if(r.url().includes('/api/')){const e={type:'response',method:r.request().method(),path:new URL(r.url()).pathname,status:r.status()};events.push(e);if(/queue|availability|\/context|repair-history/.test(e.path))try{e.body=await r.json();}catch{}}});
   await c.addInitScript(t=>localStorage.setItem('vds_token',t),who.token);
   if(process.env.WAREHOUSE_UX_BASELINE==='1')await c.route('**/mobile/**',route=>{
     const file='work/warehouse-ux/baseline-source/public'+new URL(route.request().url()).pathname;
     if(!fs.existsSync(file)||!fs.statSync(file).isFile())return route.continue();
     report.servedBaseline=true;report.sourceHashes[file]=createHash('sha256').update(fs.readFileSync(file)).digest('hex');
     return route.fulfill({path:file,contentType:file.endsWith('.css')?'text/css':'text/javascript'});
   });
   if(setup)await setup(c);
   const page=await c.newPage();p=page;page.setDefaultTimeout(5000);page.on('pageerror',e=>report.errors.push(e.message));
   await page.goto(base+'/m#/'+route);
   await page.locator('#m-view .rk-page,#m-view .v2-home,#m-view .m-error,#m-view .rk-error').first().waitFor();
   return {page,c};
 }
 async function check(name,fn){
   activeCase=name;const entry={name,before:databaseSnapshot()};report.cases.push(entry);
   try{await fn(entry);entry.result='passed';report.checks.push(name);console.log('PASS '+name);}
   catch(e){entry.result='failed';entry.error=e.stack;report.failures.push({name,error:e.stack});console.error('FAIL '+name+': '+e.message);}
   finally{entry.after=databaseSnapshot();for(const c of contexts.splice(0)){const {events,label}=network.get(c),stem=slug(name)+'-'+label;for(const [i,page]of c.pages().entries())if(!page.isClosed())await page.screenshot({path:out+'/'+stem+'-'+i+'.png',fullPage:true});await c.tracing.stop({path:out+'/'+stem+'.zip'});await c.close();fs.writeFileSync(out+'/'+stem+'.network.json',JSON.stringify(events,null,2));}}
 }
 const writes=c=>network.get(c).events.filter(e=>e.type==='request'&&e.method!=='GET');
 const query=page=>new URLSearchParams(new URL(page.url()).hash.split('?')[1]);
 async function toConfirmation(page,entry){
   entry.transitions=[];
   for(let i=0;i<7;i++){
     const action=page.locator('#rp-go,#rp-post').first();
     await action.waitFor();
     const button=await action.evaluate(e=>({id:e.id,label:e.textContent}));
     if(button.id==='rp-post')return;
     entry.transitions.push({hash:new URL(page.url()).hash,label:button.label});
     const previous=page.url();
     await page.locator('#rp-go').click();
     await page.waitForURL(u=>u.href!==previous);
   }
   throw Error('Confirmation not reachable');
 }
 if(process.env.WAREHOUSE_KIT_UX==='1'){
   const purchasing=await user('kit_ux_purchasing',['purchasing.manage']),receiving=await user('kit_ux_receiving',['inventory.receive']);
   await runKitReleaseTasks({api,sql,open,check,users,purchasing,receiving,location,out,report});
 }else if(process.env.WAREHOUSE_UX_TASKS==='1'){
   await runWarehouseTasks({api,sql,open,check,users,kit,repair,part,product,bulk,batch,location,makeJob,png,out,report});
 }else{
 await check('Kit queue opens existing picking work instead of an empty Ready tab',async()=>{
   const {page,c}=await open(users.kits,'kit-release');
   await page.locator('.rk-tabs').waitFor();assert.equal((await api('GET','/job-orders?stage=awaiting_release',undefined,users.kits.token)).length,1);
   assert.equal(await page.locator('.rk-tabs .on').getAttribute('data-tab'),'preparing');
   await page.locator('[data-id="'+kit.id+'"]').waitFor();assert.equal(writes(c).length,0);
 });
 await check('Release queue exposes unaccepted work and explains an explicitly empty Ready view',async()=>{
   const q=await api('GET','/release-slips/queue',undefined,releaser.token);assert(q.to_accept.some(r=>r.id===sale.id));assert.equal(q.releasing.length,0);
   const {page,c}=await open(releaser,'so');await page.locator('.rk-segs').waitFor();
   assert.equal(await page.locator('.rk-segs .on').getAttribute('data-tab'),'accept');
   await page.locator('[data-order="'+sale.id+'"]').waitFor();
   await page.screenshot({path:out+'/release-landing.png',fullPage:true});
   await page.locator('[data-tab=ready]').click();
   assert((await page.locator('[data-list]').innerText()).includes('No orders ready for handoff'));
   assert.equal(writes(c).length,0);
 });
 await check('RTS queue counts serialized units separately from remaining batch pieces and held units',async()=>{
   const q=await api('GET','/rts/queue',undefined,users.rts.token);
   assert.equal(q.units.filter(u=>!u.hold).length,1);assert.equal(q.batches[0].remaining_qty,7);
   const {page,c}=await open(users.rts,'receiving');await page.locator('.rk-hero').waitFor();
   assert((await page.locator('.rk-hero').innerText()).includes('1 unit · 1 batch (7 pcs)'));
   await page.locator('[data-tab=issues]').click();await page.locator('[data-jo="'+jo.id+'"]').waitFor();
   const held=await page.locator('[data-jo="'+jo.id+'"]').innerText();
   assert(held.includes('1 unit on hold'));assert(!held.includes('eligible'));
   assert.equal(writes(c).length,0);
 });
 await check('QC and QA show the parts blocker before opening a job or unit',async()=>{
   for(const [who,role]of [[users.qc,'qc'],[users.qa,'qa']]){
     const {page}=await open(who,'qc?role='+role+'&tab=re');
     const group=page.locator('[data-jo="'+jo.id+'"]');await group.waitFor();
     assert((await group.innerText()).includes('1 waiting for parts'));
     assert(!(await group.innerText()).includes('eligible'));
     await group.click();
     const card=page.locator('[data-unit="'+units[1].id+'"]');await card.waitFor();
     assert((await card.innerText()).includes('Waiting for parts'));
     await card.click();await page.locator('#qc-start').waitFor();assert(await page.locator('#qc-start').isDisabled());
     await api('POST','/job-orders/'+jo.id+'/units/inspect',{unit_ids:[units[1].id],inspection_stage:role==='qc'?1:2,result:'pass'},who.token,409);
   }
 });
 await check('Selected queue survives opening a record, browser Back and refresh',async()=>{
   for(const [who,route,tab,selector]of [[users.kits,'kit-release','preparing','[data-id="'+kit.id+'"]'],[users.qc,'qc?role=qc','re','[data-jo="'+jo.id+'"]'],[users.rts,'receiving','issues','[data-jo="'+jo.id+'"]'],[releaser,'so','accept','[data-order="'+sale.id+'"]']]){
     const {page}=await open(who,route);await page.locator('[data-tab="'+tab+'"]').click();
     assert.equal(query(page).get('tab'),tab);
     await page.locator(selector).click();await page.waitForURL(u=>u.hash!==new URL(base+'/m#/'+route).hash&&u.hash.includes('id=')||u.hash.includes('jo='));
     await page.goBack();await page.locator(selector).waitFor();
     assert.equal(await page.locator('#m-view [data-tab].on').first().getAttribute('data-tab'),tab);
     await page.reload();await page.locator(selector).waitFor();assert.equal(query(page).get('tab'),tab);
   }
 });
 await check('Parts review reaches final confirmation with three transitions and no stock write',async entry=>{
   const {page,c}=await open(users.parts,'repairs?id='+repair.id);
   await toConfirmation(page,entry);entry.transitionCount=entry.transitions.length;
   assert(entry.transitionCount<=3,'Unnecessary review transitions: '+entry.transitionCount);
   const text=await page.locator('#m-view').innerText();
   assert(text.includes(repair.number));assert(text.includes('remaining'));assert(text.includes('Stock'));
   assert(await page.locator('#rp-post').isDisabled());assert.equal(writes(c).length,0);
 });
 await check('Parts quantity rejects fractional input without silently truncating it',async()=>{
   const {page}=await open(users.parts,'repairs?id='+repair.id+'&step=source');await page.locator('#rp-go').click();
   await page.locator('[data-qty]').fill('1.5');await page.locator('#rp-go').click();
   assert.equal(query(page).get('step'),'pick');
   assert.equal(await page.locator('[data-qty]').inputValue(),'1.5');
   assert.equal(await page.locator('[data-qty]').getAttribute('aria-invalid'),'true');
   assert((await page.locator('[data-pick-error]').innerText()).includes('1 requested'));
 });
 await check('Parts loader cannot replace Home after navigation when a delayed read succeeds or fails',async()=>{
   for(const fail of [false,true]){
     let release,started;const held=new Promise(r=>release=r),seen=new Promise(r=>started=r);
     const {page,c}=await open(users.parts,'home',async c=>c.route('**/api/production/repairs/'+repair.id+'/context',async route=>{const response=fail?null:await route.fetch();started();await held;await (fail?route.fulfill({status:503,json:{error:'Delayed read failure'}}):route.fulfill({response})).catch(()=>{});}));
     await page.evaluate(id=>MApp.go('repairs',{id}),repair.id);await seen;
     await page.evaluate(()=>MApp.go('home'));await page.locator('.v2-home').waitFor();release();
     await page.waitForTimeout(200);assert.equal(await page.locator('.v2-home').count(),1);
   }
 });
 await check('Failed parts reads offer retry; retry restores the same request without a write',async()=>{
   let failing=true;
   const {page,c}=await open(users.parts,'repairs?id='+repair.id,async c=>c.route('**/api/production/repairs/'+repair.id+'/context',route=>failing?route.fulfill({status:503,json:{error:'Request unavailable'}}):route.continue()));
   await page.locator('.rk-error').waitFor();assert.equal(writes(c).length,0);failing=false;
   await page.getByRole('button',{name:'Try again',exact:true}).click();await page.locator('#rp-go').waitFor();
   assert((await page.locator('#m-view').innerText()).includes(repair.number));assert.equal(writes(c).length,0);
 });
 await check('Final issue preserves the explicit confirmation, exact quantity and one stock movement',async()=>{
   const cxt=await api('GET','/production/repairs/'+repair.id+'/context',undefined,users.parts.token),src=cxt.sources.find(l=>l.approved&&l.free>=1);
   const before=sql('SELECT quantity FROM inventory_stock WHERE item_id=? AND location_id=?',part.id,src.id)[0].quantity;
   await api('POST','/production/repairs/'+repair.id+'/accept',{from_location_id:src.id,picked_quantity:1.5},users.parts.token,400);
   await api('POST','/production/repairs/'+repair.id+'/accept',{from_location_id:src.id,picked_quantity:1},users.basic.token,403);
   const {page,c}=await open(users.parts,'repairs?id='+repair.id);await toConfirmation(page,{});
   assert(await page.locator('#rp-post').isDisabled());await page.locator('#rp-ok').check();await page.locator('#rp-post').click();
   await page.getByText('Repair part issued',{exact:true}).waitFor();
   assert.equal(sql('SELECT status FROM repair_part_requests WHERE id=?',repair.id)[0].status,'accepted');
   assert.equal(sql('SELECT quantity FROM inventory_stock WHERE item_id=? AND location_id=?',part.id,src.id)[0].quantity,before-1);
   assert.equal(writes(c).filter(e=>e.path.endsWith('/accept')).length,1);
   await api('POST','/production/repairs/'+repair.id+'/accept',{from_location_id:src.id,picked_quantity:1},users.parts.token,409);
   assert.equal(sql('SELECT quantity FROM inventory_stock WHERE item_id=? AND location_id=?',part.id,src.id)[0].quantity,before-1);
 });
 await check('Completed and empty parts queues explain status and offer no issue action',async()=>{
   const {page,c}=await open(users.parts,'repairs?id='+repair.id);await page.getByText('This request is already accepted.',{exact:true}).waitFor();
   assert.equal(await page.locator('#rp-post,#rp-go').count(),0);
   await page.locator('#rp-back').click();await page.locator('[data-list] .rk-empty').waitFor();assert.equal(writes(c).length,0);
 });
 await check('Narrow and basic permissions cannot expose another warehouse action',async()=>{
   for(const route of ['repairs','kit-release','qc?role=qc','receiving','so']){
     const {page,c}=await open(users.basic,route);await page.getByText(/permission|access|not allowed/i).first().waitFor();assert.equal(writes(c).length,0);
   }
   await api('GET','/production/repairs/'+repair.id+'/context',undefined,users.basic.token,403);
 });
 await check('Existing queues remain usable in dark and light themes at narrow width',async()=>{
   for(const theme of ['light','dark']){
     const {page}=await open(users.rts,'receiving');await page.locator('.rk-hero').waitFor();
     await page.evaluate(theme=>document.documentElement.setAttribute('data-theme',theme),theme);
     await page.setViewportSize({width:360,height:800});
     assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
     await page.screenshot({path:out+'/receiving-'+theme+'-360.png',fullPage:true});
     await page.locator('#rts-look').click();
     await page.waitForURL(u=>new URLSearchParams(u.hash.split('?')[1]).get('step')==='lookup');
   }
 });
 await check('Warehouse status buttons have touch-sized targets and work with keyboard activation',async()=>{
   for(const [who,route]of [[users.kits,'kit-release'],[users.parts,'repairs'],[users.qc,'qc?role=qc'],[users.qa,'qc?role=qa'],[users.rts,'receiving'],[releaser,'so']]){
     const {page}=await open(who,route);const buttons=page.locator('#m-view [data-tab]');await buttons.first().waitFor();
     for(const b of await buttons.all())assert((await b.boundingBox()).height>=44,'Status filter below 44px');
     const target=buttons.last(),tab=await target.getAttribute('data-tab');await target.focus();await page.keyboard.press('Enter');
     assert.equal(await target.getAttribute('aria-pressed'),'true');assert.equal(query(page).get('tab'),tab);
     assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   }
 });
 await check('A pending revision is visibly blocked even through an old confirmation link',async()=>{
   const request=await api('POST','/production/units/'+units[1].id+'/repairs',{kind:'add',component_item_id:part.id,quantity:1,notes:'Revision waiting fixture'});
   const revision=await api('POST','/production/repairs/'+request.id+'/revision',{component_item_id:part.id,quantity:2,reason:'Requester must approve the changed count'},users.parts.token);
   const {page,c}=await open(users.parts,'repairs?id='+request.id+'&step=confirm');
   await page.getByText('Revision waiting for approval — cannot issue yet',{exact:true}).waitFor();
   assert.equal(await page.locator('#rp-go,#rp-post').count(),0);assert.equal(writes(c).length,0);
   const before=databaseSnapshot();
   await api('POST','/production/repairs/'+request.id+'/accept',{from_location_id:location,picked_quantity:1},users.parts.token,409);
   assert.deepEqual(databaseSnapshot(),before);
 });
 await check('Only reinspection or held RTS work opens directly instead of an empty Ready status',async()=>{
   for(const stage of [1,2])await api('POST','/job-orders/'+jo.id+'/units/inspect',{unit_ids:[units[0].id],inspection_stage:stage,result:'pass'});
   for(const [who,role]of [[users.qc,'qc'],[users.qa,'qa']]){
     const q=await api('GET','/qc/queue?role='+role,undefined,who.token);assert(q.units.length>0&&q.units.every(u=>u.status==='rework'));
     const {page}=await open(who,'qc?role='+role);await page.locator('[data-jo]').first().waitFor();
     assert.equal(await page.locator('#m-view [data-tab].on').getAttribute('data-tab'),'re');
   }
   await api('POST','/job-orders/'+jo.id+'/products-in',{unit_ids:[units[0].id,units[2].id],location_id:location});
   await api('POST','/job-orders/'+bulk.id+'/products-in',{batch_id:batch.id,quantity:7,location_id:location});
   const q=await api('GET','/rts/queue',undefined,users.rts.token);assert.equal(q.batches.length,0);assert(q.units.length>0&&q.units.every(u=>u.hold));
   const {page}=await open(users.rts,'receiving');await page.locator('[data-jo]').first().waitFor();
   assert.equal(await page.locator('#m-view [data-tab].on').getAttribute('data-tab'),'issues');
   assert((await page.locator('.rk-hero').innerText()).includes('0 units'));
   assert((await page.locator('[data-list]').innerText()).includes('on hold'));
 });
 await check('A stock-short parts request opens Shortage and explains why it cannot be issued',async()=>{
   for(const request of await api('GET','/production/repairs?status=requested',undefined,users.parts.token))
     await api('POST','/production/repairs/'+request.id+'/reject',{warehouse_remarks:'Close disposable revision fixture'},users.parts.token);
   const missing=await api('POST','/inventory',{name:'Out-of-stock fixture part',quantity:0});
   const request=await api('POST','/production/units/'+units[1].id+'/repairs',{kind:'add',component_item_id:missing.id,quantity:1,notes:'No available stock fixture'});
   const context=await api('GET','/production/repairs/'+request.id+'/context',undefined,users.parts.token);
   assert(context.shortage&&context.sources.every(l=>!l.approved||l.free<1));
   const {page,c}=await open(users.parts,'repairs');await page.locator('.rk-segs').waitFor();
   assert.equal(await page.locator('#m-view [data-tab].on').getAttribute('data-tab'),'short');
   await page.locator('[data-req="'+request.id+'"]').click();await page.getByRole('button',{name:'Review stock shortage',exact:true}).click();
   await page.waitForURL(u=>new URLSearchParams(u.hash.split('?')[1]).get('step')==='shortage');
   assert.equal(await page.locator('#rp-post').count(),0);assert.equal(writes(c).length,0);
 });
 }
 assert.deepEqual(report.errors,[]);if(report.failures.length)process.exitCode=1;
}catch(e){report.fatal=e.stack;console.error(e);process.exitCode=1;}
finally{for(const c of contexts)await c.close();await browser?.close();db?.close();server.kill();clearTimeout(timer);fs.writeFileSync(out+'/report.json',JSON.stringify(report,null,2));}
