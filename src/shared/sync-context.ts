/**
 * The seam between shared infrastructure and the offline-first sync layer (src/sync/, see
 * docs/OFFLINE-FIRST.md). Shared code never imports src/sync/; instead it reads the current
 * sync context from here and calls the hooks src/sync/ registers at startup. With no sync
 * installed (every cloud tenant today) the context is empty and every hook is a no-op, so
 * nothing about a normal request changes.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { Request } from 'express';
import type { AuthUser } from './types';

/** One entry of a command's allocation plan: what it was given where it was first run, so a
 *  replay elsewhere produces the same row ids and document numbers (OFFLINE-FIRST §7.2). */
export type PlanEntry =
  | { t: 'id'; table: string; id: number }
  | { t: 'seq'; key: string; value: string; provisional: boolean };

export interface SyncContext {
  /**
   * record  — a node running a command optimistically (side effects discarded)
   * rebase  — a node re-running one of its pending commands on top of confirmed effects
   * replay  — the authority running a received command for real
   * guard   — a mutating request on a node with no sync class: replicated writes are refused
   */
  mode: 'record' | 'rebase' | 'replay' | 'guard';
  /** SQLite-format UTC time ('YYYY-MM-DD HH:MM:SS.SSS') that 'now' means for this command. */
  clock?: string;
  plan: PlanEntry[];
  /** Next id / sequence plan entry to consume (rebase / replay), counted per entry kind. */
  cursor: { id: number; seq: number };
  /** Anonymous-channel command: allocations are local only and never enter the plan. */
  unattributed?: boolean;
  /** Plan entries that could not be honoured on replay (table mismatch, id already taken). */
  planMisses?: number;
  /** Side effects a node skipped during an optimistic run (for tests / diagnostics). */
  skippedEffects?: string[];
}

export const syncStore = new AsyncLocalStorage<SyncContext>();

export function syncContext(): SyncContext | undefined {
  return syncStore.getStore();
}

/** The current time: the command's clock while a command is being recorded or replayed,
 *  otherwise the real time. Use in handlers instead of `new Date()` for business times. */
export function now(): Date {
  const clock = syncStore.getStore()?.clock;
  return clock ? new Date(clock.replace(' ', 'T') + 'Z') : new Date();
}

/** True while a synced command runs (a node's optimistic run or rebase re-run, or the
 *  authority's replay). A `physical` route uses it to accept a stock-out beyond recorded stock
 *  and flag it instead of refusing it (docs/OFFLINE-FIRST.md decision D1); a direct request
 *  to the cloud keeps the normal checks. */
export function inSyncedCommand(): boolean {
  const mode = syncStore.getStore()?.mode;
  return mode === 'record' || mode === 'rebase' || mode === 'replay';
}

/** True while a node runs a command optimistically or re-runs it during rebase: emails, push
 *  notifications and live broadcasts must not fire there — the authority fires them once. */
export function sideEffectsSuppressed(kind: string): boolean {
  const ctx = syncStore.getStore();
  if (!ctx || (ctx.mode !== 'record' && ctx.mode !== 'rebase')) return false;
  (ctx.skippedEffects ??= []).push(kind);
  return true;
}

/** Hooks src/sync/ installs. Absent ⇒ behaviour is exactly as before sync existed. */
export const syncHooks: {
  /** Wrap a freshly prepared statement (ID allocation, write guard). */
  prepare?: (conn: DatabaseSync, sql: string, stmt: StatementSync) => StatementSync;
  /** Issue a document number; return undefined to fall through to the normal counter. */
  nextSequence?: (key: string, prefix: string, pad: number) => string | undefined;
  /** An authenticated user for an internal replay request, or undefined for a normal request. */
  replayUser?: (req: Request) => AuthUser | undefined;
} = {};
