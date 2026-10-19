// Account-specific Work guide checks; all users and writes are in a disposable fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';import {chromium} from 'playwright';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const out=path.join(root,'work/mobile-work-guide');fs.mkdirSync(out,{recursive:true});
const server=spawn(process.execPath,['--import','tsx','scripts/browser/editor-ux-server.ts'],{cwd:root,stdio:['ignore','pipe','pipe']});
server.stderr.on('data',d=>fs.appendFileSync(path.join(out,'server.log'),d));
let browser,context;const report={checks:[],errors:[]};
const timer=setTimeout(()=>{server.kill();process.exit(1);},120000);
try {
 const port=await new Promise((resolve,reject)=>{let text='';server.stdout.on('data',d=>{text+=d;const m=text.match(/EDITOR_UX_PORT=(\d+)/);if(m)resolve(m[1]);});server.on('exit',c=>reject(Error('Fixture exited '+c)));});
 const base='http://127.0.0.1:'+port;let admin;
 async function api(method,url,data,token=admin){const r=await fetch(base+'/api'+url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(data===undefined?{}:{body:JSON.stringify(data)})});const body=await r.json();assert(r.ok,url+': '+r.status+' '+JSON.stringify(body));return body;}
 admin=(await api('POST','/auth/login',{username:'admin',password:'admin123'})).token;
 async function user(name,permissions){await api('POST','/roles',{key:name,label:name,permissions});const u=await api('POST','/users',{username:name,full_name:name,password:'Disposable-guide-123',role:name});return {...u,token:(await api('POST','/auth/login',{username:name,password:'Disposable-guide-123'})).token};}
 const qc=await user('work_guide_qc',['mobile.access','production.inspect_qc']);
 const personal=await user('work_guide_personal',['mobile.access']);
 browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 async function open(token){await context?.close();context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,reducedMotion:'reduce',serviceWorkers:'block'});await context.addInitScript(t=>localStorage.setItem('vds_token',t),token);const p=await context.newPage();p.setDefaultTimeout(15000);p.on('pageerror',e=>report.errors.push(e.message));await p.goto(base+'/m#/work');await p.waitForSelector('.v2-work-heading');return p;}
 let page=await open(admin);
 const visible=await page.locator('[data-work-guide]').evaluateAll(rows=>rows.map(r=>r.dataset.workGuideTitle));
 const labels=await page.locator('.v2-work-row b,.v2-work-tool').allTextContents();
 assert.deepEqual(visible,labels);
 await page.locator('#m-guide-start').click();
 assert.equal(await page.locator('[data-act=depth]').count(),0);
 assert((await page.locator('.guide-coach-text').innerText()).includes('only the tasks and tools currently shown'));
 for(const label of visible){await page.locator('[data-act=next]').click();assert.equal(await page.locator('.guide-coach h4').innerText(),label);assert((await page.locator('.guide-coach-text').innerText()).includes('Result / next step:'));if(label==='Receive PR'){assert((await page.locator('.guide-coach-text').innerText()).includes('supplier goods receipt'));await page.screenshot({path:path.join(out,'receive-pr.png')});}if(label==='RTS recording')assert((await page.locator('.guide-coach-text').innerText()).includes('not Receive PR'));}
 await page.locator('[data-act=next]').click();assert.equal(await page.locator('.guide-coach').count(),0);
 assert.equal(await page.evaluate(()=>MApp.currentLocation().name),'work');
 report.checks.push('Every displayed admin queue/tool has a distinct, read-only explanation');
 page=await open(qc.token);
 await page.locator('#m-guide-start').click();
 let steps=await page.evaluate(()=>MobileGuide.steps(document.querySelector('#m-view')).map(s=>s.title));
 assert(steps.includes('QC technical inspection'));assert(!steps.includes('Receive PR'));assert(!steps.includes('QA appearance inspection'));assert(!steps.includes('QA holds'));
 report.checks.push('Custom QC account includes only its current displayed queues');
 await api('PUT','/users/'+qc.id+'/permissions',{overrides:{'production.inspect_qc':false,'production.qa_review':true}});
 await page.evaluate(()=>MApp.refreshAccess());
 await page.waitForFunction(()=>!document.querySelector('.guide-coach') && [...document.querySelectorAll('[data-work-guide]')].some(r=>r.dataset.workGuideTitle==='QA holds'));
 steps=await page.evaluate(()=>MobileGuide.steps(document.querySelector('#m-view')).map(s=>s.title));
 assert(!steps.includes('QC technical inspection'));assert(steps.includes('QA holds'));
 report.checks.push('Permission change removes stale guide and explains the newly active QA-hold queue');
 page=await open(personal.token);steps=await page.evaluate(()=>MobileGuide.steps(document.querySelector('#m-view')).map(s=>s.title));
 assert(steps.includes('Notes / checklists'));assert(!steps.includes('Receive PR'));assert(!steps.includes('Release orders'));
 await page.locator('#m-guide-start').click();await page.screenshot({path:path.join(out,'personal-only.png')});
 assert.deepEqual(report.errors,[]);report.checks.push('Personal-only account has no warehouse explanations');
 console.log('PASS '+report.checks.length+' real-browser account/permission checks; '+visible.length+' admin entries explained; zero JavaScript errors.');
}finally{fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));await browser?.close();server.kill();clearTimeout(timer);}
