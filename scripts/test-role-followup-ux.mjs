// Real role workflows against disposable local data; QuickBooks is mocked by the test server.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';
const output=path.resolve('work/role-followup-ux');fs.mkdirSync(output,{recursive:true});
const server=spawn(process.execPath,['--import','tsx','scripts/browser/editor-ux-server.ts'],{stdio:['ignore','pipe','pipe']});
server.stderr.on('data',d=>fs.appendFileSync(path.join(output,'server.log'),d));
let browser;const watchdog=setTimeout(()=>{server.kill();process.exit(1);},180000);
try{
  const port=await new Promise((resolve,reject)=>{let out='';server.stdout.on('data',d=>{out+=d;const m=out.match(/EDITOR_UX_PORT=(\d+)/);if(m)resolve(m[1]);});server.on('exit',c=>reject(Error('Server exit '+c)));});
  const base='http://127.0.0.1:'+port;
  async function api(method,route,body,token){
    const r=await fetch(base+'/api'+route,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
    const data=await r.json();assert(r.ok,route+': '+r.status+' '+JSON.stringify(data));return data;
  }
  const admin=(await api('POST','/auth/login',{username:'admin',password:'admin123'})).token;
  async function account(role){const username='ux_'+role,password='Disposable-role-check-2026!';await api('POST','/users',{username,password,full_name:'Synthetic '+role,role},admin);return(await api('POST','/auth/login',{username,password})).token;}
  const warehouse=await account('warehouse'),finance=await account('finance_approver'),approver=await account('purchase_approver'),csr=await account('csr');
  const period=await api('POST','/hr/periods',{label:'UX review cutoff',start_date:'2026-10-01',end_date:'2026-10-15'},admin);
  const employee=await api('POST','/hr/employees',{employee_no:'UX-PAY-FIXTURE',name:'Synthetic payslip fixture',daily_rate:500},admin);
  const shift=await api('POST','/hr/shifts',{name:'UX fixture shift',start_time:'08:00',end_time:'17:00'},admin);
  await api('POST',`/hr/periods/${period.id}/employees`,{employee_id:employee.id},admin);
  await api('PUT',`/hr/periods/${period.id}/attendance`,{employee_id:employee.id,days:[{work_date:'2026-10-01',time_in:'08:00',time_out:'17:00',shift_id:shift.id}]},admin);
  await api('POST',`/hr/periods/${period.id}/generate-payslips`,{payroll_period:'UX review cutoff'},admin);
  await api('POST','/accounting/ledger/setup',{fiscal_year_start:'2026-01-01'},admin);
  const draft=await api('POST','/orders',{type:'purchase',items:[{name:'UX draft supplier goods',quantity:2,unit_price:123.45}]},admin);
  const approved=await api('POST','/orders',{type:'purchase',status:'approved',items:[{name:'UX approved supplier goods',quantity:2,unit_price:123.45}]},admin);
  const connect=await api('GET','/quickbooks/connect',undefined,admin);
  const state=new URL(connect.url).searchParams.get('state');assert((await fetch(base+'/api/quickbooks/callback?code=fixture&realmId=99999&state='+encodeURIComponent(state))).ok);
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||fs.existsSync('/usr/bin/chromium')?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||'/usr/bin/chromium'}:{})});
  const errors=[];
  async function pageFor(token){const c=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block',timezoneId:'Asia/Manila'});await c.addInitScript(t=>localStorage.setItem('vds_token',t),token);const p=await c.newPage();p.on('pageerror',e=>errors.push(e.message));await p.goto(base+'/');await p.waitForFunction(()=>typeof App!=='undefined'&&App.getMe());return p;}
  const wp=await pageFor(warehouse);
  await wp.evaluate(()=>App.navigate('analytics'));await wp.locator('#view').getByRole('heading',{name:'Purchasing & payables'}).waitFor();
  assert.equal(await wp.locator('#view').getByText('Stock value',{exact:true}).count(),0);
  assert.equal(await wp.locator('#view').getByText('Total payable',{exact:true}).count(),0);
  await wp.screenshot({path:path.join(output,'warehouse-reports.png')});
  await wp.evaluate(id=>App.navigate('purchasing',{order:id}),draft.id);await wp.locator('#pur-recv').waitFor();
  const text=await wp.locator('#view').textContent();assert(!text.includes('123.45')&&!text.includes('246.90'));assert(text.includes('UX draft supplier goods'));
  await wp.screenshot({path:path.join(output,'warehouse-receiving.png')});
  console.log('PASS warehouse reports and receiving render with quantities and no supplier prices');

  const fp=await pageFor(finance);
  const loaded=fp.waitForResponse(r=>new URL(r.url()).pathname==='/api/hr/payroll/cutoffs');
  await fp.evaluate(()=>App.navigate('form-records',{slug:'hr_payroll'}));assert.equal((await loaded).status(),200);
  await fp.locator(`[data-bundle-post-gl="${period.id}"]`).waitFor();
  await fp.locator(`[data-bundle-post-gl="${period.id}"]`).click();
  const posted=fp.waitForResponse(r=>new URL(r.url()).pathname===`/api/hr/periods/${period.id}/post-payroll-gl`);
  await fp.getByRole('dialog').getByRole('button',{name:'Post to GL',exact:true}).click();
  const posting=await posted;assert.equal(posting.status(),201,JSON.stringify(await posting.json()));
  assert.equal((await fp.request.get(base+'/api/hr/employees',{headers:{Authorization:'Bearer '+finance}})).status(),403);
  await fp.screenshot({path:path.join(output,'finance-payroll-review.png')});
  console.log('PASS Finance Approver posts generated payroll through its normal screen without personnel access');

  const pp=await pageFor(approver);
  await pp.evaluate(()=>App.navigate('orders',{type:'purchase'}));await pp.locator(`[data-qbpush="${approved.id}"]`).waitFor();
  assert.equal(await pp.locator(`[data-qbpush="${draft.id}"]`).count(),0);
  assert.equal(await pp.locator('#ord-qb').count(),0);
  const exported=pp.waitForResponse(r=>new URL(r.url()).pathname===`/api/quickbooks/push/order/${approved.id}`);
  await pp.locator(`[data-qbpush="${approved.id}"]`).click();assert.equal((await exported).status(),200);
  const cp=await pageFor(csr);await cp.evaluate(()=>App.navigate('orders',{type:'sale'}));await cp.locator('#ord-table').waitFor();
  assert.equal(await cp.locator('[data-qbpush]').count(),0);
  console.log('PASS existing Purchase Approver exports approved documents; drafts and CSR export controls remain unavailable');
  assert.deepEqual(errors,[]);
}finally{await browser?.close();server.kill('SIGTERM');clearTimeout(watchdog);}
