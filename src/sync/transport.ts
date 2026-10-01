/**
 * Sync endpoints (docs/OFFLINE-FIRST.md §12–13, §15), mounted at /api/sync. Served by an
 * authority: the cloud, or a site host for the PCs on its LAN (phase 3c).
 *
 *   POST /nodes                 (cloud) enrol a PC (admin session; `users.manage`) → node number
 *                               + a node token shown once. `is_host` makes it its site's host;
 *                               `host_node_no` makes it a LAN PC of that host. The first
 *                               enrolment switches the workspace to sync mode (cloud role).
 *   GET  /nodes                 (cloud) enrolled PCs (admin)
 *   POST /nodes/:no/revoke      (cloud) stop a PC syncing (lost / retired); its token stops working
 *   GET  /whoami                (any authority, public) this authority's node number + whether
 *                               it is a site host — how a LAN PC's enrolment finds its host
 *   GET  /members               (cloud, host's token) the host's LAN PCs, with token hashes, so
 *                               the host can authenticate them while the internet is down
 *   GET  /snapshot              node token → a copy to start from, with every credential stripped
 *                               (sessions, tokens, secrets) and compacted
 *   POST /commands              node token → replay the PC's commands, return verdicts. A host
 *                               may also forward its LAN PCs' commands to the cloud.
 *   GET  /pull?since=N&ids=…    node token → effects after N + verdicts on the PC's commands (a
 *                               host: also its LAN PCs'; `ids`: unattributed commands it awaits)
 *
 * A node authenticates with `X-Sync-Node-Token`, not a user session: the PC vouches for the
 * users who signed in on it, and the cloud replays each command as its actor (a disabled actor
 * fails there). Revoking the node is how a lost PC is cut off.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { activeDb, tenantStore } from '../shared/db';
import { requireAuth, requirePermission } from '../shared/auth';
import { acceptCommand, pullFor, snapshotForNode } from './authority';
import { linkStatusOf } from './client';
import { enableSync, isAuthority, isCloudOnlySetting, isNodeLocalTable, syncConfigOf } from './node';
import type { CommandResult, SyncCommand } from './commands';
import { fileRoutes } from './files';

const router = Router();
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const slugOf = () => tenantStore.getStore()?.slug ?? 'default';

function nodeAuth(req: Request, res: Response, next: NextFunction): void {
  const conn = activeDb();
  if (!isAuthority(syncConfigOf(conn))) {
    res.status(404).json({ error: 'This workspace has no installed PCs.' });
    return;
  }
  const token = req.get('x-sync-node-token');
  const row = token
    ? (conn.prepare('SELECT node_no, revoked_at FROM sync_nodes WHERE token_hash = ?').get(sha256(token)) as
        { node_no: number; revoked_at: string | null } | undefined)
    : undefined;
  if (!row || row.revoked_at) {
    res.status(401).json({ error: 'This PC is not enrolled (or was revoked).' });
    return;
  }
  conn.prepare("UPDATE sync_nodes SET last_seen_at = datetime('now') WHERE node_no = ?").run(row.node_no);
  res.locals.syncNodeNo = row.node_no;
  next();
}

/** The caller plus — on the cloud, for a site host — its LAN PCs: the nodes whose commands
 *  the caller may submit and whose verdicts it receives. */
function nodesSpokenFor(conn: import('node:sqlite').DatabaseSync, nodeNo: number): number[] {
  if (syncConfigOf(conn)?.role !== 'cloud') return [nodeNo];
  const members = conn.prepare('SELECT node_no FROM sync_nodes WHERE host_node_no = ?').all(nodeNo) as Array<{ node_no: number }>;
  return [nodeNo, ...members.map((m) => m.node_no)];
}

// Files: blobs a PC's commands carry, and the authority's list of uploaded files (§18).
router.use(fileRoutes(nodeAuth));

// ---- enrolment (admin) ----

