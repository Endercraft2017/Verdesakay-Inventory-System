/**
 * Site host failover (docs/OFFLINE-FIRST.md §4, §30; phase 5a).
 *
 * A site is numbered after its first host and keeps that number (sites.ts); which PC hosts it
 * can change. Each change starts a new **term**. The cloud records each site's host and term
 * (`sync_sites`) and is the referee: a PC that claims the site with a higher term becomes its
 * host; a host that hears of a higher term steps down.
 *
 * What makes a takeover safe:
 *  - **Every site PC mirrors its host.** Besides effects, a host sends its PCs the commands it
 *    holds that the cloud hasn't confirmed (`sync_site_log`), the site's PCs (with token hashes
 *    and LAN addresses), the cloud's address and the term. So any PC can take over with nothing
 *    lost: it forwards the old host's commands itself, and lets the site's PCs in offline.
 *  - **A full re-sync instead of a rebase.** A PC's copy is the old host's state, which includes
 *    effects of commands the cloud hasn't seen. After a takeover (or a switch to a new host),
 *    the PC first sends every command it holds, then replaces its data with a fresh copy from its
 *    authority and re-runs what is still pending (`resyncFromSnapshot`). The same step repairs a
 *    copy that has diverged (phase 6's re-sync tool).
 *  - **Stream epochs.** A host's effect stream is numbered within an epoch; a host that re-syncs
 *    starts a new one, and its PCs re-sync when they see the change.
 *
 * Endpoints (under /api/sync):
 *   GET  /site               (signed in) this PC's site, term, host and peers
 *   POST /site/take-over     (admin, a site PC) become the site's host (an admin's decision in
 *                            phase 5a; automatic election for 3+ PCs is phase 5b)
 *   POST /site/resync        (admin, any PC) take a fresh copy at the next round
 *   POST /site/host          (cloud, node token) claim a site for a term
 *   GET  /site/ca            (host, node token) the site's certificate authority, for its PCs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Router, type Request, type RequestHandler } from 'express';
import { activeDb, getDb, tenantStore } from '../shared/db';
import { requireAuth, requirePermission } from '../shared/auth';
import { drainRecorder, enableSync, isAuthority, isReplicated, syncConfigOf, type SyncConfig } from './node';
import { getCommand, insertCommand, localCommands, lockSync, toWire, type CommandResult, type SyncCommand } from './commands';
import { rerunCommands, withForeignKeysOff } from './rebase';
import { flushEffects } from './authority';
import { siteHostOf, siteMembers, siteOfNode, siteOfThisPc } from './sites';
import { downloadSnapshot, remoteOf } from './client';
import { exportSiteAuthority } from '../desktop/lan-tls';

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const slugOf = () => tenantStore.getStore()?.slug ?? 'default';
const newEpoch = () => crypto.randomBytes(8).toString('hex');

/** Rounds in a row a site PC may miss its host before it looks for another one. */
export const HOST_MISSES_BEFORE_PROBE = 3;

export interface NodeState {
  host_node_no: number | null;
  site_term: number;
  stream_epoch: string | null;
  host_epoch: string | null;
  resync_pending: number;
  cloud_url: string | null;
  cloud_tenant: string | null;
  lan_url: string | null;
  lan_tenant: string | null;
  host_misses: number;
  site_log_rowid: number;
}

export function nodeState(conn: DatabaseSync): NodeState {
  return conn.prepare(
    `SELECT host_node_no, site_term, stream_epoch, host_epoch, resync_pending, cloud_url, cloud_tenant,
            lan_url, lan_tenant, host_misses, site_log_rowid FROM sync_node WHERE k = 1`,
  ).get() as unknown as NodeState;
}

function setNode(conn: DatabaseSync, fields: Partial<NodeState>): void {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  conn.prepare(`UPDATE sync_node SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE k = 1`)
    .run(...keys.map((k) => (fields as Record<string, string | number | null>)[k] ?? null));
}

