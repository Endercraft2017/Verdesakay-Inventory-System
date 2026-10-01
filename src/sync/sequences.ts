/**
 * Document numbers under sync (docs/OFFLINE-FIRST.md §7.2, §21), installed as
 * `syncHooks.nextSequence` in front of `nextSequence()` — the one place every SO-/JO-/PR-/…
 * number comes from.
 *
 * - A **site host** issues real numbers from the blocks the cloud leased it (`numberblocks.ts`) —
 *   for its own work and when it replays a LAN PC's command — and a provisional one only when it
 *   has none left for that series (it asks for more on its next round).
 * - **Any other PC** recording a command gets a provisional number (`SO-P7-0001`); its host or the
 *   cloud gives the real one.
 * - Re-running a command during rebase reuses whatever number it was given.
 * - **The cloud** replaying a command keeps a real number only if it lies in a block it leased to
 *   the deciding site's host; otherwise (a provisional number, or one it never leased) it issues
 *   the real next number itself.
 * - Anything else (no sync, a cloud user's own request) falls through to the normal counter; the
 *   cloud notes the series so hosts can be leased blocks of it.
 */
import type { DatabaseSync } from 'node:sqlite';
import { activeDb, getSetting, setSetting } from '../shared/db';
import { syncContext, type PlanEntry } from '../shared/sync-context';
import { syncConfigOf, type SyncConfig } from './node';
import { leasedTo, noteSeries, takeFromBlock } from './numberblocks';

function provisional(conn: DatabaseSync, nodeNo: number, prefix: string): string {
  const row = conn.prepare('UPDATE sync_node SET provisional_seq = provisional_seq + 1 RETURNING provisional_seq AS n').get() as { n: number };
  return `${prefix}-P${nodeNo}-${String(row.n).padStart(4, '0')}`;
}

/** A number issued here: a real one from a host's block, else a provisional one. */
function issueHere(conn: DatabaseSync, cfg: SyncConfig, key: string, prefix: string, pad: number): Extract<PlanEntry, { t: 'seq' }> {
  if (cfg.isHost) {
    const n = takeFromBlock(conn, key);
    if (n != null) return { t: 'seq', key, value: `${prefix}-${String(n).padStart(pad, '0')}`, provisional: false };
  }
  return { t: 'seq', key, value: provisional(conn, cfg.nodeNo, prefix), provisional: true };
}

export function syncedSequence(key: string, prefix: string, pad: number): string | undefined {
  const conn = activeDb();
  const cfg = syncConfigOf(conn);
  if (!cfg) return undefined;
  const ctx = syncContext();
  if (cfg.role === 'cloud') noteSeries(conn, key); // the series exists: hosts may be leased it
  if (!ctx || ctx.mode === 'guard') return undefined;

  if (ctx.mode === 'record') {
    const e = issueHere(conn, cfg, key, prefix, pad);
    if (!ctx.unattributed) ctx.plan.push(e);
    return e.value;
  }

  const seqs = ctx.plan.filter((e): e is Extract<typeof e, { t: 'seq' }> => e.t === 'seq');
  const planned = seqs[ctx.cursor.seq++];
  const matches = !!planned && planned.key === key;
  if (planned && !matches) ctx.planMisses = (ctx.planMisses ?? 0) + 1;

  if (ctx.mode === 'rebase') {
    const e = matches ? planned : issueHere(conn, cfg, key, prefix, pad);
    ctx.effective?.push(e);
    return e.value;
  }
  if (cfg.role === 'node') {
    // A site host replaying a LAN PC's command: a provisional number becomes a real one here if
    // the host has a block left; otherwise the PC's provisional number stays (one change, later).
    let e: Extract<PlanEntry, { t: 'seq' }>;
    if (!matches) e = issueHere(conn, cfg, key, prefix, pad);
    else if (!planned.provisional) e = planned;
    else {
      const n = cfg.isHost ? takeFromBlock(conn, key) : null;
      e = n != null ? { t: 'seq', key, value: `${prefix}-${String(n).padStart(pad, '0')}`, provisional: false } : planned;
    }
    ctx.effective?.push(e);
    return e.value;
  }
  // The cloud replaying a command.
  if (!matches || planned.provisional) return undefined; // issue the real next number
  const n = Number(/-(\d+)$/.exec(planned.value)?.[1] ?? NaN);
  if (ctx.decidingSite == null || !Number.isFinite(n) || !leasedTo(conn, ctx.decidingSite, key, n)) {
    ctx.planMisses = (ctx.planMisses ?? 0) + 1; // not a number this cloud handed that site
    return undefined;
  }
  if (n > (getSetting<number>(key) || 0)) setSetting(key, n);
  return planned.value;
}
