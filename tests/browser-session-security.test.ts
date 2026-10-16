import { beforeAll, afterAll, it, expect } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';
let ctx: TestContext;
beforeAll(async () => { ctx = await setupApp(); });
afterAll(() => cleanup(ctx));
const browser = { 'X-Session-Mode': 'cookie', 'X-Requested-With': 'VDS' };
it('keeps web credentials HttpOnly and requires CSRF verification, then revokes on logout', async () => {
  const signed = await ctx.api.post('/api/auth/login').set(browser).send({ username: 'admin', password: 'admin123-test-only' });
  expect(signed.status).toBe(200);
  expect(signed.body.token).toBeUndefined();
  const raw = signed.headers['set-cookie']![0] as string;
  expect(raw).toContain('HttpOnly'); expect(raw).toContain('SameSite=Strict');
  const cookie = raw.split(';')[0]!;
  expect((await ctx.api.get('/api/auth/me').set('Cookie', cookie)).status).toBe(200);
  expect((await ctx.api.post('/api/auth/logout').set('Cookie', cookie)).status).toBe(403);
  expect((await ctx.api.post('/api/auth/logout').set(browser).set('Cookie', cookie)).status).toBe(200);
  expect((await ctx.api.get('/api/auth/me').set('Cookie', cookie)).status).toBe(401);
  expect((await ctx.api.post('/api/auth/login').set('X-Session-Mode', 'cookie').send({ username: 'admin', password: 'admin123-test-only' })).status).toBe(403);
});
it('rejects a queued operation from a different signed-in account and revokes changed access', async () => {
  const admin = await login(ctx.api);
  const other = await createEmployee(ctx.api, admin, { username: 'queue-owner' });
  const wrong = await ctx.api.post('/api/inventory').set('Authorization', `Bearer ${admin}`).set('X-Queue-Actor', String(other.id)).send({ name: 'must not write' });
  expect(wrong.status).toBe(409);
  await ctx.api.put(`/api/users/${other.id}/permissions`).set('Authorization', `Bearer ${admin}`).send({ overrides: { 'inventory.adjust': false } });
  expect((await ctx.api.get('/api/auth/me').set('Authorization', `Bearer ${other.token}`)).status).toBe(401);
  const fresh = await login(ctx.api, other.username, other.password);
  expect((await ctx.api.get('/api/auth/me').set('Authorization', `Bearer ${fresh}`)).status).toBe(200);
});
it('uses fresh script nonces, strict script policy and JSON 404s for unknown APIs', async () => {
  const one = await ctx.api.get('/'); const two = await ctx.api.get('/');
  const csp = one.headers['content-security-policy'];
  expect(csp).toContain("script-src 'self' 'nonce-");
  expect(csp).toContain("script-src-attr 'none'");
  expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
  const nonce = /nonce="([^"]+)"/.exec(one.text)![1];
  expect(csp).toContain(`'nonce-${nonce}'`);
  expect(two.text).not.toContain(`nonce="${nonce}"`);
  const missing = await ctx.api.get('/api/does-not-exist').set('Authorization', `Bearer ${await login(ctx.api)}`);
  expect(missing.status).toBe(404); expect(missing.type).toBe('application/json');
  expect(missing.body.request_id).toBe(missing.headers['x-request-id']);
});
it('serves allowlisted, clearly unapproved policy pages without an authenticated tenant', async () => {
  for (const page of ['', '/privacy', '/terms', '/refunds', '/security', '/data-rights', '/ai']) {
    const res = await ctx.api.get('/policies' + page);
    expect(res.status).toBe(200); expect(res.text).toContain('requires owner and legal approval');
    expect(res.headers['cache-control']).toBe('no-store');
  }
  expect((await ctx.api.get('/policies/constructor')).status).toBe(404);
  expect((await ctx.api.get('/policies/private-file')).status).toBe(404);
});
it('enforces read-only AI business tools in production even for a privileged caller', async () => {
  const { productionToolAllowed, executeTool } = await import('../src/modules/ai/ai-tools');
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    expect(productionToolAllowed('get_inventory')).toBe(true);
    expect(productionToolAllowed('propose_form_record')).toBe(true);
    for (const tool of ['adjust_inventory', 'send_email', 'create_user', 'delete_item']) {
      expect(productionToolAllowed(tool)).toBe(false);
      // The guard must run before trusting user/arguments or executing any tool.
      expect((await executeTool(tool, { id: 1 }, {} as any)).success).toBe(false);
    }
  } finally { process.env.NODE_ENV = previous; }
});

it('preserves department and session on an unrelated profile update', async () => {
  const token = await login(ctx.api);
  const headers = { Authorization: `Bearer ${token}` };
  const before = await ctx.api.get('/api/auth/me').set(headers);
  expect((await ctx.api.put('/api/users/1').set(headers).send({ email: 'admin@example.test' })).status).toBe(200);
  const after = await ctx.api.get('/api/auth/me').set(headers);
  expect(after.status).toBe(200);
  expect(after.body.user.department_id).toBe(before.body.user.department_id);
});
it('accepts cookie WebSockets only with the same origin and stops delivery after revocation', async () => {
  const http = await import('node:http');
  const { once } = await import('node:events');
  const { WebSocket } = await import('ws');
  const { attachWebSocket, broadcast } = await import('../src/shared/ws');
  const signed = await ctx.api.post('/api/auth/login').set(browser).send({ username: 'admin', password: 'admin123-test-only' });
  const cookie = (signed.headers['set-cookie']![0] as string).split(';')[0]!;
  const server = http.createServer(ctx.app); attachWebSocket(server);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie, Origin: `http://127.0.0.1:${port}` } });
  try {
    await once(socket, 'open');
    const received = once(socket, 'message');
    broadcast('default', [1], { type: 'test', data: 'authorized' });
    expect(JSON.parse(String((await received)[0])).data).toBe('authorized');
    const hostile = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie, Origin: 'https://evil.example' } });
    await new Promise<void>((resolve, reject) => { hostile.on('open', () => { hostile.terminate(); reject(new Error('hostile origin accepted')); }); hostile.on('error', () => resolve()); });
    const closed = once(socket, 'close');
    await ctx.api.post('/api/auth/logout').set(browser).set('Cookie', cookie);
    broadcast('default', [1], { type: 'test', data: 'must not arrive' });
    expect((await closed)[0]).toBe(1008);
  } finally { socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
