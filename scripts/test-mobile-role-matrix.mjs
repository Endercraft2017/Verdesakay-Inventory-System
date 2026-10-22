// Built-in shop-floor roles against a disposable real backend; no live tenant writes.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';
const out='work/mobile-role-matrix';fs.mkdirSync(out,{recursive:true});
const report={environment:'Disposable real backend, Chromium 390x844',checks:[],errors:[]};
const server=spawn(process.execPath,['--import','tsx','scripts/browser/editor-ux-server.ts'],{stdio:['ignore','pipe','pipe']});
server.stderr.on('data',d=>fs.appendFileSync(out+'/server.log',d));
let browser;const timer=setTimeout(()=>{server.kill();process.exit(1);},240000);
try{
 const port=await new Promise((resolve,reject)=>{let output='';server.stdout.on('data',d=>{output+=d;const m=output.match(/EDITOR_UX_PORT=(\d+)/);if(m)resolve(m[1]);});server.on('exit',c=>reject(Error('Server exit '+c)));});
 const base='http://127.0.0.1:'+port;
 async function api(method,path,body,token){const r=await fetch(base+'/api'+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});const data=await r.json();assert(r.ok,path+': '+r.status+' '+JSON.stringify(data));return data;}
 const admin=(await api('POST','/auth/login',{username:'admin',password:'admin123'})).token;
 browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true});
 const cards=['Parts requests','Production job orders','QC technical inspection','QA appearance inspection','QA holds','RTS recording','Release orders','Kit releases'];
 const roles={parts_clerk:['Parts requests'],production_lead:['Production job orders'],production_manager:['Production job orders','QA holds'],qc_inspector:['QC technical inspection'],qa_inspector:['QA appearance inspection'],receiving_clerk:['RTS recording'],releasing_clerk:['Release orders']};
 for(const [role,allowed]of Object.entries(roles)){
  await api('POST','/users',{username:'matrix_'+role,full_name:'Matrix '+role,password:'local-fixture-password',role},admin);
  const token=(await api('POST','/auth/login',{username:'matrix_'+role,password:'local-fixture-password'})).token;
  const c=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:'block'});
  await c.addInitScript(t=>localStorage.setItem('vds_token',t),token);const p=await c.newPage();p.on('pageerror',e=>report.errors.push({role,error:e.message}));
  await p.goto(base+'/m#/work');await p.locator('#m-view .v2-work').waitFor();
  for(const label of cards)assert.equal(await p.locator('#m-view').getByRole('button',{name:new RegExp('^'+label)}).count(),allowed.includes(label)?1:0,role+': '+label);
  for(const label of allowed){await p.locator('#m-view').getByRole('button',{name:new RegExp('^'+label)}).click();await p.locator('#m-view .rk-page').waitFor();assert.equal(await p.locator('[data-no-permission]').count(),0);await p.goto(base+'/m#/work');await p.locator('#m-view .v2-work').waitFor();}
  await p.goto(base+'/m#/stock-move');await p.locator('[data-no-permission]').waitFor();
  const denied=await p.request.post(base+'/api/inventory/999999/adjust',{headers:{Authorization:'Bearer '+token},data:{change:1,reason:'Narrow role denial'}});assert.equal(denied.status(),403,role);
  report.checks.push({role,passed:true,allowed});console.log('PASS '+role+' Work visibility, own desks and stock-write denial');await c.close();
 }
 assert.deepEqual(report.errors,[]);
}catch(e){report.failure=e.stack;process.exitCode=1;console.error(e);}finally{await browser?.close();server.kill('SIGTERM');clearTimeout(timer);fs.writeFileSync(out+'/report.json',JSON.stringify(report,null,2));}
