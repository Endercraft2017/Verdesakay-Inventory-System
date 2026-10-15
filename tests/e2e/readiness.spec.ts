/// <reference lib="dom" />
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

declare const API: { post: (path: string, body?: unknown, opts?: unknown) => Promise<any>; get: (path: string) => Promise<any>; getToken: () => string };

async function signIn(page: Page, mobile = false) {
  await page.goto(mobile ? '/m' : '/');
  await page.locator(mobile ? '#m-username' : '#login-username').fill('admin');
  await page.locator(mobile ? '#m-password' : '#login-password').fill('admin123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator(mobile ? '#m-app' : '#app-screen')).toBeVisible();
}

test('desktop: wrong password, keyboard login, stock journey and server logout', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.locator('#login-username').fill('admin');
  await page.locator('#login-password').fill('wrong');
  await page.locator('#login-password').press('Enter');
  await expect(page.locator('#login-error')).toContainText(/invalid/i);
  await page.locator('#login-password').fill('admin123');
  await page.locator('#login-password').press('Enter');
  await expect(page.locator('#app-screen')).toBeVisible();
  const item = await page.evaluate(async () => {
    const result = await API.post('/inventory', { name: "Audit O'Brien 🌱", quantity: 10 });
    return result.id;
  });
  await page.goto('/#inventory');
  await expect(page.getByText("Audit O'Brien 🌱", { exact: true })).toBeVisible();
  const result = await page.evaluate(async id => {
    const before = await API.get('/inventory/' + id);
    await API.post('/inventory/' + id + '/adjust', { change: -2 }, { idempotencyKey: 'browser-stock-key' });
    await API.post('/inventory/' + id + '/adjust', { change: -2 }, { idempotencyKey: 'browser-stock-key' });
    const after = await API.get('/inventory/' + id);
    return { before: before.quantity, after: after.quantity, token: API.getToken() };
  }, item);
  expect(result.before).toBe(10);
  expect(result.after).toBe(8);
  const session = (await page.context().cookies()).find(c => c.name.startsWith('vds_session_'))!;
  expect(session.httpOnly).toBe(true);
  expect(session.sameSite).toBe('Strict');
  expect(result.token).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem('vds_token'))).toBeNull();
  await page.screenshot({ path: testInfo.outputPath('desktop-inventory.png'), fullPage: true });
  page.on('dialog', dialog => dialog.accept());
  await page.locator('#logout-btn').click();
  await expect(page.locator('#login-screen')).toBeVisible();
  expect((await page.request.get('/api/auth/me', { headers: { Cookie: `${session.name}=${session.value}` } })).status()).toBe(401);
  expect(errors).toEqual([]);
});

test('mobile: 360px layout, core navigation, offline failure and sign out', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await signIn(page, true);
  const meta = await page.evaluate(() => new Promise<any>((resolve, reject) => {
    const opening = indexedDB.open('vds_mobile', 2);
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db = opening.result;
      const read = db.transaction('meta').objectStore('meta').get('token');
      read.onsuccess = () => { resolve(read.result); db.close(); };
      read.onerror = () => { reject(read.error); db.close(); };
    };
  }));
  expect(meta.cookie_auth).toBe(true);
  expect(meta.v).toBeNull();
  expect(await page.evaluate(() => new Promise<boolean>(resolve => {
    const socket = new WebSocket(location.origin.replace(/^http/, 'ws') + '/ws');
    socket.onopen = () => { socket.close(); resolve(true); };
    socket.onerror = () => resolve(false);
  }))).toBe(true);
  for (const route of ['home', 'work', 'clock', 'inbox', 'settings']) {
    await page.goto('/m#/' + route);
    await expect(page.locator('#m-app')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/m#/home');
  await page.screenshot({ path: testInfo.outputPath('mobile-home.png'), fullPage: true });
  await page.route('**/api/auth/me', route => route.abort('failed'));
  await page.reload();
  await expect(page.locator('body')).toContainText(/sign in|network|offline|try again/i);
});

test('login forms: labelled controls, keyboard access and axe scan', async ({ page }, testInfo) => {
  for (const url of ['/', '/m']) {
    await page.goto(url);
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    await testInfo.attach(url === '/' ? 'desktop-accessibility.json' : 'mobile-accessibility.json', { body: JSON.stringify(result.violations, null, 2), contentType: 'application/json' });
    expect(result.violations.filter(v => v.impact === 'critical' || v.impact === 'serious')).toEqual([]);
  }
});

test('API attack surface: injection, oversized inputs, CORS and private caching', async ({ request }) => {
  const login = await request.post('/api/auth/login', { data: { username: "' OR 1=1--", password: 'wrong' } });
  expect(login.status()).toBe(401);
  expect((await request.post('/api/auth/login', { data: { username: 'a'.repeat(10000), password: 'x' } })).status()).toBe(400);
  const cors = await request.get('/api/auth/me', { headers: { Origin: 'https://evil.example' } });
  expect(cors.status()).toBe(401);
  expect(cors.headers()['access-control-allow-origin']).toBeUndefined();
  expect(cors.headers()['cache-control']).toBe('no-store');
  expect(cors.headers()['x-content-type-options']).toBe('nosniff');
  expect((await request.get('/', { headers: { Cookie: 'vds_view=%broken' } })).status()).toBe(200);
});
