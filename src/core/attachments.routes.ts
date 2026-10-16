/** Photo attachments hung off another record — QC unit inspections, damage
 *  reports, problem reports, delivery proofs (photos + signature), release-slip photos. Files stored
 *  under UPLOAD_DIR; rows in `attachments`. Mounted at /api/attachments.
 *
 *  Permissions are per `kind` (see `canRead` / `canWrite`), so a delivery driver
 *  with only `delivery.run` can attach a POD photo without holding `inventory.*`. */
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { queryOne, queryAll, run, uploadDir } from '../shared/db';
import { requireAuth } from '../shared/auth';
import { LINE, UNIT_PHOTOS } from '../shared/desk-access';
import { enforceQuota } from '../platform/quota';
import type { Permission } from '../shared/types';
import { syncClass } from '../sync';
import { syncUpload } from '../sync/files';
import { sideEffectsSuppressed } from '../shared/sync-context';

const router = Router();
router.use(requireAuth);

const KINDS = new Set(['qc_unit', 'damage', 'problem', 'delivery', 'signature', 'release', 'release_proof', 'parts_release', 'production_issue']);
const IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/** Which permission(s) a kind needs. `[]` = any authenticated user. */
const READ_PERMS: Record<string, Permission[]> = {
  // A unit's photos (build photo, QC/QA evidence): production screens and the desks handling it.
  qc_unit: ['inventory.view', 'production.view', ...UNIT_PHOTOS],
  damage: ['inventory.view'],
  problem: [],
  delivery: ['delivery.run', 'delivery.manage'],
  signature: ['delivery.run', 'delivery.manage'],
  // Photos of goods leaving on a release slip (ref_id = release_slips.id).
  release: ['inventory.adjust', 'orders.release', 'orders.view'],
  // Handoff photos taken before the slip exists (ref_id = orders.id); the slip takes them over as 'release'.
  release_proof: ['inventory.adjust', 'orders.release', 'orders.view'],
  // Photos of the parts kit on a job order's parts release slip (ref_id = parts_release_slips.id).
  parts_release: ['inventory.view', 'production.view', ...LINE],
  // Photos on a production issue report (ref_id = production_issues.id).
  production_issue: ['inventory.view', 'production.view'],
};
// Everyone on the production floor: the line lead photographs each unit off the line, and the
// QC/QA inspectors photograph defects — none of them hold inventory.adjust.
const FLOOR_PERMS: Permission[] = [
  'inventory.adjust', 'production.record', 'production.inspect_qc', 'production.inspect_qa',
];
const WRITE_PERMS: Record<string, Permission[]> = {
  qc_unit: FLOOR_PERMS,
  damage: ['inventory.adjust'],
  problem: [],
  delivery: ['delivery.run', 'delivery.manage'],
  signature: ['delivery.run', 'delivery.manage'],
  release: ['inventory.adjust', 'orders.release'],
  release_proof: ['inventory.adjust', 'orders.release'],
  parts_release: ['inventory.adjust'],
  production_issue: [...FLOOR_PERMS, 'production.approve'],
};
function allows(req: Request, perms: Permission[]): boolean {
  return perms.length === 0 || perms.some((p) => req.user!.permissions.includes(p));
}

