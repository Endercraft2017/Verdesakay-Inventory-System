/**
 * What people see of sync (docs/OFFLINE-FIRST.md §2.4, phase 3b), mounted at /api/sync:
 *
 *   GET  /status                  this copy's mode, connection, and counts for the status pill
 *   GET  /activity?view=pending   actions saved on this PC that the cloud hasn't confirmed yet
 *   GET  /activity?view=attention actions the cloud rejected (or that no longer applied)
 *   POST /activity/:id/dismiss    hide a rejected action once it has been dealt with
 *   POST /now                     sync with the cloud right away
 *   GET  /command/:id             where one action stands (local → host_confirmed → confirmed, or
 *                                 rejected / conflict) — a screen that showed "saved on this PC"
 *                                 follows its own action to final with it (mobile role desks)
 *
 * People see their own actions; users who can manage users see everyone's on this PC.
 * Anonymous-channel commands are never listed (they carry no actor by design) — they only
 * count towards the PC-wide "waiting" total.
 */
import { Router, type Request } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { activeDb, tenantStore } from '../shared/db';
import { requireAuth } from '../shared/auth';
import { syncConfigOf } from './node';
import { linkStatusOf, SyncOfflineError, syncWithCloud } from './client';

const router = Router();
const slugOf = () => tenantStore.getStore()?.slug ?? 'default';
const seesAll = (req: Request) => !!req.user?.permissions.includes('users.manage');
const can = (req: Request, p: string) => !!req.user?.permissions.includes(p as never);

function count(conn: DatabaseSync, sql: string, ...params: Array<string | number>): number {
  return (conn.prepare(sql).get(...params) as { n: number }).n;
}

/** Open stock discrepancies, for people who can see inventory (0 otherwise). */
function openDiscrepancies(conn: DatabaseSync, req: Request): number | undefined {
  if (!can(req, 'inventory.view')) return undefined;
  return count(conn, "SELECT COUNT(*) AS n FROM stock_discrepancies WHERE status = 'open'");
}

const ATTENTION = "state IN ('rejected', 'conflict') AND dismissed_at IS NULL";

router.get('/status', requireAuth, (req, res) => {
  const conn = activeDb();
  const cfg = syncConfigOf(conn);
  if (!cfg) {
    res.json({ mode: 'off', discrepancies_open: openDiscrepancies(conn, req) });
    return;
  }
  if (cfg.role === 'cloud') {
    res.json({
      mode: 'cloud',
      discrepancies_open: openDiscrepancies(conn, req),
      ...(seesAll(req)
        ? { pcs: count(conn, 'SELECT COUNT(*) AS n FROM sync_nodes WHERE revoked_at IS NULL') }
        : {}),
    });
    return;
  }
  const mine = seesAll(req) ? '' : ' AND actor_user_id = ?';
  const p = seesAll(req) ? [] : [req.user!.id];
  const link = linkStatusOf(slugOf());
  res.json({
    mode: 'node',
    node_no: cfg.nodeNo,
    is_host: cfg.isHost === true,
    // A site host: how many PCs on its LAN it serves. A LAN PC: whether its host reaches the cloud.
    ...(cfg.isHost ? { lan_pcs: count(conn, 'SELECT COUNT(*) AS n FROM sync_nodes WHERE revoked_at IS NULL') } : {}),
    ...(link.upstream ? { upstream_online: link.upstream.online } : {}),
    online: link.online,
    last_sync_at: link.lastSyncAt,
    last_error: link.lastError,
    pending_total: count(conn, "SELECT COUNT(*) AS n FROM sync_commands WHERE state = 'local'"),
    // Accepted by the site host, not yet by the cloud (LAN PCs only).
    on_site: count(conn, `SELECT COUNT(*) AS n FROM sync_commands WHERE state = 'host_confirmed' AND unattributed = 0${mine}`, ...p),
    pending: count(conn, `SELECT COUNT(*) AS n FROM sync_commands WHERE state = 'local' AND unattributed = 0${mine}`, ...p),
    attention: count(conn, `SELECT COUNT(*) AS n FROM sync_commands WHERE ${ATTENTION} AND unattributed = 0${mine}`, ...p),
    discrepancies_open: openDiscrepancies(conn, req),
  });
});

router.get('/command/:id', requireAuth, (req, res) => {
  const conn = activeDb();
  const cfg=syncConfigOf(conn);
  if (!cfg) {
    // A non-sync install has no queued command protocol; preserve its legacy response.
    res.json({ state: 'confirmed' });
    return;
  }
  const row = conn.prepare('SELECT state, error, actor_user_id FROM sync_commands WHERE id = ?').get(String(req.params.id)) as
    { state: string; error: string | null; actor_user_id: number | null } | undefined;
  if (!row || (!seesAll(req) && row.actor_user_id !== req.user!.id)) { res.status(404).json({ error: 'Action not found' }); return; }
  // A cloud inbox can still be received/rejected; never invent confirmation for it.
  // Preserve the historical successful cloud response shape.
  res.json(cfg.role==='cloud'&&row.error==null?{state:row.state}:{state:row.state,error:row.error});
});

router.get('/activity', requireAuth, (req, res) => {
  const conn = activeDb();
  if (syncConfigOf(conn)?.role !== 'node') {
    res.json([]);
    return;
  }
  const view = req.query.view === 'attention' ? 'attention' : 'pending';
  const where = view === 'attention' ? ATTENTION : "state = 'local'";
  const mine = seesAll(req) ? '' : ' AND c.actor_user_id = ?';
  const rows = conn.prepare(
    `SELECT c.id, c.method, c.path, c.body, c.sync_class, c.occurred_at, c.state, c.error,
            c.response_status, c.actor_user_id, u.full_name AS actor_name, c.updated_at
       FROM sync_commands c LEFT JOIN users u ON u.id = c.actor_user_id
      WHERE ${where.replace(/\b(state|dismissed_at)\b/g, 'c.$1')} AND c.unattributed = 0${mine}
      ORDER BY c.node_seq DESC LIMIT 200`,
  ).all(...(seesAll(req) ? [] : [req.user!.id])) as Array<Record<string, unknown>>;
  res.json(rows.map((r) => {
    let body: unknown = null;
    try { body = JSON.parse(String(r.body)); } catch { /* keep null */ }
    return { ...r, body };
  }));
});

// POST /now — run a sync round right away (the background loop runs every 15 s anyway).
router.post('/now', requireAuth, async (_req, res, next) => {
  if (syncConfigOf(activeDb())?.role !== 'node') {
    res.status(404).json({ error: 'Only an installed PC syncs.' });
    return;
  }
  try {
    const r = await syncWithCloud(slugOf());
    res.json({ ok: true, sent: r.pushed.length, received: r.rebase.applied });
  } catch (e) {
    if (e instanceof SyncOfflineError) {
      res.status(503).json({ error: 'The cloud cannot be reached right now — your work is safe on this PC.' });
      return;
    }
    next(e);
  }
});

router.post('/activity/:id/dismiss', requireAuth, (req, res) => {
  const conn = activeDb();
  if (syncConfigOf(conn)?.role !== 'node') {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const mine = seesAll(req) ? '' : ' AND actor_user_id = ?';
  const info = conn.prepare(
    `UPDATE sync_commands SET dismissed_at = datetime('now')
      WHERE id = ? AND ${ATTENTION} AND unattributed = 0${mine}`,
  ).run(String(req.params.id), ...(seesAll(req) ? [] : [req.user!.id]));
  if (!info.changes) {
    res.status(404).json({ error: 'Nothing to dismiss' });
    return;
  }
  res.json({ ok: true });
});

export default router;
