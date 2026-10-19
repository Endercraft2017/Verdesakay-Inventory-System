import { test, expect } from '@playwright/test';

test('console retries a committed request whose response was lost without creating a second generated slug', async ({ page }) => {
  await page.goto('/_platform/');
  await page.locator('#lu').fill('browser-operator'); await page.locator('#lp').fill('Synthetic browser operator password');
  await page.locator('#login-form button').click(); await expect(page.locator('#app')).toBeVisible();
  await page.locator('#new-btn').click();
  await page.locator('#n-name').fill('Browser Receipt Workspace'); await page.locator('#n-user').fill('owner');
  await page.locator('#n-pass').fill('Synthetic browser receipt password'); await page.locator('#n-sandbox').check();
  let firstKey: string | undefined, slug: string | undefined, lost = false;
  await page.route('**/_platform/api/tenants', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const key = route.request().headers()['idempotency-key'];
    if (!lost) {
      firstKey = key;
      const committed = await route.fetch(); expect(committed.status()).toBe(201);
      slug = (await committed.json()).slug; lost = true;
      await route.abort('failed');
    } else {
      expect(key).toBe(firstKey); await route.continue();
    }
  });
  await page.locator('#n-go').click(); await expect(page.locator('#n-err')).not.toBeEmpty();
  await expect(page.locator('#n-go')).toBeEnabled(); await expect(page.locator('#n-name')).toHaveValue('Browser Receipt Workspace');
  expect(firstKey).toMatch(/^[a-f0-9-]{36}$/);
  const responsePromise = page.waitForResponse(response => response.url().endsWith('/_platform/api/tenants') && response.request().method() === 'POST');
  await page.locator('#n-go').click(); const replay = await responsePromise;
  expect(replay.status()).toBe(201); expect(replay.headers()['idempotency-replayed']).toBe('true');
  expect((await replay.json()).slug).toBe(slug); await expect(page.locator('#modal')).toHaveCount(0);
  const tenants = await page.request.get('/_platform/api/tenants'); expect(tenants.status()).toBe(200);
  const data = await tenants.json();
  expect(data.filter((tenant: { name: string }) => tenant.name === 'Browser Receipt Workspace')).toHaveLength(1);
});

test('website retries a committed signup after a lost response using the same creation key', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: 'http://localhost:4173' }); const page = await context.newPage();
  try {
    await page.goto('/'); await page.getByRole('button', { name: 'New customer', exact: true }).click();
    const form = page.locator('#signup-form');
    await form.getByLabel('Company or business name').fill('Browser Receipt Signup'); await form.getByLabel('Admin username').fill('owner');
    await form.getByLabel('Email', { exact: true }).fill('receipt-browser@example.test'); await form.getByLabel('Admin password').fill('Synthetic browser receipt password');
    let key: string | undefined, lost = false;
    await page.route('**/api/signup', async route => {
      if (!lost) {
        key = route.request().headers()['idempotency-key']; const result = await route.fetch(); expect(result.status()).toBe(201);
        lost = true; await route.abort('failed');
      } else { expect(route.request().headers()['idempotency-key']).toBe(key); await route.continue(); }
    });
    await form.locator('#signup-submit').click(); await expect(form.getByRole('alert')).not.toBeEmpty();
    await expect(form.locator('#signup-submit')).toBeEnabled();
    const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/signup') && response.request().method() === 'POST');
    await form.locator('#signup-submit').click(); const replay = await responsePromise;
    expect(replay.status()).toBe(201); expect(replay.headers()['idempotency-replayed']).toBe('true');
    await expect(page).toHaveURL(/\/browser-receipt-signup$/);
    const login = await context.request.post('/browser-receipt-signup/api/auth/login', { data: { username: 'owner', password: 'Synthetic browser receipt password' } });
    expect(login.status()).toBe(200);
    const billing = await context.request.get('/browser-receipt-signup/api/tenant/billing', { headers: { Authorization: 'Bearer ' + (await login.json()).token } });
    expect(billing.status()).toBe(200); expect((await billing.json()).invoices).toHaveLength(1);
  } finally { await context.close(); }
});
