import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {chromium} from 'playwright';
const require=createRequire(import.meta.url),root=fileURLToPath(new URL('../website/',import.meta.url));
const out=process.env.OTOM_VISUAL_OUT||fileURLToPath(new URL('../work/marketing-ui/',import.meta.url));
await fs.mkdir(out,{recursive:true});
const allowed=new Set(['index.html','app.js','lead-context.js','experience.js','style.css']);
const server=http.createServer(async(req,res)=>{const filename=req.url==='/'?'index.html':req.url.split('?')[0].replace(/^\/site\//,'');if(!allowed.has(filename)){res.writeHead(404).end();return;}const type=filename.endsWith('.js')?'text/javascript':filename.endsWith('.css')?'text/css':'text/html';res.setHeader('Content-Type',type);res.end(await fs.readFile(path.join(root,filename)));});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE||undefined,args:['--no-sandbox']});
const results=[],config={modules:['hr','inventory','accounting','mobile'],module_deps:{},signups_open:false,contact:{},pricing:null};
async function configure(page){await page.route('**/site/config',r=>r.fulfill({json:config}));await page.route('**/site/inquiry',r=>r.abort('failed'));}
try{
 for(const width of [1440,390]){
  const page=await browser.newPage({viewport:{width,height:950},reducedMotion:'reduce'});const errors=[];page.on('pageerror',e=>errors.push(e.message));await configure(page);await page.goto(origin);await page.addScriptTag({path:require.resolve('axe-core/axe.min.js')});
  assert.equal(await page.locator('[data-review-panel]:visible').count(),1);
  await page.getByRole('button',{name:'02 Kiosk',exact:true}).click();assert.equal(await page.locator('#review-kiosk').isVisible(),true);
  await page.locator('[data-review-inquiry]').click();assert.equal(await page.locator('#contact-dialog').evaluate(e=>e.open),true);assert.match(await page.locator('#c-workflow').inputValue(),/Kiosk device approval/);
  await page.locator('#c-workflow').fill('My edited request');await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.getElementById('contact-dialog').open&&document.activeElement?.matches('[data-review-inquiry]'));await page.getByRole('button',{name:'03 Payslips',exact:true}).focus();await page.keyboard.press('Enter');assert.equal(await page.locator('#review-payroll').isVisible(),true);await page.locator('[data-review-inquiry]').click();assert.equal(await page.locator('#c-workflow').inputValue(),'My edited request');await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.getElementById('contact-dialog').open&&document.activeElement?.matches('[data-review-inquiry]'));
  assert.equal(await page.locator('.optional-scope').evaluate(e=>e.open),false);await page.locator('.optional-scope summary').focus();await page.keyboard.press('Enter');assert.equal(await page.locator('.optional-scope').evaluate(e=>e.open),true);assert.match(await page.locator('.optional-scope').innerText(),/Accounting/);await page.locator('.optional-scope summary').click();
  assert.equal(await page.locator('.operations-grid article').count(),3);await page.locator('[data-review-inquiry]').click();await page.locator('#c-workflow').fill('');await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.getElementById('contact-dialog').open&&document.activeElement?.matches('[data-review-inquiry]'));await page.getByRole('button',{name:'Discuss Sales',exact:true}).click();assert.match(await page.locator('#c-workflow').inputValue(),/^Sales:/);await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.getElementById('contact-dialog').open&&document.activeElement?.matches('[data-operations-brief]'));
  const violations=await page.evaluate(async()=>(await axe.run()).violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})));assert.deepEqual(violations,[]);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width);
  if(width===390){const cells=await page.locator('.readiness td:last-child').evaluateAll(nodes=>nodes.map(e=>({left:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right})));assert.ok(cells.every(c=>c.left>=0&&c.right<=390));}
  assert.equal(await page.evaluate(()=>document.getAnimations().length),0);assert.deepEqual(errors,[]);await page.getByRole('button',{name:'01 Attendance',exact:true}).click();await page.screenshot({path:path.join(out,`otom-after-${width}.png`),fullPage:true});results.push({width,planner:'Selection, keyboard and demo-brief prefill work; edited brief retained',secondary:'Warehouse, Production and Sales visible; Sales brief prefill verified',optional:'Keyboard disclosure works',axeViolations:violations.length,overflow:false,reducedMotion:'No running animations',pageErrors:errors});await page.close();
 }
 const plain=await browser.newPage({javaScriptEnabled:false,viewport:{width:390,height:844}});await plain.goto(origin);assert.equal(await plain.locator('[data-review-panel]:visible').count(),3);assert.equal(await plain.locator('.optional-scope').evaluate(e=>e.open),true);await plain.locator('.static-contact').scrollIntoViewIfNeeded();assert.equal(await plain.locator('.static-contact').isVisible(),true);assert.equal(await plain.evaluate(()=>document.documentElement.scrollWidth),390);await plain.close();results.push({noJS:'All three review panels and optional scope visible; static contact available'});
 const blocked=await browser.newPage();await configure(blocked);await blocked.route('**/site/experience.js',r=>r.abort('failed'));await blocked.goto(origin);assert.equal(await blocked.locator('[data-review-panel]:visible').count(),3);await blocked.getByRole('button',{name:'Request an HR demo',exact:true}).first().click();assert.equal(await blocked.locator('#contact-dialog').evaluate(e=>e.open),true);await blocked.close();results.push({blockedExperience:'Static content and existing contact dialog still work'});
 const moving=await browser.newPage({viewport:{width:1440,height:950},reducedMotion:'no-preference'});await configure(moving);await moving.goto(origin);await moving.getByRole('button',{name:'02 Kiosk',exact:true}).click();assert.ok(await moving.evaluate(()=>document.getAnimations().length>0));await moving.emulateMedia({reducedMotion:'reduce'});await moving.waitForFunction(()=>document.getAnimations().length===0);assert.equal(await moving.locator('#review-kiosk').isVisible(),true);await moving.close();results.push({motion:'Real animations run; switching reduced-motion on cancels them without hiding content'});
}finally{await browser.close();server.close();}
await fs.writeFile(path.join(out,'otom-experience-results.json'),JSON.stringify({scope:'Local public marketing page; synthetic configuration, no product or email sending',results},null,2));console.log(JSON.stringify(results,null,2));
