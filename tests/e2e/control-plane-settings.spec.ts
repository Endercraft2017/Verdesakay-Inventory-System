import { test, expect } from '@playwright/test';

test('owner settings retain edited fields after a real database failure and accept a corrected save', async ({ page }) => {
  await page.goto('/_platform/');
  await page.locator('#lu').fill('browser-operator');
  await page.locator('#lp').fill('Synthetic browser operator password');
  await page.locator('#login-form button').click();
  await expect(page.locator('#app')).toBeVisible();
  await page.locator('.tenant-choice').filter({ hasText: 'Browser support fixture' }).click();
  await page.locator('[data-tab=settings]').click();
  await page.locator('#d-name').fill('Browser settings failure');
  const failed = page.waitForResponse(response => response.url().endsWith('/_platform/api/tenants/browser-support') && response.request().method() === 'PATCH');
  await page.locator('#d-save').click();
  const response = await failed;
  expect(response.status()).toBe(500);
  expect(await response.json()).toEqual({ error: 'Internal server error', request_id: response.headers()['x-request-id'] });
  await expect(page.locator('#d-save')).toBeEnabled();
  await expect(page.locator('#d-name')).toHaveValue('Browser settings failure');
  await expect(page.locator('body')).not.toContainText('synthetic-private-settings-detail');
  await page.locator('#d-name').fill('Browser settings corrected');
  const saved = page.waitForResponse(response => response.url().endsWith('/_platform/api/tenants/browser-support') && response.request().method() === 'PATCH');
  await page.locator('#d-save').click();
  expect((await saved).status()).toBe(200);
  await expect(page.locator('.tenant-choice').filter({ hasText: 'Browser settings corrected' })).toBeVisible();
});
