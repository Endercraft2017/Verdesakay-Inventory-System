import { describe, it, expect } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import fs from 'node:fs';
import vm from 'node:vm';

const code = fs.readFileSync(new URL('../public/mobile/lib/production-drafts.js', import.meta.url), 'utf8');
function boot(factory: IDBFactory, user = 7, server = '/tenant-a') {
  const context: any = { indexedDB: factory, MApp: { getMe: () => ({ id: user }) }, API: { base: () => server } };
  context.window = context;
  vm.runInNewContext(code, context);
  return context.mProductionDrafts;
}
describe('production draft persistence', () => {
  it('restores photo bytes, request identity and an uncertain upload after restart', async () => {
    const factory = new IDBFactory(), first = boot(factory);
    const photo = new Blob(['original-photo-bytes'], { type: 'image/jpeg' });
    const draft = { key: first.key(184), batch: 'LOT-A', rows: [{ identifier: 'Same serial', file: photo, saved: false,
      attempt: { key: 'original-unit-request', identifier: 'Same serial', batch: 'LOT-A', file: photo, state: 'sending', created: Date.now() } }] };
    await first.save(draft);
    const restored = await boot(factory).load(184);
    expect(restored.rows[0].attempt.state).toBe('unknown');
    expect(restored.rows[0].attempt.key).toBe('original-unit-request');
    expect(restored.rows[0].attempt.batch).toBe('LOT-A');
    expect(await restored.rows[0].file.text()).toBe('original-photo-bytes');
    expect(await restored.rows[0].attempt.file.text()).toBe('original-photo-bytes');
  });
  it('keeps another account or server from seeing a draft and removes completed drafts', async () => {
    const factory = new IDBFactory(), first = boot(factory);
    const draft = { key: first.key(184), batch: '', rows: [{ identifier: 'A', file: null, saved: true, unitId: 91, local: 'sync-1' }] };
    await first.save(draft);
    expect(await boot(factory, 8).load(184)).toBeNull();
    expect(await boot(factory, 7, '/tenant-b').load(184)).toBeNull();
    expect((await boot(factory).load(184)).rows[0]).toMatchObject({ saved: true, unitId: 91, local: 'sync-1' });
    await first.remove(draft);
    expect(await boot(factory).load(184)).toBeNull();
  });
  it('serializes fast edits without losing the latest input', async () => {
    const factory = new IDBFactory(), store = boot(factory);
    const draft = { key: store.key(184), batch: '', rows: [{ identifier: 'first', file: null, saved: false }] };
    const a = store.save(draft);
    draft.rows[0]!.identifier = 'latest';
    const b = store.save(draft);
    await Promise.all([a, b]);
    expect((await store.load(184)).rows[0].identifier).toBe('latest');
  });
  it('blocks stale tabs from overwriting or deleting a newer attempt', async () => {
    const factory = new IDBFactory(), first = boot(factory), other = boot(factory);
    const draft = { key: first.key(184), batch: '', rows: [{ identifier: 'first', file: null, saved: false }] };
    await first.save(draft);
    const stale = await other.load(184);
    draft.rows[0]!.identifier = 'newer';
    await first.save(draft);
    await expect(other.save(stale)).rejects.toThrow('changed in another tab');
    await expect(other.remove(stale)).rejects.toThrow('changed in another tab');
    expect((await first.load(184)).rows[0].identifier).toBe('newer');
  });
  it('refuses persistence when device storage is unavailable', async () => {
    const store = boot(undefined as unknown as IDBFactory);
    await expect(store.save({ key: store.key(184), batch: '', rows: [] })).rejects.toThrow('Draft storage is unavailable');
  });
  it('discovers saved approvals independently of the server queue without exposing other accounts or tenants', async () => {
    const factory = new IDBFactory(), store = boot(factory);
    await store.save({ key: store.key('184:action'), rows: [], operation: { kind: 'approve', state: 'sending', payload: { notes: 'Original' } } });
    await store.save({ key: store.key('185:action'), rows: [], operation: { kind: 'output', state: 'unknown' } });
    await store.save({ key: store.key('kit:186'), rows: [], operation: { kind: 'release', state: 'unknown' } });
    await store.save({ key: store.key('hold:503:action'), rows: [], operation: { kind: 'hold-decision', state: 'unknown' } });
    const held = await store.listActions('hold-decision', 'hold');
    expect(held).toHaveLength(1); expect(held[0].id).toBe(503);
    expect(await boot(factory, 8).listActions('hold-decision', 'hold')).toEqual([]);
    const approvals = await boot(factory).listActions('approve');
    expect(approvals).toHaveLength(1); expect(approvals[0].jobId).toBe(184);
    expect(approvals[0].record.operation.state).toBe('unknown');
    expect(await store.approvalCount([{ id: 184 }, { id: 187 }])).toBe(2);
    expect(await boot(factory, 8).listActions('approve')).toEqual([]);
    expect(await boot(factory, 7, '/tenant-b').listActions('approve')).toEqual([]);
  });
  it('discovers independent issue drafts on the same unit within the owning account and server', async () => {
    const factory = new IDBFactory(), store = boot(factory);
    for (const draftId of ['draft-chassis', 'draft-fairings']) {
      await store.save({ key: store.key('issue:501:' + draftId + ':action'), rows: [{ identifier: draftId, file: new Blob([draftId]), saved: false }], operation: { kind: 'unit-issue', draftId, state: 'draft' } });
    }
    const saved = await boot(factory).listActions('unit-issue', 'issue');
    expect(saved).toHaveLength(2); expect(saved.map((a: any) => a.id)).toEqual([501, 501]);
    expect(await saved[0].record.rows[0].file.text()).toBe(saved[0].record.operation.draftId);
    expect(await boot(factory, 8).listActions('unit-issue', 'issue')).toEqual([]);
    expect(await boot(factory, 7, '/tenant-b').listActions('unit-issue', 'issue')).toEqual([]);
  });
  it('retains an immutable JSON action across restart independently of unit-photo drafts', async () => {
    const factory = new IDBFactory(), store = boot(factory);
    const payload = { done_delta: 3, scrapped_delta: 1, batch_label: 'LOT-ORIGINAL' };
    const record = { key: store.key('184:action'), rows: [], operation: { kind: 'output', key: 'stable-progress-key', state: 'sending', payload } };
    await store.save(record);
    payload.done_delta = 99;
    const restarted = boot(factory);
    expect(await restarted.load(184)).toBeNull();
    const restored = await restarted.loadAction(184);
    expect(restored.operation.state).toBe('unknown');
    expect(restored.operation.payload.done_delta).toBe(3);
    expect(restored.operation.key).toBe('stable-progress-key');
    expect(await boot(factory, 8).loadAction(184)).toBeNull();
  });
});
