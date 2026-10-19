// Actual-app payroll checks against the shared disposable browser-audit server.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'work/forms-ux');
fs.mkdirSync(output, { recursive: true });
const report = { checks: [], scans: [], errors: [] };
const server = spawn(process.execPath, ['--import', 'tsx', 'scripts/browser/editor-ux-server.ts'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
server.stderr.on('data', data => fs.appendFileSync(path.join(output, 'server.log'), data));
let browser, page, base, token;
const timer = setTimeout(() => { server.kill(); process.exit(1); }, 240000);
async function api(method, route, body) {
  const response = await fetch(base + '/api' + route, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const value = await response.json();
  assert(response.ok, `${method} ${route}: ${response.status} ${JSON.stringify(value)}`);
  return value;
}
async function check(name, action) {
  try { await action(); report.checks.push({ name, passed: true }); console.log('PASS ' + name); }
  catch (error) { report.checks.push({ name, passed: false, error: error.message }); console.error('FAIL ' + name + ': ' + error.message); }
}
async function scan(name, selector = '.modal-overlay') {
  const result = await new AxeBuilder({ page }).include(selector).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  report.scans.push({ name, violations: result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => ({ target: n.target, summary: n.failureSummary })) })) });
  await page.screenshot({ path: path.join(output, name + '.png'), fullPage: true });
  console.log(`${name}: ${result.violations.length} violations`);
}
try {
  base = 'http://127.0.0.1:' + await new Promise((resolve, reject) => {
    let text = '';
    server.stdout.on('data', data => { text += data; const match = text.match(/EDITOR_UX_PORT=(\d+)/); if (match) resolve(match[1]); });
    server.on('exit', code => reject(new Error('Audit server exited: ' + code)));
  });
  token = (await api('POST', '/auth/login', { username: 'admin', password: 'admin123' })).token;
  await api('PUT', '/hr/payroll-policy', { pay_frequency: 'semi_monthly', auto_statutory: true, default_rest_days: [] });
  const employee = await api('POST', '/hr/employees', { employee_no: 'UX-PAY', name: 'Payroll UX Employee', daily_rate: 1800, user_id: (await api('GET', '/auth/me')).user.id });
  const shift = await api('POST', '/hr/shifts', { name: 'UX shift', start_time: '08:00', end_time: '17:00', is_default: false });
  const period = await api('POST', '/hr/periods', { label: 'Payroll UX cutoff', start_date: '2026-10-05', end_date: '2026-10-05' });
  period.label = 'Payroll UX cutoff';
  await api('POST', `/hr/periods/${period.id}/employees`, { employee_id: employee.id });
  await api('PUT', `/hr/periods/${period.id}/attendance`, { employee_id: employee.id, days: [{ work_date: '2026-10-05', time_in: '08:00', time_out: '17:00', shift_id: shift.id, notes: '' }] });
  const generated = await api('POST', `/hr/periods/${period.id}/generate-payslips`, { payroll_period: period.label });
  const record = (await api('GET', `/form-definitions/${generated.form_id}/records?period=${encodeURIComponent(period.label)}`))[0];
  const readRecord = () => api('GET', `/form-records/${record.id}`);
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || ['/usr/lib/chromium/chromium', '/usr/bin/chromium'].find(fs.existsSync);
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', timezoneId: 'Asia/Manila' });
  await context.addInitScript(value => localStorage.setItem('vds_token', value), token);
  page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(base);
  await page.waitForSelector('#app-screen:not(.hidden)');
  await check('HR forms use a column list and Payroll stays under HR', async () => {
    await page.evaluate(() => App.navigate('form-records', { scope: 'hr' }));
    await page.locator('.form-explorer tbody tr').first().waitFor();
    assert.equal(await page.locator('#view').getAttribute('data-section'), 'hr');
    assert((await page.locator('.form-explorer th').first().textContent()).startsWith('Form name'));
    assert(await page.locator('.form-explorer th').allTextContents().then(items => items.includes('Records') && items.includes('Updated')));
    await scan('hr-form-explorer-light-desktop', '#view');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
    assert(await page.locator('.form-explorer-scroll').evaluate(el => el.scrollWidth > el.clientWidth));
    await scan('hr-form-explorer-dark-phone', '#view');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => document.documentElement.dataset.theme = 'light');
    await page.evaluate(() => App.navigate('form-records', { slug: 'hr_payroll' }));
    await page.locator('#fr-back').waitFor();
    assert.equal(await page.locator('#view').getAttribute('data-section'), 'hr');
    assert.equal(await page.locator('#primary-nav [data-primary="hr"]').getAttribute('aria-current'), 'page');
    assert.equal(await page.locator('[data-subtab="payroll"]').getAttribute('aria-current'), 'page');
    await page.locator('#fr-back').click();
    await page.locator('.form-explorer').waitFor();
    assert.equal(await page.locator('#view').getAttribute('data-section'), 'hr');
    await page.locator('.form-explorer .form-card').filter({ hasText: 'HR Payroll' }).click();
    await page.locator('#fr-back').waitFor();
    assert.equal(await page.locator('[data-subtab="payroll"]').getAttribute('aria-current'), 'page');
  });
  const open = async () => {
    await page.evaluate(filter => App.navigate('form-records', filter), { slug: 'hr_payroll', period: period.label });
    await page.locator(`[data-id="${record.id}"] .hr-row-open`).click();
    await page.locator('.pd-adjustments summary').click();
  };
  const close = async () => { await page.locator('.modal-overlay').last().locator('.modal-foot [data-close]').click(); await page.waitForSelector('.modal-overlay', { state: 'detached' }); };
  await open();
  await check('Manual amounts preview without persisting, including zero', async () => {
    for (const [key, amount] of Object.entries({ sss: 0, philhealth: 111.25, pagibig: 222, withholding_tax: 333.5 })) {
      await page.locator('#pd-override-' + key).fill(String(amount));
      await page.locator('#pd-override-' + key).dispatchEvent('change');
    }
    await page.waitForFunction(() => document.querySelector('[data-ded-amount="withholding_tax"]').textContent.includes('333.50'));
    assert.notEqual((await readRecord()).data.withholding_tax, 333.5);
  });
  await scan('payroll-desktop');
  await check('Save blocks dismissal until the request finishes', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let started;
    const requestStarted = new Promise(resolve => { started = resolve; });
    let finished;
    const requestHandled = new Promise(resolve => { finished = resolve; });
    await page.route('**/api/hr/payroll/*/deductions', async route => { started(); await gate; try { await route.continue(); } finally { finished(); } });
    const acceptDiscard = dialog => dialog.accept();
    page.on('dialog', acceptDiscard);
    try {
      await page.locator('#pd-ded-save').click();
      await requestStarted;
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.pd-adjustments').count(), 1, 'Payslip must remain open while saving');
    } finally { release(); await requestHandled; await page.unroute('**/api/hr/payroll/*/deductions'); page.off('dialog', acceptDiscard); }
    await page.waitForFunction(() => document.querySelector('#pd-ded-save') && !document.querySelector('#pd-ded-save').disabled);
  });
  if (!await page.locator('.pd-adjustments').count()) await open();
  await check('Saved overrides survive reopen and regeneration', async () => {
    await page.waitForFunction(() => document.querySelector('#pd-ded-save') && !document.querySelector('#pd-ded-save').disabled);
    assert.equal((await readRecord()).data.total_deductions, 666.75);
    await close(); await open();
    assert.equal(await page.locator('#pd-override-sss').inputValue(), '0');
    assert.equal(await page.locator('#pd-override-philhealth').inputValue(), '111.25');
    await api('POST', `/hr/periods/${period.id}/generate-payslips`, { payroll_period: period.label });
    assert.equal((await readRecord()).data.withholding_tax, 333.5);
    assert.equal((await readRecord()).data.net_pay, record.data.total_earnings - 666.75);
    await close(); await open(); // Regeneration advances the revision; refresh before editing again.
  });
  await check('Deduction audit opens with the saved before and after values',async()=>{
    await page.locator('#pd-history').click();
    await page.locator('.modal-overlay').last().getByText('Deduction history — '+record.number,{exact:true}).waitFor();
    await scan('payroll-deduction-history');
    assert((await page.locator('.modal-overlay').last().innerText()).includes('Manual'));
    await page.locator('.modal-overlay').last().locator('.modal-foot [data-close]').click();
  });
  await check('Print preview includes the saved deduction amounts', async () => {
    await page.locator('#pd-print').click();
    const frame = page.frameLocator('#payslip-preview-frame');
    await frame.locator('body').waitFor();
    await scan('payroll-print-preview');
    const text = await frame.locator('body').innerText();
    for (const amount of ['111.25', '222.00', '333.50', '666.75']) assert(text.includes(amount), amount + ' must appear in print');
    await page.locator('.modal-overlay').last().locator('.modal-foot [data-close]').click();
  });
  await check('Invalid payroll amounts show field errors and cannot be saved', async () => {
    await page.locator('#pd-override-sss').fill('-1');
    await page.locator('#pd-ded-save').click();
    assert.equal(await page.locator('#pd-override-sss').getAttribute('aria-invalid'), 'true');
    assert.equal((await readRecord()).data.sss, 0);
    await scan('payroll-validation');
    await page.locator('#pd-override-sss').fill('0');
    await page.locator('#pd-override-sss').dispatchEvent('change');
  });
  await check('Print waits for the latest unsaved preview without saving it', async () => {
    await page.route('**/api/hr/payroll/*/preview-deductions', async route => { await new Promise(resolve => setTimeout(resolve, 180)); await route.continue(); });
    await page.locator('#pd-override-withholding_tax').fill('444.5');
    await page.locator('#pd-print').click();
    const frame = page.frameLocator('#payslip-preview-frame'); await frame.locator('body').waitFor();
    const text = await frame.locator('body').innerText();
    assert(text.includes('444.50')); assert(text.includes('777.75')); assert(!text.includes('Manual'));
    assert.equal((await readRecord()).data.withholding_tax, 333.5);
    await page.locator('.modal-overlay').last().locator('.modal-foot [data-close]').click();
    await page.unroute('**/api/hr/payroll/*/preview-deductions');
    await page.locator('#pd-override-withholding_tax').fill('333.5');
    await page.locator('#pd-override-withholding_tax').dispatchEvent('change');
    await page.locator('#pd-ded-save').click();
    await page.waitForFunction(() => !document.querySelector('#pd-ded-save').disabled);
  });
  await check('Use automatic clears one override while preserving the others', async () => {
    await page.locator('[data-ded-reset=sss]').click();
    await page.waitForFunction(() => document.querySelector('[data-ded-amount=sss]').textContent.includes('Automatic'));
    await page.locator('#pd-ded-save').click();
    await page.waitForFunction(() => !document.querySelector('#pd-ded-save').disabled);
    const saved = await readRecord();
    assert.equal(saved.data.statutory_overrides.sss, null);
    assert.equal(saved.data.statutory_overrides.philhealth, 111.25);
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await scan('payroll-phone');
  await close();
  await api('POST', `/hr/payroll/${record.id}/mark-paid`, {});
  await open();
  await check('Paid payslips disable every deduction editor and have no save action', async () => {
    assert.equal(await page.locator('#pd-ded-save').count(), 0);
    assert.equal(await page.locator('[data-ded-override]:not(:disabled), [data-ded]:not(:disabled)').count(), 0);
  });
  await scan('payroll-paid-phone');
  await close();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await check('Data Forms show inline errors and retain a draft until required consent is checked', async () => {
    const form = await api('POST', '/form-definitions', { name: 'UX required fields', slug: 'ux_required_fields', number_prefix: 'UX', scope: 'inventory', fields: [{ key: 'title', label: 'Title', type: 'text', required: true }, { key: 'consent', label: 'Confirm details', type: 'checkbox', required: true }], actions: [] });
    await page.evaluate(id => App.navigate('form-records', { form_id: id }), form.id);
    await page.locator('#fr-new').click();
    await page.locator('[data-field=title]').fill('Keep this draft');
    await page.locator('.modal [data-confirm]').click();
    await page.locator('[data-validation-error]').waitFor();
    assert.equal(await page.locator('[data-field=title]').inputValue(), 'Keep this draft');
    assert.equal(await page.locator('[data-field=consent]').getAttribute('aria-invalid'), 'true');
    await scan('data-form-validation');
    await page.locator('[data-modal-error] button').click();
    assert(await page.locator('[data-field=consent]').evaluate(input => document.activeElement === input));
    await page.locator('[data-field=consent]').check();
    await page.locator('.modal [data-confirm]').click();
    await page.waitForSelector('.modal-overlay', { state: 'detached' });
    const rows = await api('GET', `/form-definitions/${form.id}/records`);
    assert.equal(rows[0].data.title, 'Keep this draft'); assert.equal(rows[0].data.consent, true);
  });
  await check('The forms hub retries a failed load without losing section and search filters', async () => {
    let fail = true;
    await page.route('**/api/form-definitions', route => { if (fail) { fail = false; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Temporary test outage' }) }); } return route.continue(); });
    await page.evaluate(() => App.navigate('form-records', { scope: 'inventory', q: 'UX required' }));
    await page.locator('#fr-index-retry').click();
    await page.locator('.form-card').waitFor();
    assert.equal(await page.locator('#fr-index-scope').inputValue(), 'inventory');
    assert.equal(await page.locator('#fr-index-search').inputValue(), 'UX required');
    await page.unroute('**/api/form-definitions');
  });
  await check('Form Builder error links reveal the field tab and preserve the form name', async () => {
    await page.evaluate(() => App.navigate('form-builder', { scope: 'hr' }));
    await page.locator('#fb-new-form').click();
    await page.locator('[data-f=name]').fill('Preserved form draft');
    await page.locator('[data-setup-tab=fields]').click();
    await page.locator('#fb-add-field').click();
    await page.locator('[data-k=key]').fill(''); await page.locator('[data-k=label]').fill('');
    await page.locator('[data-setup-tab=printing]').click();
    await page.locator('.modal [data-confirm]').click();
    await page.locator('[data-modal-error] button').first().click();
    assert.equal(await page.locator('[data-setup-tab=fields]').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('[data-f=name]').inputValue(), 'Preserved form draft');
    for (const width of [1440, 1024, 768, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const theme of ['light', 'dark']) {
        await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
        const box = await page.locator('.modal').boundingBox();
        assert(box && box.x >= 0 && box.x + box.width <= width + 1, 'Form editor stays within viewport');
        await scan(`form-builder-validation-${theme}-${width}`);
      }
    }
    await page.evaluate(() => document.documentElement.dataset.theme = 'light');
    page.once('dialog', dialog => dialog.accept()); await close();
  });
  await check('Personal views, schema history and archived corrections persist', async () => {
    const fields=Array.from({length:50},(_,i)=>({key:'detail_'+i,label:'Detailed information '+i+' — a long label that should wrap clearly without hiding the input',type:'text',required:false}));
    const definition={name:'Large lifecycle audit',slug:'ux_lifecycle',number_prefix:'UL',scope:'inventory',fields,actions:[]};
    const form=await api('POST','/form-definitions',definition);
    const entry=await api('POST','/form-records',{form_def_id:form.id,data:{detail_0:'Original detail'}});
    await page.evaluate(()=>App.navigate('form-records',{scope:'inventory'}));
    await page.locator(`[data-favorite="${form.id}"]`).click();
    await page.locator('#fr-index-view').selectOption('favorites');
    await page.locator(`.form-card[data-id="${form.id}"]`).click();
    await page.locator('#fr-columns').click();
    for(const input of await page.locator('[data-column]').all()) await input.uncheck();
    await page.locator('[data-column="detail_0"]').check();
    await page.locator('.modal [data-confirm]').click();
    await page.waitForSelector('.modal-overlay',{state:'detached'});
    assert.deepEqual((await api('GET','/data-forms/preferences')).views[form.id].columns,['detail_0']);
    await page.locator('#fr-save-filter').click();await page.locator('#fr-filter-name').fill('Review all entries');
    await page.locator('.modal [data-confirm]').click();await page.waitForSelector('.modal-overlay',{state:'detached'});
    assert.equal((await api('GET','/data-forms/preferences')).views[form.id].filters[0].name,'Review all entries');
    await api('PUT',`/form-definitions/${form.id}`,{...definition,fields:[...fields,{key:'new_field',label:'New version only',type:'text'}],expected_version:1,change_reason:'Expanded collection'});
    await api('PUT',`/form-definitions/${form.id}/archive`,{archived:true,reason:'Collection complete'});
    await page.evaluate(id=>App.navigate('form-records',{form_id:id}),form.id);
    await page.locator('#fr-new:disabled').waitFor();
    await page.locator(`[data-edit="${entry.id}"]`).click();
    assert.equal(await page.locator('[data-field="new_field"]').count(),0);
    for(const width of [1440,1024,768,390]) {
      await page.setViewportSize({width,height:1000});
      for(const theme of ['light','dark']) {
        await page.evaluate(value=>document.documentElement.dataset.theme=value,theme);
        const box=await page.locator('.modal').boundingBox();assert(box.x>=0&&box.x+box.width<=width+1);
        await scan(`large-record-${theme}-${width}`);
      }
    }
    await page.locator('[data-field="detail_0"]').fill('Corrected detail');
    await page.locator('#fr-change-reason').fill('Checked original source');
    await page.locator('#fr-change-reason').focus();await page.keyboard.press('Tab');
    assert(await page.locator('.modal').evaluate(el=>el.contains(document.activeElement)));
    await page.locator('.modal [data-confirm]').click();await page.waitForSelector('.modal-overlay',{state:'detached'});
    const revisions=await api('GET',`/form-records/${entry.id}/revisions`);
    assert.equal(revisions[0].reason,'Checked original source');assert.equal(revisions[1].data.detail_0,'Original detail');
    await page.locator(`[data-history="${entry.id}"]`).click();await scan('record-revision-history');await close();
    await page.evaluate(()=>App.navigate('form-builder',{scope:'inventory'}));
    await page.locator(`[data-versions="${form.id}"]`).click();await scan('form-schema-versions');await close();
    await api('PUT',`/form-definitions/${form.id}/archive`,{archived:false});
    await page.evaluate(id=>App.navigate('form-records',{form_id:id}),form.id);await page.locator('#fr-new:not(:disabled)').waitFor();
    await page.setViewportSize({width:720,height:500});await page.locator('#fr-new').click();
    await page.locator('.modal [data-confirm]').scrollIntoViewIfNeeded();
    assert(await page.locator('.modal [data-confirm]').isVisible());await scan('large-form-reflow-half-viewport');await close();
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await check('Mobile requests show every missing field and preserve corrected input', async () => {
    await page.goto(base + '/m/#/requests?type=overtime_request');
    await page.locator('.m-request-form').waitFor();
    await page.locator('.m-request-form button[type=submit]').click();
    await page.locator('[data-validation-summary]:not([hidden])').waitFor();
    assert(await page.locator('.m-request-form [aria-invalid=true]').count() > 1);
    const reason = page.locator('[data-k=reason]');
    await reason.fill('Keep this reason');
    assert.equal(await reason.getAttribute('aria-invalid'), null);
    await scan('mobile-request-validation', '#m-view');
    await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
    await scan('mobile-request-validation-dark', '#m-view');
    assert.equal(await reason.inputValue(), 'Keep this reason');
  });
  await check('Payroll managers can review and assign an ambiguous legacy payslip', async () => {
    const oldData = { ...(await readRecord()).data };
    delete oldData.employee_id;
    await api('POST', '/hr/employees', { employee_no: 'UX-PAY-TWIN', name: 'Payroll UX Employee', daily_rate: 1800 });
    const legacy = await api('POST', '/form-records', { form_def_id: generated.form_id, data: oldData, status: 'draft' });
    await page.goto(base);
    await page.waitForSelector('#app-screen:not(.hidden)');
    await page.evaluate(() => App.navigate('form-records', { slug: 'hr_payroll' }));
    await page.locator('#fr-reconcile-owner').click();
    await page.locator(`[data-reconcile="${legacy.id}"]`).click();
    const dialog = page.locator('.modal-overlay').last();
    await dialog.locator('summary').click();
    assert(await dialog.getByText('employee name').count() > 0);
    await scan('payroll-legacy-owner-review');
    await dialog.locator('#fr-legacy-employee').selectOption(String(employee.id));
    await dialog.locator('#fr-legacy-reason').fill('Matched employee number against the signed payroll register');
    await dialog.locator('[data-confirm]').click();
    await page.waitForFunction(() => document.querySelectorAll('.modal-overlay').length === 0);
    const corrected = await api('GET', `/form-records/${legacy.id}`);
    assert.equal(corrected.data.employee_id, employee.id);
    assert.equal(corrected.status, 'draft');
  });
} catch (error) { report.errors.push(error.stack || error.message); console.error(error); }
finally {
  clearTimeout(timer);
  if (browser) await browser.close();
  server.kill('SIGTERM');
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
  const failed = report.checks.filter(c => !c.passed).length;
  const violations = report.scans.reduce((sum, scan) => sum + scan.violations.length, 0);
  console.log(JSON.stringify({ checks: report.checks.length, failed, scans: report.scans.length, violations, errors: report.errors.length }));
  if (failed || violations || report.errors.length) process.exitCode = 1;
}
