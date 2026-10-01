/**
 * An authority's side of sync (docs/OFFLINE-FIRST.md §2.2, §3): turn everything that changes
 * on it into an ordered stream of effects, accept commands from PCs by replaying them, and
 * serve effects + verdicts back.
 *
 * Two kinds of authority run this code:
 *  - the **cloud** — the final word: a replayed command is `confirmed` or `rejected` for good;
 *  - a **site host** (phase 3c) — the authority for the PCs on its LAN while it is also an
 *    ordinary node towards the cloud. A LAN PC's command it accepts becomes one of the host's
 *    own pending commands (state `local`, its changes kept for rebase) and is reported to the
 *    LAN PC as `host_confirmed`; the host later forwards it to the cloud, whose verdict flows
 *    back down the same way. Everything the host's DB does — accepting, rebasing onto the cloud,
 *    undoing a command the cloud rejected — is in its recorder's stream, so LAN PCs mirror it.
 */
import fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { getDb } from '../shared/db';
import { filterChangeset } from './changeset';
import {
  getCommand, insertCommand, lockSync, type CommandResult, type CommandState, type SyncCommand,
} from './commands';
import { drainRecorder, isAuthority, isReplicated, syncConfigOf, type SyncConfig } from './node';
import { dispatchCommand } from './replay';

/** Move what the recorder captured since the last flush into `sync_effects`. Returns the new
 *  effect's sequence number, or null when nothing replicated changed (or a transaction is open —
 *  its changes are taken at the next flush). */
export function flushEffects(conn: DatabaseSync, commandId: string | null): number | null {
  if (conn.isTransaction) return null;
  const raw = drainRecorder(conn);
  if (!raw) return null;
  const changes = filterChangeset(raw, isReplicated);
  if (!changes.length) return null;
  const row = conn
    .prepare('INSERT INTO sync_effects (command_id, changeset) VALUES (?, ?) RETURNING authority_seq')
    .get(commandId, changes) as { authority_seq: number };
  return row.authority_seq;
}

function requireAuthority(slug: string): { conn: DatabaseSync; cfg: SyncConfig } {
  const conn = getDb(slug);
  const cfg = syncConfigOf(conn);
  if (!isAuthority(cfg)) throw new Error(`"${slug}" is not a sync authority.`);
  return { conn, cfg: cfg! };
}

/** How a stored command looks to the PC that sent it. On a host, a LAN PC's command it accepted
 *  is `local` (pending towards the cloud) — to the LAN PC that means `host_confirmed`. */
function asVerdict(state: CommandState, hostView: boolean): CommandState {
  return hostView && state === 'local' ? 'host_confirmed' : state;
}

function resultOf(conn: DatabaseSync, id: string, hostView: boolean): CommandResult {
  const r = getCommand(conn, id)!;
  return {
    id: r.id, state: asVerdict(r.state, hostView), authority_seq: r.authority_seq,
    response_status: r.response_status, error: r.error,
  };
}

/**
 * Accept one command from a PC: store it, replay it through its route as its actor with its
 * allocation plan and clock, and record the result as the next effect. Idempotent: a command
 * already decided returns its stored verdict.
 */
export async function acceptCommand(slug: string, cmd: SyncCommand): Promise<CommandResult> {
  const { conn, cfg } = requireAuthority(slug);
  const host = cfg.role === 'node';
  const release = await lockSync(conn); // stored and replayed in one turn: the site order
  try {
    const existing = getCommand(conn, cmd.id);
    if (existing && existing.state !== 'received') return resultOf(conn, cmd.id, host);
    if (!existing) insertCommand(conn, cmd, { state: 'received' });

    flushEffects(conn, null); // anything before this command is not its effect
    const r = await dispatchCommand(slug, cmd, 'replay');
    const seq = flushEffects(conn, cmd.id);
    const ok = r.status < 400;
    const error = ok ? null
      : (r.body && typeof r.body === 'object' && 'error' in r.body ? String((r.body as { error: unknown }).error) : `HTTP ${r.status}`);
    // On a host an accepted command waits for the cloud like the host's own: keep its effect
    // as the changeset to undo if the host has to rebase.
    const state: CommandState = !ok ? 'rejected' : host ? 'local' : 'confirmed';
    const changes = host && ok && seq != null
      ? (conn.prepare('SELECT changeset FROM sync_effects WHERE authority_seq = ?').get(seq) as { changeset: Uint8Array }).changeset
      : null;
    conn.prepare(
      `UPDATE sync_commands SET state = ?, authority_seq = ?, response_status = ?, error = ?, plan_misses = ?,
              local_changeset = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(state, seq, r.status, error, r.ctx?.planMisses ?? 0, changes, cmd.id);
    // A host forwards what it actually allocated, so the cloud reproduces the host's rows.
    if (host && ok && r.ctx?.effective) {
      conn.prepare('UPDATE sync_commands SET allocation_plan = ? WHERE id = ?').run(JSON.stringify(r.ctx.effective), cmd.id);
    }
    return resultOf(conn, cmd.id, host);
  } finally {
    release();
  }
}

export interface Effect {
  authority_seq: number;
  command_id: string | null;
  changeset: Uint8Array;
}

export interface PullResult {
  effects: Effect[];
  /** Verdicts on the asking PC's commands. */
  results: CommandResult[];
  /** The sequence number the PC is caught up to after applying `effects`. */
  upTo: number;
}

/**
 * Effects after `since`, plus verdicts on the commands of `nodeNos` (the asking PC, and for a
 * site host also its LAN PCs) and on the unattributed commands it names in `commandIds` (those
 * carry no node number, by design, so the PC asks for them by id).
 */
export function pullFor(slug: string, nodeNos: number | number[], since: number, commandIds: string[] = []): PullResult {
  const { conn, cfg } = requireAuthority(slug);
  const host = cfg.role === 'node';
  flushEffects(conn, null); // include background writes not yet flushed
  const effects = conn
    .prepare('SELECT authority_seq, command_id, changeset FROM sync_effects WHERE authority_seq > ? ORDER BY authority_seq')
    .all(since) as unknown as Effect[];
  const nos = Array.isArray(nodeNos) ? nodeNos : [nodeNos];
  const decided = host ? "('local', 'confirmed', 'rejected')" : "('confirmed', 'rejected')";
  const ids = commandIds.slice(0, 500);
  const rows = conn
    .prepare(
      `SELECT id, state, authority_seq, response_status, error FROM sync_commands
        WHERE state IN ${decided}
          AND (node_no IN (${nos.map(() => '?').join(', ') || 'NULL'})
               OR (unattributed = 1 AND id IN (${ids.map(() => '?').join(', ') || 'NULL'})))
        ORDER BY rowid`,
    )
    .all(...nos, ...ids) as unknown as CommandResult[];
  const results = rows.map((r) => ({ ...r, state: asVerdict(r.state, host) }));
  const upTo = effects.length ? effects[effects.length - 1]!.authority_seq : since;
  return { effects, results, upTo };
}

/** A consistent copy of an authority's DB for a new PC to start from (enrolment): pending
 *  changes are flushed first, so the copy and the effect stream agree on where it stands. */
export function snapshotForNode(slug: string, file: string): void {
  const { conn } = requireAuthority(slug);
  flushEffects(conn, null);
  if (fs.existsSync(file)) fs.rmSync(file);
  conn.prepare('VACUUM INTO ?').run(file);
}
