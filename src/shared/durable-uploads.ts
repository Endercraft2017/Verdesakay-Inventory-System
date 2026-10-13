/** Tenant upload recovery shared by HR, Forms, Inventory, reports and generated files.
 * Access checks stay in each route; never call resolveDurableUpload for an untrusted
 * filename before the route has authorized the record it belongs to. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { queryOne, run, uploadDir, tenantStore, DEFAULT_TENANT } from './db';
import { backupDir, mirrorDir } from './backup';

function safeName(name: string): string {
  const parts = name.replaceAll('\\', '/').split('/');
  const syncBlob = parts.length === 2 && parts[0] === '.sync-blobs' && /^[0-9a-f]{64}$/.test(parts[1]!);
  if (syncBlob) return parts.join('/');
  if (!parts.length || parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) {
    throw new Error('Invalid stored upload name');
  }
  return parts.join('/');
}

/** Store a completed, accepted upload inside the tenant's durable database. */
export function storeDurableUpload(name: string): void {
  const safe = safeName(name);
  const file = path.join(uploadDir(), safe);
  const bytes = fs.readFileSync(file);
  storeDurableBytes(safe, bytes);
}

function storeDurableBytes(safe: string, bytes: Buffer): void {
  run(
    `INSERT INTO durable_uploads (name, data, size_bytes) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET data = excluded.data, size_bytes = excluded.size_bytes, saved_at = datetime('now')`,
    safe, bytes, bytes.length
  );
}

function restoreBytes(primary: string, bytes: Buffer): void {
  fs.mkdirSync(path.dirname(primary), { recursive: true });
  const temp = `${primary}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, bytes, { flag: 'wx' });
    fs.renameSync(temp, primary);
  } finally {
    try { fs.unlinkSync(temp); } catch { /* already moved */ }
  }
}

/** Forget bytes when the owning record is intentionally deleted or retention expires. */
export function forgetDurableUpload(name: string): void {
  run('DELETE FROM durable_uploads WHERE name = ?', safeName(name));
}

/** Return an existing path, restoring its bytes from a backup or the database if needed. */
export function resolveDurableUpload(name: string): string | null {
  const safe = safeName(name);
  const primary = path.join(uploadDir(), safe);
  if (fs.existsSync(primary)) return primary;
  const row = queryOne<{ data: Uint8Array }>('SELECT data FROM durable_uploads WHERE name = ?', safe);
  if (row) {
    restoreBytes(primary, Buffer.from(row.data));
    return primary;
  }
  const slug = tenantStore.getStore()?.slug ?? DEFAULT_TENANT;
  const tenantPart = slug === DEFAULT_TENANT ? '' : slug;
  const roots = [backupDir(), mirrorDir()].filter((root): root is string => !!root);
  for (const root of roots) {
    const candidate = path.join(root, 'uploads', tenantPart, safe);
    if (!fs.existsSync(candidate)) continue;
    const bytes = fs.readFileSync(candidate);
    storeDurableBytes(safe, bytes);
    try {
      restoreBytes(primary, bytes);
      return primary;
    } catch {
      return candidate;
    }
  }
  return null;
}
