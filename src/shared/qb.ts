/**
 * Typed query builder (Kysely), used as a SQL *compiler* only.
 *
 * `qb` builds a query with column/table names and result types checked against
 * src/shared/db-types.ts (generated from the real schema by `npm run db:types`). The compiled
 * SQL + params then run through the same synchronous helpers as hand-written SQL
 * (queryAll/queryOne/run in db.ts), so tenant resolution (activeDb), transactions
 * (db.exec('BEGIN') …) and error handling are exactly what the rest of the app uses. Kysely
 * never opens a connection (DummyDriver).
 *
 *   import { qb, all, first, exec } from '../shared/qb';
 *   const notes = all(qb.selectFrom('notes').selectAll().where('user_id', '=', uid));
 *   exec(qb.deleteFrom('notes').where('id', '=', id));
 *
 * New code may use either this or raw SQL; complex report/payroll SQL can stay raw
 * (Kysely's `sql` template tag covers one-off expressions like datetime('now')).
 */
import {
  Kysely, DummyDriver, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler,
  type Compilable,
} from 'kysely';
import { queryAll, queryOne, run } from './db';
import type { DB } from './db-types';

export { sql } from 'kysely';
export type { DB } from './db-types';

export const qb = new Kysely<DB>({
  dialect: {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (k) => new SqliteIntrospector(k),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  },
});

/** node:sqlite can't bind booleans; store them the way the schema does (0/1). */
function params(q: Compilable<unknown>): { sql: string; params: unknown[] } {
  const c = q.compile();
  return { sql: c.sql, params: c.parameters.map((p) => (typeof p === 'boolean' ? (p ? 1 : 0) : p)) };
}

/** Run a SELECT (or INSERT … RETURNING) and return every row. */
export function all<O>(q: Compilable<O>): O[] {
  const c = params(q);
  return queryAll<O>(c.sql, ...c.params);
}

/** Run a SELECT and return the first row, or undefined. */
export function first<O>(q: Compilable<O>): O | undefined {
  const c = params(q);
  return queryOne<O>(c.sql, ...c.params);
}

/** Run an INSERT/UPDATE/DELETE; returns node:sqlite's { changes, lastInsertRowid }. */
export function exec(q: Compilable<unknown>) {
  const c = params(q);
  return run(c.sql, ...c.params);
}
