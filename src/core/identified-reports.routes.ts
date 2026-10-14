/** Named employee reports: a private, auditable case channel distinct from anonymous reports
 * and from ordinary chat. Access is per-case, never granted by membership in a broad HR role. */
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { z } from 'zod';
import { db, queryAll, queryOne, run, uploadDir } from '../shared/db';
import { storeDurableUpload, resolveDurableUploadAsync } from '../shared/durable-uploads';
import { requireAuth } from '../shared/auth';
import { parseBody } from '../shared/validation';
import { notifyUser } from '../shared/push';
import { syncClass } from '../sync';
import { syncUpload } from '../sync/files';
import { enforceQuota } from '../platform/quota';

const router = Router();
router.use(requireAuth);
const statuses = ['new', 'triaged', 'investigating', 'resolved', 'closed'] as const;
const postSchema = z.object({ recipient_id: z.coerce.number().int().positive(), category: z.string().trim().min(1).max(100),
  subject: z.string().trim().min(1).max(140), description: z.string().trim().min(1).max(3000),
  incident_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')),
  incident_time: z.string().regex(/^\d{2}:\d{2}$/).optional().or(z.literal('')),
  location: z.string().trim().max(160).optional() });
const upload = multer({ storage: multer.diskStorage({ destination: (_req, _file, cb) => cb(null, uploadDir()),
  filename: (_req, file, cb) => cb(null, `ir-${Date.now()}-${crypto.randomBytes(8).toString('hex')}${path.extname(file.originalname).slice(0, 12)}`),
}), limits: { files: 4, fileSize: 5 * 1024 * 1024, fields: 16 } });
function removeFiles(files: Express.Multer.File[]) { files.forEach((f) => fs.promises.unlink(f.path).catch(() => {})); }
type CaseRow = { id: number; number: string; reporter_id: number; recipient_id: number; assignee_id: number | null;
  category: string; subject: string; description: string; incident_date: string | null; incident_time: string | null;
  location: string | null; status: string; created_at: string; updated_at: string; reporter_name: string; recipient_name: string; assignee_name: string | null };
const select = `SELECT r.*, reporter.full_name AS reporter_name, recipient.full_name AS recipient_name, assignee.full_name AS assignee_name
  FROM identified_reports r JOIN users reporter ON reporter.id = r.reporter_id
  JOIN users recipient ON recipient.id = r.recipient_id LEFT JOIN users assignee ON assignee.id = r.assignee_id`;
function one(id: number): CaseRow | undefined { return queryOne<CaseRow>(`${select} WHERE r.id = ?`, id); }
function permitted(row: CaseRow, uid: number): boolean { return [row.reporter_id, row.recipient_id, row.assignee_id].includes(uid); }
function getCase(id: number, uid: number): CaseRow | undefined { const row = one(id); return row && permitted(row, uid) ? row : undefined; }
function handler(row: CaseRow, uid: number): boolean { return uid === row.recipient_id || uid === row.assignee_id; }
function detail(row: CaseRow) {
  return { ...row,
    events: queryAll(`SELECT e.id, e.kind, e.body, e.created_at, u.full_name AS actor_name
      FROM identified_report_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.report_id = ? ORDER BY e.id`, row.id),
    attachments: queryAll<{ id: number; original_name: string; mime_type: string; size_bytes: number }>(
      'SELECT id, original_name, mime_type, size_bytes FROM identified_report_attachments WHERE report_id = ? ORDER BY id', row.id)
      .map((a) => ({ ...a, url: `/identified-reports/${row.id}/attachments/${a.id}` })) };
}
const link = (id: number) => ({ url: `#/report-problem?id=${id}`, link: { route: 'identified-reports', params: { id } } });

