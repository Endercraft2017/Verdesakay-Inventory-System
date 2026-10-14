/** Tenant upload recovery shared by HR, Forms, Inventory, Messages, reports and generated files.
 * Access checks stay in each route; never call resolveDurableUpload for an untrusted
 * filename before the route has authorized the record it belongs to.
 *
 * Where the recoverable copy lives: in the file bucket when one is configured
 * (src/shared/file-store.ts, FILES_S3_*), otherwise in the tenant database (`durable_uploads`,
 * and `message_attachments.data` for chat files). Chat bytes remain in the database until
 * the bucket confirms its copy; src/platform/upload-offload.ts
 * moves the bytes a database already held into the bucket. `.sync-blobs/` always keep a database copy
 * (they're transient and node-local). */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { queryOne, run, uploadDir, tenantStore, DEFAULT_TENANT } from './db';
import { backupDir, mirrorDir } from './backup';
import { bucketManages, localCopy, sendNow, forgetUpload } from './file-store';

function safeName(name: string): string {
  const parts = name.replaceAll('\\', '/').split('/');
  const syncBlob = parts.length === 2 && parts[0] === '.sync-blobs' && /^[0-9a-f]{64}$/.test(parts[1]!);
  if (syncBlob) return parts.join('/');
  if (!parts.length || parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) {
    throw new Error('Invalid stored upload name');
  }
  return parts.join('/');
}

/** Keep a recoverable copy of a completed, accepted upload: sent to the bucket when there is
 *  one (falling back to the database if that send fails), else stored in the database. */
export function storeDurableUpload(name: string): void {
  const safe = safeName(name);
  const file = path.join(uploadDir(), safe);
  if (bucketManages(file)) {
    void sendNow(file).then((ok) => {
      if (!ok && fs.existsSync(file)) storeDurableBytes(safe, fs.readFileSync(file));
    }).catch(() => { /* logged by sendNow; the minute sweep retries from disk */ });
    return;
  }
  storeDurableBytes(safe, fs.readFileSync(file));
}

function storeDurableBytes(safe: string, bytes: Buffer): void {
  run(
    `INSERT INTO durable_uploads (name, data, size_bytes) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET data = excluded.data, size_bytes = excluded.size_bytes, saved_at = datetime('now')`,
    safe, bytes, bytes.length
  );
}

/** Keep chat bytes in the row until the bucket confirms its copy. The callback clears
 *  the temporary database copy only after success; readers on another instance can
 *  use the row immediately even while a large file is still reaching the bucket. */
export function messageBytesToKeep(file: string, onStored: (bytes: null) => void): Buffer {
  const bytes = fs.readFileSync(file);
  if (bucketManages(file)) {
    void sendNow(file).then((ok) => {
      if (ok) onStored(null);
    }).catch(() => { /* Keep the database copy on any failure. */ });
  }
  return bytes;
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

/** Forget bytes when the owning record is intentionally deleted or retention expires: the
 *  database copy and, with a bucket, the bucket copy. */
export function forgetDurableUpload(name: string): void {
  const safe = safeName(name);
  run('DELETE FROM durable_uploads WHERE name = ?', safe);
  void forgetUpload(path.join(uploadDir(), safe));
}

/** Return an existing path, restoring its bytes from the database or a backup if needed.
 *  Synchronous, so it can't reach the bucket: routes use resolveDurableUploadAsync. Fine as is
 *  for files the bucket never drops from disk (plain text, `.sync-blobs`) and on installed PCs. */
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
    // With a bucket, the restored file on disk is sent up by the next sweep instead.
    if (!bucketManages(primary)) storeDurableBytes(safe, bytes);
    try {
      restoreBytes(primary, bytes);
      return primary;
    } catch {
      return candidate;
    }
  }
  return null;
}

/** resolveDurableUpload, but a file the disk cache dropped is first fetched back from the
 *  bucket. What routes that serve a file use. */
export async function resolveDurableUploadAsync(name: string): Promise<string | null> {
  try {
    const primary = path.join(uploadDir(), safeName(name));
    if (await localCopy(primary)) return primary;
    return resolveDurableUpload(name);
  } catch (e) {
    // Serving routes answer "no longer available" rather than crash an async handler.
    console.error(`[uploads] could not resolve ${name}: ${(e as Error).message}`);
    return null;
  }
}
