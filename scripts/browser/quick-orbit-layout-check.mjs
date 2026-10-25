import assert from 'node:assert/strict';
import path from 'node:path';
import {expect} from 'playwright/test';

// Measure the background, not the intentionally moving fan. Sampling every rendered
// frame catches shifts during the exit that before/after-only assertions miss.
export async function verifyQuickOrbitLayout({page,frame,ready,scenario,out,mode}){
  const originalViewport=page.viewportSize();
  // Other scratch checks finish with a narrow outer review page. Keep this
  // harness wide; only the actual app iframe adopts the size under test.
  await page.setViewportSize({width:1160,height:1000});
  await scenario('warehouse');
  const samples=[];
  const original=await page.locator('.phone').getAttribute('style');
  const originalLayout=await page.locator('.layout').getAttribute('style');
  try{
    for(const size of [{width:390,height:844},{width:320,height:640},{width:780,height:390}]){
      // Resize the review frame's grid track with its viewport; otherwise the
      // landscape phone would protrude outside the outer browser's viewport.
      await page.locator('.layout').evaluate((layout,width)=>layout.style.gridTemplateColumns=`minmax(0,1fr) ${width+2}px`,size.width);
      await page.locator('.phone').evaluate((phone,size)=>{phone.style.width=(size.width+2)+'px';phone.style.height=(size.height+2)+'px';},size);
      for(const theme of ['dark','light']){
        await page.locator('#theme').selectOption(theme);await ready();
        for(const reduced of [false,true]){
          await page.emulateMedia({reducedMotion:reduced?'reduce':'no-preference'});
          const f=frame();await f.evaluate(()=>scrollTo(0,330));
          // Settle scroll/sticky positions before taking the reference geometry.
          await f.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
          const before=await f.evaluate(()=>{
            const selectors=['#m-app','#m-view','.m-topbar','.m-tabbar','[data-work-desk=qc]','[data-work-desk=qc] [data-work-record]'];
            const measure=()=>({scrollY,boxes:Object.fromEntries(selectors.map(selector=>{const r=document.querySelector(selector).getBoundingClientRect();return [selector,{x:r.x,y:r.y,width:r.width,height:r.height}];}))});
            window.__orbitLayout={measure,frames:[],running:true};
            const tick=()=>{const state=window.__orbitLayout;state.frames.push(state.measure());if(state.running)requestAnimationFrame(tick);};tick();
            return {...measure(),scrollbar:innerWidth-document.documentElement.clientWidth};
          });
          const handle=f.locator('.v2-orbit-handle');
          const evidence=mode==='classic'&&size.width===390&&theme==='dark'&&!reduced;
          if(evidence)await page.locator('.phone').screenshot({path:path.join(out,'quick-actions-width-before.png')});
          for(const dismissal of ['handle','escape','backdrop','settings']){
            await handle.click();await expect(f.locator('.v2-orbit-overlay')).toBeVisible();
            await expect(handle).toHaveAttribute('aria-expanded','true');
            assert.equal(await f.locator('#m-app').evaluate(app=>app.inert),true);
            // Wait for real animations rather than depending on machine speed.
            await f.evaluate(async()=>{await new Promise(r=>requestAnimationFrame(r));await Promise.allSettled(document.querySelector('.v2-orbit-overlay').getAnimations({subtree:true}).map(a=>a.finished));});
            if(evidence&&dismissal==='handle')await page.locator('.phone').screenshot({path:path.join(out,'quick-actions-width-open.png')});
            if(dismissal==='settings'){
              await f.locator('.v2-orbit-edit').click();await expect(f.locator('.v2-orbit-settings')).toBeVisible();
              await f.locator('[data-cancel]').click();
            }else if(dismissal==='escape')await page.keyboard.press('Escape');
            else if(dismissal==='backdrop')await f.locator('.v2-orbit-backdrop').dispatchEvent('click');
            else await handle.evaluate(button=>button.click());
            await expect(f.locator('.v2-orbit-overlay')).toHaveCount(0);
            assert.equal(await f.locator('#m-app').evaluate(app=>app.inert),false);
          }
          await f.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));
          const measured=await f.evaluate(()=>{const state=window.__orbitLayout;state.running=false;return {frames:state.frames,after:state.measure(),overflow:document.body.style.overflow,focus:document.activeElement===document.querySelector('.v2-orbit-handle'),sideways:document.documentElement.scrollWidth>innerWidth};});
          if(evidence)await page.locator('.phone').screenshot({path:path.join(out,'quick-actions-width-after.png')});
          let maxDrift=0;
          for(const state of [...measured.frames,measured.after]){
            maxDrift=Math.max(maxDrift,Math.abs(state.scrollY-before.scrollY));
            for(const [selector,box] of Object.entries(state.boxes))for(const key of ['x','y','width','height'])maxDrift=Math.max(maxDrift,Math.abs(box[key]-before.boxes[selector][key]));
          }
          samples.push({mode,size,theme,reducedMotion:reduced,scrollbar:before.scrollbar,frames:measured.frames.length,maxDrift,before,after:measured.after});
          assert(maxDrift<=.25,`${mode} ${size.width} ${theme} reduced=${reduced}: background moved ${maxDrift}px while Quick Actions opened/closed`);
          assert.equal(measured.overflow,'');assert.equal(measured.sideways,false);assert(measured.focus,'Quick Actions returns keyboard focus to its handle');
        }
      }
    }
  }finally{
    await page.emulateMedia({reducedMotion:'no-preference'});
    await page.locator('.phone').evaluate((phone,style)=>{if(style===null)phone.removeAttribute('style');else phone.setAttribute('style',style);},original);
    await page.locator('.layout').evaluate((layout,style)=>{if(style===null)layout.removeAttribute('style');else layout.setAttribute('style',style);},originalLayout);
    if(originalViewport)await page.setViewportSize(originalViewport);
  }
  if(mode==='classic')assert(samples.some(s=>s.scrollbar>0),'The regression must exercise a real space-consuming scrollbar');
  if(mode==='overlay')assert(samples.every(s=>s.scrollbar===0),'The mobile sample must exercise overlay scrollbars');
  return samples;
}
