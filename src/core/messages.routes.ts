/** Internal 1:1 chat: conversations, threaded messages (reply/edit/soft-delete/react),
 *  attachments, link previews, unread count. Mounted at /api/messages. */
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { queryOne, queryAll, run, uploadDir, tenantStore, DEFAULT_TENANT } from '../shared/db';
import { requireAuth, requirePermission } from '../shared/auth';
import { parseBody, sendMessageSchema, editMessageSchema, reactSchema } from '../shared/validation';
import { notifyUser } from '../shared/push';
import { broadcast } from '../shared/ws';

const router = Router();
router.use(requireAuth);

function currentSlug(): string {
  return tenantStore.getStore()?.slug ?? DEFAULT_TENANT;
}

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

interface ReactionRow { message_id: number; user_id: number; emoji: string }

/** Batch-fetch reactions and aggregate to `[{emoji, count, mine}]`, `mine` relative to
 *  `viewerId`. Used by per-viewer REST responses (not by the viewer-agnostic WS payload,
 *  which sends the raw per-user rows instead — see `hydrateMessageForBroadcast`). */
function withReactions<T extends { id: number }>(
  rows: T[],
  viewerId: number
): (T & { reactions: { emoji: string; count: number; mine: boolean }[] })[] {
  const ids = rows.map((r) => r.id);
  const map = new Map<number, ReactionRow[]>();
  if (ids.length) {
    const reax = queryAll<ReactionRow>(
      `SELECT message_id, user_id, emoji FROM message_reactions
       WHERE message_id IN (${ids.map(() => '?').join(',')})`,
      ...ids
    );
    for (const r of reax) {
      const list = map.get(r.message_id) || [];
      list.push(r);
      map.set(r.message_id, list);
    }
  }
  return rows.map((r) => {
    const byEmoji = new Map<string, { emoji: string; count: number; mine: boolean }>();
    for (const x of map.get(r.id) || []) {
      const cur = byEmoji.get(x.emoji) || { emoji: x.emoji, count: 0, mine: false };
      cur.count += 1;
      if (x.user_id === viewerId) cur.mine = true;
      byEmoji.set(x.emoji, cur);
    }
    return { ...r, reactions: [...byEmoji.values()] };
  });
}

interface ReplyParentRow { id: number; body: string; deleted_at: string | null; sender_id: number }

/** Batch-fetch each row's `reply_to_id` target and hang a small quoted preview off it as
 *  `reply_to` (null if the row isn't a reply). Viewer-agnostic — safe for WS broadcast too. */
function withReplyPreview<T extends { id: number; reply_to_id: number | null }>(
  rows: T[]
): (T & { reply_to: null | { id: number; author: string; preview: string } })[] {
  const parentIds = [...new Set(rows.map((r) => r.reply_to_id).filter((x): x is number => x != null))];
  const parents = new Map<number, ReplyParentRow>();
  if (parentIds.length) {
    queryAll<ReplyParentRow>(
      `SELECT id, body, deleted_at, sender_id FROM messages WHERE id IN (${parentIds.map(() => '?').join(',')})`,
      ...parentIds
    ).forEach((p) => parents.set(p.id, p));
  }
  const senderIds = [...new Set([...parents.values()].map((p) => p.sender_id))];
  const names = new Map<number, string>();
  if (senderIds.length) {
    queryAll<{ id: number; full_name: string }>(
      `SELECT id, full_name FROM users WHERE id IN (${senderIds.map(() => '?').join(',')})`,
      ...senderIds
    ).forEach((u) => names.set(u.id, u.full_name));
  }
  return rows.map((r) => {
    if (r.reply_to_id == null) return { ...r, reply_to: null };
    const p = parents.get(r.reply_to_id);
    if (!p) return { ...r, reply_to: null };
    const preview = p.deleted_at ? 'Message was removed' : p.body.length > 120 ? p.body.slice(0, 117) + '…' : p.body;
    return { ...r, reply_to: { id: p.id, author: names.get(p.sender_id) ?? '', preview } };
  });
}

interface MessageFullRow {
  id: number; sender_id: number; recipient_id: number; subject: string | null; body: string;
  read_at: string | null; created_at: string; edited_at: string | null; deleted_at: string | null;
  reply_to_id: number | null;
}

