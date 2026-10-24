// Real app/API + disposable path-tenant DB. Run: node --import tsx scripts/test-mobile-profile-layout.mjs
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

const root=fileURLToPath(new URL('../',import.meta.url));
const out=path.resolve(process.env.QA_OUTPUT_DIR||path.join(root,'work/mobile-profile-layout'));
fs.mkdirSync(out,{recursive:true});
const runtime=fs.mkdtempSync(path.join(out,'runtime-'));
Object.assign(process.env,{NODE_ENV:'test',TZ:'Asia/Manila',TENANT_PATH_HOST:'127.0.0.1',
  DB_PATH:path.join(runtime,'default.db'),DATA_DIR:path.join(runtime,'tenants'),
  PLATFORM_DB_PATH:path.join(runtime,'platform.db'),UPLOAD_DIR:path.join(runtime,'uploads'),
  BACKUP_DIR:path.join(runtime,'backups'),VDS_TEST_ADMIN_PASSWORD:'Local-profile-test-238!'});
const db=await import('../src/shared/db.ts');
db.init();
const platform=await import('../src/platform/platform.ts');
const {createTenant}=await import('../src/platform/provisioning.ts');
createTenant({slug:'sandbox',name:'Profile UI fixture',admin_username:'qa_profile',
  admin_password:'Local-profile-test-238!',plan:'unlimited',status:'active',is_sandbox:true});
