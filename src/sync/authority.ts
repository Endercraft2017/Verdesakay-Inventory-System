/**
 * The authority's side of sync (docs/OFFLINE-FIRST.md §2.2, §3): turn everything that changes
 * on the cloud into an ordered stream of confirmed effects, accept commands from nodes by
 * replaying them, and serve effects + verdicts back.
 *
 * Phase 1 exposes these as in-process functions; the node ↔ host ↔ cloud HTTP transport is
 * phase 3.
 */
import fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { getDb } from '../shared/db';
import { filterChangeset } from './changeset';
import {
  getCommand, insertCommand, lockSync, type CommandResult, type SyncCommand,
} from './commands';
import { drainRecorder, isReplicated, syncConfigOf } from './node';
import { dispatchCommand } from './replay';

/** Move what the cloud recorder captured since the last flush into `sync_effects`. Returns the
 *  new effect's authority_seq, or null when nothing replicated changed (or a transaction is
 *  open — its changes are taken at the next flush). */
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

function requireCloud(slug: string): DatabaseSync {
  const conn = getDb(slug);
  if (syncConfigOf(conn)?.role !== 'cloud') throw new Error(`"${slug}" is not a sync authority.`);
  return conn;
}

function resultOf(conn: DatabaseSync, id: string): CommandResult {
  const r = getCommand(conn, id)!;
  return { id: r.id, state: r.state, authority_seq: r.authority_seq, response_status: r.response_status, error: r.error };
}

/**
 * Accept one command from a node: store it, replay it through its route as its actor with
 * its allocation plan and clock, and record the result as the next confirmed effect.
 * Idempotent: a command already decided returns its stored verdict.
 */
export async function acceptCommand(slug: string, cmd: SyncCommand): Promise<CommandResult> {
  const conn = requireCloud(slug);
  const existing = getCommand(conn, cmd.id);
  if (existing && existing.state !== 'received') return resultOf(conn, cmd.id);
  if (!existing) insertCommand(conn, cmd, { state: 'received' });

  const release = await lockSync(conn);
  try {
    flushEffects(conn, null); // anything before this command is not its effect
    const r = await dispatchCommand(slug, cmd, 'replay');
    const seq = flushEffects(conn, cmd.id);
    const ok = r.status < 400;
    const error = ok ? null
      : (r.body && typeof r.body === 'object' && 'error' in r.body ? String((r.body as { error: unknown }).error) : `HTTP ${r.status}`);
    conn.prepare(
      `UPDATE sync_commands SET state = ?, authority_seq = ?, response_status = ?, error = ?, plan_misses = ?,
              updated_at = datetime('now') WHERE id = ?`,
    ).run(ok ? 'confirmed' : 'rejected', seq, r.status, error, r.ctx?.planMisses ?? 0, cmd.id);
    return resultOf(conn, cmd.id);
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
  /** Verdicts on this node's commands. */
  results: CommandResult[];
  /** The authority_seq the node is caught up to after applying `effects`. */
  upTo: number;
}

/** Effects after `since`, plus verdicts on `nodeNo`'s commands. */
export function pullFor(slug: string, nodeNo: number, since: number): PullResult {
  const conn = requireCloud(slug);
  flushEffects(conn, null); // include background writes not yet flushed
  const effects = conn
    .prepare('SELECT authority_seq, command_id, changeset FROM sync_effects WHERE authority_seq > ? ORDER BY authority_seq')
    .all(since) as unknown as Effect[];
  const results = conn
    .prepare(
      `SELECT id, state, authority_seq, response_status, error FROM sync_commands
       WHERE node_no = ? AND state IN ('confirmed', 'rejected') ORDER BY node_seq`,
    )
    .all(nodeNo) as unknown as CommandResult[];
  const upTo = effects.length ? effects[effects.length - 1]!.authority_seq : since;
  return { effects, results, upTo };
}

/** A consistent copy of the cloud DB for a new node to start from (enrolment): pending
 *  changes are flushed first, so the copy and the effect stream agree on where it stands. */
export function snapshotForNode(slug: string, file: string): void {
  const conn = requireCloud(slug);
  flushEffects(conn, null);
  if (fs.existsSync(file)) fs.rmSync(file);
  conn.prepare('VACUUM INTO ?').run(file);
}
