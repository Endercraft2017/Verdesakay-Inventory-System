import { describe, it, expect } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
const draftCode = fs.readFileSync(new URL('../public/mobile/lib/production-drafts.js', import.meta.url), 'utf8');
const recoveryCode = fs.readFileSync(new URL('../public/mobile/modules/manufacturing/rts-recovery.js', import.meta.url), 'utf8');
function boot(factory = new IDBFactory(), post: any = async () => ({ id: 1, number: 'PI-00001' }), user = 31, server = '/tenant-a') {
  const context: any = { indexedDB: factory, crypto: { randomUUID }, Date, RoleUI: {}, MApp: { getMe: () => ({ id: user }) }, API: { base: () => server, post, syncLocal: (r: any) => r.local || null } };
  context.window = context; vm.runInNewContext(draftCode, context); vm.runInNewContext(recoveryCode, context);
  return { store: context.mProductionDrafts, recovery: context.mRtsRecovery, context };
}
const entry = (jo = 184, unit = 601) => ({ jobId: jo, path: '/job-orders/' + jo + '/products-in', payload: { location_id: 2, unit_ids: [unit] }, labels: ['K4-' + unit] });
describe('durable RTS receipts', () => {
  it('replays the exact batch quantity, location and notes after a committed response is lost', async () => {
    const factory = new IDBFactory(), requests: any[] = [], applied = new Map(); let lost = true;
    const post = async (path: string, payload: any, opts: any) => {
      requests.push({ path, payload: structuredClone(payload), key: opts.idempotencyKey });
      if (!applied.has(opts.idempotencyKey)) applied.set(opts.idempotencyKey, { id: 17, number: 'PI-00017' });
      if (lost) { lost = false; throw new Error('Response lost'); } return applied.get(opts.idempotencyKey);
    };
    const first = boot(factory, post), payload = { location_id: 2, batch_id: 81, quantity: 2, notes: 'Original physical count' };
    const { record } = await first.recovery.begin('rts-batch:81', [{ ...entry(), payload }], 'FG-A03');
    await first.recovery.send(record); expect(record.operation.entries[0].state).toBe('unknown'); payload.quantity = 9;
    const restarted = boot(factory, post), saved = await restarted.recovery.saved();
    expect(saved).toHaveLength(1); expect(saved[0].operation.entries[0].payload.quantity).toBe(2);
    await restarted.recovery.send(saved[0]); expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]); expect(applied.size).toBe(1); expect(restarted.recovery.complete(saved[0])).toBe(true);
    expect(await boot(factory, post, 32).recovery.saved()).toEqual([]); expect(await boot(factory, post, 31, '/tenant-b').recovery.saved()).toEqual([]);
  });
  it('skips confirmed job orders, stops on unknown and retains not-started entries', async () => {
    const factory = new IDBFactory(), calls: any[] = []; let lose = true;
    const post = async (path: string, payload: any, opts: any) => { calls.push({ path, payload, key: opts.idempotencyKey }); if (path.includes('/185/') && lose) { lose = false; throw new Error('Connection lost'); } return { id: calls.length, number: 'PI-' + path }; };
    const first = boot(factory, post), { record } = await first.recovery.begin('rts-unit:601', [entry(), entry(185, 602), entry(186, 603)], 'FG-A03');
    await first.recovery.send(record); expect(record.operation.entries.map((a: any) => a.state)).toEqual(['confirmed','unknown','new']);
    const restarted = boot(factory, post), [saved] = await restarted.recovery.saved();
    expect(await restarted.recovery.count({ units: [], batches: [] })).toBe(2);
    await restarted.recovery.send(saved); expect(calls.map(a => a.path)).toEqual(['/job-orders/184/products-in','/job-orders/185/products-in','/job-orders/185/products-in','/job-orders/186/products-in']); expect(calls[1].key).toBe(calls[2].key); expect(restarted.recovery.complete(saved)).toBe(true);
  });
  it('keeps local command acknowledgements pending and does not start the next job order', async () => {
    const calls: string[] = [], { recovery } = boot(undefined, async (path: string) => { calls.push(path); return { id: 1, number: 'PI-PC', local: 'command-1' }; });
    const { record } = await recovery.begin('rts-unit:601', [entry(), entry(185, 602)], 'FG-A03'); await recovery.send(record); await recovery.send(record);
    expect(calls).toHaveLength(1); expect(recovery.complete(record)).toBe(false); expect(record.operation.entries[1].state).toBe('new');
  });
  it('retains refusals and expired keys for review instead of silently reposting', async () => {
    let calls = 0; const { recovery, store } = boot(undefined, async () => { calls++; throw Object.assign(new Error('Location full'), { status: 400 }); });
    const { record } = await recovery.begin('rts-unit:601', [entry()], 'FG-A03'); await recovery.send(record); await recovery.send(record); expect(calls).toBe(1); expect(record.operation.entries[0].state).toBe('rejected');
    record.operation.entries[0].state = 'unknown'; record.operation.entries[0].created = Date.now() - 8 * 86400000; await store.save(record); await recovery.send(record); expect(calls).toBe(1); expect(record.operation.entries[0].state).toBe('conflict');
  });
  it('redirects overlapping selections and refuses unavailable storage before posting', async () => {
    const { recovery } = boot(); const { record } = await recovery.begin('rts-unit:601', [entry()], 'FG-A03');
    const overlap = await recovery.begin('rts-unit:602', [entry(184, 602), entry()], 'Different location'); expect(overlap.existing).toBe(true); expect(overlap.record.key).toBe(record.key);
    const broken = boot(undefined); broken.context.indexedDB = undefined;
    await expect(broken.recovery.begin('rts-batch:81', [{ ...entry(), payload: { location_id: 2, batch_id: 81, quantity: 2 } }], 'FG-A03')).rejects.toThrow('Draft storage is unavailable');
  });
  it('prevents two tabs from creating separate requests for the same bulk batch', async () => {
    const factory = new IDBFactory(), a = boot(factory), b = boot(factory), entries = [{ ...entry(), payload: { location_id: 2, batch_id: 81, quantity: 2 } }];
    const results = await Promise.allSettled([a.recovery.begin('rts-batch:81', entries, 'FG-A03'), b.recovery.begin('rts-batch:81', entries, 'FG-A03')]);
    const saved = await a.recovery.saved(); expect(saved).toHaveLength(1);
    // A later read can discover the winner; simultaneous writes reject stale revision zero.
    expect(results.filter(r => r.status === 'fulfilled' && !r.value.existing)).toHaveLength(1);
  });
});
