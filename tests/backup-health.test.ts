/** Backup health (src/platform/backup-health.ts): the off-site restore drill, the health check, and
    alerts to BACKUP_ALERT_WEBHOOK — against an in-process fake S3 bucket and a fake webhook. */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, type TestContext } from './helpers';

/** Path-style S3 fake: one bucket `bk`, objects in a Map. */
function fakeS3() {
  const objects = new Map<string, Buffer>();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    const [, bucket, ...rest] = url.pathname.split('/');
    const key = rest.map(decodeURIComponent).join('/');
    if (bucket !== 'bk') { res.writeHead(403); res.end('<Error><Code>AccessDenied</Code></Error>'); return; }
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.method === 'PUT') { objects.set(key, Buffer.concat(chunks)); res.end(); return; }
      if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204); res.end(); return; }
      if (req.method === 'GET' && !key) {
        const prefix = url.searchParams.get('prefix') || '';
        const items = [...objects].filter(([k]) => k.startsWith(prefix))
          .map(([k, b]) => `<Contents><Key>${k}</Key><Size>${b.length}</Size><LastModified>${new Date().toISOString()}</LastModified></Contents>`).join('');
        res.end(`<ListBucketResult><IsTruncated>false</IsTruncated>${items}</ListBucketResult>`); return;
      }
      const o = objects.get(key);
      if (!o) { res.writeHead(404); res.end('<Error><Code>NoSuchKey</Code></Error>'); return; }
      res.end(o);
    });
  });
  return { server, objects };
}

/** Records every message POSTed to it. */
function fakeWebhook() {
  const posts: string[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { posts.push(Buffer.concat(chunks).toString()); res.end('ok'); });
  });
  return { server, posts };
}

const listen = async (s: http.Server) => {
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return (s.address() as AddressInfo).port;
};

let ctx: TestContext;
let s3: ReturnType<typeof fakeS3>;
let hook: ReturnType<typeof fakeWebhook>;
let health: typeof import('../src/platform/backup-health');
let offsite: typeof import('../src/platform/offsite');
let backups: typeof import('../src/platform/backups');

beforeAll(async () => {
  ctx = await setupApp();
  await login(ctx.api);
  s3 = fakeS3();
  hook = fakeWebhook();
  const s3Port = await listen(s3.server);
  const hookPort = await listen(hook.server);
  Object.assign(process.env, {
    BACKUP_S3_T1_BUCKET: 'bk',
    BACKUP_S3_T1_ENDPOINT: `http://127.0.0.1:${s3Port}`,
    BACKUP_S3_T1_KEY_ID: 'id',
    BACKUP_S3_T1_SECRET: 'secret',
    BACKUP_S3_T1_PATH_STYLE: 'true',
    BACKUP_KEY: 'test-backup-key-0123456789',
    BACKUP_ALERT_WEBHOOK: `http://127.0.0.1:${hookPort}/alerts`,
  });
  health = await import('../src/platform/backup-health');
  offsite = await import('../src/platform/offsite');
  backups = await import('../src/platform/backups');
  backups.runDailyBackups();
  backups.runHourlyBackups();
  await offsite.pushOffsite();
});
afterAll(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('BACKUP_S3_') || k === 'BACKUP_KEY' || k === 'BACKUP_ALERT_WEBHOOK') delete process.env[k];
  }
  s3.server.close();
  hook.server.close();
  cleanup(ctx);
});

describe('restore drill', () => {
  it('restores every database from the off-site copy and records the result', async () => {
    const run = await health.runRestoreDrill();
    expect(run.ok).toBe(true);
    // The newest daily and the newest hourly copy of every database.
    const daily = run.results.filter((r) => !r.key?.includes('/hourly/'));
    const hourly = run.results.filter((r) => r.key?.includes('/hourly/'));
    expect(daily.map((r) => r.name).sort()).toEqual([...backups.backupNames()].sort());
    expect(hourly.map((r) => r.name).sort()).toEqual([...backups.backupNames()].sort());
    for (const r of run.results) expect(r.tables).toBeGreaterThan(0);
    expect(health.lastDrill()?.at).toBe(run.at);
    expect(health.drillDue()).toBe(false);
    expect(health.drillDue(new Date(Date.now() + 31 * 86_400_000))).toBe(true);
  });

  it('fails when an off-site copy is damaged, and retries the next day', async () => {
    const key = [...s3.objects.keys()].find((k) => k.startsWith('db/default/') && !k.includes('/hourly/'))!;
    const good = s3.objects.get(key)!;
    s3.objects.set(key, offsite.pack(Buffer.from('not a database at all')));
    try {
      const run = await health.runRestoreDrill();
      expect(run.ok).toBe(false);
      expect(run.results.find((r) => r.name === 'default')?.ok).toBe(false);
      expect(health.drillDue(new Date(Date.now() + 25 * 3_600_000))).toBe(true);
    } finally {
      s3.objects.set(key, good);
    }
  });
});