/** A host's stream epoch, created the first time it is asked for. */
export function streamEpoch(conn: DatabaseSync): string {
  const e = nodeState(conn).stream_epoch;
  if (e) return e;
  const fresh = newEpoch();
  setNode(conn, { stream_epoch: fresh });
  return fresh;
}

/** The server restarts in its new role (HTTPS for the LAN as host, local HTTP otherwise). The
 *  installed app sets this; tests leave it unset. */
export const roleChange: { onChange: ((isHost: boolean) => void) | null } = { onChange: null };

/** The headers a PC sends so its authority knows where to reach it on the LAN (for failover). */
export function lanHeaders(conn: DatabaseSync): Record<string, string> {
  const st = nodeState(conn);
  return {
    ...(st.lan_url ? { 'x-sync-lan-url': st.lan_url } : {}),
    ...(st.lan_tenant ? { 'x-sync-lan-tenant': st.lan_tenant } : {}),
  };
}

/** An authority notes where a PC said it can be reached. */
export function noteLanAddress(conn: DatabaseSync, nodeNo: number, req: Request): void {
  const url = req.get('x-sync-lan-url');
  if (!url || !/^https?:\/\/[^\s]{1,200}$/.test(url)) return;
  const tenant = req.get('x-sync-lan-tenant');
  conn.prepare('UPDATE sync_nodes SET lan_url = ?, lan_tenant = ? WHERE node_no = ?')
    .run(url, tenant && /^[a-z0-9-]{1,64}$/.test(tenant) ? tenant : null, nodeNo);
}

// ---------------------------------------------------------------- what a host tells its PCs

export interface PeerInfo {
  node_no: number;
  name: string;
  token_hash: string;
  revoked_at: string | null;
  lan_url: string | null;
  lan_tenant: string | null;
  voting: number;
}

export interface HostSiteInfo {
  site_no: number | null;
  host: number;
  term: number;
  epoch: string;
  cloud_url: string | null;
  cloud_tenant: string | null;
  peers: PeerInfo[];
}

export interface SiteLog {
  /** Every command the host holds that the cloud hasn't confirmed. */
  pending: string[];
  /** Those the PC hasn't been sent yet (after its `since` position), as sent over the wire. */
  commands: Array<{ rowid: number; cmd: SyncCommand }>;
}

/** What a site host adds to a pull for one of its PCs: the site, and its unconfirmed commands. */
export function hostSiteInfo(conn: DatabaseSync, cfg: SyncConfig, logSince: number): { site: HostSiteInfo; site_log: SiteLog } {
  const st = nodeState(conn);
  const remote = remoteOf(conn);
  const peers = conn.prepare(
    'SELECT node_no, name, token_hash, revoked_at, lan_url, lan_tenant, voting FROM sync_nodes ORDER BY node_no',
  ).all() as unknown as PeerInfo[];
  // The host itself, so it is let in should it come back as an ordinary PC of the new host.
  if (remote) {
    peers.push({
      node_no: cfg.nodeNo, name: 'Site host', token_hash: sha256(remote.nodeToken), revoked_at: null,
      lan_url: st.lan_url, lan_tenant: st.lan_tenant,
      voting: (conn.prepare('SELECT voting FROM sync_node WHERE k = 1').get() as { voting: number }).voting,
    });
  }
  const rows = conn.prepare("SELECT rowid AS rowid_, * FROM sync_commands WHERE state = 'local' ORDER BY rowid").all() as
    Array<Record<string, unknown> & { rowid_: number }>;
  return {
    site: {
      site_no: siteOfThisPc(conn, cfg), host: cfg.nodeNo, term: st.site_term, epoch: streamEpoch(conn),
      cloud_url: remote?.cloudUrl ?? null, cloud_tenant: remote?.tenant ?? null, peers,
    },
    site_log: {
      pending: rows.map((r) => String(r.id)),
      commands: rows.filter((r) => r.rowid_ > logSince)
        .map((r) => ({ rowid: r.rowid_, cmd: toWire(r as never) })),
    },
  };
}

