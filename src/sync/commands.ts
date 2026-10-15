/**
 * The command log (docs/OFFLINE-FIRST.md §2.1) and the per-DB lock that serializes command
 * capture, replay and rebase, so one SQLite session captures exactly one command's changes.
 * All reads/writes here go to node-local `sync_*` tables on the raw connection.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { PlanEntry } from '../shared/sync-context';
import { formatHlc, parseHlc, tickHlc } from './ids-util';

export type SyncClass = 'merge' | 'physical' | 'claim' | 'online';
/** local: not yet decided · received: in an authority's inbox · host_confirmed: accepted by the
 *  site host, not yet by the cloud · confirmed / rejected: the cloud's verdict · conflict: a
 *  pending command that no longer applied when re-run. */
export type CommandState = 'local' | 'received' | 'host_confirmed' | 'confirmed' | 'rejected' | 'conflict';

/** What travels from a node to the authority (the local changeset never does). */
export interface SyncCommand {
  id: string;
  node_no: number | null;
  node_seq: number | null;
  hlc: string | null;
  occurred_at: string | null;
  occurred_date: string;
  actor_user_id: number | null;
  device_id: string | null;
  method: string;
  path: string;
  body: string;
  sync_class: SyncClass;
  allocation_plan: string;
  app_version: string;
  unattributed: number;
  /** Request facts a replay must reproduce (§20): `{ headers?: { 'x-kiosk-token' }, session?: { shared }, validatedSnapshots?: server-owned canonical facts }`. */
  context?: string | null;
}

export interface CommandRow extends SyncCommand {
  state: CommandState;
  authority_seq: number | null;
  local_changeset: Uint8Array | null;
  response_status: number | null;
  error: string | null;
  plan_misses: number;
}

/** The authority's verdict on one command, as returned to the node that made it. */
export interface CommandResult {
  id: string;
  state: CommandState;
  authority_seq: number | null;
  response_status: number | null;
  error: string | null;
}

export const APP_VERSION: string = (() => {
  try {
    const pkg = path.join(import.meta.dirname, '..', '..', 'package.json');
    return (JSON.parse(fs.readFileSync(pkg, 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

const COMMAND_COLUMNS = [
  'id', 'node_no', 'node_seq', 'hlc', 'occurred_at', 'occurred_date', 'actor_user_id', 'device_id',
  'method', 'path', 'body', 'sync_class', 'allocation_plan', 'app_version', 'unattributed', 'context',
] as const;

/** Next node_seq + HLC for a command made on this DB. */
export function stampLocal(conn: DatabaseSync, nodeNo: number): { node_seq: number; hlc: string } {
  const row = conn.prepare('SELECT node_seq, hlc FROM sync_node WHERE k = 1').get() as { node_seq: number; hlc: string | null };
  const hlc = formatHlc(tickHlc(row.hlc ? parseHlc(row.hlc) : null, nodeNo));
  const node_seq = row.node_seq + 1;
  conn.prepare('UPDATE sync_node SET node_seq = ?, hlc = ? WHERE k = 1').run(node_seq, hlc);
  return { node_seq, hlc };
}

export function insertCommand(
  conn: DatabaseSync,
  cmd: SyncCommand,
  extra: { state: CommandState; local_changeset?: Uint8Array | null; response_status?: number | null },
): void {
  const cols = [...COMMAND_COLUMNS, 'state', 'local_changeset', 'response_status'];
  conn.prepare(`INSERT INTO sync_commands (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(
    ...COMMAND_COLUMNS.map((c) => cmd[c] ?? null),
    extra.state,
    extra.local_changeset ?? null,
    extra.response_status ?? null,
  );
}

export function getCommand(conn: DatabaseSync, id: string): CommandRow | undefined {
  return conn.prepare('SELECT * FROM sync_commands WHERE id = ?').get(id) as CommandRow | undefined;
}

/** Commands still waiting for the cloud, in the order they took effect here (insertion order:
 *  on a site host that interleaves its own commands with those it accepted from LAN PCs,
 *  whose node_seq values come from different counters). */
export function localCommands(conn: DatabaseSync): CommandRow[] {
  return conn.prepare("SELECT * FROM sync_commands WHERE state = 'local' ORDER BY rowid").all() as unknown as CommandRow[];
}

export function toWire(row: CommandRow): SyncCommand {
  const out = {} as Record<string, unknown>;
  for (const c of COMMAND_COLUMNS) out[c] = row[c];
  return out as unknown as SyncCommand;
}

export function parsePlan(json: string): PlanEntry[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? (v as PlanEntry[]) : [];
  } catch {
    return [];
  }
}

const locks = new WeakMap<DatabaseSync, Promise<void>>();

/** Wait for this DB's sync lock; resolves to the release function. */
export async function lockSync(conn: DatabaseSync): Promise<() => void> {
  const prev = locks.get(conn) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => { release = r; });
  locks.set(conn, prev.then(() => mine));
  await prev;
  return release;
}
