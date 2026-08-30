/** Photo attachments hung off another record — QC unit inspections, damage
 *  reports, problem reports. Files stored under UPLOAD_DIR; rows in `attachments`.
 *  Mounted at /api/attachments. */
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { queryOne, queryAll, run, uploadDir } from '../db';
import { requireAuth, requirePermission } from '../auth';
import { enforceQuota } from '../quota';

const router = Router();
router.use(requireAuth);

const KINDS = new Set(['qc_unit', 'damage', 'problem']);
const IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

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
router.get('/', requirePermission('inventory.view'), (req, res) => {
  const kind = String(req.query.kind || '');
  const refId = Number(req.query.ref_id);
  if (!KINDS.has(kind) || !Number.isInteger(refId) || refId <= 0) {
    res.status(400).json({ error: 'kind and ref_id are required' });
    return;
  }
  const rows = queryAll<Row>(
    `SELECT a.id, a.kind, a.ref_id, a.caption, a.created_at, u.full_name AS uploaded_by_name
     FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by
     WHERE a.kind = ? AND a.ref_id = ? ORDER BY a.id`,
    kind, refId
  );
  res.json(rows.map((r) => ({ ...r, url: `/api/attachments/${r.id}/image` })));
});

// GET /api/attachments/:id/image — stream the file
router.get('/:id/image', requirePermission('inventory.view'), (req, res) => {
  const row = queryOne<Row>('SELECT image_path FROM attachments WHERE id = ?', Number(req.params.id));
  if (!row) { res.status(404).json({ error: 'Attachment not found' }); return; }
  const file = path.join(uploadDir(), row.image_path);
  if (!fs.existsSync(file)) { res.status(404).json({ error: 'File missing' }); return; }
  res.sendFile(file);
});

// POST /api/attachments — { kind, ref_id, caption? } + an `image` file
router.post('/', requirePermission('inventory.adjust'), upload.single('image'), (req, res) => {
  const kind = String(req.body?.kind || '');
  const refId = Number(req.body?.ref_id);
  const caption = typeof req.body?.caption === 'string' ? req.body.caption.trim().slice(0, 300) : null;
  if (!KINDS.has(kind) || !Number.isInteger(refId) || refId <= 0) {
    if (req.file) unlink(req.file.filename);
    res.status(400).json({ error: 'kind and ref_id are required' });
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
router.delete('/:id', requirePermission('inventory.adjust'), (req, res) => {
  const row = queryOne<Row>('SELECT image_path FROM attachments WHERE id = ?', Number(req.params.id));
  if (!row) { res.status(404).json({ error: 'Attachment not found' }); return; }
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
