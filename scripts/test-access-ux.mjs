// Local browser regression checks; all API responses use sample data. No live backend.
import fs from 'node:fs';
import http from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const root = fileURLToPath(new URL('../public', import.meta.url));
const server = http.createServer((req, res) => { try {
    const pathname = new URL(req.url, 'http://local').pathname;
    const file = root + (pathname.endsWith('/') ? pathname + 'index.html' : pathname);
    res.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(fs.readFileSync(file));
}
catch {
    res.statusCode = 404;
    res.end('');
} });
(async () => {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = 'http://127.0.0.1:' + server.address().port;
    const b = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), headless: true, args: ['--no-sandbox'] });
    const context = await b.newContext({ serviceWorkers: 'block' });
    const p = await context.newPage();
    let logins = 0, resets = 0, access = "denied";
    await p.route('**/api/**', async (route) => { const url = route.request().url(); let body = {}, status = 200; if (url.includes('/auth/me')) {
        body = { user: { id: 9001, username: 'sample.staff', full_name: 'Sample Staff', role: 'employee', modules: [], permissions: access === 'restored' ? ['mobile.access'] : [], employee: null } };
        if (access === 'offline') {
            await route.abort();
            return;
        }
    }
    else if (url.includes('/auth/login')) {
        logins++;
        await new Promise(r => setTimeout(r, 300));
        body = { error: 'Invalid username or password' };
        status = 401;
    }
    else if (url.includes('/auth/forgot-password'))
        body = { ok: true, message: 'If that account exists and has an email address on file, a reset link is on its way.' };
    else if (url.includes('/auth/reset-password')) {
        resets++;
        body = { ok: true };
    } await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }); });
    for (const mobile of [false, true]) {
        await p.goto(base + '/' + (mobile ? 'mobile/' : ''));
        const form = p.locator(mobile ? '#m-login-form' : '#login-form');
        await form.waitFor({ state: 'visible' });
        const password = form.locator('input[name=password]');
        await password.fill('Sample-pass-238');
        await form.getByRole('button', { name: 'Show password', exact: true }).click();
        assert.equal(await password.getAttribute('type'), 'text');
        await form.getByRole('button', { name: 'Hide password', exact: true }).click();
        assert.equal(await password.inputValue(), 'Sample-pass-238');
        await form.locator('input[name=username]').fill('sample.staff');
        const before = logins;
        await form.evaluate(f => { f.requestSubmit(); f.requestSubmit(); });
        await p.waitForTimeout(600);
        assert.equal(logins - before, 1);
        assert.equal(await form.locator('[role=alert]').textContent(), 'Invalid username or password');
        assert.equal(await form.locator('[role=alert]').evaluate(e => e === document.activeElement), true);
        for (const theme of ['light', 'dark']) {
            const data = await p.evaluate(theme => { document.documentElement.dataset.theme = theme; const input = document.querySelector('input[type=checkbox]'); return { scheme: getComputedStyle(input).colorScheme }; }, theme);
            assert.equal(data.scheme, theme);
        }
        if (mobile) {
            const aligned = await form.locator('.m-shared-opt').evaluate(label => { const a = label.querySelector('input').getBoundingClientRect(), b = label.querySelector('span').getBoundingClientRect(); return a.right < b.left && Math.abs(a.top - b.top) < 5; });
            assert.ok(aligned);
            await p.locator('#m-recovery').click();
            await p.locator('#recovery-identifier').waitFor();
        }
        else
            await p.locator('#forgot-link').click();
        await p.locator('#recovery-identifier').fill('sample.staff');
        await p.locator('[data-confirm]').click();
        await p.getByRole('heading', { name: 'Request received' }).waitFor();
        assert.equal(await p.locator('[data-confirm]').isVisible(), false);
    }
    await p.goto(base + '/?reset=sample');
    await p.locator('#reset-password').fill('Sample-pass-238');
    await p.locator('#reset-confirm').fill('Different-pass-238');
    await p.locator('[data-confirm]').click();
    assert.equal(resets, 0);
    await p.locator('#reset-confirm').fill('Sample-pass-238');
    await p.locator('[data-confirm]').click();
    await p.getByRole('heading', { name: 'Password updated' }).waitFor();
    assert.equal(resets, 1);
    assert.equal(await p.locator('[data-confirm]').isVisible(), false);
    assert.ok(!p.url().includes('reset='));
    await p.goto(base + '/mobile/');
    await p.evaluate(() => localStorage.setItem('vds_token', 'sample'));
    await p.reload();
    await p.locator('#m-check-access').waitFor();
    await p.locator('#m-check-access').click();
    await p.getByText('Access is still not enabled.', { exact: false }).waitFor();
    access = 'offline';
    await p.locator('#m-check-access').click();
    await p.locator('#m-access-status').filter({ hasText: /offline|network|fetch/i }).waitFor();
    access = 'restored';
    await p.locator('#m-check-access').click();
    await p.locator('.m-blocked').waitFor({ state: 'detached' });
    await p.evaluate(() => { document.documentElement.dataset.theme = 'dark'; const box = document.createElement('div'); box.style.colorScheme = 'light'; box.innerHTML = '<input type="checkbox" id="nested-check"><label class="rk-check"><input type="checkbox" id="custom-check">Sample</label>'; document.body.appendChild(box); });
    assert.equal(await p.locator('#nested-check').evaluate(e => getComputedStyle(e).colorScheme), 'dark');
    assert.equal(await p.locator('#custom-check').evaluate(e => getComputedStyle(e).backgroundColor), 'rgb(21, 26, 32)');
    await p.locator('#custom-check').check();
    assert.equal(await p.locator('#custom-check').isChecked(), true);
    await b.close();
    server.close();
    console.log('PASS: blocked denial/offline/restored; nested/custom dark checkboxes.');
    console.log('PASS: actual desktop/mobile login Show/Hide, duplicate prevention, focused errors, theme checkboxes, mobile alignment/recovery, persistent recovery and reset mismatch/success.');
})().catch(e => { console.error(e); server.close(); process.exit(1); });