/** A site PC takes in what its host told it. Returns whether it owes a full re-sync (the host
 *  started a new stream epoch). */
export function absorbHostSite(conn: DatabaseSync, cfg: SyncConfig, site: HostSiteInfo, log: SiteLog | undefined): boolean {
  const st = nodeState(conn);
  const upsert = conn.prepare(
    `INSERT INTO sync_nodes (node_no, name, token_hash, revoked_at, lan_url, lan_tenant, voting) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(node_no) DO UPDATE SET name = excluded.name, token_hash = excluded.token_hash, revoked_at = excluded.revoked_at,
       lan_url = excluded.lan_url, lan_tenant = excluded.lan_tenant, voting = excluded.voting`,
  );
  for (const p of site.peers) {
    if (p.node_no === cfg.nodeNo) {
      conn.prepare('UPDATE sync_node SET voting = ? WHERE k = 1').run(p.voting); // whether this PC votes
      continue;
    }
    upsert.run(p.node_no, p.name, p.token_hash, p.revoked_at, p.lan_url, p.lan_tenant, p.voting);
  }
  const fields: Partial<NodeState> = {};
  if (site.term > st.site_term) fields.site_term = site.term;
  if (site.cloud_url) { fields.cloud_url = site.cloud_url; fields.cloud_tenant = site.cloud_tenant; }
  if (site.site_no != null && st.host_node_no == null) fields.host_node_no = site.site_no;
  const resync = !!st.host_epoch && st.host_epoch !== site.epoch;
  if (!st.host_epoch) fields.host_epoch = site.epoch;
  if (resync) fields.resync_pending = 1;
  if (log) {
    const keep = new Set(log.pending);
    const ins = conn.prepare('INSERT OR REPLACE INTO sync_site_log (id, host_rowid, cmd) VALUES (?, ?, ?)');
    let top = st.site_log_rowid;
    for (const c of log.commands) {
      if (keep.has(c.cmd.id)) ins.run(c.cmd.id, c.rowid, JSON.stringify(c.cmd));
      top = Math.max(top, c.rowid);
    }
    for (const r of conn.prepare('SELECT id FROM sync_site_log').all() as Array<{ id: string }>) {
      if (!keep.has(r.id)) conn.prepare('DELETE FROM sync_site_log WHERE id = ?').run(r.id);
    }
    fields.site_log_rowid = top;
  }
  setNode(conn, fields);
  return resync;
}

/** What the cloud tells a site's PC about its site: who hosts it now, and under which term. */
export function cloudSiteInfo(conn: DatabaseSync, nodeNo: number):
  { site_no: number; host: number; term: number; host_lan_url: string | null; host_lan_tenant: string | null } | null {
  const site = siteOfNode(conn, nodeNo);
  if (site == null) return null;
  const { host, term } = siteHostOf(conn, site);
  const h = conn.prepare('SELECT lan_url, lan_tenant FROM sync_nodes WHERE node_no = ?').get(host) as
    { lan_url: string | null; lan_tenant: string | null } | undefined;
  return { site_no: site, host, term, host_lan_url: h?.lan_url ?? null, host_lan_tenant: h?.lan_tenant ?? null };
}

// ---------------------------------------------------------------- changing roles

/**
 * Become the site's host (an admin's decision, or — phase 5b — an election). The PC takes the
 * old host's unconfirmed commands as its own to forward, lets the site's PCs in with the
 * credentials it mirrored, starts a new term and stream, and owes a full re-sync, which it does
 * when it next reaches the cloud (after claiming the site there).
 */
