// Real mobile source with sample network responses; no credentials or sessions leave localhost.
import fs from 'node:fs';
import http from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const root=fileURLToPath(new URL('../public/',import.meta.url));
const server=http.createServer((req,res)=>{try{const pathname=new URL(req.url,'http://local').pathname;const file=root+(pathname==='/'?'mobile/index.html':pathname.slice(1));res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(file));}catch{res.statusCode=404;res.end('');}});
let browser;
try {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  browser=await chromium.launch({...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),headless:true,args:['--no-sandbox']});
  const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
  const page=await context.newPage();
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  let mode='password',saved=false,enabled=false,postCount={},profileFailures=1,profileLoads=0,invalid=false;
  const codes=['a1b2c-d3e4f','b2c3d-e4f5a','c3d4e-f5a6b','d4e5f-a6b7c','e5f6a-b7c8d','f6a7b-c8d9e','a7b8c-d9e0f','b8c9d-e0f1a','c9d0e-f1a2b','d0e1f-a2b3c'];
  await page.route('**/api/**',async route=>{
    const pathname=new URL(route.request().url()).pathname;
    const key=pathname.replace(/^\/api/,'');let body={},status=200;
    if(route.request().method()==='POST'){
      postCount[key]=(postCount[key]||0)+1;
      await new Promise(resolve=>setTimeout(resolve,key==='/auth/change-password'?1500:300));
      if(invalid){status=400;body={error:'This sign-in has expired. Enter your password again.'};}
      else if(key==='/auth/login')body=mode==='challenge'?{mfa_required:true,mfa_token:'sample-challenge-only'}:{token:'sample-only',user:{}};
      else if(key==='/auth/login/mfa')body={token:'sample-only'};
      else if(key==='/auth/change-password'){saved=true;body={ok:true};}
      else if(key==='/auth/mfa/setup')body={secret:'JBSWY3DPEHPK3PXP',otpauth_url:'otpauth://totp/Otom:sample?secret=JBSWY3DPEHPK3PXP&issuer=Otom'};
      else if(key==='/auth/mfa/enable'){enabled=true;body={recovery_codes:codes};}
      else body={ok:true};
    } else if(key==='/auth/me'){
      profileLoads++;
      if((saved||enabled||mode==='challenge')&&profileFailures>0){profileFailures--;await route.abort();return;}
      body={user:{id:9001,username:'sample.staff',full_name:'Sample Staff',role:'employee',permissions:[],modules:[],employee:null,password_change_required:mode==='password'&&!saved,mfa_setup_required:mode==='setup'&&!enabled}};
    } else if(key.includes('queue'))body=[];
    await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  });
  const base='http://127.0.0.1:'+server.address().port;
  async function login(shared=false){
    await page.goto(base);
    await page.locator('#m-username').fill('sample.staff');
    await page.locator('#m-password').fill('Sample-pass-238');
    if(shared)await page.locator('#m-shared').check();
    await page.locator('#m-login-form button[type=submit]').click();
    await page.locator('#m-login').waitFor({state:'hidden'});
  }
  await login();
  await page.locator('#m-temp-password').fill('Sample-temp-238');
  await page.locator('#m-new-password').fill('Sample-new-238');
  await page.locator('#m-confirm-password').fill('Different-pass-238');
  await page.locator('#m-new-password-form button[type=submit]').click();
  await page.locator('[data-auth-error]').filter({hasText:'do not match'}).waitFor();
  assert.equal(postCount['/auth/change-password']||0,0);
  await page.locator('#m-confirm-password').fill('Sample-new-238');
  await page.getByRole('button',{name:'Show temporary password',exact:true}).click();
  assert.equal(await page.locator('#m-temp-password').getAttribute('type'),'text');
  const pending=await page.locator('#m-new-password-form').evaluate(form=>{form.requestSubmit();form.requestSubmit();return {out:form.querySelector('[data-auth-out]').disabled,submit:form.querySelector('[type=submit]').disabled};});
  assert.deepEqual(pending,{out:true,submit:true});
  await page.getByRole('button',{name:'Retry access',exact:true}).waitFor();
  await page.locator('#m-new-password-form button[type=submit]').click();
  await page.locator('.m-blocked').waitFor();
  assert.equal(postCount['/auth/change-password'],1);

  // Start a separate required MFA setup flow from a fresh page/session.
  mode='setup';saved=false;profileFailures=0;
  await page.evaluate(()=>{localStorage.clear();sessionStorage.clear()});
  await login();
  await page.locator('#m-mfa-password').fill('Sample-pass-238');
  await page.getByRole('button',{name:'Show password',exact:true}).click();
  await page.locator('#m-mfa-pw').evaluate(form=>{form.requestSubmit();form.requestSubmit()});
  await page.locator('#m-mfa-enable').waitFor();
  assert.equal(postCount['/auth/mfa/setup'],1);
  await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>window.sampleCopied=value}}));
  await page.locator('[data-copy-key]').click();
  assert.equal(await page.evaluate(()=>window.sampleCopied),'JBSWY3DPEHPK3PXP');
  await page.locator('#m-mfa-code').fill('123');
  await page.locator('#m-mfa-enable button[type=submit]').click();
  await page.locator('[data-auth-error]').filter({hasText:'6-digit'}).waitFor();
  assert.equal(postCount['/auth/mfa/enable']||0,0);
  await page.locator('#m-mfa-code').fill('123456');
  await page.locator('#m-mfa-enable').evaluate(form=>{form.requestSubmit();form.requestSubmit()});
  await page.locator('#m-mfa-codes').waitFor();
  assert.equal(postCount['/auth/mfa/enable'],1);
  const originalCodes=await page.locator('.m-auth-codes').textContent();
  const beforeLoads=profileLoads;
  await page.evaluate(async()=>{window.dispatchEvent(new Event('focus'));window.dispatchEvent(new Event('online'));document.dispatchEvent(new Event('visibilitychange'));location.hash='#/settings';await MApp.refreshAccess();});
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.m-auth-codes').textContent(),originalCodes);
  assert.equal(profileLoads,beforeLoads);
  await page.locator('#m-mfa-done').click();
  await page.locator('[data-auth-error]').filter({hasText:'Save your recovery codes'}).waitFor();
  await page.locator('[data-copy-codes]').click();
  assert.equal((await page.evaluate(()=>window.sampleCopied)).split('\n').length,10);
  await page.evaluate(()=>{navigator.clipboard.writeText=async()=>{throw Error('Unavailable')}});
  await page.locator('[data-copy-codes]').click();
  assert.equal((await page.locator('[data-copy-fallback]').inputValue()).split('\n').length,10);
  const downloading=page.waitForEvent('download');await page.locator('[data-download-codes]').click();
  const file=await downloading;assert.equal(file.suggestedFilename(),'otom-recovery-codes.txt');
  assert.ok(fs.readFileSync(await file.path(),'utf8').includes(codes.join('\n')));
  await page.evaluate(()=>document.documentElement.dataset.theme='dark');
  assert.equal(await page.locator('[data-saved-codes]').evaluate(e=>getComputedStyle(e).colorScheme),'dark');
  const aligned=await page.locator('.m-auth-saved').evaluate(label=>{const a=label.querySelector('input').getBoundingClientRect(),b=label.querySelector('span').getBoundingClientRect();return a.right<b.left});assert.ok(aligned);
  await page.locator('[data-saved-codes]').check();profileFailures=1;
  await page.locator('#m-mfa-done').click();
  await page.getByRole('button',{name:'Retry access',exact:true}).waitFor();
  assert.equal(await page.locator('.m-auth-codes').textContent(),originalCodes);
  await page.locator('#m-mfa-done').click();await page.locator('.m-blocked').waitFor();

  // Recovery code sign-in retains borrowed-phone token storage and retries profile only.
  mode='challenge';profileFailures=1;
  await page.evaluate(()=>{localStorage.clear();sessionStorage.clear()});
  await login(true);
  await page.getByRole('button',{name:'Recovery code',exact:true}).click();
  assert.equal(await page.locator('#m-mfa-code').getAttribute('inputmode'),'text');
  await page.locator('#m-mfa-code').fill('a1b2c-d3e4f');
  await page.locator('#m-mfa-form button[type=submit]').click();
  await page.getByRole('button',{name:'Retry access',exact:true}).waitFor();
  await page.locator('#m-mfa-form button[type=submit]').click();await page.locator('.m-blocked').waitFor();
  assert.equal(postCount['/auth/login/mfa'],1);
  assert.equal(await page.evaluate(()=>!!sessionStorage.getItem('vds_token')&&!localStorage.getItem('vds_token')),true);
  await page.evaluate(()=>{localStorage.clear();sessionStorage.clear()});profileFailures=0;
  await login();invalid=true;
  await page.locator('#m-mfa-code').fill('123456');await page.locator('#m-mfa-form button[type=submit]').click();
  await page.locator('#m-code-help').filter({hasText:'Back to password'}).waitFor();
  await page.getByRole('button',{name:'Back to password',exact:true}).click();await page.locator('#m-login').waitFor({state:'visible'});
  invalid=false;mode='setup';enabled=false;profileFailures=0;
  await page.evaluate(()=>{localStorage.clear();sessionStorage.clear()});
  await login();await page.locator('#m-mfa-password').fill('Sample-pass-238');
  await page.locator('#m-mfa-pw button[type=submit]').click();await page.locator('#m-mfa-enable').waitFor();
  await page.locator('#m-mfa-code').fill('123456');await page.locator('#m-mfa-enable button[type=submit]').click();
  await page.locator('#m-mfa-codes').waitFor();await page.locator('[data-auth-out]').click();
  await page.locator('#m-login').waitFor({state:'visible'});
  assert.equal(await page.locator('.m-auth-codes').count(),0);
  assert.equal(await page.evaluate(()=>!!localStorage.getItem('vds_token')||!!sessionStorage.getItem('vds_token')),false);
  assert.deepEqual(errors,[]);
  console.log('PASS: five actual mobile auth surfaces; single-flight setup/enable/password; saved-password and accepted-code retries; borrowed session; code modes/expiry/back; copy fallback/download; dark checkbox/alignment; focus/online/visibility/hash preservation of once-only codes; completion with server access checks.');
} finally {if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