router.post('/nodes', requireAuth, requirePermission('users.manage'), (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name || name.length > 80) {
    res.status(400).json({ error: 'Give the PC a name (up to 80 characters), e.g. "Warehouse desk".' });
    return;
  }
  const conn = activeDb();
  const cfg = syncConfigOf(conn);
  if (cfg?.role === 'node') {
    res.status(409).json({ error: 'Enrol PCs against the cloud workspace, not another installed PC.' });
    return;
  }
  const isHost = req.body?.is_host === true;
  const hostNo = req.body?.host_node_no == null ? null : Number(req.body.host_node_no);
  if (isHost && hostNo != null) {
    res.status(400).json({ error: 'A PC is either its site\'s host or a PC of a host, not both.' });
    return;
  }
  if (!cfg) enableSync(conn, { role: 'cloud', nodeNo: 0 }); // first PC: this workspace starts syncing
  if (hostNo != null) {
    const host = conn.prepare('SELECT is_host, revoked_at FROM sync_nodes WHERE node_no = ?').get(hostNo) as
      { is_host: number; revoked_at: string | null } | undefined;
    if (!host || !host.is_host || host.revoked_at) {
      res.status(400).json({ error: `PC #${hostNo} is not an active site host.` });
      return;
    }
  }
  const next = (conn.prepare('SELECT COALESCE(MAX(node_no), 0) + 1 AS n FROM sync_nodes').get() as { n: number }).n;
  const token = crypto.randomBytes(32).toString('base64url');
  conn.prepare('INSERT INTO sync_nodes (node_no, name, token_hash, enrolled_by, is_host, host_node_no) VALUES (?, ?, ?, ?, ?, ?)')
    .run(next, name, sha256(token), req.user!.id, isHost ? 1 : 0, hostNo);
  res.status(201).json({ node_no: next, name, node_token: token, is_host: isHost, host_node_no: hostNo });
});

router.get('/whoami', (_req, res) => {
  const cfg = syncConfigOf(activeDb());
  if (!isAuthority(cfg)) {
    res.status(404).json({ error: 'Not a sync authority.' });
    return;
  }
  res.json({ role: cfg!.role, node_no: cfg!.nodeNo, is_host: cfg!.isHost === true });
});

router.get('/members', nodeAuth, (_req, res) => {
  const conn = activeDb();
  if (syncConfigOf(conn)?.role !== 'cloud') {
    res.status(404).json({ error: 'Only the cloud knows the enrolled PCs.' });
    return;
  }
  res.json(conn.prepare(
    'SELECT node_no, name, token_hash, revoked_at FROM sync_nodes WHERE host_node_no = ? ORDER BY node_no',
  ).all(res.locals.syncNodeNo as number));
});

router.get('/nodes', requireAuth, requirePermission('users.manage'), (_req, res) => {
  const conn = activeDb();
  if (syncConfigOf(conn)?.role !== 'cloud') {
    res.json([]);
    return;
  }
  res.json(conn.prepare(
    'SELECT node_no, name, enrolled_at, last_seen_at, revoked_at, is_host, host_node_no FROM sync_nodes ORDER BY node_no',
  ).all());
});

router.post('/nodes/:no/revoke', requireAuth, requirePermission('users.manage'), (req, res) => {
  const conn = activeDb();
  if (syncConfigOf(conn)?.role !== 'cloud') {
    res.status(404).json({ error: 'No such PC' });
    return;
  }
  const info = conn.prepare("UPDATE sync_nodes SET revoked_at = datetime('now') WHERE node_no = ? AND revoked_at IS NULL")
    .run(Number(req.params.no));
  if (!info.changes) {
    res.status(404).json({ error: 'No such enrolled PC' });
    return;
  }
  res.json({ ok: true });
});

// ---- node-authenticated ----

