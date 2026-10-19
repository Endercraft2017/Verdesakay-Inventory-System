// Browser checks against the real account/MFA/UI sources, with sample API responses.
import fs from 'node:fs';
import http from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));
const read = name => fs.readFileSync(publicRoot + name, 'utf8');
const script = value => '<script>' + value.replace(/<\/script/gi, '<\\/script') + '</script>';
const api = `
window.sample={response:'success',loadError:false,clipboard:'',calls:[],mfa:false};
window.App={getMe:()=>({username:'sample.staff',full_name:'Sample Staff',role:'employee',department_name:'Operations'}),setMe:()=>{},hasPermission:()=>true,register:(name,render)=>window.renderAccount=render};
const codes=['a1b2c-d3e4f','b2c3d-e4f5a','c3d4e-f5a6b','d4e5f-a6b7c','e5f6a-b7c8d','f6a7b-c8d9e','a7b8c-d9e0f','b8c9d-e0f1a','c9d0e-f1a2b','d0e1f-a2b3c'];
const API={get:async p=>{if(sample.loadError&&p!=='/tenant'&&p!=='/messages/quota')throw Error('Could not load this section');if(p==='/tenant')return{company_id:'SAMPLE-001'};if(p==='/auth/mfa')return{available:true,enabled:sample.mfa,required:false,recovery_codes_left:10};if(p.startsWith('/auth/sessions'))return[];return{used_bytes:0,cap_bytes:1000}},post:async(p,body)=>{sample.calls.push(p);await new Promise(r=>setTimeout(r,200));if(sample.response==='offline'){const e=Error('Network unavailable');e.offline=true;throw e}if(sample.response==='expired')throw Error('This sign-in has expired. Enter your password again.');if(sample.response==='invalid')throw Error('That code is not right. Check your authenticator app and try again.');if(p==='/auth/mfa/setup')return{secret:'JBSWY3DPEHPK3PXP',otpauth_url:'otpauth://totp/Otom:sample?secret=JBSWY3DPEHPK3PXP&issuer=Otom'};if(p==='/auth/mfa/recovery-codes')return{recovery_codes:codes};if(p==='/auth/mfa/enable'){sample.mfa=true;return{recovery_codes:codes}}if(p==='/auth/change-username')return{username:body.new_username};return{ok:true}},put:async(p,body)=>{sample.calls.push(p);await new Promise(r=>setTimeout(r,200));if(sample.response==='offline'){const e=Error('Network unavailable');e.offline=true;throw e}return{ok:true}}};
Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{sample.clipboard=value}}});
`;
const html = '<!doctype html><html data-theme="light"><head><style>' +
  ['css/styles.css', 'css/visual-refresh.css', 'css/select-controls.css'].map(read).join('\n') +
  '</style></head><body><main id="view" style="padding:16px"></main><div id="modal-root"></div><div id="toasts"></div>' +
  script(api) + ['js/ui.js','js/auth-controls.js','mobile/vendor/qrcode.js','js/lib/session-list.js','js/lib/mfa.js','js/modules/core/account.js'].map(name=>script(read(name))).join('') +
  script('window.TestMfa=Mfa;window.TestSessions=SessionList;renderAccount(document.getElementById("view"));') + '</body></html>';
