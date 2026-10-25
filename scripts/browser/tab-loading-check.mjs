import assert from 'node:assert/strict';
import {expect} from 'playwright/test';

// Observe rendered frames; a settled screenshot cannot catch the loading flash.
export async function verifyTabLoading({page,frame,ready,scenario}){
  const results=[];
  for(const sample of [
    {scenario:'empty',network:'ready',theme:'dark'},
    {scenario:'empty',network:'slow',theme:'light'},
    {scenario:'warehouse',network:'ready',theme:'light'},
    {scenario:'warehouse',network:'failed',theme:'dark'}
  ]){
    await scenario(sample.scenario);await page.locator('#theme').selectOption(sample.theme);await ready();
    await page.locator('#network').selectOption(sample.network);await ready();
    const f=frame();await f.evaluate(()=>{
      window.__tabFrames=[];window.__tabSampling=true;
      const tick=()=>{if(!window.__tabSampling)return;const view=document.querySelector('#m-view');
        window.__tabFrames.push({route:location.hash,height:view.getBoundingClientRect().height,
          loadingDesks:[...view.querySelectorAll('[data-work-desk]')].filter(d=>d.querySelector('.m-hint')?.textContent==='Loading this queue…').map(d=>d.dataset.workDesk),
          openTools:!!view.querySelector('[data-work-tools][open]'),
          menus:document.querySelectorAll('.m-select-menu:not([hidden])').length,
          falseEmpty:!!view.querySelector('[data-work-empty]:not([hidden])')&&!!view.querySelector('[data-work-freshness]:not([hidden])')});requestAnimationFrame(tick);};requestAnimationFrame(tick);
    });
    for(let i=0;i<2;i++)for(const tab of ['home','work']){
      await f.locator('#m-tabbar [data-tab='+tab+']').click();
      await expect(f.locator('#m-view')).toHaveAttribute('data-route',tab);
      // Leave delayed reads while in flight, then return: late results must not
      // expand the outgoing screen or create an empty-state claim.
      await page.waitForTimeout(sample.network==='slow'?180:90);
    }
    await ready();
    const frames=await f.evaluate(()=>{window.__tabSampling=false;return window.__tabFrames;});
    assert(frames.some(s=>s.route==='#/home')&&frames.some(s=>s.route==='#/work'));
    const bad=frames.filter(s=>s.loadingDesks.length||s.openTools||s.menus||s.falseEmpty);
    results.push({...sample,frames:frames.length,unexpectedFrames:bad.length});
    assert.deepEqual(bad,[],`${sample.scenario}/${sample.network}: navigation painted loading-only queue sections, an open popup, or a false empty state`);
  }
  await page.locator('#network').selectOption('ready');await ready();await scenario('sales');
  return results;
}