/** Build the starting copy for a node: the workspace as of the latest effect, minus everything
 *  that is a credential rather than data (OFFLINE-FIRST §7.5), then VACUUMed so the removed
 *  rows can't be recovered from free pages. */
export function buildNodeSnapshot(slug: string, file: string): void {
  snapshotForNode(slug, file);
  const d = new DatabaseSync(file);
  try {
    d.exec('PRAGMA secure_delete = ON');
    const tables = d.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string; sql: string | null }>;
    for (const { name, sql } of tables) {
      if (name.startsWith('sqlite_') || name === 'sync_effects') continue;
      if (/^CREATE VIRTUAL TABLE/i.test(sql ?? '')) d.exec(`DELETE FROM "${name}"`); // FTS: through the vtable
      else if (isNodeLocalTable(name) && !/^doc_chunks_/.test(name)) d.exec(`DELETE FROM "${name}"`);
    }
    // Keep only the position this copy stands at; the node reads it at enrolment.
    d.exec(`DELETE FROM sync_effects WHERE authority_seq < (SELECT MAX(authority_seq) FROM sync_effects);
            UPDATE sync_effects SET changeset = x'', command_id = NULL`);
    const del = d.prepare('DELETE FROM settings WHERE key = ?');
    for (const { key } of d.prepare('SELECT key FROM settings').all() as Array<{ key: string }>) {
      if (isCloudOnlySetting(key)) del.run(key); // secrets + AI / email / QuickBooks settings
    }
    d.exec('VACUUM');
  } finally {
    d.close();
  }
}

router.get('/snapshot', nodeAuth, (_req, res, next) => {
  const file = path.join(os.tmpdir(), `vds-snapshot-${crypto.randomBytes(6).toString('hex')}.db`);
  try {
    buildNodeSnapshot(slugOf(), file);
  } catch (e) {
    fs.rmSync(file, { force: true });
    next(e);
    return;
  }
  res.download(file, 'workspace.db', () => fs.rmSync(file, { force: true }));
});

router.post('/commands', nodeAuth, async (req, res, next) => {
  try {
    const nodeNo = res.locals.syncNodeNo as number;
    const allowed = new Set(nodesSpokenFor(activeDb(), nodeNo));
    const commands = Array.isArray(req.body?.commands) ? (req.body.commands as SyncCommand[]) : [];
    const results: CommandResult[] = [];
    for (const cmd of commands) {
      // A PC may only submit its own commands — a host also its LAN PCs' — or unattributed ones.
      const own = cmd.unattributed === 1 ? cmd.node_no == null : allowed.has(Number(cmd.node_no));
      if (!own || typeof cmd.id !== 'string') {
        results.push({ id: String(cmd.id), state: 'rejected', authority_seq: null, response_status: 403, error: 'Not this PC\'s command' });
        continue;
      }
      results.push(await acceptCommand(slugOf(), cmd));
    }
    res.json({ results });
  } catch (e) {
    next(e);
  }
});

router.get('/pull', nodeAuth, (req, res) => {
  const since = Math.max(0, Number(req.query.since) || 0);
  const ids = typeof req.query.ids === 'string' && req.query.ids ? req.query.ids.split(',').slice(0, 500) : [];
  const conn = activeDb();
  const pull = pullFor(slugOf(), nodesSpokenFor(conn, res.locals.syncNodeNo as number), since, ids);
  const cfg = syncConfigOf(conn);
  const link = cfg?.role === 'node' ? linkStatusOf(slugOf()) : null;
  res.json({
    upTo: pull.upTo,
    // From a site host: whether it can reach the cloud, so its LAN PCs can say so.
    ...(link ? { upstream: { online: link.online, last_sync_at: link.lastSyncAt } } : {}),
    results: pull.results,
    effects: pull.effects.map((e) => ({
      authority_seq: e.authority_seq,
      command_id: e.command_id,
      changeset: Buffer.from(e.changeset).toString('base64'),
    })),
  });
});

export default router;
