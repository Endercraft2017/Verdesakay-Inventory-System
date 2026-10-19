import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {chromium} from 'playwright';
const out=path.resolve('work/permission-evidence/desktop-fix');fs.mkdirSync(out,{recursive:true});
const server=spawn(process.execPath,['--import','tsx','scripts/browser/editor-ux-server.ts'],{stdio:['ignore','pipe','pipe']});server.stderr.on('data',d=>fs.appendFileSync(out+'/server.log',d));let browser;
const report={environment:'Local candidate code with disposable real Express/SQLite backend; NOT deployed sandbox',checks:[],errors:[]};
const watchdog=setTimeout(()=>{server.kill();process.exit(1)},180000);
try{
const port=await new Promise((resolve,reject)=>{let s='';server.stdout.on('data',d=>{s+=d;const m=s.match(/EDITOR_UX_PORT=(\d+)/);if(m)resolve(m[1])});server.on('exit',c=>reject(Error('server exit '+c)))});const base='http://127.0.0.1:'+port;
async function api(method,url,data,token){const r=await fetch(base+'/api'+url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(data?{body:JSON.stringify(data)}:{})});assert(r.ok,url+": "+r.status);return r.json()}
const admin=(await api('POST','/auth/login',{username:'admin',password:'admin123'})).token;
browser=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium'});
for(const [role,route,title]of [['parts_clerk','repairs','Parts Clerk'],['receiving_clerk','production-receiving','RTS Clerk']]){
const user=await api('POST','/users',{username:role,password:'disposable-test-password',full_name:title,role},admin);const token=(await api('POST','/auth/login',{username:role,password:'disposable-test-password'})).token;
for(const mobile of [false,true]){
const c=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1440,height:1000},isMobile:mobile,hasTouch:mobile,serviceWorkers:'block'});await c.addInitScript(t=>localStorage.setItem('vds_token',t),token);const p=await c.newPage();p.on('pageerror',e=>report.errors.push(e.message));
if(mobile){await p.goto(base+'/m#/work');await p.locator('#m-view .v2-work').waitFor();await p.locator('#m-view .v2-work-row').filter({hasText:role==='parts_clerk'?/Parts requests/:/RTS recording/}).waitFor();}
else{await p.goto(base+'/');await p.waitForFunction(()=>window.App?.getMe());assert(await p.evaluate(r=>App.canAccessRoute(r),route));for(const denied of ['job-orders','production-overview','finished-products',role==='parts_clerk'?'production-receiving':'repairs'])assert.equal(await p.evaluate(r=>App.canAccessRoute(r),denied),false);await p.locator('[data-primary="production"]').click();const loaded=p.waitForResponse(r=>r.url().includes(role==='parts_clerk'?'/api/production/repairs?':'/api/rts/queue'));await p.evaluate(r=>App.navigate(r),route);assert.equal((await loaded).status(),200);await p.locator(role==='parts_clerk'?'#rp-table':'#pi-table').getByText('Loading…',{exact:true}).waitFor({state:'hidden'});
if(role==='receiving_clerk'){const history=p.waitForResponse(r=>r.url().endsWith('/api/job-orders/production-receipts'));await p.evaluate(()=>App.navigate('production-receiving',{tab:'history'}));assert.equal((await history).status(),200);await p.locator('#view').getByText('Loading…',{exact:true}).waitFor({state:'hidden'});await p.screenshot({path:out+'/'+role+'-history.png',fullPage:true});await p.evaluate(()=>App.navigate('production-receiving',{tab:'queue'}));await p.locator('#pi-table').getByText('Loading…',{exact:true}).waitFor({state:'hidden'});}
}
await p.screenshot({path:out+'/'+role+(mobile?'-mobile':'-desktop')+'.png',fullPage:true});report.checks.push(role+' '+(mobile?'mobile duties':'desktop desk, read API and unrelated desk isolation'));await c.close();
}
await api('PUT','/users/'+user.id+'/permissions',{overrides:{[role==='parts_clerk'?'production.repairs':'production.receive']:false}},admin);
const c=await browser.newContext();await c.addInitScript(t=>localStorage.setItem('vds_token',t),token);const p=await c.newPage();await p.goto(base+'/');await p.waitForFunction(()=>window.App?.getMe());assert.equal(await p.evaluate(r=>App.canAccessRoute(r),route),false);report.checks.push(role+' explicit denial removes desktop desk');await c.close();
}
assert.deepEqual(report.errors,[]);console.log(JSON.stringify(report));
}catch(e){report.failure=e.stack;console.error(e);process.exitCode=1}finally{await browser?.close();server.kill();clearTimeout(watchdog);fs.writeFileSync(out+'/report.json',JSON.stringify(report,null,2))}
