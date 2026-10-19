import {test,expect} from '@playwright/test';
async function open(page:any){
  await page.goto('/_platform/'); await page.locator('#lu').fill('browser-operator'); await page.locator('#lp').fill('Synthetic browser operator password');
  await page.locator('#login-form button').click(); await expect(page.locator('#app')).toBeVisible(); await page.locator('#mail-btn').click();
  await expect(page.locator('#m-history')).toContainText('browser-old-failure'); await expect(page.locator('#m-refresh')).toBeEnabled();
}
test('old delivery failures remain discoverable across pages and failed reads preserve the selected view',async({page})=>{
  await open(page);
  await expect(page.locator('#m-outbox')).not.toContainText('browser-old-failure');
  await expect(page.locator('#m-health')).toContainText('Not yet observed');
  await expect(page.locator('#m-history')).not.toContainText('Synthetic private');
  await page.locator('#m-history-filter').selectOption('all'); await expect(page.locator('#m-older')).toBeEnabled();
  await expect(page.locator('#m-history')).not.toContainText('browser-old-failure');
  await page.locator('#m-older').click(); await expect(page.locator('#m-history')).toContainText('browser-history-40');
  await expect(page.locator('#m-older')).toBeEnabled(); await page.locator('#m-older').click();
  await expect(page.locator('#m-history')).toContainText('browser-old-failure'); await expect(page.locator('#m-older')).toBeDisabled();
  const before=await page.locator('#m-history').innerText(); const health=await page.locator('#m-health').innerText();
  await page.route('**/_platform/api/mail/delivery?**',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Synthetic read unavailable'})}),{times:1});
  await page.locator('#m-history-filter').selectOption('queued'); await expect(page.locator('#m-err')).toHaveText('Synthetic read unavailable');
  await expect(page.locator('#m-history-filter')).toHaveValue('all'); expect(await page.locator('#m-history').innerText()).toBe(before); expect(await page.locator('#m-health').innerText()).toBe(health);
  await page.locator('#m-refresh').click(); await expect(page.locator('#m-err')).toBeEmpty(); await expect(page.locator('#m-older')).toBeEnabled();
});
test('stalled delivery reads time out, retain evidence and recover without a write',async({page})=>{
  await open(page); await page.clock.install();
  const before=await page.locator('#m-history').innerText(); let release!:()=>void; let seen!:()=>void;
  const requested=new Promise<void>(r=>seen=r), held=new Promise<void>(r=>release=r);
  await page.route('**/_platform/api/mail/delivery?**',async route=>{seen(); await held; try{await route.abort();}catch{}},{times:1});
  await page.locator('#m-refresh').click(); await requested; await page.clock.fastForward(20001);
  await expect(page.locator('#m-err')).toHaveText('Delivery status refresh timed out. Try again.');
  expect(await page.locator('#m-history').innerText()).toBe(before); await expect(page.locator('#m-refresh')).toBeEnabled(); release();
  await page.locator('#m-refresh').click(); await expect(page.locator('#m-err')).toBeEmpty();
});