export async function takeOverAsHost(slug: string, opts: { term?: number } = {}): Promise<{ site: number; term: number }> {
  const conn = getDb(slug);
  const cfg = syncConfigOf(conn);
  if (cfg?.role !== 'node') throw Object.assign(new Error('Only an installed PC can take over as site host.'), { status: 409 });
  if (cfg.isHost) throw Object.assign(new Error('This PC is already the site host.'), { status: 409 });
  const site = siteOfThisPc(conn, cfg);
  const st = nodeState(conn);
  if (site == null) throw Object.assign(new Error('This PC is not part of a site.'), { status: 409 });
  // An election already moved this PC to the term it won; an admin's take-over starts the next one.
  const term = opts.term ?? st.site_term + 1;
  if (!st.cloud_url) {
    throw Object.assign(new Error('This PC has not heard from its site host yet. Connect it to the host once first.'), { status: 409 });
  }
  const release = await lockSync(conn);
  try {
    conn.exec('BEGIN');
    try {
      for (const r of conn.prepare('SELECT cmd FROM sync_site_log ORDER BY host_rowid').all() as Array<{ cmd: string }>) {
        const cmd = JSON.parse(r.cmd) as SyncCommand;
        if (!getCommand(conn, cmd.id)) insertCommand(conn, cmd, { state: 'local' });
      }
      conn.prepare("UPDATE sync_commands SET state = 'local' WHERE state = 'host_confirmed'").run();
      conn.prepare('DELETE FROM sync_site_log').run();
      conn.prepare('DELETE FROM sync_effects').run();
      setNode(conn, {
        host_node_no: site, site_term: term, stream_epoch: newEpoch(), host_epoch: null,
        resync_pending: 1, host_misses: 0, site_log_rowid: 0,
      });
      // Its own credential works with the cloud too: it was issued there at enrolment.
      conn.prepare('UPDATE sync_remote SET cloud_url = ?, tenant = ? WHERE k = 1').run(st.cloud_url, st.cloud_tenant);
      conn.exec('COMMIT');
    } catch (e) {
      conn.exec('ROLLBACK');
      throw e;
    }
  } finally {
    release();
  }
  enableSync(conn, { role: 'node', nodeNo: cfg.nodeNo, isHost: true });
  drainRecorder(conn); // the takeover itself is not an effect for the LAN
  roleChange.onChange?.(true);
  return { site, term };
}

/** Stop being the site's host: another PC holds it under a higher term. Called after this
 *  round's commands went to the cloud; the rest go to the new host, then this PC re-syncs from
 *  it like any of the site's PCs. Its unused document numbers are given up (gaps). */
export function stepDown(conn: DatabaseSync, cfg: SyncConfig, to: { site_no: number; host: number; term: number; host_lan_url: string | null; host_lan_tenant: string | null }): void {
  conn.exec('BEGIN');
  try {
    setNode(conn, {
      host_node_no: to.site_no, site_term: to.term, stream_epoch: null, host_epoch: null, resync_pending: 1, host_misses: 0,
    });
    if (to.host_lan_url) {
      conn.prepare('UPDATE sync_remote SET cloud_url = ?, tenant = ? WHERE k = 1').run(to.host_lan_url, to.host_lan_tenant);
    }
    conn.prepare('DELETE FROM sync_seq_blocks').run();
    conn.prepare('DELETE FROM sync_effects').run();
    conn.exec('COMMIT');
  } catch (e) {
    conn.exec('ROLLBACK');
    throw e;
  }
  enableSync(conn, { role: 'node', nodeNo: cfg.nodeNo });
  roleChange.onChange?.(false);
}

/** A site PC follows a new host: what the old host had accepted is sent again (the new host
 *  recognises what it already holds), then the PC re-syncs from it. */
export function switchHost(conn: DatabaseSync, to: { url: string; tenant: string | null; term: number }): void {
  conn.exec('BEGIN');
  try {
    conn.prepare('UPDATE sync_remote SET cloud_url = ?, tenant = ? WHERE k = 1').run(to.url.replace(/\/+$/, ''), to.tenant);
    conn.prepare("UPDATE sync_commands SET state = 'local' WHERE state = 'host_confirmed'").run();
    setNode(conn, { site_term: to.term, host_epoch: null, resync_pending: 1, host_misses: 0, site_log_rowid: 0 });
    conn.prepare('DELETE FROM sync_site_log').run();
    conn.exec('COMMIT');
  } catch (e) {
    conn.exec('ROLLBACK');
    throw e;
  }
}