const server = http.createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end(html);});
let browser;
try {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH} : {}), headless:true, args:['--no-sandbox'] });
  const page = await browser.newPage({viewport:{width:1100,height:1000}});
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://127.0.0.1:'+server.address().port);
  await page.getByLabel('Display name',{exact:true}).fill('Updated Sample');
  await page.locator('#pf-save').evaluate(button=>{button.click();button.click();});
  await page.getByText('Profile saved.',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>sample.calls.filter(p=>p==='/auth/profile').length),1);
  await page.evaluate(()=>sample.response='offline');
  await page.locator('#pf-save').click();
  await page.locator('#pf-err').filter({hasText:'offline'}).waitFor();
  assert.equal(await page.locator('#pf-err').evaluate(e=>e===document.activeElement),true);
  assert.equal(await page.locator('#pf-name').inputValue(),'Updated Sample');
  await page.evaluate(()=>sample.response='success');
  await page.locator('#cur-pw').fill('Sample-pass-238');
  await page.getByLabel('New password',{exact:true}).fill('Sample-new-238');
  await page.getByLabel('Confirm new password',{exact:true}).fill('Different-pass-238');
  await page.locator('#pw-save').click();
  await page.locator('#pw-err').filter({hasText:'do not match'}).waitFor();
  assert.equal(await page.evaluate(()=>sample.calls.includes('/auth/change-password')),false);
  await page.getByLabel('Confirm new password',{exact:true}).fill('Sample-new-238');
  await page.locator('#pw-save').click();
  await page.locator('#pw-status').filter({hasText:'other sessions have ended'}).waitFor();
  assert.equal(await page.locator('#cur-pw').inputValue(),'');
  await page.locator('#un-next').fill('sample.updated');
  await page.locator('#un-current').fill('Sample-pass-238');
  await page.locator('#un-form').getByRole('button',{name:'Show username confirmation password',exact:true}).click();
  await page.locator('#un-form').evaluate(form=>{form.requestSubmit();form.requestSubmit()});
  await page.locator('#un-status').filter({hasText:'Username updated'}).waitFor();
  assert.equal(await page.evaluate(()=>sample.calls.filter(p=>p==='/auth/change-username').length),1);

  await page.evaluate(()=>{TestMfa.askCode('sample-challenge').then(result=>window.challengeResult=result)});
  let modal=page.locator('.modal');
  await modal.locator('[data-confirm]').click();
  await modal.locator('[data-modal-error]').filter({hasText:'6-digit'}).waitFor();
  await modal.getByRole('button',{name:'Recovery code',exact:true}).click();
  assert.equal(await modal.locator('[data-f=code]').getAttribute('inputmode'),'text');
  await modal.locator('[data-f=code]').fill('a1b2c-d3e4f');
  await modal.locator('[data-confirm]').click();
  await modal.waitFor({state:'detached'});
  assert.ok(await page.evaluate(()=>window.challengeResult));
  await page.evaluate(()=>{sample.response='expired';TestMfa.askCode('sample-challenge').then(result=>window.challengeResult=result)});
  modal=page.locator('.modal');
  await modal.locator('[data-f=code]').fill('123456');
  await modal.locator('[data-confirm]').click();
  await modal.locator('[data-expired]').waitFor({state:'visible'});
  await modal.getByRole('button',{name:'Back to password',exact:true}).click();
  await modal.waitFor({state:'detached'});
  assert.equal(await page.evaluate(()=>window.challengeResult),null);

  await page.evaluate(()=>{sample.response='success';TestMfa.setup().then(result=>window.setupResult=result)});
  modal=page.locator('.modal');
  await modal.getByLabel('Your password',{exact:true}).fill('Sample-pass-238');
  await modal.getByRole('button',{name:'Show password',exact:true}).click();
  assert.equal(await modal.locator('[data-f=pw]').getAttribute('type'),'text');
  await modal.locator('[data-confirm]').click();
  await page.getByRole('heading',{name:'Add it to your authenticator app',exact:true}).waitFor();
  await modal.locator('[data-copy-key]').click();
  assert.equal(await page.evaluate(()=>sample.clipboard),'JBSWY3DPEHPK3PXP');
  await modal.locator('[data-f=code]').fill('123');
  await modal.locator('[data-confirm]').click();
  await modal.locator('[data-modal-error]').filter({hasText:'6-digit'}).waitFor();
  await modal.locator('[data-f=code]').fill('123456');
  await modal.locator('[data-confirm]').click();
  await page.getByRole('heading',{name:'Two-step sign-in is on',exact:true}).waitFor();
  await modal.locator('[data-confirm]').click();
  await modal.locator('[data-save-reminder]').filter({hasText:'Save your codes'}).waitFor();
  await modal.locator('[data-copy-codes]').click();
  assert.equal((await page.evaluate(()=>sample.clipboard)).split('\n').length,10);
  await page.evaluate(()=>{navigator.clipboard.writeText=async()=>{throw Error('Unavailable')};document.execCommand=()=>false});
  await modal.locator('[data-copy-codes]').click();
  assert.equal((await modal.locator('[data-copy-fallback]').inputValue()).split('\n').length,10);
  const downloaded=page.waitForEvent('download');
  await modal.locator('[data-download-codes]').click();
  const file=await downloaded;
  assert.equal(file.suggestedFilename(),'otom-recovery-codes.txt');
  const text=fs.readFileSync(await file.path(),'utf8');
  assert.ok(text.includes('a1b2c-d3e4f\nb2c3d-e4f5a'));
  await page.evaluate(()=>document.documentElement.dataset.theme='dark');
  assert.equal(await modal.locator('[data-saved-codes]').evaluate(e=>getComputedStyle(e).colorScheme),'dark');
  await modal.locator('[data-saved-codes]').check();
  await modal.locator('[data-confirm]').click();
  await modal.waitFor({state:'detached'});
  assert.equal(await page.evaluate(()=>window.setupResult),true);
  await page.setViewportSize({width:390,height:900});
  assert.equal(await page.locator('.account-details-grid').evaluate(e=>getComputedStyle(e).gridTemplateColumns.split(' ').length),1);
  await page.evaluate(async()=>{sample.loadError=true;await renderAccount(document.getElementById('view'))});
  await page.locator('[data-mfa-retry]').waitFor();
  await page.locator('[data-session-retry]').waitFor();
  await page.evaluate(()=>sample.loadError=false);
  await page.locator('[data-mfa-retry]').click();
  await page.locator('#acc-mfa').getByText('On.',{exact:true}).waitFor();
  await page.locator('[data-session-retry]').click();
  await page.getByText('No sign-ins recorded.',{exact:true}).waitFor();
  await page.evaluate(()=>{TestMfa.disable().then(result=>window.disabledResult=result)});
  modal=page.locator('.modal');
  await modal.getByLabel('Your current password',{exact:true}).fill('Sample-pass-238');
  await modal.getByRole('button',{name:'Recovery code',exact:true}).click();
  assert.equal(await modal.locator('[data-f=code]').getAttribute('inputmode'),'text');
  await modal.locator('[data-f=code]').fill('a1b2c-d3e4f');
  await page.evaluate(()=>sample.response='invalid');
  await modal.locator('[data-confirm]').click();
  await modal.locator('[data-modal-error]').waitFor({state:'visible'});
  assert.equal(await modal.locator('[data-f=pw]').inputValue(),'Sample-pass-238');
  await page.evaluate(()=>sample.response='success');
  await modal.locator('[data-confirm]').click();
  await modal.waitFor({state:'detached'});
  assert.equal(await page.evaluate(()=>window.disabledResult),true);
  await page.evaluate(()=>{TestMfa.newRecoveryCodes().then(()=>window.replacedResult=true)});
  modal=page.locator('.modal');
  await modal.getByLabel('Your current password',{exact:true}).fill('Sample-pass-238');
  await modal.locator('[data-f=code]').fill('123456');
  await modal.getByRole('button',{name:'Replace recovery codes',exact:true}).click();
  await page.getByRole('heading',{name:'Your new recovery codes',exact:true}).waitFor();
  await modal.getByText('Your old recovery codes no longer work. Save this new set before leaving.',{exact:true}).waitFor();
  await modal.locator('[data-confirm]').click();
  await modal.locator('[data-save-reminder]').filter({hasText:'replacement codes'}).waitFor();
  await modal.locator('[data-saved-codes]').check();
  await modal.locator('[data-confirm]').click();
  await modal.waitFor({state:'detached'});
  assert.equal(await page.evaluate(()=>window.replacedResult),true);
  await page.evaluate(async()=>{
    sample.response='success';sample.revoked=false;
    window.renderSampleSessions=()=>TestSessions.render(document.querySelector('#acc-sessions'),{
      load:async()=>[{id:'current',current:true,device:'Sample current browser'},...(sample.revoked?[]:[{id:'other1',device:'Sample phone'},{id:'other2',device:'Sample PC'}])],
      revokeAllPreservesCurrent:true,
      revokeAll:async()=>{await API.post('/auth/sessions/revoke-others');sample.revoked=true;return{ended:2}},
    });await renderSampleSessions();
  });
  await page.locator('[data-end-all]').click();
  modal=page.locator('.modal');
  await modal.getByText('2 other active sign-in sessions',{exact:true}).waitFor();
  await modal.locator('.modal-foot [data-close]').click();
  await modal.waitFor({state:'detached'});
  await page.locator('[data-end-all]').click();
  await page.evaluate(()=>sample.response='offline');
  await modal.locator('[data-confirm]').click();
  await modal.locator('[data-modal-error]').waitFor({state:'visible'});
  await page.evaluate(()=>sample.response='success');
  await modal.locator('[data-confirm]').click();
  await modal.getByText('2 other sessions signed out. This browser stays signed in.',{exact:true}).waitFor();
  assert.equal(await modal.locator('[data-confirm]').isVisible(),false);
  assert.equal(await page.locator('#acc-sessions tbody tr').count(),1);
  await modal.locator('.modal-foot [data-close]').click();
  await page.evaluate(async()=>{
    window.nativeConfirmCalled=false;window.confirm=()=>{window.nativeConfirmCalled=true;return false};
    await TestSessions.render(document.querySelector('#acc-sessions'),{load:async()=>[{id:'other',device:'Other user sample device'}],revokeAll:async()=>{throw Error('Must not run after cancellation')}});
  });
  await page.locator('[data-end-all]').click();
  assert.equal(await page.evaluate(()=>window.nativeConfirmCalled),true);
  assert.equal(await page.locator('.modal').count(),0);
  await page.evaluate(()=>{TestMfa.setup({forced:true}).then(result=>window.forcedResult=result)});
  await page.locator('.modal-foot').getByRole('button',{name:'Sign out',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.forcedResult),false);
  assert.deepEqual(errors,[]);
  console.log('PASS: account pending guards/results/errors, password validation, username Show/Hide + submit, both MFA code modes/expiry, full setup, clipboard fallback/download, save reminder, dark checkbox, narrow layout, load retries, forced cancellation.');
} finally {
  if(browser)await browser.close();
  await new Promise(resolve=>server.close(resolve));
}