/** Full, viewer-agnostic shape of one message for a WS broadcast payload. Reactions are
 *  sent as raw per-user rows (not aggregated with `mine`) since a broadcast fans out to
 *  both participants at once and "mine" is viewer-relative. */
function hydrateMessageForBroadcast(id: number): unknown {
  const row = queryOne<MessageFullRow>(
    `SELECT id, sender_id, recipient_id, subject, body, read_at, created_at, edited_at, deleted_at, reply_to_id
     FROM messages WHERE id = ?`,
    id
  );
  if (!row) return null;
  const withAtt = withAttachments([row])[0]!;
  const withReply = withReplyPreview([withAtt])[0]!;
  const reactions = queryAll<{ emoji: string; user_id: number }>(
    'SELECT emoji, user_id FROM message_reactions WHERE message_id = ?',
    id
  );
  return { ...withReply, reactions };
}

interface MessageRow {
  id: number; subject: string | null; body: string; read_at: string | null; created_at: string;
  other_id: number; other_name: string; other_username: string;
}

// GET /api/messages?box=inbox|sent — legacy email-style listing, kept for the AI tools
// (src/modules/ai/ai-tools.ts) and anything else still reading it directly.
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

// GET /api/messages/conversations — one row per counterpart, for the chat UI's left pane.
router.get('/conversations', requirePermission('messages.view'), (req, res) => {
  const uid = req.user!.id;
  const partners = queryAll<{ other_id: number; last_id: number }>(
    `SELECT other_id, MAX(id) AS last_id FROM (
       SELECT recipient_id AS other_id, id FROM messages WHERE sender_id = ?
       UNION ALL
       SELECT sender_id AS other_id, id FROM messages WHERE recipient_id = ?
     ) GROUP BY other_id ORDER BY last_id DESC`,
    uid,
    uid
  );
  const rows = partners.map((p) => {
    const other = queryOne<{ id: number; full_name: string; username: string }>(
      'SELECT id, full_name, username FROM users WHERE id = ?',
      p.other_id
    );
    const last = queryOne<{ body: string; created_at: string; sender_id: number; deleted_at: string | null }>(
      'SELECT body, created_at, sender_id, deleted_at FROM messages WHERE id = ?',
      p.last_id
    )!;
    const unread = queryOne<{ c: number }>(
      'SELECT COUNT(*) AS c FROM messages WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL AND deleted_at IS NULL',
      p.other_id,
      uid
    )!.c;
    return {
      other_id: p.other_id,
      other_name: other?.full_name ?? '(deleted user)',
      other_username: other?.username ?? '',
      last_message: last.deleted_at ? 'Message was removed' : last.body,
      last_message_at: last.created_at,
      last_message_mine: last.sender_id === uid,
      unread_count: unread,
    };
  });
  res.json(rows);
});

// GET /api/messages/with/:userId?before=<id>&limit=<n> — the full thread with one
// counterpart, newest-first, cursor-paginated.
router.get('/with/:userId', requirePermission('messages.view'), (req, res) => {
  const uid = req.user!.id;
  const otherId = Number(req.params.userId);
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const before = req.query.before ? Number(req.query.before) : null;
  const rows = queryAll<MessageFullRow>(
    `SELECT id, sender_id, recipient_id, subject, body, read_at, created_at, edited_at, deleted_at, reply_to_id
     FROM messages
     WHERE ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))
       ${before ? 'AND id < ?' : ''}
     ORDER BY id DESC LIMIT ?`,
    uid,
    otherId,
    otherId,
    uid,
    ...(before ? [before] : []),
    limit
  );
  const withAtt = withAttachments(rows);
  const withReact = withReactions(withAtt, uid);
  const withReply = withReplyPreview(withReact);
  res.json(withReply.map((r) => ({ ...r, mine: r.sender_id === uid })));
});

// POST /api/messages/with/:userId/read — bulk-mark every unread message from that user
// read (opening a thread reads the whole thing, not one message at a time).
router.post('/with/:userId/read', requirePermission('messages.view'), (req, res) => {
  const info = run(
    "UPDATE messages SET read_at = datetime('now') WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL",
    Number(req.params.userId),
    req.user!.id
  );
  res.json({ ok: true, updated: info.changes });
});

