/** The signed-in person's notification history (`notifications`, written by shared/push.ts
 *  notifyUser whenever the authority notifies someone — with or without a push subscription).
 *  Mounted at /api/notifications; everything is the caller's own rows only.
 *    GET  /              newest first (?limit=, default 50, max 200) + unread count
 *    GET  /unread-count  for badges (desktop rail bell, phone header)
 *    POST /:id/read      mark one read
 *    POST /read-all      mark all read
 *  Each row carries `url` (a phone route, e.g. '#/qc?role=qa&unit=5') and, where the record
 *  has a desktop screen, `link` ({ route, params }). */
import { Router } from 'express';
import { queryAll, queryOne, run } from '../shared/db';
import { requireAuth } from '../shared/auth';
import { syncClass } from '../sync';

const router = Router();
router.use(requireAuth);

interface Row { id: number; title: string; body: string | null; url: string | null; link: string | null; tag: string | null; created_at: string; read_at: string | null }

const unread = (userId: number) =>
  queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', userId)!.n;

router.get('/', (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const rows = queryAll<Row>(
    'SELECT id, title, body, url, link, tag, created_at, read_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?',
    req.user!.id, limit
  ).map((r) => {
    let link: unknown = null;
    try { link = r.link ? JSON.parse(r.link) : null; } catch { link = null; }
    return { ...r, link };
  });
  res.json({ items: rows, unread: unread(req.user!.id) });
});

router.get('/unread-count', (req, res) => { res.json({ count: unread(req.user!.id) }); });

router.post('/read-all', syncClass('merge'), (req, res) => {
  run("UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL", req.user!.id);
  res.json({ ok: true, unread: 0 });
});

router.post('/:id/read', syncClass('merge'), (req, res) => {
  const r = run("UPDATE notifications SET read_at = COALESCE(read_at, datetime('now')) WHERE id = ? AND user_id = ?", Number(req.params.id), req.user!.id);
  if (!Number(r.changes)) { res.status(404).json({ error: 'Notification not found' }); return; }
  res.json({ ok: true, unread: unread(req.user!.id) });
});

export default router;
