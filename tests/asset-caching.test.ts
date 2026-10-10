/** Desktop shell assets are content-versioned (src/shared/asset-version.ts): the shell names each
    script/style with `?v=<content hash>`, a request carrying the current hash is cacheable for a
    year (browser + CDN), and anything else still revalidates. The phone shell stays unversioned
    because its service worker precaches the plain URLs. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { setupApp, cleanup, type TestContext } from './helpers';
import { assetHash, versionAssetUrls, staticCacheControl, IMMUTABLE } from '../src/shared/asset-version';

const PUBLIC = path.join(import.meta.dirname, '..', 'public');
let ctx: TestContext;
beforeAll(async () => { ctx = await setupApp(); });
afterAll(() => cleanup(ctx));

describe('versioned desktop shell', () => {
  it('names every local script and stylesheet by its content hash', async () => {
    const res = await ctx.api.get('/index.html');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-cache');
    const appHash = assetHash(path.join(PUBLIC, 'js/app.js'));
    expect(res.text).toContain(`src="/js/app.js?v=${appHash}"`);
    expect(res.text).toMatch(/href="\/css\/styles\.css\?v=[0-9a-f]{12}"/);
    // No script or stylesheet left unversioned.
    expect(res.text).not.toMatch(/(src|href)="\/[^"?]+\.(js|css)"/);
  });

  it('serves the current version immutably and anything else with revalidation', async () => {
    const v = assetHash(path.join(PUBLIC, 'js/app.js'));
    const current = await ctx.api.get(`/js/app.js?v=${v}`);
    expect(current.status).toBe(200);
    expect(current.headers['cache-control']).toBe(IMMUTABLE);
    expect((await ctx.api.get('/js/app.js?v=000000000000')).headers['cache-control']).toBe('no-cache');
    expect((await ctx.api.get('/js/app.js')).headers['cache-control']).toBe('no-cache');
  });

  it('leaves the phone shell on plain URLs for its service worker', async () => {
    const res = await ctx.api.get('/mobile/index.html');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('?v=');
  });
});

describe('asset-version helpers', () => {
  it('rehashes a file when it changes and skips references to missing files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-assets-'));
    try {
      const file = path.join(dir, 'a.js');
      fs.writeFileSync(file, 'one');
      const first = assetHash(file);
      fs.writeFileSync(file, 'two, longer');
      const second = assetHash(file);
      expect(first).not.toBe(second);
      expect(staticCacheControl(file, second)).toBe(IMMUTABLE);
      expect(staticCacheControl(file, first)).toBe('no-cache');
      expect(staticCacheControl(file, undefined)).toBe('no-cache');
      expect(versionAssetUrls('<script src="/a.js"></script><script src="/gone.js"></script><a href="//cdn/x.js">', dir))
        .toBe(`<script src="/a.js?v=${second}"></script><script src="/gone.js"></script><a href="//cdn/x.js">`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
