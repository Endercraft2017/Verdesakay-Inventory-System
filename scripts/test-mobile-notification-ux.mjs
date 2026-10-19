// Exercises production sources with delayed sample APIs; never contacts a live server.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const read = p => fs.readFileSync(new URL('../public/' + p, import.meta.url), 'utf8');
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setContent('<main id="view" data-route="notifications"></main><div id="m-toasts"></div>');
  await page.addScriptTag({ content: read('mobile/lib/dom.js') });
  await page.addScriptTag({ content: `
    window.routes={};window.calls=[];window.mode='ok';window.failRead=true;
    window.MApp={route:(n,f)=>routes[n]=f,setTitle:()=>{},go:(n,p)=>{window.destination={n,p}},getMe:()=>({}),can:()=>true};
    window.API={isSharedSession:()=>true,clearToken:()=>{},get:async p=>{calls.push(p);await new Promise(r=>setTimeout(r,200));if(mode==='all-fail')throw Error('Sample offline');if(p==='/notifications')return{items:[{id:2,title:'Sample update',url:'#/requests?id=2',created_at:'2026-10-19 01:00:00'}]};return[]},post:async p=>{calls.push(p);await new Promise(r=>setTimeout(r,250));if(failRead&&p.includes('/notifications/'))throw Error('Sample network error');return{}}};
  ` });
  await page.addScriptTag({ content: read('mobile/modules/core/notifications.js') });
  await page.evaluate(() => routes.notifications(document.getElementById('view'), {}));
  await page.locator('[data-nid]').waitFor();
  await page.locator('[data-nid]').evaluate(b => { b.click(); b.click(); b.dispatchEvent(new MouseEvent('click')); });
  await page.locator('[data-read-error]').waitFor();
  assert.equal(await page.evaluate(() => calls.filter(p => p === '/notifications/2/read').length), 1);
  assert.equal(await page.locator('[data-nid]').getAttribute('class').then(s => s.includes('unread')), true);
  await page.locator('[data-readall]').evaluate(b => { b.click(); b.dispatchEvent(new MouseEvent('click')); });
  await page.getByRole('alert').filter({ hasText: 'Could not mark all read' }).waitFor();
  assert.equal(await page.evaluate(() => calls.filter(p => p === '/notifications/read-all').length), 1);
  await page.evaluate(() => { routes.notifications(document.getElementById('view'), {}); const v=document.getElementById('view');v.dataset.route='settings';v.textContent='Another screen'; });
  await page.waitForTimeout(350);
  assert.equal(await page.locator('#view').textContent(), 'Another screen');
  await page.evaluate(() => { mode='all-fail';const v=document.getElementById('view');v.dataset.route='notifications';routes.notifications(v,{id:999}); });
  await page.getByRole('button', { name: 'Try again' }).waitFor();
  await page.evaluate(() => { mode='ok'; });
  await page.getByRole('button', { name: 'Try again' }).click();
  await page.getByRole('alert').filter({ hasText: 'unavailable' }).waitFor();
  await page.getByRole('button', { name: 'Back to notifications' }).click();
  assert.equal(await page.evaluate(() => destination.n), 'notifications');

  await page.addScriptTag({ content: read('mobile/modules/core/settings.js') });
  await page.evaluate(() => {
    window.pushCalls=0;window.statusCalls=0;
    window.mPush={status:async()=>{statusCalls++;await new Promise(r=>setTimeout(r,100));if(statusCalls===1)throw Error('Could not check status');return 'off'},enable:async()=>{pushCalls++;await new Promise(r=>setTimeout(r,250));throw Error('Permission was not granted')},disable:async()=> 'off'};
    routes.settings(document.getElementById('view'));
  });
  await page.locator('[data-profile-action=appearance]').click();
  await page.locator('[data-notif]').filter({hasText:'Retry'}).waitFor();
  await page.getByRole('button',{name:'Check status',exact:true}).click();
  await page.locator('[data-notif]').filter({hasText:'Off'}).waitFor();
  await page.locator('[data-notif]').evaluate(b=>{b.click();b.dispatchEvent(new MouseEvent('click'));});
  await page.getByRole('status').filter({hasText:'Permission was not granted'}).waitFor();
  assert.equal(await page.evaluate(()=>pushCalls),1);
  assert.equal(await page.locator('[data-notif]').isEnabled(),true);

  // Run the actual sign-out functions; replace only the terminal browser reload.
  const app=read('mobile/app.js');
  const start=app.indexOf('  var signOutPending = null;'), end=app.indexOf('  function paintSharedBanner()',start);
  assert.ok(start!==-1&&end>start);
  await page.addScriptTag({content:`window.ME_KEY='sample';window.clearUserData=()=>{};window.go=n=>{window.queueDestination=n};window.signoutDone=false;window.queueChecks=0;window.mQueue={flush:async()=>{await new Promise(r=>setTimeout(r,200))},count:async()=>{queueChecks++;throw Error('Cannot read queue')},clearToken:()=>{}};`+app.slice(start,end).replace('location.reload();','window.signoutDone=true;')+'window.testSignOut=signOut;'});
  await page.evaluate(()=>{testSignOut();testSignOut();testSignOut();});
  await page.getByRole('dialog',{name:'Couldn’t verify unsent actions'}).waitFor();
  assert.equal(await page.getByRole('dialog').count(),1);
  assert.equal(await page.evaluate(()=>queueChecks),1);
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  assert.equal(await page.evaluate(()=>signoutDone),false);
  await page.evaluate(()=>{testSignOut();testSignOut();});
  await page.getByRole('button',{name:'Review queue'}).click();
  assert.equal(await page.evaluate(()=>queueDestination),'queue');
  await page.evaluate(()=>{testSignOut();testSignOut();});
  await page.getByRole('button',{name:'Sign out anyway'}).evaluate(b=>{b.click();b.click();});
  await page.waitForFunction(()=>signoutDone);
  assert.equal(await page.evaluate(()=>calls.filter(p=>p==='/auth/logout').length),1);
  assert.deepEqual(errors,[]);
  console.log('PASS: delayed repeated clicks, unread preservation, read-all errors, stale navigation, detail retry, permission retry, one queue warning, cancel/review, one logout.');
} finally { await browser.close(); }
