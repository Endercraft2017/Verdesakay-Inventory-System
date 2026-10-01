/**
 * Per-database sync identity (docs/OFFLINE-FIRST.md §3). A tenant DB takes part in sync only
 * once `enableSync()` has given it a role: `cloud` (the final authority, node number 0) or
 * `node` (an installed PC, node number 1–65535 issued at enrolment). A DB with no `sync_node`
 * row — every tenant today — is untouched by src/sync/.
 *
 * Everything this module stores lives in node-local `sync_*` tables, which never replicate.
 */
import type { DatabaseSync, Session } from 'node:sqlite';
import { installClockOverride } from './clock';

export type SyncRole = 'cloud' | 'node';

export interface SyncConfig {
  role: SyncRole;
  nodeNo: number;
}

/** Row ids of node N are N × 2^37 + counter, so every id stays a safe JS integer
 *  (65535 × 2^37 + 2^37 < 2^53) and every pre-sync row already fits node 0's range. */
export const NODE_RANGE = 2 ** 37;
export const MAX_NODE_NO = 65535;

/** Tables that never replicate: sync bookkeeping, per-device state, credentials, derived
 *  indexes (OFFLINE-FIRST §7.5 "node-local tables"). */
export function isNodeLocalTable(table: string): boolean {
  return (
    table.startsWith('sync_') ||
    table.startsWith('sqlite_') ||
    table.startsWith('doc_chunks') || // AI search FTS5 index + its shadow tables, rebuilt per node
    table === 'sessions' ||
    table === 'idempotency_keys' ||
    table === 'activity_log' || // the authority writes its own row when it replays a command
    table === 'anonymous_report_tickets' ||
    table === 'push_subscriptions'
  );
}

/** `settings` rows that are credentials, not data: the key that unlocks stored secrets
 *  (shared/secrets.ts) and the secrets themselves. Nodes never need them — outside calls
 *  (email, QuickBooks, AI) run only on the cloud — so they never leave it (§7.5). */
export const SECRET_SETTINGS = new Set(['_secret_key', 'mail_smtp_pass', 'qbo_tokens', 'ai_api_key']);

/** Whether a changed row replicates: its table isn't node-local and it isn't a secret setting.
 *  Called per table (no `pk`) and per row by `filterChangeset`. */
