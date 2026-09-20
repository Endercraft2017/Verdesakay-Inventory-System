/** Internal messaging: inbox/sent, unread count, send (+ attachments), mark read, delete. */
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { queryOne, queryAll, run, uploadDir } from '../db';
import { requireAuth, requirePermission } from '../auth';
import { parseBody, sendMessageSchema } from '../validation';
import { notifyUser } from '../push';

const router = Router();
router.use(requireAuth);

/** Fixed per-user pool for message attachments — independent of the tenant's plan
 *  storage_mb quota (see src/quota.ts). Freed automatically as messages are deleted. */
const USER_STORAGE_CAP_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB
const FILE_MAX_BYTES = 10 * 1024 * 1024; // 10 MB per file
const MAX_FILES_PER_MESSAGE = 10;

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir()),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).slice(0, 12);
      cb(null, `msg-${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: FILE_MAX_BYTES, files: MAX_FILES_PER_MESSAGE },
});

function unlinkAll(files: Express.Multer.File[] | undefined): void {
  (files || []).forEach((f) => fs.promises.unlink(f.path).catch(() => {}));
}

/** Bytes currently used by `userId`'s sent attachments (freed as messages are deleted). */
function userStorageUsed(userId: number): number {
  return queryOne<{ bytes: number }>(
    `SELECT COALESCE(SUM(ma.size_bytes), 0) AS bytes
     FROM message_attachments ma JOIN messages m ON m.id = ma.message_id
     WHERE m.sender_id = ?`,
    userId
  )!.bytes;
}

interface AttachmentRow {
  id: number; message_id: number; original_name: string; mime_type: string | null; size_bytes: number;
}

/** Batch-fetch attachments for a page of messages and hang them off each row as `attachments`. */
function withAttachments<T extends { id: number }>(rows: T[]): (T & { attachments: unknown[] })[] {
  const ids = rows.map((r) => r.id);
  const map = new Map<number, AttachmentRow[]>();
  if (ids.length) {
    const atts = queryAll<AttachmentRow>(
      `SELECT id, message_id, original_name, mime_type, size_bytes FROM message_attachments
       WHERE message_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`,
      ...ids
    );
    for (const a of atts) {
      const list = map.get(a.message_id) || [];
      list.push(a);
      map.set(a.message_id, list);
    }
  }
  return rows.map((r) => ({
    ...r,
    attachments: (map.get(r.id) || []).map((a) => ({
      id: a.id,
      name: a.original_name,
      mime_type: a.mime_type,
      size_bytes: a.size_bytes,
      url: `/messages/${r.id}/attachments/${a.id}`,
    })),
  }));
}

interface MessageRow {
  id: number; subject: string | null; body: string; read_at: string | null; created_at: string;
  other_id: number; other_name: string; other_username: string;
}

// GET /api/messages?box=inbox|sent
router.get('/', requirePermission('messages.view'), (req, res) => {
  const box = req.query.box === 'sent' ? 'sent' : 'inbox';
  const uid = req.user!.id;
  const rows =
    box === 'inbox'
      ? queryAll<MessageRow>(
          `SELECT m.id, m.subject, m.body, m.read_at, m.created_at,
                  m.sender_id AS other_id, u.full_name AS other_name, u.username AS other_username
           FROM messages m JOIN users u ON u.id = m.sender_id
           WHERE m.recipient_id = ?
           ORDER BY m.id DESC`,
          uid
        )
      : queryAll<MessageRow>(
          `SELECT m.id, m.subject, m.body, m.read_at, m.created_at,
                  m.recipient_id AS other_id, u.full_name AS other_name, u.username AS other_username
           FROM messages m JOIN users u ON u.id = m.recipient_id
           WHERE m.sender_id = ?
           ORDER BY m.id DESC`,
          uid
        );
  res.json(withAttachments(rows));
});

// GET /api/messages/unread-count
router.get('/unread-count', requirePermission('messages.view'), (req, res) => {
  const c = queryOne<{ c: number }>(
    'SELECT COUNT(*) AS c FROM messages WHERE recipient_id = ? AND read_at IS NULL',
    req.user!.id
  )!.c;
  res.json({ count: c });
});

// GET /api/messages/quota — the caller's attachment storage usage
router.get('/quota', requirePermission('messages.view'), (req, res) => {
  res.json({ used_bytes: userStorageUsed(req.user!.id), cap_bytes: USER_STORAGE_CAP_BYTES });
});

// POST /api/messages — send a message, optionally with up to 10 files (field `files`)
router.post('/', requirePermission('messages.send'), upload.array('files', MAX_FILES_PER_MESSAGE), (req, res) => {
  const files = (req.files as Express.Multer.File[]) || [];
  let parsed: { recipient_id: number; subject?: string | null; body: string };
  try {
    parsed = parseBody(sendMessageSchema, req.body);
  } catch (e) {
    unlinkAll(files);
    throw e;
  }
  const { recipient_id, subject, body } = parsed;
  if (recipient_id === req.user!.id) {
    unlinkAll(files);
    res.status(400).json({ error: 'You cannot message yourself' });
    return;
  }
  const recipient = queryOne('SELECT id FROM users WHERE id = ? AND active = 1', recipient_id);
  if (!recipient) {
    unlinkAll(files);
    res.status(404).json({ error: 'Recipient not found' });
    return;
  }
  const addingBytes = files.reduce((sum, f) => sum + f.size, 0);
  if (addingBytes > 0) {
    const used = userStorageUsed(req.user!.id);
    if (used + addingBytes > USER_STORAGE_CAP_BYTES) {
      unlinkAll(files);
      const usedGb = (used / 1024 ** 3).toFixed(2);
      res.status(413).json({
        error: `You've used ${usedGb} GB of your 5 GB attachment storage. Delete some old messages to free up space.`,
      });
      return;
    }
  }
  const info = run(
    'INSERT INTO messages (sender_id, recipient_id, subject, body) VALUES (?, ?, ?, ?)',
    req.user!.id,
    recipient_id,
    subject ?? null,
    body
  );
  const messageId = Number(info.lastInsertRowid);
  for (const f of files) {
    run(
      'INSERT INTO message_attachments (message_id, stored_name, original_name, mime_type, size_bytes) VALUES (?, ?, ?, ?, ?)',
      messageId,
      f.filename,
      f.originalname,
      f.mimetype,
      f.size
    );
  }
  void notifyUser(recipient_id, {
    title: subject ? `Message: ${subject}` : `New message from ${req.user!.full_name}`,
    body: body.length > 140 ? body.slice(0, 137) + '…' : body,
    url: '#/home',
    tag: 'msg',
  });
  res.status(201).json({ id: messageId, attachments: files.length });
});

