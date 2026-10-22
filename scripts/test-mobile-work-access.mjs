// Actual desktop per-person access editor -> mobile Work, with an unchanged clerk role.
// Defaults to disposable data. A remote run must explicitly target the sandbox tenant.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {chromium,request} from 'playwright';

const remote=process.env.MOBILE_WORK_TEST_BASE;
if(remote && new URL(remote).pathname.replace(/\/$/,'')!=='/sandbox')throw new Error('Remote writes are restricted to the sandbox tenant.');
const runKind=remote?(process.env.MOBILE_WORK_CANDIDATE==='1'?'sandbox-candidate':'sandbox-deployed'):'local';
const output=path.resolve('work/mobile-work-access-audit',runKind);fs.mkdirSync(output,{recursive:true});
const report={environment:remote||'Disposable Express/SQLite backend',checks:[],errors:[],candidateAssets:process.env.MOBILE_WORK_CANDIDATE==='1'};
const server=remote?null:spawn(process.execPath,['--import','tsx','scripts/browser/editor-ux-server.ts'],{stdio:['ignore','pipe','pipe']});
server?.stderr.on('data',d=>fs.appendFileSync(path.join(output,'server.log'),d));
let base,admin,browser,desktopContext,phoneContext,user,role,remoteApi,desktop,phone;
const watchdog=setTimeout(()=>{server?.kill();process.exit(1);},300000);
async function api(method,route,body,token=admin){
  const headers={'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})};
  const res=remoteApi?await remoteApi.fetch(base+'/api'+route,{method,headers,...(body!==undefined?{data:body}:{})}):await fetch(base+'/api'+route,{method,headers,...(body!==undefined?{body:JSON.stringify(body)}:{})});
  const value=await res.json(),ok=remoteApi?res.ok():res.ok,status=remoteApi?res.status():res.status;assert(ok,`${method} ${route}: ${status} ${JSON.stringify(value)}`);return value;
}
async function check(name,fn){await fn();report.checks.push({name,passed:true});console.log('PASS '+name);}
async function context(token,phone=false){
  const c=await browser.newContext({viewport:phone?{width:390,height:844}:{width:1440,height:1000},isMobile:phone,hasTouch:phone,serviceWorkers:'block',timezoneId:'Asia/Manila'});
  const tenant=new URL(base).pathname.replace(/\/$/,'');
  await c.addInitScript(({token,key})=>{try{localStorage.setItem(key,token);}catch{}},{token,key:(tenant?'tenant:'+tenant+':':'')+'vds_token'});
  if(remote&&report.candidateAssets)await c.route('**/mobile/**',async route=>{
    const relative=new URL(route.request().url()).pathname.slice(tenant.length);
    const file=path.resolve('public'+relative);
    if(!file.startsWith(path.resolve('public/mobile')+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile())return route.continue();
    await route.fulfill({path:file});
  });
  c.on('page',p=>p.on('pageerror',e=>report.errors.push(e.message)));return c;
}
try{
  base=remote?remote.replace(/\/$/,''):'http://127.0.0.1:'+await new Promise((resolve,reject)=>{let out='';server.stdout.on('data',d=>{out+=d;const m=out.match(/EDITOR_UX_PORT=(\d+)/);if(m)resolve(m[1]);});server.on('exit',c=>reject(Error('Fixture server exit '+c)));});
  if(remote){
    remoteApi=await request.newContext({...((process.env.HTTPS_PROXY||process.env.HTTP_PROXY)?{proxy:{server:process.env.HTTPS_PROXY||process.env.HTTP_PROXY}}:{})});
    if(process.env.MOBILE_WORK_TEST_TOKEN_FILE)admin=fs.readFileSync(process.env.MOBILE_WORK_TEST_TOKEN_FILE,'utf8').trim();
    else if(process.env.MOBILE_WORK_TEST_USERNAME&&process.env.MOBILE_WORK_TEST_PASSWORD)admin=(await api('POST','/auth/login',{username:process.env.MOBILE_WORK_TEST_USERNAME,password:process.env.MOBILE_WORK_TEST_PASSWORD},null)).token;
    else throw new Error('Sandbox credentials or an authenticated token file are required.');
  }else admin=(await api('POST','/auth/login',{username:'admin',password:'admin123'},null)).token;
  const stamp=Date.now(),password=randomBytes(24).toString('base64url');
  role='work_clerk_'+stamp;
  await api('POST','/roles',{key:role,label:'Clerk work audit '+stamp,permissions:['mobile.access','messages.view','messages.send','production.repairs']});
  user=await api('POST','/users',{username:'work_clerk_'+stamp,full_name:'Clerk Work Audit '+stamp,password,role});
  report.fixture={userId:user.id,role};
  const employee=(await api('POST','/auth/login',{username:'work_clerk_'+stamp,password},null)).token;
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||fs.existsSync('/usr/bin/chromium')?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||'/usr/bin/chromium'}:{}),...(remote&&process.env.HTTPS_PROXY?{proxy:{server:process.env.HTTPS_PROXY}}:{})});
  desktopContext=await context(admin);phoneContext=await context(employee,true);
  desktop=await desktopContext.newPage();phone=await phoneContext.newPage();
  await desktop.goto(base+'/');await desktop.waitForFunction(()=>typeof AccessEditor!=='undefined'&&typeof API!=='undefined');
  await desktop.evaluate(id=>App.navigate('admin',{id}),user.id);await desktop.locator('#edit-perm-btn').waitFor();
  await phone.goto(base+'/m#/work');await phone.locator('#m-view').getByRole('button',{name:/Parts requests/}).waitFor();
  async function edit(changes){
    await desktop.locator('#edit-perm-btn').click();await desktop.locator('#perm-save').waitFor();
    for(const [key,on]of Object.entries(changes)){const cb=desktop.locator('[data-pp-key="'+key+'"]');if(await cb.isChecked()!==on)await cb.locator('..').click();}
    const response=desktop.waitForResponse(r=>r.url().endsWith('/users/'+user.id+'/permissions')&&r.request().method()==='PUT');
    await desktop.locator('#perm-save').click();assert.equal((await response).status(),200);await desktop.locator('#perm-save').waitFor({state:'detached'});
  }
  async function work(){await phone.evaluate(()=>MApp.go('home'));await phone.waitForURL(u=>u.hash==='#/home');await phone.locator('#m-tabbar [data-tab=work]').click();await phone.waitForURL(u=>u.hash==='#/work');await phone.locator('#m-view .v2-work').waitFor();}
  await check('The clerk role starts with parts requests and no inventory adjustments',async()=>{
    assert.equal(await phone.locator('#m-view').getByRole('button',{name:/RTS recording/}).count(),0);assert.equal(await phone.locator('#m-view').getByRole('button',{name:/Stock in \/ out/}).count(),0);
  });
  await check('Desktop per-person grants appear on Work without changing the clerk role or firing focus',async()=>{
    await edit({'production.receive':true,'orders.release':true,'inventory.view':true,'inventory.adjust':true,'inventory.transfer':true,'inventory.count':true});await phone.locator('#m-tabbar [data-tab=work]').click();
    for(const label of ['Parts requests','RTS recording','Release orders','Inventory stock','Transfer stock'])await phone.locator('#m-view').getByRole('button',{name:new RegExp('^'+label)}).waitFor();
    const me=(await api('GET','/auth/me',undefined,employee)).user;assert.equal(me.role,role);assert(me.permissions.includes('production.receive'));
    assert.equal(await phone.locator('#m-view').getByRole('button',{name:'All role queues',exact:true}).count(),0);
    assert.equal(await phone.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await phone.screenshot({path:path.join(output,'custom-clerk-work.png'),fullPage:true});
  });
  await check('Clerk links open their actual RTS, parts and releasing desks',async()=>{
    for(const [label,route,endpoint]of [['RTS recording','receiving','/rts/queue'],['Parts requests','repairs','/production/repairs'],['Release orders','so','/release-slips/queue']]){
      await work();const loaded=phone.waitForResponse(r=>new URL(r.url()).pathname.endsWith('/api'+endpoint)&&r.request().method()==='GET');await phone.locator('#m-view').getByRole('button',{name:new RegExp('^'+label)}).click();await phone.waitForURL(u=>u.hash.split('?')[0]==='#/'+route);assert.equal((await loaded).status(),200);await phone.locator('#m-view .rk-page').waitFor();assert.equal(await phone.locator('[data-no-permission]').count(),0);
    }
  });
  await check('Desktop removals disappear on Work while retained clerk and read-only inventory rights remain',async()=>{
    await edit({'production.receive':false,'orders.release':false,'inventory.adjust':false,'inventory.transfer':false,'inventory.count':false});await work();
    await phone.waitForFunction(()=>!MApp.can('inventory.adjust'));
    for(const label of ['RTS recording','Release orders','Transfer stock','Stock in / out'])assert.equal(await phone.locator('#m-view').getByRole('button',{name:new RegExp('^'+label)}).count(),0);
    for(const label of ['Parts requests','Inventory stock'])await phone.locator('#m-view').getByRole('button',{name:new RegExp('^'+label)}).waitFor();
    await phone.goto(base+'/m#/stock-move');await phone.locator('[data-no-permission]').waitFor();
    const refused=await phone.request.post(base+'/api/inventory/999999/adjust',{headers:{Authorization:'Bearer '+employee},data:{change:1,reason:'Permission denial test'}});assert.equal(refused.status(),403);
    await work();await phone.screenshot({path:path.join(output,'clerk-after-removal.png'),fullPage:true});
  });
  await check('Removing all operational access leaves personal Work tools only',async()=>{
    await edit({'production.repairs':false,'inventory.view':false});await work();await phone.waitForFunction(()=>!MApp.can('production.repairs'));
    for(const label of ['Parts requests','RTS recording','Release orders','Inventory stock'])assert.equal(await phone.locator('#m-view').getByRole('button',{name:new RegExp('^'+label)}).count(),0);
    await phone.locator('#m-view').getByRole('button',{name:/Report a blocker/}).waitFor();await phone.locator('#m-view').getByRole('button',{name:'Guides',exact:true}).waitFor();
  });
  await check('Revoked operational access blocks bookmarked screens and direct read APIs',async()=>{
    for(const route of ['receiving','repairs','so','stock-counts','stock-count-tasks','stock-move']){
      await phone.goto(base+'/m#/'+route);await phone.locator('[data-no-permission]').waitFor();
    }
    for(const endpoint of ['/rts/queue','/production/repairs','/release-slips/queue','/inventory/stock-counts?status=all','/inventory/stock-counts/tasks?status=open&mine=1']){
      const response=await phone.request.get(base+'/api'+endpoint,{headers:{Authorization:'Bearer '+employee}});assert.equal(response.status(),403,endpoint);
    }
    await work();
  });
  assert.deepEqual(report.errors,[]);
}catch(e){report.checks.push({name:'Acceptance run',passed:false,error:e.stack});console.error(e);try{await phone?.screenshot({path:path.join(output,'failure.png'),fullPage:true});report.effectivePermissions=await phone?.evaluate(()=>MApp.getMe()?.permissions);}catch{}process.exitCode=1;}
finally{
  await browser?.close();
  // Sandbox audit accounts are disabled, never left with the test's granted rights.
  if(remote&&user?.id){try{await api('PUT','/users/'+user.id+'/permissions',{overrides:{}});await api('PUT','/users/'+user.id,{active:0});report.fixture.disabled=true;}catch(e){report.cleanupError=e.message;process.exitCode=1;}}
  await remoteApi?.dispose();clearTimeout(watchdog);fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));server?.kill('SIGTERM');
}
