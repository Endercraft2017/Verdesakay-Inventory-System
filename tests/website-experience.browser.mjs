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
const screenKeys=['attendance','payroll','mobile','inventory','production','sales'];
const allowed=new Set(['index.html','app.js','lead-context.js','experience.js','style.css',...screenKeys.map(key=>'assets/screens/otom-'+key+'.webp')]);
const server=http.createServer(async(req,res)=>{
 const filename=req.url==='/'?'index.html':req.url.split('?')[0].replace(/^\/site\//,'');
 if(!allowed.has(filename)){res.writeHead(404).end();return;}
 try{const type=filename.endsWith('.webp')?'image/webp':filename.endsWith('.js')?'text/javascript':filename.endsWith('.css')?'text/css':'text/html';res.setHeader('Content-Type',type);res.end(await fs.readFile(path.join(root,filename)));}
 catch{res.writeHead(404).end();}
});
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

  const tourImage=page.locator('img[data-tour-image]');
  await tourImage.scrollIntoViewIfNeeded();
  await page.waitForFunction(()=>{const image=document.querySelector('img[data-tour-image]');return image.complete&&image.naturalWidth>0;});
  assert.equal(await page.locator('[data-tour-screen]').count(),screenKeys.length);
  for(const key of screenKeys){
    await page.locator('[data-tour-screen='+key+']').click();
    await page.waitForFunction(key=>document.querySelector('[data-tour-screen='+key+']').getAttribute('aria-pressed')==='true'&&document.querySelector('#product-tour-figure').getAttribute('aria-busy')==='false',key);
    assert.equal(await tourImage.getAttribute('src'),'/site/assets/screens/otom-'+key+'.webp');
    assert.equal(await page.locator('#product-tour-figure [data-tour-title]').innerText(),await page.locator('[data-tour-screen='+key+']').getAttribute('data-tour-title'));
    assert.equal(await page.locator('[data-tour-full]').getAttribute('href'),'/site/assets/screens/otom-'+key+'.webp');
    assert.equal(await page.locator('[data-tour-inquiry]').isDisabled(),false);
    await page.waitForFunction(()=>{const image=document.querySelector('img[data-tour-image]');return image.complete&&image.naturalWidth>0;});
    const dimensions=await tourImage.evaluate(image=>[image.naturalWidth,image.naturalHeight]);
    assert.deepEqual(dimensions,key==='mobile'?[780,1688]:[1440,960]);
  }
  await page.locator('[data-tour-inquiry]').click();await page.locator('#c-workflow').fill('');await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.getElementById('contact-dialog').open);
  await page.locator('[data-tour-screen=inventory]').click();await page.waitForFunction(()=>document.querySelector('[data-tour-screen=inventory]').getAttribute('aria-pressed')==='true');
  await page.locator('[data-tour-inquiry]').click();assert.match(await page.locator('#c-workflow').inputValue(),/^Warehouse and inventory:/);
  await page.locator('#c-workflow').fill('Keep my own walkthrough request');await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.getElementById('contact-dialog').open);
  await page.locator('[data-tour-screen=payroll]').focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelector('[data-tour-screen=payroll]').getAttribute('aria-pressed')==='true');
  await page.locator('[data-tour-inquiry]').click();assert.equal(await page.locator('#c-workflow').inputValue(),'Keep my own walkthrough request');await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.getElementById('contact-dialog').open);
  await page.locator('[data-tour-screen=attendance]').click();await page.waitForFunction(()=>document.querySelector('[data-tour-screen=attendance]').getAttribute('aria-pressed')==='true');
  results.push({width,gallery:'Six real local captures decode at intended dimensions; switch, full-image links, keyboard and brief edit-retention work',autoplay:false});
  const violations=await page.evaluate(async()=>(await axe.run()).violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})));assert.deepEqual(violations,[]);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width);
  if(width===390){const cells=await page.locator('.readiness td:last-child').evaluateAll(nodes=>nodes.map(e=>({left:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right})));assert.ok(cells.every(c=>c.left>=0&&c.right<=390));}
  assert.equal(await page.evaluate(()=>document.getAnimations().length),0);assert.deepEqual(errors,[]);await page.getByRole('button',{name:'01 Attendance',exact:true}).click();await page.screenshot({path:path.join(out,`otom-after-${width}.png`),fullPage:true});results.push({width,planner:'Selection, keyboard and demo-brief prefill work; edited brief retained',secondary:'Warehouse, Production and Sales visible; Sales brief prefill verified',optional:'Keyboard disclosure works',axeViolations:violations.length,overflow:false,reducedMotion:'No running animations',pageErrors:errors});await page.close();
 }
 const plain=await browser.newPage({javaScriptEnabled:false,viewport:{width:390,height:844}});await plain.goto(origin);assert.equal(await plain.locator('[data-tour-fallback] a:visible').count(),screenKeys.length);assert.equal(await plain.locator('[data-tour-controls]').isVisible(),false);assert.equal(await plain.locator('[data-tour-inquiry]').isVisible(),false);await plain.waitForFunction(()=>{const image=document.querySelector('img[data-tour-image]');return image.complete&&image.naturalWidth>0;});assert.equal(await plain.locator('[data-review-panel]:visible').count(),3);assert.equal(await plain.locator('.optional-scope').evaluate(e=>e.open),true);await plain.locator('.static-contact').scrollIntoViewIfNeeded();assert.equal(await plain.locator('.static-contact').isVisible(),true);assert.equal(await plain.evaluate(()=>document.documentElement.scrollWidth),390);await plain.close();results.push({noJS:'All three review panels and optional scope visible; static contact available'});
 const blocked=await browser.newPage();await configure(blocked);await blocked.route('**/site/experience.js',r=>r.abort('failed'));await blocked.goto(origin);assert.equal(await blocked.locator('[data-tour-fallback] a:visible').count(),screenKeys.length);assert.equal(await blocked.locator('[data-tour-controls]').isVisible(),false);assert.equal(await blocked.locator('[data-review-panel]:visible').count(),3);await blocked.getByRole('button',{name:'Request an HR demo',exact:true}).first().click();assert.equal(await blocked.locator('#contact-dialog').evaluate(e=>e.open),true);await blocked.close();results.push({blockedExperience:'Static content and existing contact dialog still work'});
 const moving=await browser.newPage({viewport:{width:1440,height:950},reducedMotion:'no-preference'});await configure(moving);await moving.goto(origin);await moving.getByRole('button',{name:'02 Kiosk',exact:true}).click();assert.ok(await moving.evaluate(()=>document.getAnimations().length>0));await moving.emulateMedia({reducedMotion:'reduce'});await moving.waitForFunction(()=>document.getAnimations().length===0);assert.equal(await moving.locator('#review-kiosk').isVisible(),true);await moving.emulateMedia({reducedMotion:'no-preference'});
 await moving.locator('[data-tour-screen=payroll]').focus();await moving.keyboard.press('Enter');await moving.waitForFunction(()=>document.querySelector('[data-tour-screen=payroll]').getAttribute('aria-pressed')==='true');assert.equal(await moving.locator('[data-tour-media]').evaluate(e=>e.getAnimations().length),0);
 await moving.locator('[data-tour-screen=inventory]').click();await moving.waitForFunction(()=>document.querySelector('[data-tour-screen=inventory]').getAttribute('aria-pressed')==='true');assert.ok(await moving.locator('[data-tour-media]').evaluate(e=>e.getAnimations().length)>0);
 await moving.emulateMedia({reducedMotion:'reduce'});await moving.waitForFunction(()=>document.querySelector('[data-tour-media]').getAnimations().length===0);
 await moving.route('**/site/assets/screens/otom-production.webp',r=>r.abort('failed'));await moving.locator('[data-tour-screen=production]').click();await moving.waitForFunction(()=>document.querySelector('[data-tour-status]').textContent.includes('previous view is still shown'));assert.equal(await moving.locator('img[data-tour-image]').getAttribute('src'),'/site/assets/screens/otom-inventory.webp');assert.equal(await moving.locator('[data-tour-screen=inventory]').getAttribute('aria-pressed'),'true');
 await moving.close();results.push({galleryMotion:'Pointer-only crossfade; keyboard instant; reduced-motion cancels; failed image retains prior accurate view',motion:'Real animations run; switching reduced-motion on cancels them without hiding content'});
}finally{await browser.close();server.close();}
await fs.writeFile(path.join(out,'otom-experience-results.json'),JSON.stringify({scope:'Local public marketing page with real local-app captures and synthetic data; config is synthetic and inquiry requests are aborted; no live backend or email sending',results},null,2));console.log(JSON.stringify(results,null,2));

