import http from 'node:http';
import { once } from 'node:events';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';
let ctx: TestContext;
let token: string;
beforeAll(async () => { ctx = await setupApp(); token = await login(ctx.api); });
afterAll(() => cleanup(ctx));

describe('production security regression', () => {
  it('returns private API responses without caching and rejects hostile CORS', async () => {
    const result = await ctx.api.get('/api/auth/me').set('Origin', 'https://evil.example');
    expect(result.status).toBe(401);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.headers['access-control-allow-origin']).toBeUndefined();
    expect(result.headers['x-content-type-options']).toBe('nosniff');
    expect(result.headers['x-frame-options']).toBe('DENY');
    expect((await ctx.api.get('/').set('Cookie', 'vds_view=%broken')).status).toBe(200);
  });

  it('prevents workspace identifiers from escaping the database directory', async () => {
    const { getDb } = await import('../src/shared/db');
    for (const slug of ['../escape', '/tmp/escape', 'a/b', 'a\\b', '..', 'a.db']) {
      expect(() => getDb(slug)).toThrow('Invalid workspace identifier');
    }
  });

  it('uses separate fallback encryption keys for each tenant', async () => {
    const { withTenant, getSetting } = await import('../src/shared/db');
    const { encryptSecret, decryptSecret } = await import('../src/shared/secrets');
    const a = withTenant('crypt-a', () => ({ blob: encryptSecret('tenant-a-only'), key: getSetting('_secret_key') }));
    const b = withTenant('crypt-b', () => ({ blob: encryptSecret('tenant-b-only'), key: getSetting('_secret_key') }));
    expect(a.key).not.toBe(b.key);
    expect(withTenant('crypt-a', () => decryptSecret(a.blob))).toBe('tenant-a-only');
    expect(withTenant('crypt-b', () => decryptSecret(a.blob))).toBe('');
  });

  it('does not deliver websocket messages after server-side logout', async () => {
    const account = await createEmployee(ctx.api, token, { username: 'socket-revoke' });
    const { attachWebSocket, broadcast } = await import('../src/shared/ws');
    const server = http.createServer(ctx.app);
    attachWebSocket(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${account.token}`);
    try {
      await once(socket, 'open');
      await ctx.api.post('/api/auth/logout').set('Authorization', `Bearer ${account.token}`);
      const closed = once(socket, 'close');
      const received: unknown[] = [];
      socket.on('message', data => received.push(data));
      broadcast('default', [account.id], { type: 'message:new', data: { secret: true } });
      const [code] = await closed;
      expect(code).toBe(1008);
      expect(received).toEqual([]);
    } finally {
      socket.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('revokes platform operator sessions when a password is reset', async () => {
    const operators = await import('../src/platform/platform-users');
    operators.upsertPlatformUser('audit-operator', 'old-password');
    const session = operators.platformLogin('audit-operator', 'old-password');
    expect(operators.platformUserFromToken(session)).not.toBeNull();
    operators.upsertPlatformUser('audit-operator', 'new-password');
    expect(operators.platformUserFromToken(session)).toBeNull();
  });

  it('throttles password recovery outside test mode', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const { createApp } = await import('../src/app');
      const supertest = (await import('supertest')).default;
      const api = supertest(createApp());
      for (let i = 0; i < 20; i++) {
        expect((await api.post('/api/auth/reset-password').send({ token: 'invalid-token-' + i, new_password: 'secret123' })).status).toBe(400);
      }
      expect((await api.post('/api/auth/reset-password').send({ token: 'invalid-token-last', new_password: 'secret123' })).status).toBe(429);
    } finally { process.env.NODE_ENV = previous; }
  });
});

it('classifies ZAP metadata alert as the SPA fallback, not a metadata proxy', async () => {
  const root = await ctx.api.get('/');
  const probe = await ctx.api.get('/metadata/instance?password=ZAP&username=ZAP').set('Host', '169.254.169.254');
  expect(probe.status).toBe(200);
  expect(probe.type).toBe('text/html');
  const normalize = (html: string) => html.replace(/nonce="[^"]+"/g, 'nonce="NONCE"').replace(/window.VDS_CSP_NONCE="[^"]+"/g, 'window.VDS_CSP_NONCE="NONCE"');
  expect(normalize(probe.text)).toBe(normalize(root.text));
  expect(probe.text).not.toMatch(/AccessKeyId|SecretAccessKey|instanceId|compute.*subscriptionId/);
});

it('refuses a fresh production default password and never prints a configured bootstrap password', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-bootstrap-audit-'));
  try {
    const env = { ...process.env, NODE_ENV: 'production', ADMIN_PASSWORD: '', DB_PATH: path.join(dir, 'app.db'), DATA_DIR: path.join(dir, 'data'), UPLOAD_DIR: path.join(dir, 'uploads'), BACKUP_DIR: path.join(dir, 'backups') };
    const args = ['--import', 'tsx', '--input-type=module', '-e', "const db = await import('./src/shared/db.ts'); db.init(); db.closeAllConnections();"];
    const rejected = spawnSync(process.execPath, args, { env, encoding: 'utf8' });
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain('Set ADMIN_PASSWORD');
    const password = 'audit-bootstrap-password-strong';
    const accepted = spawnSync(process.execPath, args, { env: { ...env, ADMIN_PASSWORD: password }, encoding: 'utf8' });
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(accepted.stdout + accepted.stderr).not.toContain(password);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
