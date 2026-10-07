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
  /** Closes this test file's database handles so cleanup() can delete tmpDir (Windows refuses to
      delete an open SQLite file, which used to leave every %TEMP%ds-test-* folder behind). */
  closeDb?: () => void;
}

export async function setupApp(): Promise<TestContext> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-test-'));
  process.env.DB_PATH = path.join(tmpDir, 'test.db');           // the `default` tenant DB
  process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
  process.env.DATA_DIR = path.join(tmpDir, 'data');             // non-default tenant DBs
  process.env.PLATFORM_DB_PATH = path.join(tmpDir, 'platform.db'); // the SaaS control plane
  delete process.env.ADMIN_PASSWORD;

  const db = await import('../src/shared/db');
  db.init();
  // Test punches happen at whatever the real wall-clock time is; without this, any test that
  // punches after 17:00 would see its first punch recorded as a forgot-to-time-in time-out
  // (src/modules/hr/clock.ts firstPunchOutAfter). Tests of that rule set it explicitly.
  db.setSetting('clock_policy', { first_punch_out_after: '24:00' });
  const platform = await import('../src/platform/platform');
  platform._resetPlatformDb(); // drop any cached handle from a previous test file
  const { createApp } = await import('../src/app');
  const app = createApp();
  const closeDb = () => { db.closeAllConnections(); platform._resetPlatformDb(); };
  return { app, api: supertest(app), tmpDir, closeDb };
}

export function cleanup(ctx: TestContext): void {
  try { ctx.closeDb?.(); } catch { /* best effort */ }
  try {
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
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

/** Add `count` serialized units to a released, QC-gated (qc_stages > 0) job order via
    POST /:id/units — that endpoint replaced bulk done_delta for serialized job orders
    (see job-orders.routes.ts), so every test that just needs some pending units to exist,
    rather than testing production-recording itself, creates them this way. Returns the
    created unit ids. */
export async function addSerializedUnits(
  api: supertest.Agent,
  token: string,
  jobOrderId: number,
  count: number,
  identifierPrefix = 'U',
  batchLabel?: string
): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    // Identifier + the required photo travel together as one multipart request.
    let req = api
      .post(`/api/job-orders/${jobOrderId}/units`)
      .set('Authorization', `Bearer ${token}`)
      .field('identifier', `${identifierPrefix}-${Date.now()}-${i}-${Math.floor(Math.random() * 1e6)}`);
    if (batchLabel) req = req.field('batch_label', batchLabel);
    const res = await req.attach('image', Buffer.from('unit-photo'), 'unit.png');
    if (res.status !== 201) throw new Error(`Failed to add unit: ${JSON.stringify(res.body)}`);
    ids.push(res.body.id as number);
  }
  return ids;
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
