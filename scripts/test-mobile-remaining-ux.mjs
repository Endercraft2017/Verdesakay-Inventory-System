// Real-backend mobile QR acceptance audit. Uses generated print images as Chromium's
// virtual camera frames; never replaces the scanner or mocks stock API responses.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
const output = path.resolve('work/mobile-workflow-audit');
fs.mkdirSync(output, { recursive: true });
const profile = path.join(output, 'browser-profile');
fs.rmSync(profile, { recursive: true, force: true });
const requests = [];
const report = { backend: 'Disposable real Express/SQLite backend', camera: 'Real browser photo picker; QR scanner remains covered by test-mobile-qr-ux.mjs', viewport: '390x844', checks: [], errors: [], limits: ['Virtual camera, not physical paper/printer or phone optics.'] };
const server = spawn(process.execPath, ['--import', 'tsx', 'scripts/browser/editor-ux-server.ts'], { stdio: ['ignore', 'pipe', 'pipe'] });
server.stderr.on('data', d => fs.appendFileSync(path.join(output, 'server.log'), d));
let base, admin, browser, context, page;
const watchdog = setTimeout(() => { server.kill(); process.exit(1); }, 600000);
async function api(method, route, body, token = admin, expected) {
    const res = await fetch(base + '/api' + route, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) }, ...(body !== undefined ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}) });
    const value = await res.json();
    assert(expected ? res.status === expected : res.ok, `${method} ${route}: ${res.status} ${JSON.stringify(value)}`);
    return value;
}
async function check(name, fn) { await fn(); report.checks.push({ name, passed: true }); console.log('PASS ' + name); }
async function loginRole(role) { const username = 'audit_' + role; await api('POST', '/users', { username, full_name: role, password: 'test-secret123', role }); return (await api('POST', '/auth/login', { username, password: 'test-secret123' }, null)).token; }
async function launch(token, camera) {
    await context?.close();
    context = await chromium.launchPersistentContext(profile, { viewport: { width: 390, height: 844 }, permissions: ['camera'], timezoneId: 'Asia/Manila', serviceWorkers: 'block', ...((process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || ['/usr/bin/chromium', '/usr/lib/chromium/chromium'].find(fs.existsSync)) ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || ['/usr/bin/chromium', '/usr/lib/chromium/chromium'].find(fs.existsSync) } : {}), headless: true, args: camera ? ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-file-for-fake-video-capture=' + camera] : [] });
    browser = context.browser();
    await context.addInitScript(t => localStorage.setItem('vds_token', t), token);
    page = await context.newPage();
    for (const old of context.pages()) if (old !== page) await old.close();
    page.on('request', req => { if (req.method() === 'POST' && /\/api\/orders\/\d+\/(?:release|release-slip)$/.test(new URL(req.url()).pathname))
        requests.push({ url: req.url(), body: req.postData(), key: req.headers()['idempotency-key'] }); });
    page.on('pageerror', e => report.errors.push(e.message));
}
async function go(route) { await page.goto(base + '/m#/' + route); await page.locator('#m-view .rk-page, #m-view .m-jo-head, #m-view .m-choose').first().waitFor(); }
async function frame(src, file) {
    const luminance = await page.evaluate(async (src) => { const img = new Image(); img.src = src; await img.decode(); const c = document.createElement('canvas'); c.width = 640; c.height = 480; const x = c.getContext('2d'); x.fillStyle = 'white'; x.fillRect(0, 0, 640, 480); x.imageSmoothingEnabled = false; x.drawImage(img, 160, 80, 320, 320); const data = x.getImageData(0, 0, 640, 480).data; return Array.from({ length: 640 * 480 }, (_, i) => data[i * 4] > 128 ? 235 : 16); }, src);
    fs.writeFileSync(file, Buffer.concat([Buffer.from('YUV4MPEG2 W640 H480 F5:1 Ip A1:1 C420jpeg\nFRAME\n'), Buffer.from(luminance), Buffer.alloc(640 * 480 / 2, 128)]));
}
async function printLabel(kind, id, token) {
    await launch(token);
    await go('record?' + kind + '=' + id);
    const popupPromise = page.waitForEvent('popup');
    await page.getByRole('button', { name: 'Print label', exact: true }).click();
    const popup = await popupPromise;
    await popup.locator('img.lbl-qr').waitFor();
    const src = await popup.locator('img.lbl-qr').getAttribute('src');
    assert(src?.startsWith('data:image/'));
    const code = await page.evaluate(async (src) => (await new ZXing.BrowserMultiFormatReader().decodeFromImageUrl(src)).getText(), src);
    assert.equal(code, 'VDS:' + kind.toUpperCase() + ':' + id);
    await popup.pdf({ path: path.join(output, kind + '-label.pdf'), width: '64mm', height: '44mm', printBackground: true });
    const video = path.join(output, kind + '.y4m');
    await frame(src, video);
    await popup.close();
    return video;
}
async function cameraVerify(selector) { await page.locator('[data-verify-label]').click(); await page.locator('.m-scan video').waitFor(); assert.equal(await page.locator('.m-scan-manual').count(), 0); await page.locator(selector).waitFor({ state: 'visible' }); await page.waitForFunction(sel => !document.querySelector(sel)?.disabled, selector, { timeout: 20000 }); assert.equal(await page.locator('.m-scan').count(), 0); }
async function product(name, qty, qc, existingId) {
    const p = existingId ? { id: existingId } : await api('POST', '/inventory', { name, sku: name, quantity: 0 });
    const part = await api('POST', '/inventory', { name: name + ' component', quantity: 100, unit_cost: 3 });
    await api('PUT', '/finished-products/' + p.id, { components: [{ component_item_id: part.id, quantity: 1 }] });
    const jo = await api('POST', '/job-orders', { product_item_id: p.id, qty_ordered: qty, qc_stages: qc });
    await api('POST', `/job-orders/${jo.id}/approve`);
    await api('POST', '/job-orders/warehouse-accept', { job_order_ids: [jo.id] });
    await api('POST', '/job-orders/prepare', { job_orders: [{ id: jo.id }] });
    await api('POST', `/job-orders/${jo.id}/release`);
    await api('POST', `/job-orders/${jo.id}/accept`, {});
    return { id: p.id, jo: jo.id };
}
async function order(p, qty) { const so = await api('POST', '/orders', { type: 'sale', status: 'approved', customer_name: 'QR recipient', items: [{ item_id: p.id, name: 'Audit product', quantity: qty, unit_price: 20 }] }); const auth = await api('POST', `/release-slips/orders/${so.id}/authorizations`, { mode: 'pickup', recipient_name: 'QR recipient' }); return { id: so.id, auth: auth.token, productId: p.id, quantity: qty }; }

async function photo(){const chooser=page.waitForEvent('filechooser');await page.locator('.m-thumb-add').click();await(await chooser).setFiles({name:'evidence.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6gAAAAABJRU5ErkJggg==','base64')});await page.locator('.m-photo-picker img').waitFor();}
async function pick(name){await page.locator('.m-picker input[type=search]').fill(name);await page.locator('.m-picker-item').filter({hasText:name}).first().click();}
try{
 base='http://127.0.0.1:'+await new Promise((resolve,reject)=>{let out='';server.stdout.on('data',d=>{out+=d;const m=out.match(/EDITOR_UX_PORT=(\d+)/);if(m)resolve(m[1]);});server.on('exit',c=>reject(Error('Server exit '+c)));});
 admin=(await api('POST','/auth/login',{username:'admin',password:'admin123'},null)).token;
 const loc=(await api('GET','/locations')).find(l=>l.is_default).id;
 await api('PUT','/release-slips/policy',{authorization_required:false});
 await launch(admin);
 await check('Allocation correction recovers a lost response without touching stock or customer demand',async()=>{
  const p=await api('POST','/inventory',{name:'Correction product',quantity:5});const sale=await api('POST','/orders',{type:'sale',status:'approved',items:[{item_id:p.id,name:'Correction product',quantity:5,unit_price:20}]});await api('POST','/orders/'+sale.id+'/accept-release');await api('POST','/orders/'+sale.id+'/release',{bulk:[{item_id:p.id,quantity:3}]});
  await go('so?id='+sale.id+'&step=correct');await page.locator('[data-undo-line]').fill('2');await page.locator('#undo-reviewed').check();
  const correctionPath='**/api/orders/'+sale.id+'/release/unreserve';let attempts=[];await page.route(correctionPath,async route=>{attempts.push({key:route.request().headers()['idempotency-key'],body:route.request().postData()});await route.fetch();await route.abort('connectionreset');});await page.locator('#undo-save').click();await page.locator('#rel-retry').waitFor();
  assert.equal((await api('GET','/orders/'+sale.id)).items[0].released_qty,1);await launch(admin);page.on('request',r=>{if(r.url().endsWith('/release/unreserve'))attempts.push({key:r.headers()['idempotency-key'],body:r.postData()});});await go('so?id='+sale.id);await page.locator('#rel-retry').click();await page.locator('#rel-review-current').waitFor();assert.equal(attempts[0].key,attempts[1].key);assert.equal(attempts[0].body,attempts[1].body);const item=await api('GET','/inventory/'+p.id);assert.equal(item.quantity,5);assert.equal(item.available_quantity,0);await page.screenshot({path:path.join(output,'allocation-correction.png'),fullPage:true});
 });
 let returned,slip,returnItem;
 await check('Return receipt keeps photos across restart and adds no stock until separate inspection',async()=>{
  const p=await api('POST','/inventory',{name:'Returned product',quantity:1});returnItem=p.id;const so=await api('POST','/orders',{type:'sale',status:'approved',items:[{item_id:p.id,name:p.name||'Returned product',quantity:1,unit_price:20}]});await api('POST','/orders/'+so.id+'/accept-release');await api('POST','/orders/'+so.id+'/release',{bulk:[{item_id:p.id,quantity:1}]});slip=(await api('POST','/orders/'+so.id+'/release-slip',{collected_by:'Customer'})).id;
  await page.goto(base+'/m#/returns?slip='+slip);await page.locator('[data-note]').fill('Customer reported damage');await photo();await page.locator('[data-note]').dispatchEvent('change');await page.getByRole('heading',{name:'Receive customer return'}).waitFor();const url=page.url();await launch(admin);await page.goto(url);await page.locator('.m-photo-picker img').waitFor();assert.equal(await page.locator('[data-note]').inputValue(),'Customer reported damage');
  await page.route('**/api/sales-returns',async route=>{if(route.request().method()==='POST'){await route.fetch();await route.abort('connectionreset');}else await route.continue();});await page.locator('#ret-save').click();await page.locator('#wf-retry').waitFor();assert.equal((await api('GET','/inventory/'+p.id)).quantity,0);const rows=await api('GET','/sales-returns');assert.equal(rows.length,1);returned=rows[0].id;
  await launch(admin);await page.goto(base+'/m#/returns');await page.locator('#wf-retry').click();await page.locator('#wf-review').waitFor();await page.locator('#wf-review').click();await page.waitForURL(u=>u.hash.includes('id='+returned));await page.locator('select[data-decision]').waitFor();assert.equal((await api('GET','/sales-returns')).length,1);await page.screenshot({path:path.join(output,'return-inspection.png'),fullPage:true});
  await page.locator('[data-note]').fill('Inspected and suitable for restock');await page.locator('#ret-decide').click();await page.locator('#wf-review').waitFor();assert.equal((await api('GET','/inventory/'+p.id)).quantity,1);await page.locator('#wf-review').click();await page.waitForURL(u=>u.hash.includes('id='+returned));assert.equal((await api('GET','/sales-returns/'+returned)).status,'restocked');
 });
 await check('Semi-built intake creates one pending finishing unit and suppresses duplicate production entry',async()=>{
  const p=await api('POST','/inventory',{name:'Finishing product'});const part=await api('POST','/inventory',{name:'Finish BOM part',quantity:1});await api('PUT','/finished-products/'+p.id,{components:[{component_item_id:part.id,quantity:1}]});await api('POST','/inventory/'+p.id+'/adjust',{change:1,location_id:loc,build_mode:'semi_built',reason:'Existing complete package'});
  await page.goto(base+'/m#/semi-finishing');await page.locator('[data-product-choice]').selectOption(String(p.id));await page.locator('[data-source-choice]').selectOption('bulk');await page.locator('[data-identifier]').fill('FINISH-ONE');await page.locator('[data-complete]').check();await photo();
  await page.route('**/api/job-orders/convert-semi',async route=>{await route.fetch();await route.abort('connectionreset');});await page.locator('#semi-submit').click();await page.locator('#wf-retry').waitFor();await launch(admin);await page.goto(base+'/m#/semi-finishing');await page.locator('#wf-retry').click();await page.locator('#wf-review').waitFor();const jobs=(await api('GET','/job-orders')).filter(j=>j.product_item_id===p.id);assert.equal(jobs.length,1);const units=await api('GET','/job-orders/'+jobs[0].id+'/units');assert.equal(units.length,1);assert.equal(units[0].status,'pending');assert.equal((await api('GET','/inventory/'+p.id)).quantity,0);await page.locator('#wf-review').click();await page.waitForURL(u=>u.hash.includes('id='+jobs[0].id));await page.getByText('Finishing conversion:',{exact:false}).waitFor();assert.equal(await page.locator('#jo-record').count(),0);await page.screenshot({path:path.join(output,'finishing-job.png'),fullPage:true});
 });
 await check('Semi-built transfer preserves variant balances and full location paths',async()=>{
  const branch=await api('POST','/locations',{name:'Branch warehouse',type:'warehouse'}),shelf=await api('POST','/locations',{name:'Shelf A',type:'warehouse',parent_id:branch.id});const p=await api('POST','/inventory',{name:'Variant transfer product',quantity:2});await api('POST','/inventory/'+p.id+'/adjust',{change:3,location_id:loc,build_mode:'semi_built',reason:'Semi packages'});
  await page.goto(base+'/m#/transfer');await pick('Variant transfer product');await page.locator('[data-build]').selectOption('semi_built');await page.locator('[data-to] select').selectOption(String(shelf.id));await page.locator('[data-qty]').fill('2');assert.match(await page.locator('[data-to] select option:checked').innerText(),/Branch warehouse \/ Shelf A/);await page.locator('#m-view button[type=submit]').click();await page.locator('#wf-review').waitFor();const rows=await api('GET','/inventory/'+p.id+'/stock');assert.equal(rows.find(r=>r.location_id===loc).assembled_quantity,2);assert.equal(rows.find(r=>r.location_id===loc).semi_built_quantity,1);assert.equal(rows.find(r=>r.location_id===shelf.id).semi_built_quantity,2);await page.screenshot({path:path.join(output,'variant-transfer.png'),fullPage:true});
 });
 await check('Whole-job issue reports preserve photos and allow explicit resolution',async()=>{
  const p=await product('Whole job issues',1,1);await page.goto(base+'/m#/unit-issues?job='+p.jo);await page.locator('#ui-new').click();await page.locator('[data-area]').fill('Kit quantity');await page.locator('[data-description]').fill('Missing a supplied component');await photo();await page.locator('#ui-send').click();await page.locator('#ui-back').waitFor();await page.locator('#ui-back').click();await page.locator('[data-reports] [data-id]').waitFor();await page.locator('[data-reports] [data-id]').first().click();await page.locator('#ui-resolve').click();await page.locator('[data-resolution]').fill('Warehouse corrected the package');await page.locator('#ui-confirm-action').click();await page.locator('#ui-back').waitFor();const rows=await api('GET','/production-issues?job_order_id='+p.jo+'&whole_job=1');assert.equal(rows.length,1);assert.equal(rows[0].status,'resolved');assert.equal(rows[0].unit_id,null);assert.equal(rows[0].photo_count,1);
 });

 await check('Ordinary QC confirmation recovers a committed response loss after restart',async()=>{
  const p=await product('QC durable decision',1,1),fd=new FormData();fd.append('identifier','QC-RETRY-UNIT');fd.append('image',new Blob(['unit-proof'],{type:'image/png'}),'proof.png');const unit=await api('POST','/job-orders/'+p.jo+'/units',fd);
  await page.goto(base+'/m#/qc?unit='+unit.id+'&role=qc&step=pass');await page.locator('#qc-identity').check();await page.locator('#qc-start').click();await page.locator('[data-d=pass]').click();await page.locator('#qc-confirm').waitFor();let requests=[];
  await page.route('**/api/job-orders/'+p.jo+'/units/inspect',async route=>{requests.push({key:route.request().headers()['idempotency-key'],body:route.request().postData()});await route.fetch();await route.abort('connectionreset');});await page.locator('#qc-confirm').click();await page.locator('#wf-retry').waitFor();await launch(admin);page.on('request',r=>{if(r.url().endsWith('/units/inspect'))requests.push({key:r.headers()['idempotency-key'],body:r.postData()});});await page.goto(base+'/m#/qc?role=qc');await page.locator('#wf-retry').click();await page.locator('#wf-review').waitFor();assert.equal(requests[0].key,requests[1].key);assert.equal(requests[0].body,requests[1].body);const units=await api('GET','/job-orders/'+p.jo+'/units');assert.equal(units[0].status,'passed');await page.screenshot({path:path.join(output,'qc-durable-confirmation.png'),fullPage:true});
 });

 await check('Inspector return repair screen works without warehouse locations or customer data',async()=>{
  const p=await product('Inspector return repair',1,1),fd=new FormData();fd.append('identifier','RETURN-REPAIR');fd.append('image',new Blob(['unit-proof'],{type:'image/png'}),'unit.png');const u=await api('POST','/job-orders/'+p.jo+'/units',fd);await api('POST','/job-orders/'+p.jo+'/units/inspect',{unit_ids:[u.id],result:'pass'});await api('POST','/job-orders/'+p.jo+'/products-in',{location_id:loc,unit_ids:[u.id]});
  const so=await api('POST','/orders',{type:'sale',status:'approved',customer_name:'Private buyer',items:[{item_id:p.id,name:'Return serial',quantity:1,unit_price:99}]});await api('POST','/orders/'+so.id+'/accept-release');await api('POST','/orders/'+so.id+'/release',{unit_ids:[u.id]});const sl=await api('POST','/orders/'+so.id+'/release-slip',{collected_by:'Buyer'});const sc=await api('GET','/sales-returns/slips/'+sl.id+'/context');const proof=new FormData();proof.append('kind','sales_return_proof');proof.append('ref_id',String(sl.id));proof.append('image',new Blob(['proof'],{type:'image/png'}),'proof.png');const att=await api('POST','/attachments',proof);const ret=await api('POST','/sales-returns',{slip_id:sl.id,slip_item_id:sc.lines[0].id,unit_id:u.id,quantity:1,reason:'Repair needed after return',evidence_ids:[att.id]});await api('POST','/sales-returns/'+ret.id+'/inspect',{decision:'reject',condition_note:'Requires a physical repair'});await api('POST','/sales-returns/'+ret.id+'/disposition',{decision:'repair',note:'Repair before warehouse reinspection'});
  const inspector=await loginRole('qc_inspector');await launch(inspector);await page.goto(base+'/m#/returns?id='+ret.id);await page.locator('#ret-decide').waitFor();assert.equal(await page.locator('[data-location] select').count(),0);assert(!/Private buyer/.test(await page.locator('#m-view').innerText()));await page.getByRole('button',{name:'Request repair parts',exact:true}).waitFor();await page.locator('[data-note]').fill('Repair work completed and checked');await page.locator('#ret-decide').click();await page.locator('#wf-review').waitFor();assert.equal((await api('GET','/sales-returns/'+ret.id)).disposition_state,'awaiting_inspection');assert.equal((await api('GET','/inventory/'+p.id)).quantity,0);await page.screenshot({path:path.join(output,'inspector-return-repair.png'),fullPage:true});
 });
 await check('Direct unit sale recovers once and is mandatory on the next trip slip',async()=>{
  await launch(admin);const p=await product('Direct mobile unit',1,1),fd=new FormData();fd.append('identifier','DIRECT-MOBILE-ONE');fd.append('image',new Blob(['proof'],{type:'image/png'}),'unit.png');const u=await api('POST','/job-orders/'+p.jo+'/units',fd);await api('POST','/job-orders/'+p.jo+'/units/inspect',{unit_ids:[u.id],result:'pass'});await api('POST','/job-orders/'+p.jo+'/products-in',{location_id:loc,unit_ids:[u.id]});
  const so=await order(p,1);await api('POST','/orders/'+so.id+'/accept-release');const line=(await api('GET','/orders/'+so.id)).items[0];
  await page.goto(base+'/m#/allocate?id='+p.id);await page.locator('[data-order]').selectOption(String(so.id));await page.locator('[data-line]').selectOption(String(line.id));await page.locator('[data-unit="'+u.id+'"]').check();let posts=[];
  await page.route('**/api/finished-products/'+p.id+'/units/allocate',async route=>{posts.push({key:route.request().headers()['idempotency-key'],body:route.request().postData()});await route.fetch();await route.abort('connectionreset');});await page.locator('#direct-submit').click();await page.locator('#wf-retry').waitFor();assert.equal((await api('GET','/inventory/'+p.id)).quantity,0);
  await launch(admin);page.on('request',r=>{if(r.url().endsWith('/units/allocate'))posts.push({key:r.headers()['idempotency-key'],body:r.postData()});});await page.goto(base+'/m#/allocate');await page.locator('#wf-retry').click();await page.locator('#wf-review').waitFor();assert.deepEqual(posts[0],posts[1]);await page.getByText('Stock removed; awaiting trip slip',{exact:true}).first().waitFor();await page.locator('#wf-review').click();await page.locator('[data-load-unit="'+u.id+'"]').waitFor();assert(await page.locator('[data-load-unit="'+u.id+'"]').isChecked());assert(await page.locator('[data-load-unit="'+u.id+'"]').isDisabled());await page.screenshot({path:path.join(output,'direct-unit-trip.png'),fullPage:true});
  const slip=await api('POST','/orders/'+so.id+'/release-slip',{collected_by:'Buyer',authorization_token:so.auth,lines:[{order_item_id:line.id,quantity:1,unit_ids:[u.id]}]});assert(slip.id);assert.equal((await api('GET','/inventory/'+p.id)).quantity,0);
 });
 await check('Unsent return draft restores the exact selected serial after restart',async()=>{
  const p=await product('Return serial selection',2,1),ids=[];for(let i=0;i<2;i++){const fd=new FormData();fd.append('identifier','RETURN-CHOICE-'+i);fd.append('image',new Blob(['proof'],{type:'image/png'}),'unit.png');ids.push((await api('POST','/job-orders/'+p.jo+'/units',fd)).id);}await api('POST','/job-orders/'+p.jo+'/units/inspect',{unit_ids:ids,result:'pass'});await api('POST','/job-orders/'+p.jo+'/products-in',{location_id:loc,unit_ids:ids});const so=await order(p,2);await api('POST','/orders/'+so.id+'/accept-release');await api('POST','/orders/'+so.id+'/release',{unit_ids:ids});const sl=await api('POST','/orders/'+so.id+'/release-slip',{collected_by:'Buyer',authorization_token:so.auth});await page.goto(base+'/m#/returns?slip='+sl.id);await page.locator('[data-unit]').selectOption(String(ids[1]));await page.waitForFunction(async id=>(await mWorkflow.load('returns'))?.batch.unit===id,ids[1]);await launch(admin);await page.goto(base+'/m#/returns?slip='+sl.id);await page.locator('[data-unit]').waitFor();assert.equal(await page.locator('[data-unit]').inputValue(),String(ids[1]));
 });
 await check('Manager finishing and basic employee tools respect the mobile permission gates',async()=>{
  const manager=await loginRole('production_manager');await launch(manager);await page.goto(base+'/m#/semi-finishing');await page.locator('[data-product-choice]').waitFor();assert.equal(await page.getByText('Finishing intake permission is required.',{exact:true}).count(),0);
  await api('POST','/roles',{key:'workflow_basic',label:'Basic employee',permissions:['mobile.access','messages.view','messages.send']});const basic=await loginRole('workflow_basic');await launch(basic);for(const route of ['returns','semi-finishing','stock-move','transfer']){await page.goto(base+'/m#/'+route);await page.locator('[data-no-permission]').waitFor();}
 });
 assert.deepEqual(report.errors,[]);
}catch(e){report.checks.push({name:'Acceptance run',passed:false,error:e.stack});console.error(e);try{await page?.screenshot({path:path.join(output,'failure.png'),fullPage:true});console.error(await page?.locator('#m-view').innerText());}catch{}process.exitCode=1;}
finally{clearTimeout(watchdog);fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));await context?.close();server.kill('SIGTERM');}
