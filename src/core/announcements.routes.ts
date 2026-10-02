/** Company-wide announcements. Any logged-in user can read the active ones
 *  (mobile home card + announcements view, desktop announcements view); posting,
 *  editing and deleting need the `announce` permission. Mounted at /api/announcements. */
import { Router } from 'express';
import { queryOne, queryAll, run } from '../shared/db';
import { requireAuth, requirePermission } from '../shared/auth';
import { parseBody, announcementSchema, updateAnnouncementSchema } from '../shared/validation';
import { notifyAll } from '../shared/push';
import type { Announcement } from '../shared/types';
import { syncClass } from '../sync';

const router = Router();
router.use(requireAuth);

const WITH_AUTHOR =
  `SELECT a.*, u.full_name AS created_by_name
   FROM announcements a LEFT JOIN users u ON u.id = a.created_by`;

// GET /api/announcements — active (unexpired) announcements, pinned first
router.get('/', (_req, res) => {
  const rows = queryAll<Announcement>(
    `${WITH_AUTHOR}
     WHERE a.expires_at IS NULL OR a.expires_at >= datetime('now','localtime')
     ORDER BY a.pinned DESC, a.id DESC`
  );
  res.json(rows);
});

// GET /api/announcements/all — everything incl. expired (management)
router.get('/all', requirePermission('announce'), (_req, res) => {
  res.json(queryAll<Announcement>(`${WITH_AUTHOR} ORDER BY a.pinned DESC, a.id DESC`));
});

// POST /api/announcements — announce
router.post('/', requirePermission('announce'), syncClass('claim'), async (req, res) => {
  const input = parseBody(announcementSchema, req.body);
  const info = run(
    `INSERT INTO announcements (title, body, pinned, expires_at, created_by)
     VALUES (?, ?, ?, ?, ?)`,
    input.title, input.body, input.pinned ? 1 : 0, input.expires_at || null, req.user!.id
  );
  if (input.notify) {
    await notifyAll({
      title: 'Announcement: ' + input.title,
      body: input.body.length > 140 ? input.body.slice(0, 137) + '…' : input.body,
      url: '#/announcements',
      tag: 'ann-' + info.lastInsertRowid,
    });
  }
  res.status(201).json({ id: info.lastInsertRowid });
});

// PUT /api/announcements/:id — announce
router.put('/:id', requirePermission('announce'), syncClass('claim'), (req, res) => {
  const id = Number(req.params.id);
  if (!queryOne('SELECT id FROM announcements WHERE id = ?', id)) {
    res.status(404).json({ error: 'Announcement not found' }); return;
  }
  const input = parseBody(updateAnnouncementSchema, req.body);
  run(
    'UPDATE announcements SET title = ?, body = ?, pinned = ?, expires_at = ? WHERE id = ?',
    input.title, input.body, input.pinned ? 1 : 0, input.expires_at || null, id
  );
  res.json({ ok: true });
});

// DELETE /api/announcements/:id — announce
router.delete('/:id', requirePermission('announce'), syncClass('claim'), (req, res) => {
  const info = run('DELETE FROM announcements WHERE id = ?', Number(req.params.id));
  if (!info.changes) { res.status(404).json({ error: 'Announcement not found' }); return; }
  res.json({ ok: true });
});

export default router;
