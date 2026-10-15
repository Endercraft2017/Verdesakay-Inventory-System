// Actual-app payroll checks against the shared disposable browser-audit server.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'work/connected-forms-ux');
fs.mkdirSync(output, { recursive: true });
const report = { checks: [], scans: [], errors: [] };
const server = spawn(process.execPath, ['--import', 'tsx', 'scripts/browser/editor-ux-server.ts'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
server.stderr.on('data', data => fs.appendFileSync(path.join(output, 'server.log'), data));
let browser, page, base, token;
const timer = setTimeout(() => { server.kill(); process.exit(1); }, 360000);
async function api(method, route, body) {
  const response = await fetch(base + '/api' + route, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const value = await response.json();
  assert(response.ok, `${method} ${route}: ${response.status} ${JSON.stringify(value)}`);
  return value;
}
async function check(name, action) {
  try { await action(); report.checks.push({ name, passed: true }); console.log('PASS ' + name); }
  catch (error) { report.checks.push({ name, passed: false, error: error.message }); console.error('FAIL ' + name + ': ' + error.message);if(page)console.log('Modal error: '+await page.locator('[data-modal-error]').last().textContent().catch(()=>''));if(page)await page.screenshot({path:path.join(output,'failed-'+report.checks.length+'.png'),fullPage:true}); }
}
async function scan(name, selector = '.modal-overlay') {
  const result = await new AxeBuilder({ page }).include(selector).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  report.scans.push({ name, violations: result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => ({ target: n.target, summary: n.failureSummary })) })) });
  await page.screenshot({ path: path.join(output, name + '.png'), fullPage: true });
  console.log(`${name}: ${result.violations.length} violations`);if(result.violations.length)console.log(JSON.stringify(result.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))}))));
}
try {
  base = 'http://127.0.0.1:' + await new Promise((resolve, reject) => {
    let text = '';
    server.stdout.on('data', data => { text += data; const match = text.match(/EDITOR_UX_PORT=(\d+)/); if (match) resolve(match[1]); });
    server.on('exit', code => reject(new Error('Audit server exited: ' + code)));
  });
  token = (await api('POST', '/auth/login', { username: 'admin', password: 'admin123' })).token;

  const product=await api('POST','/inventory',{name:'Connected UX Product',sku:'CX-1',unit:'box',quantity:20,attributes:{sale_price:125.5}});
  const customer=await api('POST','/customers',{name:'Connected UX Customer'});
  const executablePath=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||['/usr/lib/chromium/chromium','/usr/bin/chromium'].find(fs.existsSync);
  browser=await chromium.launch({...(executablePath?{executablePath}:{}),headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1000},timezoneId:'Asia/Manila',reducedMotion:'reduce'});
  await context.addInitScript(value=>localStorage.setItem('vds_token',value),token);
  page=await context.newPage();page.on('pageerror',error=>report.errors.push(error.stack||error.message));
  await page.goto(base);await page.waitForSelector('#app-screen:not(.hidden)');
  const confirm=()=>page.locator('.modal-overlay').last().locator('[data-confirm]').click();
  const close=()=>page.locator('.modal-overlay').last().locator('.modal-foot [data-close]').click();
  let form,record;
  await check('Build connected customer, item rows, tax calculations and sales workflow through the UI',async()=>{
    await page.evaluate(()=>App.navigate('form-builder',{scope:'inventory'}));await page.locator('#fb-new-form').click();
    await page.locator('[data-f=name]').fill('Connected invoice UX');await page.locator('[data-setup-tab=fields]').click();
    const definitions=[['customer','Customer','reference:customer'],['items','Products','line_items'],['subtotal','Subtotal','calculated'],['tax_rate','Tax percentage','number'],['tax','Tax amount','calculated'],['total','Final total','calculated'],['prepared_by','Prepared by','system:user']];
    for(const [index,[key,label,type]]of definitions.entries()){
      await page.locator('#fb-add-field').click();const row=page.locator(`[data-fi="${index}"]`);
      await row.locator('[data-k=key]').fill(key);await row.locator('[data-k=label]').fill(label);await row.locator('[data-k=type]').selectOption(type);
      if(['customer','items'].includes(key))await row.locator('[data-k=required]').check();
      if(key==='tax_rate')await row.locator('[data-k=default]').fill('12');
      if(type==='calculated'){
        await row.locator('[data-configure-math]').click();
        await page.locator('#fc-operation').selectOption(key==='tax'?'percent':'sum');
        for(const operand of key==='subtotal'?['items.line_total']:key==='tax'?['subtotal','tax_rate']:['subtotal','tax'])await page.locator(`#fc-operands input[value="${operand}"]`).check();
        await confirm();await page.waitForSelector('#fc-operation',{state:'detached'});
      }
    }
    await scan('connected-fields-configuration');
    await page.locator('[data-setup-tab=automation]').click();await page.locator('#fb-add-action').click();
    await page.locator('[data-ak=type]').selectOption('create_sales_draft');await page.locator('[data-ak=tax_field]').selectOption('tax_rate');await page.locator('[data-ak=total_field]').selectOption('total');
    await scan('connected-builder');await confirm();await page.waitForSelector('.modal-overlay',{state:'detached'});
    form=(await api('GET','/form-definitions')).find(row=>row.slug==='connected_invoice_ux');assert(form);assert.equal(form.actions[0].run_on,'submitted');assert.equal(form.fields[2].calculation.operator,'sum');
  });
  await check('Lookup failure can retry without losing the current form and customer selection',async()=>{
    await page.evaluate(id=>App.navigate('form-records',{form_id:id}),form.id);await page.locator('#fr-new').click();
    await page.locator('[data-field=customer] option').filter({hasText:'Connected UX Customer'}).waitFor({state:'attached'});await page.locator('[data-field=customer]').selectOption(String(customer.id));
    let fail=true;await page.route('**/api/data-forms/sources/product?*',route=>{if(fail){fail=false;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Temporary product outage'})});}return route.continue();});
    await page.locator('[data-add-item]').click();await page.locator('[data-lookup-retry]:not([hidden])').click();
    await page.locator('[data-item-row] select option').filter({hasText:'Connected UX Product'}).waitFor({state:'attached'});
    assert.equal(await page.locator('[data-field=customer]').inputValue(),String(customer.id));await page.unroute('**/api/data-forms/sources/product?*');
    await page.locator('[data-item-row] select').selectOption(String(product.id));assert.equal(await page.locator('[data-item-price]').inputValue(),'125.5');
    await page.locator('[data-item-quantity]').fill('2');await page.locator('[data-item-price]').fill('99');
    await page.locator('[data-item-discount]').fill('10');await page.waitForFunction(()=>document.querySelector('[data-field=total]').value==='199.58');
    await page.locator('[data-item-discount]').fill('0');
    await page.waitForFunction(()=>document.querySelector('[data-field=total]').value==='221.76');
    await page.locator('[data-add-item]').click();assert.equal(await page.locator('[data-item-price]').first().inputValue(),'99');await page.locator('[data-remove-item]').last().click();assert.equal(await page.locator('[data-item-price]').inputValue(),'99');
    await scan('connected-record');
  });
  await check('Invalid quantities are blocked and corrections retain the rest of the draft',async()=>{
    await page.locator('[data-item-quantity]').fill('0');await confirm();
    await page.locator('[data-modal-error]').filter({hasText:'greater than zero'}).waitFor();
    assert.equal(await page.locator('[data-item-price]').inputValue(),'99');await page.locator('[data-item-quantity]').fill('2');
  });
  await check('Connected invoice editor remains usable across themes and widths',async()=>{
    for(const width of [1440,1024,768,390]){
      await page.setViewportSize({width,height:1000});
      for(const theme of ['light','dark']){
        await page.evaluate(value=>document.documentElement.dataset.theme=value,theme);const box=await page.locator('.modal').boundingBox();assert(box.x>=0&&box.x+box.width<=width+1);
        await scan(`connected-record-${theme}-${width}`);
      }
    }
    await page.locator('[data-item-price]').focus();await page.keyboard.press('Tab');assert(await page.locator('.modal').evaluate(el=>el.contains(document.activeElement)));
    await confirm();await page.waitForSelector('.modal-overlay',{state:'detached'});
    record=(await api('GET',`/form-definitions/${form.id}/records`))[0];assert.equal(record.data.total,221.76);assert.equal(record.status,'draft');assert.equal(record.sales_order_id,null);
  });
  await check('Reopening retains historical product data and agreed price after the product changes',async()=>{
    await api('PUT','/inventory/'+product.id,{name:'Renamed UX Product',unit:'piece',attributes:{sale_price:300}});
    await page.locator(`[data-edit="${record.id}"]`).click();assert.equal(await page.locator('[data-item-price]').inputValue(),'99');
    assert.equal(await page.locator('[data-item-row] [readonly]').first().inputValue(),'box');await close();await page.waitForSelector('.modal-overlay',{state:'detached'});
    const tpl=await api('GET','/templates/'+form.template_id);
    const printed=await page.evaluate(({body,data})=>renderTemplate(body,{...data,company:{name:'Example company'}}),{body:tpl.body,data:record.data});
    assert(printed.includes('Connected UX Product'));assert(printed.includes('221.76'));assert(!printed.includes('[object Object]'));
  });
  await check('A committed submission with a lost response retries the same request without a duplicate order',async()=>{
    await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>document.documentElement.dataset.theme='light');
    await page.locator('#fr-new').click();await page.locator('[data-field=customer] option').filter({hasText:'Connected UX Customer'}).waitFor({state:'attached'});
    await page.locator('[data-field=customer]').selectOption(String(customer.id));await page.locator('[data-add-item]').click();
    await page.locator('[data-item-row] select option').filter({hasText:'Renamed UX Product'}).waitFor({state:'attached'});await page.locator('[data-item-row] select').selectOption(String(product.id));await page.locator('#fr-record-status').selectOption('submitted');
    const before=(await api('GET',`/form-definitions/${form.id}/records`)).length;let lose=true;const keys=[];
    await page.route('**/api/form-records',async route=>{keys.push(route.request().headers()['idempotency-key']);const response=await route.fetch();if(lose){lose=false;await route.abort('failed');}else await route.fulfill({response});});
    await confirm();await page.locator('[data-modal-error]').filter({hasText:'Retry Save'}).waitFor();
    assert.equal((await api('GET',`/form-definitions/${form.id}/records`)).length,before+1);
    assert.equal(await page.locator('[data-item-price]').isDisabled(),true);await scan('connected-save-recovery');
    await confirm();await page.waitForSelector('.modal-overlay',{state:'detached'});await page.unroute('**/api/form-records');
    assert.equal(keys.length,2);assert.equal(keys[0],keys[1]);assert.equal((await api('GET',`/form-definitions/${form.id}/records`)).length,before+1);
  });
  await check('Submission creates one reviewable open sales order and preserves stock',async()=>{
    const before=await api('GET','/inventory/'+product.id);
    const saved=await api('GET','/form-records/'+record.id);await api('PUT','/form-records/'+record.id,{data:saved.data,status:'submitted',expected_revision:saved.revision});
    const submitted=await api('GET','/form-records/'+record.id),order=await api('GET','/orders/'+submitted.sales_order.order_id);
    assert.equal(order.status,'open');assert.equal(order.total,221.76);assert.equal(order.items[0].unit_price,99);assert.equal((await api('GET','/inventory/'+product.id)).quantity,before.quantity);
    await page.evaluate(id=>App.navigate('form-records',{form_id:id}),form.id);await page.locator(`[data-edit="${record.id}"]`).click();await page.locator('[data-open-linked-order]').waitFor();await scan('linked-sales-review');
    await page.locator('[data-open-linked-order]').click();await page.waitForFunction(()=>document.querySelector('.modal')?.textContent.includes('SO-'));
  });

  await check('Configure named property bindings, retain unsaved settings and retry a system lookup in place',async()=>{
    const aux=await api('POST','/form-definitions',{name:'Connected property audit',slug:'connected_property_audit',number_prefix:'CPA',scope:'inventory',fields:[{key:'product',label:'Product',type:'reference',source:'product',required:true},{key:'unit',label:'Product unit',type:'text'},{key:'amount',label:'Agreed price',type:'number',required:true},{key:'prepared_by',label:'Prepared by',type:'system',source:'user',property:'name'}]});
    await page.evaluate(()=>App.navigate('form-builder',{scope:'inventory'}));await page.locator(`[data-edit="${aux.id}"]`).click();await page.locator('[data-setup-tab=fields]').click();
    await page.locator('[data-connect="1"]').click();await page.locator('#fc-source').selectOption('product');await page.locator('#fc-property').selectOption('unit');await scan('connected-property-dialog');await confirm();await page.waitForSelector('#fc-source',{state:'detached'});
    let warned=false;page.once('dialog',async dialog=>{warned=true;await dialog.dismiss();});await close();assert(warned);assert.equal(await page.locator('.modal-overlay').count(),1);
    await page.locator('[data-connect="2"]').click();await page.locator('#fc-source').selectOption('product');await page.locator('#fc-property').selectOption('sale_price');assert(await page.locator('#fc-editable').isChecked());await confirm();await page.waitForSelector('#fc-source',{state:'detached'});await confirm();await page.waitForSelector('.modal-overlay',{state:'detached'});
    let failed=false;await page.route('**/api/data-forms/sources/user',route=>{if(!failed){failed=true;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Temporary user lookup outage'})});}return route.continue();});
    await page.evaluate(id=>App.navigate('form-records',{form_id:id}),aux.id);await page.locator('#fr-new').click();await page.locator('[data-field=product] option').filter({hasText:'Renamed UX Product'}).waitFor({state:'attached'});await page.locator('[data-field=product]').selectOption(String(product.id));
    assert.equal(await page.locator('[data-field=unit]').inputValue(),'piece');assert.equal(await page.locator('[data-field=unit]').getAttribute('readonly'),'');await page.locator('[data-field=amount]').fill('250');
    await page.locator('[data-system-retry]:not([hidden])').click();await page.waitForFunction(()=>document.querySelector('[data-field=prepared_by]').value.length>0);assert.equal(await page.locator('[data-field=amount]').inputValue(),'250');await scan('connected-system-recovery');
    await confirm();await page.waitForSelector('.modal-overlay',{state:'detached'});await page.unroute('**/api/data-forms/sources/user');
    const saved=(await api('GET',`/form-definitions/${aux.id}/records`))[0];assert.equal(saved.data.unit,'piece');assert.equal(saved.data.amount,250);
  });

  await check('The print editor offers connected properties and inserts a real repeating item table',async()=>{
    await page.evaluate(()=>App.navigate('form-builder',{scope:'inventory'}));await page.locator(`[data-tpl="${form.id}"]`).click();await page.locator(`[data-layout-edit="${form.template_id}"]`).click();await page.locator('.doc-surface').waitFor();
    await page.locator('[data-studio-tab=Data]').click();await page.locator('[data-variable-search]').fill('customer.address');await page.locator('[data-variable-insert="customer.address"]').waitFor();
    await scan('connected-print-variable-bank','.doc-fs');
    await page.locator('[data-variable-search]').fill('Repeating table');const before=await page.locator('.doc-surface table').count();
    await page.locator('[data-variable-insert="items"]').click();assert.equal(await page.locator('.doc-surface table').count(),before+1);
    const body=await page.evaluate(()=>serializeEditor(document.querySelector('.doc-surface')));assert(body.includes('{{#items}}'));assert(body.includes('{{/items}}'));
    const preview=await page.evaluate(({body,data})=>renderTemplate(body,{...data,fields:data,company:{name:'Example'}}),{body,data:record.data});assert(preview.includes('Connected UX Product'));assert(!preview.includes('[object Object]'));
    await scan('connected-repeating-table','.doc-fs');
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