export function isReplicated(table: string, pk?: unknown[]): boolean {
  if (isNodeLocalTable(table)) return false;
  if (table === 'settings' && pk && SECRET_SETTINGS.has(String(pk[0]))) return false;
  return true;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sync_node (
    k                  INTEGER PRIMARY KEY CHECK (k = 1),
    role               TEXT NOT NULL CHECK (role IN ('cloud','node')),
    node_no            INTEGER NOT NULL,
    node_seq           INTEGER NOT NULL DEFAULT 0,
    hlc                TEXT,
    last_authority_seq INTEGER NOT NULL DEFAULT 0,
    provisional_seq    INTEGER NOT NULL DEFAULT 0,
    enabled_at         TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- Next row id to hand out per replicated table, within this DB's node range.
  CREATE TABLE IF NOT EXISTS sync_id_counters (
    tbl  TEXT PRIMARY KEY,
    next INTEGER NOT NULL
  );
  -- Commands: made here (a node's own) or received (the authority's inbox).
  CREATE TABLE IF NOT EXISTS sync_commands (
    id               TEXT PRIMARY KEY,           -- ULID
    node_no          INTEGER,                    -- NULL when unattributed
    node_seq         INTEGER,
    hlc              TEXT,
    occurred_at      TEXT,                       -- ISO UTC; NULL when unattributed
    occurred_date    TEXT NOT NULL,              -- YYYY-MM-DD
    actor_user_id    INTEGER,
    device_id        TEXT,
    method           TEXT NOT NULL,
    path             TEXT NOT NULL,
    body             TEXT NOT NULL,
    sync_class       TEXT NOT NULL,
    allocation_plan  TEXT NOT NULL DEFAULT '[]',
    app_version      TEXT NOT NULL,
    unattributed     INTEGER NOT NULL DEFAULT 0,
    state            TEXT NOT NULL CHECK (state IN ('local','received','confirmed','rejected','conflict')),
    authority_seq    INTEGER,
    local_changeset  BLOB,
    response_status  INTEGER,
    error            TEXT,
    plan_misses      INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_sync_commands_state ON sync_commands(state, node_seq);
  -- Cloud side: the installed PCs enrolled against this workspace. Node numbers are never
  -- reused (a revoked PC's rows keep their ids). Only the token's SHA-256 is stored.
  CREATE TABLE IF NOT EXISTS sync_nodes (
    node_no      INTEGER PRIMARY KEY,
    name         TEXT NOT NULL,
    token_hash   TEXT NOT NULL UNIQUE,
    enrolled_by  INTEGER,
    enrolled_at  TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT,
    revoked_at   TEXT
  );
  -- Node side: where this copy syncs to, and its credential there.
  CREATE TABLE IF NOT EXISTS sync_remote (
    k          INTEGER PRIMARY KEY CHECK (k = 1),
    cloud_url  TEXT NOT NULL,
    node_token TEXT NOT NULL
  );
  -- Confirmed effects, in authority order (the authority's outgoing stream).
  CREATE TABLE IF NOT EXISTS sync_effects (
    authority_seq INTEGER PRIMARY KEY AUTOINCREMENT,
    command_id    TEXT,
    changeset     BLOB NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

/** Columns added to sync tables after they first shipped (CREATE TABLE IF NOT EXISTS doesn't add
 *  columns to an existing table). Applied whenever a sync DB is opened or enabled. */
const ADDED_COLUMNS: Array<[table: string, column: string, ddl: string]> = [
  ['sync_commands', 'dismissed_at', 'ALTER TABLE sync_commands ADD COLUMN dismissed_at TEXT'],
];

function ensureSyncSchema(conn: DatabaseSync): void {
  conn.exec(SCHEMA);
  for (const [table, column, ddl] of ADDED_COLUMNS) {
    const cols = conn.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) conn.exec(ddl);
  }
}

const configs = new WeakMap<DatabaseSync, SyncConfig | null>();

/** The cloud's continuous change recorder: one SQLite session per cloud DB, drained into
 *  `sync_effects` at each flush (src/sync/authority.ts). Started the moment the DB is first
 *  seen as sync-enabled — before any write — so no change can slip past unrecorded. */
const recorders = new WeakMap<DatabaseSync, Session>();

function startRecorder(conn: DatabaseSync): void {
  if (!recorders.has(conn)) recorders.set(conn, conn.createSession());
}

/** Everything recorded on a cloud DB since the last call (raw, unfiltered), restarting the
 *  recorder. Null when this DB has no recorder. */
export function drainRecorder(conn: DatabaseSync): Uint8Array | null {
  const s = recorders.get(conn);
  if (!s) return null;
  const cs = s.changeset();
  s.close();
  recorders.set(conn, conn.createSession());
  return cs;
}

/** This DB's sync role, or null when sync isn't enabled on it (cached per connection). */
export function syncConfigOf(conn: DatabaseSync): SyncConfig | null {
  const cached = configs.get(conn);
  if (cached !== undefined) return cached;
  const hasTable = conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sync_node'").get();
  const row = hasTable
    ? (conn.prepare('SELECT role, node_no FROM sync_node WHERE k = 1').get() as { role: SyncRole; node_no: number } | undefined)
    : undefined;
  const cfg = row ? { role: row.role, nodeNo: row.node_no } : null;
  if (cfg) ensureSyncSchema(conn);
  configs.set(conn, cfg);
  if (cfg) installClockOverride(conn);
  if (cfg?.role === 'cloud') startRecorder(conn);
  return cfg;
}

/** Give a DB its sync role. Re-running with a new role/number re-identifies it — that is how
 *  a snapshot of the cloud becomes node N at enrolment (unconfirmed commands are dropped). */
export function enableSync(conn: DatabaseSync, cfg: SyncConfig): SyncConfig {
  if (cfg.role === 'cloud' && cfg.nodeNo !== 0) throw new Error('The cloud is node 0.');
  if (cfg.role === 'node' && !(Number.isInteger(cfg.nodeNo) && cfg.nodeNo >= 1 && cfg.nodeNo <= MAX_NODE_NO)) {
    throw new Error(`A node number must be 1–${MAX_NODE_NO}.`);
  }
  ensureSyncSchema(conn);
  const prev = conn.prepare('SELECT role, node_no FROM sync_node WHERE k = 1').get() as { role: SyncRole; node_no: number } | undefined;
  if (!prev || prev.role !== cfg.role || prev.node_no !== cfg.nodeNo) {
    conn.exec('BEGIN');
    try {
      conn.prepare('DELETE FROM sync_node').run();
      conn.prepare('INSERT INTO sync_node (k, role, node_no) VALUES (1, ?, ?)').run(cfg.role, cfg.nodeNo);
      conn.prepare('DELETE FROM sync_id_counters').run();
      // A node keeps the authority's effect position it was snapshotted at; its own command
      // log starts empty. The cloud's received commands stay (they are its inbox).
      if (cfg.role === 'node') {
        conn.prepare('DELETE FROM sync_commands').run();
        const last = conn.prepare('SELECT MAX(authority_seq) AS s FROM sync_effects').get() as { s: number | null };
        conn.prepare('UPDATE sync_node SET last_authority_seq = ?').run(last.s ?? 0);
        conn.prepare('DELETE FROM sync_effects').run();
      }
      conn.exec('COMMIT');
    } catch (e) {
      conn.exec('ROLLBACK');
      throw e;
    }
  }
  configs.set(conn, { ...cfg });
  installClockOverride(conn);
  if (cfg.role === 'cloud') startRecorder(conn);
  else {
    recorders.get(conn)?.close();
    recorders.delete(conn);
  }
  return { ...cfg };
}

/** Forget cached roles (tests that reopen a DB file under the same connection object). */
export function _resetSyncConfigCache(conn: DatabaseSync): void {
  configs.delete(conn);
}
