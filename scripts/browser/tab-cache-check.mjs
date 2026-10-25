import assert from 'node:assert/strict';
import {expect} from 'playwright/test';

export async function verifyTabCache({page,frame,ready,scenario,out}){
  await scenario('warehouse');
  const prior=frame().url(),coldStart=Date.now();await page.locator('#network').selectOption('slow');
  await expect.poll(()=>frame()?.url()).not.toBe(prior);await ready();
  const coldWork=Date.now()-coldStart,f=frame(),samples=[];
  await expect(f.locator('[data-work-desk=qc] [data-work-record]')).toHaveCount(2);
  async function go(tab,selector){
    const start=Date.now();await f.locator('#m-tabbar [data-tab='+tab+']').click();
    await expect(f.locator(selector).first()).toBeVisible({timeout:600});
    return Date.now()-start;
  }
  const homeQueue=await go('home','[data-home-work=qc] [data-attention]');
  await expect(f.locator('.v2-attendance-hero')).not.toContainText('Checking attendance',{timeout:5000});
  const work=await go('work','[data-work-desk=qc] [data-work-record]');
  await expect(f.locator('[data-work-freshness]')).toHaveText('Checking current work…');
  await ready();
  const home=await go('home','[data-home-work=qc] [data-attention]');
  await expect(f.locator('.v2-attendance-hero')).not.toContainText('Checking attendance',{timeout:600});
  samples.push({simulatedNetworkDelayMs:2500,coldWorkMs:coldWork,homeQueuesMs:homeQueue,workRecordsMs:work,homeAttendanceAndQueuesMs:home});
  assert(work<1000&&home<1000,'Warm overviews must display before a 2.5-second fresh response');
  await page.locator('.phone').screenshot({path:out+'/warm-home-checking.png'});
  // The next server response represents completion elsewhere. The cached record
  // may preview it, but the fresh response must remove it without another tap.
  await f.evaluate(()=>{window.__scratch.responses['/api/qc/queue?role=qc'].body.units=[];});
  await go('work','[data-work-desk=qc] [data-work-record]');
  await f.locator('[data-work-desk=qc] [data-work-record]').first().click();
  await expect(f.locator('#m-view')).toContainText('no longer needs attention',{timeout:5000});
  await expect(f.locator('#work-open-action')).toHaveCount(0);
  await f.locator('#m-back').click();
  await ready();await expect(f.locator('[data-work-desk=qc]')).toHaveCount(0);
  // A denied read must drop stale rows, not leave an apparently actionable card.
  await f.evaluate(()=>{window.__scratch.responses['/api/qc/queue?role=qa']={status:403,body:{error:'Access revoked in simulated server state'}};});
  await f.locator('#m-tabbar [data-tab=home]').click();
  await f.locator('#m-tabbar [data-tab=work]').click();await ready();
  await expect(f.locator('[data-work-desk=qa] [data-work-record]')).toHaveCount(0);
  await expect(f.locator('[data-work-desk=qa]')).toContainText('Check needed');
  await page.locator('#network').selectOption('ready');await ready();await scenario('sales');return samples;
}
