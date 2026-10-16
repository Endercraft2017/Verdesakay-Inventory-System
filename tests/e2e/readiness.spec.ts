/// <reference lib="dom" />
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { generateSync } from 'otplib';

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

test('browser: separate users cannot edit each other’s notes; role changes revoke cookies', async ({ page, browser }) => {
  await signIn(page);
  const suffix = Date.now();
  const account = await page.evaluate(async s => {
    const username = 'browser.staff.' + s;
    const created = await API.post('/users', { username, full_name: 'Browser Employee', password: 'browser-test-password', role: 'warehouse' });
    const note = await API.post('/notes', { title: 'Owner-only', body: 'private record' });
    return { id: created.id, note: note.id, username };
  }, suffix);
  const context = await browser.newContext({ baseURL: new URL(page.url()).origin });
  const staff = await context.newPage();
  try {
    await staff.goto('/');
    await staff.locator('#login-username').fill(account.username);
    await staff.locator('#login-password').fill('browser-test-password');
    await staff.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(staff.locator('#app-screen')).toBeVisible();
    const forbidden = await staff.evaluate(async id => {
      const result = await fetch('/api/notes/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'VDS' }, body: JSON.stringify({ body: 'intrusion' }) });
      return result.status;
    }, account.note);
    expect(forbidden).toBe(404);
    await page.evaluate(async id => { await API.post('/notes', { body: 'second independent write' });
      const result = await fetch('/api/users/' + id + '/permissions', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'VDS' }, body: JSON.stringify({ overrides: { 'inventory.view': false } }) });
      if (!result.ok) throw new Error('Override failed');
    }, account.id);
    expect((await staff.request.get('/api/auth/me')).status()).toBe(401);
    const unchanged = await page.evaluate(async () => API.get('/notes'));
    expect(unchanged.find((n: any) => n.id === account.note).body).toBe('private record');
  } finally { await context.close(); }
});

test('browser: message HTML is a non-executable attachment and policy links are usable', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Privacy, terms and security (drafts)' }).click();
  await expect(page.getByRole('heading', { name: 'Policies and security' })).toBeVisible();
  await page.getByRole('link', { name: 'Privacy notice' }).click();
  await expect(page.locator('main')).toContainText('DRAFT');
  await signIn(page);
  const result = await page.evaluate(async () => {
    const user = await API.post('/users', { username: 'file.' + Date.now(), full_name: 'Attachment Reader', password: 'browser-test-password' });
    const form = new FormData(); form.set('recipient_id', String(user.id)); form.set('body', 'File safety');
    form.append('files', new Blob(['<script>window.COMPROMISED=true</script>'], { type: 'text/html' }), 'unsafe.html');
    const created = await fetch('/api/messages', { method: 'POST', headers: { 'X-Requested-With': 'VDS' }, body: form });
    const message = await created.json();
    const sent = await API.get('/messages?box=sent');
    const row = sent.find((m: any) => m.id === message.id);
    const response = await fetch('/api' + row.attachments[0].url);
    return { status: response.status, type: response.headers.get('content-type'), disposition: response.headers.get('content-disposition') };
  });
  expect(result.status).toBe(200); expect(result.type).toContain('application/octet-stream');
  expect(result.disposition).toMatch(/^attachment;/);
});

test('browser: uploaded JavaScript cannot execute as a self-hosted script', async ({ page }) => {
  await signIn(page);
  const ran = await page.evaluate(async () => {
    const form = new FormData(); form.set('title', 'Script execution probe');
    form.append('file', new Blob(['window.UPLOAD_EXECUTED=true'], { type: 'application/javascript' }), 'probe.js');
    const response = await fetch('/api/forms', { method: 'POST', headers: { 'X-Requested-With': 'VDS' }, body: form });
    if (!response.ok) throw new Error('Probe upload failed');
    const file = await response.json();
    return new Promise<boolean>(resolve => {
      const script = document.createElement('script'); script.src = '/api/forms/' + file.id + '/download';
      script.onload = () => resolve(true); script.onerror = () => resolve(false);
      document.head.appendChild(script);
    });
  });
  expect(ran).toBe(false);
  expect(await page.evaluate(() => (window as any).UPLOAD_EXECUTED)).toBeUndefined();
});

