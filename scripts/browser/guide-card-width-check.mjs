import assert from 'node:assert/strict';
import {expect} from 'playwright/test';

export async function verifyGuideReveal({page,frame,ready,scenario,out}){
  await scenario('warehouse');const f=frame();
  await expect(f.locator('[data-work-tools]')).not.toHaveAttribute('open','');
  await f.locator('#m-guide-start').click();
  const picker=f.locator('.guide-coach [data-act=jump]');
  const value=await picker.evaluate(select=>[...select.options].find(o=>o.textContent.includes('Release orders'))?.value);
  assert(value,'Authorized Release orders step exists');await picker.selectOption(value);
  await expect(f.locator('[data-work-tools]')).toHaveAttribute('open','');
  const target=f.locator('[data-work-guide-title="Release orders"]');await expect(target).toBeVisible();
  await expect(f.locator('.guide-focus-ring')).toBeVisible();
  const geometry=await target.evaluate(target=>{const r=target.getBoundingClientRect(),g=document.querySelector('.guide-focus-ring').getBoundingClientRect();return {target:{x:r.x,y:r.y,w:r.width,h:r.height},ring:{x:g.x,y:g.y,w:g.width,h:g.height},painted:target.checkVisibility?.()};});
  assert(geometry.painted!==false);assert(Math.abs(geometry.ring.x-(geometry.target.x-5))<1&&Math.abs(geometry.ring.y-(geometry.target.y-5))<1);
  const unobscured=await target.evaluate(target=>{const r=target.getBoundingClientRect();return [.15,.5,.85].every(x=>[.2,.5,.8].every(y=>target.contains(document.elementFromPoint(r.left+r.width*x,r.top+r.height*y))));});
  assert(unobscured,'Guide target must stay above the dock and outside the coach panel');
  await page.screenshot({path:out+'/guide-revealed-work.png'});
  await target.evaluate(target=>target.hidden=true);await expect(f.locator('.guide-focus-ring')).toBeHidden();
  await target.evaluate(target=>target.hidden=false);await expect(f.locator('.guide-focus-ring')).toBeVisible();
  await target.evaluate(target=>target.remove());await expect(f.locator('.guide-focus-ring')).toBeHidden();
  assert(f.url().endsWith('#/work'),'Guide does not navigate into or activate a business action');
  await f.locator('[data-act=close]').click();await scenario('sales');return geometry;
}

export async function verifyCustomerRails({page,frame,ready,scenario,out}){
  await scenario('sales');const samples=[];
  for(const theme of ['dark','light']){
    await page.locator('#theme').selectOption(theme);await ready();const f=frame();await f.evaluate(()=>MApp.go('customers'));
    await expect(f.locator('[data-customers] .rk-job').first()).toBeVisible();
    async function measure(screen){const boxes=await f.locator('.rk-job').evaluateAll(cards=>cards.map(card=>{const r=card.getBoundingClientRect(),rail=card.querySelector('.m-status-rail').getBoundingClientRect(),c=getComputedStyle(card);return {card:{x:r.x,y:r.y,w:r.width,h:r.height},rail:{x:rail.x,y:rail.y,w:rail.width,h:rail.height},border:parseFloat(c.borderTopWidth),columns:c.gridTemplateColumns};}));for(let i=1;i<boxes.length;i++){assert(boxes[i].card.y-(boxes[i-1].card.y+boxes[i-1].card.h)>=11.5,'Adjacent cards retain the shared 12px list gap');}for(const b of boxes){assert(Math.abs(b.rail.y-(b.card.y+b.border))<1,'Rail is flush with card top');assert(Math.abs(b.rail.y+b.rail.h-(b.card.y+b.card.h-b.border))<1,'Rail is flush with card bottom');assert(Math.abs(b.rail.x+b.rail.w-(b.card.x+b.card.w-b.border))<1,'Rail is flush with card right');assert(b.rail.w>=44,'Rail keeps its shared width');}samples.push({theme,screen,boxes});}
    await measure('customers');await page.locator('.phone').screenshot({path:out+'/customers-'+theme+'.png'});
    await f.locator('[data-customers] .rk-job').first().click();await expect(f.locator('.rk-job')).toBeVisible();await measure('recent-sales');await page.locator('.phone').screenshot({path:out+'/customer-recent-sales-'+theme+'.png'});
  }
  await page.locator('#home').click();await ready();return samples;
}

export async function verifyTabWidths({page,frame,ready,scenario,out}){
  await scenario('manager');const samples=[],viewport=page.viewportSize();
  await page.setViewportSize({width:1800,height:1000});const originalLayout=await page.locator('.layout').getAttribute('style'),originalPhone=await page.locator('.phone').getAttribute('style');
  try{for(const width of [320,390,768,1280]){
    await page.locator('.layout').evaluate((el,width)=>{el.style.maxWidth='none';el.style.gridTemplateColumns=`minmax(0,1fr) ${width+2}px`;},width);
    await page.locator('.phone').evaluate((el,width)=>el.style.width=(width+2)+'px',width);
    const f=frame();let reference;
    for(const [tab,route,selector] of [['home','home','.v2-home'],['work','work','.v2-work'],['clock','clock','.v2-clock'],['inbox','inbox','.m-inbox-v2'],['profile','settings','.profile-page']]){
      await f.locator('#m-tabbar [data-tab='+tab+']').click();await expect(f.locator('#m-view')).toHaveAttribute('data-route',route);await expect(f.locator(selector)).toBeVisible();
      const box=await f.locator(selector).evaluate(el=>{const r=el.getBoundingClientRect(),c=getComputedStyle(el);return {x:r.x+parseFloat(c.paddingLeft),width:r.width-parseFloat(c.paddingLeft)-parseFloat(c.paddingRight),outer:r.width,overflow:document.documentElement.scrollWidth>innerWidth};});
      if(!reference)reference=box;assert(Math.abs(box.x-reference.x)<1&&Math.abs(box.width-reference.width)<1,`${width}px ${tab} content differs from Home: ${JSON.stringify({box,reference})}`);assert(!box.overflow);samples.push({viewport:width,tab,...box});
    }
  }}finally{await page.locator('.layout').evaluate((el,style)=>style===null?el.removeAttribute('style'):el.setAttribute('style',style),originalLayout);await page.locator('.phone').evaluate((el,style)=>style===null?el.removeAttribute('style'):el.setAttribute('style',style),originalPhone);await page.setViewportSize(viewport);}
  await scenario('sales');return samples;
}
