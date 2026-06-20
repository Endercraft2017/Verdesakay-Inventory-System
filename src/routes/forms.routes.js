'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { db, UPLOAD_DIR } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();
router.use(requireAuth);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).slice(0, 12);
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
});

// Forms visible to a user: shared (no department) + their own department.
// Admins see everything.
function visibilityClause(user) {
  if (user.role === 'admin') return { sql: '', params: [] };
  return {
    sql: ' WHERE (f.department_id IS NULL OR f.department_id = ?)',
    params: [user.department_id],
  };
}

// GET /api/forms  — list forms the user can see
router.get('/', (req, res) => {
  const vis = visibilityClause(req.user);
  const rows = db
    .prepare(
      `SELECT f.id, f.title, f.description, f.category, f.original_name, f.mime_type,
              f.size_bytes, f.department_id, f.created_at,
              d.name AS department_name, u.full_name AS uploaded_by_name
       FROM forms f
       LEFT JOIN departments d ON d.id = f.department_id
       LEFT JOIN users u ON u.id = f.uploaded_by
       ${vis.sql}
       ORDER BY f.created_at DESC`
    )
    .all(...vis.params);
  res.json(rows);
});

// POST /api/forms  — upload a form/document
router.post('/', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'A file is required' });

  const title = String((req.body || {}).title || '').trim() || req.file.originalname;
  const description = (req.body || {}).description ? String(req.body.description).trim() : null;
  const category = (req.body || {}).category ? String(req.body.category).trim() : null;
  const departmentId = (req.body || {}).department_id ? Number(req.body.department_id) : null;

  const info = db
    .prepare(
      `INSERT INTO forms
        (title, description, category, stored_name, original_name, mime_type, size_bytes,
         department_id, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      title,
      description,
      category,
      req.file.filename,
      req.file.originalname,
      req.file.mimetype,
      req.file.size,
      departmentId,
      req.user.id
    );
  res.status(201).json({ id: info.lastInsertRowid });
});

// GET /api/forms/:id/download
router.get('/:id/download', (req, res) => {
  const form = db.prepare('SELECT * FROM forms WHERE id = ?').get(Number(req.params.id));
  if (!form) return res.status(404).json({ error: 'Form not found' });

  // Enforce visibility.
  if (req.user.role !== 'admin' && form.department_id && form.department_id !== req.user.department_id) {
    return res.status(403).json({ error: 'You do not have access to this file' });
  }
  const filePath = path.join(UPLOAD_DIR, form.stored_name);
  if (!fs.existsSync(filePath)) return res.status(410).json({ error: 'File is missing on disk' });
  res.download(filePath, form.original_name);
});

// DELETE /api/forms/:id  — uploader or admin can delete
router.delete('/:id', (req, res) => {
  const form = db.prepare('SELECT * FROM forms WHERE id = ?').get(Number(req.params.id));
  if (!form) return res.status(404).json({ error: 'Form not found' });
  if (req.user.role !== 'admin' && form.uploaded_by !== req.user.id) {
    return res.status(403).json({ error: 'Only the uploader or an admin can delete this file' });
  }
  db.prepare('DELETE FROM forms WHERE id = ?').run(form.id);
  const filePath = path.join(UPLOAD_DIR, form.stored_name);
  fs.promises.unlink(filePath).catch(() => {}); // best effort
  res.json({ ok: true });
});

// Multer error handler (file too large, etc.)
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: `Upload failed: ${err.message}` });
  }
  next(err);
});

module.exports = router;
