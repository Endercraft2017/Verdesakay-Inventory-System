/**
 * Site number blocks (src/sync/numberblocks.ts + sequences.ts; docs/OFFLINE-FIRST.md §21): the
 * cloud leases a site host blocks of real document numbers; the host issues them offline — for
 * its own work and its LAN PCs' — and the cloud keeps only numbers it leased to that host.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cleanup } from './helpers';
import { setupSiteTrio, type SiteTrio } from './sync-helpers';
import type { SyncContext } from '../src/shared/sync-context';

let T: SiteTrio;
let ctxmod: typeof import('../src/shared/sync-context');
const KEY = 'order_seq_sale';

const inCtx = <R>(slug: string, c: SyncContext, fn: () => R): R => T.dbmod.withTenant(slug, () => ctxmod.syncStore.run(c, fn));
const record = (): SyncContext => ({ mode: 'record', plan: [], cursor: { id: 0, seq: 0 } });
const leases = () => T.cloudDb().prepare('SELECT host_node_no, key, first, last FROM sync_seq_leases WHERE key = ? ORDER BY id').all(KEY) as
  Array<{ host_node_no: number; key: string; first: number; last: number }>;

beforeAll(async () => {
  T = await setupSiteTrio();
  ctxmod = await import('../src/shared/sync-context');
  // The cloud issues a sales-order number once: the series is now known.
  T.dbmod.withTenant('default', () => T.dbmod.nextSequence(KEY, 'SO'));
});
afterAll(() => {
  T.close();
  cleanup(T.ctx);
});

describe('leasing', () => {
  it('a host with no blocks asks for every series in use, and the cloud moves its own counter past them', async () => {
    T.hostDb().prepare('DELETE FROM sync_seq_blocks').run(); // as if freshly enrolled after the SO above
    const before = T.dbmod.withTenant('default', () => T.dbmod.getSetting<number>(KEY));
    await T.hostRound();
    expect(leases()).toEqual([{ host_node_no: T.hostNo, key: KEY, first: before! + 1, last: before! + 50 }]);
    // The cloud's next own number comes after the block.
    expect(T.dbmod.withTenant('default', () => T.dbmod.nextSequence(KEY, 'SO'))).toBe(`SO-${String(before! + 51).padStart(5, '0')}`);
  });

  it('only a site host is leased numbers', async () => {
    const lanToken = T.sync.remoteOf(T.lanDb())!.nodeToken;
    // The LAN PC's token is only known to its host, not the cloud — so try the host's own call path.
    const r = await T.ctx.api.post('/api/sync/sequence-blocks').set('X-Sync-Node-Token', lanToken).send({ keys: [KEY] });
    expect([401, 403]).toContain(r.status);
  });
});

describe('issuing offline', () => {
  it('the host issues real numbers from its block for its own work', () => {
    const block = leases()[0]!;
    const c = record();
    const n = inCtx(T.hostSlug, c, () => T.dbmod.nextSequence(KEY, 'SO'));
    expect(n).toBe(`SO-${String(block.first).padStart(5, '0')}`);
    expect(c.plan).toEqual([{ t: 'seq', key: KEY, value: n, provisional: false }]);
  });

  it('a LAN PC gets a provisional number; its host replaces it with a real one from the block', () => {
    const lan = record();
    const p = inCtx(T.lanSlug, lan, () => T.dbmod.nextSequence(KEY, 'SO'));
    expect(p).toMatch(new RegExp(`^SO-P${T.lanNo}-\\d{4}$`));
    const hostReplay: SyncContext = { mode: 'replay', plan: lan.plan, cursor: { id: 0, seq: 0 }, effective: [] };
    const real = inCtx(T.hostSlug, hostReplay, () => T.dbmod.nextSequence(KEY, 'SO'));
    expect(real).toMatch(/^SO-\d{5}$/);
    expect(hostReplay.effective).toEqual([{ t: 'seq', key: KEY, value: real, provisional: false }]);
  });

  it('the cloud keeps a number it leased to that host, and replaces one it never leased', () => {
    const block = leases()[0]!;
    const inside = `SO-${String(block.first + 5).padStart(5, '0')}`;
    const keep: SyncContext = {
      mode: 'replay', decidingSite: T.hostNo, cursor: { id: 0, seq: 0 },
      plan: [{ t: 'seq', key: KEY, value: inside, provisional: false }],
    };
    expect(inCtx('default', keep, () => T.dbmod.nextSequence(KEY, 'SO'))).toBe(inside);
    const forged: SyncContext = {
      mode: 'replay', decidingSite: T.hostNo, cursor: { id: 0, seq: 0 },
      plan: [{ t: 'seq', key: KEY, value: 'SO-99999', provisional: false }],
    };
    const issued = inCtx('default', forged, () => T.dbmod.nextSequence(KEY, 'SO'));
    expect(issued).not.toBe('SO-99999');
    expect(forged.planMisses).toBe(1);
  });

  it('runs out → provisional, and the next round refills the block', async () => {
    const block = leases()[0]!;
    T.hostDb().prepare('UPDATE sync_seq_blocks SET next = last + 1').run(); // used up
    const c = record();
    expect(inCtx(T.hostSlug, c, () => T.dbmod.nextSequence(KEY, 'SO'))).toMatch(new RegExp(`^SO-P${T.hostNo}-`));
    await T.hostRound();
    const all = leases();
    expect(all).toHaveLength(2);
    expect(all[1]!.first).toBeGreaterThan(block.last);
    const again = inCtx(T.hostSlug, record(), () => T.dbmod.nextSequence(KEY, 'SO'));
    expect(again).toBe(`SO-${String(all[1]!.first).padStart(5, '0')}`);
  });
});
