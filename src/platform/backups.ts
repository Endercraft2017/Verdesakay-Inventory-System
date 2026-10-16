/**
 * The daily backup job + manual backup/restore helpers, built on src/shared/backup.ts.
 *
 * What gets backed up, each under `backupDir()/<name>/`:
 *  - every tenant DB: `default` (data.db) + each non-purged tenant in the catalog
 *  - `_platform` — platform.db (tenant catalog + owner-console accounts)
 *  - `uploads/` — a mirror of UPLOAD_DIR (item images, attachments, punch photos, 201
 *    docs). Files are copied when new or changed and never deleted from the backup, so an
 *    accidental delete in the app is still recoverable — EXCEPT kiosk punch photos, which
 *    the app deletes on a retention schedule: those are removed from the backup too
 *    (isRetentionManagedUpload), so backups don't keep employee photos past retention.
 *
 * `runDailyBackups()` is idempotent per local day: it's called at boot and hourly from
 * server.ts, and only snapshots a database whose `daily/<name>-<today>.db` doesn't exist
 * yet. The last run's result is written to `backupDir()/status.json` so there's always a
 * file saying when backups last succeeded and what failed.
 *
 *   npm run backup            snapshot everything now (manual/)
 *   npm run backup:list       what's on disk
 *   npm run backup:restore -- <name> <backup-file> --yes   (server must be stopped)
 */
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { getDb, DB_PATH, DATA_DIR, UPLOAD_DIR, DEFAULT_TENANT } from '../shared/db';
import { isValidSlug, retiredDefaultTenant } from './platform';
import {
  backupDir, mirrorDir, kindDir, snapshotTo, pruneDaily, pruneNewest, retention, localDate, stamp,
  isRetentionManagedUpload, type BackupKind,
} from '../shared/backup';
import { listTenants, platformDb, PLATFORM_DB_PATH } from './platform';

export const PLATFORM_BACKUP_NAME = '_platform';

export interface BackupResult {
  name: string;
  ok: boolean;
  file?: string;
  bytes?: number;
  skipped?: boolean; // today's daily already exists
  copied?: number;   // uploads: files copied this run
  error?: string;
  mirrorError?: string;
}

/** Every database to back up, as name → live connection (opened lazily). */
function targets(): Array<{ name: string; conn: () => DatabaseSync }> {
  const slugs = [...(retiredDefaultTenant() ? [] : [DEFAULT_TENANT]), ...listTenants().filter((t) => t.status !== 'purged').map((t) => t.slug)];
  return [
    ...slugs.map((slug) => ({ name: slug, conn: () => getDb(slug) })),
    { name: PLATFORM_BACKUP_NAME, conn: () => platformDb() },
  ];
}

/** The on-disk file a backup name restores onto. */
export function liveFileFor(name: string): string {
  if (name === PLATFORM_BACKUP_NAME) return PLATFORM_DB_PATH;
  if (name === DEFAULT_TENANT) return DB_PATH;
  if (!isValidSlug(name)) throw new Error('Invalid backup workspace name');
  return path.join(DATA_DIR, `${name}.db`);
}

/** Mirror `src` into `dest`: copy files that are missing or differ in size/mtime. Additive,
 *  except retention-managed punch photos, whose deletions are mirrored too. */
function mirrorFolder(src: string, dest: string, rel = ''): number {
  if (!fs.existsSync(src)) return 0;
  let copied = 0;
  const present = new Set<string>();
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    present.add(entry.name);
    if (entry.isDirectory()) {
      copied += mirrorFolder(s, d, rel ? `${rel}/${entry.name}` : entry.name);
    } else if (entry.isFile()) {
      const ss = fs.statSync(s);
      const ds = fs.existsSync(d) ? fs.statSync(d) : null;
      if (!ds || ds.size !== ss.size || ds.mtimeMs < ss.mtimeMs) {
        fs.mkdirSync(dest, { recursive: true });
        fs.copyFileSync(s, d);
        fs.utimesSync(d, ss.atime, ss.mtime);
        copied++;
      }
    }
  }
  dropDeletedPhotos(dest, rel, present);
  return copied;
}

/** Remove backed-up punch photos under `dest` whose source is gone (`present` = names still
 *  in the source folder; a folder missing from the source — e.g. a purged tenant — is
 *  walked with nothing present). */
function dropDeletedPhotos(dest: string, rel: string, present: Set<string> = new Set()): void {
  if (!fs.existsSync(dest)) return;
  for (const entry of fs.readdirSync(dest, { withFileTypes: true })) {
    if (present.has(entry.name)) continue;
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isFile() && isRetentionManagedUpload(r)) fs.rmSync(path.join(dest, entry.name), { force: true });
    else if (entry.isDirectory()) dropDeletedPhotos(path.join(dest, entry.name), r);
  }
}

function backupUploads(): BackupResult {
  try {
    let copied = mirrorFolder(UPLOAD_DIR, path.join(backupDir(), 'uploads'));
    let mirrorError: string | undefined;
    const mirror = mirrorDir();
    if (mirror) {
      try { copied += mirrorFolder(UPLOAD_DIR, path.join(mirror, 'uploads')); } catch (e) { mirrorError = (e as Error).message; }
    }
    return { name: 'uploads', ok: true, copied, mirrorError };
  } catch (e) {
    return { name: 'uploads', ok: false, error: (e as Error).message };
  }
}

