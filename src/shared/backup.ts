/**
 * Database backup primitives: consistent point-in-time snapshots of a live SQLite
 * connection, where they're stored, and how many are kept.
 *
 * Two kinds of snapshot, both under `backupDir()/<name>/`:
 *  - `pre-migrate/` — taken by db.ts's getDb() right before migrate() runs on a database
 *    that already has data. A migration that can't get its snapshot refuses to run, so a
 *    bad schema change can always be rolled back by swapping the file.
 *  - `daily/` — taken by the daily job (src/platform/backups.ts). Retention keeps the newest
 *    `BACKUP_KEEP_DAILY` days plus one per month for `BACKUP_KEEP_MONTHLY` months, so a
 *    problem noticed weeks late still has a clean copy to go back to.
 *  - `hourly/` — taken every hour while the database is changing (src/platform/backups.ts),
 *    newest `BACKUP_KEEP_HOURLY` kept, so a bad day loses at most an hour of work.
 *
 * Snapshots use `VACUUM INTO`, which is transactionally consistent even while the server
 * is writing (WAL mode) — unlike copying the .db file, which can catch it mid-write and
 * miss whatever is still in the -wal file. Every snapshot is `PRAGMA quick_check`ed before
 * it's kept, and written to a temp name first so a half-written file is never mistaken for
 * a good backup.
 *
 * Env:
 *   BACKUP_DIR            where snapshots go (default: `<folder of DB_PATH>/backups`)
 *   BACKUP_MIRROR_DIR     optional second copy of every snapshot — point it at another
 *                         drive, a NAS share, or a cloud-synced folder for off-disk redundancy
 *   BACKUP_KEEP_DAILY     daily snapshots kept (default 14)
 *   BACKUP_KEEP_MONTHLY   older month-end snapshots kept (default 12)
 *   BACKUP_KEEP_HOURLY    hourly snapshots kept per database (default 48; 0 turns them off)
 *   BACKUP_KEEP_PREMIGRATE pre-migration snapshots kept per database (default 10)
 *   BACKUP_BEFORE_MIGRATE set to `off` to skip the pre-migration snapshot (not recommended)
 */
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/** Kiosk punch photos: `uploadDir()/kiosk-punches/` (src/modules/hr/punch-photos.ts). The app
 *  deletes them on a per-tenant retention (age / total size), so every backup copy of the
 *  folder MIRRORS it — a photo the app deleted is deleted from the backups too. All other
 *  uploads are backed up additively (an accidental delete stays recoverable). */
export const PUNCH_PHOTOS_SUBDIR = 'kiosk-punches';

/** True for a path under UPLOAD_DIR (forward- or back-slashed, relative) that is a
 *  retention-managed punch photo — `kiosk-punches/x.jpg` or `<slug>/kiosk-punches/x.jpg`. */
export function isRetentionManagedUpload(rel: string): boolean {
  const parts = rel.split(/[\\/]/);
  return parts.length >= 2 && parts.length <= 3 && parts[parts.length - 2] === PUNCH_PHOTOS_SUBDIR;
}

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** Root folder for snapshots. Defaults next to the default tenant's DB file, so tests
    (which point DB_PATH at a temp dir) never write into the real db/backups. */
export function backupDir(): string {
  if (process.env.BACKUP_DIR) return process.env.BACKUP_DIR;
  const dbPath = process.env.DB_PATH || path.join(import.meta.dirname, '..', '..', 'db', 'data.db');
  return path.join(path.dirname(dbPath), 'backups');
}

export function mirrorDir(): string | null {
  return process.env.BACKUP_MIRROR_DIR || null;
}

export type BackupKind = 'daily' | 'hourly' | 'pre-migrate' | 'pre-restore' | 'manual';

/** `YYYYMMDD-HHMMSS` in local time — sortable, filename-safe. */
export function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** `YYYY-MM-DD` in local time — the daily snapshot's key. */
export function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** `YYYY-MM-DD-HH` in local time — the hourly snapshot's key. */
export function localHour(d = new Date()): string {
  return `${localDate(d)}-${String(d.getHours()).padStart(2, '0')}`;
}

export function kindDir(name: string, kind: BackupKind, root = backupDir()): string {
  return path.join(root, name, kind);
}

/**
 * Write a consistent snapshot of `conn` to `destFile` (must not exist yet) and verify it.
 * Throws if the snapshot can't be written or fails its integrity check; on failure no
 * file is left at `destFile`. Also copies it to BACKUP_MIRROR_DIR when set — a mirror
 * failure is returned as `mirrorError`, not thrown, since the primary copy is good.
 */