// POST /api/messages — send a message, optionally with up to 10 files (field `files`)
// and/or a `reply_to_id` quoting an earlier message in the same conversation.
router.post('/', requirePermission('messages.send'), upload.array('files', MAX_FILES_PER_MESSAGE), (req, res) => {
  const files = (req.files as Express.Multer.File[]) || [];
  let parsed: { recipient_id: number; subject?: string | null; body: string; reply_to_id?: number };
  try {
    parsed = parseBody(sendMessageSchema, req.body);
  } catch (e) {
    unlinkAll(files);
    throw e;
  }
  const { recipient_id, subject, body, reply_to_id } = parsed;
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
  if (reply_to_id) {
    const parent = queryOne<{ sender_id: number; recipient_id: number; deleted_at: string | null }>(
      'SELECT sender_id, recipient_id, deleted_at FROM messages WHERE id = ?',
      reply_to_id
    );
    const parties = parent ? new Set([parent.sender_id, parent.recipient_id]) : null;
    if (!parent || parent.deleted_at || !parties!.has(req.user!.id) || !parties!.has(recipient_id)) {
      unlinkAll(files);
      res.status(400).json({ error: 'The message being replied to was not found in this conversation' });
      return;
    }
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
    'INSERT INTO messages (sender_id, recipient_id, subject, body, reply_to_id) VALUES (?, ?, ?, ?, ?)',
    req.user!.id,
    recipient_id,
    subject ?? null,
    body,
    reply_to_id ?? null
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
  broadcast(currentSlug(), [recipient_id, req.user!.id], { type: 'message:new', data: hydrateMessageForBroadcast(messageId) });
  void notifyUser(recipient_id, {
    title: subject ? `Message: ${subject}` : `New message from ${req.user!.full_name}`,
    body: body.length > 140 ? body.slice(0, 137) + '…' : body,
    url: '#/home',
    tag: 'msg',
  });
  res.status(201).json({ id: messageId, attachments: files.length });
});

// PATCH /api/messages/:id — sender-only edit.
router.patch('/:id', requirePermission('messages.send'), (req, res) => {
  const { body } = parseBody(editMessageSchema, req.body);
  const id = Number(req.params.id);
  const msg = queryOne<{ sender_id: number; recipient_id: number; deleted_at: string | null }>(
    'SELECT sender_id, recipient_id, deleted_at FROM messages WHERE id = ?',
    id
  );
  if (!msg) {
    res.status(404).json({ error: 'Message not found' });
    return;
  }
  if (msg.sender_id !== req.user!.id) {
    res.status(403).json({ error: 'Only the sender can edit this message' });
    return;
  }
  if (msg.deleted_at) {
    res.status(400).json({ error: 'Cannot edit a removed message' });
    return;
  }
  run("UPDATE messages SET body = ?, edited_at = datetime('now') WHERE id = ?", body, id);
  const edited_at = queryOne<{ edited_at: string }>('SELECT edited_at FROM messages WHERE id = ?', id)!.edited_at;
  broadcast(currentSlug(), [msg.sender_id, msg.recipient_id], { type: 'message:edited', data: { id, body, edited_at } });
  res.json({ ok: true, edited_at });
});

// POST /api/messages/:id/react {emoji} — sender or recipient; re-sending the same emoji
// toggles the reaction off, a different emoji replaces it (one reaction per user).
router.post('/:id/react', requirePermission('messages.view'), (req, res) => {
  const { emoji } = parseBody(reactSchema, req.body);
  const uid = req.user!.id;
  const id = Number(req.params.id);
  const msg = queryOne<{ sender_id: number; recipient_id: number; deleted_at: string | null }>(
    'SELECT sender_id, recipient_id, deleted_at FROM messages WHERE id = ?',
    id
  );
  if (!msg) {
    res.status(404).json({ error: 'Message not found' });
    return;
  }
  if (msg.sender_id !== uid && msg.recipient_id !== uid) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  if (msg.deleted_at) {
    res.status(400).json({ error: 'Cannot react to a removed message' });
    return;
  }
  const existing = queryOne<{ emoji: string }>(
    'SELECT emoji FROM message_reactions WHERE message_id = ? AND user_id = ?',
    id,
    uid
  );
  if (existing && existing.emoji === emoji) {
    run('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ?', id, uid);
  } else {
    run(
      `INSERT INTO message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)
       ON CONFLICT(message_id, user_id) DO UPDATE SET emoji = excluded.emoji, created_at = datetime('now')`,
      id,
      uid,
      emoji
    );
  }
  const reactions = queryAll<{ emoji: string; user_id: number }>(
    'SELECT emoji, user_id FROM message_reactions WHERE message_id = ?',
    id
  );
  broadcast(currentSlug(), [msg.sender_id, msg.recipient_id], { type: 'reaction:changed', data: { message_id: id, reactions } });
  res.json({ ok: true, reactions });
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

// POST /api/messages/:id/read — mark a single received message read (kept alongside the
// bulk POST /with/:userId/read; used directly by the AI tools).
router.post('/:id/read', requirePermission('messages.view'), (req, res) => {
  const info = run(
    "UPDATE messages SET read_at = datetime('now') WHERE id = ? AND recipient_id = ? AND read_at IS NULL",
    Number(req.params.id),
    req.user!.id
  );
  res.json({ ok: true, updated: info.changes });
});

// DELETE /api/messages/:id — sender-only "unsend": soft-deletes (clears body, removes
// attachments/reactions) rather than dropping the row, so the recipient sees "Message was
// removed" instead of the thread silently losing a message.
router.delete('/:id', requirePermission('messages.send'), (req, res) => {
  const uid = req.user!.id;
  const id = Number(req.params.id);
  const msg = queryOne<{ sender_id: number; recipient_id: number; deleted_at: string | null }>(
    'SELECT sender_id, recipient_id, deleted_at FROM messages WHERE id = ?',
    id
  );
  if (!msg) {
    res.status(404).json({ error: 'Message not found' });
    return;
  }
  if (msg.sender_id !== uid) {
    res.status(403).json({ error: 'Only the sender can remove this message' });
    return;
  }
  if (msg.deleted_at) {
    res.json({ ok: true });
    return;
  }
  const atts = queryAll<{ stored_name: string }>('SELECT stored_name FROM message_attachments WHERE message_id = ?', id);
  run("UPDATE messages SET body = '', subject = NULL, deleted_at = datetime('now'), deleted_by = ? WHERE id = ?", uid, id);
  run('DELETE FROM message_attachments WHERE message_id = ?', id);
  run('DELETE FROM message_reactions WHERE message_id = ?', id);
  atts.forEach((a) => fs.promises.unlink(path.join(uploadDir(), a.stored_name)).catch(() => {}));
  broadcast(currentSlug(), [msg.sender_id, msg.recipient_id], { type: 'message:deleted', data: { id } });
  res.json({ ok: true });
});

// ---- Link previews ----

const LINK_PREVIEW_TIMEOUT_MS = 5000;
const LINK_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
const LINK_PREVIEW_MAX_REDIRECTS = 3;
const LINK_PREVIEW_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts;
    if (a === undefined || b === undefined) return true;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    if (low === '::1' || low === '::') return true;
    if (low.startsWith('fe80:') || low.startsWith('fc') || low.startsWith('fd')) return true;
    if (low.startsWith('::ffff:')) return isPrivateIp(low.slice(7));
    return false;
  }
  return true; // not a literal IP we recognize -- treat conservatively as unsafe
}

/** True if `hostname` (as given by `URL#hostname`, which brackets a literal IPv6 address
 *  e.g. `[::1]`) is or resolves to a loopback/private/link-local address, or fails to
 *  resolve at all. Used to block SSRF via the link-preview fetcher. */
async function isPrivateHost(hostname: string): Promise<boolean> {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return isPrivateIp(host);
  try {
    const addrs = await dns.lookup(host, { all: true });
    return addrs.length === 0 || addrs.some((a) => isPrivateIp(a.address));
  } catch {
    return true;
  }
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'");
}

function metaContent(html: string, prop: string): string | undefined {
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return decodeHtmlEntities(m[1]!.trim());
  }
  return undefined;
}

