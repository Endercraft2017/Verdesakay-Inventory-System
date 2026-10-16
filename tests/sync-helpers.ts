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
      // A real installed PC runs as the `default` workspace (every module); match that here.
      provisioning.importTenant({ slug: nodeSlug, name: nodeSlug, sourceFile: file, plan: 'unlimited' });
      sync.enableSync(dbmod.getDb(nodeSlug), { role: 'node', nodeNo });
      const r = await ctx.api.post('/api/auth/login').set('X-Tenant', nodeSlug).send({ username: 'admin', password: 'admin123-test-only' });
      if (r.status !== 200) throw new Error(`node login failed: ${r.status}`);
      nodeToken = r.body.token as string;
    },
  };
  return pair;
}

export interface SiteTrio {
  ctx: TestContext;
  sync: typeof import('../src/sync');
  dbmod: typeof import('../src/shared/db');
  url: string;
  server: import('node:http').Server;
  hostSlug: string;
  lanSlug: string;
  hostNo: number;
  lanNo: number;
  cloudHdr: () => Record<string, string>;
  hostHdr: () => Record<string, string>;
  lanHdr: () => Record<string, string>;
  cloudDb: () => DatabaseSync;
  hostDb: () => DatabaseSync;
  lanDb: () => DatabaseSync;
  hostRound: () => ReturnType<typeof import('../src/sync')['syncWithCloud']>;
  lanRound: () => ReturnType<typeof import('../src/sync')['syncWithCloud']>;
  /** Point the host (or the LAN PC) at nothing, as if its link were down; and back. */
  cutOff: (who: 'host' | 'lan') => void;
  reconnect: (who: 'host' | 'lan') => void;
  close: () => void;
}

/**
 * A site over one real HTTP server: `default` = the cloud, a site host and one LAN PC enrolled
 * through it (docs/OFFLINE-FIRST.md §15). Call `seed` to create cloud data before the copies
 * are taken.
 */
export async function setupSiteTrio(seed?: (t: { api: TestContext['api']; cloudHdr: () => Record<string, string> }) => Promise<void>): Promise<SiteTrio> {
  const http = await import('node:http');
  const ctx = await setupApp();
  const sync = await import('../src/sync');
  const dbmod = await import('../src/shared/db');
  const provisioning = await import('../src/platform/provisioning');
  const cloudToken = await login(ctx.api);
  const cloudHdr = () => ({ Authorization: `Bearer ${cloudToken}` });
  if (seed) await seed({ api: ctx.api, cloudHdr });
  const server = http.createServer(ctx.app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  const hostSlug = 'trio-host';
  const lanSlug = 'trio-lan';
  const signIn = async (tenant: string) => {
    const r = await ctx.api.post('/api/auth/login').set('X-Tenant', tenant).send({ username: 'admin', password: 'admin123-test-only' });
    if (r.status !== 200) throw new Error(`login on ${tenant} failed: ${r.status}`);
    return r.body.token as string;
  };

  const host = await sync.registerNode({ cloudUrl: url, username: 'admin', password: 'admin123-test-only', name: 'Trio host', asHost: true });
  const hostFile = path.join(ctx.tmpDir, `${hostSlug}.db`);
  await sync.downloadSnapshot({ fromUrl: url, nodeToken: host.nodeToken, file: hostFile });
  provisioning.importTenant({ slug: hostSlug, name: hostSlug, sourceFile: hostFile, plan: 'unlimited' }); // every module, like a real PC
  sync.adoptSnapshot(dbmod.getDb(hostSlug), { ...host, cloudUrl: url, isHost: true });

  const lan = await sync.registerNode({ cloudUrl: url, username: 'admin', password: 'admin123-test-only', name: 'Trio desk', hostNodeNo: host.nodeNo });
  await sync.syncWithCloud(hostSlug); // the host learns about its LAN PC
  const lanFile = path.join(ctx.tmpDir, `${lanSlug}.db`);
  await sync.downloadSnapshot({ fromUrl: url, tenant: hostSlug, nodeToken: lan.nodeToken, file: lanFile });
  provisioning.importTenant({ slug: lanSlug, name: lanSlug, sourceFile: lanFile, plan: 'unlimited' });
  sync.adoptSnapshot(dbmod.getDb(lanSlug), { ...lan, cloudUrl: url, tenant: hostSlug, hostNodeNo: host.nodeNo });

  const hostToken = await signIn(hostSlug);
  const lanToken = await signIn(lanSlug);
  const remoteUrl = { host: url, lan: url };
  const dbOf = (who: 'host' | 'lan') => dbmod.getDb(who === 'host' ? hostSlug : lanSlug);
  return {
    ctx, sync, dbmod, url, server, hostSlug, lanSlug, hostNo: host.nodeNo, lanNo: lan.nodeNo,
    cloudHdr,
    hostHdr: () => ({ Authorization: `Bearer ${hostToken}`, 'X-Tenant': hostSlug }),
    lanHdr: () => ({ Authorization: `Bearer ${lanToken}`, 'X-Tenant': lanSlug }),
    cloudDb: () => dbmod.getDb('default'),
    hostDb: () => dbmod.getDb(hostSlug),
    lanDb: () => dbmod.getDb(lanSlug),
    hostRound: () => sync.syncWithCloud(hostSlug),
    lanRound: () => sync.syncWithCloud(lanSlug),
    cutOff: (who) => { dbOf(who).prepare('UPDATE sync_remote SET cloud_url = ?').run('http://127.0.0.1:1'); },
    reconnect: (who) => { dbOf(who).prepare('UPDATE sync_remote SET cloud_url = ?').run(remoteUrl[who]); },
    close: () => { server.close(); },
  };
}
