import { test, expect } from '@playwright/test';

test('owner sees uncertain signup delivery, retains it on refresh failure and sends no retry', async ({ page }) => {
  await page.goto('/_platform/'); await page.locator('#lu').fill('browser-operator'); await page.locator('#lp').fill('Synthetic browser operator password');
  await page.locator('#login-form button').click(); await expect(page.locator('#app')).toBeVisible();
  await page.locator('#mail-btn').click();
  await expect(page.locator('#m-outbox')).toContainText('Delivery uncertain');
  await expect(page.locator('#m-outbox')).toContainText('browser-support');
  await expect(page.locator('#m-outbox')).not.toContainText('Synthetic private message');
  await expect(page.locator('#modal').getByRole('button', {name:/resend|retry/i})).toHaveCount(0);
  let failed=false, writes=0;
  await page.route('**/_platform/api/mail', async route => {
    if(route.request().method()!=='GET') { writes++; return route.continue(); }
    if(!failed) { failed=true; return route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'Internal server error',request_id:'synthetic'})}); }
    await route.continue();
  });
  await page.locator('#m-refresh').click(); await expect(page.locator('#m-err')).toHaveText('Internal server error');
  await expect(page.locator('#m-outbox')).toContainText('Delivery uncertain'); await expect(page.locator('#m-refresh')).toBeEnabled();
  await page.locator('#m-refresh').click(); await expect(page.locator('#m-err')).toBeEmpty();
  await expect(page.locator('#m-outbox')).toContainText('interrupted_send'); expect(writes).toBe(0);
});
