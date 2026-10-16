/** In-app bug reporting: any signed-in user can file a report (title, steps to
 *  reproduce, up to 5 screenshots) from the sidebar; users.manage reviews and
 *  resolves them from Admin → Bug Reports. Files stored under UPLOAD_DIR, rows in
 *  `bug_reports` / `bug_report_attachments`. Mounted at /api/bug-reports. */
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { queryOne, queryAll, run, uploadDir } from '../shared/db';
import { requireAuth, requirePermission } from '../shared/auth';
import { parseBody, createBugReportSchema, updateBugReportSchema } from '../shared/validation';
import { enforceQuota } from '../platform/quota';
import type { BugReport } from '../shared/types';
import { syncClass } from '../sync';
import { syncUpload } from '../sync/files';

const router = Router();
router.use(requireAuth);

const MAX_SCREENSHOTS = 5;
const FILE_MAX_BYTES = 5 * 1024 * 1024; // 5 MB per screenshot
const IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir()),
    filename: (_req, file, cb) => {
      const ext = ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' } as Record<string, string>)[file.mimetype] || '.jpg';
      cb(null, `bug-${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: FILE_MAX_BYTES, files: MAX_SCREENSHOTS },
  fileFilter: (_req, file, cb) => cb(null, IMAGE_MIME.has(file.mimetype)),
});

function unlinkAll(files: Express.Multer.File[] | undefined): void {
  (files || []).forEach((f) => fs.promises.unlink(f.path).catch(() => {}));
}

interface ListRow extends BugReport {
  reporter_name: string | null;
  screenshot_count: number;
}

interface AttachmentRow {
  id: number; original_name: string; mime_type: string | null; size_bytes: number;
}

function withScreenshots(reportId: number): Array<AttachmentRow & { url: string }> {
  return queryAll<AttachmentRow>(
    'SELECT id, original_name, mime_type, size_bytes FROM bug_report_attachments WHERE bug_report_id = ? ORDER BY id',
    reportId
  ).map((a) => ({ ...a, url: `/bug-reports/${reportId}/screenshots/${a.id}` }));
}

// GET /api/bug-reports?status=open|resolved — admin list
router.get('/', requirePermission('users.manage'), (req, res) => {
  const status = req.query.status === 'open' || req.query.status === 'resolved' ? req.query.status : null;
  const rows = queryAll<ListRow>(
    `SELECT r.*, u.full_name AS reporter_name,
            (SELECT COUNT(*) FROM bug_report_attachments a WHERE a.bug_report_id = r.id) AS screenshot_count
     FROM bug_reports r LEFT JOIN users u ON u.id = r.reported_by
     ${status ? 'WHERE r.status = ?' : ''}
     ORDER BY r.id DESC`,
    ...(status ? [status] : [])
  );
  res.json(rows);
});

// GET /api/bug-reports/open-count — badge count for the sidebar button
router.get('/open-count', requirePermission('users.manage'), (_req, res) => {
  const { c } = queryOne<{ c: number }>("SELECT COUNT(*) AS c FROM bug_reports WHERE status = 'open'")!;
  res.json({ count: c });
});

// GET /api/bug-reports/:id — full detail + screenshots, admin only
router.get('/:id', requirePermission('users.manage'), (req, res) => {
  const row = queryOne<ListRow>(
    `SELECT r.*, u.full_name AS reporter_name,
            (SELECT COUNT(*) FROM bug_report_attachments a WHERE a.bug_report_id = r.id) AS screenshot_count
     FROM bug_reports r LEFT JOIN users u ON u.id = r.reported_by WHERE r.id = ?`,
    Number(req.params.id)
  );
  if (!row) { res.status(404).json({ error: 'Bug report not found' }); return; }
  res.json({ ...row, screenshots: withScreenshots(row.id) });
});

// GET /api/bug-reports/:id/screenshots/:attId — stream a screenshot, admin only
router.get('/:id/screenshots/:attId', requirePermission('users.manage'), (req, res) => {
  const att = queryOne<{ stored_name: string; original_name: string; mime_type: string | null }>(
    'SELECT stored_name, original_name, mime_type FROM bug_report_attachments WHERE id = ? AND bug_report_id = ?',
    Number(req.params.attId),
    Number(req.params.id)
  );
  if (!att) { res.status(404).json({ error: 'Screenshot not found' }); return; }
  const filePath = path.join(uploadDir(), att.stored_name);
  if (!fs.existsSync(filePath)) { res.status(410).json({ error: 'File is missing on disk' }); return; }
  if (att.mime_type) res.type(att.mime_type);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(att.original_name)}"`);
  if (!/\.(?:jpe?g|png|gif|webp)$/i.test(filePath)) { res.attachment(path.basename(filePath)); res.type('application/octet-stream'); }
  res.sendFile(filePath);
});

// POST /api/bug-reports — file a report; any signed-in user; up to 5 screenshots (field `screenshots`)
router.post('/', syncClass('merge'), syncUpload(upload.array('screenshots', MAX_SCREENSHOTS)), (req, res) => {
  const files = (req.files as Express.Multer.File[]) || [];
  let parsed: { title: string; steps_to_reproduce: string; description?: string | null; page_context?: string | null };
  try {
    parsed = parseBody(createBugReportSchema, req.body);
  } catch (e) {
    unlinkAll(files);
    throw e;
  }
  const addingBytes = files.reduce((sum, f) => sum + f.size, 0);
  if (addingBytes > 0) {
    try {
      enforceQuota('storage_mb', addingBytes);
    } catch (e) {
      unlinkAll(files);
      throw e;
    }
  }
  const info = run(
    'INSERT INTO bug_reports (title, steps_to_reproduce, description, page_context, reported_by) VALUES (?, ?, ?, ?, ?)',
    parsed.title,
    parsed.steps_to_reproduce,
    parsed.description ?? null,
    parsed.page_context ?? null,
    req.user!.id
  );
  const reportId = Number(info.lastInsertRowid);
  for (const f of files) {
    run(
      'INSERT INTO bug_report_attachments (bug_report_id, stored_name, original_name, mime_type, size_bytes) VALUES (?, ?, ?, ?, ?)',
      reportId,
      f.filename,
      f.originalname,
      f.mimetype,
      f.size
    );
  }
  res.status(201).json({ id: reportId, screenshots: files.length });
});

// PUT /api/bug-reports/:id — mark open/resolved, admin only
router.put('/:id', requirePermission('users.manage'), syncClass('claim'), (req, res) => {
  const input = parseBody(updateBugReportSchema, req.body);
  const id = Number(req.params.id);
  const info =
    input.status === 'resolved'
      ? run(
          "UPDATE bug_reports SET status = 'resolved', resolved_by = ?, resolved_at = datetime('now') WHERE id = ?",
          req.user!.id,
          id
        )
      : run(
          "UPDATE bug_reports SET status = 'open', resolved_by = NULL, resolved_at = NULL WHERE id = ?",
          id
        );
  if (info.changes === 0) { res.status(404).json({ error: 'Bug report not found' }); return; }
  res.json({ ok: true });
});

// Multer errors (file too large, too many files, wrong type) → 400
router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (err instanceof multer.MulterError) {
    const msg =
      err.code === 'LIMIT_FILE_SIZE'
        ? 'Each screenshot must be 5 MB or smaller.'
        : err.code === 'LIMIT_FILE_COUNT'
          ? `You can attach up to ${MAX_SCREENSHOTS} screenshots.`
          : err.message;
    res.status(400).json({ error: `Upload failed: ${msg}` });
    return;
  }
  next(err);
});

export default router;