function writeStatus(kind: BackupKind, results: BackupResult[]): void {
  try {
    const statusFile = path.join(backupDir(), 'status.json');
    fs.mkdirSync(path.dirname(statusFile), { recursive: true });
    const prev = fs.existsSync(statusFile) ? JSON.parse(fs.readFileSync(statusFile, 'utf8')) : {};
    const allOk = results.every((r) => r.ok && !r.mirrorError);
    fs.writeFileSync(statusFile, JSON.stringify({
      ...prev,
      last_run: { kind, at: new Date().toISOString(), ok: allOk, results },
      ...(allOk ? { last_success_at: new Date().toISOString() } : {}),
    }, null, 2));
  } catch { /* status is informational; never fail a backup over it */ }
}

function report(results: BackupResult[]): void {
  for (const r of results) {
    if (!r.ok) console.error(`[backup] FAILED "${r.name}": ${r.error}`);
    if (r.mirrorError) console.error(`[backup] "${r.name}" not copied to BACKUP_MIRROR_DIR: ${r.mirrorError}`);
  }
}

/** Take today's daily snapshot of every database that doesn't have one yet, then prune. */
export function runDailyBackups(now = new Date()): BackupResult[] {
  const day = localDate(now);
  const results: BackupResult[] = [];
  for (const t of targets()) {
    const dir = kindDir(t.name, 'daily');
    const file = path.join(dir, `${t.name}-${day}.db`);
    if (fs.existsSync(file)) { results.push({ name: t.name, ok: true, file, skipped: true }); continue; }
    try {
      const r = snapshotTo(t.conn(), file);
      pruneDaily(dir, retention.daily(), retention.monthly());
      results.push({ name: t.name, ok: true, ...r });
    } catch (e) {
      results.push({ name: t.name, ok: false, error: (e as Error).message });
    }
  }
  if (results.some((r) => !r.skipped)) {
    results.push(backupUploads());
    writeStatus('daily', results);
    report(results);
    const made = results.filter((r) => r.ok && !r.skipped && r.name !== 'uploads').length;
    if (made) console.log(`[backup] daily snapshot for ${day}: ${made} database(s) → ${backupDir()}`);
  }
  return results;
}

/** Snapshot everything right now into `manual/` (keeps the newest 20 per database). */
export function runManualBackup(): BackupResult[] {
  const results: BackupResult[] = [];
  for (const t of targets()) {
    const dir = kindDir(t.name, 'manual');
    try {
      results.push({ name: t.name, ok: true, ...snapshotTo(t.conn(), path.join(dir, `${t.name}-${stamp()}.db`)) });
      pruneNewest(dir, 20);
    } catch (e) {
      results.push({ name: t.name, ok: false, error: (e as Error).message });
    }
  }
  results.push(backupUploads());
  writeStatus('manual', results);
  report(results);
  return results;
}

export interface BackupFile { name: string; kind: string; file: string; bytes: number; modified: string }

/** Every snapshot on disk, newest first. */
export function listBackups(): BackupFile[] {
  const root = backupDir();
  if (!fs.existsSync(root)) return [];
  const out: BackupFile[] = [];
  for (const name of fs.readdirSync(root)) {
    const nameDir = path.join(root, name);
    if (name === 'uploads' || !fs.statSync(nameDir).isDirectory()) continue;
    for (const kind of fs.readdirSync(nameDir)) {
      const kd = path.join(nameDir, kind);
      if (!fs.statSync(kd).isDirectory()) continue;
      for (const f of fs.readdirSync(kd).filter((x) => x.endsWith('.db'))) {
        const st = fs.statSync(path.join(kd, f));
        out.push({ name, kind, file: path.join(kd, f), bytes: st.size, modified: st.mtime.toISOString() });
      }
    }
  }
  return out.sort((a, b) => b.modified.localeCompare(a.modified));
}

/**
 * Replace a database with a backup. ONLY while the server is stopped — a running server
 * keeps the old file open. First snapshots the current file into `pre-restore/` so the
 * restore itself can be undone, then copies the backup over it and removes the stale
 * -wal/-shm files (which belong to the old DB and would corrupt the restored one).
 */
export function restoreBackup(name: string, backupFile: string): { restored: string; safetyCopy: string | null } {
  liveFileFor(name); // validate the target before reading or writing anything
  if (!fs.existsSync(backupFile)) throw new Error(`backup file not found: ${backupFile}`);
  const check = new DatabaseSync(backupFile, { readOnly: true });
  try {
    const row = check.prepare('PRAGMA quick_check').get() as Record<string, unknown>;
    if (String(Object.values(row)[0]) !== 'ok') throw new Error('backup file fails its integrity check');
  } finally {
    check.close();
  }
  const live = liveFileFor(name);
  let safetyCopy: string | null = null;
  if (fs.existsSync(live)) {
    const cur = new DatabaseSync(live);
    try {
      safetyCopy = snapshotTo(cur, path.join(kindDir(name, 'pre-restore'), `${name}-${stamp()}.db`)).file;
    } finally {
      cur.close();
    }
  }
  fs.mkdirSync(path.dirname(live), { recursive: true });
  fs.copyFileSync(backupFile, live);
  fs.rmSync(`${live}-wal`, { force: true });
  fs.rmSync(`${live}-shm`, { force: true });
  return { restored: live, safetyCopy };
}
