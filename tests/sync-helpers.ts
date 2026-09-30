/**
 * A cloud + installed-node pair for offline-sync tests (docs/OFFLINE-FIRST.md). The `default`
 * tenant plays the cloud (node 0); a snapshot of it imported as another tenant plays an
 * installed PC. `round()` is one in-process sync (push commands, pull effects, rebase).
 */
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { setupApp, login, type TestContext } from './helpers';

export interface SyncPair {
  ctx: TestContext;
  sync: typeof import('../src/sync');
  dbmod: typeof import('../src/shared/db');
  nodeSlug: string;
  nodeNo: number;
  cloudHdr: () => Record<string, string>;
  nodeHdr: () => Record<string, string>;
  cloudDb: () => DatabaseSync;
  nodeDb: () => DatabaseSync;
  round: () => ReturnType<typeof import('../src/sync')['syncOnce']>;
  /** Snapshot the cloud now and enrol it as the node (call after seeding cloud data). */
  enrol: () => Promise<void>;
}

export async function setupSyncPair(nodeSlug = 'plant-b', nodeNo = 9): Promise<SyncPair> {
  const ctx = await setupApp();
  const sync = await import('../src/sync');
  const dbmod = await import('../src/shared/db');
  const cloudToken = await login(ctx.api);
  let nodeToken = '';
  sync.enableSync(dbmod.getDb('default'), { role: 'cloud', nodeNo: 0 });
  const pair: SyncPair = {
    ctx, sync, dbmod, nodeSlug, nodeNo,
    cloudHdr: () => ({ Authorization: `Bearer ${cloudToken}` }),
    nodeHdr: () => ({ Authorization: `Bearer ${nodeToken}`, 'X-Tenant': nodeSlug }),
    cloudDb: () => dbmod.getDb('default'),
    nodeDb: () => dbmod.getDb(nodeSlug),
    round: () => sync.syncOnce(nodeSlug, 'default', nodeNo),
    enrol: async () => {
      const provisioning = await import('../src/platform/provisioning');
      const file = path.join(ctx.tmpDir, `enrol-${nodeSlug}.db`);
      sync.snapshotForNode('default', file);
      provisioning.importTenant({ slug: nodeSlug, name: nodeSlug, sourceFile: file });
      sync.enableSync(dbmod.getDb(nodeSlug), { role: 'node', nodeNo });
      const r = await ctx.api.post('/api/auth/login').set('X-Tenant', nodeSlug).send({ username: 'admin', password: 'admin123' });
      if (r.status !== 200) throw new Error(`node login failed: ${r.status}`);
      nodeToken = r.body.token as string;
    },
  };
  return pair;
}
