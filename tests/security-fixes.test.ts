/** Regression tests for the 2026-10-10 security audit fixes (docs/reviews/security-audit-2026-10-10.md). */
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { setupApp, cleanup, login, type TestContext } from './helpers';

let ctx: TestContext;
let admin: string;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  // Read once when shared/hosting.ts loads — set before the app is imported.
  process.env.CLIENT_IP_HEADER = 'x-real-ip';
  ctx = await setupApp();
  admin = await login(ctx.api);
});
afterAll(() => { delete process.env.CLIENT_IP_HEADER; cleanup(ctx); });

describe('QuickBooks OAuth callback (H1, H2)', () => {
  it('escapes what it echoes back', async () => {
    const res = await ctx.api.get('/api/quickbooks/callback').query({ error: '<script>alert(1)</script>' });
    expect(res.text).not.toContain('<script>alert(1)</script>');
    expect(res.text).toContain('&#60;script&#62;');
  });

  it('never opens or creates a database for a workspace that does not exist', async () => {
    const res = await ctx.api.get('/api/quickbooks/callback').query({ state: 'ghostco.' + 'a'.repeat(32), code: 'c', realmId: 'r' });
    expect(res.status).toBe(400);
    expect(res.text).toContain('Unknown workspace');
    expect(fs.existsSync(path.join(process.env.DATA_DIR!, 'ghostco.db'))).toBe(false);
  });
});

describe('client IP and headers (M1, M3)', () => {
  it('records the edge proxy\'s client address, not the connecting hop', async () => {
    await ctx.api.post('/api/users').set(bearer(admin))
      .send({ username: 'ipcheck', full_name: 'IP Check', password: 'ipcheck-pass-1-test-only', role: 'admin' });
    const login1 = await ctx.api.post('/api/auth/login').set('X-Real-IP', '203.0.113.7').send({ username: 'ipcheck', password: 'ipcheck-pass-1-test-only' });
    const sessions = await ctx.api.get('/api/auth/sessions').set(bearer(login1.body.token));
    expect(sessions.body[0].ip).toBe('203.0.113.7');
  });

  it('limits browser features to what the app uses', async () => {
    const res = await ctx.api.get('/api/health');
    expect(res.headers['permissions-policy']).toContain('camera=(self)');
    expect(res.headers['permissions-policy']).toContain('microphone=()');
  });
});

describe('passwords (M2)', () => {
  it('rejects short and common passwords for new accounts', async () => {
    const short = await ctx.api.post('/api/users').set(bearer(admin)).send({ username: 'pw1', full_name: 'Pw', password: 'abc1234', role: 'admin' });
    expect(short.status).toBe(400);
    const common = await ctx.api.post('/api/users').set(bearer(admin)).send({ username: 'pw2', full_name: 'Pw', password: 'PasswordPassword', role: 'admin' });
    expect(common.status).toBe(400);
    const good = await ctx.api.post('/api/users').set(bearer(admin)).send({ username: 'pw3', full_name: 'Pw', password: 'tide-lamp-9-test-only', role: 'admin' });
    expect(good.status).toBe(201);
  });
});

describe('activity log redaction (M5)', () => {
  it('never stores a provider API key', async () => {
    await ctx.api.put('/api/ai/config').set(bearer(admin)).send({ api_key: 'sk-test-SHOULD-NOT-LOG' });
    await new Promise((r) => setTimeout(r, 30));
    const { queryAll } = await import('../src/shared/db');
    const rows = queryAll<Record<string, unknown>>("SELECT * FROM activity_log WHERE path LIKE '%ai/config%'");
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain('SHOULD-NOT-LOG');
  });
});

describe('chat attachments (L4)', () => {
  it('serves anything but a plain image as a download', async () => {
    const u = await ctx.api.post('/api/users').set(bearer(admin))
      .send({ username: 'chatpal', full_name: 'Chat Pal', password: 'chatpal-pass-1-test-only', role: 'admin' });
    const send = await ctx.api.post('/api/messages').set(bearer(admin))
      .field('recipient_id', String(u.body.id)).field('body', 'see attached')
      .attach('files', Buffer.from('<script>alert(1)</script>'), { filename: 'page.html', contentType: 'text/html' });
    const { queryOne } = await import('../src/shared/db');
    const att = queryOne<{ id: number }>('SELECT id FROM message_attachments WHERE message_id = ?', send.body.id)!;
    const res = await ctx.api.get(`/api/messages/${send.body.id}/attachments/${att.id}`).set(bearer(admin));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/octet-stream/);
    expect(res.headers['content-disposition']).toMatch(/^attachment;/);
  });
});

describe('idempotency replay (L5)', () => {
  it('replays a stored outcome only to the user who produced it', async () => {
    const key = 'audit-idem-key-0001';
    const first = await ctx.api.post('/api/notes').set(bearer(admin)).set('Idempotency-Key', key).send({ title: 'mine', body: 'private note' });
    expect(first.status).toBeLessThan(300);
    const again = await ctx.api.post('/api/notes').set(bearer(admin)).set('Idempotency-Key', key).send({ title: 'mine', body: 'private note' });
    expect(again.headers['idempotency-replayed']).toBe('true');
    const other = await login(ctx.api, 'chatpal', 'chatpal-pass-1-test-only');
    const stranger = await ctx.api.post('/api/notes').set(bearer(other)).set('Idempotency-Key', key).send({ title: 'x', body: 'y' });
    expect(stranger.headers['idempotency-replayed']).toBeUndefined();
    const anonymous = await ctx.api.post('/api/notes').set('Idempotency-Key', key).send({});
    expect(anonymous.status).toBe(401);
  });
});

describe('Content-Security-Policy (M3)', () => {
  it('allows only this server\'s scripts plus the page\'s own nonce', async () => {
    for (const page of ['/index.html', '/mobile/index.html']) {
      const res = await ctx.api.get(page);
      const csp = String(res.headers['content-security-policy'] || '');
      const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
      expect(nonce, page).toBeTruthy();
      expect(csp).toContain("script-src 'self' 'nonce-");
      expect(csp).toContain("object-src 'none'");
      expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
      // Every inline <script> in the shell carries this response's nonce; none is left bare.
      expect(res.text).not.toMatch(/<script>/);
      expect(res.text).toContain(`<script nonce="${nonce}">`);
    }
    // A fresh nonce per response.
    const a = String((await ctx.api.get('/index.html')).headers['content-security-policy']);
    const b = String((await ctx.api.get('/index.html')).headers['content-security-policy']);
    expect(a).not.toBe(b);
  });
});
