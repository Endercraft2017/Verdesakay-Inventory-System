// Exercise the actual desktop auth gate and its network transitions with sample responses.
import fs from 'node:fs';
import http from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const root=fileURLToPath(new URL('../public/',import.meta.url));
const server=http.createServer((req,res)=>{
  try {
    const pathname=new URL(req.url,'http://local').pathname;
    const file=root+(pathname==='/'?'index.html':pathname.slice(1));
    res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');
    res.end(fs.readFileSync(file));
  } catch {res.statusCode=404;res.end('');}
});
let browser;
try {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  browser=await chromium.launch({...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),headless:true,args:['--no-sandbox']});
  const base='http://127.0.0.1:'+server.address().port;
  const page=await browser.newPage();
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>localStorage.setItem('vds_token','sample-token-only'));
  let changed=false,profileFailure=true,changes=0,loadsAfterSave=0,logouts=0;
  await page.route('**/api/**',async route=>{
    const url=route.request().url();let body={},status=200;
    if(url.includes('/auth/me')){
      if(changed){loadsAfterSave++;if(profileFailure){profileFailure=false;await route.abort();return;}}
      body={user:{id:9001,username:'sample.staff',full_name:'Sample Staff',role:'employee',permissions:[],modules:[],password_change_required:!changed,mfa_setup_required:changed}};
    } else if(url.includes('/auth/change-password')){
      changes++;await new Promise(resolve=>setTimeout(resolve,500));changed=true;body={ok:true};
    } else if(url.includes('/auth/logout')){logouts++;body={ok:true};}
    else if(url.includes('departments'))body=[];
    await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.goto(base);
  let modal=page.locator('.modal');
  await modal.getByRole('heading',{name:'Choose your new password',exact:true}).waitFor();
  await modal.getByLabel('Temporary password',{exact:true}).fill('Sample-temp-238');
  await modal.getByLabel('New password',{exact:true}).fill('Sample-new-238');
  await modal.getByLabel('Confirm new password',{exact:true}).fill('Different-pass-238');
  await modal.locator('[data-confirm]').click();
  await modal.locator('[data-modal-error]').filter({hasText:'do not match'}).waitFor();
  assert.equal(changes,0);
  await modal.getByLabel('Confirm new password',{exact:true}).fill('Sample-new-238');
  await modal.locator('[data-confirm]').click();
  await modal.getByRole('button',{name:'Saving…',exact:true}).waitFor();
  // These actions must respect the pending-save guard and must not dispatch logout.
  await modal.getByRole('button',{name:'Sign out',exact:true}).click();
  await page.keyboard.press('Escape');
  assert.equal(logouts,0);
  await modal.getByRole('button',{name:'Retry access',exact:true}).waitFor();
  assert.equal(await modal.locator('[data-f=current]').inputValue(),'');
  await modal.getByRole('button',{name:'Retry access',exact:true}).click();
  await page.getByRole('heading',{name:'Set up two-step sign-in',exact:true}).waitFor();
  assert.equal(await page.locator('.modal').count(),1);
  assert.equal(changes,1);assert.equal(loadsAfterSave,2);assert.equal(logouts,0);
  // Cancellation through each standard modal dismissal must sign out exactly once.
  for(const method of ['escape','close','button','backdrop']){
    changed=false;profileFailure=false;
    await page.goto(base);
    modal=page.locator('.modal');
    await modal.getByRole('heading',{name:'Choose your new password',exact:true}).waitFor();
    const before=logouts;
    if(method==='escape'){await modal.locator('input').first().focus();await page.keyboard.press('Escape');}
    if(method==='close')await modal.getByRole('button',{name:'Close dialog',exact:true}).click();
    if(method==='button')await modal.getByRole('button',{name:'Sign out',exact:true}).click();
    if(method==='backdrop')await page.locator('.modal-overlay').click({position:{x:5,y:5}});
    await page.waitForFunction(()=>!localStorage.getItem('vds_token'));
    assert.equal(logouts-before,1);
    await page.locator('.modal').waitFor({state:'detached'});
  }
  assert.deepEqual(errors,[]);
  console.log('PASS: actual required-password gate; validation; pending-save dismissal guard; profile retry with one password POST; subsequent MFA gate; Escape/Close/Sign out/backdrop each sign out once.');
} finally {
  if(browser)await browser.close();
  await new Promise(resolve=>server.close(resolve));
}
