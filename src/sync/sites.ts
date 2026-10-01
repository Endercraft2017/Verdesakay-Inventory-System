/**
 * Home sites and site decisions (docs/OFFLINE-FIRST.md §16, phase 3c-ii; decisions D4, D6).
 *
 * Every record that needs an exclusive decision (`claim`) has a **home**: a stock location's
 * records belong to the site host the location is assigned to (`location_sites`); everything
 * else — company-wide master data, settings — belongs to the **main site** (setting
 * `sync_main_host`). With no main site set, nothing can be decided offline.
 *
 * While the internet is down, a site may decide its own records: on the host itself, or on a
 * LAN PC whose host it has just been able to reach. When the host forwards such a decision, the
 * cloud re-runs it as a **site decision** (`siteFinal`): a check the route marks as a clash-check
 * may fail without refusing it, and the clash is recorded here for an admin.
 *
 * Endpoints (mounted under /api/sync; admin = `users.manage`; changes are cloud-only):
 *   GET  /sites                 hosts, the main site, and each location's home
 *   PUT  /sites                 set the main site and location homes
 *   GET  /clashes?status=       site decisions the cloud kept despite a clash
 *   POST /clashes/:id/resolve   record what was done about one
 */
import { Router, type Request } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { activeDb, getSetting, queryAll, queryOne, run, setSetting } from '../shared/db';
import { requireAuth, requirePermission } from '../shared/auth';
import { syncContext } from '../shared/sync-context';
import { syncConfigOf, type SyncConfig } from './node';

/** Whose decision a record is: company-wide, or a stock location's (null = no location). */
export type Home = 'company' | { location: number | null };

export const MAIN_HOST_SETTING = 'sync_main_host';

export function mainHost(): number | null {
  const v = getSetting<number | null>(MAIN_HOST_SETTING);
  return typeof v === 'number' ? v : null;
}

/** The site host that decides `home` offline, or null when only the cloud can. */
export function deciderOf(home: Home): number | null {
  if (home !== 'company' && home.location != null) {
    const row = queryOne<{ host_node_no: number }>('SELECT host_node_no FROM location_sites WHERE location_id = ?', home.location);
    if (row) return row.host_node_no;
  }
  return mainHost();
}

/** The site this PC belongs to: a host is its own site; a LAN PC belongs to its host; a PC
 *  syncing with the cloud directly belongs to no site (it can decide nothing offline). */
export function siteOfThisPc(conn: DatabaseSync, cfg: SyncConfig): number | null {
  if (cfg.role !== 'node') return null;
  if (cfg.isHost) return cfg.nodeNo;
  const row = conn.prepare('SELECT host_node_no FROM sync_node WHERE k = 1').get() as { host_node_no: number | null } | undefined;
  return row?.host_node_no ?? null;
}

/** On the cloud: the site a PC's commands come from (its own number for a host, its host's
 *  for a LAN PC, null for a PC that syncs with the cloud directly). */
export function siteOfNode(conn: DatabaseSync, nodeNo: number | null): number | null {
  if (nodeNo == null) return null;
  const row = conn.prepare('SELECT is_host, host_node_no FROM sync_nodes WHERE node_no = ?').get(nodeNo) as
    { is_host: number; host_node_no: number | null } | undefined;
  if (!row) return null;
  return row.is_host ? nodeNo : row.host_node_no;
}

/** Record that the cloud kept a site's decision despite a clash (call only when
 *  `siteDecisionStands()`); part of the same command, so it replicates with it. */
export function recordSiteClash(req: Request, summary: string): void {
  run(
    'INSERT INTO site_decision_clashes (host_node_no, route, summary, actor_user_id) VALUES (?, ?, ?, ?)',
    syncContext()?.decidingSite ?? null, `${req.method} ${req.originalUrl.split('?')[0]}`, summary, req.user?.id ?? null,
  );
}

// ---- admin endpoints ----

const router = Router();
const admin = [requireAuth, requirePermission('users.manage')];

router.get('/sites', ...admin, (_req, res) => {
  const conn = activeDb();
  const cloud = syncConfigOf(conn)?.role === 'cloud';
  const hosts = cloud
    ? conn.prepare('SELECT node_no, name FROM sync_nodes WHERE is_host = 1 AND revoked_at IS NULL ORDER BY node_no').all()
    : [];
  res.json({
    hosts,
    main_host: mainHost(),
    locations: queryAll(
      `SELECT l.id, l.name, l.type, ls.host_node_no FROM locations l
         LEFT JOIN location_sites ls ON ls.location_id = l.id ORDER BY l.name COLLATE NOCASE`,
    ),
  });
});

router.put('/sites', ...admin, (req, res) => {
  const conn = activeDb();
  if (syncConfigOf(conn)?.role !== 'cloud') {
    res.status(409).json({ error: 'Sites are set up on the cloud workspace.' });
    return;
  }
  const hosts = new Set((conn.prepare('SELECT node_no FROM sync_nodes WHERE is_host = 1 AND revoked_at IS NULL').all() as Array<{ node_no: number }>).map((h) => h.node_no));
  const check = (n: unknown) => n == null || hosts.has(Number(n));
  const main = req.body?.main_host;
  const homes = Array.isArray(req.body?.locations) ? req.body.locations as Array<{ location_id: number; host_node_no: number | null }> : null;
  if (main !== undefined && !check(main)) {
    res.status(400).json({ error: `PC #${main} is not an active site host.` });
    return;
  }
  if (homes && homes.some((h) => !check(h.host_node_no))) {
    res.status(400).json({ error: 'Every location must belong to an active site host (or none).' });
    return;
  }
  conn.exec('BEGIN');
  try {
    if (main !== undefined) setSetting(MAIN_HOST_SETTING, main == null ? null : Number(main));
    for (const h of homes ?? []) {
      if (h.host_node_no == null) run('DELETE FROM location_sites WHERE location_id = ?', Number(h.location_id));
      else {
        run(
          `INSERT INTO location_sites (location_id, host_node_no) VALUES (?, ?)
           ON CONFLICT(location_id) DO UPDATE SET host_node_no = excluded.host_node_no`,
          Number(h.location_id), Number(h.host_node_no),
        );
      }
    }
    conn.exec('COMMIT');
  } catch (e) {
    conn.exec('ROLLBACK');
    throw e;
  }
  res.json({ ok: true });
});

router.get('/clashes', ...admin, (req, res) => {
  const status = req.query.status === 'all' ? 'all' : req.query.status === 'resolved' ? 'resolved' : 'open';
  res.json(queryAll(
    `SELECT c.*, u.full_name AS actor_name, r.full_name AS resolved_by_name
       FROM site_decision_clashes c
       LEFT JOIN users u ON u.id = c.actor_user_id
       LEFT JOIN users r ON r.id = c.resolved_by
      WHERE ? = 'all' OR c.status = ?
      ORDER BY c.id DESC LIMIT 500`,
    status, status,
  ));
});

router.post('/clashes/:id/resolve', ...admin, (req, res) => {
  const note = String(req.body?.note ?? '').trim();
  if (!note) {
    res.status(400).json({ error: 'Say what was done.' });
    return;
  }
  const info = run(
    `UPDATE site_decision_clashes SET status = 'resolved', resolution_note = ?, resolved_by = ?, resolved_at = datetime('now')
      WHERE id = ? AND status = 'open'`,
    note.slice(0, 500), req.user!.id, Number(req.params.id),
  );
  if (!info.changes) {
    res.status(404).json({ error: 'No open clash with that number' });
    return;
  }
  res.json({ ok: true });
});

export default router;
