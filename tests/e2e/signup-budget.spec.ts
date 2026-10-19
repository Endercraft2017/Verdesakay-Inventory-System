import {test,expect} from '@playwright/test';
async function form(page:any,name:string){
 await page.goto('/');await page.getByRole('button',{name:'New customer',exact:true}).click();
 const f=page.locator('#signup-form');await f.getByLabel('Company or business name').fill(name);await f.getByLabel('Admin username').fill('owner');await f.getByLabel('Email',{exact:true}).fill('signup-budget@example.test');await f.getByLabel('Admin password').fill('Synthetic browser admission password');await expect(f.locator('#signup-submit')).toBeEnabled();return f;
}
test('signup deadline preserves a committed request identity and retries without duplicate invoice',async({browser})=>{
 const context=await browser.newContext({baseURL:'http://localhost:4173'}),page=await context.newPage();let release!:()=>void;
 try{
  const f=await form(page,'Browser Signup Deadline');await page.clock.install();let key:string|undefined,seen!:()=>void;
  const committed=new Promise<void>(r=>seen=r),held=new Promise<void>(r=>release=r);let first=true;
  await page.route('**/api/signup',async route=>{
   if(first){first=false;key=route.request().headers()['idempotency-key'];const r=await route.fetch();expect(r.status()).toBe(201);seen();await held;try{await route.fulfill({response:r});}catch{}}
   else{expect(route.request().headers()['idempotency-key']).toBe(key);await route.continue();}
  });
  await f.locator('#signup-submit').click();await committed;await page.clock.fastForward(20001);
  await expect(f.getByRole('alert')).toHaveText('Registration timed out. Retry with the same details.');await expect(f.locator('#signup-submit')).toBeEnabled();await expect(f.getByLabel('Company or business name')).toHaveValue('Browser Signup Deadline');release();
  const response=page.waitForResponse(r=>r.url().endsWith('/api/signup')&&r.request().method()==='POST');await f.locator('#signup-submit').click();const replay=await response;expect(replay.status()).toBe(201);expect(replay.headers()['idempotency-replayed']).toBe('true');await expect(page).toHaveURL(/\/browser-signup-deadline$/);
  const login=await context.request.post('/browser-signup-deadline/api/auth/login',{data:{username:'owner',password:'Synthetic browser admission password'}});expect(login.status()).toBe(200);
  const billing=await context.request.get('/browser-signup-deadline/api/tenant/billing',{headers:{Authorization:'Bearer '+(await login.json()).token}});expect((await billing.json()).invoices).toHaveLength(1);
 }finally{if(release)release();await context.close();}
});
test('signup busy response retains fields and the same key for a successful retry',async({browser})=>{
 const context=await browser.newContext({baseURL:'http://localhost:4173'}),page=await context.newPage();
 try{
  const f=await form(page,'Browser Signup Busy');let first=true,key:string|undefined;
  await page.route('**/api/signup',async route=>{if(first){first=false;key=route.request().headers()['idempotency-key'];await route.fulfill({status:503,contentType:'application/json',headers:{'Retry-After':'5'},body:JSON.stringify({error:'Registration is busy. Try again shortly.'})});}else{expect(route.request().headers()['idempotency-key']).toBe(key);await route.continue();}});
  await f.locator('#signup-submit').click();await expect(f.getByRole('alert')).toHaveText('Registration is busy. Try again shortly.');await expect(f.getByLabel('Company or business name')).toHaveValue('Browser Signup Busy');await expect(f.locator('#signup-submit')).toBeEnabled();await f.locator('#signup-submit').click();await expect(page).toHaveURL(/\/browser-signup-busy$/);
 }finally{await context.close();}
});
test('signup refuses null, HTML and wrong-status success without losing request identity',async({browser})=>{
 const context=await browser.newContext({baseURL:'http://localhost:4173'}),page=await context.newPage();
 try{
  const f=await form(page,'Browser Signup Confirm');let n=0,key:string|undefined;
  await page.route('**/api/signup',async route=>{const current=route.request().headers()['idempotency-key'];if(!key)key=current;expect(current).toBe(key);n++;
   if(n===1)await route.fulfill({status:201,contentType:'application/json',body:'null'});
   else if(n===2)await route.fulfill({status:200,contentType:'text/html',body:'<html>Synthetic fallback</html>'});
   else if(n===3)await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({slug:'browser-signup-confirm'})});else await route.continue();
  });
  for(let i=0;i<3;i++){await f.locator('#signup-submit').click();await expect(f.getByRole('alert')).toHaveText('Registration was not confirmed. Retry with the same details.');await expect(f.locator('#signup-submit')).toBeEnabled();}
  await f.locator('#signup-submit').click();await expect(page).toHaveURL(/\/browser-signup-confirm$/);
 }finally{await context.close();}
});
