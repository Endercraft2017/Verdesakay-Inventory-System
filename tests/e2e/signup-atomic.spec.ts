import { test, expect } from '@playwright/test';

test('website signup retains input after invoice failure and retries the same workspace successfully', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: 'http://localhost:4173' });
  const page = await context.newPage();
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'New customer', exact: true }).click();
    const form = page.locator('#signup-form');
    await form.getByLabel('Company or business name').fill('Browser Atomic Failed');
    await form.getByLabel('Admin username').fill('owner');
    await form.getByLabel('Email', { exact: true }).fill('browser-atomic@example.test');
    await form.getByLabel('Admin password').fill('Synthetic browser signup password');
    const failed = page.waitForResponse(response => response.url().endsWith('/api/signup') && response.request().method() === 'POST');
    await form.locator('#signup-submit').click();
    const response = await failed;
    expect(response.status()).toBe(500);
    const body = await response.json(); expect(body.error).toBe('Internal server error');
    expect(body.request_id).toBe(response.headers()['x-request-id']);
    await expect(form.getByRole('alert')).toHaveText('Internal server error');
    await expect(form.getByLabel('Company or business name')).toHaveValue('Browser Atomic Failed');
    await expect(form.locator('#signup-submit')).toBeEnabled();
    const succeeded = page.waitForResponse(response => response.url().endsWith('/api/signup') && response.request().method() === 'POST');
    await form.locator('#signup-submit').click();
    const complete = await succeeded; expect(complete.status()).toBe(201);
    await expect(page).toHaveURL(/\/browser-atomic-failed$/);
    await expect(page.locator('#login-username')).toBeVisible();
    const login = await context.request.post('/browser-atomic-failed/api/auth/login', { data: { username: 'owner', password: 'Synthetic browser signup password' } });
    expect(login.status()).toBe(200);
    const token = (await login.json()).token;
    const billing = await context.request.get('/browser-atomic-failed/api/tenant/billing', { headers: { Authorization: 'Bearer ' + token } });
    expect(billing.status()).toBe(200);
    const state = await billing.json(); expect(state.awaiting_payment).toBe(true); expect(state.invoices).toHaveLength(1);
    expect(state.invoices[0].reference).toBeTruthy();
  } finally { await context.close(); }
});
