/**
 * Offline-first sync (docs/OFFLINE-FIRST.md; catalog entry `sync/`). Phase 1: the command
 * foundation. `installSync(app)` registers the hooks shared code calls; a tenant DB takes part
 * only after `enableSync()` gives it a role, so installing this changes nothing for any
 * existing tenant.
 */
import type { Express } from 'express';
import { syncHooks } from '../shared/sync-context';
import { wrapPrepared } from './ids';
import { syncedSequence } from './sequences';
import { replayUserOf, setReplayApp } from './replay';
import { acceptCommand, pullFor } from './authority';
import { applyConfirmed, lastAuthoritySeq, pendingCommands, type RebaseSummary } from './rebase';
import type { CommandResult } from './commands';
import { Router } from 'express';
import transportRoutes from './transport';
import statusRoutes from './status';
import siteRoutes from './sites';

/** Everything under /api/sync: the PC ↔ cloud transport and the status / inbox endpoints. */
export const syncRoutes = Router().use(transportRoutes).use(statusRoutes).use(siteRoutes);

export function installSync(app: Express): void {
  syncHooks.prepare = wrapPrepared;
  syncHooks.nextSequence = syncedSequence;
  syncHooks.replayUser = replayUserOf;
  setReplayApp(app);
}

/** `DEPLOY_MODE=cloud` (default: today's server) or `node` (an installed desktop copy). */
export const DEPLOY_MODE: 'cloud' | 'node' = process.env.DEPLOY_MODE === 'node' ? 'node' : 'cloud';

/**
 * One in-process sync round between a node DB and the cloud DB (both tenants of this process):
 * push the node's pending commands, pull effects + verdicts, rebase. Phase 3 replaces the
 * in-process calls with the node ↔ host ↔ cloud HTTP transport; the steps stay the same.
 */
export async function syncOnce(nodeSlug: string, cloudSlug: string, nodeNo: number): Promise<{
  pushed: CommandResult[];
  rebase: RebaseSummary;
}> {
  const pushed: CommandResult[] = [];
  for (const cmd of pendingCommands(nodeSlug)) pushed.push(await acceptCommand(cloudSlug, cmd));
  const pull = pullFor(cloudSlug, nodeNo, lastAuthoritySeq(nodeSlug));
  const rebase = await applyConfirmed(nodeSlug, pull);
  return { pushed, rebase };
}

export { syncClass, syncRequestMiddleware } from './capture';
export { replayTenantOf } from './replay';
export { enableSync, syncConfigOf, isAuthority, isNodeLocalTable, NODE_RANGE } from './node';
export { acceptCommand, pullFor, snapshotForNode, flushEffects } from './authority';
export { applyConfirmed, pendingCommands, lastAuthoritySeq, SyncDivergenceError } from './rebase';
export { SyncBlockedError } from './ids';
export { buildNodeSnapshot } from './transport';
export { deciderOf, mainHost, recordSiteClash, MAIN_HOST_SETTING, type Home } from './sites';
export {
  enrolNode, registerNode, downloadSnapshot, hostNodeNo, adoptSnapshot, syncWithCloud, startSyncLoop, remoteOf,
  linkStatusOf, SyncOfflineError,
} from './client';
export type { SyncClass, SyncCommand, CommandResult } from './commands';