test('browser: authenticator enrollment, one-use recovery and mobile factor sign-in', async ({ page, browser }) => {
  await signIn(page);
  const username = 'mfa.' + Date.now();
  // Exercise real creation and both sign-in UIs with a password past bcrypt's old byte limit.
  const password = 'browser-mfa-password'.repeat(5);
  await page.evaluate(async args => { await API.post('/users', { username: args.username, full_name: 'MFA Browser', password: args.password, role: 'warehouse' }); }, { username, password });
  const context = await browser.newContext({ baseURL: new URL(page.url()).origin });
  const account = await context.newPage();
  try {
    await account.goto('/');
    await account.locator('#login-username').fill(username); await account.locator('#login-password').fill(password);
    await account.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(account.locator('#app-screen')).toBeVisible();
    await account.goto('/#account');
    await account.locator('#mfa-on').click();
    let dialog = account.locator('.modal-overlay');
    await dialog.locator('[data-f="pw"]').fill(password);
    await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
    dialog = account.locator('.modal-overlay');
    await expect(dialog).toContainText('Add it to your authenticator app');
    const secret = (await dialog.locator('.mono').innerText()).replace(/\s/g, '');
    await dialog.locator('[data-f="code"]').fill(generateSync({ secret }));
    await dialog.getByRole('button', { name: 'Turn on', exact: true }).click();
    await expect(dialog).toContainText('Two-step sign-in is on');
    const codes = (await dialog.locator('pre').innerText()).trim().split('\n'); expect(codes).toHaveLength(10);
    await dialog.getByRole('button', { name: 'I saved them', exact: true }).click();
    await account.evaluate(async () => { await API.post('/auth/logout'); (API as any).clearToken(); });
    await account.goto('/');
    await account.locator('#login-username').fill(username); await account.locator('#login-password').fill(password);
    await account.getByRole('button', { name: 'Sign in', exact: true }).click();
    dialog = account.locator('.modal-overlay');
    await expect(dialog).toContainText('Two-step sign-in');
    await dialog.locator('[data-f="code"]').fill(codes[0]!);
    await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(account.locator('#app-screen')).toBeVisible();
    await account.evaluate(async () => { await API.post('/auth/logout'); (API as any).clearToken(); });
    await account.setViewportSize({ width: 390, height: 844 }); await account.goto('/m');
    await account.locator('#m-username').fill(username); await account.locator('#m-password').fill(password);
    await account.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(account.locator('#m-mfa-code')).toBeVisible();
    await account.locator('#m-mfa-code').fill(codes[0]!);
    await account.locator('#m-mfa-form').getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(account.locator('#m-mfa-error')).toContainText('not right');
    await account.locator('#m-mfa-code').fill(codes[1]!);
    await account.locator('#m-mfa-form').getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(account.locator('#m-app')).toBeVisible();
    expect(await account.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // A factor change in another browser must terminate this mobile session too.
    await page.evaluate(async () => { await API.post('/auth/logout'); (API as any).clearToken(); });
    await page.goto('/');
    await page.locator('#login-username').fill(username);
    await page.locator('#login-password').fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    const factorDialog = page.locator('.modal-overlay');
    await factorDialog.locator('[data-f="code"]').fill(codes[2]!);
    await factorDialog.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.locator('#app-screen')).toBeVisible();
    await page.goto('/#account');
    await page.locator('#mfa-off').click();
    const disableDialog = page.locator('.modal-overlay');
    await disableDialog.locator('[data-f="pw"]').fill(password);
    await disableDialog.locator('[data-f="code"]').fill(codes[3]!);
    await disableDialog.getByRole('button', { name: 'Turn off', exact: true }).click();
    await expect(page.locator('#mfa-on')).toBeVisible();
    expect(await account.evaluate(async () => (await fetch('/api/auth/me')).status)).toBe(401);
  } finally { await context.close(); }
});
