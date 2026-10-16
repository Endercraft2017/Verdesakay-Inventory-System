/** The desktop installer download (src/desktop/desktop.routes.ts, docs/OFFLINE-FIRST.md §17) —
 *  work in progress: unpublished until an installer is placed in DESKTOP_INSTALLER_DIR. */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, type TestContext } from './helpers';

let ctx: TestContext;
let admin: string;
const hdr = () => ({ Authorization: `Bearer ${admin}` });

beforeAll(async () => {
  ctx = await setupApp();
  admin = await login(ctx.api);
  delete process.env.DESKTOP_INSTALLER_DIR;
});
afterAll(() => {
  delete process.env.DESKTOP_INSTALLER_DIR;
  cleanup(ctx);
});

describe('desktop installer download', () => {
  it('says "not published yet" while nothing is published', async () => {
    expect((await ctx.api.get('/api/desktop/installer/info').set(hdr())).body).toEqual({ available: false });
    const r = await ctx.api.get('/api/desktop/installer').set(hdr());
    expect(r.status).toBe(404);
    expect(r.body.error).toMatch(/not published yet/);
  });

  it('serves the newest installer once one is published', async () => {
    const dir = path.join(ctx.tmpDir, 'installers');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'Verdesakay Setup 0.9.0.exe'), 'old');
    await new Promise((r) => setTimeout(r, 20));
    fs.writeFileSync(path.join(dir, 'Verdesakay Setup 1.0.0.exe'), 'new installer bytes');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');
    process.env.DESKTOP_INSTALLER_DIR = dir;
    const info = (await ctx.api.get('/api/desktop/installer/info').set(hdr())).body;
    expect(info).toMatchObject({ available: true, file: 'Verdesakay Setup 1.0.0.exe', size: 19 });
    const dl = await ctx.api.get('/api/desktop/installer').set(hdr()).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(dl.status).toBe(200);
    expect(String(dl.headers['content-disposition'])).toContain('Verdesakay Setup 1.0.0.exe');
    expect((dl.body as Buffer).toString()).toBe('new installer bytes');
  });

  it('is for admins only', async () => {
    await ctx.api.post('/api/users').set(hdr()).send({ username: 'clerk-dl', full_name: 'Clerk', password: 'clerkpass1-test-only', role: 'warehouse' });
    const t = await login(ctx.api, 'clerk-dl', 'clerkpass1-test-only');
    expect((await ctx.api.get('/api/desktop/installer/info').set({ Authorization: `Bearer ${t}` })).status).toBe(403);
    expect((await ctx.api.get('/api/desktop/installer/info')).status).toBe(401);
  });
});
