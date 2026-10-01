/**
 * Statement wrapper for sync-enabled DBs (installed as `syncHooks.prepare`), doing two jobs:
 *
 * 1. Node-partitioned row ids (docs/OFFLINE-FIRST.md §7.2). SQLite's AUTOINCREMENT continues
 *    after a table's highest id, which may be another node's range, so on a sync-enabled DB
 *    every INSERT into a replicated table is renumbered right after it runs: rows above the
 *    pre-insert maximum move into this DB's range, in the same statement's transaction, and
 *    `lastInsertRowid` / RETURNING ids are patched. Works for any INSERT shape without parsing
 *    SQL beyond the target table. While recording, each id enters the command's allocation
 *    plan; on rebase/replay the plan is consumed so a row keeps the id the device showed.
 *
 * 2. The node write guard. On a node, a mutating request whose route has no sync class
 *    (`guard` mode) may not write replicated tables — it would change local data nothing
 *    will ever sync. Node-local tables (sessions, activity log…) stay writable.
 *
 * DBs without sync get the original statement back untouched.
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { syncContext, type SyncContext } from '../shared/sync-context';
import { isNodeLocalTable, syncConfigOf, NODE_RANGE, type SyncConfig } from './node';

export class SyncBlockedError extends Error {
  status = 503;
  expose = true; // the central error handler shows this message despite the 5xx
  constructor(message = 'This action needs an internet connection. It is not available offline yet.') {
    super(message);
  }
}

const WRITE_RE = /^\s*(insert|replace|update|delete)\b(?:\s+or\s+\w+)?\s+(?:into\s+|from\s+)?["`[]?([A-Za-z_]\w*)/i;

/** The table a write statement targets, '?' for a write we can't attribute (e.g. WITH …
 *  INSERT), or null for a read. */
export function writeTarget(sql: string): string | null {
  const m = WRITE_RE.exec(sql);
  if (m) return m[2]!;
  if (/^\s*with\b/i.test(sql) && /\b(insert|update|delete|replace)\b/i.test(sql)) return '?';
  return null;
}

