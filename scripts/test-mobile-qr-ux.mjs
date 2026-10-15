// Real-backend mobile QR acceptance audit. Uses generated print images as Chromium's
// virtual camera frames; never replaces the scanner or mocks stock API responses.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
const output = path.resolve('work/mobile-qr-audit');
fs.mkdirSync(output, { recursive: true });
const requests = [];
const report = { backend: 'Disposable real Express/SQLite backend', camera: 'Chromium virtual-camera Y4M frames generated from actual printed QR images; scanner callbacks unchanged', viewport: '390x844', checks: [], errors: [], limits: ['Virtual camera, not physical paper/printer or phone optics.'] };
const server = spawn(process.execPath, ['--import', 'tsx', 'scripts/browser/editor-ux-server.ts'], { stdio: ['ignore', 'pipe', 'pipe'] });
server.stderr.on('data', d => fs.appendFileSync(path.join(output, 'server.log'), d));
let base, admin, browser, context, page;
const watchdog = setTimeout(() => { server.kill(); process.exit(1); }, 300000);
async function api(method, route, body, token = admin, expected) {
    const res = await fetch(base + '/api' + route, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) }, ...(body !== undefined ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}) });
    const value = await res.json();
    assert(expected ? res.status === expected : res.ok, `${method} ${route}: ${res.status} ${JSON.stringify(value)}`);
    return value;
}
async function check(name, fn) { await fn(); report.checks.push({ name, passed: true }); console.log('PASS ' + name); }
async function loginRole(role) { const username = 'audit_' + role; await api('POST', '/users', { username, full_name: role, password: 'test-secret123', role }); return (await api('POST', '/auth/login', { username, password: 'test-secret123' }, null)).token; }
async function launch(token, camera, storageState) {
    await browser?.close();
    browser = await chromium.launch({ ...((process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || ['/usr/bin/chromium', '/usr/lib/chromium/chromium'].find(fs.existsSync)) ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || ['/usr/bin/chromium', '/usr/lib/chromium/chromium'].find(fs.existsSync) } : {}), headless: true, args: camera ? ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-file-for-fake-video-capture=' + camera] : [] });
    context = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['camera'], timezoneId: 'Asia/Manila', serviceWorkers: 'block', ...(storageState ? { storageState } : {}) });
    await context.addInitScript(t => localStorage.setItem('vds_token', t), token);
    page = await context.newPage();
    page.on('request', req => { if (req.method() === 'POST' && /\/api\/orders\/\d+\/release$/.test(new URL(req.url()).pathname))
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
    const canvas = page.locator('[data-sign] canvas');
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
    if (so.id === 1) {
        await check('Reload during handoff cannot silently release stock', async () => {
            await page.reload();
            await page.locator('#rel-go').click();
            await page.locator('[data-cap], #rel-post').first().waitFor();
            assert.equal((await api('GET', '/inventory/' + so.productId)).quantity, so.quantity);
            if (!await page.locator('#rel-post').count()) {
                report.limits.push('Handoff proof/signature drafts are memory-only: reload safely blocks release but requires recapture. Durable proof recovery remains open.');
                await captureToReview(so);
                await page.locator('#rel-go').click();
            }
        });
    }
    else
        await page.locator('#rel-go').click();
    await page.locator('#rel-post').waitFor();
    await page.locator('#rel-ok').check();
    await page.locator('#rel-post').click();
    await page.waitForURL(/step=done/);
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
                const saved = await context.storageState({ indexedDB: true });
                await launch(release, item.video, saved);
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
    await browser?.close();
    server.kill('SIGTERM');
}
