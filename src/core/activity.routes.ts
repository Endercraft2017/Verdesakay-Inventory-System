import { redactStoredMeta } from '../shared/activity';
/** Activity log (admin-only, `audit.view`): read the app-wide action history. Read-only: rows
 *  are removed only by the retention sweep after ACTIVITY_LOG_RETENTION_DAYS (cleanupSessions). */
import { Router } from 'express';
import { queryOne, queryAll } from '../shared/db';
import { requireAuth, requirePermission } from '../shared/auth';
import type { ActivityLogRow } from '../shared/types';

const router = Router();
router.use(requireAuth, requirePermission('audit.view'));

function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

// GET /api/activity — filtered, paginated feed (newest first)
router.get('/', (req, res) => {
  const { user_id, entity, action, from, to, q, ip, device_id } = req.query;
  const where: string[] = [];
  const params: unknown[] = [];

  if (user_id) { where.push('user_id = ?'); params.push(Number(user_id)); }
  if (typeof entity === 'string' && entity.trim()) { where.push('entity = ?'); params.push(entity.trim()); }
  if (typeof action === 'string' && action.trim()) { where.push('action = ?'); params.push(action.trim()); }
  if (typeof from === 'string' && from.trim()) { where.push('created_at >= ?'); params.push(from.trim()); }
  if (typeof to === 'string' && to.trim()) { where.push('created_at <= ?'); params.push(to.trim()); }
  if (typeof ip === 'string' && ip.trim()) { where.push('ip = ?'); params.push(ip.trim()); }
  if (typeof device_id === 'string' && device_id.trim()) { where.push('device_id = ?'); params.push(device_id.trim()); }
  if (typeof q === 'string' && q.trim()) {
    where.push('(summary LIKE ? OR path LIKE ? OR user_name LIKE ? OR ip LIKE ? OR device LIKE ?)');
    const like = `%${q.trim()}%`;
    params.push(like, like, like, like, like);
  }
  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const limit = clampInt(req.query.limit, 100, 1, 500);
  const offset = clampInt(req.query.offset, 0, 0, 5_000_000);

  const total = queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM activity_log${whereSql}`, ...params)?.n ?? 0;
  const rows = queryAll<ActivityLogRow>(
    `SELECT * FROM activity_log${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`,
    ...params,
    limit,
    offset
  );
  res.json({ rows: rows.map(row => ({ ...row, meta: redactStoredMeta(row.meta) })), total, limit, offset });
});

// GET /api/activity/options — distinct values for the filter dropdowns
router.get('/options', (_req, res) => {
  const entities = queryAll<{ entity: string }>(
    `SELECT DISTINCT entity FROM activity_log WHERE entity IS NOT NULL AND entity != '' ORDER BY entity`
  ).map((r) => r.entity);
  const actions = queryAll<{ action: string }>(
    `SELECT DISTINCT action FROM activity_log WHERE action IS NOT NULL AND action != '' ORDER BY action`
  ).map((r) => r.action);
  const users = queryAll<{ id: number; full_name: string }>(
    `SELECT DISTINCT u.id, u.full_name
     FROM activity_log a JOIN users u ON u.id = a.user_id
     ORDER BY u.full_name COLLATE NOCASE`
  );
  res.json({ entities, actions, users });
});

// No DELETE: the audit trail is what catches misuse by the people who can read it, so nothing in
// the app removes entries early — only the retention sweep (cleanupSessions) does.

export default router;
