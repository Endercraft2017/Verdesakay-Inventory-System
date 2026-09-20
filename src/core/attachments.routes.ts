/** Photo attachments hung off another record — QC unit inspections, damage
 *  reports, problem reports, delivery proofs (photos + signature). Files stored
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
import { enforceQuota } from '../platform/quota';
import type { Permission } from '../shared/types';

const router = Router();
router.use(requireAuth);

const KINDS = new Set(['qc_unit', 'damage', 'problem', 'delivery', 'signature']);
const IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/** Which permission(s) a kind needs. `[]` = any authenticated user. */
const READ_PERMS: Record<string, Permission[]> = {
  qc_unit: ['inventory.view'],
  damage: ['inventory.view'],
  problem: [],
  delivery: ['delivery.run', 'delivery.manage'],
  signature: ['delivery.run', 'delivery.manage'],
};
const WRITE_PERMS: Record<string, Permission[]> = {
  qc_unit: ['inventory.adjust'],
  damage: ['inventory.adjust'],
  problem: [],
  delivery: ['delivery.run', 'delivery.manage'],
  signature: ['delivery.run', 'delivery.manage'],
};
function allows(req: Request, perms: Permission[]): boolean {
  return perms.length === 0 || perms.some((p) => req.user!.permissions.includes(p));
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir()),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).slice(0, 12) || '.jpg';
      cb(null, `att-${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, IMAGE_MIME.has(file.mimetype)),
});

function unlink(name: string | null | undefined): void {
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
  res.sendFile(file);
});

// POST /api/attachments — { kind, ref_id, caption? } + an `image` file
router.post('/', upload.single('image'), (req, res) => {
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
  const info = run(
    'INSERT INTO attachments (kind, ref_id, image_path, caption, uploaded_by) VALUES (?, ?, ?, ?, ?)',
    kind, refId, req.file.filename, caption || null, req.user!.id
  );
  const id = Number(info.lastInsertRowid);
  res.status(201).json({ id, url: `/api/attachments/${id}/image` });
});

// DELETE /api/attachments/:id
router.delete('/:id', (req, res) => {
  const row = queryOne<Row>('SELECT kind, image_path FROM attachments WHERE id = ?', Number(req.params.id));
  if (!row) { res.status(404).json({ error: 'Attachment not found' }); return; }
  if (!allows(req, WRITE_PERMS[row.kind] ?? ['inventory.adjust'])) { res.status(403).json({ error: 'Forbidden' }); return; }
  run('DELETE FROM attachments WHERE id = ?', Number(req.params.id));
  unlink(row.image_path);
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
