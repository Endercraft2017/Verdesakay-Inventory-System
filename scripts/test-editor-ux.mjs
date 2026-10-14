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
const deadline = setTimeout(() => { console.error('Editor UX audit timed out'); backend.kill(); process.exit(1); }, 600000);
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
  if(name.endsWith('-more'))for(const action of ['data-details','data-help']){const label=page.locator('.doc-more-popover ['+action+'] span'),box=await label.boundingBox();assert(box&&box.width>20&&box.height>=10,action+' must have a visible menu label');}
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
async function closeDialog(title) { const dialog = page.getByRole('dialog', { name: title, exact: true }); await dialog.locator('.modal-foot [data-close]').click(); await dialog.waitFor({state:'hidden'}); }

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
    await page.locator('.doc-more-menu summary').click();await scan('desktop-'+theme+'-more');await page.locator('.doc-more-menu summary').click();
    await page.locator('[data-tab=home]').click();
    for (const tab of ['Properties','Pages','Layers','Outline','Styles','Data','Library','Review','History','Shared','Template','Print']) {
      await page.locator(`[data-studio-tab="${tab}"]`).click();
      await scan('desktop-' + theme + '-' + tab);
      await page.locator('[data-inspector-close]').click();
    }
  }
  await check('Save and Close remain visible across responsive widths', async () => {
    for (const width of [1440,1024,768,390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      for (const selector of ['[data-save]','[data-close]']) {
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
    for(const panel of ['Template','Print']){await editorButton('data-studio-tab='+panel).click();await scan('phone-'+theme+'-'+panel);await editorButton('data-inspector-close').click();}
    await page.locator('.doc-more-menu summary').click();await scan('phone-'+theme+'-more');await page.locator('.doc-more-menu summary').click();
  }
  await check('Assistant launcher does not cover the canvas and remains available', async () => {
    const button=editorButton('data-editor-assistant');
    if(await button.count()){
      assert.equal(await page.locator('#ai-fab').isVisible(),false);
      await button.click();await page.locator('#ai-widget').waitFor();await page.locator('#ai-widget-close').click();
    }
  });
  await check('Layout leads to a separate print-grid sidebar without changing document content', async () => {
    const before = (await api('GET', `/templates/${template.id}`)).body;
    const layout=page.locator('[data-panel=layout]');
    assert.equal(await layout.locator('.doc-copies,.doc-gap-x,.doc-zoomsel').count(),0);
    if(await editorButton('data-ribbon-more').isVisible()) await editorButton('data-ribbon-more').click();
    await editorButton('data-open-panel=Print').click();
    assert(await page.locator('.doc-gap-x').isVisible());
    assert(await page.locator('.doc-copies').isVisible());
    assert.equal(await page.locator('.doc-studio-side [data-inspector-title]').textContent(),'Print grid');
    await editorButton('data-inspector-close').click();
    assert.equal((await api('GET', `/templates/${template.id}`)).body,before);
    assert.equal(await page.locator('.doc-fs-bar .doc-save-status').textContent(),'No unsaved changes');
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await check('Variable bank copies complete tokens and field management returns to the editor', async () => {
    await editorButton('data-studio-tab=Data').click();
    await page.locator('[data-variable-search]').fill('company.name');
    await page.locator('[data-variable-copy]').first().click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '{{company.name}}');
    await editorButton('data-managevars').click();
    await scan('dialog-variable-manager', '[role=dialog]');
    await closeDialog('Template variables');
    assert(await page.locator('[data-variable-insert]').first().isVisible());
    await page.locator('[data-inspector-close]').click();
  });
  await check('Settings opens by keyboard, traps focus, and returns to its invoker', async () => {
    await page.locator('.doc-more-menu summary').focus();await page.keyboard.press('Enter');
    await editorButton('data-details').focus();await page.keyboard.press('Enter');
    const dialog=page.getByRole('dialog',{name:'Editor settings',exact:true});await dialog.waitFor();
    await scan('dialog-settings','[role=dialog]');
    await dialog.locator('[data-confirm]').focus();await page.keyboard.press('Tab');
    assert(await dialog.evaluate(element=>element.contains(document.activeElement)));
    assert(await dialog.locator('[data-confirm]').evaluate(element=>element!==document.activeElement));
    await page.keyboard.press('Shift+Tab');assert(await dialog.locator('[data-confirm]').evaluate(element=>element===document.activeElement));
    await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
    assert(await page.locator('.doc-more-menu summary').evaluate(element=>element===document.activeElement));
  });
  await editorButton('data-file').click(); await scan('dialog-file', '[role=dialog]'); await closeDialog('Import and export');
  await editorButton('data-studio-tab=Template').click();
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
  await closeDialog('Linked forms'); await editorButton('data-inspector-close').click();
  await page.locator('[data-tab=insert]').click(); await editorButton('data-ins=table').click();
  await scan('dialog-insert-table', '[role=dialog]');
  await page.getByRole('dialog', { name: 'Insert table', exact: true }).locator('[data-confirm]').click();
  await page.locator('.doc-surface td').first().click(); await page.locator('[data-tab=table]').click();
  await scan('desktop-dark-table');
  await editorButton('data-tbl=properties').click(); await scan('dialog-table-properties', '[role=dialog]'); await closeDialog('Table properties');
  await page.locator('[data-tab=insert]').click(); await editorButton('data-ins=image').click();
  const imageDialog = page.getByRole('dialog', {name:'Insert image',exact:true});
  await imageDialog.locator('#img-file').setInputFiles({name:'audit.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAFAAAAA8CAIAAAB+RarbAAAAY0lEQVR4nO3PQRHAIADAMEAhbxQjay62uy5R0M597viT9XXA2wzXGa4zXGe4znCd4TrDdYbrDNcZrjNcZ7jOcJ3hOsN1husM1xmuM1xnuM5wneE6w3WG6wzXGa4zXGe4znDdAxr5Aepp8UDGAAAAAElFTkSuQmCC','base64')});
  await imageDialog.locator('[data-confirm]').click(); await imageDialog.waitFor({state:'hidden'});
  for(const theme of ['light','dark']) for(const width of [1440,390]){
    await page.evaluate(value=>document.documentElement.dataset.theme=value,theme);
    await page.setViewportSize({width,height:width===390?844:1000});
    await page.locator('[data-tab=insert]').click();
    for(const [action,title] of [['image','Insert image'],['link','Insert link'],['symbol','Insert symbol'],['variable','Insert variable'],['formula','Insert a formula']]){
      if(['variable','formula'].includes(action)) await editorButton('data-studio-tab=Data').click();
      await editorButton('data-ins='+action).click();await page.getByRole('dialog',{name:title,exact:true}).waitFor();
      await scan('dialog-'+action+'-'+theme+'-'+width,'[role=dialog]');await closeDialog(title);if(['variable','formula'].includes(action)) await editorButton('data-inspector-close').click();
    }
    await page.locator('.doc-surface img').click(); await editorButton('data-studio-tab=Properties').click();
    await editorButton('data-do=picture').click(); await scan('dialog-picture-'+theme+'-'+width,'[role=dialog]'); await closeDialog('Picture settings'); await editorButton('data-inspector-close').click();
    await page.keyboard.press('Control+f'); await page.locator('.doc-find').waitFor(); await scan('find-'+theme+'-'+width); await page.keyboard.press('Escape');
    await page.locator('[data-tab=home]').click();await page.locator('.doc-surface p').first().click();
    await editorButton('data-paragraph').click();await scan('dialog-paragraph-'+theme+'-'+width,'[role=dialog]');await closeDialog('Paragraph spacing');
    await editorButton('data-studio-tab=Styles').click();await editorButton('data-adv=style-edit').first().click();await scan('dialog-style-'+theme+'-'+width,'[role=dialog]');
    const styleTitle=await page.getByRole('dialog').getAttribute('aria-label');await closeDialog(styleTitle);await editorButton('data-inspector-close').click();
    await editorButton('data-studio-tab=Pages').click();await editorButton('data-adv=section').click();await scan('dialog-section-'+theme+'-'+width,'[role=dialog]');await closeDialog('Insert section');await editorButton('data-inspector-close').click();
  }
  await page.setViewportSize({width:1440,height:1000});
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
  await check('Print-grid controls remain usable beside the measured preview and preserve proportional scaling', async () => {
    await editorButton('data-studio-tab=Print').click();
    for(const [selector,value] of [['.doc-copies','2'],['.doc-records-per-page','2'],['.doc-gap-x','0']]){await page.locator(selector).fill(value);await page.locator(selector).press('Tab');}
    await editorButton('data-print-preview').click();
    await page.waitForFunction(()=>document.querySelector('.doc-pageview iframe')?.contentDocument?.querySelectorAll('.tiled-cell-inner').length===4);
    assert(await page.locator('.doc-copies').isVisible()); assert(await page.locator('.doc-gap-x').isVisible());
    await scan('print-preview-sidebar','.doc-studio-side');
    await page.locator('.doc-gap-x').fill('3');await page.locator('.doc-gap-x').press('Tab');
    await page.waitForFunction(()=>{const doc=document.querySelector('.doc-pageview iframe')?.contentDocument,grid=doc?.querySelector('.tiled-grid');return grid&&Math.abs(parseFloat(doc.defaultView.getComputedStyle(grid).columnGap)-3*96/25.4)<.1;});
    const scales=await page.locator('.doc-pageview iframe').evaluate(frame=>[...frame.contentDocument.querySelectorAll('.tiled-cell-inner')].map(el=>({w:el.getBoundingClientRect().width/el.offsetWidth,h:el.getBoundingClientRect().height/el.offsetHeight})));
    assert.equal(scales.length,4);for(const scale of scales)assert(Math.abs(scale.w-scale.h)<.002);
    await editorButton('data-mode=visual').click(); await editorButton('data-inspector-close').click();
  });
  await check('Repeated saves with delayed shared polling persist text and reopen cleanly', async () => {
    await page.route('**/api/templates/studio/documents/**/room', async route => {
      const response = await route.fetch();
      if (route.request().method() === 'GET') await new Promise(resolve => setTimeout(resolve, 250));
      await route.fulfill({ response });
    });
    try {
      await page.locator('[data-tab=home]').click();
      for (let attempt = 0; attempt < 3; attempt++) {
        const paragraph = page.locator('.doc-surface p').first();
        await paragraph.click(); await page.keyboard.press('End');
        const text = ` Verified save ${attempt}.`;
        await page.keyboard.type(text);
        const published = page.waitForResponse(response => response.url() === `${base}/api/templates/${template.id}` && response.request().method() === 'PUT');
        await editorButton('data-save').click();
        assert.equal((await published).status(), 200);
        await page.waitForFunction(() => document.querySelector('.doc-save-status')?.textContent === 'Saved');
        assert((await api('GET', `/templates/${template.id}`)).body.includes(text.trim()));
        assert(!/overlap|need review/i.test(await page.locator('.doc-shared-status').textContent()));
      }
      await editorButton('data-close').click(); await page.locator('.doc-fs').waitFor({state:'hidden'});
      await page.locator(`[data-edit="${template.id}"]`).click();
      await page.waitForFunction(() => document.querySelector('.doc-shared-status')?.textContent.includes('Connected'));
      assert((await page.locator('.doc-surface').textContent()).includes('Verified save 2.'));
    } finally { await page.unroute('**/api/templates/studio/documents/**/room'); }
  });
  await check('A multipage design disables grid printing', async () => {
    await editorButton('data-studio-tab=Pages').click();
    await editorButton('data-adv=page-add').click(); await editorButton('data-adv=page-add').click();
    assert(await page.locator('.doc-copies').isDisabled());
    assert.equal(await page.locator('.doc-copies').inputValue(), '1');
    await editorButton('data-inspector-close').click();
  });
} catch (error) { report.errors.push(error.stack || error.message); console.error(error.message); if(page) await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{}); }
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
