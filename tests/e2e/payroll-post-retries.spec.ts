/// <reference lib="dom" />
import {test,expect,type Page} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function open(page:Page,kind:string){
 await page.goto('/?view=desktop');await page.locator('#login-username').fill('admin');await page.locator('#login-password').fill('admin123-test-only');await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page.locator('#app-screen')).toBeVisible();
 await page.evaluate(async label=>{const w=window as any;const p=(await w.API.get('/hr/periods')).find((p:any)=>p.label===label);await w.App.navigate('hr-timekeeping',{period_id:p.id});},'GL-POST-BROWSER-'+kind);
 await page.locator('#tk-more-toggle').click();await page.locator('#tk-post-gl').click();
 const dialog=page.getByRole('dialog',{name:'Post payroll to the General Ledger',exact:true});await expect(dialog).toBeVisible();return dialog;
}
test.beforeAll(async({request})=>{
 const login=await(await request.post('/api/auth/login',{data:{username:'admin',password:'admin123-test-only'}})).json();
 expect((await request.post('/api/accounting/ledger/setup',{headers:{Authorization:`Bearer ${login.token}`},data:{fiscal_year_start:'2026-01-01'}})).status()).toBe(201);
});
test('a committed response lost in transit recovers its original journal with the same attempt',async({page})=>{
 const keys:string[]=[];let original:number|undefined,recovered:number|undefined;
 await page.route('**/post-payroll-gl',async route=>{
  keys.push(route.request().headers()['idempotency-key']!);const r=await route.fetch();expect(r.status()).toBe(201);const body=await r.json();
  if(keys.length===1){original=body.entry.id;await route.abort('failed');}
  else{expect(r.headers()['idempotency-replayed']).toBe('true');recovered=body.entry.id;await route.fulfill({response:r});}
 });
 const dialog=await open(page,'LOST'),confirm=dialog.getByRole('button',{name:'Post to GL',exact:true});await confirm.click();
 await expect(dialog.getByRole('status')).toContainText('Posting was not confirmed');await expect(confirm).toBeEnabled();await expect(dialog.getByLabel('Payroll period label')).toBeDisabled();
 await confirm.click();await expect(dialog).toBeHidden();expect(keys).toHaveLength(2);expect(keys[0]).toMatch(/^[a-f0-9]{32}$/);expect(keys[1]).toBe(keys[0]);expect(recovered).toBe(original);
 await expect(page.locator('#toasts')).toContainText('Recovered the original posting');
});
test('a hung response reaches its deadline and retains the committed attempt for retry',async({page})=>{
 await page.clock.install();let release:(()=>void)|undefined,committed!:()=>void;const saved=new Promise<void>(r=>{committed=r;});let key:string|undefined,original:number|undefined,attempts=0;
 await page.route('**/post-payroll-gl',async route=>{
  attempts++;const current=route.request().headers()['idempotency-key'];
  if(attempts===1){key=current;const r=await route.fetch();expect(r.status()).toBe(201);original=(await r.json()).entry.id;committed();await new Promise<void>(r=>{release=r;});try{await route.abort('failed');}catch{}return;}
  expect(current).toBe(key);const r=await route.fetch();expect(r.headers()['idempotency-replayed']).toBe('true');expect((await r.json()).entry.id).toBe(original);await route.fulfill({response:r});
 });
 try{
  const dialog=await open(page,'TIMEOUT'),confirm=dialog.getByRole('button',{name:'Post to GL',exact:true});await confirm.click();await saved;await expect(confirm).toBeDisabled();await page.clock.fastForward(20001);
  await expect(confirm).toBeEnabled();await expect(dialog.getByRole('status')).toContainText('Posting was not confirmed');await expect(dialog.getByLabel('Payroll period label')).toBeDisabled();release?.();
  await confirm.click();await expect(dialog).toBeHidden();expect(attempts).toBe(2);
 }finally{release?.();}
});
for(const kind of ['ACTOR','COMPANY','VIEW'])test(`changed ${kind.toLowerCase()} invalidates an open posting before any submission`,async({page})=>{
 let writes=0;page.on('request',r=>{if(r.method()==='POST'&&r.url().includes('/post-payroll-gl'))writes++;});
 const dialog=await open(page,kind);
 await page.evaluate(async kind=>{const w=window as any;if(kind==='ACTOR')w.App.setMe({full_name:'Changed synthetic operator'});else if(kind==='COMPANY')w.VDS_BASE_PATH='/other-company';else await w.App.navigate('hr');},kind);
 if(kind==='VIEW'){await expect(dialog).toBeHidden();expect(writes).toBe(0);return;}
 await dialog.getByRole('button',{name:'Post to GL',exact:true}).click();await expect(dialog.getByRole('alert')).toContainText('changed');await expect(dialog.getByLabel('Payroll period label')).toHaveValue('');expect(writes).toBe(0);
});
test('posting confirmation is labelled, accessible and usable at supported desktop widths and themes',async({page})=>{
 const dialog=await open(page,'ACCESS'),results=[];
 for(const theme of ['light','dark'])for(const width of [1440,1024,768,390]){
  await page.setViewportSize({width,height:900});await page.evaluate(theme=>document.documentElement.setAttribute('data-theme',theme),theme);
  await expect(dialog.getByLabel('Payroll period label')).toBeVisible();const button=dialog.getByRole('button',{name:'Post to GL',exact:true});await expect(button).toBeInViewport();
  // Inspect a settled theme: foreground tokens switch immediately while button
  // backgrounds transition for 180ms. Await actual animations rather than sleep.
  await dialog.evaluate(async el=>{getComputedStyle(el.querySelector('button')!).backgroundColor;await Promise.all(el.getAnimations({subtree:true}).map(a=>a.finished.catch(()=>{})));});
  const result=await new AxeBuilder({page}).include('[role="dialog"]').analyze();expect(result.violations).toEqual([]);results.push({theme,width,incomplete:result.incomplete.map(x=>({id:x.id,impact:x.impact}))});
  await page.screenshot({path:`work/payroll-post-${theme}-${width}.png`});
 }
 const fs=await import('node:fs');fs.writeFileSync('work/payroll-post-browser-accessibility.json',JSON.stringify(results,null,2)+'\n');
});
