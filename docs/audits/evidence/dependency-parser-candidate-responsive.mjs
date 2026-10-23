import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const output = 'work/dependency-followup-responsive';
fs.mkdirSync(output, { recursive: true });
const backend = spawn(process.execPath, ['--import', 'tsx', 'scripts/browser/editor-ux-server.ts'], { stdio: ['ignore', 'pipe', 'pipe'] });
backend.stderr.on('data', chunk => fs.appendFileSync(output + '/server.txt', chunk));
let browser;
const report = [];
try {
  const port = await new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(Error('Isolated server startup timed out')), 30_000);
    backend.stdout.on('data', chunk => { text += chunk; const match = text.match(/EDITOR_UX_PORT=(\d+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
    backend.on('exit', code => { clearTimeout(timer); reject(Error('Server exited: ' + code)); });
  });
  const base = 'http://127.0.0.1:' + port;
  let token;
  async function api(method, route, body) {
    const response = await fetch(base + '/api' + route, { method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000),
    });
    assert(response.ok, method + ' ' + route + ' ' + response.status);
    return response.json();
  }
  token = (await api('POST', '/auth/login', { username: 'admin', password: 'admin123-test-only' })).token;
  await api('POST', '/auth/change-password', { current_password: 'admin123-test-only', new_password: 'Synthetic Word viewport password' });
  token = (await api('POST', '/auth/login', { username: 'admin', password: 'Synthetic Word viewport password' })).token;
  const template = await api('POST', '/templates', { name: 'Synthetic Word viewport review', type: 'generic', body: '<h1>Word conversion review</h1><p>Preserved draft. Review conversion before applying it.</p>' });
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || ['/usr/lib/chromium/chromium', '/usr/bin/chromium'].find(fs.existsSync);
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await page.goto(base + '/?view=desktop');
  await page.locator('#login-username').fill('admin');
  await page.locator('#login-password').fill('Synthetic Word viewport password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForFunction(() => window.App?.getMe());
  await page.evaluate(() => window.App.navigate('templates'));
  await page.locator(`[data-edit="${template.id}"]`).click();
  await page.waitForFunction(() => document.querySelector('.doc-shared-status')?.textContent.includes('Connected'));
  for (const theme of ['light', 'dark']) for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    for (const selector of ['[data-save]', '[data-close]']) {
      const box = await page.locator('.doc-fs ' + selector).boundingBox();
      assert(box && box.x >= 0 && box.x + box.width <= width + 1, selector + ' clipped at ' + width);
    }
    const name = `editor-${theme}-${width}.png`;
    await page.screenshot({ path: path.join(output, name) });
    report.push({ theme, width, file: name, controlsVisible: true });
  }
  fs.writeFileSync(output + '/results.json', JSON.stringify(report, null, 2) + '\n');
  console.log('Eight editor viewport/theme captures and Save/Close bounds passed');
} finally {
  if (browser) await browser.close();
  if (backend.exitCode === null && backend.signalCode === null) { const stopped = once(backend, 'exit'); backend.kill(); await stopped; }
}
