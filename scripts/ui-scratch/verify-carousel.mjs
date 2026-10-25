import assert from 'node:assert/strict';
import path from 'node:path';
import {expect} from 'playwright/test';
import {output} from './build.mjs';

export async function verifyCarousel({page,reset,data,quantity,screenshot,accessible,check,report}) {
 const visible=f=>f.locator('[data-batch-row].is-current');
 async function image(f){await expect(visible(f).locator('[data-photo-item].is-current img')).toHaveCount(1);}
 await check('Photo and list presentations share fields, values, source stock and account-scoped preference',async()=>{
  const f=await reset({layout:'photos',ready:true});await image(f);await expect(visible(f)).toHaveCount(1);
  await f.evaluate(()=>window.__quantityReference=document.querySelector('[data-batch-qty="1"]'));
  await quantity(f,1,5);await f.locator('[data-batch-step="-1"][data-id="1"]').click();await expect(f.locator('[data-batch-qty="1"]')).toHaveValue('4');await f.locator('[data-batch-step="1"][data-id="1"]').click();
  await f.locator('[data-batch-next]').click();await expect(f.locator('[data-batch-position]')).toHaveText(/^Item 2\./);await f.locator('[data-batch-prev]').click();await expect(f.locator('[data-batch-qty="1"]')).toHaveValue('5');
  await f.locator('[data-batch-layout="list"]').click();await expect(f.locator('[data-batch-row]')).toHaveCount(3);assert(await f.evaluate(()=>__quantityReference===document.querySelector('[data-batch-qty="1"]')));
  await f.locator('[data-batch-layout="photos"]').click();await f.locator('[data-batch-context-toggle]').click();await f.locator('[data-batch-location] select').selectOption('2');await expect(visible(f).locator('[data-batch-photo-source]')).toHaveText('Branch');await expect(visible(f).locator('[data-batch-before]')).toHaveText('8');
  assert.equal((await data(f)).applied,0);assert.equal((await data(f)).journal.filter(r=>r.method==='POST').length,0);
  assert.equal(await f.evaluate(()=>localStorage.getItem('vds_batch_layout:'+JSON.stringify(['',1]))),'photos');
 });
 await check('Photo-only horizontal drag and keyboard/button navigation never change quantity',async()=>{
  const f=await reset({layout:'photos',ready:true});await image(f);const before=(await data(f)).stock;
  const stage=visible(f).locator('[data-batch-photo]'),r=await stage.boundingBox();
  await page.mouse.move(r.x+r.width*.8,r.y+r.height/2);await page.mouse.down();await page.mouse.move(r.x+r.width*.15,r.y+r.height/2,{steps:8});await page.mouse.up();
  await expect(f.locator('[data-batch-position]')).toHaveText(/^Item 2\./);await image(f);
  const other=await visible(f).locator('[data-batch-photo]').boundingBox();await page.mouse.move(other.x+100,other.y+20);await page.mouse.down();await page.mouse.move(other.x+105,other.y+90,{steps:6});await page.mouse.up();await expect(f.locator('[data-batch-position]')).toHaveText(/^Item 2\./);
  await visible(f).locator('[data-batch-photo]').focus();await visible(f).locator('[data-batch-photo]').press('ArrowLeft');await expect(f.locator('[data-batch-position]')).toHaveText(/^Item 1\./);await expect(f.locator('[data-batch-prev]')).toBeHidden();
  await f.locator('[data-batch-qty="1"]').focus();await f.locator('[data-batch-qty="1"]').press('ArrowRight');await expect(f.locator('[data-batch-position]')).toHaveText(/^Item 1\./);
  await f.locator('[data-batch-next]').click();await f.locator('[data-batch-next]').click();await expect(f.locator('[data-batch-next]')).toBeHidden();await expect(f.locator('[data-batch-qty="3"]')).toHaveValue('2');assert.deepEqual((await data(f)).stock,before);assert.equal((await data(f)).applied,0);
 });
 await check('The photo Review shortcut reveals the blocked item before focusing and records the same payload',async()=>{
  const f=await reset({layout:'photos'});await f.locator('[data-batch-jump]').click();await expect(visible(f)).toHaveAttribute('data-batch-row','3');await expect(f.locator('[data-batch-qty="3"]')).toBeFocused();await expect(f.locator('[data-batch-record]')).toBeDisabled();await quantity(f,3,2);await f.locator('[data-batch-record]').click();await expect(f.locator('[data-batch-result-title]')).toHaveText('Batch recorded');assert.deepEqual((await data(f)).journal.filter(r=>r.method==='POST').map(r=>r.body.change),[-3,-2,-2]);
 });
 await check('Missing and failed images preserve identity, quantities and safe recording; retry only reads the image',async()=>{
  for(const photo of ['missing','failed']){const f=await reset({layout:'photos',photo,ready:true});await expect(visible(f).locator('[data-photo-item].is-current [data-batch-photo-content]')).toContainText(photo==='missing'?'No photo saved':'Photo unavailable');await expect(f.locator('[data-batch-qty="1"]')).toHaveValue('3');await expect(f.locator('[data-batch-record]')).toBeEnabled();await expect(visible(f)).toContainText('DEMO-BOLT');
   if(photo==='missing'){assert.equal((await data(f)).journal.filter(r=>r.path.endsWith('/image')).length,0);await screenshot('photo-missing');}
   else {await page.locator('#reconnect').click();await visible(f).locator('[data-photo-item].is-current .m-batch-photo-retry').click();await image(f);assert.equal((await data(f)).journal.filter(r=>r.method==='POST').length,0);}
  }
 });
 await check('Slow or cancelled photo responses cannot appear on another item or another route',async()=>{
  const f=await reset({layout:'photos',photo:'slow'});await expect(visible(f).locator('[data-photo-item].is-current [data-batch-photo-content]')).toContainText('Loading');await f.locator('[data-batch-next]').click();await image(f);await expect(visible(f).locator('[data-photo-item].is-current img')).toHaveAttribute('alt',/Control cable/);await expect(visible(f).locator('[data-photo-item].is-current img')).not.toHaveAttribute('alt',/M8 flange bolt/);
  await f.locator('[data-batch-next]').click();await f.evaluate(()=>MApp.go('work'));await expect(f.locator('#m-view')).toContainText('Outside this review');await page.waitForTimeout(1600);await expect(f.locator('#m-view')).toContainText('Outside this review');await expect(f.locator('[data-batch-photo]')).toHaveCount(0);
 });
 await check('Photo stock-check recovery and empty new batches expose the existing source and picker controls',async()=>{
  let f=await reset({layout:'photos',response:'readfail'});await f.locator('[data-batch-jump]').click();await expect(f.locator('[data-batch-refresh]')).toBeFocused();await expect(f.locator('.m-batch-context')).toBeVisible();await page.locator('#reconnect').click();await f.locator('[data-batch-refresh]').click();await expect(f.locator('[data-batch-row="1"] [data-batch-before]')).toHaveText('12');await expect(f.locator('[data-batch-qty="1"]')).toHaveValue('3');
  f=await reset({layout:'photos',ready:true});await f.locator('[data-batch-record]').click();await expect(f.locator('[data-batch-result-title]')).toHaveText('Batch recorded');await f.locator('[data-batch-new]').click();await expect(f.locator('[data-batch-root]')).toHaveAttribute('data-batch-layout','photos');await expect(f.locator('.m-picker input')).toBeVisible();await expect(f.locator('[data-batch-row]')).toHaveCount(0);await expect(f.locator('[data-batch-record]')).toBeDisabled();
 });
 await check('Current photo layout keeps quantity and settled-number pagination clear of the dock',async()=>{
  const f=await reset({layout:'photos',ready:true});await image(f);
  const geometry=await f.evaluate(()=>{const box=s=>{const r=document.querySelector(s).getBoundingClientRect();return{x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height),bottom:Math.round(r.bottom)};};const quantity=box('[data-batch-row].is-current [data-batch-qty]'),dock=box('[data-batch-dock]');return{viewport:{width:innerWidth,height:innerHeight},photo:box('[data-batch-row].is-current [data-batch-photo]'),quantity,dock,dots:box('.m-batch-dots'),quantityClearOfDock:quantity.bottom<=dock.y};});
  assert(geometry.quantityClearOfDock);assert(geometry.dots.bottom<=geometry.quantity.y);await screenshot('photo-view');await page.locator('.frames').screenshot({path:path.join(output,'evidence/list-photo-comparison.png')});report.metrics.carousel={chosen:geometry,interpretation:'Current source controls and layout. Native swipe measurements are recorded separately. Staff speed and physical-device behavior remain unverified.'};
 });
 await check('Photo controls remain reachable at narrow, landscape, long-text and keyboard sizes',async()=>{
  const f=await reset({layout:'photos',size:'320x640',long:true,finished:true,reserved:true,ready:true,dark:true});await image(f);await f.locator('[data-batch-next]').click();await f.locator('[data-batch-next]').click();await expect(f.locator('[data-batch-build]')).toHaveCount(1);await expect(visible(f)).toHaveAttribute('data-batch-row','3');await f.locator('[data-batch-qty="3"]').scrollIntoViewIfNeeded();await screenshot('photo-dark-long');
  for(const[w,h]of[[320,640],[375,667],[780,390]]){await page.locator('#after').evaluate((el,s)=>{el.style.width=s[0]+'px';el.style.height=s[1]+'px';},[w,h]);await f.evaluate(()=>dispatchEvent(new Event('resize')));await f.locator('[data-batch-qty="3"]').scrollIntoViewIfNeeded();const g=await f.locator('[data-batch-qty="3"]').evaluate(el=>({bottom:el.getBoundingClientRect().bottom,dock:document.querySelector('[data-batch-dock]').getBoundingClientRect().top,overflow:document.documentElement.scrollWidth>innerWidth}));assert(!g.overflow);assert(g.bottom<=g.dock);}
  await reset({layout:'photos'});
 });
 await check('Photo view retains real scanner, light/dark accessibility and reduced-motion keyboard behavior',async()=>{
  for(const dark of [false,true])for(const photo of ['normal','missing','failed']){const f=await reset({layout:'photos',dark,photo,ready:true});if(photo==='normal')await image(f);else await expect(visible(f).locator('[data-photo-item].is-current [data-batch-photo-content]')).toContainText(photo==='missing'?'No photo saved':'Photo unavailable');await accessible(f,'photos '+photo+(dark?' dark':' light'));
   const small=await f.locator('[data-batch-root]').evaluate(root=>[...root.querySelectorAll('button,input,select')].filter(e=>{const r=e.getBoundingClientRect();return r.width&&r.height&&(r.width<44||r.height<44);}).map(e=>e.outerHTML));assert.deepEqual(small,[]);
  }
  const f=await reset({layout:'photos',ready:true});await f.locator('.m-scan-btn').click();await f.locator('.m-scan-manual input').fill('DEMO-BOLT');await f.locator('.m-scan-manual button').click();await expect(f.locator('[data-batch-qty="1"]')).toHaveValue('4');await page.emulateMedia({reducedMotion:'reduce'});await visible(f).locator('[data-batch-photo]').focus();await visible(f).locator('[data-batch-photo]').press('ArrowRight');await expect(f.locator('[data-batch-position]')).toHaveText(/^Item 2\./);await page.emulateMedia({reducedMotion:'no-preference'});
 });
 await reset();
}
