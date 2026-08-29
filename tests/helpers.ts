/**
 * Shared test harness. Each test file gets its own throwaway SQLite database and
 * uploads directory by setting DB_PATH / UPLOAD_DIR *before* importing the app, so
 * tests are fully isolated and run with no manual setup.
 *
 * NOTE: app/db are imported dynamically (not at top of file) so the env vars are in
 * place before db.ts opens its connection.
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import supertest from 'supertest';
import type { Express } from 'express';

export interface TestContext {
  app: Express;
  api: supertest.Agent;
  tmpDir: string;
}

export async function setupApp(): Promise<TestContext> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-test-'));
  process.env.DB_PATH = path.join(tmpDir, 'test.db');           // the `default` tenant DB
  process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
  process.env.DATA_DIR = path.join(tmpDir, 'data');             // non-default tenant DBs
  process.env.PLATFORM_DB_PATH = path.join(tmpDir, 'platform.db'); // the SaaS control plane
  delete process.env.ADMIN_PASSWORD;

  const db = await import('../src/db');
  db.init();
  const platform = await import('../src/platform');
  platform._resetPlatformDb(); // drop any cached handle from a previous test file
  const { createApp } = await import('../src/app');
  const app = createApp();
  return { app, api: supertest(app), tmpDir };
}

export function cleanup(ctx: TestContext): void {
  try {
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/** Log in and return the bearer token. */
export async function login(
  api: supertest.Agent,
  username = 'admin',
  password = 'admin123'
): Promise<string> {
  const res = await api.post('/api/auth/login').send({ username, password });
  if (res.status !== 200) throw new Error(`Login failed for ${username}: ${res.status}`);
  return res.body.token as string;
}

/** Convenience: create an employee account (as admin) and return its id + token. */
export async function createEmployee(
  api: supertest.Agent,
  adminToken: string,
  overrides: Record<string, unknown> = {}
): Promise<{ id: number; token: string; username: string; password: string }> {
  const username = (overrides.username as string) || 'emp' + Math.floor(Math.random() * 1e6);
  const password = (overrides.password as string) || 'secret1';
  const res = await api
    .post('/api/users')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ username, full_name: 'Test Employee', password, role: 'admin_staff', ...overrides });
  if (res.status !== 201) throw new Error('Failed to create employee: ' + JSON.stringify(res.body));
  const token = await login(api, username, password);
  return { id: res.body.id, token, username, password };
}
