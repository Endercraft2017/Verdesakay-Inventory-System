'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/messages?box=inbox|sent
router.get('/', (req, res) => {
  const box = req.query.box === 'sent' ? 'sent' : 'inbox';
  let rows;
  if (box === 'inbox') {
    rows = db
      .prepare(
        `SELECT m.id, m.subject, m.body, m.read_at, m.created_at,
                m.sender_id AS other_id, u.full_name AS other_name, u.username AS other_username
         FROM messages m JOIN users u ON u.id = m.sender_id
         WHERE m.recipient_id = ?
         ORDER BY m.id DESC`
      )
      .all(req.user.id);
  } else {
    rows = db
      .prepare(
        `SELECT m.id, m.subject, m.body, m.read_at, m.created_at,
                m.recipient_id AS other_id, u.full_name AS other_name, u.username AS other_username
         FROM messages m JOIN users u ON u.id = m.recipient_id
         WHERE m.sender_id = ?
         ORDER BY m.id DESC`
      )
      .all(req.user.id);
  }
  res.json(rows);
});

// GET /api/messages/unread-count
router.get('/unread-count', (req, res) => {
  const c = db
    .prepare('SELECT COUNT(*) AS c FROM messages WHERE recipient_id = ? AND read_at IS NULL')
    .get(req.user.id).c;
  res.json({ count: c });
});

// POST /api/messages  — send a message
router.post('/', (req, res) => {
  const { recipient_id, subject, body } = req.body || {};
  const rid = Number(recipient_id);
  const text = String(body || '').trim();
  if (!rid || !text) {
    return res.status(400).json({ error: 'Recipient and message body are required' });
  }
  if (rid === req.user.id) {
    return res.status(400).json({ error: 'You cannot message yourself' });
  }
  const recipient = db.prepare('SELECT id FROM users WHERE id = ? AND active = 1').get(rid);
  if (!recipient) return res.status(404).json({ error: 'Recipient not found' });

  const info = db
    .prepare(
      `INSERT INTO messages (sender_id, recipient_id, subject, body)
       VALUES (?, ?, ?, ?)`
    )
    .run(req.user.id, rid, subject ? String(subject).trim() : null, text);
  res.status(201).json({ id: info.lastInsertRowid });
});

// POST /api/messages/:id/read  — mark a received message read
router.post('/:id/read', (req, res) => {
  const id = Number(req.params.id);
  const info = db
    .prepare(
      "UPDATE messages SET read_at = datetime('now') WHERE id = ? AND recipient_id = ? AND read_at IS NULL"
    )
    .run(id, req.user.id);
  res.json({ ok: true, updated: info.changes });
});

// DELETE /api/messages/:id  — sender or recipient can delete their view
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const info = db
    .prepare('DELETE FROM messages WHERE id = ? AND (sender_id = ? OR recipient_id = ?)')
    .run(id, req.user.id, req.user.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Message not found' });
  res.json({ ok: true });
});

module.exports = router;
