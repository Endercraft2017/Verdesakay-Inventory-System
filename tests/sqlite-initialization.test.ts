import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';

const driver = path.resolve('tests/helpers/sqlite-startup-worker.ts');
const roots: string[] = [];
interface Running {
  child: ChildProcess;
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  output: () => string;
}
const children: Running[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-startup-')); roots.push(root);
  const env = { ...process.env, NODE_ENV: 'test', DEPLOY_MODE: 'cloud', ADMIN_PASSWORD: 'Synthetic startup audit fixture',
    DB_PATH: path.join(root, 'data.db'), DATA_DIR: path.join(root, 'tenants'), PLATFORM_DB_PATH: path.join(root, 'platform.db'),
    UPLOAD_DIR: path.join(root, 'uploads'), BACKUP_DIR: path.join(root, 'backups'), PLATFORM_ADMIN_USERNAME: '', PLATFORM_ADMIN_PASSWORD: '' };
  return { root, env };
}
function launch(f: ReturnType<typeof fixture>, mode: string, marker: string, override: Record<string, string> = {}): Running {
  const child = spawn(process.execPath, ['--import', 'tsx', driver, mode, f.root, marker], { env: { ...f.env, ...override }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const done = once(child, 'exit').then(([code, signal]) => ({ code, signal }));
  const item = { child, done, output: () => output }; children.push(item); return item;
}
async function waitFor(file: string, child: ChildProcess) {
  const deadline = Date.now() + 15_000;
  while (!fs.existsSync(file)) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Startup process exited before barrier');
    if (Date.now() > deadline) throw new Error('Startup process did not reach its barrier');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function success(c: ReturnType<typeof launch>) { expect((await c.done).code, c.output()).toBe(0); }
const read = (f: ReturnType<typeof fixture>, marker: string) => JSON.parse(fs.readFileSync(path.join(f.root, marker + '.json'), 'utf8'));
const release = (f: ReturnType<typeof fixture>) => fs.writeFileSync(path.join(f.root, 'release'), 'go');
function snapshot(f: ReturnType<typeof fixture>) {
  const db = new DatabaseSync(f.env.DB_PATH, { readOnly: true });
  try { return { payroll: db.prepare("SELECT data,status,revision FROM form_records WHERE number='STARTUP-PAYROLL-1'").all(),
    settings: db.prepare("SELECT value FROM settings WHERE key='startup_sentinel'").all(),
    admins: db.prepare("SELECT COUNT(*) AS n FROM users WHERE username='admin'").get(),
    integrity: db.prepare('PRAGMA integrity_check').all(), foreignKeys: db.prepare('PRAGMA foreign_key_check').all() }; }
  finally { db.close(); }
}
afterEach(async () => {
  for (const c of children.splice(0)) { if (c.child.exitCode === null && c.child.signalCode === null) c.child.kill('SIGKILL'); await c.done; }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it('waits for competing cold initialization and preserves saved payroll/settings', async () => {
  const f = fixture(); await success(launch(f, 'seed', 'seed')); const before = snapshot(f);
  const first = launch(f, 'warm-hold', 'first'); await waitFor(path.join(f.root, 'held'), first.child);
  const second = launch(f, 'open', 'second'); await waitFor(path.join(f.root, 'second-started'), second.child);
  await new Promise(resolve => setTimeout(resolve, 150));
  expect(fs.existsSync(path.join(f.root, 'second.json'))).toBe(false); release(f);
  await success(first); await success(second); expect(snapshot(f)).toEqual(before);
  expect(read(f, 'second')).toMatchObject({ ok: true, busy_timeout: 0, transaction_open: false });
});

it('serializes first-run read-before-insert and creates one administrator', async () => {
  const f = fixture(), first = launch(f, 'fresh-hold', 'first'); await waitFor(path.join(f.root, 'held'), first.child);
  const second = launch(f, 'open', 'second'); await waitFor(path.join(f.root, 'second-started'), second.child);
  await new Promise(resolve => setTimeout(resolve, 150));
  expect(fs.existsSync(path.join(f.root, 'second-empty'))).toBe(false); release(f);
  await success(first); await success(second); expect(snapshot(f).admins).toEqual({ n: 1 });
});

it('releases initialization ownership after a real process kill', async () => {
  const f = fixture(); await success(launch(f, 'seed', 'seed')); const before = snapshot(f);
  const first = launch(f, 'warm-hold', 'first'); await waitFor(path.join(f.root, 'held'), first.child);
  const second = launch(f, 'open', 'second'); await waitFor(path.join(f.root, 'second-started'), second.child);
  first.child.kill('SIGKILL'); expect((await first.done).signal).toBe('SIGKILL');
  await success(second); expect(snapshot(f)).toEqual(before);
});

it('serializes first-run control-plane setup and restores its runtime wait policy', async () => {
  const f = fixture(), first = launch(f, 'catalog-hold', 'first'); await waitFor(path.join(f.root, 'held'), first.child);
  const second = launch(f, 'catalog-open', 'second'); await waitFor(path.join(f.root, 'second-started'), second.child);
  await new Promise(resolve => setTimeout(resolve, 150));
  expect(fs.existsSync(path.join(f.root, 'second.json'))).toBe(false); release(f);
  await success(first); await success(second);
  expect(read(f, 'first')).toMatchObject({ ok: true, operators: 1, busy_timeout: 0 });
  expect(read(f, 'second')).toMatchObject({ ok: true, operators: 1, busy_timeout: 0 });
});

it('does not serialize unrelated database paths', async () => {
  const f = fixture(), first = launch(f, 'lock-hold', 'first'); await waitFor(path.join(f.root, 'held'), first.child);
  const other = launch(f, 'lock-open', 'other', { DB_PATH: path.join(f.root, 'independent.db') });
  await success(other); expect(read(f, 'other')).toMatchObject({ ok: true, entered: true });
  expect(fs.existsSync(path.join(f.root, 'first.json'))).toBe(false); release(f); await success(first);
});

// Exercise the real ten-second busy budget; allow child launch/cleanup overhead without
// relaxing the requirement that the blocked callback never executes and retry succeeds.
it('bounds a persistent startup lock and permits retry after release', async () => {
  const f = fixture(), first = launch(f, 'lock-hold', 'first'); await waitFor(path.join(f.root, 'held'), first.child);
  const blocked = launch(f, 'lock-open', 'blocked'); await success(blocked);
  expect(read(f, 'blocked')).toMatchObject({ ok: false, errcode: 5 });
  expect(read(f, 'blocked').entered).toBeUndefined(); expect(read(f, 'blocked').elapsed_ms).toBeGreaterThanOrEqual(9500);
  release(f); await success(first); const retry = launch(f, 'lock-open', 'retry'); await success(retry);
  expect(read(f, 'retry')).toMatchObject({ ok: true, entered: true });
}, 35_000);

it('evicts a catalog connection whose operator seed failed, then retries initialization', async () => {
  const f = fixture(), c = launch(f, 'catalog-retry', 'catalog'); await success(c);
  expect(read(f, 'catalog')).toMatchObject({ ok: true, first_failed: true, operators: 1, busy_timeout: 0 });
});

it('preserves filesystem-free initialization for private in-memory databases', async () => {
  const f = fixture(), tenant = launch(f, 'memory', 'tenant', { DB_PATH: ':memory:' }); await success(tenant);
  expect(read(f, 'tenant')).toMatchObject({ ok: true, memory_lock_files: [], busy_timeout: 0 });
  const catalog = launch(f, 'catalog-memory', 'catalog', { PLATFORM_DB_PATH: ':memory:' }); await success(catalog);
  expect(read(f, 'catalog')).toMatchObject({ ok: true, memory_lock_files: [], busy_timeout: 0 });
});
