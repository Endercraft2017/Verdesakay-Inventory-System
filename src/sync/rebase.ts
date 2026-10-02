/**
 * The node's side of sync (docs/OFFLINE-FIRST.md §2.3): apply the authority's confirmed
 * effects the way `git pull --rebase` applies commits.
 *
 * 1. undo every pending local command (apply the inverse of its captured changeset, newest
 *    first) — the DB is back at the last confirmed state;
 * 2. apply the new confirmed effects in authority order;
 * 3. record the authority's verdicts on this node's commands;
 * 4. re-run the still-pending commands on top, through their routes, with their original
 *    plan and clock, capturing fresh changesets.
 *
 * Steps 1–3 are one transaction. Any conflict there means this copy has diverged from the
 * authority (it should be impossible) — the whole pull is refused rather than half-applied.
 *
 * With a site host (phase 3c) the authority may answer `host_confirmed`: the host accepted the
 * command and its effect is in the host's stream, so it is done here too (not re-run); the
 * cloud's final `confirmed` / `rejected` arrives later and only updates its state — if the cloud
 * rejects it, the host's own undo reaches this PC through the same stream. A host running this
 * against the cloud then flushes, so its LAN PCs receive the whole rebase as effects.
 */
import type { DatabaseSync } from 'node:sqlite';
import { getDb } from '../shared/db';
import { filterChangeset, invertChangeset } from './changeset';
import { localCommands, lockSync, toWire, type SyncCommand } from './commands';
import { isAuthority, isReplicated, syncConfigOf } from './node';
import { flushEffects, type PullResult } from './authority';
import { dispatchCommand } from './replay';

export class SyncDivergenceError extends Error {
  constructor(what: string) {
    super(`This copy no longer matches the authority (${what}); it must be re-synced from a fresh snapshot.`);
  }
}

function requireNode(slug: string): DatabaseSync {
  const conn = getDb(slug);
  if (syncConfigOf(conn)?.role !== 'node') throw new Error(`"${slug}" is not a sync node.`);
  return conn;
}

/** This node's commands still waiting for the authority, oldest first (what to push). */
export function pendingCommands(slug: string): SyncCommand[] {
  return localCommands(requireNode(slug)).map(toWire);
}

export function lastAuthoritySeq(slug: string): number {
  const conn = requireNode(slug);
  return (conn.prepare('SELECT last_authority_seq AS s FROM sync_node WHERE k = 1').get() as { s: number }).s;
}

export interface RebaseSummary {
  undone: number;
  applied: number;
  /** Accepted by the site host (not yet by the cloud). */
  onSite: number;
  confirmed: number;
  rejected: number;
  rerun: number;
  conflicts: number;
}

/**
 * Run `fn` (synchronous: nothing else can touch the connection meanwhile) with foreign-key
 * enforcement off. A changeset already contains every row its source changed — including rows
 * changed by ON DELETE CASCADE / SET NULL — so applying it must not fire those actions again:
 * they would edit rows the changeset is about to change and make it conflict (or double-apply).
 * The pragma is a no-op inside a transaction, so this wraps the whole BEGIN…COMMIT.
 */
export function withForeignKeysOff<T>(conn: DatabaseSync, fn: () => T): T {
  conn.exec('PRAGMA foreign_keys = OFF');
  try {
    return fn();
  } finally {
    conn.exec('PRAGMA foreign_keys = ON');
  }
}

function applyStrict(conn: DatabaseSync, changes: Uint8Array, what: string): void {
  if (!changes.length) return;
  // Default conflict handling is ABORT: applyChangeset returns false and changes nothing.
  if (!conn.applyChangeset(changes)) throw new SyncDivergenceError(what);
}