const {createApp}=await import('../src/app.ts');
const {attachWebSocket}=await import('../src/shared/ws.ts');
const server=http.createServer(createApp());attachWebSocket(server);
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port+'/sandbox';
const results={phase:process.env.QA_PHASE||'current',viewportHeights:844,cases:[],pageErrors:[]};
let browser;
async function check(name,fn){try{const detail=await fn();results.cases.push({name,status:'pass',detail});console.log('PASS '+name);}catch(e){results.cases.push({name,status:'fail',error:e.message});console.log('FAIL '+name+': '+e.message);}}
async function signedIn(width,theme,shared=false){
  const context=await browser.newContext({viewport:{width,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:1,colorScheme:theme});
  const page=await context.newPage();page.on('pageerror',e=>results.pageErrors.push(e.message));
  await page.goto(base+'/m');await page.locator('#m-login').waitFor({state:'visible'});
  await page.locator('#m-username').fill('qa_profile');await page.locator('#m-password').fill('Local-profile-test-238!');
  if(shared)await page.locator('#m-shared').check();
  await page.locator('#m-login-form button[type=submit]').click();await page.locator('#m-app').waitFor({state:'visible'});
  await page.locator('[data-tab=profile]').click();await page.locator('[data-profile-action=security]').waitFor();
  return {page,context,token:await page.evaluate(()=>API.getToken())};
}
async function formSpacing(page,selector){return page.locator(selector).evaluate(form=>{
  const input=form.querySelector('input[type=password]'),button=form.querySelector('button[type=submit]');
  const a=input.getBoundingClientRect(),b=button.getBoundingClientRect();
  return{gap:b.top-a.bottom,inputWidth:a.width,buttonWidth:b.width,overflow:document.documentElement.scrollWidth>innerWidth};
});}
try{
  browser=await chromium.launch({...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  for(const width of [320,390,658])for(const theme of ['light','dark']){
    const {page,context,token}=await signedIn(width,theme);const label=width+'-'+theme;
    await check(label+' Profile footer',async()=>{
      const button=page.locator('[data-profile-signout]');assert.equal(await button.count(),1,'Direct Profile sign-out is missing');
      await button.evaluate(e=>e.scrollIntoView({block:'center'}));
      const geometry=await button.evaluate(e=>{const r=e.getBoundingClientRect(),dock=document.querySelector('#m-tabbar').getBoundingClientRect();return{height:r.height,bottom:r.bottom,dockTop:dock.top,hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};});
      assert.ok(geometry.height>=44);assert.ok(geometry.bottom<geometry.dockTop);assert.equal(geometry.hit,true);
      if(width===390)await page.screenshot({path:path.join(out,'profile-'+theme+'.png')});return geometry;
    });
    await page.locator('[data-profile-action=security]').click();await page.locator('[data-username]').waitFor();
    await check(label+' username form spacing',async()=>{const r=await formSpacing(page,'[data-username]');assert.ok(r.gap>=12,'Input/action gap is '+r.gap+'px');assert.equal(r.overflow,false);return r;});
    await check(label+' password form spacing',async()=>{const r=await formSpacing(page,'[data-pw]');assert.ok(r.gap>=12,'Input/action gap is '+r.gap+'px');assert.equal(r.overflow,false);return r;});
    if(width===390)await check(label+' autofill matches Profile theme',async()=>{
      const cdp=await context.newCDPSession(page);await cdp.send('DOM.enable');await cdp.send('CSS.enable');
      const {root:document}=await cdp.send('DOM.getDocument');const {nodeId}=await cdp.send('DOM.querySelector',{nodeId:document.nodeId,selector:'[data-next-username]'});
      await cdp.send('CSS.forcePseudoState',{nodeId,forcedPseudoClasses:['autofill']});
      const style=await page.locator('[data-next-username]').evaluate(e=>{
        const s=getComputedStyle(e),root=getComputedStyle(document.documentElement);
        function color(token){const probe=document.createElement('span');probe.style.color=root.getPropertyValue(token);document.body.append(probe);const value=getComputedStyle(probe).color;probe.remove();return value;}
        return{shadow:s.boxShadow,text:s.webkitTextFillColor,matches:e.matches(':autofill'),surface:color('--v2-surface-soft'),expectedText:color('--v2-text')};
      });
      await cdp.send('CSS.forcePseudoState',{nodeId,forcedPseudoClasses:[]});await cdp.detach();
      assert.equal(style.matches,true);assert.ok(style.shadow.includes(style.surface));assert.equal(style.text,style.expectedText);return style;
    });
    if(width===390||(width===658&&theme==='dark')){
      await page.locator('[data-next-username]').fill('qa.new.user');await page.locator('[data-username-password]').fill('Demo-only-password');
      await page.locator('[data-username]').evaluate(form=>{const card=form.closest('.profile-section');window.scrollBy(0,card.getBoundingClientRect().top-82);});
      await page.locator('.profile-section').filter({has:page.locator('[data-username]')}).screenshot({path:path.join(out,'security-'+width+'-'+theme+'.png')});
    }
    if(width===390&&theme==='dark'){
      await check('password mismatch stays local',async()=>{let writes=0;const listener=r=>{if(r.url().endsWith('/auth/change-password')&&r.method()==='POST')writes++;};page.on('request',listener);
        await page.locator('[data-cur]').fill('Local-profile-test-238!');await page.locator('[data-new]').fill('Different-profile-test-238!');await page.locator('[data-confirm]').fill('Mismatch-profile-test-238!');
        await page.locator('[data-pw] button[type=submit]').click();await page.locator('[data-password-error]').filter({hasText:'do not match'}).waitFor();assert.equal(writes,0);page.off('request',listener);return 'Mismatch visible; no password mutation sent.';});
    }
    await page.locator('[data-profile-back]').click();await page.locator('[data-profile-action=security]').waitFor();
    if(await page.locator('[data-profile-signout]').count()){
      if(width===390&&theme==='dark')await check('Profile sign-out preserves unsent-action cancel',async()=>{
        await context.setOffline(true);
        try{
          await page.evaluate(()=>mQueue.enqueue({key:'qa-profile-unsent',method:'POST',path:'/tasks',body:{title:'Local profile fixture'},label:'Profile fixture action'}));
          await page.locator('[data-profile-signout]').click();await page.locator('[data-cancel]').waitFor({state:'visible'});await page.locator('[data-cancel]').click();
          await page.waitForFunction(()=>!document.querySelector('[data-profile-signout]').disabled);
          assert.equal(await page.evaluate(()=>MApp.getMe().username),'qa_profile');
          assert.equal(await page.evaluate(()=>mQueue.count()),1);
        }finally{await page.evaluate(()=>mQueue.discard('qa-profile-unsent')).catch(()=>{});await context.setOffline(false);}
        assert.equal((await page.evaluate(()=>API.get('/auth/me'))).user.username,'qa_profile');return 'Cancel keeps the account signed in and the unsent action intact.';
      });
      await check(label+' Profile sign-out ends server session',async()=>{
        let logouts=0;const listener=r=>{if(r.url().endsWith('/auth/logout')&&r.method()==='POST')logouts++;};page.on('request',listener);
        await page.locator('[data-profile-signout]').click();await page.locator('#m-login').waitFor({state:'visible'});
        assert.equal(await page.evaluate(()=>API.getToken()),null);assert.equal((await context.request.get(base+'/api/auth/me',{headers:{Authorization:'Bearer '+token}})).status(),401);
        assert.equal(logouts,1);return 'One logout request; browser token cleared; old server token rejected (401).';
      });
    }else await context.request.post(base+'/api/auth/logout',{headers:{Authorization:'Bearer '+token},data:{}});
    await context.close();
  }
  await check('borrowed Profile sign-out clears personal cache',async()=>{
    const {page,context,token}=await signedIn(390,'dark',true);
    assert.equal(await page.locator('[data-profile-signout]').count(),1);
    await page.evaluate(()=>window.localStorage.setItem('tenant:/sandbox:vds_qa_profile_private','Only the local test user'));
    await page.locator('[data-profile-signout]').click();await page.locator('#m-login').waitFor({state:'visible'});
    assert.equal(await page.evaluate(()=>window.localStorage.getItem('tenant:/sandbox:vds_qa_profile_private')),null);
    assert.equal((await context.request.get(base+'/api/auth/me',{headers:{Authorization:'Bearer '+token}})).status(),401);
    await context.close();return 'Borrowed token and personal marker removed; server session ended.';
  });
  assert.deepEqual(results.pageErrors,[]);
}finally{
  if(browser)await browser.close();
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));db.closeAllConnections();platform._resetPlatformDb();
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(results,null,2)+'\n');fs.rmSync(runtime,{recursive:true,force:true});
}
if(results.cases.some(c=>c.status==='fail'))process.exitCode=1;