/** Ask the site's other PCs which of them hosts the site now. Returns the newest host (highest
 *  term, at least this PC's) other than the one it already follows, or null. */
export async function findSiteHost(conn: DatabaseSync, cfg: SyncConfig): Promise<{ url: string; tenant: string | null; node_no: number; term: number } | null> {
  const site = siteOfThisPc(conn, cfg);
  if (site == null) return null;
  const st = nodeState(conn);
  const current = remoteOf(conn)?.cloudUrl;
  const peers = conn.prepare('SELECT node_no, lan_url, lan_tenant FROM sync_nodes WHERE lan_url IS NOT NULL AND revoked_at IS NULL AND node_no != ?')
    .all(cfg.nodeNo) as Array<{ node_no: number; lan_url: string; lan_tenant: string | null }>;
  let best: { url: string; tenant: string | null; node_no: number; term: number } | null = null;
  for (const p of peers) {
    try {
      const r = await fetch(`${p.lan_url.replace(/\/+$/, '')}/api/sync/whoami`, {
        headers: p.lan_tenant ? { 'x-tenant': p.lan_tenant } : {}, signal: AbortSignal.timeout(3000),
      });
      if (!r.ok) continue;
      const me = (await r.json()) as { node_no: number; is_host: boolean; site_no?: number | null; term?: number };
      if (!me.is_host || me.site_no !== site || (me.term ?? 1) < st.site_term) continue;
      if (p.lan_url === current && (p.lan_tenant ?? null) === (remoteOf(conn)?.tenant ?? null) && (me.term ?? 1) <= st.site_term) continue;
      if (!best || (me.term ?? 1) > best.term) best = { url: p.lan_url, tenant: p.lan_tenant, node_no: me.node_no, term: me.term ?? 1 };
    } catch { /* that PC is off or unreachable */ }
  }
  return best;
}

// ---------------------------------------------------------------- full re-sync

/** Record the authority's verdicts on commands just sent (a re-sync skips the pull that
 *  normally brings them): what it accepted must not be re-run on top of a copy that has it. */
export function recordVerdicts(conn: DatabaseSync, results: CommandResult[]): void {
  const set = conn.prepare(
    `UPDATE sync_commands SET state = ?, authority_seq = ?, response_status = ?, error = ?, local_changeset = NULL,
            updated_at = datetime('now') WHERE id = ? AND state IN ('local', 'host_confirmed')`,
  );
  for (const r of results) {
    if (r.state === 'host_confirmed' || r.state === 'confirmed' || r.state === 'rejected') {
      set.run(r.state, r.authority_seq, r.response_status, r.error, r.id);
    }
  }
}

/**
 * Replace this copy's data with a fresh copy from its authority, then re-run what is still
 * pending on top. Node-local tables — sign-ins, sync bookkeeping, credentials — are kept. Call
 * after every command it could send has been sent (verdicts recorded). A host starts a new
 * stream epoch, so its PCs re-sync too.
 */
