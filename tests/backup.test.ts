/** Database backups (src/shared/backup.ts + src/platform/backups.ts): the pre-migration
    snapshot getDb() takes before upgrading an existing DB, the refusal to migrate when that
    snapshot can't be written, the daily job + its retention, the mirror copy, and restore. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

let tmpDir: string;

function useTmpEnv(): void {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-backup-'));
  process.env.DB_PATH = path.join(tmpDir, 'data.db');
  process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
  process.env.DATA_DIR = path.join(tmpDir, 'tenants');
  process.env.PLATFORM_DB_PATH = path.join(tmpDir, 'platform.db');
  delete process.env.BACKUP_DIR;
  delete process.env.BACKUP_MIRROR_DIR;
  delete process.env.BACKUP_BEFORE_MIGRATE;
  delete process.env.ADMIN_PASSWORD;
}

/** A DB file that looks like an older release left it: some data + an old schema_version. */
function writeOldDb(file: string, version: number): void {
  const raw = new DatabaseSync(file);
  raw.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE keep_me (id INTEGER PRIMARY KEY, note TEXT);
  `);
  raw.prepare("INSERT INTO keep_me (id, note) VALUES (1, 'precious')").run();
  raw.prepare("INSERT INTO settings (key, value) VALUES ('schema_version', ?)").run(String(version));
  raw.close();
}

beforeEach(() => { vi.resetModules(); useTmpEnv(); });
afterEach(async () => {
  try { (await import('../src/platform/platform'))._resetPlatformDb(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('pre-migration snapshot', () => {
  it('snapshots an existing DB before migrating it, with its pre-upgrade contents', async () => {
    writeOldDb(process.env.DB_PATH!, 43);
    const db = await import('../src/shared/db');
    db.init();

    const dir = path.join(tmpDir, 'backups', 'default', 'pre-migrate');
    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(new RegExp(`^default-v43-to-v${db.SCHEMA_VERSION}-\\d{8}-\\d{6}\\.db$`));

    const snap = new DatabaseSync(path.join(dir, files[0]!), { readOnly: true });
    expect((snap.prepare('SELECT note FROM keep_me WHERE id = 1').get() as { note: string }).note).toBe('precious');
    expect((snap.prepare("SELECT value FROM settings WHERE key = 'schema_version'").get() as { value: string }).value).toBe('43');
    // Taken before createSchema ran, so the old DB's shape is preserved exactly.
    expect(snap.prepare("SELECT 1 FROM sqlite_master WHERE name = 'users'").get()).toBeUndefined();
    snap.close();

    // And the migration still ran on the live DB without losing the row.
    expect(db.getSetting<number>('schema_version')).toBe(db.SCHEMA_VERSION);
    expect(db.queryOne<{ note: string }>('SELECT note FROM keep_me WHERE id = 1')!.note).toBe('precious');
  });

  it('takes no snapshot for a brand-new DB, or one already on the current version', async () => {
    const db = await import('../src/shared/db');
    db.init(); // fresh file
    expect(fs.existsSync(path.join(tmpDir, 'backups', 'default', 'pre-migrate'))).toBe(false);

    vi.resetModules(); // reopen the same (now current) file
    const again = await import('../src/shared/db');
    again.init();
    expect(fs.existsSync(path.join(tmpDir, 'backups', 'default', 'pre-migrate'))).toBe(false);
  });

  it('refuses to migrate when the snapshot cannot be written, leaving the DB untouched', async () => {
    writeOldDb(process.env.DB_PATH!, 43);
    const blocker = path.join(tmpDir, 'not-a-dir');
    fs.writeFileSync(blocker, 'x');
    process.env.BACKUP_DIR = blocker; // mkdir under a file fails
    const db = await import('../src/shared/db');
    expect(() => db.init()).toThrow(/Refusing to migrate "default".*pre-migration backup failed/);

    const raw = new DatabaseSync(process.env.DB_PATH!, { readOnly: true });
    expect((raw.prepare("SELECT value FROM settings WHERE key = 'schema_version'").get() as { value: string }).value).toBe('43');
    raw.close();
  });

  it('BACKUP_BEFORE_MIGRATE=off skips the snapshot', async () => {
    writeOldDb(process.env.DB_PATH!, 43);
    process.env.BACKUP_BEFORE_MIGRATE = 'off';
    const db = await import('../src/shared/db');
    db.init();
    expect(fs.existsSync(path.join(tmpDir, 'backups', 'default', 'pre-migrate'))).toBe(false);
  });
});

describe('daily backups', () => {
  it('snapshots every DB once per day, mirrors it, copies uploads, and writes status.json', async () => {
    const mirror = path.join(tmpDir, 'mirror');
    process.env.BACKUP_MIRROR_DIR = mirror;
    const db = await import('../src/shared/db');
    db.init();
    db.run("INSERT INTO settings (key, value) VALUES ('probe', '\"hello\"')");
    fs.mkdirSync(process.env.UPLOAD_DIR!, { recursive: true });
    fs.writeFileSync(path.join(process.env.UPLOAD_DIR!, 'photo.jpg'), 'img');

    const { runDailyBackups } = await import('../src/platform/backups');
    const { localDate } = await import('../src/shared/backup');
    const day = new Date(2026, 8, 24, 10);
    const first = runDailyBackups(day);
    expect(first.every((r) => r.ok && !r.mirrorError)).toBe(true);
    expect(first.map((r) => r.name).sort()).toEqual(['_platform', 'default', 'uploads']);

    const snapFile = path.join(tmpDir, 'backups', 'default', 'daily', `default-${localDate(day)}.db`);
    const snap = new DatabaseSync(snapFile, { readOnly: true });
    expect((snap.prepare("SELECT value FROM settings WHERE key = 'probe'").get() as { value: string }).value).toBe('"hello"');
    snap.close();
    expect(fs.existsSync(path.join(tmpDir, 'backups', '_platform', 'daily', `_platform-${localDate(day)}.db`))).toBe(true);
    expect(fs.existsSync(path.join(mirror, 'default', 'daily', `default-${localDate(day)}.db`))).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, 'backups', 'uploads', 'photo.jpg'), 'utf8')).toBe('img');
    expect(fs.existsSync(path.join(mirror, 'uploads', 'photo.jpg'))).toBe(true);

    const status = JSON.parse(fs.readFileSync(path.join(tmpDir, 'backups', 'status.json'), 'utf8'));
    expect(status.last_run.ok).toBe(true);
    expect(status.last_success_at).toBeTruthy();

    // Same day again: nothing new taken.
    const second = runDailyBackups(new Date(2026, 8, 24, 11));
    expect(second.every((r) => r.skipped)).toBe(true);
    // Uploads deleted in the app stay in the backup.
    fs.rmSync(path.join(process.env.UPLOAD_DIR!, 'photo.jpg'));
    runDailyBackups(new Date(2026, 8, 25, 1));
    expect(fs.existsSync(path.join(tmpDir, 'backups', 'uploads', 'photo.jpg'))).toBe(true);
  });

  it('retention keeps the newest N days plus one per month for M months', async () => {
    const { pruneDaily } = await import('../src/shared/backup');
    const dir = path.join(tmpDir, 'daily');
    fs.mkdirSync(dir, { recursive: true });
    const names = [
      'default-2026-05-10.db', 'default-2026-05-31.db',
      'default-2026-06-15.db', 'default-2026-06-30.db',
      'default-2026-07-31.db',
      'default-2026-09-20.db', 'default-2026-09-21.db', 'default-2026-09-22.db',
    ];
    for (const n of names) fs.writeFileSync(path.join(dir, n), '');
    pruneDaily(dir, 3, 2);
    expect(fs.readdirSync(dir).sort()).toEqual([
      'default-2026-06-30.db', 'default-2026-07-31.db', // latest of the 2 newest older months
      'default-2026-09-20.db', 'default-2026-09-21.db', 'default-2026-09-22.db', // newest 3
    ]);
  });
});

describe('restore', () => {
  it('replaces the DB with a backup and keeps a pre-restore copy of what it replaced', async () => {
    const db = await import('../src/shared/db');
    db.init();
    db.run("INSERT INTO settings (key, value) VALUES ('probe', '\"before\"')");
    const { runManualBackup, restoreBackup } = await import('../src/platform/backups');
    const snap = runManualBackup().find((r) => r.name === 'default')!;
    expect(snap.ok).toBe(true);
    db.run("UPDATE settings SET value = '\"after\"' WHERE key = 'probe'");
    db.activeDb().close(); // "stop the server"

    const r = restoreBackup('default', snap.file!);
    expect(r.safetyCopy).toBeTruthy();
    const restored = new DatabaseSync(process.env.DB_PATH!, { readOnly: true });
    expect((restored.prepare("SELECT value FROM settings WHERE key = 'probe'").get() as { value: string }).value).toBe('"before"');
    restored.close();
    const safety = new DatabaseSync(r.safetyCopy!, { readOnly: true });
    expect((safety.prepare("SELECT value FROM settings WHERE key = 'probe'").get() as { value: string }).value).toBe('"after"');
    safety.close();
  });
});

it('refuses restore target path traversal before touching a database', async () => {
  const { liveFileFor, restoreBackup } = await import('../src/platform/backups');
  for (const target of ['../escape', '/tmp/escape', '..', 'tenant/child', 'bad.db']) {
    expect(() => liveFileFor(target)).toThrow('Invalid backup workspace name');
    expect(() => restoreBackup(target, '/no/such/backup.db')).toThrow('Invalid backup workspace name');
  }
});
