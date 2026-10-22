/**
 * Per-database sync identity (docs/OFFLINE-FIRST.md §3). A tenant DB takes part in sync only
 * once `enableSync()` has given it a role: `cloud` (the final authority, node number 0) or
 * `node` (an installed PC, node number 1–65535 issued at enrolment). A node may also be its
 * site's **host** (phase 3c): the authority for the PCs on its LAN, and an ordinary node
 * towards the cloud. A DB with no `sync_node` row — every tenant today — is untouched.
 *
 * Everything this module stores lives in node-local `sync_*` tables, which never replicate.
 */
import type { DatabaseSync, Session } from 'node:sqlite';
import { configureFormHistoryConnection } from '../shared/form-history-context';
import { installClockOverride } from './clock';

export type SyncRole = 'cloud' | 'node';

export interface SyncConfig {
  role: SyncRole;
  nodeNo: number;
  /** A node that is its site's host (present only when true). */
  isHost?: true;
}

/** Whether this DB accepts other PCs' commands: the cloud, or a site host. */
export function isAuthority(cfg: SyncConfig | null): boolean {
  return !!cfg && (cfg.role === 'cloud' || cfg.isHost === true);
}

/** Row ids of node N are N × 2^37 + counter, so every id stays a safe JS integer
 *  (65535 × 2^37 + 2^37 < 2^53) and every pre-sync row already fits node 0's range. */
export const NODE_RANGE = 2 ** 37;
export const MAX_NODE_NO = 65535;

/** Tables of online-only features — they hold credentials or what only the cloud can use, and an
 *  installed PC never needs them (user direction 2026-10-01, OFFLINE-FIRST §7.5): password-reset
 *  tokens (sent by email), QuickBooks links, the email log, AI assistant conversations. */
const CLOUD_ONLY_TABLES = new Set(['password_resets', 'qbo_links', 'mail_log', 'ai_messages', 'ai_pending_actions',
  // Two-step sign-in: secrets are encrypted with the cloud's key, and installed PCs (on-site,
  // on the office network) sign in with the password alone — see src/core/mfa.ts.
  'user_mfa', 'user_mfa_recovery', 'mfa_challenges']);

/** Tables that never replicate: sync bookkeeping, per-device state, credentials, derived
 *  indexes, online-only features (OFFLINE-FIRST §7.5 "node-local tables"). */
export function isNodeLocalTable(table: string): boolean {
  return (
    CLOUD_ONLY_TABLES.has(table) ||
    table.startsWith('sync_') ||
    table.startsWith('sqlite_') ||
    table.startsWith('doc_studio_') && table !== 'doc_studio_library' || // private working state stays on its originating server
    table.startsWith('doc_chunks') || // AI search FTS5 index + its shadow tables, rebuilt per node
    table === 'sessions' ||
    table === 'idempotency_keys' ||
    table === 'activity_log' || // the authority writes its own row when it replays a command
    table === 'durable_uploads' || // each node keeps its own recoverable copy of transferred files
    table === 'anonymous_report_tickets' ||
    table === 'push_subscriptions'
  );
}

/** `settings` rows that are credentials, not data: the key that unlocks stored secrets
 *  (shared/secrets.ts), the secrets themselves, and the web-push private key. */
export const SECRET_SETTINGS = new Set(['_secret_key', 'mail_smtp_pass', 'qbo_tokens', 'ai_api_key', 'vapid_keys']);
/** Settings of online-only features (AI, email, QuickBooks): an installed PC can't use them —
 *  those calls run only on the cloud (§7.8) — so they never leave it either. */
export const CLOUD_ONLY_SETTING_PREFIXES = ['ai_', 'mail_', 'qbo_'];

/** Whether a `settings` row stays on the cloud (a secret, or an online-only feature's). */
export function isCloudOnlySetting(key: string): boolean {
  return SECRET_SETTINGS.has(key) || CLOUD_ONLY_SETTING_PREFIXES.some((p) => key.startsWith(p));
}

/** Whether a changed row replicates: its table isn't node-local and it isn't a cloud-only
 *  setting. Called per table (no `pk`) and per row by `filterChangeset`. */
