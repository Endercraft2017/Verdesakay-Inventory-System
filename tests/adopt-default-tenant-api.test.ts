import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { setupApp, cleanup, login, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => { process.env.APP_DOMAIN = 'otom.afkcube.com'; ctx = await setupApp(); });
afterAll(() => {
  delete process.env.TENANT_PATH_HOST;
  delete process.env.DEFAULT_TENANT_REDIRECT;
  delete process.env.APP_DOMAIN;
  cleanup(ctx);
});

it('runs the migration CLI on a real app database and serves its existing company at the new URL', async () => {
  const token = await login(ctx.api);
  const item = await ctx.api.post('/api/inventory').set('Authorization', `Bearer ${token}`).send({ name: 'Original company item', quantity: 7 });
  expect(item.status).toBe(201);
  fs.writeFileSync(path.join(process.env.UPLOAD_DIR!, 'original-document.pdf'), 'original document bytes');
  const db = await import('../src/shared/db');
  db.closeAllConnections(); // no open source writers during the actual CLI migration
  const source = fs.readFileSync(process.env.DB_PATH!);
  const run = (...extra: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/adopt-default-tenant.ts', '--slug', 'verdesakay', '--name', 'Verdesakay', ...extra], { cwd: path.join(import.meta.dirname, '..'), env: process.env, encoding: 'utf8' });
  const preview = run();
  expect(preview.status, preview.stderr).toBe(0);
  expect(JSON.parse(preview.stdout)).toMatchObject({ applied: false, users: 1, files: 1 });
  const migrated = run('--apply', '--server-stopped');
  expect(migrated.status, migrated.stderr).toBe(0);
  const report = JSON.parse(migrated.stdout);
  expect(report.applied).toBe(true);
  expect(fs.readFileSync(path.join(report.recovery, 'source.db'))).toEqual(fs.readFileSync(report.target_database));
  expect(fs.readFileSync(process.env.DB_PATH!)).toEqual(source);
  process.env.TENANT_PATH_HOST = 'otom.afkcube.com';
  process.env.DEFAULT_TENANT_REDIRECT = 'verdesakay';
  const signedIn = await ctx.api.post('/verdesakay/api/auth/login').set('Host', 'otom.afkcube.com').send({ username: 'admin', password: 'admin123' });
  expect(signedIn.status).toBe(200);
  const headers = { Host: 'otom.afkcube.com', Authorization: `Bearer ${signedIn.body.token}` };
  const items = await ctx.api.get('/verdesakay/api/inventory').set(headers);
  expect(items.status).toBe(200);
  expect(items.body).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Original company item', quantity: 7 })]));
  expect((await ctx.api.get('/verdesakay/api/tenant').set(headers)).body).toMatchObject({ slug: 'verdesakay', name: 'Verdesakay', plan: 'unlimited' });
  expect((await ctx.api.get('/api/health').set('Host', 'otom.afkcube.com')).body.ok).toBe(true);
  expect((await ctx.api.get('/api/inventory').set('Host', 'legacy-service.up.railway.app').set('Authorization', `Bearer ${token}`)).status).toBe(410);
  expect((await ctx.api.get('/').set('Host', 'legacy-service.up.railway.app')).headers.location).toBe('https://otom.afkcube.com/verdesakay/');
  expect(fs.readFileSync(process.env.DB_PATH!)).toEqual(source); // new URL/health never open the original DB
  const { runManualBackup } = await import('../src/platform/backups');
  const backups = runManualBackup();
  expect(backups.every(result => result.ok)).toBe(true);
  expect(backups.some(result => result.name === 'default')).toBe(false);
  expect(backups.some(result => result.name === 'verdesakay')).toBe(true);
  expect(fs.readFileSync(process.env.DB_PATH!)).toEqual(source);
  expect(fs.readFileSync(path.join(process.env.UPLOAD_DIR!, 'original-document.pdf'), 'utf8')).toBe('original document bytes');
  expect(fs.readFileSync(path.join(process.env.UPLOAD_DIR!, 'verdesakay', 'original-document.pdf'), 'utf8')).toBe('original document bytes');
});
