/** Offline adoption of the original company. Never removes or rewrites source data. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, DATA_DIR, UPLOAD_DIR } from '../shared/db';
import { createTenantRow, getTenant, isValidSlug, listTenants, logProvisioning, platformDb } from './platform';
import { PLANS } from './plans';

type FileEntry = { name: string; bytes: number; sha256: string };

function manifest(root: string, excluded = new Set<string>()): FileEntry[] {
  const entries: FileEntry[] = [];
  function visit(dir: string, relative = ''): void {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      const rel = path.join(relative, name);
      const stat = fs.lstatSync(file);
      if (!relative && excluded.has(name) && stat.isDirectory()) continue;
      if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic link in uploads: ${rel}`);
      if (stat.isDirectory()) visit(file, rel);
      else if (stat.isFile()) entries.push({ name: rel, bytes: stat.size, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') });
      else throw new Error(`Unsupported upload entry: ${rel}`);
    }
  }
  if (fs.existsSync(root)) visit(root);
  return entries;
}

function integrity(db: DatabaseSync): void {
  const result = db.prepare('PRAGMA integrity_check').all();
  if (result.length !== 1 || result[0]?.integrity_check !== 'ok') throw new Error('Database integrity check failed.');
}

/** dry-run by default; the caller must stop all server/worker writers before apply. */
export function adoptDefaultTenant(input: { slug: string; name: string; plan?: string; apply?: boolean; serverStopped?: boolean }) {
  const slug = input.slug.toLowerCase().trim();
  const plan = input.plan ?? 'unlimited'; // preserve the first company's existing entitlements
  if (!isValidSlug(slug)) throw new Error('Invalid tenant slug.');
  if (!(plan in PLANS)) throw new Error('Unknown plan.');
  if (!input.name.trim()) throw new Error('Company name is required.');
  if (!fs.existsSync(DB_PATH)) throw new Error(`Source database does not exist: ${DB_PATH}`);
  if (getTenant(slug)) throw new Error('Tenant already exists; refusing to overwrite it.');
  const targetDb = path.join(DATA_DIR, `${slug}.db`);
  const targetUploads = path.join(UPLOAD_DIR, slug);
  const uploadsRoot = path.resolve(UPLOAD_DIR);
  const dataRoot = path.resolve(DATA_DIR);
  if (dataRoot === uploadsRoot || dataRoot.startsWith(uploadsRoot + path.sep)) {
    throw new Error('DATA_DIR must be outside UPLOAD_DIR to keep recovery files separate.');
  }
  if (fs.existsSync(targetDb) || fs.existsSync(targetUploads)) throw new Error('Destination already exists; refusing to overwrite it.');
  const excluded = new Set(listTenants().map(t => t.slug));
  const files = manifest(UPLOAD_DIR, excluded);
  const source = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    integrity(source);
    const users = Number(source.prepare('SELECT COUNT(*) AS n FROM users').get()?.n);
    if (!users) throw new Error('Source database has no users.');
    const report = { slug, users, files: files.length, upload_bytes: files.reduce((n, f) => n + f.bytes, 0), source_database: DB_PATH, target_database: targetDb, target_uploads: targetUploads, applied: false };
    if (!input.apply) return report;
    if (!input.serverStopped) throw new Error('Stop all server and worker processes, then pass --server-stopped.');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const recovery = fs.mkdtempSync(path.join(DATA_DIR, '.adopt-default-'));
    const snapshot = path.join(recovery, 'source.db');
    source.prepare('VACUUM INTO ?').run(snapshot); // includes committed WAL contents
    platformDb().prepare('VACUUM INTO ?').run(path.join(recovery, 'platform.db'));
    const snapshotDb = new DatabaseSync(snapshot, { readOnly: true });
    try { integrity(snapshotDb); } finally { snapshotDb.close(); }
    const uploadsBackup = path.join(recovery, 'uploads');
    fs.mkdirSync(uploadsBackup);
    for (const file of files) {
      const dest = path.join(uploadsBackup, file.name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(UPLOAD_DIR, file.name), dest, fs.constants.COPYFILE_EXCL);
    }
    if (JSON.stringify(manifest(uploadsBackup)) !== JSON.stringify(files)
      || JSON.stringify(manifest(UPLOAD_DIR, excluded)) !== JSON.stringify(files)) {
      throw new Error(`Uploads changed during copying. No tenant registered. Recovery files: ${recovery}`);
    }
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    fs.mkdirSync(targetUploads); // fails rather than overwriting a concurrent destination
    fs.cpSync(uploadsBackup, targetUploads, { recursive: true, errorOnExist: true, force: false });
    fs.copyFileSync(snapshot, targetDb, fs.constants.COPYFILE_EXCL);
    if (!fs.readFileSync(snapshot).equals(fs.readFileSync(targetDb))
      || JSON.stringify(manifest(targetUploads)) !== JSON.stringify(files)) {
      throw new Error(`Destination verification failed. No tenant registered. Recovery files: ${recovery}`);
    }
    fs.writeFileSync(path.join(recovery, 'verification.json'), JSON.stringify({ ...report, stage: 'copies_verified', files_manifest: files }, null, 2));
    const control = platformDb();
    control.exec('BEGIN IMMEDIATE');
    try {
      createTenantRow({ slug, name: input.name.trim(), plan, status: 'active' });
      logProvisioning(slug, 'adopt-default', JSON.stringify({ users, files: files.length, recovery }));
      control.exec('COMMIT');
    } catch (e) { control.exec('ROLLBACK'); throw e; }
    return { ...report, applied: true, recovery };
  } finally { source.close(); }
}
