/** Forms & files: upload, list (with department visibility), download, delete. */
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { queryOne, queryAll, run, UPLOAD_DIR } from '../db';
import { requireAuth } from '../auth';
import type { AuthUser, FormRow } from '../types';

const router = Router();
router.use(requireAuth);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).slice(0, 12);
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  },
});

const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } }); // 25 MB

/** Forms visible to a user: shared (no dept) + own dept. Admins see all. */
function visibilityClause(user: AuthUser): { sql: string; params: unknown[] } {
  if (user.role === 'admin') return { sql: '', params: [] };
  return {
    sql: ' WHERE (f.department_id IS NULL OR f.department_id = ?)',
    params: [user.department_id],
  };
}

// GET /api/forms — list forms the user can see
router.get('/', (req, res) => {
  const vis = visibilityClause(req.user!);
  const rows = queryAll(
    `SELECT f.id, f.title, f.description, f.category, f.original_name, f.mime_type,
            f.size_bytes, f.department_id, f.created_at,
            d.name AS department_name, u.full_name AS uploaded_by_name
     FROM forms f
     LEFT JOIN departments d ON d.id = f.department_id
     LEFT JOIN users u ON u.id = f.uploaded_by
     ${vis.sql}
     ORDER BY f.created_at DESC`,
    ...vis.params
  );
  res.json(rows);
});

// POST /api/forms — upload a form/document
router.post('/', upload.single('file'), (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'A file is required' });
    return;
  }
  const body = req.body as Record<string, string>;
  const title = (body.title || '').trim() || req.file.originalname;
  const description = body.description ? body.description.trim() : null;
  const category = body.category ? body.category.trim() : null;
  const departmentId = body.department_id ? Number(body.department_id) : null;

  const info = run(
    `INSERT INTO forms
      (title, description, category, stored_name, original_name, mime_type, size_bytes,
       department_id, uploaded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    title,
    description,
    category,
    req.file.filename,
    req.file.originalname,
    req.file.mimetype,
    req.file.size,
    departmentId,
    req.user!.id
  );
  res.status(201).json({ id: info.lastInsertRowid });
});

// GET /api/forms/:id/download
router.get('/:id/download', (req, res) => {
  const form = queryOne<FormRow>('SELECT * FROM forms WHERE id = ?', Number(req.params.id));
  if (!form) {
    res.status(404).json({ error: 'Form not found' });
    return;
  }
  if (
    req.user!.role !== 'admin' &&
    form.department_id &&
    form.department_id !== req.user!.department_id
  ) {
    res.status(403).json({ error: 'You do not have access to this file' });
    return;
  }
  const filePath = path.join(UPLOAD_DIR, form.stored_name);
  if (!fs.existsSync(filePath)) {
    res.status(410).json({ error: 'File is missing on disk' });
    return;
  }
  res.download(filePath, form.original_name);
});

// DELETE /api/forms/:id — uploader or admin
router.delete('/:id', (req, res) => {
  const form = queryOne<FormRow>('SELECT * FROM forms WHERE id = ?', Number(req.params.id));
  if (!form) {
    res.status(404).json({ error: 'Form not found' });
    return;
  }
  if (req.user!.role !== 'admin' && form.uploaded_by !== req.user!.id) {
    res.status(403).json({ error: 'Only the uploader or an admin can delete this file' });
    return;
  }
  run('DELETE FROM forms WHERE id = ?', form.id);
  fs.promises.unlink(path.join(UPLOAD_DIR, form.stored_name)).catch(() => {});
  res.json({ ok: true });
});

// Multer-specific error handling (file too large, etc.)
router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (err instanceof multer.MulterError) {
    res.status(400).json({ error: `Upload failed: ${err.message}` });
    return;
  }
  next(err);
});

export default router;
