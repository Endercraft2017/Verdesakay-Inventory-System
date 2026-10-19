// Guide-library smoke checks against an isolated database, never the deployed workspace.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.join(root,'work/guide-refresh');fs.mkdirSync(output,{recursive:true});
const server=spawn(process.execPath,['--import','tsx','scripts/browser/editor-ux-server.ts'],{cwd:root,stdio:['ignore','pipe','pipe']});
server.stderr.on('data',d=>fs.appendFileSync(path.join(output,'server.log'),d));
const report={checks:[],errors:[]};let browser;
const timer=setTimeout(()=>{server.kill();process.exit(1);},240000);
try {
  const port=await new Promise((resolve,reject)=>{let text='';server.stdout.on('data',d=>{text+=d;const m=text.match(/EDITOR_UX_PORT=(\d+)/);if(m)resolve(m[1]);});server.once('exit',code=>reject(new Error('Audit server exited '+code)));});
  const base='http://127.0.0.1:'+port;
  browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
  const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce',timezoneId:'Asia/Manila'});
  const auth=await context.request.post(base+'/api/auth/login',{data:{username:'admin',password:'admin123'}});
  assert(auth.ok(),'Fixture login failed');const {token}=await auth.json();
  await context.addInitScript(value=>localStorage.setItem('vds_token',value),token);
  const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>report.errors.push(e.message));
  await page.goto(base);await page.waitForFunction(()=>!!window.App?.getMe());
  const pipelines=await page.evaluate(()=>GUIDE.pipelines.filter(p=>p.pipeline).map(p=>({id:p.id,title:p.title,length:p.steps.length})));
  assert.equal(pipelines.length,11);
  for(const width of [1440,390]) {
    await page.setViewportSize({width,height:1000});
    for(const theme of ['light','dark']) {
      await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
      for(const p of pipelines) {
        await page.evaluate(id=>App.navigate('sop',{topic:id}),p.id);
        await page.waitForFunction(id=>document.querySelector('.guide-hero h3')?.textContent===GUIDE.byId[id].title,p.id);
        assert.equal(await page.locator('.workflow-stop').count(),p.length);
        assert.equal(await page.locator('.workflow-connector').count(),p.length-1);
        assert.equal(await page.locator('.pipeline-check').count(),p.length*2);
        const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);
        assert(!overflow,p.id+' overflows at '+width);
        if(p.id==='split-trips')await page.screenshot({path:path.join(output,'trips-'+theme+'-'+width+'.png'),fullPage:true});
        report.checks.push({platform:'web',workflow:p.id,width,theme});
      }
    }
  }
  // Explicit Help topics must render their own titles and current workflow actions.
  const topics=await page.evaluate(()=>Help.topics.map(t=>({id:t.id,title:t.title})));
  for(const t of topics) {
    await page.evaluate(id=>Help.open(id),t.id);
    assert.equal(await page.locator('.help-content h4').first().textContent(),t.title);
  }
  await page.locator('.drawer-close').click();
  report.checks.push({platform:'web',helpTopics:topics.length});
  await page.goto(base+'/m/');await page.waitForFunction(()=>!!window.MApp?.getMe());
  await page.evaluate(()=>MApp.go('guides'));await page.waitForSelector('#m-guide-section');
  await page.selectOption('#m-guide-section','pipelines');
  assert.equal(await page.locator('.m-guide-reference').count(),11);
  for(const theme of ['light','dark']) {
    await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
    for(const p of pipelines) {
      const card=page.locator('.m-guide-reference').filter({has:page.locator('summary strong',{hasText:p.title})});
      await card.locator('summary').click();
      assert.equal(await card.locator('.m-pipeline-path > li').count(),p.length);
      assert((await card.innerText()).includes('Result / handoff:'));
      if(p.id==='customer-return')await page.screenshot({path:path.join(output,'phone-return-'+theme+'.png'),fullPage:true});
      await card.locator('summary').click();
      report.checks.push({platform:'phone',workflow:p.id,theme});
    }
  }
  assert.deepEqual(report.errors,[]);
  console.log('PASS '+report.checks.length+' guide checks; '+topics.length+' Help topics; zero JavaScript errors.');
} finally {
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
  await browser?.close();server.kill();clearTimeout(timer);
}
