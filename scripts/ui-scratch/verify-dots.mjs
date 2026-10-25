import assert from 'node:assert/strict';
import {expect} from 'playwright/test';
export async function verifyDots({page,reset,data,quantity,screenshot,accessible,check,report}){
 const current=f=>f.locator('[data-batch-row].is-current');
 await check('Clickable numbered dots, centered long pagination and gradient boundaries match the selected item',async()=>{
  const f=await reset({layout:'photos',count:'12',ready:true});await expect(f.locator('[data-batch-dot]')).toHaveCount(12);await expect(f.locator('[data-dot-indicator]')).toHaveText('1');await expect(f.locator('[data-batch-prev]')).toBeHidden();await expect(f.locator('[data-batch-next]')).toBeVisible();
  assert.equal(await f.locator('[data-batch-next]').evaluate(e=>getComputedStyle(e).borderTopWidth),'0px');assert.match(await f.locator('[data-batch-next]').evaluate(e=>getComputedStyle(e).backgroundImage),/linear-gradient/);
  await f.locator('[data-batch-dot="6"]').scrollIntoViewIfNeeded();await f.locator('[data-batch-dot="6"]').click();await expect(current(f)).toHaveAttribute('data-batch-row','6');await expect(f.locator('[data-dot-indicator]')).toHaveText('6');
  await f.locator('[data-batch-dot="6"]').press('End');await expect(current(f)).toHaveAttribute('data-batch-row','12');await expect(f.locator('[data-batch-next]')).toBeHidden();await expect(f.locator('[data-batch-prev]')).toBeVisible();
  const r=await f.locator('[data-batch-dot="12"]').evaluate(e=>{const r=e.getBoundingClientRect(),p=e.parentElement.getBoundingClientRect();return{left:r.left,right:r.right,start:p.left,end:p.right};});assert(r.left>=r.start&&r.right<=r.end);await screenshot('centered-dots');
  await f.locator('[data-batch-dot="12"]').press('Home');await expect(current(f)).toHaveAttribute('data-batch-row','1');assert.equal((await data(f)).applied,0);
 });
 await check('Native mobile swipe tracks the finger, snaps to a real row and preserves quantities',async()=>{
  const f=await reset({layout:'photos',ready:true});const stage=current(f).locator('[data-batch-photo]');await stage.scrollIntoViewIfNeeded();const r=await stage.boundingBox(),cdp=await page.context().newCDPSession(page);await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
  const start=r.x+r.width*.75,end=r.x+r.width*.2,y=r.y+r.height*.6;
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:start,y}]});
  for(let n=1;n<=8;n++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:start+(end-start)*n/8,y}]});await page.waitForTimeout(20);}
  const during=await f.locator('.m-batch-image-rail').evaluate(e=>({left:e.scrollLeft,width:e.clientWidth}));assert(during.left>0&&during.left<during.width+12,'Expected a partially scrolled, finger-tracked native rail');
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await expect(current(f)).toHaveAttribute('data-batch-row','2');await expect.poll(()=>f.locator('.m-batch-image-rail').evaluate(e=>Math.round(e.scrollLeft))).toBe(await f.locator('.m-batch-image-rail').evaluate(e=>e.clientWidth));
  await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:false});await cdp.detach();assert.equal(await f.locator('[data-batch-qty="1"]').inputValue(),'3');assert.equal((await data(f)).applied,0);assert(await f.locator('[data-batch-photo] img').count()<=3);report.metrics.nativeSwipe={partialScroll:during.left,snappedTo:'item 2',method:'Chromium CDP touch input; no physical-device claim'};
 });
 await check('The photo stock ratio uses request-available stock, preserves reservations and warns on negative estimates',async()=>{
  let f=await reset({layout:'photos',ready:true,reserved:true});await expect(current(f).locator('[data-photo-after]')).toHaveText('1');await expect(current(f).locator('[data-photo-available]')).toHaveText('4 pcs');await expect(current(f).locator('[data-photo-onhand]')).toContainText('12 pcs on hand');await expect(current(f).locator('.m-batch-balance')).toBeHidden();
  f=await reset({layout:'photos'});await f.locator('[data-batch-dot="3"]').click();await expect(current(f).locator('[data-photo-after]')).toHaveText('-3');await expect(current(f).locator('[data-batch-photo-stock]')).toHaveClass(/negative/);await expect(f.locator('[data-batch-record]')).toBeDisabled();await screenshot('split-stock-badge');
 });
 await check('Quantity focus moves above the simulated keyboard without changing the selected row',async()=>{
  const f=await reset({layout:'photos',long:true,finished:true});await f.locator('[data-batch-dot="3"]').click();await quantity(f,3,1);await page.locator('#keyboard').check();await f.locator('[data-batch-qty="3"]').focus();await f.evaluate(()=>dispatchEvent(new Event('resize')));await page.waitForTimeout(250);
  const r=await f.locator('[data-batch-qty="3"]').evaluate(e=>({top:e.getBoundingClientRect().top,bottom:e.getBoundingClientRect().bottom,dock:document.querySelector('[data-batch-dock]').getBoundingClientRect().top,header:document.querySelector('.m-topbar').getBoundingClientRect().bottom}));assert(r.top>=r.header&&r.bottom<=r.dock);await expect(current(f)).toHaveAttribute('data-batch-row','3');await expect(f.locator('[data-batch-qty="3"]')).toHaveValue('1');await screenshot('keyboard-focus');
 });
 await check('JO and CKD products keep separate allocations, real denominators and a shared-part stock budget',async()=>{
  for(const request of ['jo','ckd']){
   const f=await reset({request,layout:'photos',reserved:true});await expect(f.locator('.m-preparation-target').first()).toHaveText('/ 5');await expect(f.locator('[data-batch-qty="1"]')).toHaveValue('1');await quantity(f,1,3);await expect(current(f)).toContainText('Shared demand 8 pcs');
   await f.locator('.m-preparation-group select').selectOption('1');await expect(f.locator('.m-preparation-target').first()).toHaveText('/ 3');await expect(f.locator('[data-batch-qty="1"]')).toHaveValue('0');await quantity(f,1,2);await expect(f.locator('[data-batch-qty="1"]')).toHaveAttribute('aria-invalid','true');
   await quantity(f,1,1);await expect(f.locator('[data-batch-qty="1"]')).toHaveAttribute('aria-invalid','false');await f.locator('.m-preparation-group select').selectOption('0');await expect(f.locator('[data-batch-qty="1"]')).toHaveValue('3');await expect(f.locator('.m-preparation-target').first()).toHaveText('/ 5');await expect(f.locator('[data-batch-dock] button')).toHaveCount(0);assert.equal((await data(f)).journal.filter(r=>r.method==='POST').length,0);await screenshot(request+'-grouped-preparation');
  }
 });
 await check('An assembled SO selects finished units rather than exploding its BOM, with accessible preparation examples',async()=>{
  let f=await reset({request:'so',layout:'photos'});await expect(f.locator('[data-batch-row]')).toHaveCount(1);await expect(f.locator('[data-batch-row]')).toHaveAttribute('data-batch-row','3');await expect(f.locator('.m-preparation-target')).toHaveText('/ 5');await expect(f.locator('[data-batch-qty="3"]')).toHaveValue('0');await quantity(f,3,2);await expect(f.locator('[data-batch-qty="3"]')).toHaveAttribute('aria-invalid','false');await screenshot('so-finished-preparation');
  for(const request of ['so','ckd','jo'])for(const dark of [false,true]){f=await reset({request,layout:'photos',dark});await accessible(f,request+' preparation'+(dark?' dark':' light'));}
  assert.equal((await data(f)).applied,0);
 });
 await check('Missing request requirements cannot be silently converted into zero targets',async()=>{const f=await reset({layout:'photos'});const invalid=await f.evaluate(()=>[null,undefined,'',false,{},-1].every(value=>{try{mPreparationReview.joGroup({id:1},{source_location_id:1,lines:[{component_item_id:1,need:value,picked:0,available:2,have:2}]});return false;}catch(_){return true;}}));assert(invalid);});
 await check('Reduced motion and keyboard dot navigation use immediate scroll positions',async()=>{
  const f=await reset({layout:'photos',ready:true});await page.emulateMedia({reducedMotion:'reduce'});await f.locator('[data-batch-dot="1"]').focus();await f.locator('[data-batch-dot="1"]').press('ArrowRight');await expect(current(f)).toHaveAttribute('data-batch-row','2');assert.equal(await f.locator('.m-batch-image-rail').evaluate(e=>Math.round(e.scrollLeft)),await f.locator('.m-batch-image-rail').evaluate(e=>e.clientWidth));await expect(f.locator('[data-batch-dot="2"]')).toBeFocused();await page.emulateMedia({reducedMotion:'no-preference'});
 });
 await reset();
}