interface LinkPreviewData { title?: string; description?: string; image_url?: string; site_name?: string }

function parseOgTags(html: string, baseUrl: string): LinkPreviewData | null {
  const title = metaContent(html, 'og:title') || html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim();
  const description = metaContent(html, 'og:description') || metaContent(html, 'description');
  let image = metaContent(html, 'og:image');
  if (image) {
    try {
      image = new URL(image, baseUrl).toString();
    } catch {
      image = undefined;
    }
  }
  const site_name = metaContent(html, 'og:site_name');
  if (!title && !description && !image) return null;
  return { title, description, image_url: image, site_name };
}

/** Fetch `startUrl` and parse its OG tags, re-validating every hop of up to
 *  `LINK_PREVIEW_MAX_REDIRECTS` manual redirects against `isPrivateHost` (a redirect is
 *  the classic SSRF bypass for a naive "check the URL once" guard). Returns null on any
 *  failure — non-http(s), private/unresolvable host, timeout, non-HTML response, oversized
 *  body, or no recognizable OG/title data. */
async function fetchLinkPreview(startUrl: string): Promise<LinkPreviewData | null> {
  let current = startUrl;
  for (let hop = 0; hop <= LINK_PREVIEW_MAX_REDIRECTS; hop++) {
    let parsed: URL;
    try {
      parsed = new URL(current);
    } catch {
      return null;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (await isPrivateHost(parsed.hostname)) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LINK_PREVIEW_TIMEOUT_MS);
    let resp: globalThis.Response;
    try {
      resp = await fetch(parsed, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': 'OtomLinkPreview/1.0' },
      });
    } catch {
      clearTimeout(timer);
      return null;
    }
    clearTimeout(timer);

    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('location');
      if (!loc) return null;
      try {
        current = new URL(loc, parsed).toString();
      } catch {
        return null;
      }
      continue;
    }
    if (!resp.ok) return null;
    const contentType = resp.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) return null;

    const reader = resp.body?.getReader();
    if (!reader) return null;
    let received = 0;
    let html = '';
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > LINK_PREVIEW_MAX_BYTES) {
        reader.cancel().catch(() => {});
        break;
      }
      html += decoder.decode(value, { stream: true });
    }
    return parseOgTags(html, parsed.toString());
  }
  return null; // too many redirects
}

