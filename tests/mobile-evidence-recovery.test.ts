import { describe, it, expect } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';

function boot(factory: IDBFactory, mode: 'release' | 'delivery', api: any, photo: any, user = 7) {
  const context: any = { indexedDB: factory, crypto, Blob, navigator: { onLine: true }, RoleUI: {},
    MApp: { getMe: () => ({ id: user }) }, API: { base: () => '/tenant-a', syncLocal: (r: any) => r.local || null, ...api }, mPhoto: { attachBlob: photo } };
  context.window = context;
  for (const file of ['lib/production-drafts.js', 'modules/inventory/' + (mode === 'release' ? 'release-handoff' : 'delivery-recovery') + '.js']) {
    vm.runInNewContext(fs.readFileSync(new URL('../public/mobile/' + file, import.meta.url), 'utf8'), context);
  }
  return { flow: mode === 'release' ? context.mReleaseHandoff : context.mDeliveryRecovery, store: context.mProductionDrafts };
}
for (const mode of ['release', 'delivery'] as const) {
  describe(mode + ' evidence recovery', () => {
    const record = { id: 31, number: 'DOC-31', order: { id: 31, number: 'SO-31' } };
    const draft = () => ({ pkg: {}, photos: [new Blob(['photo-original'])], sign: new Blob(['signature-original']), geo: { lat: 14, lng: 121 } });
    async function start(flow: any, payload: any = { recipient: 'Original' }) {
      if (mode === 'release') await flow.start(record, draft(), payload);
      else { const s = await flow.draft(record); s.batch = draft(); await flow.start(record,s,'complete',payload); }
    }
    it('retains original bytes and JSON across a lost final response and restart', async () => {
      const factory = new IDBFactory(), posts: any[] = [], uploads: any[] = [];
      let lose = true;
      const api = { post: async (path: string, payload: any, opts: any) => { posts.push({ path, body: JSON.stringify(payload), key: opts.idempotencyKey }); if (lose) { lose = false; throw new Error('response lost'); } return { id: 82 }; } };
      const photo = async (...args: any[]) => { uploads.push(args); return { id: uploads.length }; };
      await start(boot(factory,mode,api,photo).flow);
      const { flow } = boot(factory,mode,api,photo), s = await flow.load(31);
      expect(s.operation.state).toBe('unknown');
      expect(await s.rows[0].file.text()).toBe('photo-original');
      expect(await s.rows[1].file.text()).toBe('signature-original');
      expect(await boot(factory,mode,api,photo,8).flow.load(31)).toBeNull();
      await flow.send(s);
      expect(uploads).toHaveLength(2); expect(posts).toHaveLength(2); expect(posts[0]).toEqual(posts[1]);
      expect(s.operation.state).toBe('confirmed');
    });
    it('blocks final transition until the signature upload succeeds; reuses its key after restart', async () => {
      const factory = new IDBFactory(), posts: any[] = [], keys: string[] = [];
      let lose = true;
      const api = { post: async (...args: any[]) => { posts.push(args); return { id: 82 }; } };
      const photo = async (...args: any[]) => { keys.push(args[5].idempotencyKey); if (args[3].endsWith('.png') && lose) { lose = false; throw new Error('upload response lost'); } return { id: keys.length }; };
      await start(boot(factory,mode,api,photo).flow);
      expect(posts).toHaveLength(0);
      const { flow } = boot(factory,mode,api,photo), s = await flow.load(31);
      await flow.send(s);
      expect(posts).toHaveLength(1); expect(keys).toHaveLength(3); expect(keys[1]).toBe(keys[2]);
    });
    it('keeps a site-PC response pending and refuses a replacement request', async () => {
      const factory = new IDBFactory(); let calls = 0;
      const api = { post: async () => { calls++; return { id: 82, local: 'command-1' }; } };
      const photo = async () => ({ id: 9 });
      const { flow } = boot(factory,mode,api,photo);
      await start(flow);
      const s = await flow.load(31); expect(s.operation.local).toBe('command-1');
      await flow.send(s); expect(calls).toBe(1);
      await expect(start(flow,{ recipient: 'Changed' })).rejects.toThrow(/original|Recover/);
    });
    it('refuses to post when device persistence is unavailable', async () => {
      let posts = 0;
      const { flow } = boot(undefined as any, mode, { post: async () => { posts++; } }, async () => ({ id: 1 }));
      await expect(start(flow)).rejects.toThrow('Draft storage is unavailable'); expect(posts).toBe(0);
    });
  });
}