export function isReplicated(table: string, pk?: unknown[]): boolean {
  if (isNodeLocalTable(table)) return false;
  if (table === 'settings' && pk && isCloudOnlySetting(String(pk[0]))) return false;
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
    is_host            INTEGER NOT NULL DEFAULT 0,
    host_node_no       INTEGER,                  -- a LAN PC: its site host's node number
    last_file_seq      INTEGER NOT NULL DEFAULT 0, -- files fetched from the authority up to here
    enabled_at         TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- Next row id to hand out per replicated table, within this DB's node range.
  CREATE TABLE IF NOT EXISTS sync_id_counters (
    tbl  TEXT PRIMARY KEY,
    next INTEGER NOT NULL
  );
  -- Commands: made here (a node's own), received (the authority's inbox), or — on a site
  -- host — accepted from a LAN PC and pending towards the cloud like the host's own.
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
    state            TEXT NOT NULL CHECK (state IN ('local','received','host_confirmed','confirmed','rejected','conflict')),
    authority_seq    INTEGER,
    local_changeset  BLOB,
    response_status  INTEGER,
    error            TEXT,
    plan_misses      INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
    dismissed_at     TEXT,
    context          TEXT                        -- allow-listed request facts a replay needs (§20)
  );
  CREATE INDEX IF NOT EXISTS idx_sync_commands_state ON sync_commands(state, node_seq);
  -- The PCs this authority accepts: on the cloud, every enrolled PC (a host's LAN PCs carry
  -- its node number in host_node_no); on a site host, its LAN PCs, copied from the cloud
  -- (GET /api/sync/members). Node numbers are never reused. Only the token's SHA-256 is kept.
  CREATE TABLE IF NOT EXISTS sync_nodes (
    node_no      INTEGER PRIMARY KEY,
    name         TEXT NOT NULL,
    token_hash   TEXT NOT NULL UNIQUE,
    enrolled_by  INTEGER,
    enrolled_at  TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT,
    revoked_at   TEXT,
    is_host      INTEGER NOT NULL DEFAULT 0,
    host_node_no INTEGER
  );
  -- Node side: the authority this copy syncs with (the cloud, or its site host), and its
  -- credential there. \`tenant\` is sent as X-Tenant (honoured only outside production).
  CREATE TABLE IF NOT EXISTS sync_remote (
    k          INTEGER PRIMARY KEY CHECK (k = 1),
    cloud_url  TEXT NOT NULL,
    node_token TEXT NOT NULL,
    tenant     TEXT
  );
  -- Files (phase 3e, §18). An authority lists every uploaded file it holds, in order, so its PCs
  -- can fetch the ones they lack; a PC remembers which files a command carries were already sent.
  CREATE TABLE IF NOT EXISTS sync_files (
    seq      INTEGER PRIMARY KEY AUTOINCREMENT,
    name     TEXT NOT NULL UNIQUE,
    size     INTEGER NOT NULL,
    added_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sync_blobs (
    hash      TEXT PRIMARY KEY,
    size      INTEGER NOT NULL,
    pushed_at TEXT
  );
  -- Site number blocks (§21). Cloud: the blocks it leased each host, and every series in use.
  -- Host: its blocks, and the series it needed.
  CREATE TABLE IF NOT EXISTS sync_seq_leases (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    host_node_no INTEGER NOT NULL,
    key          TEXT NOT NULL,
    first        INTEGER NOT NULL,
    last         INTEGER NOT NULL,
    leased_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sync_seq_keys (key TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS sync_seq_blocks (
    key  TEXT NOT NULL,
    next INTEGER NOT NULL,
    last INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sync_seq_wanted (
    key       TEXT PRIMARY KEY,
    wanted_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- Failover (phase 5, §30). A site PC's mirror of the commands its host holds but the cloud
  -- hasn't confirmed yet (its own and other PCs'): if the host is lost, whoever takes over
  -- forwards them, so work recorded through the old host isn't lost with it.
  CREATE TABLE IF NOT EXISTS sync_site_log (
    id         TEXT PRIMARY KEY,                 -- the command's id
    host_rowid INTEGER NOT NULL,                 -- its position in the host's log
    cmd        TEXT NOT NULL                     -- the command, as sent over the wire (JSON)
  );
  -- Cloud: each site's current host and term (a site is numbered after its first host). A site
  -- with no row has term 1 and the host it was enrolled with.
  CREATE TABLE IF NOT EXISTS sync_sites (
    site_no      INTEGER PRIMARY KEY,
    host_node_no INTEGER NOT NULL,
    term         INTEGER NOT NULL,
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
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
  ['sync_node', 'is_host', 'ALTER TABLE sync_node ADD COLUMN is_host INTEGER NOT NULL DEFAULT 0'],
  ['sync_nodes', 'is_host', 'ALTER TABLE sync_nodes ADD COLUMN is_host INTEGER NOT NULL DEFAULT 0'],
  ['sync_nodes', 'host_node_no', 'ALTER TABLE sync_nodes ADD COLUMN host_node_no INTEGER'],
  ['sync_remote', 'tenant', 'ALTER TABLE sync_remote ADD COLUMN tenant TEXT'],
  ['sync_node', 'host_node_no', 'ALTER TABLE sync_node ADD COLUMN host_node_no INTEGER'],
  ['sync_node', 'last_file_seq', 'ALTER TABLE sync_node ADD COLUMN last_file_seq INTEGER NOT NULL DEFAULT 0'],
  ['sync_commands', 'context', 'ALTER TABLE sync_commands ADD COLUMN context TEXT'],
  // Local only (never sent): an anonymous-channel command is held until then (§25).
  ['sync_commands', 'release_after', 'ALTER TABLE sync_commands ADD COLUMN release_after TEXT'],
  // Failover (phase 5, §30). A PC: its site's current term; its own stream's epoch (a host) and
  // the epoch of the host stream it follows; a full re-sync owed at the next round; the cloud's
  // address (a site PC learns it from its host, to take over); its own LAN address; how many
  // rounds in a row its host didn't answer.
  ['sync_node', 'site_term', 'ALTER TABLE sync_node ADD COLUMN site_term INTEGER NOT NULL DEFAULT 1'],
  ['sync_node', 'stream_epoch', 'ALTER TABLE sync_node ADD COLUMN stream_epoch TEXT'],
  ['sync_node', 'host_epoch', 'ALTER TABLE sync_node ADD COLUMN host_epoch TEXT'],
  ['sync_node', 'resync_pending', 'ALTER TABLE sync_node ADD COLUMN resync_pending INTEGER NOT NULL DEFAULT 0'],
  ['sync_node', 'cloud_url', 'ALTER TABLE sync_node ADD COLUMN cloud_url TEXT'],
  ['sync_node', 'cloud_tenant', 'ALTER TABLE sync_node ADD COLUMN cloud_tenant TEXT'],
  ['sync_node', 'lan_url', 'ALTER TABLE sync_node ADD COLUMN lan_url TEXT'],
  ['sync_node', 'lan_tenant', 'ALTER TABLE sync_node ADD COLUMN lan_tenant TEXT'],
  ['sync_node', 'host_misses', 'ALTER TABLE sync_node ADD COLUMN host_misses INTEGER NOT NULL DEFAULT 0'],
  ['sync_node', 'site_log_rowid', 'ALTER TABLE sync_node ADD COLUMN site_log_rowid INTEGER NOT NULL DEFAULT 0'],
  // Election (phase 5b, §31): the vote this PC cast in which term (kept, so a restart can't vote
  // twice), and whether it votes at all (set by an admin on the cloud).
  ['sync_node', 'voted_term', 'ALTER TABLE sync_node ADD COLUMN voted_term INTEGER'],
  ['sync_node', 'voted_for', 'ALTER TABLE sync_node ADD COLUMN voted_for INTEGER'],
  ['sync_node', 'voting', 'ALTER TABLE sync_node ADD COLUMN voting INTEGER NOT NULL DEFAULT 1'],
  // Upkeep (phase 6, §32). An authority: which app version each PC runs and how far it has read
  // the effect stream; and up to where it has trimmed that stream (older PCs must re-sync).
  ['sync_nodes', 'app_version', 'ALTER TABLE sync_nodes ADD COLUMN app_version TEXT'],
  ['sync_nodes', 'last_pull_seq', 'ALTER TABLE sync_nodes ADD COLUMN last_pull_seq INTEGER NOT NULL DEFAULT 0'],
  ['sync_node', 'compacted_upto', 'ALTER TABLE sync_node ADD COLUMN compacted_upto INTEGER NOT NULL DEFAULT 0'],
  // An authority: where each PC can be reached on its LAN (reported by the PC), and whether it
  // votes in host elections (a laptop that comes and goes is set not to).
  ['sync_nodes', 'lan_url', 'ALTER TABLE sync_nodes ADD COLUMN lan_url TEXT'],
  ['sync_nodes', 'lan_tenant', 'ALTER TABLE sync_nodes ADD COLUMN lan_tenant TEXT'],
  ['sync_nodes', 'voting', 'ALTER TABLE sync_nodes ADD COLUMN voting INTEGER NOT NULL DEFAULT 1'],
];

/** `sync_commands` created before the `host_confirmed` state existed has a CHECK that rejects
 *  it; SQLite can't alter a CHECK, so the table is rebuilt with its rows (same transaction). */
function upgradeCommandStates(conn: DatabaseSync): void {
  const row = conn.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sync_commands'").get() as { sql: string } | undefined;
  if (!row || row.sql.includes('host_confirmed')) return;
  const cols = (conn.prepare('PRAGMA table_info(sync_commands)').all() as Array<{ name: string }>).map((c) => c.name);
  const nested = conn.isTransaction; // first seen inside a handler's transaction: use a savepoint
  conn.exec(nested ? 'SAVEPOINT sync_upgrade' : 'BEGIN');
  try {
    conn.exec('ALTER TABLE sync_commands RENAME TO sync_commands_old; DROP INDEX IF EXISTS idx_sync_commands_state;');
    conn.exec(SCHEMA); // recreates sync_commands (+ index) with the current definition
    const list = cols.map((c) => `"${c}"`).join(', ');
    conn.exec(`INSERT INTO sync_commands (${list}) SELECT ${list} FROM sync_commands_old; DROP TABLE sync_commands_old;`);
    conn.exec(nested ? 'RELEASE sync_upgrade' : 'COMMIT');
  } catch (e) {
    conn.exec(nested ? 'ROLLBACK TO sync_upgrade; RELEASE sync_upgrade' : 'ROLLBACK');
    throw e;
  }
}

function ensureSyncSchema(conn: DatabaseSync): void {
  conn.exec(SCHEMA);
  for (const [table, column, ddl] of ADDED_COLUMNS) {
    const cols = conn.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) conn.exec(ddl);
  }
  upgradeCommandStates(conn);
}

const configs = new WeakMap<DatabaseSync, SyncConfig | null>();

/** An authority's continuous change recorder: one SQLite session per cloud / site-host DB,
 *  drained into `sync_effects` at each flush (src/sync/authority.ts). It captures every change,
 *  including changesets the host applies while rebasing onto the cloud — so the host's LAN PCs,
 *  replaying that stream in order, mirror the host exactly. Started the moment the DB is first
 *  seen as an authority — before any write — so no change slips past unrecorded. */
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
  if (hasTable) ensureSyncSchema(conn);
  const row = hasTable
    ? (conn.prepare('SELECT role, node_no, is_host FROM sync_node WHERE k = 1').get() as
        { role: SyncRole; node_no: number; is_host: number } | undefined)
    : undefined;
  const cfg: SyncConfig | null = row
    ? { role: row.role, nodeNo: row.node_no, ...(row.is_host ? { isHost: true as const } : {}) }
    : null;
  configs.set(conn, cfg);
  if (cfg) installClockOverride(conn);
  if (isAuthority(cfg)) startRecorder(conn);
  return cfg;
}

/** Give a DB its sync role. Re-running with a new role/number re-identifies it — that is how
 *  a snapshot of the cloud becomes node N at enrolment (unconfirmed commands are dropped). */
export function enableSync(conn: DatabaseSync, cfg: SyncConfig): SyncConfig {
  configureFormHistoryConnection(conn);
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
      conn.prepare('INSERT INTO sync_node (k, role, node_no, is_host) VALUES (1, ?, ?, ?)').run(cfg.role, cfg.nodeNo, cfg.isHost ? 1 : 0);
      conn.prepare('DELETE FROM sync_id_counters').run();
      // A node keeps the authority's effect position it was snapshotted at; its own command
      // log starts empty. The cloud's received commands stay (they are its inbox).
      if (cfg.role === 'node') {
        conn.prepare('DELETE FROM sync_commands').run();
        conn.prepare('DELETE FROM sync_nodes').run(); // a host learns its LAN PCs from the cloud
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
  if (prev && prev.role === cfg.role && prev.node_no === cfg.nodeNo) {
    conn.prepare('UPDATE sync_node SET is_host = ? WHERE k = 1').run(cfg.isHost ? 1 : 0);
  }
  const out: SyncConfig = { role: cfg.role, nodeNo: cfg.nodeNo, ...(cfg.isHost ? { isHost: true as const } : {}) };
  configs.set(conn, out);
  installClockOverride(conn);
  if (isAuthority(out)) startRecorder(conn);
  else {
    recorders.get(conn)?.close();
    recorders.delete(conn);
  }
  return { ...out };
}

/** Forget cached roles (tests that reopen a DB file under the same connection object). */
export function _resetSyncConfigCache(conn: DatabaseSync): void {
  configs.delete(conn);
}
