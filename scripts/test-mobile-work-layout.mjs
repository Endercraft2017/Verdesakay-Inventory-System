// Work UI acceptance with independent database/API oracles. All records and mutations are disposable.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import { execFileSync } from 'node:child_process';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { chromium, expect } from 'playwright/test';
const baseline = process.env.WORK_LAYOUT_BASELINE === '1', out = process.env.WORK_LAYOUT_OUTPUT || 'work/work-layout/' + (baseline ? 'before' : 'after');
fs.mkdirSync(out, { recursive: true });
const sourceHashes=Object.fromEntries(['public/mobile/modules/hr/work.js','public/mobile/modules/core/notifications.js','public/mobile/mobile-v2.css','public/mobile/sw.js','src/core/notifications.routes.ts','src/modules/inventory/release-slips.routes.ts'].map(p=>[p,createHash('sha256').update(fs.readFileSync(p)).digest('hex')]));
const report = { sourceHashes, baselineRef: baseline?'8c4d506':null, environment: 'Local disposable Express/SQLite, Chromium 390x844, Asia/Manila; no live sandbox writes', checks: [], metrics: [], flows: [], profiles: [], errors: [] };
const server = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', "await import('./scripts/browser/editor-ux-server.ts');console.log('WORK_DB='+process.env.DB_PATH)"], { stdio: ['ignore', 'pipe', 'pipe'] });
server.stderr.on('data', d => fs.appendFileSync(out + '/server.log', d));
let browser, db, base, admin;
const contexts = [], networks = new Map();
let caseName = 'fixture';
const watchdog = setTimeout(() => { server.kill(); process.exit(1); }, 240000);
try {
    const cfg = await new Promise((resolve, reject) => { let log = ''; server.stdout.on('data', d => { log += d; const p = log.match(/EDITOR_UX_PORT=(\d+)/), f = log.match(/WORK_DB=(.+)/); if (p && f)
        resolve({ port: p[1], file: f[1].trim() }); }); server.on('exit', c => reject(Error('Fixture exited ' + c))); });
    base = 'http://127.0.0.1:' + cfg.port;
    async function api(method, path, data, token = admin) { const r = await fetch(base + '/api' + path, { method, headers: { Authorization: 'Bearer ' + (token || ''), 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) }); const body = await r.json(); assert(r.ok, path + ': ' + r.status + ' ' + JSON.stringify(body)); return body; }
    admin = (await api('POST', '/auth/login', { username: 'admin', password: 'admin123' }, '')).token;
    db = new DatabaseSync(cfg.file, { readOnly: true });
    const sql = (q, ...p) => db.prepare(q).all(...p);
    const administrator = { token: admin, ...(await api('GET', '/auth/me')).user };
    async function user(name, permissions) { await api('POST', '/roles', { key: name, label: name, permissions: ['mobile.access', ...permissions] }); const r = await api('POST', '/users', { username: name, full_name: name, password: 'fixture-password', role: name }); const token = (await api('POST', '/auth/login', { username: name, password: 'fixture-password' }, '')).token; const profile = (await api('GET', '/auth/me', undefined, token)).user; report.profiles.push({ id: profile.id, role: profile.role, permissions: profile.permissions }); return { ...r, token }; }
    const clerk = await user('work_audit_clerk', ['orders.view', 'orders.release', 'production.kit_release', 'production.repairs', 'production.receive']), qc = await user('work_audit_qc', ['production.inspect_qc']), basic = await user('work_audit_basic', []);
    function seed(commands) { const w = new DatabaseSync(cfg.file); try {
        w.exec('BEGIN');
        for (const [q, ...params] of commands)
            w.prepare(q).run(...params);
        w.exec('COMMIT');
    }
    finally {
        w.close();
    } }
    const stock = () => sql('SELECT item_id,location_id,quantity FROM inventory_stock ORDER BY item_id,location_id');
    browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    async function open(who) { const c = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'Asia/Manila', serviceWorkers: 'block' }); contexts.push(c); const network = []; networks.set(c, network); c.on('response', async (r) => { if (r.url().includes('/api/')) {
        const row = {case:caseName, method: r.request().method(), path: new URL(r.url()).pathname + new URL(r.url()).search, status: r.status() };
        network.push(row);
        if (/notifications|queue|stage=/.test(r.url()))
            try {
                row.body = await r.json();
            }
            catch { }
    } }); if (baseline) {
        for (const file of ['public/mobile/modules/hr/work.js', 'public/mobile/mobile-v2.css']) {
            const body = execFileSync('git', ['show', '8c4d506:' + file], { encoding: 'utf8' });
            await c.route('**/' + file.slice(7), r => r.fulfill({ body, contentType: file.endsWith('.css') ? 'text/css' : 'text/javascript' }));
        }
    } await c.tracing.start({ screenshots: true, snapshots: true, sources: true }); await c.addInitScript(t => { localStorage.setItem('vds_token', t); localStorage.setItem('vds_theme', 'dark'); window.__workTaps = []; document.addEventListener('pointerup', e => { if (e.isTrusted) {
        const b = e.target.closest('button');
        if (b)
            window.__workTaps.push({ label: b.textContent.trim(), hash: location.hash });
    } }, true); }, who.token); const page = await c.newPage(); page.setDefaultTimeout(8000); page.on('pageerror', e => report.errors.push(e.message)); await page.goto(base + '/m#/work'); await ready(page); return { page, c }; }
    async function ready(page) { await page.locator('[data-attention-refresh]').waitFor(); await page.waitForFunction(() => document.querySelector('[data-attention-refresh]')?.disabled === false); }
    async function measure(page, label) { const data = await page.evaluate(() => { const f = document.querySelector('[data-work-attention]'); const r = e => { if (!e)
        return null; const b = e.getBoundingClientRect(); return { height: b.height, top: b.top }; }; return { attention: r(f), groups: [...f.querySelectorAll('[data-work-desk]')].map(e => ({ key: e.dataset.workDesk, ...r(e), rows: e.querySelectorAll('[data-attention]').length, empty: e.textContent.includes('No items waiting in this queue.'), text: e.textContent.slice(0, 220) })), authorizedTop: [...document.querySelectorAll('.v2-work-title')].find(e => e.textContent.includes('My authorized queues'))?.getBoundingClientRect().top, assignment: r(document.querySelector('.v2-work-assignment')), documentHeight: document.documentElement.scrollHeight }; }); report.metrics.push({ label, ...data }); await page.screenshot({ path: out + '/' + label + '.png', fullPage: true }); return data; }
    async function check(name, fn) { caseName = name; try {
        await fn();
        report.checks.push(name);
        console.log('PASS ' + name);
    }
    catch (e) {
        report.failure = { name, error: e.stack };
        throw e;
    }
    finally {
        let i = 0;
        for (const c of contexts.splice(0)) {
            const stem = String(report.checks.length).padStart(2, '0') + '-' + i++;
            await c.tracing.stop({ path: out + '/' + stem + '.zip' });
            fs.writeFileSync(out + '/' + stem + '.network.json', JSON.stringify(networks.get(c), null, 2));
            await c.close();
        }
    } }
    await check('Empty Work uses one clear summary and keeps authorized queues and tools accessible', async () => { for (const [label, who] of [['empty-admin', administrator], ['empty-clerk', clerk], ['empty-qc', qc], ['empty-basic', basic]]) {
        const before = stock(), { page } = await open(who);
        const data = await measure(page, label);
        if (baseline) {
            assert(data.groups.every(g => g.empty));
        }
        else {
            await expect(page.locator('[data-work-empty]')).toBeVisible();
            assert.equal(await page.locator('[data-work-attention] [data-work-desk]').count(), 0);
            await expect(page.locator('[data-work-tools]')).not.toHaveAttribute('open', '');
            await expect(page.locator('[data-work-updates]')).not.toHaveAttribute('open', '');
            await page.locator('[data-work-tools]>summary').click();
            await expect(page.getByRole('button', { name: 'Tasks & reminders', exact: true })).toBeVisible();
            await expect(page.getByRole('button', { name: 'Report a blocker', exact: false })).toBeVisible();
        }
        assert.deepEqual(stock(), before);
    } });
    if (!baseline) {
        const raw = await api('POST', '/inventory', { name: 'Audit warehouse frame', quantity: 20 }), product = await api('POST', '/inventory', { name: 'Audit warehouse product', quantity: 0 });
        await api('PUT', '/finished-products/' + product.id, { components: [{ component_item_id: raw.id, quantity: 1 }] });
        const older = await api('POST', '/orders', { type: 'sale', customer_name: 'Older follow-up buyer', items: [{ item_id: raw.id, name: 'Frame', quantity: 1 }] }), newer = await api('POST', '/orders', { type: 'sale', customer_name: 'Newer follow-up buyer', items: [{ item_id: raw.id, name: 'Frame', quantity: 1 }] }), sale = await api('POST', '/orders', { type: 'sale', customer_name: 'Ready for warehouse', items: [{ item_id: raw.id, name: 'Frame', quantity: 1 }] });
        const approver = await user('work_audit_approver', ['orders.view', 'orders.approve']);
        await api('POST', '/orders/' + sale.id + '/status', { status: 'approved' }, approver.token);
        const cancelled = await api('POST', '/orders', { type: 'sale', customer_name: 'Finished follow-up', items: [{ name: 'Service', quantity: 1 }] });
        await api('POST', '/orders/' + cancelled.id + '/status', { status: 'cancelled' });
        const jo = await api('POST', '/job-orders', { product_item_id: product.id, qty_ordered: 1, qc_stages: 2 });
        await api('POST', '/job-orders/' + jo.id + '/approve');
        await api('POST', '/tasks', { title: 'Overdue safety follow-up', due_date: '2026-10-01' }, admin);
        seed([['UPDATE orders SET created_at=? WHERE id=?', '2026-01-01 00:00:00', older.id], ['UPDATE orders SET created_at=? WHERE id=?', '2026-10-01 00:00:00', newer.id]]);
        const notifications = [['New HR request', 'Sample employee — Leave request', '#/approvals?id=501', 'hr-request-501'], ['New HR request', 'Sample employee — Leave request', '#/approvals?id=501', 'hr-request-501'], ['New HR request', 'Sample employee — Leave request', '#/approvals?id=502', 'hr-request-502'], ['Request approved', 'Leave request was approved', '#/notifications', 'hr-approved-503'], ['Old release update', 'A sale that is now cancelled', '#/so?id=' + cancelled.id, 'sale-release-' + cancelled.id]];
        seed(notifications.map(n => ['INSERT INTO notifications(user_id,title,body,url,tag) VALUES(?,?,?,?,?)', administrator.id, ...n]));
        await api('POST', '/orders/' + older.id + '/status', { status: 'approved' }, approver.token);
        await api('POST', '/orders/' + newer.id + '/status', { status: 'approved' }, approver.token);
        seed([['UPDATE orders SET created_at=? WHERE id=?', '2026-01-03 00:00:00', sale.id], ['UPDATE job_orders SET approved_at=? WHERE id=?', '2026-01-02 00:00:00', jo.id]]);
        let releaseNotice = sql('SELECT id FROM notifications WHERE user_id=? AND url=? ORDER BY id DESC', administrator.id, '#/so?id=' + sale.id)[0];
        assert(releaseNotice, 'The approval must create a real release notice');
        // Real QC/QA and mixed serialized/batch receiving records.
        async function productionJob(qty, stages) { const j = await api('POST', '/job-orders', { product_item_id: product.id, qty_ordered: qty, qc_stages: stages }); await api('POST', '/job-orders/' + j.id + '/approve'); await api('POST', '/job-orders/warehouse-accept', { job_order_ids: [j.id] }); await api('POST', '/job-orders/prepare', { job_orders: [{ id: j.id }] }); await api('POST', '/job-orders/' + j.id + '/release'); await api('POST', '/job-orders/' + j.id + '/accept', {}); return j; }
        const built = await productionJob(3, 2), units = [], png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6gAAAAABJRU5ErkJggg==', 'base64');
        for (let i = 0; i < 3; i++) {
            const fd = new FormData();
            fd.append('identifier', 'WORK-UNIT-' + i);
            fd.append('image', new Blob([png], { type: 'image/png' }), 'unit.png');
            const r = await fetch(base + '/api/job-orders/' + built.id + '/units', { method: 'POST', headers: { Authorization: 'Bearer ' + admin }, body: fd });
            assert(r.ok);
            units.push(await r.json());
        }
        const proof = new FormData();
        proof.append('kind', 'qc_unit');
        proof.append('ref_id', String(units[1].id));
        proof.append('image', new Blob([png], { type: 'image/png' }), 'defect.png');
        const evidence = await (await fetch(base + '/api/attachments', { method: 'POST', headers: { Authorization: 'Bearer ' + admin }, body: proof })).json();
        await api('POST', '/job-orders/' + built.id + '/units/inspect', { unit_ids: [units[1].id], inspection_stage: 1, result: 'fail', disposition: 'repair', remarks: 'Needs a frame replacement', evidence_ids: [evidence.id] });
        await api('POST', '/production/units/' + units[1].id + '/repairs', { kind: 'add', component_item_id: raw.id, quantity: 1, notes: 'Work layout blocking fixture' });
        for (const stage of [1, 2])
            await api('POST', '/job-orders/' + built.id + '/units/inspect', { unit_ids: [units[2].id], inspection_stage: stage, result: 'pass' });
        const bulk = await productionJob(5, 0);
        await api('POST', '/job-orders/' + bulk.id + '/progress', { done_delta: 5 });
        const receivable = await api('GET', '/job-orders/' + bulk.id + '/receivable'), batch = receivable.batches[0], location = receivable.output_location_id;
        const expectedRelease = async () => (await api('GET', '/release-slips/queue', undefined, clerk.token));
        await check('Live Work uses two oldest previews and full API counts; sales tracking is collapsed', async () => { const before = stock(), { page } = await open(administrator); await measure(page, 'populated-admin'); const live = await expectedRelease(), numbers = sql("SELECT number FROM orders WHERE id IN (?,?,?) ORDER BY created_at,id", older.id, newer.id, sale.id).map(r => r.number); for (const r of live.to_accept.concat(live.releasing))
            assert.equal(r.created_at, sql('SELECT created_at FROM orders WHERE id=?', r.id)[0].created_at); const g = page.locator('[data-work-desk=release]'); assert.equal(await g.locator('[data-attention]').count(), 2); assert.deepEqual(await g.locator('[data-attention] b').evaluateAll(es => es.map(e => { const copy = e.cloneNode(true); copy.querySelector('span')?.remove(); return copy.textContent; })), numbers.slice(0, 2)); await expect(g.locator('.work-desk-heading')).toContainText('3 orders'); await expect(page.locator('[data-work-tracking]')).not.toBeVisible(); await g.locator('.work-view-all').click(); await page.waitForURL(u => u.hash.split('?')[0] === '#/so'); assert.deepEqual(stock(), before); });
        await check('Record identity groups repeated events; opening updates preserves checked two-tap flow', async () => { seed([["INSERT INTO notifications(user_id,title,body,url) VALUES(?,?,?,?)", administrator.id, 'New HR request', 'Employee A', '#/approvals?id=600'], ["INSERT INTO notifications(user_id,title,body,url) VALUES(?,?,?,?)", administrator.id, 'New HR request', 'Employee A', '#/approvals?id=600'], ["INSERT INTO notifications(user_id,title,body,url) VALUES(?,?,?,?)", administrator.id, 'New HR request', 'Employee B', '#/approvals?id=601']]); const before = stock(), { page } = await open(administrator); await page.locator('[data-work-updates]>summary').click(); const rows = page.locator('[data-work-desk=notice] [data-attention]'); assert.equal(await rows.filter({ hasText: 'New HR request' }).count(), 2); const all = await api('GET', '/notifications?unread=1&limit=200'); report.notificationFixture = { unread: all.unread, items: all.items.map(n => ({ id: n.id, title: n.title, url: n.url })) }; await page.locator('[data-work-updates]>summary').click(); await expect(page.locator('[data-work-updates]')).not.toHaveAttribute('open', ''); assert.equal(sql('SELECT read_at FROM notifications WHERE id=?', releaseNotice.id)[0].read_at, null); });
        await check('An operational update opens the checked record in two navigation taps without stock changes', async () => { seed([['INSERT INTO notifications(user_id,title,body,url) VALUES(?,?,?,?)', clerk.id, 'Fixture warehouse handoff', 'Ready for warehouse', '#/so?id=' + sale.id]]); const before = stock(), { page } = await open(clerk); await page.locator('[data-work-updates]>summary').click(); const notice = (await api('GET', '/notifications?unread=1&limit=200', undefined, clerk.token)).items.find(n => n.url === '#/so?id=' + sale.id); assert(notice); await page.locator('[data-work-desk=notice] [data-attention]').filter({ hasText: notice.title }).first().click(); await page.locator('#work-open-action').click(); await page.waitForURL(u => u.hash.split('?')[0] === '#/so'); const taps = await page.evaluate(() => window.__workTaps); assert.equal(taps.length, 2); report.flows.push({ kind: 'update', navigationTaps: 2, disclosureTaps: 1, taps, destination: new URL(page.url()).hash }); assert(sql('SELECT read_at FROM notifications WHERE id=?', notice.id)[0].read_at); assert.deepEqual(stock(), before); });
        await check('Another employee completes the oldest order; refreshing advances the next category', async () => { const { page } = await open(clerk), before = stock(); assert.equal(await page.locator('[data-work-attention] [data-work-desk]').first().getAttribute('data-work-desk'), 'release'); await api('POST', '/orders/' + older.id + '/status', { status: 'cancelled' }); await page.locator('[data-attention-refresh]').click(); await ready(page); assert.equal(await page.locator('[data-work-attention] [data-work-desk]').first().getAttribute('data-work-desk'), 'kits'); assert.equal(await page.locator('[data-work-attention] [data-attention=release][data-work-record="record:' + older.id + '"]').count(), 0); await page.screenshot({ path: out + '/oldest-completed.png', fullPage: true }); assert.deepEqual(stock(), before); });
        await check('Failed queue retains stale records; refusal removes them without claiming all-clear', async () => { const { page, c } = await open(clerk); await c.route('**/api/release-slips/queue', r => r.fulfill({ status: 503, json: { error: 'Temporary fixture failure' } })); await page.locator('[data-attention-refresh]').click(); await ready(page); await expect(page.locator('[data-work-desk=release]')).toContainText('Last loaded'); assert.equal(await page.locator('[data-work-desk=release] [data-attention]').count(), 2); await expect(page.locator('[data-work-empty]')).not.toBeVisible(); await c.unroute('**/api/release-slips/queue'); await c.route('**/api/release-slips/queue', r => r.fulfill({ status: 403, json: { error: 'Access refused' } })); await page.locator('[data-attention-refresh]').click(); await ready(page); assert.equal(await page.locator('[data-work-desk=release] [data-attention]').count(), 0); await expect(page.locator('[data-work-desk=release]')).toContainText('Unknown'); });
        await check('Older unread updates survive a latest-history window full of read rows', async () => { seed([['INSERT INTO notifications(user_id,title,body,url,read_at) VALUES(?,?,?,?,NULL)', basic.id, 'Older unread update', 'Still unread', '#/notifications'], ...Array.from({ length: 51 }, (_, i) => ['INSERT INTO notifications(user_id,title,body,url,read_at) VALUES(?,?,?,?,?)', basic.id, 'Read update ' + i, 'Already read', '#/notifications', '2026-10-25 00:00:00'])]); const { page } = await open(basic); await expect(page.locator('[data-work-updates-label]')).toHaveText('Updates · 1 unread'); await page.locator('[data-work-updates]>summary').click(); await expect(page.getByRole('button', { name: /Older unread update/ })).toBeVisible(); assert.equal((await api('GET', '/notifications', undefined, basic.token)).items.filter(n => !n.read_at).length, 0); await page.getByRole('button', { name: /Older unread update/ }).click(); await page.waitForURL(u => u.hash.includes('/notifications?id=')); await expect(page.locator('.v2-notification-focus h2')).toHaveText('Older unread update'); });
        await check('QC and QA counts match their own queues and blocked units retain checked action links', async () => { const before = stock(), { page } = await open(administrator); for (const role of ['qc', 'qa']) {
            const q = await api('GET', '/qc/queue?role=' + role), g = page.locator('[data-work-desk=' + role + ']');
            await expect(g.locator('.work-desk-heading')).toContainText(q.units.length + ' units');
            assert.equal(await g.locator('[data-attention]').count(), Math.min(2, q.units.length));
        } const g = page.locator('[data-work-desk=qc]'); await expect(g).toContainText('Waiting for parts'); await g.locator('[data-attention]').filter({ hasText: 'WORK-UNIT-1' }).click(); await expect(page.locator('#m-view')).toContainText('warehouse must resolve'); await page.locator('#work-open-action').click(); await page.waitForURL(u => u.hash.includes('role=qc') && u.hash.includes('unit=' + units[1].id)); assert.deepEqual(stock(), before); });
        await check('Partial and complete batch receipts update exact piece counts; RTS holds stay visible', async () => { const { page } = await open(clerk); const g = page.locator('[data-work-desk=rts]'); await expect(g.locator('.work-desk-heading')).toContainText('1 unit · 1 batch (5 pcs)'); const before = sql('SELECT COALESCE(SUM(quantity),0) AS n FROM inventory_stock WHERE item_id=?', product.id)[0].n; await api('POST', '/job-orders/' + bulk.id + '/products-in', { batch_id: batch.id, quantity: 2, location_id: location }); await page.locator('[data-attention-refresh]').click(); await ready(page); await expect(g).toContainText('1 unit · 1 batch (3 pcs)'); assert.equal(sql('SELECT COALESCE(SUM(quantity),0) AS n FROM inventory_stock WHERE item_id=?', product.id)[0].n, before + 2); await api('POST', '/job-orders/' + bulk.id + '/products-in', { batch_id: batch.id, quantity: 3, location_id: location }); await api('POST', '/production-issues', { job_order_id: built.id, unit_id: units[2].id, category: 'Product-data mismatch', severity: 'high', description: 'Hold remaining serial for record correction' }); await page.locator('[data-attention-refresh]').click(); await ready(page); await expect(g.locator('.work-held')).toContainText('1 unit on hold'); assert.equal(await g.locator('[data-attention]').count(), 0); await expect(page.locator('[data-work-attention] [data-work-desk=rts]')).toBeVisible(); assert.equal(sql('SELECT COALESCE(SUM(quantity),0) AS n FROM inventory_stock WHERE item_id=?', product.id)[0].n, before + 5); await g.locator('.work-held').click(); await page.waitForURL(u => u.hash.includes('tab=issues')); });
        await check('Employee sessions see only effective duties and revoked access removes private previews', async () => { for (const [who, expected] of [[clerk, ['release', 'kits', 'parts', 'rts', 'notice', 'personal']], [qc, ['qc', 'notice', 'personal']], [basic, ['notice', 'personal']]]) {
            const { page } = await open(who);
            assert.deepEqual((await page.locator('[data-work-desk]').evaluateAll(es => es.map(e => e.dataset.workDesk))).sort(), expected.sort());
        } const { page } = await open(clerk); await api('PUT', '/users/' + clerk.id + '/permissions', { overrides: { 'orders.view': false, 'orders.release': false, 'production.kit_release': false, 'production.repairs': false, 'production.receive': false } }); await page.evaluate(async () => { await MApp.refreshAccess({ required: true }); MApp.render(); }); await ready(page); assert.equal(await page.locator('[data-work-desk=release]').count(), 0); await expect(page.locator('[data-work-attention]')).not.toContainText('SO-'); assert.equal((await api('GET', '/auth/me', undefined, clerk.token)).user.permissions.includes('orders.release'), false); await api('PUT', '/users/' + clerk.id + '/permissions', { overrides: {} }); });
        await check('Delayed reads cannot repaint after leaving Work; return loads current queues', async () => { const { page, c } = await open(clerk); let releaseResponse; await c.route('**/api/release-slips/queue', async (r) => { const data = await r.fetch(); await new Promise(resolve => releaseResponse = () => resolve()); await r.fulfill({ response: data }); }); await page.locator('[data-attention-refresh]').click(); await page.waitForFunction(() => document.querySelector('[data-attention-refresh]').disabled); await expect.poll(() => typeof releaseResponse).toBe('function'); await page.evaluate(() => MApp.go('home')); await page.waitForURL(u => u.hash === '#/home'); releaseResponse(); await expect(page.locator('.v2-work')).toHaveCount(0); await c.unroute('**/api/release-slips/queue'); await page.evaluate(() => MApp.go('work')); await ready(page); await expect(page.locator('[data-work-desk=release] .work-desk-heading')).toContainText('2 orders'); });
        await check('Saved original handoff remains visible above collapsed tools when no server record is pending', async () => { const { page } = await open(clerk), before = stock(); await page.evaluate(async (id) => { const slot = 'handoff:' + id + ':action'; await mProductionDrafts.save({ key: mProductionDrafts.key(slot), rows: [], batch: {}, operation: { kind: 'release-handoff', orderId: id, number: 'SAVED-ORIGINAL', state: 'unknown', key: 'saved-original-key', created: Date.now() } }); }, cancelled.id); await page.reload(); await ready(page); await expect(page.locator('[data-work-recovery]')).toContainText('SAVED-ORIGINAL'); await page.locator('[data-work-recovery] button').filter({ hasText: 'SAVED-ORIGINAL' }).click(); await page.waitForURL(u => u.hash.includes('step=proof')); assert.equal(new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('id'), String(cancelled.id)); assert.deepEqual(stock(), before); });
        await check('Keyboard disclosures, dark/light themes and narrow mobile layouts remain usable', async () => { const { page } = await open(qc); await page.locator('[data-work-clear]>summary').focus(); await page.keyboard.press('Enter'); await expect(page.locator('[data-work-clear]')).toHaveAttribute('open', ''); await page.locator('[data-work-clear-list] .work-view-all').first().click(); await page.waitForURL(u => u.hash.split('?')[0] === '#/tasks'); await page.evaluate(() => MApp.go('work')); await ready(page); for (const theme of ['dark', 'light']) {
            await page.evaluate(t => { document.documentElement.dataset.theme = t; localStorage.setItem('vds_theme', t); }, theme);
            for (const width of [320, 390, 768]) {
                await page.setViewportSize({ width, height: 844 });
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
            }
            const results = await new AxeBuilder({ page }).include('.v2-work').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
            report.accessibility ||= [];
            report.accessibility.push({ theme, violations: results.violations });
            assert.deepEqual(results.violations, []);
            await page.screenshot({ path: out + '/work-' + theme + '.png', fullPage: true });
        } });
    }
    assert.deepEqual(report.errors, []);
}
catch (e) {
    report.fatal = e.stack;
    console.error(e);
    process.exitCode = 1;
}
finally {
    for (const c of contexts)
        await c.close();
    await browser?.close();
    db?.close();
    server.kill();
    clearTimeout(watchdog);
    fs.writeFileSync(out + '/report.json', JSON.stringify(report, null, 2));
}
