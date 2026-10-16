import { test, expect } from '@playwright/test';

test('console verifies real WebAuthn registration and sign-in, rejects replay, and protects the last key', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: 'http://localhost:4173' });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const authenticator = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true
  }});
  await page.goto('/_platform/');
  await page.locator('#lu').fill('browser-operator');
  await page.locator('#lp').fill('Synthetic browser operator password');
  await page.locator('#login-form button').click();
  await expect(page.locator('#app')).toBeVisible();
  await page.getByRole('button', { name: 'Account & security' }).click();
  await page.getByRole('button', { name: 'Manage passkeys' }).click();
  await page.locator('#pk-password').fill('Synthetic browser operator password');
  const enrolled = page.waitForResponse(r => r.url().endsWith('/passkeys/register/verify'));
  await page.locator('#pk-add').click();
  expect((await enrolled).status()).toBe(200);
  await expect(page.locator('#pk-list')).toContainText('My Windows computer');
  await expect(page.getByRole('button', { name: 'Remove', exact: true })).toBeDisabled();
  await page.locator('#pk-close').click();
  await page.locator('#logout').click();
  // No authenticated cookie/session is issued at the password stage.
  const passwordStage = await context.request.post('/_platform/api/login', {
    headers: { 'X-Requested-With':'VDS', 'X-Session-Mode':'cookie' },
    data: { username:'browser-operator', password:'Synthetic browser operator password' }
  });
  expect((await passwordStage.json()).passkey_required).toBe(true);
  expect(passwordStage.headers()['set-cookie']).toBeUndefined();
  expect((await context.request.get('/_platform/api/tenants')).status()).toBe(401);
  await page.locator('#lp').fill('Synthetic browser operator password');
  const signed = page.waitForResponse(r => r.url().endsWith('/passkeys/login'));
  await page.locator('#login-form button').click();
  const signedResponse = await signed;
  expect(signedResponse.status()).toBe(200);
  await expect(page.locator('#app')).toBeVisible();
  const proof = signedResponse.request().postDataJSON();
  expect((await context.request.post('/_platform/api/passkeys/login', {
    headers: { 'X-Requested-With':'VDS', 'X-Session-Mode':'cookie' }, data: proof
  })).status()).toBe(400);
  // Fresh proof permits policy activation; last-key removal remains forbidden.
  await page.getByRole('button', { name: 'Account & security' }).click();
  await page.getByRole('button', { name: 'Manage passkeys' }).click();
  const policy = page.waitForResponse(r => r.url().endsWith('/passkeys/require'));
  await page.locator('#pk-require').click();
  expect((await policy).status()).toBe(200);
  const removal = await context.request.post('/_platform/api/passkeys/remove', {
    headers: { 'X-Requested-With':'VDS', 'X-Session-Mode':'cookie' },
    data: { id:proof.response.id, current_password:'Synthetic browser operator password' }
  });
  expect(removal.status()).toBe(409);
  // A correctly signed assertion without local user verification must still fail.
  await cdp.send('WebAuthn.setUserVerified', { authenticatorId: authenticator.authenticatorId, isUserVerified: false });
  const noUVChallenge = await context.request.post('/_platform/api/login', {
    headers: { 'X-Requested-With':'VDS', 'X-Session-Mode':'cookie' },
    data: { username:'browser-operator', password:'Synthetic browser operator password' }
  });
  const noUV = await noUVChallenge.json();
  const unverified = await page.evaluate(async (options) => {
    // A hostile client may relax the browser prompt; the server must independently require UV.
    return (window as any).ConsoleWebAuthn.startAuthentication({ optionsJSON: { ...options, userVerification:'discouraged' } });
  }, noUV.options);
  expect((await context.request.post('/_platform/api/passkeys/login', {
    headers: { 'X-Requested-With':'VDS', 'X-Session-Mode':'cookie' }, data: { token:noUV.token, response:unverified }
  })).status()).toBe(400);
  await cdp.send('WebAuthn.setUserVerified', { authenticatorId: authenticator.authenticatorId, isUserVerified:true });
  await context.close();
});
