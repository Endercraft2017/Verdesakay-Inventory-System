// Real browser checks against disposable data; never opens the application's database.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
const output = path.resolve('work/permission-picker-ux');
fs.mkdirSync(output, { recursive: true });
const server = spawn(process.execPath, ['--import', 'tsx', 'scripts/browser/editor-ux-server.ts'], { stdio: ['ignore', 'pipe', 'pipe'] });
server.stderr.on('data', d => fs.appendFileSync(path.join(output, 'server.log'), d));
let browser;
const watchdog = setTimeout(() => { server.kill(); process.exit(1); }, 180000);
try {
  const port = await new Promise((resolve, reject) => {
    let out = ''; server.stdout.on('data', d => { out += d; const m = out.match(/EDITOR_UX_PORT=(\d+)/); if (m) resolve(m[1]); });
    server.on('exit', code => reject(Error('Fixture server exited: ' + code)));
  });
  const base = 'http://127.0.0.1:' + port;
  async function api(route, body, token) {
    const r = await fetch(base + '/api' + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });
    assert(r.ok, route + ': ' + r.status); return r.json();
  }
  const { token } = await api('/auth/login', { username: 'admin', password: 'admin123' });
  const user = await api('/users', { username: 'picker_fixture', full_name: 'Permission UI Review', role: 'csr', password: 'Disposable-fixture-2026!' }, token);
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || fs.existsSync('/usr/bin/chromium') ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium' } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, hasTouch: true, serviceWorkers: 'block', timezoneId: 'Asia/Manila' });
  await context.addInitScript(token => { localStorage.setItem('vds_token', token); localStorage.setItem('vds_theme', 'dark'); }, token);
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/'); await page.waitForFunction(() => typeof AccessEditor !== 'undefined');
  await page.evaluate(async id => { await AccessEditor.open(id); }, user.id);
  await page.locator('.drawer-access.open').waitFor();
  assert.equal(await page.locator('.pp-group').count(), 15);
  assert.equal(await page.locator('[data-pp-key]').count(), new Set(await page.locator('[data-pp-key]').evaluateAll(xs => xs.map(x => x.dataset.ppKey))).size);
  await page.locator('[data-pp-group]').selectOption('orders');
  assert.equal(await page.locator('.pp-group').count(), 1);
  const tip = page.locator('[data-pp-key="orders.authorize"]').locator('..').locator('..').locator('.help-icon');
  await tip.hover(); await page.getByRole('tooltip').waitFor();
  assert.match(await page.getByRole('tooltip').textContent(), /commercial release authorization/);
  let bounds = await page.getByRole('tooltip').boundingBox(); assert(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 1440);
  await tip.focus(); await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('tooltip').count(), 0); assert.equal(await page.locator('.drawer-access.open').count(), 1);
  await page.locator('[data-pp-group]').selectOption('');
  const before = await page.locator('.pp-toolbar').boundingBox();
  await page.locator('.pp-list').evaluate(el => { el.scrollTop = el.scrollHeight; });
  const after = await page.locator('.pp-toolbar').boundingBox();
  assert.equal(after.y, before.y);
  const listBounds = await page.locator('.pp-list').boundingBox(); assert(listBounds.y >= after.y + after.height);
  const checkbox = page.locator('[data-pp-key="workspace.manage"]');
  await checkbox.focus(); await page.keyboard.press('Space');
  assert.equal(await checkbox.isChecked(), true); assert.equal(await checkbox.evaluate(el => el === document.activeElement), true);
  // Restore the draft; no account access is saved by this UI run.
  await page.locator('#perm-reset').click(); assert.equal(await checkbox.isChecked(), false);
  await page.locator('[data-pp-group]').selectOption('orders');
  await page.locator('.toast').waitFor({ state: 'detached' });
  await page.screenshot({ path: path.join(output, 'desktop.png') });
  await page.locator('[data-pp-details]').check();
  assert.equal(await page.locator('[data-pp-key="orders.create"]').locator('..').locator('..').locator('.pp-description').isVisible(), true);
  await page.locator('[data-pp-key="orders.delete"]').locator('..').locator('..').locator('.pp-text').click();
  assert.equal(await page.locator('[data-pp-key="orders.delete"]').isChecked(), true);
  await page.locator('[data-pp-show="off"]').click();
  assert.equal(await page.locator('[data-pp-key="orders.delete"]').count(), 0);
  await page.screenshot({ path: path.join(output, 'permission-explanations.png') });
  await page.locator('[data-pp-show="all"]').click();
  await page.locator('[data-pp-details]').uncheck();
  await page.locator('#perm-reset').click();
  console.log('PASS desktop grouping, hover, keyboard help, focus preservation, and toolbar scrolling');

  for (const viewport of [{ width: 390, height: 844 }, { width: 360, height: 640 }]) {
    await page.setViewportSize(viewport);
    for (const mode of ['account', 'role']) {
      if (mode === 'role') {
        await page.evaluate(async () => { await AccessEditor.editRole(null); });
        await page.waitForFunction(() => document.querySelectorAll('.drawer-access').length === 1);
      }
      await page.locator('[data-pp-group]').selectOption('payroll');
      const help = page.locator('[data-pp-key="payroll.approve"]').locator('..').locator('..').locator('.help-icon');
      await help.scrollIntoViewIfNeeded();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await help.tap(); await page.getByRole('tooltip').waitFor();
      bounds = await page.getByRole('tooltip').boundingBox();
      assert(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height);
      if (mode === 'account' && viewport.width === 390) await page.screenshot({ path: path.join(output, 'tooltip-touch.png') });
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.drawer-access').evaluate(el => el.scrollWidth > el.clientWidth), false);
      assert.equal(await page.locator('.pp-list').evaluate(el => el.scrollWidth > el.clientWidth), false);
      const list = await page.locator('.pp-list').boundingBox(); assert(list.height >= 120, JSON.stringify({ mode, viewport, list }));
      const footer = await page.locator('.drawer-access .drawer-foot').boundingBox(); assert(footer.y + footer.height <= viewport.height + 1);
      await page.screenshot({ path: path.join(output, `${mode}-${viewport.width}.png`) });
      if (mode === 'role') {
        await page.evaluate(async id => { await AccessEditor.open(id); }, user.id);
        await page.waitForFunction(() => document.querySelectorAll('.drawer-access').length === 1);
      }
    }
  }
  console.log('PASS account and role editors at 390px and 360px: tap help, visible footer, usable list, no horizontal overflow');
  await page.locator('.drawer-access.open [data-close]').click();
  await page.locator('.drawer-access').waitFor({ state: 'detached' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => App.navigate('admin'));
  await page.locator('#add-user').click();
  const modal = page.locator('.modal-overlay').last();
  await modal.locator('[data-f="full_name"]').fill('Unsaved role selection');
  const choose = modal.locator('.role-picker-trigger');
  await choose.click();
  const search = modal.getByRole('searchbox', { name: 'Find a role' });
  await search.fill('inventory.receive');
  await modal.locator('[data-role-choice="warehouse"]').waitFor();
  await search.fill('csr');
  // Normal buttons support keyboard selection without committing the account form.
  await modal.locator('[data-role-choice="csr"]').focus(); await page.keyboard.press('Enter');
  assert.equal(await modal.locator('[data-f="role"]').inputValue(), 'csr');
  assert.equal(await choose.getAttribute('aria-expanded'), 'false');
  assert.equal(await choose.evaluate(el => el === document.activeElement), true);
  await modal.locator('.role-preview summary').click();
  assert.match(await modal.locator('.role-preview-groups').textContent(), /Create orders/);
  assert.doesNotMatch(await modal.locator('.role-preview-groups').textContent(), /Administer roles and permissions/);
  await choose.click(); await search.fill('no matching role here');
  await modal.locator('[data-role-clear]').click();
  assert.equal(await modal.locator('[data-role-choice]').count(), await modal.locator('[data-f="role"] option').count());
  await search.focus(); await page.keyboard.press('Escape');
  assert.equal(await modal.count(), 1); assert.equal(await modal.locator('[data-f="role"]').inputValue(), 'csr');
  assert.equal(await modal.locator('[data-f="full_name"]').inputValue(), 'Unsaved role selection');
  await page.screenshot({ path: path.join(output, 'role-preview-desktop.png') });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), theme);
    await page.setViewportSize({ width: 360, height: 640 });
    await choose.tap(); await search.fill('csr');
    await modal.locator('[data-role-choice="csr_supervisor"]').scrollIntoViewIfNeeded();
    assert.equal(await modal.evaluate(el => el.scrollWidth > el.clientWidth), false);
    assert.equal(await modal.locator('.role-picker-results').evaluate(el => el.scrollWidth > el.clientWidth), false);
    await page.screenshot({ path: path.join(output, `role-choice-360-${theme}.png`) });
    await modal.locator('[data-role-choice="csr_supervisor"]').tap();
    assert.equal(await modal.locator('[data-f="role"]').inputValue(), 'csr_supervisor');
    const foot = await modal.locator('.modal-foot').boundingBox(); assert(foot.y + foot.height <= 641);
  }
  page.once('dialog', dialog => dialog.accept()); // Explicitly discard this synthetic account draft.
  await modal.locator('.modal-head [data-close]').click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator(`tr[data-open="${user.id}"] td`).first().click();
  await page.locator('#edit-perm-btn').waitFor();
  assert.equal(await page.locator('[data-f="role"]').inputValue(), 'csr');
  console.log('PASS searchable role choice, permission preview, keyboard selection, Escape preserving account drafts, touch/light/dark layout; role browsing makes no account changes');
  assert.deepEqual(errors, []);
} finally {
  await browser?.close(); server.kill('SIGTERM'); clearTimeout(watchdog);
}
