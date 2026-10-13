/**
 * Moving file bytes out of the tenant databases once a file bucket is configured
 * (src/shared/file-store.ts). Before the bucket, durable-uploads.ts kept a recoverable copy of
 * every upload inside the tenant database (`durable_uploads`, `message_attachments.data`); with
 * a bucket that copy belongs in the bucket, so the databases — and their hourly snapshots — stay
 * small. Runs after each minute's file sweep (server.ts), a batch per tenant at a time, until
 * nothing is left; then compacts the database once so the volume gets the space back.
 *
 * A database copy is deleted only after the bucket has the same file. On a cloud/host database
 * those deletes don't replicate (sync/authority.ts withoutReplicating): installed PCs keep the
 * copies they have, since they have no bucket.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getDb, uploadDir, DEFAULT_TENANT } from '../shared/db';
import { bucketManages, hasBucketCopy, sendNow, putBytes } from '../shared/file-store';
import { withoutReplicating } from '../sync/authority';
import { liveTenantSlugs } from './backups';

/** Rows moved per tenant per sweep; the rest follow a minute later. */
const BATCH = 200;
/** Compact a database once at least this much has been freed in it. */
const VACUUM_MIN_FREE_BYTES = 8 * 1024 * 1024;
const checkedSinceStart = new Set<string>();

export interface OffloadResult { moved: number; freedBytes: number; remaining: number; vacuumed: boolean }

/** Make sure the bucket has this file: already sent, sent now from disk, or put from the bytes
 *  the database holds. False if the bucket couldn't take it. */
async function ensureInBucket(abs: string, dbBytes: () => Buffer | null): Promise<boolean> {
  if (hasBucketCopy(abs)) return true;
  if (fs.existsSync(abs) && await sendNow(abs)) return true;
  const bytes = dbBytes();
  return !!bytes && putBytes(abs, bytes);
}

/** Move one batch of this tenant's database-held file bytes into the bucket. No-op without one. */
export async function offloadDatabaseCopies(slug: string = DEFAULT_TENANT): Promise<OffloadResult> {
  const r: OffloadResult = { moved: 0, freedBytes: 0, remaining: 0, vacuumed: false };
  const root = uploadDir(slug);
  if (!bucketManages(path.join(root, 'x'))) return r;
  const conn = getDb(slug);

  // `.sync-blobs/` keep their database copy (transient, and the bucket never takes dot-folders).
  const uploads = conn.prepare(
    "SELECT name, size_bytes FROM durable_uploads WHERE name NOT LIKE '.%' ORDER BY name LIMIT ?"
  ).all(BATCH) as Array<{ name: string; size_bytes: number }>;
  const doneUploads: string[] = [];
  for (const u of uploads) {
    const ok = await ensureInBucket(path.join(root, u.name), () => {
      const row = conn.prepare('SELECT data FROM durable_uploads WHERE name = ?').get(u.name) as { data: Uint8Array } | undefined;
      return row ? Buffer.from(row.data) : null;
    });
    if (!ok) break; // the bucket is probably unreachable: try again next sweep
    doneUploads.push(u.name);
    r.freedBytes += u.size_bytes;
  }

  const atts = conn.prepare(
    'SELECT id, stored_name, size_bytes FROM message_attachments WHERE data IS NOT NULL ORDER BY id LIMIT ?'
  ).all(BATCH) as Array<{ id: number; stored_name: string; size_bytes: number | null }>;
  const doneAtts: number[] = [];
  if (doneUploads.length === uploads.length) {
    for (const a of atts) {
      const ok = await ensureInBucket(path.join(root, path.basename(a.stored_name)), () => {
        const row = conn.prepare('SELECT data FROM message_attachments WHERE id = ?').get(a.id) as { data: Uint8Array | null } | undefined;
        return row?.data ? Buffer.from(row.data) : null;
      });
      if (!ok) break;
      doneAtts.push(a.id);
      r.freedBytes += a.size_bytes ?? 0;
    }
  }

  if (doneUploads.length || doneAtts.length) {
    withoutReplicating(conn, () => {
      const delUpload = conn.prepare('DELETE FROM durable_uploads WHERE name = ?');
      const clearAtt = conn.prepare('UPDATE message_attachments SET data = NULL WHERE id = ?');
      conn.exec('BEGIN');
      try {
        for (const name of doneUploads) delUpload.run(name);
        for (const id of doneAtts) clearAtt.run(id);
        conn.exec('COMMIT');
      } catch (e) {
        conn.exec('ROLLBACK');
        throw e;
      }
    });
  }
  r.moved = doneUploads.length + doneAtts.length;

  r.remaining = (conn.prepare("SELECT COUNT(*) AS c FROM durable_uploads WHERE name NOT LIKE '.%'").get() as { c: number }).c
    + (conn.prepare('SELECT COUNT(*) AS c FROM message_attachments WHERE data IS NOT NULL').get() as { c: number }).c;

  // Deleted rows only become free pages; VACUUM hands the space back to the volume. Once the move
  // is complete — after it freed something, or on the first check since this server started (a
  // restart between the last batch and the compaction).
  const firstCheck = !checkedSinceStart.has(slug);
  checkedSinceStart.add(slug);
  if (r.remaining === 0 && (r.moved > 0 || firstCheck)) {
    const pageSize = (conn.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
    const free = (conn.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count * pageSize;
    if (free >= VACUUM_MIN_FREE_BYTES) {
      conn.exec('VACUUM');
      r.vacuumed = true;
    }
  }
  return r;
}

/** One batch for every tenant (server.ts runs this after each file sweep). Logs progress. */
export async function offloadAllDatabaseCopies(): Promise<void> {
  for (const slug of liveTenantSlugs()) {
    try {
      const r = await offloadDatabaseCopies(slug);
      if (r.moved) {
        console.log(`[files] ${slug}: moved ${r.moved} file(s) (${(r.freedBytes / 1048576).toFixed(1)} MB) from the database to the bucket${r.remaining ? `, ${r.remaining} to go` : ''}`);
      }
      if (r.vacuumed) console.log(`[files] ${slug}: database compacted`);
    } catch (e) {
      console.error(`[files] ${slug}: moving database copies to the bucket failed: ${(e as Error).message}`);
    }
  }
}
