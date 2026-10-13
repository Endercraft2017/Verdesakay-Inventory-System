import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'work/editor-ux');
fs.mkdirSync(output, { recursive: true });
const reportOnly = process.argv.includes('--report-only');
const filter = process.env.EDITOR_UX_CASE || '';
const report = { scans: [], checks: [], errors: [] };
const backend = spawn(process.execPath, ['--import', 'tsx', 'scripts/browser/editor-ux-server.ts'], {
  cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
});
backend.stderr.on('data', data => fs.appendFileSync(path.join(output, 'server.log'), data));
let browser, context, page, base, token;
const deadline = setTimeout(() => { console.error('Editor UX audit timed out'); backend.kill(); process.exit(1); }, 360000);
async function api(method, resource, body) {
  const response = await fetch(base + '/api' + resource, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  assert(response.ok, `${method} ${resource}: ${response.status} ${JSON.stringify(result)}`);
  return result;
}
async function scan(name, selector = '.doc-fs') {
  if (filter && !name.includes(filter)) return;
  await page.waitForTimeout(180); // wait for modal transition, not an application/network timeout
  const result = await new AxeBuilder({ page }).include(selector)
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const map = item => ({ id: item.id, impact: item.impact, description: item.description, helpUrl: item.helpUrl,
    nodes: item.nodes.map(node => ({ target: node.target, summary: node.failureSummary, html: node.html })) });
  report.scans.push({ name, violations: result.violations.map(map), incomplete: result.incomplete.map(map) });
  await page.screenshot({ path: path.join(output, name + '.png') });
  console.log(`${name}: ${result.violations.length} violations, ${result.incomplete.length} manual-review rules`);
}
async function check(name, action) {
  try { await action(); report.checks.push({ name, passed: true }); console.log('PASS ' + name); }
  catch (error) { report.checks.push({ name, passed: false, error: error.message }); console.error('FAIL ' + name + ': ' + error.message); }
}
function editorButton(attribute) { return page.locator('.doc-fs [' + attribute + ']'); }
async function closeDialog(title) { await page.getByRole('dialog', { name: title, exact: true }).locator('.modal-foot [data-close]').click(); }

try {
  base = 'http://127.0.0.1:' + await new Promise((resolve, reject) => {
    let text = '';
    backend.stdout.on('data', data => { text += data; const match = text.match(/EDITOR_UX_PORT=(\d+)/); if (match) resolve(match[1]); });
    backend.on('exit', code => reject(new Error('Audit server exited: ' + code)));
  });
  token = (await api('POST', '/auth/login', { username: 'admin', password: 'admin123' })).token;
  await api('POST', '/auth/change-password', { current_password: 'admin123', new_password: 'EditorAudit!73952' });
  const template = await api('POST', '/templates', { name: 'Editor UX audit', type: 'generic',
    body: '<style data-docpage>@page{size:210mm 297mm;margin:14mm}</style><h1>{{company.name}}</h1><p>Employee payslip layout.</p>' });
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || ['/usr/lib/chromium/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(fs.existsSync);
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', permissions: ['clipboard-read','clipboard-write'] });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  await context.addInitScript(({ value, origin }) => { if (window === window.top && location.origin === origin) {
    localStorage.setItem('vds_token', value); localStorage.setItem('vds_theme', 'light');
  } }, { value: token, origin: base });
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(base + '/app');
  await page.waitForFunction(() => typeof App !== 'undefined' && App.getMe());
  await page.evaluate(() => App.navigate('templates'));
  await page.locator(`[data-edit="${template.id}"]`).click();
  await page.locator('.doc-surface').waitFor();
  await page.waitForFunction(() => document.querySelector('.doc-shared-status')?.textContent.includes('Connected'));

  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
    for (const tab of ['home','insert','layout']) {
      await page.locator(`[data-tab="${tab}"]`).click();
      await scan('desktop-' + theme + '-' + tab);
    }
    await page.locator('[data-tab=home]').click();
    for (const tab of ['Properties','Pages','Layers','Outline','Styles','Data','Library','Review','History','Shared']) {
      await page.locator(`[data-studio-tab="${tab}"]`).click();
      await scan('desktop-' + theme + '-' + tab);
      await page.locator('[data-inspector-close]').click();
    }
  }
  await check('Save and Close remain visible across responsive widths', async () => {
    for (const width of [1440,1024,768,390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      for (const selector of ['[data-save]','[data-close]','[data-linked-forms]']) {
        const box = await page.locator('.doc-fs ' + selector).boundingBox();
        assert(box && box.x >= 0 && box.x + box.width <= width + 1, selector + ' clipped at ' + width);
      }
    }
  });
  for (const theme of ['light','dark']) {
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
    for (const tab of ['home','insert','layout']) {
      await page.locator(`[data-tab="${tab}"]`).click(); await scan('phone-' + theme + '-' + tab);
    }
  }
  await check('Assistant launcher does not cover the canvas and remains available', async () => {
    const button=editorButton('data-editor-assistant');
    if(await button.count()){
      assert.equal(await page.locator('#ai-fab').isVisible(),false);
      await button.click();await page.locator('#ai-widget').waitFor();await page.locator('#ai-widget-close').click();
    }
  });
  await check('Compact ribbon exposes its remaining controls', async () => {
    await editorButton('data-ribbon-more').waitFor({ state: 'visible' });
    await editorButton('data-ribbon-more').click();
    await page.locator('.doc-gap-x').fill('0'); await page.locator('.doc-gap-x').press('Tab');
    assert(await page.locator('[data-panel=layout]').evaluate(element => element.scrollTop > 0));
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await check('Variable bank copies complete tokens and field management returns to the editor', async () => {
    await editorButton('data-studio-tab=Data').click();
    await page.locator('[data-variable-search]').fill('company.name');
    await page.locator('[data-variable-copy]').first().click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '{{company.name}}');
    await page.locator('[data-do=manage-fields]').click();
    await scan('dialog-variable-manager', '[role=dialog]');
    await closeDialog('Template variables');
    assert(await page.locator('[data-variable-insert]').first().isVisible());
    await page.locator('[data-inspector-close]').click();
  });
  await check('Settings opens by keyboard, traps focus, and returns to its invoker', async () => {
    await editorButton('data-details').focus();await page.keyboard.press('Enter');
    const dialog=page.getByRole('dialog',{name:'Editor settings',exact:true});await dialog.waitFor();
    await scan('dialog-settings','[role=dialog]');
    await dialog.locator('[data-confirm]').focus();await page.keyboard.press('Tab');
    assert(await dialog.evaluate(element=>element.contains(document.activeElement)));
    assert(await dialog.locator('[data-confirm]').evaluate(element=>element!==document.activeElement));
    await page.keyboard.press('Shift+Tab');assert(await dialog.locator('[data-confirm]').evaluate(element=>element===document.activeElement));
    await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
    assert(await editorButton('data-details').evaluate(element=>element===document.activeElement));
  });
  await editorButton('data-file').click(); await scan('dialog-file', '[role=dialog]'); await closeDialog('Import and export');
  await editorButton('data-linked-forms').click(); await page.locator('[data-link-form]').waitFor();
  await scan('dialog-linked-forms', '[role=dialog]');
  await check('A payslip layout can be linked and made default without removing other layouts', async () => {
    const forms = await api('GET', '/form-definitions');
    const form = forms.find(item => item.slug === 'hr_payroll'); assert(form);
    const oldDefault = form.template_id;
    const dialog = page.getByRole('dialog', { name: 'Linked forms', exact: true });
    await dialog.locator('[data-link-search]').fill(form.name);
    await dialog.locator('[data-link-form]').selectOption(String(form.id));
    await dialog.locator('[data-link-default]').check();
    await dialog.locator('[data-link-form-action]').click();
    await dialog.locator(`[data-link-unlink="${form.id}"]`).waitFor();
    const layouts = await api('GET', `/form-definitions/${form.id}/templates`);
    assert(layouts.find(item => item.id === template.id)?.is_default);
    if (oldDefault) assert(layouts.some(item => item.id === oldDefault));
  });
  await closeDialog('Linked forms');
  await page.locator('[data-tab=insert]').click(); await editorButton('data-ins=table').click();
  await scan('dialog-insert-table', '[role=dialog]');
  await page.getByRole('dialog', { name: 'Insert table', exact: true }).locator('[data-confirm]').click();
  await page.locator('.doc-surface td').first().click(); await page.locator('[data-tab=table]').click();
  await scan('desktop-dark-table');
  await editorButton('data-tbl=properties').click(); await scan('dialog-table-properties', '[role=dialog]'); await closeDialog('Table properties');
  await check('Page size swaps and undo restores both dimensions', async () => {
    await page.locator('[data-tab=layout]').click();
    await page.locator('.doc-custom-w').fill('180'); await page.locator('.doc-custom-w').press('Tab');
    await page.locator('.doc-custom-h').fill('250'); await page.locator('.doc-custom-h').press('Tab');
    await editorButton('data-swap-wh').click();
    assert.equal(await page.locator('.doc-custom-w').inputValue(), '250');
    assert.equal(await page.locator('.doc-custom-h').inputValue(), '180');
    await editorButton('data-ex=undo').click();
    assert.equal(await page.locator('.doc-custom-w').inputValue(), '180');
    assert.equal(await page.locator('.doc-custom-h').inputValue(), '250');
    await page.locator('.doc-zoomsel').selectOption('0.5');
    const handle=page.locator('[data-page-resize=se]');const bounds=await handle.boundingBox();assert(bounds);
    await page.mouse.move(bounds.x+bounds.width/2,bounds.y+bounds.height/2);await page.mouse.down();
    await page.mouse.move(bounds.x+bounds.width/2+96/25.4*10*.5,bounds.y+bounds.height/2+96/25.4*10*.5,{steps:5});await page.mouse.up();
    assert.equal(await page.locator('.doc-custom-w').inputValue(),'190');assert.equal(await page.locator('.doc-custom-h').inputValue(),'260');
    await editorButton('data-ex=undo').click();assert.equal(await page.locator('.doc-custom-w').inputValue(),'180');assert.equal(await page.locator('.doc-custom-h').inputValue(),'250');
  });
  await check('A multipage design disables grid printing', async () => {
    await editorButton('data-studio-tab=Pages').click();
    await editorButton('data-adv=page-add').click(); await editorButton('data-adv=page-add').click();
    assert(await page.locator('.doc-copies').isDisabled());
    assert.equal(await page.locator('.doc-copies').inputValue(), '1');
    await editorButton('data-inspector-close').click();
  });
} catch (error) { report.errors.push(error.stack || error.message); console.error(error.message); }
finally {
  clearTimeout(deadline);
  const violations = report.scans.reduce((sum, item) => sum + item.violations.length, 0);
  const failed = report.checks.filter(item => !item.passed).length;
  report.summary = { scans: report.scans.length, violations, checks: report.checks.length, failed, errors: report.errors.length };
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.summary));
  if (context) await context.tracing.stop({ path: path.join(output, 'trace.zip') }).catch(() => {});
  if (browser) await browser.close();
  if (backend.exitCode === null && backend.signalCode === null) { const stopped = once(backend, 'exit'); backend.kill(); await stopped.catch(() => {}); }
  if (report.errors.length || failed || (!reportOnly && violations)) process.exitCode = 1;
}