export async function resyncFromSnapshot(slug: string): Promise<{ rerun: number; conflicts: number }> {
  const conn = getDb(slug);
  const cfg = syncConfigOf(conn);
  const remote = remoteOf(conn);
  if (cfg?.role !== 'node' || !remote) throw new Error(`"${slug}" is not an enrolled PC.`);
  // The authority's identity: a host's epoch is what this PC follows from now on.
  let epoch: string | null = null;
  try {
    const r = await fetch(`${remote.cloudUrl}/api/sync/whoami`, {
      headers: remote.tenant ? { 'x-tenant': remote.tenant } : {}, signal: AbortSignal.timeout(10_000),
    });
    if (r.ok) epoch = ((await r.json()) as { epoch?: string | null }).epoch ?? null;
  } catch { /* the download below reports the problem */ }
  const file = path.join(os.tmpdir(), `vds-resync-${crypto.randomBytes(6).toString('hex')}.db`);
  await downloadSnapshot({ fromUrl: remote.cloudUrl, nodeToken: remote.nodeToken, file, tenant: remote.tenant });
  const release = await lockSync(conn);
  try {
    const tables = (conn.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string; sql: string | null }>)
      .filter((t) => !t.name.startsWith('sqlite_') && !/^CREATE VIRTUAL TABLE/i.test(t.sql ?? '') && isReplicated(t.name))
      .map((t) => t.name);
    withForeignKeysOff(conn, () => {
      conn.exec(`ATTACH DATABASE '${file.replace(/'/g, "''")}' AS snap`);
      try {
        conn.exec('BEGIN');
        try {
          const inSnap = new Set((conn.prepare("SELECT name FROM snap.sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name));
          for (const t of tables) {
            if (!inSnap.has(t)) continue;
            const cols = (conn.prepare(`PRAGMA main.table_info("${t}")`).all() as Array<{ name: string }>).map((c) => c.name);
            const snapCols = new Set((conn.prepare(`PRAGMA snap.table_info("${t}")`).all() as Array<{ name: string }>).map((c) => c.name));
            const shared = cols.filter((c) => snapCols.has(c)).map((c) => `"${c}"`).join(', ');
            if (t === 'settings') {
              // Only the replicated settings are the authority's to replace.
              for (const { key } of conn.prepare('SELECT key FROM main.settings').all() as Array<{ key: string }>) {
                if (isReplicated('settings', [key])) conn.prepare('DELETE FROM main.settings WHERE key = ?').run(key);
              }
              conn.exec(`INSERT OR REPLACE INTO main.settings (${shared}) SELECT ${shared} FROM snap.settings`);
              continue;
            }
            conn.exec(`DELETE FROM main."${t}"`);
            conn.exec(`INSERT INTO main."${t}" (${shared}) SELECT ${shared} FROM snap."${t}"`);
          }
          if (inSnap.has('sqlite_sequence')) {
            for (const t of tables) {
              conn.prepare('DELETE FROM main.sqlite_sequence WHERE name = ?').run(t);
              conn.prepare('INSERT INTO main.sqlite_sequence (name, seq) SELECT name, seq FROM snap.sqlite_sequence WHERE name = ?').run(t);
            }
          }
          const at = conn.prepare('SELECT MAX(authority_seq) AS s FROM snap.sync_effects').get() as { s: number | null };
          conn.prepare('UPDATE sync_node SET last_authority_seq = ?, resync_pending = 0, host_misses = 0 WHERE k = 1').run(at.s ?? 0);
          if (!cfg.isHost) setNode(conn, { host_epoch: epoch });
          conn.exec('COMMIT');
        } catch (e) {
          conn.exec('ROLLBACK');
          throw e;
        }
      } finally {
        conn.exec('DETACH DATABASE snap');
      }
    });
    if (isAuthority(cfg)) {
      // A host's PCs can't follow a wholesale replacement as effects: new stream, they re-sync.
      drainRecorder(conn);
      conn.prepare('DELETE FROM sync_effects').run();
      setNode(conn, { stream_epoch: newEpoch() });
    }
    const counts = await rerunCommands(slug, conn, localCommands(conn));
    if (isAuthority(cfg)) flushEffects(conn, null);
    return counts;
  } finally {
    release();
    fs.rmSync(file, { force: true });
  }
}

// ---------------------------------------------------------------- endpoints

export function failoverRoutes(nodeAuth: RequestHandler): Router {
  const router = Router();

  router.get('/site', requireAuth, (_req, res) => {
    const conn = activeDb();
    const cfg = syncConfigOf(conn);
    if (cfg?.role !== 'node') { res.json({ installed: false }); return; }
    const st = nodeState(conn);
    res.json({
      installed: true,
      node_no: cfg.nodeNo,
      is_host: cfg.isHost === true,
      site_no: siteOfThisPc(conn, cfg),
      term: st.site_term,
      resync_pending: st.resync_pending === 1,
      host_misses: st.host_misses,
      can_take_over: !cfg.isHost && siteOfThisPc(conn, cfg) != null && !!st.cloud_url,
      peers: conn.prepare('SELECT node_no, name, lan_url, voting, revoked_at FROM sync_nodes ORDER BY node_no').all(),
    });
  });

  router.post('/site/take-over', requireAuth, requirePermission('users.manage'), async (req, res, next) => {
    if (req.body?.confirm !== true) {
      res.status(400).json({
        error: 'Confirm that the site host is switched off or unreachable. Two hosts at once make a site decide twice.',
      });
      return;
    }
    try {
      res.json({ ok: true, ...(await takeOverAsHost(slugOf())) });
    } catch (e) {
      next(e);
    }
  });

  // Re-sync this PC from a fresh copy at the next round (its pending work is sent first and
  // re-run on top) — for a copy that looks wrong.
  router.post('/site/resync', requireAuth, requirePermission('users.manage'), (_req, res) => {
    const conn = activeDb();
    if (syncConfigOf(conn)?.role !== 'node') { res.status(409).json({ error: 'Only an installed PC re-syncs.' }); return; }
    setNode(conn, { resync_pending: 1 });
    res.json({ ok: true });
  });

  // The cloud, as referee: a site's PC claims the site under a term.
  router.post('/site/host', nodeAuth, (req, res) => {
    const conn = activeDb();
    if (syncConfigOf(conn)?.role !== 'cloud') { res.status(404).json({ error: 'Only the cloud records site hosts.' }); return; }
    const caller = res.locals.syncNodeNo as number;
    const site = siteOfNode(conn, caller);
    const term = Number(req.body?.term);
    if (site == null || !Number.isInteger(term) || term < 1) {
      res.status(400).json({ error: 'Not a PC of a site, or no term.' });
      return;
    }
    const cur = siteHostOf(conn, site);
    if (cur.host === caller && term <= cur.term) { res.json({ site_no: site, host: caller, term: cur.term }); return; }
    if (term <= cur.term) {
      res.status(409).json({ error: `Site ${site} is hosted by PC #${cur.host} (term ${cur.term}).`, ...cloudSiteInfo(conn, caller) });
      return;
    }
    conn.exec('BEGIN');
    try {
      conn.prepare(
        `INSERT INTO sync_sites (site_no, host_node_no, term) VALUES (?, ?, ?)
         ON CONFLICT(site_no) DO UPDATE SET host_node_no = excluded.host_node_no, term = excluded.term, updated_at = datetime('now')`,
      ).run(site, caller, term);
      // Every PC of the site — the first host too — now names the site explicitly.
      for (const n of siteMembers(conn, site)) {
        conn.prepare('UPDATE sync_nodes SET is_host = ?, host_node_no = ? WHERE node_no = ?').run(n === caller ? 1 : 0, site, n);
      }
      conn.exec('COMMIT');
    } catch (e) {
      conn.exec('ROLLBACK');
      throw e;
    }
    res.json({ site_no: site, host: caller, term });
  });

  // A host gives its site's PCs the site's certificate authority (so any of them can host).
  router.get('/site/ca', nodeAuth, (_req, res) => {
    const cfg = syncConfigOf(activeDb());
    const dir = process.env.LAN_TLS_DIR;
    const ca = cfg?.role === 'node' && cfg.isHost && dir ? exportSiteAuthority(dir) : null;
    if (!ca) { res.status(404).json({ error: 'No site certificate here.' }); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.json(ca);
  });

  return router;
}