/** Whether an INSERT lists an explicit `id` column (then the caller chose the id; keep it). */
function insertsExplicitId(sql: string): boolean {
  const m = /^\s*(?:insert|replace)\b[^(]*\(([^)]*)\)\s*(?:values|select)\b/i.exec(sql);
  return !!m && m[1]!.split(',').some((c) => c.trim().replace(/^["`[]|["`\]]$/g, '').toLowerCase() === 'id');
}

const idTableCache = new WeakMap<DatabaseSync, Map<string, boolean>>();

/** Whether `table` has a single INTEGER PRIMARY KEY named `id` (the tables we renumber). */
function hasIntegerId(conn: DatabaseSync, table: string): boolean {
  let cache = idTableCache.get(conn);
  if (!cache) idTableCache.set(conn, (cache = new Map()));
  let v = cache.get(table);
  if (v === undefined) {
    const cols = conn.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string; type: string; pk: number }>;
    const pk = cols.filter((c) => c.pk > 0);
    v = pk.length === 1 && pk[0]!.name === 'id' && /INT/i.test(pk[0]!.type);
    cache.set(table, v);
  }
  return v;
}

function taken(conn: DatabaseSync, table: string, id: number): boolean {
  return !!conn.prepare(`SELECT 1 FROM "${table}" WHERE id = ?`).get(id);
}

/** Next free id in this DB's range for `table`. `own` = the temporary id of the row being
 *  renumbered, which may simply keep its id when that is the next free one. */
export function allocateId(conn: DatabaseSync, cfg: SyncConfig, table: string, own?: number): number {
  const base = cfg.nodeNo * NODE_RANGE;
  const row = conn.prepare('SELECT next FROM sync_id_counters WHERE tbl = ?').get(table) as { next: number } | undefined;
  let next = row?.next;
  if (next === undefined) {
    const m = conn.prepare(`SELECT MAX(id) AS m FROM "${table}" WHERE id >= ? AND id < ?`).get(base, base + NODE_RANGE) as { m: number | null };
    next = (m.m ?? base) + 1;
  }
  while (next !== own && taken(conn, table, next)) next++;
  if (next >= base + NODE_RANGE) throw new Error(`Row id range of node ${cfg.nodeNo} is exhausted for ${table}.`);
  conn.prepare('INSERT INTO sync_id_counters (tbl, next) VALUES (?, ?) ON CONFLICT(tbl) DO UPDATE SET next = excluded.next')
    .run(table, next + 1);
  return next;
}

function nextPlanned(ctx: SyncContext, table: string): number | undefined {
  const ids = ctx.plan.filter((e): e is Extract<typeof e, { t: 'id' }> => e.t === 'id');
  const e = ids[ctx.cursor.id++];
  if (e && e.table === table) return e.id;
  ctx.planMisses = (ctx.planMisses ?? 0) + 1;
  return undefined;
}

/** The final id for the freshly inserted row whose temporary id is `tmp`. */
function chooseId(conn: DatabaseSync, cfg: SyncConfig, table: string, tmp: number): number {
  const ctx = syncContext();
  if (ctx && (ctx.mode === 'rebase' || ctx.mode === 'replay') && !ctx.unattributed) {
    const planned = nextPlanned(ctx, table);
    if (planned !== undefined && (planned === tmp || !taken(conn, table, planned))) {
      ctx.effective?.push({ t: 'id', table, id: planned });
      return planned;
    }
    if (planned !== undefined) ctx.planMisses = (ctx.planMisses ?? 0) + 1;
  }
  const id = allocateId(conn, cfg, table, tmp);
  if (ctx?.mode === 'record' && !ctx.unattributed) ctx.plan.push({ t: 'id', table, id });
  ctx?.effective?.push({ t: 'id', table, id });
  return id;
}

function renumber(conn: DatabaseSync, cfg: SyncConfig, table: string, before: number): Map<number, number> {
  const fresh = (conn.prepare(`SELECT id FROM "${table}" WHERE id > ? ORDER BY id`).all(before) as Array<{ id: number | bigint }>)
    .map((r) => Number(r.id));
  const moved = new Map<number, number>();
  for (const tmp of fresh) {
    const id = chooseId(conn, cfg, table, tmp); // never another fresh row's id: those are taken
    if (id !== tmp) conn.prepare(`UPDATE "${table}" SET id = ? WHERE id = ?`).run(id, tmp);
    moved.set(tmp, id);
  }
  return moved;
}

function patchRow(row: unknown, moved: Map<number, number>): unknown {
  if (row && typeof row === 'object' && 'id' in row) {
    const r = row as { id: number | bigint };
    const to = moved.get(Number(r.id));
    if (to !== undefined) r.id = typeof r.id === 'bigint' ? BigInt(to) : to;
  }
  return row;
}

export function wrapPrepared(conn: DatabaseSync, sql: string, stmt: StatementSync): StatementSync {
  const cfg = syncConfigOf(conn);
  if (!cfg) return stmt;
  const table = writeTarget(sql);
  if (!table || (table !== '?' && isNodeLocalTable(table))) return stmt;
  const renumbers = table !== '?' && /^\s*(insert|replace)/i.test(sql) && !insertsExplicitId(sql) && hasIntegerId(conn, table);

  const execute = <T>(kind: 'run' | 'get' | 'all' | 'iterate', fn: () => T): T => {
    if (cfg.role === 'node' && syncContext()?.mode === 'guard') throw new SyncBlockedError();
    if (!renumbers || kind === 'iterate') return fn();
    const before = Number((conn.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM "${table}"`).get() as { m: number | bigint }).m);
    const result = fn();
    const moved = renumber(conn, cfg, table, before);
    if (!moved.size) return result;
    if (kind === 'run') {
      const r = result as { changes: number | bigint; lastInsertRowid: number | bigint };
      const to = moved.get(Number(r.lastInsertRowid));
      if (to === undefined) return result;
      return { ...r, lastInsertRowid: typeof r.lastInsertRowid === 'bigint' ? BigInt(to) : to } as T;
    }
    if (kind === 'all') return (result as unknown[]).map((row) => patchRow(row, moved)) as T;
    return patchRow(result, moved) as T;
  };

  return new Proxy(stmt, {
    get(target, prop) {
      const value = (target as unknown as Record<string | symbol, unknown>)[prop];
      if (typeof value !== 'function') return value;
      const fn = value as (...a: unknown[]) => unknown;
      if (prop === 'run' || prop === 'get' || prop === 'all' || prop === 'iterate') {
        return (...args: unknown[]) => execute(prop, () => fn.apply(target, args));
      }
      return fn.bind(target);
    },
  });
}