// GET /api/messages/:id/attachments/:attId — stream a message's attached file
router.get('/:id/attachments/:attId', requirePermission('messages.view'), (req, res) => {
  const messageId = Number(req.params.id);
  const uid = req.user!.id;
  const msg = queryOne<{ sender_id: number; recipient_id: number }>(
    'SELECT sender_id, recipient_id FROM messages WHERE id = ?',
    messageId
  );
  if (!msg) {
    res.status(404).json({ error: 'Message not found' });
    return;
  }
  if (msg.sender_id !== uid && msg.recipient_id !== uid) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  const att = queryOne<{ stored_name: string; original_name: string; mime_type: string | null }>(
    'SELECT stored_name, original_name, mime_type FROM message_attachments WHERE id = ? AND message_id = ?',
    Number(req.params.attId),
    messageId
  );
  if (!att) {
    res.status(404).json({ error: 'Attachment not found' });
    return;
  }
  const filePath = path.join(uploadDir(), att.stored_name);
  if (!fs.existsSync(filePath)) {
    res.status(410).json({ error: 'File is missing on disk' });
    return;
  }
  if (att.mime_type) res.type(att.mime_type);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(att.original_name)}"`);
  res.sendFile(filePath);
});

// POST /api/messages/:id/read — mark a received message read
router.post('/:id/read', requirePermission('messages.view'), (req, res) => {
  const info = run(
    "UPDATE messages SET read_at = datetime('now') WHERE id = ? AND recipient_id = ? AND read_at IS NULL",
    Number(req.params.id),
    req.user!.id
  );
  res.json({ ok: true, updated: info.changes });
});

// DELETE /api/messages/:id — sender or recipient; also removes any attached files on disk
router.delete('/:id', (req, res) => {
  const uid = req.user!.id;
  const messageId = Number(req.params.id);
  const atts = queryAll<{ stored_name: string }>(
    'SELECT stored_name FROM message_attachments WHERE message_id = ?',
    messageId
  );
  const info = run(
    'DELETE FROM messages WHERE id = ? AND (sender_id = ? OR recipient_id = ?)',
    messageId,
    uid,
    uid
  );
  if (info.changes === 0) {
    res.status(404).json({ error: 'Message not found' });
    return;
  }
  atts.forEach((a) => fs.promises.unlink(path.join(uploadDir(), a.stored_name)).catch(() => {}));
  res.json({ ok: true });
});

// Multer errors (file too large, too many files) → 400
router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (err instanceof multer.MulterError) {
    const msg =
      err.code === 'LIMIT_FILE_SIZE'
        ? 'Each attachment must be 10 MB or smaller.'
        : err.code === 'LIMIT_FILE_COUNT'
          ? `You can attach up to ${MAX_FILES_PER_MESSAGE} files per message.`
          : err.message;
    res.status(400).json({ error: `Upload failed: ${msg}` });
    return;
  }
  next(err);
});

export default router;
