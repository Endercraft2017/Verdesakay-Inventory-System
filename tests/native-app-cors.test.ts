/** The installed phone app (docs/OFFLINE-FIRST.md §29, phase 7a) serves its pages from inside the
    app and calls the API cross-origin: the API answers the app's two origins, and only those,
    only on /api, and never with credentials (cookies). */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, type TestContext } from './helpers';

describe('CORS for the installed app', () => {
  let ctx: TestContext;
  beforeAll(async () => { ctx = await setupApp(); });
  afterAll(() => cleanup(ctx));

  for (const origin of ['https://localhost', 'capacitor://localhost']) {
    it(`answers the preflight from ${origin}`, async () => {
      const res = await ctx.api.options('/api/auth/login')
        .set('Origin', origin)
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'authorization, content-type, x-device-id');
      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe(origin);
      expect(res.headers['access-control-allow-headers']).toMatch(/Authorization/);
      expect(res.headers['access-control-allow-headers']).toMatch(/X-Device-Id/);
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    });
  }

  it('lets the app read responses and the sync headers', async () => {
    const res = await ctx.api.get('/api/health').set('Origin', 'https://localhost');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('https://localhost');
    expect(res.headers['vary']).toMatch(/Origin/);
    expect(res.headers['access-control-expose-headers']).toMatch(/X-Sync-State/);
  });

  it('gives any other website nothing', async () => {
    for (const origin of ['https://evil.example', 'http://localhost', 'https://localhost.evil.example']) {
      const res = await ctx.api.get('/api/health').set('Origin', origin);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      const pre = await ctx.api.options('/api/auth/login').set('Origin', origin)
        .set('Access-Control-Request-Method', 'POST');
      expect(pre.headers['access-control-allow-origin']).toBeUndefined();
    }
  });

  it('is limited to /api', async () => {
    const res = await ctx.api.get('/m/').set('Origin', 'https://localhost');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
