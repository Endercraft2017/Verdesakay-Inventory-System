/**
 * The cloud's sync endpoints (docs/OFFLINE-FIRST.md §12, phase 3a), mounted at /api/sync.
 *
 *   POST /nodes                 enrol an installed PC (admin session; `users.manage`) → node
 *                               number + a node token shown once. The first enrolment switches
 *                               the workspace to sync mode (cloud role).
 *   GET  /nodes                 enrolled PCs (admin)
 *   POST /nodes/:no/revoke      stop a PC syncing (lost / retired); its token stops working
 *   GET  /snapshot              node token → a copy of the workspace to start from, with every
 *                               credential stripped (sessions, tokens, secrets) and compacted
 *   POST /commands              node token → replay the node's commands, return verdicts
 *   GET  /pull?since=N          node token → confirmed effects after N + verdicts on its commands
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
import { enableSync, isNodeLocalTable, SECRET_SETTINGS, syncConfigOf } from './node';
import type { CommandResult, SyncCommand } from './commands';

const router = Router();
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const slugOf = () => tenantStore.getStore()?.slug ?? 'default';

function nodeAuth(req: Request, res: Response, next: NextFunction): void {
  const conn = activeDb();
  if (syncConfigOf(conn)?.role !== 'cloud') {
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
  if (!cfg) enableSync(conn, { role: 'cloud', nodeNo: 0 }); // first PC: this workspace starts syncing
  const next = (conn.prepare('SELECT COALESCE(MAX(node_no), 0) + 1 AS n FROM sync_nodes').get() as { n: number }).n;
  const token = crypto.randomBytes(32).toString('base64url');
  conn.prepare('INSERT INTO sync_nodes (node_no, name, token_hash, enrolled_by) VALUES (?, ?, ?, ?)')
    .run(next, name, sha256(token), req.user!.id);
  res.status(201).json({ node_no: next, name, node_token: token });
});

router.get('/nodes', requireAuth, requirePermission('users.manage'), (_req, res) => {
  const conn = activeDb();
  if (syncConfigOf(conn)?.role !== 'cloud') {
    res.json([]);
    return;
  }
  res.json(conn.prepare(
    'SELECT node_no, name, enrolled_at, last_seen_at, revoked_at FROM sync_nodes ORDER BY node_no',
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
    for (const k of SECRET_SETTINGS) del.run(k);
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
    const commands = Array.isArray(req.body?.commands) ? (req.body.commands as SyncCommand[]) : [];
    const results: CommandResult[] = [];
    for (const cmd of commands) {
      // A PC may only submit its own commands (or unattributed ones, which carry no node).
      const own = cmd.unattributed === 1 ? cmd.node_no == null : cmd.node_no === nodeNo;
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
  const pull = pullFor(slugOf(), res.locals.syncNodeNo as number, since);
  res.json({
    upTo: pull.upTo,
    results: pull.results,
    effects: pull.effects.map((e) => ({
      authority_seq: e.authority_seq,
      command_id: e.command_id,
      changeset: Buffer.from(e.changeset).toString('base64'),
    })),
  });
});

export default router;