router.get('/', (req, res) => {
  const uid = req.user!.id;
  res.set('Cache-Control', 'private, no-store');
  res.json(queryAll<CaseRow>(`${select} WHERE r.reporter_id = ? OR r.recipient_id = ? OR r.assignee_id = ? ORDER BY r.id DESC LIMIT 200`, uid, uid, uid));
});
router.post('/', syncClass('merge'), syncUpload(upload.array('files', 4)), (req, res) => {
  const files = (req.files as Express.Multer.File[] | undefined) || [];
  let input: z.infer<typeof postSchema>;
  try { input = parseBody(postSchema, req.body); } catch (error) { removeFiles(files); throw error; }
  const uid = req.user!.id;
  if (input.recipient_id === uid) { removeFiles(files); res.status(400).json({ error: 'Choose another person to receive the report.' }); return; }
  const recipient = queryOne<{ id: number }>('SELECT id FROM users WHERE id = ? AND active = 1', input.recipient_id);
  if (!recipient) { removeFiles(files); res.status(400).json({ error: 'Recipient is not available.' }); return; }
  const allowed = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf',
    'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']);
  if (files.some((f) => !allowed.has(f.mimetype))) { removeFiles(files); res.status(400).json({ error: 'Use images, PDF, or Word documents for evidence.' }); return; }
  try { enforceQuota('storage_mb'); } catch (error) { removeFiles(files); throw error; }
  let id: number;
  db.exec('BEGIN IMMEDIATE');
  try {
    id = Number(run(`INSERT INTO identified_reports (reporter_id, recipient_id, assignee_id, category, subject, description,
      incident_date, incident_time, location) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, uid, input.recipient_id,
    input.recipient_id, input.category, input.subject, input.description, input.incident_date || null,
    input.incident_time || null, input.location || null).lastInsertRowid);
    run('UPDATE identified_reports SET number = ? WHERE id = ?', 'IR-' + String(id).padStart(6, '0'), id);
    run("INSERT INTO identified_report_events (report_id, actor_id, kind, body) VALUES (?, ?, 'submitted', ?)", id, uid, input.description);
    for (const f of files) {
      run('INSERT INTO identified_report_attachments (report_id, stored_name, original_name, mime_type, size_bytes) VALUES (?, ?, ?, ?, ?)',
        id, f.filename, f.originalname.slice(0, 200), f.mimetype, f.size);
      storeDurableUpload(f.filename);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); removeFiles(files); throw error; }
  void notifyUser(input.recipient_id, { title: 'New identified report', body: `IR-${String(id).padStart(6, '0')} · ${input.category}`, ...link(id) });
  res.status(201).json(detail(one(id)!));
});
router.get('/:id', (req, res) => {
  const row = getCase(Number(req.params.id), req.user!.id);
  if (!row) { res.status(404).json({ error: 'Report not found' }); return; }
  res.set('Cache-Control', 'private, no-store'); res.json({ ...detail(row), can_handle: handler(row, req.user!.id) });
});
router.get('/:id/attachments/:attachmentId', async (req, res) => {
  const row = getCase(Number(req.params.id), req.user!.id);
  if (!row) { res.status(404).json({ error: 'Attachment not found' }); return; }
  const file = queryOne<{ original_name: string; mime_type: string; stored_name: string }>(
    'SELECT original_name, mime_type, stored_name FROM identified_report_attachments WHERE report_id = ? AND id = ?', row.id, Number(req.params.attachmentId));
  if (!file) { res.status(404).json({ error: 'Attachment not found' }); return; }
  const location = await resolveDurableUploadAsync(path.basename(file.stored_name));
  if (!location) { res.status(410).json({ error: 'Evidence is no longer available.' }); return; }
  const inline = /^image\/(jpeg|png|webp)$/.test(file.mime_type);
  res.set({ 'Content-Type': inline ? file.mime_type : 'application/octet-stream',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.original_name)}`,
    'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' }); res.sendFile(location);
});
router.post('/:id/reply', syncClass('merge'), (req, res) => {
  const row = getCase(Number(req.params.id), req.user!.id);
  if (!row) { res.status(404).json({ error: 'Report not found' }); return; }
  if (row.status === 'closed') { res.status(409).json({ error: 'This report is closed.' }); return; }
  const { body } = parseBody(z.object({ body: z.string().trim().min(1).max(3000) }), req.body);
  run("INSERT INTO identified_report_events (report_id, actor_id, kind, body) VALUES (?, ?, 'reply', ?)", row.id, req.user!.id, body);
  run("UPDATE identified_reports SET updated_at = datetime('now') WHERE id = ?", row.id);
  const targets = handler(row, req.user!.id) ? [row.reporter_id] : [...new Set([row.recipient_id, row.assignee_id].filter((id): id is number => id != null))];
  for (const uid of targets.filter((id) => id !== req.user!.id)) void notifyUser(uid, { title: 'Identified report update', body: row.number, ...link(row.id) });
  res.json(detail(one(row.id)!));
});
router.post('/:id/status', syncClass('merge'), (req, res) => {
  const row = getCase(Number(req.params.id), req.user!.id);
  if (!row) { res.status(404).json({ error: 'Report not found' }); return; }
  if (!handler(row, req.user!.id)) { res.status(403).json({ error: 'Only the report handler can change status.' }); return; }
  const { status } = parseBody(z.object({ status: z.enum(statuses) }), req.body);
  if (status !== row.status) {
    run("UPDATE identified_reports SET status = ?, updated_at = datetime('now') WHERE id = ?", status, row.id);
    run("INSERT INTO identified_report_events (report_id, actor_id, kind, body) VALUES (?, ?, 'status', ?)", row.id, req.user!.id, status);
    void notifyUser(row.reporter_id, { title: 'Report status updated', body: `${row.number} · ${status}`, ...link(row.id) });
  }
  res.json(detail(one(row.id)!));
});
router.post('/:id/assign', syncClass('merge'), (req, res) => {
  const row = getCase(Number(req.params.id), req.user!.id);
  if (!row) { res.status(404).json({ error: 'Report not found' }); return; }
  if (!handler(row, req.user!.id)) { res.status(403).json({ error: 'Only the report handler can assign this case.' }); return; }
  const { user_id } = parseBody(z.object({ user_id: z.coerce.number().int().positive() }), req.body);
  const assignee = queryOne<{ id: number; full_name: string }>('SELECT id, full_name FROM users WHERE id = ? AND active = 1', user_id);
  if (!assignee || assignee.id === row.reporter_id) { res.status(400).json({ error: 'Choose an active staff member.' }); return; }
  run("UPDATE identified_reports SET assignee_id = ?, updated_at = datetime('now') WHERE id = ?", user_id, row.id);
  run("INSERT INTO identified_report_events (report_id, actor_id, kind, body) VALUES (?, ?, 'assigned', ?)", row.id, req.user!.id, assignee.full_name);
  if (user_id !== req.user!.id) void notifyUser(user_id, { title: 'Report assigned to you', body: row.number, ...link(row.id) });
  res.json(detail(one(row.id)!));
});
export default router;
