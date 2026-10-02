/**
 * Sync upkeep (docs/OFFLINE-FIRST.md §7.10, §32; phase 6).
 *
 * Version skew. Every PC tells its authority which app version it runs (`X-Sync-App-Version`):
 *  - a PC **newer** than its authority waits — the authority can't replay commands its own code
 *    doesn't understand. Update the cloud (or site host) first; the PC syncs again by itself;
 *  - a command made with an app version **outside the replay window** (a different major version)
 *    is rejected on replay with a clear message, and lands in that PC's Needs attention list for
 *    re-entry — nothing is lost silently.
 *
 * Trimming. An authority's effect stream grows with every change. Effects every active PC has
 * already read, and older than `KEEP_DAYS`, are deleted. A PC that falls behind the trimmed point
 * (switched off for weeks, or revoked and re-enabled) is told to re-sync from a fresh copy
 * (failover.ts `resyncFromSnapshot`). A PC's own command log keeps decided commands for
 * `KEEP_DAYS` too.
 */
import type { DatabaseSync } from 'node:sqlite';
import { APP_VERSION } from './commands';
import { compareVersions } from './election';

export const KEEP_DAYS = Number(process.env.SYNC_KEEP_DAYS) || 14;
/** A PC not seen this long no longer holds the stream back; it re-syncs when it returns. */
export const STALE_PC_DAYS = Number(process.env.SYNC_STALE_PC_DAYS) || 30;

const major = (v: string) => parseInt(v.split('.')[0] ?? '0', 10) || 0;

/** Whether a command made with `version` can still be replayed here. */
export function replayable(version: string): boolean {
  return major(version) === major(APP_VERSION);
}

/** Why an authority on this version won't take a PC on `pcVersion`, or null when it will. */
export function versionRefusal(pcVersion: string | undefined): string | null {
  if (!pcVersion) return null; // older PCs don't send it
  if (compareVersions(pcVersion, APP_VERSION) > 0) {
    return `This PC runs app version ${pcVersion}, newer than ${APP_VERSION} where it syncs. It waits until that is updated.`;
  }
  return null;
}

/** An authority notes which version a PC runs and how far it has read the stream. */
export function notePc(conn: DatabaseSync, nodeNo: number, info: { version?: string; pulledUpTo?: number }): void {
  if (info.version) conn.prepare('UPDATE sync_nodes SET app_version = ? WHERE node_no = ?').run(info.version.slice(0, 32), nodeNo);
  if (info.pulledUpTo != null) {
    conn.prepare('UPDATE sync_nodes SET last_pull_seq = MAX(last_pull_seq, ?) WHERE node_no = ?').run(info.pulledUpTo, nodeNo);
  }
}

/** Up to where this authority has trimmed its stream: a PC asking for effects before it re-syncs. */
export function compactedUpTo(conn: DatabaseSync): number {
  return (conn.prepare('SELECT compacted_upto AS c FROM sync_node WHERE k = 1').get() as { c: number } | undefined)?.c ?? 0;
}

/**
 * Trim the effect stream: delete effects every active PC has read and that are older than
 * `keepDays`. Returns how many went. Safe to run any time on an authority.
 */
export function compactEffects(conn: DatabaseSync, keepDays = KEEP_DAYS, staleDays = STALE_PC_DAYS): number {
  const active = conn.prepare(
    `SELECT MIN(last_pull_seq) AS m, COUNT(*) AS n FROM sync_nodes
      WHERE revoked_at IS NULL AND last_seen_at >= datetime('now', ?)`,
  ).get(`-${staleDays} days`) as { m: number | null; n: number };
  const head = (conn.prepare('SELECT COALESCE(MAX(authority_seq), 0) AS h FROM sync_effects').get() as { h: number }).h;
  // No active PC: nobody reads the stream; keep only the recent tail.
  const readByAll = active.n ? (active.m ?? 0) : head;
  const old = conn.prepare("SELECT COALESCE(MAX(authority_seq), 0) AS s FROM sync_effects WHERE created_at < datetime('now', ?)")
    .get(`-${keepDays} days`) as { s: number };
  // Never the newest effect: a fresh copy reads its position from it (transport.ts buildNodeSnapshot).
  const upTo = Math.min(readByAll, old.s, head - 1);
  if (upTo <= compactedUpTo(conn)) return 0;
  const n = Number(conn.prepare('DELETE FROM sync_effects WHERE authority_seq <= ?').run(upTo).changes);
  conn.prepare('UPDATE sync_node SET compacted_upto = ? WHERE k = 1').run(upTo);
  return n;
}

/** A PC's own command log: decided commands older than `keepDays` go (a dismissed rejection
 *  too); rejections still waiting in Needs attention stay. */
export function compactCommands(conn: DatabaseSync, keepDays = KEEP_DAYS): number {
  return Number(conn.prepare(
    `DELETE FROM sync_commands
      WHERE updated_at < datetime('now', ?)
        AND (state = 'confirmed' OR (state IN ('rejected', 'conflict') AND dismissed_at IS NOT NULL))`,
  ).run(`-${keepDays} days`).changes);
}
