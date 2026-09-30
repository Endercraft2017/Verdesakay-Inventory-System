/**
 * Request clock for SQL (docs/OFFLINE-FIRST.md §7.3). On a sync-enabled connection, SQLite's
 * date/time functions are overridden so 'now' means the command's time while a command is
 * recorded or replayed — so a punch or stock movement made offline at 16:45 and synced at 19:00
 * is stored as 16:45, including in column DEFAULT (datetime('now')). Every other call is
 * delegated unchanged to an un-overridden in-memory connection, and with no command clock set
 * 'now' is the real time, so behaviour outside a command is exactly SQLite's.
 */
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { syncContext } from '../shared/sync-context';

// SQLite date function → index of the argument that may be the 'now' time-value.
const FUNCTIONS: Record<string, number> = { datetime: 0, date: 0, time: 0, julianday: 0, unixepoch: 0, strftime: 1 };

let helper: DatabaseSync | null = null;
const helperStmts = new Map<string, StatementSync>();
const installed = new WeakSet<DatabaseSync>();

function builtin(fn: string, args: SQLInputValue[]): SQLInputValue {
  helper ??= new DatabaseSync(':memory:');
  const sql = `SELECT ${fn}(${args.map(() => '?').join(',')}) AS v`;
  let stmt = helperStmts.get(sql);
  if (!stmt) {
    stmt = helper.prepare(sql);
    helperStmts.set(sql, stmt);
  }
  return (stmt.get(...args) as { v: SQLInputValue }).v;
}

export function installClockOverride(conn: DatabaseSync): void {
  if (installed.has(conn)) return;
  installed.add(conn);
  for (const [fn, nowArg] of Object.entries(FUNCTIONS)) {
    conn.function(fn, { varargs: true, deterministic: false }, (...args: SQLInputValue[]) => {
      const clock = syncContext()?.clock;
      if (clock) {
        const tv = args[nowArg];
        if (args.length <= nowArg) args[nowArg] = clock; // datetime() / strftime('%Y') mean now too
        else if (typeof tv === 'string' && tv.toLowerCase() === 'now') args[nowArg] = clock;
      }
      return builtin(fn, args);
    });
  }
}

/** A Date as SQLite's UTC time-value text ('YYYY-MM-DD HH:MM:SS.SSS'). */
export function sqliteTime(d: Date): string {
  return d.toISOString().replace('T', ' ').replace('Z', '');
}