describe('health check and alerts', () => {
  it('alerts once while a problem stays open, then once on recovery', async () => {
    hook.posts.length = 0;
    // The drill above failed: one alert, not repeated on the next hourly check.
    const first = await health.checkBackupHealth();
    expect(first.ok).toBe(false);
    expect(first.problems.join(' ')).toMatch(/Restore drill failed/);
    await health.checkBackupHealth();
    expect(hook.posts).toHaveLength(1);
    expect(JSON.parse(hook.posts[0]!).text).toMatch(/Backup problem/);

    // Fixed: a passing drill clears it and sends the recovery message.
    expect((await health.runRestoreDrill()).ok).toBe(true);
    const after = await health.checkBackupHealth();
    expect(after.ok).toBe(true);
    expect(hook.posts).toHaveLength(2);
    expect(JSON.parse(hook.posts[1]!).text).toMatch(/recovered/);
  });

  it('flags a database whose newest daily snapshot is too old', async () => {
    const { backupDir } = await import('../src/shared/backup');
    const dir = path.join(backupDir(), 'default', 'daily');
    const twoDaysAgo = (Date.now() - 2 * 86_400_000) / 1000;
    for (const f of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, f), twoDaysAgo, twoDaysAgo);
    expect(health.backupProblems().join(' ')).toMatch(/"default" has no daily snapshot/);
  });

  it('reports a failed off-site copy', async () => {
    process.env.BACKUP_S3_T1_BUCKET = 'wrong-bucket'; // the fake answers 403
    try {
      // Something new to send, so the push actually talks to the bucket.
      fs.mkdirSync(process.env.UPLOAD_DIR!, { recursive: true });
      fs.writeFileSync(path.join(process.env.UPLOAD_DIR!, 'new-scan.txt'), 'x');
      await offsite.pushOffsite();
      expect(health.backupProblems().join(' ')).toMatch(/Off-site copy to "t1" failed/);
    } finally {
      process.env.BACKUP_S3_T1_BUCKET = 'bk';
    }
  });
});

describe('hourly snapshots', () => {
  const at = (h: number) => new Date(2030, 0, 1, h, 5); // well after the boot-time snapshot
  const hourlyDir = async () => path.join((await import('../src/shared/backup')).backupDir(), 'default', 'hourly');
  const files = async () => fs.readdirSync(await hourlyDir()).filter((f) => f.endsWith('.db')).sort();

  it('snapshots once per hour, and only when the database changed since the last one', async () => {
    await login(ctx.api); // a write
    const first = backups.runHourlyBackups(at(10)).find((r) => r.name === 'default')!;
    expect(first.ok && !first.skipped).toBe(true);
    expect(await files()).toContain('default-2030-01-01-10.db');

    // Same hour again: already there.
    expect(backups.runHourlyBackups(at(10)).find((r) => r.name === 'default')!.skipped).toBe(true);
    // Next hour with no writes in between: nothing new to keep.
    expect(backups.runHourlyBackups(at(11)).find((r) => r.name === 'default')!.skipped).toBe(true);
    expect(await files()).not.toContain('default-2030-01-01-11.db');

    await login(ctx.api); // a write
    const third = backups.runHourlyBackups(at(12)).find((r) => r.name === 'default')!;
    expect(third.skipped).toBeFalsy();
    const snap = new DatabaseSync(path.join(await hourlyDir(), 'default-2030-01-01-12.db'), { readOnly: true });
    try { expect((snap.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n).toBeGreaterThan(0); }
    finally { snap.close(); }
  });

  it('keeps the newest BACKUP_KEEP_HOURLY, and removes aged-out copies off-site too', async () => {
    await offsite.pushOffsite();
    const sent = () => [...s3.objects.keys()].filter((k) => k.startsWith('db/default/hourly/'));
    expect(sent()).toContain('db/default/hourly/default-2030-01-01-10.db.gz.enc');

    process.env.BACKUP_KEEP_HOURLY = '1';
    try {
      await login(ctx.api);
      backups.runHourlyBackups(at(13));
      expect(await files()).toEqual(['default-2030-01-01-13.db']);
      await offsite.pushOffsite();
      expect(sent()).toEqual(['db/default/hourly/default-2030-01-01-13.db.gz.enc']);
    } finally {
      delete process.env.BACKUP_KEEP_HOURLY;
    }
  });

  it('BACKUP_KEEP_HOURLY=0 turns them off', () => {
    process.env.BACKUP_KEEP_HOURLY = '0';
    try { expect(backups.runHourlyBackups(at(14))).toEqual([]); }
    finally { delete process.env.BACKUP_KEEP_HOURLY; }
  });

  it('the health check flags hourly snapshots that stopped', () => {
    expect(health.backupProblems().join(' ')).not.toMatch(/Hourly snapshots/);
    const later = new Date(Date.now() + 4 * 3_600_000);
    expect(health.backupProblems(later).join(' ')).toMatch(/Hourly snapshots have not succeeded in the last 3 hours/);
  });
});
