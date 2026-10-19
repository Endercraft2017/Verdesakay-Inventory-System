import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

// Disposable tenant only: exercise a real account-access edit and the phone approval desk.
const server = spawn(process.execPath, ['--import', 'tsx', 'scripts/browser/editor-ux-server.ts'], { stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
try {
  const port = await new Promise((resolve, reject) => {
    server.stdout.on('data', data => { const match = String(data).match(/EDITOR_UX_PORT=(\d+)/); if (match) resolve(match[1]); });
    server.on('exit', code => reject(new Error(`Disposable server exited: ${code}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  const api = async (method, path, token, body, expected = 200) => {
    const response = await fetch(base + '/api' + path, {
      method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(data)}`);
    return data;
  };
  const admin = (await api('POST', '/auth/login', null, { username: 'admin', password: 'admin123' })).token;
  const catalog = await api('GET', '/users/permissions/catalog', admin);
  for (const key of ['mobile.access', 'inventory.view', 'inventory.adjust', 'purchasing.manage',
    'production.approve', 'production.record', 'production.inspect_qc', 'production.inspect_qa',
    'production.qa_review', 'production.receive', 'orders.edit', 'orders.release',
    'delivery.run', 'delivery.manage']) {
    assert(catalog.permissions.includes(key), `Permission missing from account editor: ${key}`);
  }
  const managerUser = await api('POST', '/users', admin,
    { username: 'approval-manager', full_name: 'Approval Manager', password: 'testpass123', role: 'production_manager' }, 201);
  const manager = (await api('POST', '/auth/login', null,
    { username: 'approval-manager', password: 'testpass123' })).token;
  const product = await api('POST', '/inventory', admin, { name: 'Permission audit product' }, 201);
  const component = await api('POST', '/inventory', admin, { name: 'Permission audit component', quantity: 2 }, 201);
  await api('PUT', `/finished-products/${product.id}`, admin,
    { components: [{ component_item_id: component.id, quantity: 1 }] });
  const job = await api('POST', '/job-orders', admin, { product_item_id: product.id, qty_ordered: 1 }, 201);
  await api('POST', `/job-orders/${job.id}/approve`, manager, {}, 403);
  assert.equal((await api('GET', `/job-orders/${job.id}`, manager)).approved_at, null);

  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const desktopContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  await desktopContext.addInitScript(token => localStorage.setItem('vds_token', token), admin);
  const desktop = await desktopContext.newPage();
  await desktop.goto(base + '/app');
  await desktop.waitForFunction(() => typeof App !== 'undefined' && App.getMe());
  await desktop.evaluate(id => App.navigate('admin', { id }), managerUser.id);
  await desktop.locator('#edit-perm-btn').waitFor();
  assert.equal(await desktop.locator('#edit-perm-btn').count(), 1, 'Account deep link should open one editor');
  await desktop.locator('#edit-perm-btn').click();
  await desktop.locator('#perm-save').waitFor();
  await desktop.getByText('Raise new sale orders', { exact: true }).waitFor();
  await desktop.getByText('Customize fields on the item form', { exact: true }).waitFor();
  await desktop.getByText('Sign off a draft job order so the warehouse can release its parts', { exact: true }).waitFor();
  const approval = desktop.locator('.drawer.open [data-pp-key="production.approve"]');
  assert.equal(await approval.isChecked(), false);

  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await phoneContext.addInitScript(token => localStorage.setItem('vds_token', token), manager);
  const phone = await phoneContext.newPage();
  const errors = [];
  desktop.on('pageerror', error => errors.push(error.message));
  phone.on('pageerror', error => errors.push(error.message));
  await phone.goto(base + '/m#/work');
  await phone.locator('#m-view .v2-work').waitFor();
  assert.equal(await phone.locator('#m-view').getByRole('button', { name: /Awaiting production approval/ }).count(), 0);

  const save = async on => {
    await desktop.locator('#edit-perm-btn').click();
    await desktop.locator('#perm-save').waitFor();
    const box = desktop.locator('.drawer.open [data-pp-key="production.approve"]');
    if ((await box.isChecked()) !== on) await box.locator('..').click();
    const saved = desktop.waitForResponse(response => response.url().endsWith(`/users/${managerUser.id}/permissions`) && response.request().method() === 'PUT');
    await desktop.locator('#perm-save').click();
    assert.equal((await saved).status(), 200);
    await desktop.locator('#perm-save').waitFor({ state: 'detached' });
  };
  // The first editor opening above is only for checking labels; close it before using save().
  await desktop.locator('.drawer [data-close]').click();
  await desktop.locator('#perm-save').waitFor({ state: 'detached' });
  await save(true);
  await phone.locator('#m-tabbar [data-tab=work]').click();
  await phone.locator('#m-view').getByRole('button', { name: /Awaiting production approval/ }).waitFor();
  assert((await api('GET', '/auth/me', manager)).user.permissions.includes('production.approve'));
  await phone.locator('#m-view').getByRole('button', { name: /Awaiting production approval/ }).click();
  await phone.getByText('Permission audit product').first().waitFor();
  const reviewed = await api('GET', `/job-orders/${job.id}`, manager);
  await api('POST', `/job-orders/${job.id}/approve`, manager, { expected_revision: reviewed.approval_revision });
  assert((await api('GET', `/job-orders/${job.id}`, admin)).approved_at);
  console.log('Production manager denied by default; desktop grant appears on phone and permits reviewed approval');

  await save(false);
  await phone.evaluate(() => MApp.go('home'));
  await phone.locator('#m-tabbar [data-tab=work]').click();
  await phone.locator('#m-view .v2-work').waitFor();
  await phone.waitForFunction(() => !MApp.can('production.approve'));
  assert.equal(await phone.locator('#m-view').getByRole('button', { name: /Awaiting production approval/ }).count(), 0);
  const another = await api('POST', '/job-orders', admin, { product_item_id: product.id, qty_ordered: 1 }, 201);
  await api('POST', `/job-orders/${another.id}/approve`, manager, {}, 403);
  assert.equal((await api('GET', `/job-orders/${another.id}`, admin)).approved_at, null);
  assert.deepEqual(errors, []);
  console.log('Revoking approval hides the phone desk and restores backend denial');
  await phoneContext.close();
  await desktopContext.close();
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
