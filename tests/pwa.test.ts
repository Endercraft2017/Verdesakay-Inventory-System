/** The mobile PWA plumbing: manifest + service worker are served, and the SW
 *  carries the Service-Worker-Allowed header so it can claim the /m scope. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => { ctx = await setupApp(); });
afterAll(() => cleanup(ctx));

describe('mobile PWA', () => {
  it('serves the web manifest', async () => {
    const res = await ctx.api.get('/mobile/manifest.webmanifest');
    expect(res.status).toBe(200);
    expect(res.body.start_url ?? JSON.parse(res.text).start_url).toBe('/m');
  });

  it('serves sw.js with a broadened scope and no-cache', async () => {
    const res = await ctx.api.get('/mobile/sw.js');
    expect(res.status).toBe(200);
    expect(res.headers['service-worker-allowed']).toBe('/m');
    expect(res.headers['cache-control']).toMatch(/no-cache/);
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.text).toContain('vds-flush');
  });

  it('the icons exist', async () => {
    for (const n of ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png']) {
      const res = await ctx.api.get('/mobile/icons/' + n);
      expect(res.status, n).toBe(200);
      expect(res.headers['content-type']).toMatch(/image\/png/);
    }
  });
});
