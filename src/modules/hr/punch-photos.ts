/**
 * One photo per punch, captured from the kiosk's camera at the moment of the punch (attendance
 * or field work) -- see public/js/views/hr-kiosk.js. Files live under uploadDir()/kiosk-punches
 * (so they're already tenant-isolated the same way every other upload is, see uploadDir's own
 * doc comment in src/db.ts); one row per (punch_kind, punch_id) in punch_photos -- re-punching an
 * already-photographed slot (a click-to-correct fix, or an OT re-punch of Out) replaces the file
 * and row rather than accumulating one photo per attempt.
 *
 * Retention is a per-tenant, owner-only setting (src/platform.ts's tenants.photo_retention_days /
 * photo_max_mb -- null means "use the system default", 0 means "no limit"). There's no scheduled
 * job in this codebase (see cleanupSessions's own doc comment in src/db.ts for the same pattern);
 * enforceRetention runs lazily at the end of every save, mirroring how enforceQuota (src/quota.ts)
 * checks inline on every upload rather than via a cron sweep.
 */
import fs from 'node:fs';
import { storeDurableUpload, resolveDurableUploadAsync, forgetDurableUpload } from '../../shared/durable-uploads';
import path from 'node:path';
import crypto from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { queryOne, queryAll, run, uploadDir, tenantStore, DEFAULT_TENANT } from '../../shared/db';
import { getTenant } from '../../platform/platform';
import { requirePermission } from '../../shared/auth';
import { PUNCH_PHOTOS_SUBDIR } from '../../shared/backup';
import { syncClass } from '../../sync';
import { syncUpload } from '../../sync/files';
import { syncContext } from '../../shared/sync-context';

function currentSlug(): string {
  return tenantStore.getStore()?.slug ?? DEFAULT_TENANT;
}

export type PunchKind = 'attendance' | 'field';

const DEFAULT_RETENTION_DAYS = 60;
const DEFAULT_MAX_MB = 300;

function photoDir(): string {
  const dir = path.join(uploadDir(), PUNCH_PHOTOS_SUBDIR); // backups mirror this folder's deletions
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function unlinkQuiet(fileName: string): void {
  forgetDurableUpload(`${PUNCH_PHOTOS_SUBDIR}/${fileName}`);
  try { fs.unlinkSync(path.join(photoDir(), fileName)); } catch { /* already gone */ }
}

interface PhotoRow { id: number; file_name: string; file_size: number; created_at: string }

/** The tenant's effective retention policy. `days`/`maxMb` of 0 means "no limit" for that
 *  dimension. The `default` (self-hosted, single-tenant) install has no platform.db catalog
 *  row at all, so it always gets the system default rather than "unlimited". */
export function retentionFor(slug: string): { days: number; maxMb: number } {
  if (slug === DEFAULT_TENANT) return { days: DEFAULT_RETENTION_DAYS, maxMb: DEFAULT_MAX_MB };
  const t = getTenant(slug);
  return {
    days: t?.photo_retention_days ?? DEFAULT_RETENTION_DAYS,
    maxMb: t?.photo_max_mb ?? DEFAULT_MAX_MB,
  };
}

/** Total bytes currently used by this tenant's punch photos (for the owner console). */
export function punchPhotoUsageBytes(): number {
  let total = 0;
  try {
    for (const name of fs.readdirSync(photoDir())) {
      try { total += fs.statSync(path.join(photoDir(), name)).size; } catch { /* raced a delete */ }
    }
  } catch { /* missing dir */ }
  return total;
}

/** Delete whatever's past the tenant's age limit, then -- if still over the size cap -- delete
 *  oldest-first until under it. Runs inside the active tenant's DB (see tenantStore), so this
 *  must only be called with a tenant already selected. */
function enforceRetention(slug: string): void {
  const { days, maxMb } = retentionFor(slug);

  if (days > 0) {
    const stale = queryAll<PhotoRow>(
      "SELECT id, file_name, file_size, created_at FROM punch_photos WHERE created_at < datetime('now', ?)",
      `-${days} days`
    );
    for (const row of stale) {
      unlinkQuiet(row.file_name);
      run('DELETE FROM punch_photos WHERE id = ?', row.id);
    }
  }

  if (maxMb > 0) {
    const capBytes = maxMb * 1024 * 1024;
    let total = punchPhotoUsageBytes();
    if (total > capBytes) {
      const oldest = queryAll<PhotoRow>('SELECT id, file_name, file_size, created_at FROM punch_photos ORDER BY created_at ASC, id ASC');
      for (const row of oldest) {
        if (total <= capBytes) break;
        unlinkQuiet(row.file_name);
        run('DELETE FROM punch_photos WHERE id = ?', row.id);
        total -= row.file_size;
      }
    }
  }
}

/** Save (or replace) the photo for one punch. `sourcePath` is where multer already wrote the
 *  upload -- this takes ownership of that file (moves it into the punch-photos folder under a
 *  fresh name) rather than re-reading the bytes, so it works for any file size. If this punch
 *  already had a photo, the old file is deleted and its row is reused (same id). */
export function savePunchPhoto(
  punchKind: PunchKind,
  punchId: number,
  employeeId: number,
  sourcePath: string,
  fileSize: number
): { id: number } {
  // In a synced command the name comes from the command, so every copy stores the same one (§18).
  const cmd = syncContext()?.commandId?.toLowerCase();
  const fileName = cmd
    ? `p-${punchKind}-${punchId}-${cmd}.jpg`
    : `p-${punchKind}-${punchId}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.jpg`;
  fs.renameSync(sourcePath, path.join(photoDir(), fileName));
  storeDurableUpload(`${PUNCH_PHOTOS_SUBDIR}/${fileName}`);

  const existing = queryOne<PhotoRow>(
    'SELECT id, file_name FROM punch_photos WHERE punch_kind = ? AND punch_id = ?',
    punchKind, punchId
  );
  let id: number;
  if (existing) {
    unlinkQuiet(existing.file_name);
    run(
      "UPDATE punch_photos SET file_name = ?, file_size = ?, created_at = datetime('now') WHERE id = ?",
      fileName, fileSize, existing.id
    );
    id = existing.id;
  } else {
    const info = run(
      'INSERT INTO punch_photos (punch_kind, punch_id, employee_id, file_name, file_size) VALUES (?, ?, ?, ?, ?)',
      punchKind, punchId, employeeId, fileName, fileSize
    );
    id = Number(info.lastInsertRowid);
  }

  enforceRetention(currentSlug());
  return { id };
}

export function getPunchPhotoFile(id: number): { file_name: string } | undefined {
  return queryOne<{ file_name: string }>('SELECT file_name FROM punch_photos WHERE id = ?', id);
}

/** punch_id -> photo id, for whichever of `punchIds` actually have a saved photo. One query for
 *  a whole batch (e.g. every punch behind a period's worth of attendance rows), not one per id. */
export function photoIdsForPunches(punchKind: PunchKind, punchIds: number[]): Map<number, number> {
  const map = new Map<number, number>();
  if (!punchIds.length) return map;
  const placeholders = punchIds.map(() => '?').join(',');
  const rows = queryAll<{ id: number; punch_id: number }>(
    `SELECT id, punch_id FROM punch_photos WHERE punch_kind = ? AND punch_id IN (${placeholders})`,
    punchKind, ...punchIds
  );
  for (const r of rows) map.set(r.punch_id, r.id);
  return map;
}

export function punchPhotoPath(fileName: string): string {
  return path.join(photoDir(), fileName);
}

const uploadTmp = multer({
  // Lands in the tenant's root upload dir first (multer needs a folder that already exists at
  // request time; photoDir() creates kiosk-punches/ lazily) -- savePunchPhoto() then moves the
  // file into kiosk-punches/ under its real name.
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir()),
    filename: (_req, _file, cb) => cb(null, `tmp-punchphoto-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.jpg`),
  }),
  limits: { fileSize: 2 * 1024 * 1024 }, // the kiosk already compresses to a few tens of KB; this is generous headroom
  fileFilter: (_req, file, cb) => cb(null, file.mimetype === 'image/jpeg'),
});