export async function applyConfirmed(slug: string, pull: PullResult): Promise<RebaseSummary> {
  const conn = requireNode(slug);
  const release = await lockSync(conn);
  try {
    const pending = localCommands(conn);
    const verdicts = new Map(pull.results.map((r) => [r.id, r]));
    const summary: RebaseSummary = { undone: 0, applied: 0, onSite: 0, confirmed: 0, rejected: 0, rerun: 0, conflicts: 0 };

    withForeignKeysOff(conn, () => {
      conn.exec('BEGIN');
      try {
        for (const c of [...pending].reverse()) {
          if (c.local_changeset?.length) {
            applyStrict(conn, invertChangeset(c.local_changeset), `undoing command ${c.id}`);
            summary.undone++;
          }
        }
        for (const e of pull.effects) {
          applyStrict(conn, e.changeset, `effect #${e.authority_seq}`);
          summary.applied++;
        }
        conn.prepare('UPDATE sync_node SET last_authority_seq = MAX(last_authority_seq, ?) WHERE k = 1').run(pull.upTo);
        const setVerdict = conn.prepare(
          `UPDATE sync_commands SET state = ?, authority_seq = ?, response_status = ?, error = ?, local_changeset = NULL,
                  updated_at = datetime('now') WHERE id = ? AND state IN ('local', 'host_confirmed')`,
        );
        const decided = new Set(['host_confirmed', 'confirmed', 'rejected']);
        for (const v of pull.results) {
          if (!decided.has(v.state)) continue;
          const changed = setVerdict.run(v.state, v.authority_seq, v.response_status, v.error, v.id).changes;
          if (!changed) continue;
          if (v.state === 'host_confirmed') summary.onSite++;
          else if (v.state === 'confirmed') summary.confirmed++;
          else summary.rejected++;
        }
        conn.exec('COMMIT');
      } catch (e) {
        conn.exec('ROLLBACK');
        throw e;
      }
    });

    // Re-run what the authority hasn't decided yet, on top of the new confirmed state.
    const counts = await rerunCommands(slug, conn, pending.filter((c) => !verdicts.has(c.id)));
    summary.rerun += counts.rerun;
    summary.conflicts += counts.conflicts;
    // A site host streams what this rebase did to its LAN PCs.
    if (isAuthority(syncConfigOf(conn))) flushEffects(conn, null);
    return summary;
  } finally {
    release();
  }
}

/** Re-run commands through their routes on top of the current state, capturing fresh
 *  changesets; one that no longer applies becomes a conflict and keeps nothing (step 4 of a
 *  rebase, and the last step of a full re-sync — failover.ts). Call holding the sync lock. */
export async function rerunCommands(
  slug: string, conn: DatabaseSync, commands: Array<ReturnType<typeof localCommands>[number]>,
): Promise<{ rerun: number; conflicts: number }> {
  const counts = { rerun: 0, conflicts: 0 };
  for (const c of commands) {
    const session = conn.createSession();
    let status = 0;
    let error: string | null = null;
    try {
      const r = await dispatchCommand(slug, c, 'rebase');
      status = r.status;
      if (status >= 400) {
        error = r.body && typeof r.body === 'object' && 'error' in r.body
          ? String((r.body as { error: unknown }).error) : `HTTP ${status}`;
      }
    } finally {
      let changes: Uint8Array | null = filterChangeset(session.changeset(), isReplicated);
      session.close();
      const ok = status > 0 && status < 400;
      // A command that no longer applies keeps nothing: undo any partial write, so this
      // copy stays exactly "confirmed state + pending commands".
      if (!ok && changes.length) {
        const undo = invertChangeset(changes);
        withForeignKeysOff(conn, () => applyStrict(conn, undo, `undoing failed re-run of ${c.id}`));
        changes = null;
      }
      conn.prepare(
        `UPDATE sync_commands SET state = ?, local_changeset = ?, response_status = ?, error = ?,
                updated_at = datetime('now') WHERE id = ?`,
      ).run(ok ? 'local' : 'conflict', changes, status || null, error, c.id);
    }
    if (status && status < 400) counts.rerun++;
    else counts.conflicts++;
  }
  return counts;
}
