/**
 * Site number blocks (docs/OFFLINE-FIRST.md §7.2, §21; phase 4b). Document numbers (SO-, MO-,
 * PRS-, …) come from `nextSequence()`. The cloud is the only issuer of real numbers, so while the
 * internet is down a site would only have provisional ones (`SO-P7-0001`) — awkward on a printed
 * slip. Instead the cloud **leases each site host a block** per series (e.g. 51–100 of
 * `order_seq_sale`), moving its own counter past it; the host issues real numbers from its blocks
 * offline, for its own work and its LAN PCs' (via `sync/sequences.ts`), and asks for more each round.
 * The cloud keeps a host-issued number only if it lies in a block it leased to that host.
 *
 * Trade-offs: numbers are unique but not in date order across sites, and a retired host leaves
 * gaps. Not suitable for BIR-registered series (none use nextSequence today).
 *
 *   POST /api/sync/sequence-blocks   (cloud, a site host's token)  { keys: string[] } →
 *                                    [{ key, first, last }]  — `keys: ['*']` = every series in use
 */
import { Router, type Request, type Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { activeDb, getSetting, setSetting } from '../shared/db';
import { syncConfigOf } from './node';

export const BLOCK_SIZE = 50;
/** A host asks for a new block of a series when fewer than this many numbers are left. */
export const REFILL_BELOW = 10;

// ---- cloud side ----

/** The cloud remembers every series it has issued numbers for (so a host can be leased blocks of
 *  all of them up front). */
export function noteSeries(conn: DatabaseSync, key: string): void {
  conn.prepare('INSERT OR IGNORE INTO sync_seq_keys (key) VALUES (?)').run(key);
}

export function leaseBlock(conn: DatabaseSync, hostNodeNo: number, key: string, size = BLOCK_SIZE): { key: string; first: number; last: number } {
  const n = getSetting<number>(key) || 0;
  const first = n + 1;
  const last = n + size;
  setSetting(key, last); // the cloud's own counter moves past the block
  conn.prepare('INSERT INTO sync_seq_leases (host_node_no, key, first, last) VALUES (?, ?, ?, ?)').run(hostNodeNo, key, first, last);
  noteSeries(conn, key);
  return { key, first, last };
}

/** Whether `value` (the number part of a document number) lies in a block leased to `host`. */
export function leasedTo(conn: DatabaseSync, host: number, key: string, value: number): boolean {
  return !!conn.prepare('SELECT 1 FROM sync_seq_leases WHERE host_node_no = ? AND key = ? AND ? BETWEEN first AND last')
    .get(host, key, value);
}

// ---- host side ----

/** Take the next number of `key` from this host's blocks, or null when it has none left (and
 *  remember the series is wanted, for the next round). */
export function takeFromBlock(conn: DatabaseSync, key: string): number | null {
  const b = conn.prepare('SELECT rowid AS id, next, last FROM sync_seq_blocks WHERE key = ? AND next <= last ORDER BY next LIMIT 1')
    .get(key) as { id: number; next: number; last: number } | undefined;
  conn.prepare("INSERT INTO sync_seq_wanted (key) VALUES (?) ON CONFLICT(key) DO UPDATE SET wanted_at = datetime('now')").run(key);
  if (!b) return null;
  conn.prepare('UPDATE sync_seq_blocks SET next = next + 1 WHERE rowid = ?').run(b.id);
  return b.next;
}

/** The series this host should ask a new block of: ones it wanted and ran low on. */
export function seriesToRefill(conn: DatabaseSync): string[] {
  return (conn.prepare(
    `SELECT w.key FROM sync_seq_wanted w
      WHERE COALESCE((SELECT SUM(last - next + 1) FROM sync_seq_blocks b WHERE b.key = w.key AND b.next <= b.last), 0) < ?`,
  ).all(REFILL_BELOW) as Array<{ key: string }>).map((r) => r.key);
}

export function storeBlocks(conn: DatabaseSync, blocks: Array<{ key: string; first: number; last: number }>): void {
  const ins = conn.prepare('INSERT INTO sync_seq_blocks (key, next, last) VALUES (?, ?, ?)');
  for (const b of blocks) ins.run(b.key, b.first, b.last);
}

// ---- endpoint ----

export function numberBlockRoutes(nodeAuth: (req: Request, res: Response, next: () => void) => void): Router {
  const router = Router();
  router.post('/sequence-blocks', nodeAuth, (req, res) => {
    const conn = activeDb();
    if (syncConfigOf(conn)?.role !== 'cloud') {
      res.status(404).json({ error: 'Only the cloud leases document numbers.' });
      return;
    }
    const host = res.locals.syncNodeNo as number;
    const isHost = conn.prepare('SELECT is_host FROM sync_nodes WHERE node_no = ?').get(host) as { is_host: number } | undefined;
    if (!isHost?.is_host) {
      res.status(403).json({ error: 'Only a site host is leased document numbers.' });
      return;
    }
    let keys = Array.isArray(req.body?.keys) ? (req.body.keys as unknown[]).map(String) : [];
    if (keys.includes('*')) {
      keys = [...new Set([...keys.filter((k) => k !== '*'),
        ...(conn.prepare('SELECT key FROM sync_seq_keys').all() as Array<{ key: string }>).map((r) => r.key)])];
    }
    keys = keys.filter((k) => /^[a-z0-9_-]{1,64}$/i.test(k)).slice(0, 100);
    conn.exec('BEGIN');
    try {
      const out = keys.map((k) => leaseBlock(conn, host, k));
      conn.exec('COMMIT');
      res.json(out);
    } catch (e) {
      conn.exec('ROLLBACK');
      throw e;
    }
  });
  return router;
}