/** Multipart field "photo" (JPEG only, 2 MB cap) into a temp file for savePunchPhoto; the file
 *  travels with a synced command. Also used by the phone's selfie step (clock.routes.ts). */
export const punchPhotoUpload = syncUpload(uploadTmp.single('photo'));

/** Multer errors (file too large, wrong field) -> 400, same as attachments.routes.ts. */
export function punchPhotoUploadErrors(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (err instanceof multer.MulterError) { res.status(400).json({ error: `Upload failed: ${err.message}` }); return; }
  next(err);
}

/** Builds the two routes a kiosk punch-photo feature needs: POST /:punchId (upload/replace,
 *  multipart field "photo") and GET /:id (serve). Both `/api/hr/clock/photo` (attendance) and
 *  `/api/hr/field/photo` (field work) mount one of these, differing only in which table
 *  `lookupPunch` checks the punch actually exists in -- everything else (storage, replace
 *  semantics, retention) is shared. The caller's router must already run requireAuth. */
export function punchPhotoRoutes(
  punchKind: PunchKind,
  lookupPunch: (punchId: number) => { employee_id: number } | undefined
): Router {
  const router = Router();

  // A punch photo records something that happened at the kiosk: `physical`, and the photo
  // travels with the command (docs/OFFLINE-FIRST.md §18, §20).
  router.post('/:punchId', requirePermission('hr.view'), syncClass('physical'), punchPhotoUpload, (req, res) => {
    const punchId = Number(req.params.punchId);
    const punch = Number.isInteger(punchId) ? lookupPunch(punchId) : undefined;
    if (!punch) {
      if (req.file) fs.promises.unlink(req.file.path).catch(() => { /* ignore */ });
      res.status(404).json({ error: 'Punch not found.' });
      return;
    }
    if (!req.file) { res.status(400).json({ error: 'A photo file is required.' }); return; }
    const { id } = savePunchPhoto(punchKind, punchId, punch.employee_id, req.file.path, req.file.size);
    // `url` is relative to /api (this app's convention — see API.get/post/blobUrl in
    // public/js/api.js, which all prepend /api themselves), NOT the literal fetchable path.
    res.status(201).json({ id, url: `${req.baseUrl.replace(/^\/api/, '')}/${id}` });
  });

  router.get('/:id', requirePermission('hr.view'), async (req, res) => {
    const row = getPunchPhotoFile(Number(req.params.id));
    if (!row) { res.status(404).json({ error: 'Photo not found.' }); return; }
    const file = await resolveDurableUploadAsync(`${PUNCH_PHOTOS_SUBDIR}/${row.file_name}`);
    if (!file) { res.status(410).json({ error: 'File is no longer available' }); return; }
    res.sendFile(file);
  });

  router.use(punchPhotoUploadErrors);

  return router;
}
