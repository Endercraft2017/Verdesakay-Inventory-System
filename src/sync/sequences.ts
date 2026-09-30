/**
 * Document numbers under sync (docs/OFFLINE-FIRST.md §7.2), installed as
 * `syncHooks.nextSequence` in front of `nextSequence()` — the one place every SO-/JO-/PR-/…
 * number comes from.
 *
 * - A node recording a command gets a PROVISIONAL number (`SO-P7-0001`): it can't know the
 *   next real number while other PCs and the cloud are issuing them too. The number enters
 *   the command's allocation plan.
 * - Re-running that command during rebase reuses the same provisional number.
 * - The authority replaying it issues the real next number (provisional numbers are never
 *   kept); a non-provisional planned number (a site host's leased block, phase 3) is kept and
 *   the counter moved past it.
 * - Anything else (no sync, a cloud user's own request) falls through to the normal counter.
 */
import type { DatabaseSync } from 'node:sqlite';
import { activeDb, getSetting, setSetting } from '../shared/db';
import { syncContext } from '../shared/sync-context';
import { syncConfigOf } from './node';

function provisional(conn: DatabaseSync, nodeNo: number, prefix: string): string {
  const row = conn.prepare('UPDATE sync_node SET provisional_seq = provisional_seq + 1 RETURNING provisional_seq AS n').get() as { n: number };
  return `${prefix}-P${nodeNo}-${String(row.n).padStart(4, '0')}`;
}

export function syncedSequence(key: string, prefix: string, _pad: number): string | undefined {
  const ctx = syncContext();
  if (!ctx || ctx.mode === 'guard') return undefined;
  const conn = activeDb();
  const cfg = syncConfigOf(conn);
  if (!cfg) return undefined;

  if (ctx.mode === 'record') {
    const value = provisional(conn, cfg.nodeNo, prefix);
    if (!ctx.unattributed) ctx.plan.push({ t: 'seq', key, value, provisional: true });
    return value;
  }

  const seqs = ctx.plan.filter((e): e is Extract<typeof e, { t: 'seq' }> => e.t === 'seq');
  const planned = seqs[ctx.cursor.seq++];
  if (!planned || planned.key !== key) {
    if (planned) ctx.planMisses = (ctx.planMisses ?? 0) + 1;
    return ctx.mode === 'rebase' ? provisional(conn, cfg.nodeNo, prefix) : undefined;
  }
  if (ctx.mode === 'rebase') return planned.value;
  // replay on the authority
  if (planned.provisional) return undefined; // issue the real next number
  const n = Number(/-(\d+)$/.exec(planned.value)?.[1] ?? NaN);
  if (Number.isFinite(n) && n > (getSetting<number>(key) || 0)) setSetting(key, n);
  return planned.value;
}