// GET /api/messages/link-preview?url=<url> — cached OG-tag fetch for a chat link preview
// card. SSRF-guarded (see fetchLinkPreview/isPrivateHost above); cached in link_previews
// for LINK_PREVIEW_TTL_MS so the same link isn't refetched on every render.
router.get('/link-preview', requirePermission('messages.view'), async (req, res) => {
  const raw = String(req.query.url || '');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    res.status(400).json({ error: 'Invalid URL' });
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    res.status(400).json({ error: 'Invalid URL' });
    return;
  }
  const url = parsed.toString();

  const cached = queryOne<{
    title: string | null; description: string | null; image_url: string | null;
    site_name: string | null; fetched_at: string; failed: number;
  }>('SELECT title, description, image_url, site_name, fetched_at, failed FROM link_previews WHERE url = ?', url);
  const fresh = cached && Date.now() - new Date(cached.fetched_at.replace(' ', 'T')).getTime() < LINK_PREVIEW_TTL_MS;
  if (fresh) {
    if (cached!.failed) {
      res.status(404).json({ error: 'No preview available' });
      return;
    }
    res.json({
      title: cached!.title, description: cached!.description,
      image_url: cached!.image_url, site_name: cached!.site_name,
    });
    return;
  }

  const preview = await fetchLinkPreview(url);
  run(
    `INSERT INTO link_previews (url, title, description, image_url, site_name, fetched_at, failed)
     VALUES (?, ?, ?, ?, ?, datetime('now'), ?)
     ON CONFLICT(url) DO UPDATE SET title = excluded.title, description = excluded.description,
       image_url = excluded.image_url, site_name = excluded.site_name,
       fetched_at = excluded.fetched_at, failed = excluded.failed`,
    url,
    preview?.title ?? null,
    preview?.description ?? null,
    preview?.image_url ?? null,
    preview?.site_name ?? null,
    preview ? 0 : 1
  );
  if (!preview) {
    res.status(404).json({ error: 'No preview available' });
    return;
  }
  res.json(preview);
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
