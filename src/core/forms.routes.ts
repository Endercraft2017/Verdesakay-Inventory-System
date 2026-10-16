import { safeDocumentType } from '../shared/file-response';
/** Forms & files: upload, list (with department visibility), download, delete. */
import path from 'node:path';
import fs from 'node:fs';
import { storeDurableUpload, resolveDurableUploadAsync, forgetDurableUpload } from '../shared/durable-uploads';
import crypto from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { queryOne, queryAll, run, uploadDir } from '../shared/db';
import { enforceQuota } from '../platform/quota';
import { requireAuth, requirePermission } from '../shared/auth';
import type { FormRow } from '../shared/types';
import { syncClass } from '../sync';
import { syncUpload } from '../sync/files';
import { sideEffectsSuppressed } from '../shared/sync-context';
import { visibilityClause } from './file-visibility';
export { visibilityClause } from './file-visibility';

const router = Router();
router.use(requireAuth);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir()),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).slice(0, 12);
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  },
});

const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } }); // 25 MB

// GET /api/forms — list forms the user can see
router.get('/', requirePermission('forms.view'), (req, res) => {
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
router.post('/', requirePermission('forms.upload'), syncClass('merge'), syncUpload(upload.single('file')), (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'A file is required' });
    return;
  }
  try { enforceQuota('storage_mb'); }
  catch (e) { fs.promises.unlink(path.join(uploadDir(), req.file.filename)).catch(() => {}); throw e; }
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
  storeDurableUpload(req.file.filename);
  res.status(201).json({ id: info.lastInsertRowid });
});

// GET /api/forms/:id/download
router.get('/:id/download', requirePermission('forms.view'), async (req, res) => {
  const form = queryOne<FormRow>('SELECT * FROM forms WHERE id = ?', Number(req.params.id));
  if (!form) {
    res.status(404).json({ error: 'Form not found' });
    return;
  }
  if (
    !req.user!.permissions.includes('users.manage') &&
    form.department_id &&
    form.department_id !== req.user!.department_id
  ) {
    res.status(403).json({ error: 'You do not have access to this file' });
    return;
  }
  const filePath = await resolveDurableUploadAsync(form.stored_name);
  if (!filePath) {
    res.status(410).json({ error: 'File is missing on disk' });
    return;
  }
  safeDocumentType(res, form.mime_type);
  res.download(filePath, form.original_name);
});

// DELETE /api/forms/:id — uploader or admin
router.delete('/:id', syncClass('claim'), (req, res) => {
  const form = queryOne<FormRow>('SELECT * FROM forms WHERE id = ?', Number(req.params.id));
  if (!form) {
    res.status(404).json({ error: 'Form not found' });
    return;
  }
  if (!req.user!.permissions.includes('forms.delete') && form.uploaded_by !== req.user!.id) {
    res.status(403).json({ error: 'Only the uploader or someone with delete permission can delete this file' });
    return;
  }
  run('DELETE FROM forms WHERE id = ?', form.id);
  // An installed PC keeps the file until the cloud confirms: a refused delete brings the row back.
  if (!sideEffectsSuppressed('unlink')) {
    forgetDurableUpload(form.stored_name);
    fs.promises.unlink(path.join(uploadDir(), form.stored_name)).catch(() => {});
  }
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
