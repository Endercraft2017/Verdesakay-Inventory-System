import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
const server = spawn(process.execPath, ['--import', 'tsx', 'scripts/browser/editor-ux-server.ts'], { stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
try {
  const port = await new Promise((resolve, reject) => {
    server.stdout.on('data', data => { const m = String(data).match(/EDITOR_UX_PORT=(\d+)/); if (m) resolve(m[1]); });
    server.on('exit', code => reject(new Error('server exited ' + code)));
  });
  const base = `http://127.0.0.1:${port}`;
  const api = async (method, route, token, body, status = 200) => {
    const r = await fetch(base + '/api' + route, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body == null ? undefined : JSON.stringify(body) });
    const data = await r.json(); assert.equal(r.status, status, route + ': ' + JSON.stringify(data)); return data;
  };
  const admin = (await api('POST', '/auth/login', '', { username: 'admin', password: 'admin123' })).token;
  await api('PUT', '/release-slips/policy', admin, { authorization_required: false });
  const item = await api('POST', '/inventory', admin, { name: 'Courier browser item', quantity: 1 }, 201);
  const order = await api('POST', '/orders', admin, { type: 'sale', status: 'approved', customer_name: 'Courier buyer', items: [{ item_id: item.id, name: 'Courier browser item', quantity: 1, unit_price: 25 }] }, 201);
  await api('POST', '/orders/' + order.id + '/accept-release', admin, {});
  await api('POST', '/orders/' + order.id + '/release', admin, { bulk: [{ item_id: item.id, quantity: 1 }] });
  const slip = await api('POST', '/orders/' + order.id + '/release-slip', admin, { collected_by: 'Dispatch' }, 201);
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    await context.addInitScript(token => localStorage.setItem('vds_token', token), admin);
    const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(base + '/app'); await page.waitForFunction(() => typeof App !== 'undefined' && App.getMe());
    await page.evaluate(() => App.navigate('releasing', { tab: 'slips' }));
    await page.locator('#rs-table tr[data-open="' + slip.id + '"]').click();
    if (width === 1440) {
      await page.getByRole('button', { name: 'Book courier' }).click();
      await page.locator('[data-f="courier"]').fill('Swift Cargo');
      const dispatch = await api('GET', '/deliveries/planning-context?order_id=' + order.id, admin);
      await page.locator('[data-f="driver"]').selectOption(String(dispatch.drivers[0].id));
      await page.locator('[data-f="tracking"]').fill('SW-123');
      await page.locator('#modal-root [data-confirm]').last().click();
      await page.getByRole('button', { name: 'Confirm courier pickup' }).waitFor();
      await page.getByRole('button', { name: 'Confirm courier pickup' }).click();
      await page.locator('[data-f="collector"]').fill('J. Courier');
      await page.locator('[data-f="photo"]').setInputFiles({ name: 'pickup.png', mimeType: 'image/png', buffer: Buffer.from('pickup-proof') });
      const booking = (await api('GET', '/deliveries?order_id=' + order.id, admin))[0];
      await page.route('**/api/deliveries/' + booking.id + '/complete', async route => {
        const response = await route.fetch(); assert.equal(response.status(), 200); await route.abort('failed');
      }, { times: 1 });
      await page.locator('#modal-root [data-confirm]').last().click();
      await page.getByText('Picked up', { exact: false }).first().waitFor();
      const delivery = (await api('GET', '/deliveries?order_id=' + order.id, admin))[0];
      assert.equal(delivery.delivery_mode, 'courier'); assert.equal(delivery.status, 'delivered'); assert.equal(delivery.tracking_number, 'SW-123');
      assert.equal(delivery.pod_recipient, 'J. Courier'); assert.equal(delivery.photo_count, 1);
      console.log('Desktop 1440: courier booked and pickup proven; no customer POD required');
    } else {
      await page.getByText('Swift Cargo', { exact: false }).first().waitFor();
      await page.getByText('Picked up', { exact: false }).first().waitFor();
      console.log('Desktop 390: courier pickup remains readable');
    }
    assert.deepEqual(errors, []); await context.close();
  }
  const product = await api('POST', '/inventory', admin, { name: 'Browser CKD product' }, 201);
  const frame = await api('POST', '/inventory', admin, { name: 'Browser CKD frame', quantity: 3 }, 201);
  const wheel = await api('POST', '/inventory', admin, { name: 'Browser CKD wheel', quantity: 6 }, 201);
  await api('PUT', '/finished-products/' + product.id, admin, { components: [{ component_item_id: frame.id, quantity: 1 }, { component_item_id: wheel.id, quantity: 2 }] });
  const kitOrder = await api('POST', '/orders', admin, { type: 'sale', status: 'approved', customer_name: 'Whole kit browser', items: [{ item_id: product.id, name: 'Browser CKD product', quantity: 2, unit_price: 100, fulfillment_mode: 'ckd' }] }, 201);
  const kitAuthorization = await api('POST', '/release-slips/orders/' + kitOrder.id + '/authorizations', admin, { mode: 'pickup', recipient_name: 'CKD pickup', partial_allowed: true }, 201);
  await api('POST', '/orders/' + kitOrder.id + '/accept-release', admin, {});
  await api('POST', '/orders/' + kitOrder.id + '/release', admin, { bulk: [{ item_id: frame.id, quantity: 1 }] });
  const narrow = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await narrow.addInitScript(token => localStorage.setItem('vds_token', token), admin);
  const kitPage = await narrow.newPage();
  await kitPage.goto(base + '/app'); await kitPage.waitForFunction(() => typeof App !== 'undefined' && App.getMe());
  await kitPage.evaluate(() => App.navigate('releasing', { tab: 'queue' }));
  await kitPage.locator('#rl-picking tr[data-open="' + kitOrder.id + '"]').click();
  assert(await kitPage.locator('#rl-slip').isDisabled());
  await kitPage.getByText('Only complete CKD kits may leave', { exact: false }).waitFor();
  await api('POST', '/orders/' + kitOrder.id + '/release', admin, { bulk: [{ item_id: wheel.id, quantity: 2 }] });
  await kitPage.evaluate(() => App.navigate('releasing', { tab: 'queue' }));
  await kitPage.locator('#rl-picking tr[data-open="' + kitOrder.id + '"]').click();
  assert(await kitPage.locator('#rl-slip').isEnabled());
  console.log('Desktop 390: incomplete CKD kit blocked; one whole kit enables partial slip');
  await api('POST', '/orders/' + kitOrder.id + '/release', admin, { bulk: [{ item_id: frame.id, quantity: 1 }] });
  await kitPage.evaluate(() => App.navigate('releasing', { tab: 'queue' }));
  await kitPage.locator('#rl-picking tr[data-open="' + kitOrder.id + '"]').click();
  assert(await kitPage.locator('#rl-slip').isDisabled());
  await kitPage.getByText('Unreserve extra picked parts or complete another kit', { exact: false }).waitFor();
  await api('POST', '/orders/' + kitOrder.id + '/release/unreserve', admin, { bulk: [{ item_id: frame.id, quantity: 1 }] });
  console.log('Desktop 390: an extra picked CKD component blocks slip until undone');
  const firstKitSlip = await api('POST', '/orders/' + kitOrder.id + '/release-slip', admin,
    { collected_by: 'CKD pickup', authorization_token: kitAuthorization.token }, 201);
  assert(firstKitSlip.id);
  assert.equal((await api('GET', '/inventory/' + frame.id, admin)).quantity, 2);
  assert.equal((await api('GET', '/inventory/' + wheel.id, admin)).quantity, 4);
  await api('POST', '/release-slips/orders/' + kitOrder.id + '/authorizations', admin,
    { mode: 'pickup', recipient_name: 'CKD second pickup', partial_allowed: true }, 201);
  await kitPage.evaluate(() => App.navigate('releasing', { tab: 'queue' }));
  await kitPage.locator('#rl-picking tr[data-open="' + kitOrder.id + '"]').click();
  assert(await kitPage.locator('#rl-slip').isDisabled());
  console.log('Desktop 390: shipped first-kit components cannot enable a new empty trip');
  const spare = await api('POST', '/inventory', admin, { name: 'Browser mixed-order spare', quantity: 1 }, 201);
  const mixedOrder = await api('POST', '/orders', admin, { type: 'sale', status: 'approved', customer_name: 'Mixed browser', items: [
    { item_id: product.id, name: 'Browser CKD product', quantity: 1, unit_price: 100, fulfillment_mode: 'ckd' },
    { item_id: spare.id, name: 'Browser mixed-order spare', quantity: 1, unit_price: 10 },
  ] }, 201);
  await api('POST', '/release-slips/orders/' + mixedOrder.id + '/authorizations', admin, { mode: 'pickup', recipient_name: 'Mixed pickup', partial_allowed: true }, 201);
  await api('POST', '/orders/' + mixedOrder.id + '/accept-release', admin, {});
  await api('POST', '/orders/' + mixedOrder.id + '/release', admin, { bulk: [{ item_id: spare.id, quantity: 1 }] });
  await kitPage.evaluate(() => App.navigate('releasing', { tab: 'queue' }));
  await kitPage.locator('#rl-picking tr[data-open="' + mixedOrder.id + '"]').click();
  assert(await kitPage.locator('#rl-slip').isEnabled());
  console.log('Desktop 390: held spare can ship on a mixed CKD/non-CKD partial slip');
  await narrow.close();
  assert.equal((await api('GET', '/inventory/' + item.id, admin)).quantity, 0);
} finally { await browser?.close(); server.kill('SIGTERM'); }
