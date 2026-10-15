// Real-backend mobile QR acceptance audit. Uses generated print images as Chromium's
// virtual camera frames; never replaces the scanner or mocks stock API responses.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
const output = path.resolve('work/mobile-qr-audit');
fs.mkdirSync(output, { recursive: true });
const profile = path.join(output, 'browser-profile');
fs.rmSync(profile, { recursive: true, force: true });
const requests = [];
const report = { backend: 'Disposable real Express/SQLite backend', camera: 'Chromium virtual-camera Y4M frames generated from actual printed QR images; scanner callbacks unchanged', viewport: '390x844', checks: [], errors: [], limits: ['Virtual camera, not physical paper/printer or phone optics.'] };
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
async function captureToReview(so) {
    await go('so?id=' + so.id + '&step=handoff');
    await page.locator('[data-token]').fill(so.auth);
    await page.locator('[data-verify]').click();
    await page.getByText(' · Valid', { exact: false }).first().waitFor();
    await page.locator('#rel-go').click();
    const chooser = page.waitForEvent('filechooser');
    await page.locator('[data-cap]').click();
    await (await chooser).setFiles({ name: 'handoff.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6gAAAAABJRU5ErkJggg==', 'base64') });
    await page.locator('[data-thumbs] img').waitFor();
    const canvas = page.locator('[data-sign] canvas');
    await canvas.scrollIntoViewIfNeeded();
    const box = await canvas.boundingBox();
    assert(box);
    await page.mouse.move(box.x + 20, box.y + 20);
    await page.mouse.down();
    await page.mouse.move(box.x + 90, box.y + 45, { steps: 10 });
    await page.mouse.up();
    await page.locator('#rel-go').click();
    await page.locator('#m-view[data-figma-node="78:317"]').waitFor();
}
async function warehouseOut(so) {
    await page.locator('#rel-review-current').click();
    await page.locator('#rel-go').click();
    await captureToReview(so);
    await check('Handoff photos and signature survive a browser restart', async () => {
        const url = page.url(), token = await page.evaluate(() => localStorage.getItem('vds_token'));
        await launch(token);
        await page.goto(url);
        await page.locator('#rel-go').waitFor();
        assert.match(await page.locator('#m-view').innerText(), /1 photo and acknowledgement attached/);
        await page.locator('#rel-go').click();
        await page.locator('#rel-post').waitFor();
        assert.equal((await api('GET', '/inventory/' + so.productId)).quantity, so.quantity);
    });
    const attempts = [], uploadAttempts = [];
    const finalPath = '**/api/orders/' + so.id + '/release-slip';
    let loseFinal = true, loseUpload = true;
    await page.route('**/api/attachments', async route => {
        if (route.request().method() !== 'POST') return route.continue();
        uploadAttempts.push(route.request().headers()['idempotency-key']);
        if (loseUpload) { loseUpload = false; await route.fetch(); await route.abort('connectionreset'); }
        else await route.continue();
    });
    await page.route(finalPath, async route => {
        attempts.push({ body: route.request().postData(), key: route.request().headers()['idempotency-key'] });
        if (loseFinal) { loseFinal = false; await route.fetch(); await route.abort('connectionreset'); }
        else await route.continue();
    });
    await page.locator('#rel-ok').check();
    await page.locator('#rel-post').click();
    await page.locator('#handoff-retry').waitFor();
    await check('Committed attachment with lost response retries the original upload key', async () => {
        assert.equal((await api('GET', '/inventory/' + so.productId)).quantity, so.quantity);
        const staged = await api('GET', '/attachments?kind=release_proof&ref_id=' + so.id);
        assert.equal(staged.length, 1);
        await page.locator('#handoff-retry').click();
        await page.waitForFunction(() => document.querySelector('#handoff-retry') && !document.querySelector('#handoff-retry').disabled);
        assert.equal(uploadAttempts[0], uploadAttempts[1]);
    });
    await check('Committed warehouse-out with lost response recovers after browser restart', async () => {
        const c = await api('GET', `/release-slips/orders/${so.id}/context`, undefined, admin);
        assert(c.slip);
        assert.equal((await api('GET', '/inventory/' + so.productId)).quantity, 0);
        const token = await page.evaluate(() => localStorage.getItem('vds_token'));
        const url = page.url();
        await launch(token);
        await page.goto(url);
        await page.locator('#handoff-retry').click();
        await page.locator('#handoff-review').waitFor();
        const after = await api('GET', `/release-slips/orders/${so.id}/context`, undefined, admin);
        assert.equal(after.slip.id, c.slip.id);
        const finalRequests = requests.filter(r => new URL(r.url).pathname.endsWith('/orders/' + so.id + '/release-slip'));
        assert.equal(finalRequests.length, 2); assert.equal(finalRequests[0].key, finalRequests[1].key); assert.equal(finalRequests[0].body, finalRequests[1].body);
        assert.equal((await api('GET', '/inventory/' + so.productId)).quantity, 0);
    });
    const c = await api('GET', `/release-slips/orders/${so.id}/context`, undefined, admin);
    const photos = await api('GET', '/attachments?kind=release&ref_id=' + c.slip.id);
    assert(photos.some(p => p.caption === 'Handoff proof'));
    assert(photos.some(p => p.caption === 'Recipient acknowledgement'));
    await page.screenshot({ path: path.join(output, 'warehouse-out-' + so.id + '.png'), fullPage: true });
}
try {
    base = 'http://127.0.0.1:' + await new Promise((resolve, reject) => { let text = ''; server.stdout.on('data', d => { text += d; const m = text.match(/EDITOR_UX_PORT=(\d+)/); if (m)
        resolve(m[1]); }); server.on('exit', c => reject(Error('server exit ' + c))); });
    admin = (await api('POST', '/auth/login', { username: 'admin', password: 'admin123' }, null)).token;
    const rts = await loginRole('receiving_clerk'), release = await loginRole('releasing_clerk');
    const batchProduct = await product('AUDIT-BATCH', 5, 0);
    await api('POST', `/job-orders/${batchProduct.jo}/progress`, { done_delta: 5 });
    const rec = await api('GET', `/job-orders/${batchProduct.jo}/receivable`);
    const batch = rec.batches[0];
    const unitProduct = await product('AUDIT-UNIT', 1, 1, batchProduct.id);
    const fd = new FormData();
    fd.append('identifier', 'AUDIT-SERIAL');
    fd.append('image', new Blob([Buffer.from('unit-photo')], { type: 'image/png' }), 'unit.png');
    const unit = await api('POST', `/job-orders/${unitProduct.jo}/units`, fd);
    await api('POST', `/job-orders/${unitProduct.jo}/units/inspect`, { unit_ids: [unit.id], result: 'pass' });
    let batchVideo, unitVideo;
    await check('Real print sheets produce decodable immutable batch and unit QR PDFs', async () => { batchVideo = await printLabel('batch', batch.id, rts); unitVideo = await printLabel('unit', unit.id, rts); assert.equal((await api('GET', '/inventory/' + batchProduct.id)).quantity, 0); assert.equal((await api('GET', '/inventory/' + unitProduct.id)).quantity, 0); });
    await check('Wrong virtual-camera sticker cannot confirm selected stock', async () => { await launch(rts, unitVideo); await go('receiving?batch=' + batch.id); await page.locator('#rts-ok').check(); await page.locator('[data-verify-label]').click(); await page.getByText('Wrong or ambiguous label.', { exact: false }).first().waitFor({ timeout: 20000 }); assert(await page.locator('#rts-post').isDisabled()); assert.equal((await api('GET', '/inventory/' + batchProduct.id)).quantity, 0); });
    for (const item of [{ kind: 'batch', id: batch.id, p: batchProduct, video: batchVideo, qty: 2 }, { kind: 'unit', id: unit.id, p: unitProduct, video: unitVideo, qty: 1 }]) {
        await check('Camera-decoded ' + item.kind + ' QR receives only selected RTS stock', async () => { await launch(rts, item.video); await go(item.kind === 'batch' ? 'receiving?batch=' + item.id : 'receiving?unit=' + item.id + '&step=confirm'); if (item.kind === 'batch')
            await page.locator('.rk-stepper input').fill(String(item.qty)); await page.locator('#rts-ok').check(); assert(await page.locator('#rts-post').isDisabled()); await cameraVerify('#rts-post'); await page.locator('#rts-post').click(); await page.locator('#rts-next').waitFor(); assert.equal((await api('GET', '/inventory/' + item.p.id)).quantity, item.qty); });
        const so = await order(item.p, item.qty);
        await check('Camera-decoded ' + item.kind + ' allocates exact stock to sales without stock-out', async () => {
            await launch(release, item.video);
            await go('so?id=' + so.id);
            await page.locator('#rel-go').click();
            await page.locator('#rel-review-current').click();
            await page.locator('#rel-go').click();
            await go('so?id=' + so.id + '&step=unit&code=' + encodeURIComponent('VDS:' + item.kind.toUpperCase() + ':' + item.id));
            const confirm = item.kind === 'batch' ? '#rel-label-ok' : '#rel-ok';
            await cameraVerify(confirm);
            if (item.kind === 'batch')
                await page.route('**/api/orders/' + so.id + '/release', async (route) => { await route.fetch(); await route.abort('connectionreset'); });
            await page.locator(confirm).click();
            if (item.kind === 'batch') {
                await page.locator('#rel-retry').waitFor();
                await launch(release, item.video);
                await go('so?id=' + so.id);
                await page.locator('#rel-retry').click();
            }
            await page.locator('#rel-review-current').waitFor();
            const c = await api('GET', `/release-slips/orders/${so.id}/context`, undefined, release);
            if (item.kind === 'batch') {
                assert.equal(c.batch_allocations.length, 1);
                assert.equal(c.batch_allocations[0].batch_id, item.id);
                assert.equal(c.batch_allocations[0].quantity, item.qty);
                const attempts = requests.filter(r => r.url.endsWith('/orders/' + so.id + '/release'));
                assert.equal(attempts.length, 2);
                assert.deepEqual(attempts[0], attempts[1]);
            }
            else
                assert.equal(c.units[0].id, item.id);
            assert.equal((await api('GET', '/inventory/' + item.p.id)).quantity, item.qty);
        });
        await check('Mobile browser ' + item.kind + ' proof, signature and warehouse-out consume stock once', async () => { await warehouseOut(so); assert.equal((await api('GET', '/inventory/' + item.p.id)).quantity, 0); const c = await api('GET', `/release-slips/orders/${so.id}/context`, undefined, release); assert(c.slip); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); });
    }
    await check('QR lookup shows current same-product stock and exact sold unit without writes', async () => {
        await api('POST', `/job-orders/${batchProduct.jo}/products-in`, { location_id: rec.output_location_id, batch_id: batch.id, quantity: 1 });
        await launch(rts, unitVideo);
        await go('scan');
        await page.locator('[data-record]').waitFor({ timeout: 20000 });
        assert((await page.locator('#m-view').innerText()).includes('On hand: 1'));
        assert.equal(await page.locator('[data-in], [data-out]').count(), 0);
        await page.locator('[data-record]').click();
        await page.locator('.m-jo-head').waitFor();
        assert((await page.locator('#m-view').innerText()).includes('sold'));
        assert.equal((await api('GET', '/inventory/' + batchProduct.id)).quantity, 1);
    });
    await check('Narrow roles cannot execute the other clerk’s stock transition', async () => {
        await api('POST', `/job-orders/${batchProduct.jo}/products-in`, { location_id: rec.output_location_id, batch_id: batch.id, quantity: 1 }, release, 403);
        await api('POST', '/orders/1/release', { bulk: [{ item_id: batchProduct.id, batch_id: batch.id, quantity: 1 }] }, rts, 403);
    });
    await check('Unavailable camera blocks confirmation and exposes no manual verification', async () => {
        await launch(rts);
        await go('receiving?batch=' + batch.id);
        if (await page.locator('#rts-next').count()) { await page.locator('#rts-next').click(); await go('receiving?batch=' + batch.id); }
        await page.locator('#rts-ok').check();
        await page.locator('[data-verify-label]').click();
        await page.getByText('Camera scanning is required.', { exact: false }).waitFor({ timeout: 20000 });
        assert.equal(await page.locator('.m-scan-manual').count(), 0);
        assert(await page.locator('#rts-post').isDisabled());
        assert.equal((await api('GET', '/inventory/' + batchProduct.id)).quantity, 1);
    });
    await check('Unit print template failure reports an error without a blank print sheet', async () => {
        await launch(rts);
        await go('record?unit=' + unit.id);
        let opened = 0;
        page.on('popup', () => opened++);
        await page.route('**/api/production/label-templates', route => route.abort('connectionreset'));
        await page.getByRole('button', { name: 'Print label', exact: true }).click();
        await page.getByText(/failed|unavailable|network|connect|fetch/i).last().waitFor({ timeout: 10000 });
        assert.equal(opened, 0);
    });
    const driver = await loginRole('warehouse');
    const driverMe = await api('GET','/auth/me',undefined,driver);
    const assigned = driverMe.user || driverMe;
    const delivery = await api('POST','/deliveries',{ order_id: 1, assigned_to: assigned.id, address: 'Acceptance test drop' });
    const deliveryPosts = [];
    async function deliveryRoute(action) {
        await page.route('**/api/deliveries/' + delivery.id + '/' + action, async route => {
            deliveryPosts.push({ action, body: route.request().postData(), key: route.request().headers()['idempotency-key'] });
            await route.fetch(); await route.abort('connectionreset');
        });
    }
    async function restartDelivery(step) {
        await launch(driver);
        page.on('request', req => { if (req.method() === 'POST' && req.url().includes('/api/deliveries/' + delivery.id + '/')) deliveryPosts.push({ action: new URL(req.url()).pathname.split('/').pop(), body: req.postData(), key: req.headers()['idempotency-key'] }); });
        await page.goto(base + '/m#/deliveries?id=' + delivery.id + (step ? '&step=' + step : ''));
    }
    await check('Delivery start recovers a committed response loss after browser restart', async () => {
        await restartDelivery(); await deliveryRoute('status');
        await page.getByRole('button',{name:'Start delivery',exact:true}).click();
        await page.locator('#delivery-retry').waitFor();
        assert.equal((await api('GET','/deliveries/' + delivery.id)).status,'out_for_delivery');
        await restartDelivery();
        await page.locator('#delivery-retry').click(); await page.locator('#delivery-review').waitFor();
        const attempts = deliveryPosts.filter(r => r.action === 'status');
        assert.equal(attempts[0].key, attempts.at(-1).key); assert.equal(attempts[0].body, attempts.at(-1).body);
        await page.locator('#delivery-review').click();
        await page.getByRole('button',{name:'Complete delivery',exact:true}).waitFor();
    });
    await check('Delivery proof, signature, recipient and note survive a real browser restart', async () => {
        await page.getByRole('button',{name:'Complete delivery',exact:true}).click();
        await page.locator('[data-recip]').fill('Delivery recipient'); await page.locator('[data-note]').fill('Original delivery note');
        const chooser = page.waitForEvent('filechooser'); await page.locator('.m-thumb-add').click();
        await (await chooser).setFiles({ name:'drop.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6gAAAAABJRU5ErkJggg==','base64') });
        await page.locator('.m-photo-picker img').waitFor();
        const canvas = page.locator('[data-sig] canvas'); await canvas.scrollIntoViewIfNeeded(); const b=await canvas.boundingBox();
        await page.mouse.move(b.x+20,b.y+20); await page.mouse.down(); await page.mouse.move(b.x+100,b.y+50,{steps:10}); await page.mouse.up();
        let savedSignature = false;
        for (let i=0;i<100;i++) {
            savedSignature = await page.evaluate(async id => { const s=await mProductionDrafts.load('delivery:' + id + ':action'); return !!s?.batch?.sign; }, delivery.id);
            if (savedSignature) break; await page.waitForTimeout(20);
        }
        assert(savedSignature, 'Signature bytes must commit to IndexedDB before closing the browser');
        await restartDelivery('proof');
        await page.locator('[data-recip]').waitFor();
        assert.equal(await page.locator('[data-recip]').inputValue(),'Delivery recipient');
        assert.equal(await page.locator('[data-note]').inputValue(),'Original delivery note');
        assert.equal(await page.locator('.m-photo-picker img').count(),1);
        assert.match(await page.locator('#m-view').innerText(),/Saved signature retained/);
    });
    await check('Delivered response loss recovers one POD with no second stock deduction', async () => {
        const quantity = (await api('GET','/inventory/' + batchProduct.id)).quantity;
        await deliveryRoute('complete'); await page.locator('[data-ok]').click(); await page.locator('#delivery-retry').waitFor();
        const committed=await api('GET','/deliveries/' + delivery.id); assert.equal(committed.status,'delivered'); assert(committed.signature_url); assert.equal(committed.photos.length,1);
        await restartDelivery(); await page.locator('#delivery-retry').click(); await page.locator('#delivery-review').waitFor();
        const attempts=deliveryPosts.filter(r=>r.action==='complete'); assert.equal(attempts[0].key,attempts.at(-1).key); assert.equal(attempts[0].body,attempts.at(-1).body);
        assert.equal((await api('GET','/inventory/' + batchProduct.id)).quantity,quantity);
        assert.equal(await page.locator('#m-view').getByText('Delivered',{exact:true}).count(),1);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await page.locator('#m-tabbar').waitFor({state:'visible'});
        await page.screenshot({path:path.join(output,'delivery-confirmed.png'),fullPage:true});
    });
    await check('Physical delivery may start before slip; delivery evidence stays optional after warehouse-out', async () => {
        const pendingOrder = await order(batchProduct, 1);
        const d=await api('POST','/deliveries',{order_id:pendingOrder.id,assigned_to:assigned.id});
        const before=(await api('GET','/inventory/'+batchProduct.id)).quantity;
        await launch(driver); await page.goto(base+'/m#/deliveries?id='+d.id);
        await page.getByRole('button',{name:'Start delivery',exact:true}).click(); await page.locator('#delivery-review').click();
        await page.getByRole('button',{name:'Complete delivery',exact:true}).click(); await page.locator('[data-ok]').click();
        await page.locator('#delivery-release').waitFor();
        assert.equal((await api('GET','/deliveries/'+d.id)).status,'out_for_delivery');
        assert.equal((await api('GET','/inventory/'+batchProduct.id)).quantity,before);
        await api('POST','/orders/'+pendingOrder.id+'/accept-release');
        await api('POST','/orders/'+pendingOrder.id+'/release',{bulk:[{item_id:batchProduct.id,batch_id:batch.id,quantity:1}]});
        await api('POST','/orders/'+pendingOrder.id+'/release-slip',{collected_by:'QR recipient',authorization_token:pendingOrder.auth});
        const shipped=(await api('GET','/inventory/'+batchProduct.id)).quantity;
        await page.locator('#delivery-review').click(); await page.getByRole('button',{name:'Complete delivery',exact:true}).click(); await page.locator('[data-ok]').click();
        await page.locator('#delivery-review').waitFor();
        const result=await api('GET','/deliveries/'+d.id);
        assert.equal(result.status,'delivered'); assert.equal(result.pod_recipient,null); assert.equal(result.signature_url,null); assert.equal(result.photos.length,0);
        assert.equal((await api('GET','/inventory/'+batchProduct.id)).quantity,shipped);
    });
    await check('Basic account sees only personal mobile tools; operational URLs and APIs stay blocked', async () => {
        await api('POST','/roles',{key:'audit_basic',label:'Audit basic employee',permissions:['mobile.access','messages.view','messages.send']});
        const basic=await loginRole('audit_basic'); await launch(basic);
        await page.goto(base+'/m#/work'); await page.locator('.v2-work').waitFor();
        const work=await page.locator('#m-view').innerText(); assert.match(work,/Personal tasks and employee services/); assert(!/Release orders|Deliveries|QC technical inspection|Pick order/.test(work));
        const actions=await page.locator('.v2-orbit-action').evaluateAll(nodes=>nodes.map(b=>b.dataset.route)); assert.deepEqual(actions,['requests','report-problem','inbox']);
        for (const route of ['so','deliveries','qc','receiving','kit-release','job-orders','production','stock-move','scan','record','my-log','allocate','confidential-reports']) {
            await page.goto(base+'/m#/'+route); await page.locator('[data-no-permission]').waitFor();
        }
        for (const route of ['/release-slips/queue','/deliveries','/rts/queue','/job-orders','/qc/queue','/inventory']) await api('GET',route,undefined,basic,403);
        await page.goto(base+'/m#/work'); await page.locator('.v2-work').waitFor();
        await page.screenshot({path:path.join(output,'basic-employee-work.png'),fullPage:true});
    });
    await check('Desktop permission removal refreshes phone visibility when focus returns', async () => {
        const releaseMe=(await api('GET','/auth/me',undefined,release)).user;
        await launch(release); await page.goto(base+'/m#/work'); await page.getByText('Release orders',{exact:true}).waitFor();
        await api('PUT','/users/'+releaseMe.id+'/permissions',{overrides:{'orders.release':false,'orders.view':false}});
        await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
        await page.waitForFunction(()=>!MApp.can('orders.release'));
        assert.equal(await page.getByText('Release orders',{exact:true}).count(),0);
        await page.goto(base+'/m#/so'); await page.locator('[data-no-permission]').waitFor();
        await api('GET','/release-slips/queue',undefined,release,403);
    });
    assert.deepEqual(report.errors, []);
}
catch (e) {
    report.checks.push({ name: 'Acceptance run', passed: false, error: e.stack });
    console.error(e);
    try {
        await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true });
        console.error(await page?.locator('#m-view').innerText());
    }
    catch { }
    process.exitCode = 1;
}
finally {
    clearTimeout(watchdog);
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    await context?.close();
    server.kill('SIGTERM');
}
