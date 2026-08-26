/** Internal messaging: inbox/sent, unread count, send, mark read, delete. */
import { Router } from 'express';
import { queryOne, queryAll, run } from '../db';
import { requireAuth, requirePermission } from '../auth';
import { parseBody, sendMessageSchema } from '../validation';

const router = Router();
router.use(requireAuth);

// GET /api/messages?box=inbox|sent
router.get('/', requirePermission('messages.view'), (req, res) => {
  const box = req.query.box === 'sent' ? 'sent' : 'inbox';
  const uid = req.user!.id;
  const rows =
    box === 'inbox'
      ? queryAll(
          `SELECT m.id, m.subject, m.body, m.read_at, m.created_at,
                  m.sender_id AS other_id, u.full_name AS other_name, u.username AS other_username
           FROM messages m JOIN users u ON u.id = m.sender_id
           WHERE m.recipient_id = ?
           ORDER BY m.id DESC`,
          uid
        )
      : queryAll(
          `SELECT m.id, m.subject, m.body, m.read_at, m.created_at,
                  m.recipient_id AS other_id, u.full_name AS other_name, u.username AS other_username
           FROM messages m JOIN users u ON u.id = m.recipient_id
           WHERE m.sender_id = ?
           ORDER BY m.id DESC`,
          uid
        );
  res.json(rows);
});

// GET /api/messages/unread-count
router.get('/unread-count', requirePermission('messages.view'), (req, res) => {
  const c = queryOne<{ c: number }>(
    'SELECT COUNT(*) AS c FROM messages WHERE recipient_id = ? AND read_at IS NULL',
    req.user!.id
  )!.c;
  res.json({ count: c });
});

// POST /api/messages — send a message
router.post('/', requirePermission('messages.send'), (req, res) => {
  const { recipient_id, subject, body } = parseBody(sendMessageSchema, req.body);
  if (recipient_id === req.user!.id) {
    res.status(400).json({ error: 'You cannot message yourself' });
    return;
  }
  const recipient = queryOne('SELECT id FROM users WHERE id = ? AND active = 1', recipient_id);
  if (!recipient) {
    res.status(404).json({ error: 'Recipient not found' });
    return;
  }
  const info = run(
    'INSERT INTO messages (sender_id, recipient_id, subject, body) VALUES (?, ?, ?, ?)',
    req.user!.id,
    recipient_id,
    subject ?? null,
    body
  );
  res.status(201).json({ id: info.lastInsertRowid });
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

// DELETE /api/messages/:id — sender or recipient
router.delete('/:id', (req, res) => {
  const uid = req.user!.id;
  const info = run(
    'DELETE FROM messages WHERE id = ? AND (sender_id = ? OR recipient_id = ?)',
    Number(req.params.id),
    uid,
    uid
  );
  if (info.changes === 0) {
    res.status(404).json({ error: 'Message not found' });
    return;
  }
  res.json({ ok: true });
});

export default router;
