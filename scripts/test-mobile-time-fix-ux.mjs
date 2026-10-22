// Actual time-fix, queue, draft guard, router and styles with fictional APIs only.
// The isolated browser stores sample queue entries; no live attendance writes or credentials.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
const read = f => fs.readFileSync(new URL('../public/' + f, import.meta.url), 'utf8');
const app = read('mobile/app.js'), router = app.slice(app.indexOf('  function hashFor('), app.indexOf('  function back('));
const index = read('mobile/index.html');
const shell = index.slice(index.indexOf('<!-- App -->'), index.indexOf('<script src="/js/api.js"')).replace('id="m-app" class="hidden"', 'id="m-app"');
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), headless: true, args: ['--no-sandbox'] });
const screenshots = process.env.TIME_FIX_UX_SCREENSHOT_DIR;
if (screenshots) fs.mkdirSync(screenshots, { recursive: true });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 900 }, timezoneId: 'Asia/Manila' });
  const page = await context.newPage(); page.setDefaultTimeout(8000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', r => r.request().url() === 'https://time-fix.example/' ? r.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Time correction source checks</title></head><body>' + shell + '</body></html>' }) : r.abort());
  await page.goto('https://time-fix.example/');
  await page.addStyleTag({ content: ['mobile/mobile.css', 'mobile/mobile-v2.css', 'css/select-controls.css'].map(read).join('\n') });
  await page.addScriptTag({ content: `
    window.routes={};window.fixture={account:1,token:crypto.randomUUID(),online:true,delay:140,writeDelay:700,failRead:0,submitMode:'sent',cancelMode:'sent',calls:[],created:new Map(),nextId:42,rows:{1:[
      {id:41,work_date:'2026-10-20',requested_in:'08:00',requested_out:'17:00',reason:'Forgot to scan after the afternoon delivery.',status:'pending',created_at:'2026-10-21 02:15:00'},
      {id:38,work_date:'2026-10-17',requested_in:null,requested_out:'17:25',reason:'The scanner was unavailable when I finished my shift.',status:'approved',created_at:'2026-10-18 00:10:00',decided_by_name:'M. Reyes',decided_at:'2026-10-19 01:20:00',decision_note:'Checked against the delivery log.'},
      {id:36,work_date:'2026-10-16',requested_in:'08:05',requested_out:null,reason:'My morning scan did not complete.',status:'rejected',created_at:'2026-10-17 00:25:00',decision_note:'Please check the work date.'}
    ]}};
    Object.defineProperty(navigator,'onLine',{configurable:true,get:()=>fixture.online});
    const delay=(ms,signal)=>new Promise((resolve,reject)=>{const t=setTimeout(resolve,ms);if(signal)signal.addEventListener('abort',()=>{clearTimeout(t);reject(Object.assign(Error('Sample request aborted'),{offline:true}))},{once:true})});
    window.API={getToken:()=>fixture.token,isSharedSession:()=>false,syncLocal:r=>r?.__syncCommand||null,
      get:async(p,o)=>{fixture.calls.push({method:'get',path:p});await delay(fixture.delay,o?.signal);if(fixture.failRead){fixture.failRead--;throw Error('Sample read unavailable')}return structuredClone(fixture.rows[fixture.account]||[])},
      post:async(p,b,o)=>{const account=fixture.account,mode=p.endsWith('/cancel')?fixture.cancelMode:fixture.submitMode;fixture.calls.push({method:'post',path:p,key:o?.idempotencyKey,account});await delay(fixture.writeDelay,o?.signal);
        if(p.endsWith('/cancel')){const row=fixture.rows[account].find(r=>r.id===Number(p.split('/').at(-2)));if(mode==='error')throw Error('Sample cancellation response lost');if(mode==='changed'){row.status='approved';row.decision_note='Reviewed while this request was open.';throw Error('Only a pending correction can be cancelled')}row.status='cancelled';return{ok:true,status:'cancelled',...(mode==='local'?{__syncCommand:'sample-cancel'}:{})}}
        if(mode==='error')throw Error('Sample server unavailable');if(mode==='queue')throw Object.assign(Error('Sample network unavailable'),{offline:true});
        if(fixture.created.has(o?.idempotencyKey))return fixture.created.get(o.idempotencyKey);
        const result={id:fixture.nextId++};fixture.created.set(o.idempotencyKey,result);fixture.rows[account].unshift({...structuredClone(b),id:result.id,status:'pending',created_at:'2026-10-22 06:15:00'});
        if(mode==='lost')throw Object.assign(Error('Sample response lost after save'),{offline:true});if(mode==='local')result.__syncCommand='sample-submit';return result;
      }};
    window.MApp={route:(n,f)=>routes[n]=f,getMe:()=>({id:fixture.account,employee:{id:fixture.account+10}}),setTitle:s=>document.querySelector('#m-title').textContent=s,render:()=>draw()};
    window.draw=()=>{if(window.mPersonalDraft&&!mPersonalDraft.allow())return;const name=location.hash.replace(/^#\\/?/,'').split('?')[0]||'home';const view=document.querySelector('#m-view');view.innerHTML='';view.dataset.route=name;if(routes[name])routes[name](view);else view.innerHTML='<h1>Other screen</h1>'};window.addEventListener('hashchange',draw);
  ` });
  for (const f of ['mobile/lib/dom.js', 'mobile/lib/personal.js', 'mobile/lib/queue.js', 'mobile/modules/hr/time-fix.js']) await page.addScriptTag({ content: read(f) });
  await page.addScriptTag({ content: '(function(){' + router + ';MApp.go=go;})();' });
  await page.evaluate(async () => {
    await mQueue.setToken(fixture.token, { id: fixture.account, full_name: 'Fictional employee' });
    document.querySelector('#m-ctx-role').textContent = 'Employee';
    document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => MApp.go(b.dataset.tab));
    document.querySelector('#m-back').onclick = () => history.back();
    MApp.go('time-fix');
  });
  const shot = async name => {
    if (!screenshots) return;
    // Fit the complete screen in a taller viewport so sticky/fixed chrome is not
    // stitched over form controls by a full-page screenshot. Product styles are untouched.
    const size = page.viewportSize(), height = await page.evaluate(() => Math.max(innerHeight, document.body.scrollHeight));
    await page.setViewportSize({ width: size.width, height }); await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: path.join(screenshots, name + '.png'), style: '#m-toasts{visibility:hidden}' });
    await page.setViewportSize(size);
  };
  const count = async suffix => page.evaluate(s => fixture.calls.filter(c => c.method === 'post' && c.path.endsWith(s)).length, suffix);
  const fill = async () => { for (const [k, v] of Object.entries({ work_date: '2026-10-20', requested_in: '08:00', requested_out: '17:00', reason: 'Forgot to scan after the afternoon delivery.' })) await page.locator('[data-k=' + k + ']').fill(v); };
  const submit = () => page.getByRole('button', { name: 'Submit request', exact: true }).click();
  const axe = async () => { const result = await new AxeBuilder({ page }).include('#m-view').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze(); assert.deepEqual(result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.failureSummary) })), []); };

  await page.locator('[data-tf-id="41"]').waitFor(); await shot('list'); await axe();
  await page.locator('[data-tf-id="41"]').focus(); await page.keyboard.press('Enter'); await page.locator('[data-tf-cancel-start]:not([disabled])').waitFor();
  await page.locator('[data-tf-cancel-start]').click(); await page.waitForFunction(() => document.activeElement.hasAttribute('data-tf-cancel-keep')); assert.equal(await count('/cancel'), 0); await shot('cancel-confirmation'); await page.locator('[data-tf-cancel-keep]').click(); await page.locator('[data-tf-back]').click(); assert.equal(await page.locator('[data-tf-id="41"]').evaluate(e => e === document.activeElement), true);
  await page.locator('#m-tf-new').click(); await submit(); await page.waitForFunction(() => document.activeElement.dataset.k === 'work_date'); assert.equal(await page.locator('[aria-invalid=true]').count(), 3);
  await fill(); await page.evaluate(() => MApp.render()); assert.equal(await page.locator('[data-k=reason]').inputValue(), 'Forgot to scan after the afternoon delivery.'); await shot('form'); await axe();
  await page.evaluate(() => MApp.go('home')); await page.locator('[data-tf-keep-draft]').click(); assert.equal(await page.locator('[data-k=reason]').inputValue(), 'Forgot to scan after the afternoon delivery.');
  await page.evaluate(() => history.back()); await page.locator('[data-tf-discard]').waitFor(); await page.locator('[data-tf-discard]').click(); await page.getByRole('heading', { name: 'Other screen', exact: true }).waitFor();
  await page.evaluate(() => MApp.go('time-fix')); await page.locator('#m-tf-new').click(); await fill(); await page.evaluate(() => fixture.submitMode = 'error'); await submit();
  await page.evaluate(() => { MApp.go('home'); const view = document.querySelector('#m-view'); view.innerHTML = ''; routes['time-fix'](view); }); assert.equal(await page.locator('[data-tf-back]').isDisabled(), true); await page.getByText('Submission was not confirmed.', { exact: false }).waitFor(); assert.equal(await count('/time-corrections'), 1);
  await page.evaluate(() => fixture.submitMode = 'sent'); await submit(); await page.getByRole('heading', { name: 'Request submitted' }).waitFor(); await page.locator('[data-tf-view-created]').click(); await page.locator('[data-tf-cancel-start]:not([disabled])').waitFor(); assert.equal(await page.evaluate(() => fixture.calls.filter(c => c.key).every(c => c.key === fixture.calls.find(x => x.key).key)), true);
  await page.evaluate(() => fixture.cancelMode = 'error'); await page.locator('[data-tf-cancel-start]').click(); await page.locator('[data-tf-cancel-confirm]').click(); assert.equal(await page.locator('[data-tf-back]').isDisabled(), true); await page.getByText('Cancellation was not confirmed.', { exact: false }).waitFor(); assert.equal(await page.locator('[data-tf-cancel-start]').count(), 0);
  await page.evaluate(() => fixture.failRead = 1); await page.locator('[data-tf-check-status]').click(); await page.getByText('Sample read unavailable.', { exact: false }).waitFor(); assert.equal(await count('/cancel'), 1); await page.locator('[data-tf-check-status]').click(); await page.locator('[data-tf-cancel-start]:not([disabled])').waitFor();
  await page.evaluate(() => fixture.cancelMode = 'changed'); await page.locator('[data-tf-cancel-start]').click(); await page.locator('[data-tf-cancel-confirm]').click(); await page.getByText('Cancellation was not confirmed.', { exact: false }).waitFor(); await page.locator('[data-tf-check-status]').click(); await page.getByText('Reviewed while this request was open.', { exact: true }).waitFor(); assert.equal(await page.locator('[data-tf-cancel-start]').count(), 0);
  await page.locator('[data-tf-back]').click(); await page.locator('[data-tf-id="38"]').click(); await page.getByRole('heading', { name: 'Review note' }).waitFor(); await page.locator('[data-tf-check-status]:not([disabled])').waitFor(); await shot('detail'); await axe();
  await page.locator('[data-tf-back]').click(); await page.evaluate(() => fixture.failRead = 1); await page.locator('[data-tf-refresh]').click(); await page.getByText('Last loaded requests are shown.', { exact: false }).waitFor(); assert.equal(await page.locator('[data-tf-id]').count(), 4); await page.locator('[data-tf-refresh]').click(); await page.locator('[data-tf-refresh]:not([disabled])').waitFor();
  await page.locator('#m-tf-new').click(); await fill(); await page.evaluate(() => { fixture.submitMode = 'lost'; fixture.online = false; }); await submit(); await page.getByRole('heading', { name: 'Saved on this phone' }).waitFor(); await shot('queued-receipt');
  assert.equal(await page.evaluate(async () => (await mQueue.all()).length), 1); const saved = await page.evaluate(() => fixture.rows[1].length);
  await page.evaluate(async () => { fixture.submitMode = 'sent'; fixture.online = true; await mQueue.flush(); }); assert.equal(await page.evaluate(() => fixture.rows[1].length), saved); assert.equal(await page.evaluate(async () => (await mQueue.all()).length), 0);
  await page.locator('[data-tf-back]').click(); await page.locator('#m-tf-new').click(); await fill(); await page.evaluate(() => fixture.submitMode = 'local'); await submit(); await page.getByRole('heading', { name: 'Saved on the site PC' }).waitFor(); await page.getByText('Cloud confirmation is pending.', { exact: false }).waitFor(); assert.equal(await page.locator('[data-tf-view-created]').count(), 0);
  await page.locator('[data-tf-back]').click(); await page.locator('[data-tf-id="41"]').click(); await page.locator('[data-tf-cancel-start]:not([disabled])').waitFor(); await page.evaluate(() => fixture.cancelMode = 'local'); await page.locator('[data-tf-cancel-start]').click(); await page.locator('[data-tf-cancel-confirm]').click(); await page.getByText('Cancellation saved on the site PC.', { exact: false }).waitFor(); assert.equal(await page.locator('[data-tf-cancel-start]').count(), 0);
  await page.locator('[data-tf-back]').click(); await page.locator('#m-tf-new').click(); await fill(); await page.evaluate(() => { fixture.submitMode = 'queue'; fixture.online = false; }); await submit();
  await page.evaluate(async () => { fixture.account = 2; fixture.token = crypto.randomUUID(); fixture.rows[2] = []; await mQueue.setToken(fixture.token, { id: 2 }); MApp.render(); }); await page.getByRole('heading', { name: 'No corrections yet' }).waitFor(); await page.waitForTimeout(850); assert.equal(await page.evaluate(async () => (await mQueue.all()).length), 0); assert.equal(await page.locator('form').count(), 0);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; fixture.rows[2] = [{ id: 61, work_date: '2026-10-20', status: 'approved', requested_in: '08:00', reason: 'Fictional correction.' }]; }); await page.locator('[data-tf-refresh]').click(); await page.locator('[data-tf-id="61"]').waitFor(); await axe();
  await page.setViewportSize({ width: 360, height: 500 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await page.locator('#m-tf-new').click(); await submit();
  const focusVisible = await page.locator('[data-k=work_date]').evaluate(e => { const r = e.getBoundingClientRect(); return r.top >= document.querySelector('.m-topbar').getBoundingClientRect().bottom && r.bottom <= document.querySelector('.m-tabbar').getBoundingClientRect().top; }); assert.equal(focusVisible, true, 'first invalid field is visible between the app header and bottom navigation');
  await page.setViewportSize({ width: 360, height: 800 }); await shot('dark-errors'); await axe(); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log('PASS: actual correction, queue, draft guard and router sources; three screens, keyboard/focus, inline errors, draft rerender and browser Back, one pending write, stable retry/replay key, lost-response queue replay without another record, honest queue/site-PC outcomes, fresh cancellation checks and recovery, account-switch protection, dark 360px layout, automated accessibility and six screenshots. No live attendance writes.');
} finally { await browser.close(); }
