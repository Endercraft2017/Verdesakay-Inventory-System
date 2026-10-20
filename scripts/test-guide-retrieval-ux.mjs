// Real-app retrieval checks against a disposable server. No production data or AI services.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';import {chromium} from 'playwright';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),out=path.join(root,'work/guide-retrieval');fs.mkdirSync(out,{recursive:true});
const server=spawn(process.execPath,['--import','tsx','scripts/browser/editor-ux-server.ts'],{cwd:root,stdio:['ignore','pipe','pipe']});server.stderr.on('data',d=>fs.appendFileSync(path.join(out,'server.log'),d));
const report={checks:[],errors:[]};let browser;const timer=setTimeout(()=>{server.kill();process.exit(1);},120000);
try{
 const port=await new Promise((resolve,reject)=>{let log='';server.stdout.on('data',d=>{log+=d;const m=log.match(/EDITOR_UX_PORT=(\d+)/);if(m)resolve(m[1]);});server.once('exit',c=>reject(Error('Fixture stopped '+c)));});const base='http://127.0.0.1:'+port;
 browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce',serviceWorkers:'block'});
 const auth=await context.request.post(base+'/api/auth/login',{data:{username:'admin',password:'admin123'}});assert(auth.ok());const {token}=await auth.json();await context.addInitScript(t=>localStorage.setItem('vds_token',t),token);
 const page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));page.setDefaultTimeout(15000);
 const sent=[];page.on('request',r=>{if(r.url().includes('customer%20returned')||(r.postData()||'').includes('customer returned'))sent.push(r.url());});
 await page.goto(base);await page.waitForFunction(()=>!!window.App?.getMe());await page.evaluate(()=>App.navigate('sop'));
 async function ask(q){await page.locator('[data-intent-input]').fill(q);await page.locator('[data-intent-form] button[type=submit]').click();}
 for(const width of [1440,390])for(const theme of ['light','dark']){
  await page.setViewportSize({width,height:1000});await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
  await ask('A customer returned a damaged unit');assert((await page.locator('.guide-retrieval-source').first().innerText()).includes('Customer return'));assert((await page.locator('.guide-retrieval-result').first().innerText()).includes('Receive against the original slip'));
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:path.join(out,'web-'+theme+'-'+width+'.png'),fullPage:true});report.checks.push('web '+theme+' '+width);
 }
 await page.locator('[data-intent-select]').first().click();assert((await page.locator('.guide-hero h3').innerText()).includes('Customer return'));assert.equal(await page.evaluate(()=>App.currentLocation().route),'sop');
 await ask('receive goods');assert.equal(await page.locator('[data-intent-choice]').count(),3);await page.locator('[data-intent-choice]').first().click();assert((await page.locator('.guide-retrieval-source').first().innerText()).includes('Purchasing'));
 await ask('purple unicorn quux');assert.equal(await page.locator('.guide-retrieval-result').count(),0);assert((await page.locator('[data-intent-status]').innerText()).includes('No close match'));
 await context.setOffline(true);await ask('I need a budget to buy tools');assert((await page.locator('.guide-retrieval-source').first().innerText()).includes('Internal purchase request'));await context.setOffline(false);report.checks.push('web clarification, no match, guide-only selection and offline retrieval');
 await page.goto(base+'/m/');await page.waitForFunction(()=>!!window.MApp?.getMe());await page.evaluate(()=>MApp.go('guides'));await page.waitForSelector('[data-intent-input]');
 await ask('receive goods');await page.locator('[data-intent-choice]').first().click();await page.locator('[data-intent-select]').first().click();assert(await page.locator('[data-guide-id="purchase-to-pay"]').evaluate(el=>el.open));assert.equal(await page.evaluate(()=>MApp.currentLocation().name),'guides');
 await context.setOffline(true);await ask('old stock before the system');assert((await page.locator('.guide-retrieval-source').first().innerText()).includes('Pre-system unit'));await page.screenshot({path:path.join(out,'phone-offline.png'),fullPage:true});report.checks.push('phone guide selection and offline legacy-intake retrieval');
 assert.deepEqual(sent,[]);assert.deepEqual(report.errors,[]);console.log('PASS '+report.checks.length+' browser checks; local offline search; no query sent; zero JavaScript errors.');
}finally{fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));await browser?.close();server.kill();clearTimeout(timer);}