export const imageUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir()),
    filename: (_req, file, cb) => {
      const ext = ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' } as Record<string, string>)[file.mimetype] || '.jpg';
      cb(null, `att-${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, IMAGE_MIME.has(file.mimetype)),
});

export function unlink(name: string | null | undefined): void {
  if (name) fs.promises.unlink(path.join(uploadDir(), name)).catch(() => {});
}

interface Row {
  id: number; kind: string; ref_id: number; image_path: string;
  caption: string | null; uploaded_by: number | null; created_at: string;
  uploaded_by_name?: string | null;
}

// GET /api/attachments?kind=&ref_id= — list attachments for one record
router.get('/', (req, res) => {
  const kind = String(req.query.kind || '');
  const refId = Number(req.query.ref_id);
  if (!KINDS.has(kind) || !Number.isInteger(refId) || refId <= 0) {
    res.status(400).json({ error: 'kind and ref_id are required' });
    return;
  }
  if (!allows(req, READ_PERMS[kind] ?? ['inventory.view'])) { res.status(403).json({ error: 'Forbidden' }); return; }
  const rows = queryAll<Row>(
    `SELECT a.id, a.kind, a.ref_id, a.caption, a.created_at, u.full_name AS uploaded_by_name
     FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by
     WHERE a.kind = ? AND a.ref_id = ? ORDER BY a.id`,
    kind, refId
  );
  res.json(rows.map((r) => ({ ...r, url: `/api/attachments/${r.id}/image` })));
});

// GET /api/attachments/:id/image — stream the file
router.get('/:id/image', (req, res) => {
  const row = queryOne<Row>('SELECT kind, image_path FROM attachments WHERE id = ?', Number(req.params.id));
  if (!row) { res.status(404).json({ error: 'Attachment not found' }); return; }
  if (!allows(req, READ_PERMS[row.kind] ?? ['inventory.view'])) { res.status(403).json({ error: 'Forbidden' }); return; }
  const file = path.join(uploadDir(), row.image_path);
  if (!fs.existsSync(file)) { res.status(404).json({ error: 'File missing' }); return; }
  if (!/\.(?:jpe?g|png|gif|webp)$/i.test(file)) { res.attachment(path.basename(file)); res.type('application/octet-stream'); }
  res.sendFile(file);
});

// POST /api/attachments — { kind, ref_id, caption? } + an `image` file
// A photo is a fact: taken offline, it travels with its command (src/sync/files.ts).
router.post('/', syncClass('physical'), syncUpload(imageUpload.single('image')), (req, res) => {
  const kind = String(req.body?.kind || '');
  const refId = Number(req.body?.ref_id);
  const caption = typeof req.body?.caption === 'string' ? req.body.caption.trim().slice(0, 300) : null;
  if (!KINDS.has(kind) || !Number.isInteger(refId) || refId <= 0) {
    if (req.file) unlink(req.file.filename);
    res.status(400).json({ error: 'kind and ref_id are required' });
    return;
  }
  if (!allows(req, WRITE_PERMS[kind] ?? ['inventory.adjust'])) {
    if (req.file) unlink(req.file.filename);
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  if (!req.file) {
    res.status(400).json({ error: 'An image file is required (JPG, PNG, GIF or WebP)' });
    return;
  }
  try {
    enforceQuota('storage_mb', req.file.size);
  } catch (e) {
    unlink(req.file.filename);
    throw e;
  }
  const id = saveAttachment(kind, refId, req.file.filename, caption || null, req.user!.id);
  res.status(201).json({ id, url: `/api/attachments/${id}/image` });
});

/** Record an already-uploaded file (multer, via `imageUpload`) as an attachment. For routes
 *  that take a photo together with the record it belongs to (e.g. POST /job-orders/:id/units),
 *  so the two are saved in one request. Caller checks permissions and the storage quota. */
export function saveAttachment(kind: string, refId: number, filename: string, caption: string | null, userId: number): number {
  const info = run(
    'INSERT INTO attachments (kind, ref_id, image_path, caption, uploaded_by) VALUES (?, ?, ?, ?, ?)',
    kind, refId, filename, caption, userId
  );
  return Number(info.lastInsertRowid);
}

// DELETE /api/attachments/:id
router.delete('/:id', syncClass('claim'), (req, res) => {
  const row = queryOne<Row>('SELECT kind, image_path FROM attachments WHERE id = ?', Number(req.params.id));
  if (!row) { res.status(404).json({ error: 'Attachment not found' }); return; }
  if (!allows(req, WRITE_PERMS[row.kind] ?? ['inventory.adjust'])) { res.status(403).json({ error: 'Forbidden' }); return; }
  run('DELETE FROM attachments WHERE id = ?', Number(req.params.id));
  // An installed PC keeps the file until the cloud confirms: a refused delete brings the row back.
  if (!sideEffectsSuppressed('unlink')) unlink(row.image_path);
  res.json({ ok: true });
});

// Multer errors (file too large, wrong field) → 400
router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (err instanceof multer.MulterError) {
    res.status(400).json({ error: `Upload failed: ${err.message}` });
    return;
  }
  next(err);
});

export default router;