export function snapshotTo(conn: DatabaseSync, destFile: string): { file: string; bytes: number; mirrorError?: string } {
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  const tmp = `${destFile}.partial`;
  fs.rmSync(tmp, { force: true });
  try {
    conn.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    const check = new DatabaseSync(tmp, { readOnly: true });
    try {
      const row = check.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined;
      const verdict = row ? String(Object.values(row)[0]) : 'no result';
      if (verdict !== 'ok') throw new Error(`integrity check failed: ${verdict}`);
    } finally {
      check.close();
    }
    fs.renameSync(tmp, destFile);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  const bytes = fs.statSync(destFile).size;

  let mirrorError: string | undefined;
  const mirror = mirrorDir();
  if (mirror) {
    try {
      const rel = path.relative(backupDir(), destFile);
      // A destFile outside backupDir() (e.g. a custom path) mirrors to the mirror's root.
      const target = rel.startsWith('..') || path.isAbsolute(rel) ? path.join(mirror, path.basename(destFile)) : path.join(mirror, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(destFile, target);
    } catch (e) {
      mirrorError = (e as Error).message;
    }
  }
  return { file: destFile, bytes, mirrorError };
}

/** Keep the newest `keep` `.db` files in `dir` (by name, which sorts by timestamp). */
export function pruneNewest(dir: string, keep: number): string[] {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.db')).sort();
  const drop = files.slice(0, Math.max(0, files.length - keep));
  for (const f of drop) fs.rmSync(path.join(dir, f), { force: true });
  return drop;
}

/**
 * Daily-folder retention: keep the newest `keepDaily` snapshots, plus — among the older
 * ones — the latest snapshot of each month for the newest `keepMonthly` months. Files are
 * named `<name>-YYYY-MM-DD.db`. Returns the removed filenames.
 */
export function pruneDaily(dir: string, keepDaily: number, keepMonthly: number): string[] {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => /\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
  const recent = new Set(files.slice(Math.max(0, files.length - keepDaily)));
  const older = files.filter((f) => !recent.has(f));
  // Latest file per month among the older ones, newest months first.
  const perMonth = new Map<string, string>();
  for (const f of older) perMonth.set(f.slice(-13, -6), f); // sorted ascending ⇒ last wins
  const monthly = new Set([...perMonth.keys()].sort().reverse().slice(0, keepMonthly).map((m) => perMonth.get(m)!));
  const drop = older.filter((f) => !monthly.has(f));
  for (const f of drop) fs.rmSync(path.join(dir, f), { force: true });
  return drop;
}

export const retention = {
  daily: () => envInt('BACKUP_KEEP_DAILY', 14),
  monthly: () => envInt('BACKUP_KEEP_MONTHLY', 12),
  hourly: () => envInt('BACKUP_KEEP_HOURLY', 48),
  preMigrate: () => envInt('BACKUP_KEEP_PREMIGRATE', 10),
};

/** The schema version recorded in a DB, read raw (before createSchema touches anything).
    `null` = a brand-new, empty file — nothing to protect. 0 = has tables but predates
    version tracking. */
export function storedSchemaVersion(conn: DatabaseSync): number | null {
  const tables = (conn.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table'").get() as { c: number }).c;
  if (tables === 0) return null;
  try {
    const row = conn.prepare("SELECT value FROM settings WHERE key = 'schema_version'").get() as { value: string } | undefined;
    return row ? Number(JSON.parse(row.value)) || 0 : 0;
  } catch {
    return 0; // no settings table yet
  }
}

/**
 * Called by db.ts right before migrate(): snapshot `conn` to
 * `<backupDir>/<name>/pre-migrate/<name>-v<from>-to-v<to>-<stamp>.db`. Returns the file,
 * or null when there's nothing to protect (fresh DB) or it's switched off. Throws if the
 * snapshot fails — the caller must then NOT migrate.
 */
export function preMigrationSnapshot(conn: DatabaseSync, name: string, toVersion: number): string | null {
  if ((process.env.BACKUP_BEFORE_MIGRATE || '').toLowerCase() === 'off') return null;
  const from = storedSchemaVersion(conn);
  if (from === null || from >= toVersion) return null;
  const dir = kindDir(name, 'pre-migrate');
  const { file, mirrorError } = snapshotTo(conn, path.join(dir, `${name}-v${from}-to-v${toVersion}-${stamp()}.db`));
  if (mirrorError) console.warn(`[backup] pre-migration snapshot of "${name}" not mirrored: ${mirrorError}`);
  pruneNewest(dir, retention.preMigrate());
  return file;
}
