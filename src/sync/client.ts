/**
 * An installed PC's side of the sync transport (docs/OFFLINE-FIRST.md §12–13, §15): enrol,
 * start from a stripped snapshot, then sync over HTTP with its authority — push pending
 * commands, pull effects, rebase. `startSyncLoop` runs that in the background when
 * `DEPLOY_MODE=node`; losing the connection just means the next round waits.
 *
 * A PC's authority is the cloud, or — for a PC on a site's LAN (phase 3c) — its site host. A
 * site host is itself an ordinary PC towards the cloud; after each round with the cloud it also
 * refreshes the list of its LAN PCs, so it can let them in while the internet is down.
 */
import fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { getDb } from '../shared/db';
import { enableSync, syncConfigOf } from './node';
import { applyConfirmed, lastAuthoritySeq, pendingCommands, SyncDivergenceError, type RebaseSummary } from './rebase';
import type { CommandResult } from './commands';
import type { PullResult } from './authority';
import { blobPath, blobsOf, filePath, registerFile } from './files';
import { openForPc, sealForPc } from '../desktop/pc-secret';
import { seriesToRefill, storeBlocks } from './numberblocks';

export interface RemoteConfig {
  /** The authority this copy syncs with: the cloud, or its site host. */
  cloudUrl: string;
  nodeToken: string;
  /** Sent as X-Tenant (honoured only outside production — tests, local multi-tenant setups). */
  tenant: string | null;
}

/** The authority could not be reached (no internet, DNS, timeout) — not an error in itself. */
export class SyncOfflineError extends Error {}

/** How this PC's link last looked (for the status pill). In memory: after a restart it is
 *  unknown (`online: null`) until the first round. `upstream` is reported by a site host:
 *  whether it can reach the cloud. */
export interface LinkStatus {
  online: boolean | null;
  lastSyncAt: string | null;
  lastError: string | null;
  upstream?: { online: boolean | null; last_sync_at: string | null };
}
const links = new Map<string, LinkStatus>();

export function linkStatusOf(slug: string): LinkStatus {
  return links.get(slug) ?? { online: null, lastSyncAt: null, lastError: null };
}

export function remoteOf(conn: DatabaseSync): RemoteConfig | null {
  let r: { cloud_url: string; node_token: string; tenant: string | null } | undefined;
  try {
    r = conn.prepare('SELECT cloud_url, node_token, tenant FROM sync_remote WHERE k = 1').get() as typeof r;
  } catch {
    return null; // sync tables not created on this DB
  }
  // The token is sealed with the PC's DPAPI-held secret when the desktop app runs it (§19);
  // opening it without that secret fails loudly rather than looking "not enrolled".
  return r ? { cloudUrl: r.cloud_url, nodeToken: openForPc(r.node_token), tenant: r.tenant } : null;
}

const trimUrl = (u: string) => u.replace(/\/+$/, '');
const tenantHeader = (tenant?: string | null): Record<string, string> => (tenant ? { 'x-tenant': tenant } : {});

async function call(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 30_000) });
  } catch (e) {
    throw new SyncOfflineError(`Cannot reach ${new URL(url).host}: ${(e as Error).message}`);
  }
}

async function jsonOrThrow<T>(res: Response, what: string): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(`${what} failed (${res.status}): ${body.error ?? 'no details'}`);
  return body;
}

export interface Registration {
  nodeNo: number;
  nodeToken: string;
}

/** Register a PC with the cloud as an admin. `asHost` makes it its site's host; `hostNodeNo`
 *  makes it a LAN PC of that host. */
export async function registerNode(opts: {
  cloudUrl: string; username: string; password: string; name: string;
  asHost?: boolean; hostNodeNo?: number | null; cloudTenant?: string | null;
}): Promise<Registration> {
  const base = trimUrl(opts.cloudUrl);
  const t = tenantHeader(opts.cloudTenant);
  const login = await jsonOrThrow<{ token: string }>(
    await call(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...t },
      body: JSON.stringify({ username: opts.username, password: opts.password }),
    }), 'Sign-in');
  const node = await jsonOrThrow<{ node_no: number; node_token: string }>(
    await call(`${base}/api/sync/nodes`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${login.token}`, ...t },
      body: JSON.stringify({ name: opts.name, is_host: !!opts.asHost, host_node_no: opts.hostNodeNo ?? null }),
    }), 'Enrolment');
  return { nodeNo: node.node_no, nodeToken: node.node_token };
}

/** Which node a site host is (public `GET /api/sync/whoami` on the host). */
export async function hostNodeNo(hostUrl: string, tenant?: string | null): Promise<number> {
  const me = await jsonOrThrow<{ node_no: number; is_host: boolean }>(
    await call(`${trimUrl(hostUrl)}/api/sync/whoami`, { headers: tenantHeader(tenant) }), 'Finding the site host');
  if (!me.is_host) throw new Error(`${hostUrl} is not a site host.`);
  return me.node_no;
}

/** Download a starting copy from an authority into `file` (which must not exist yet). A site
 *  host only knows a new LAN PC after its next round with the cloud, so a 401 is retried until
 *  `waitMs` has passed. */
export async function downloadSnapshot(opts: {
  fromUrl: string; nodeToken: string; file: string; tenant?: string | null; waitMs?: number;
}): Promise<void> {
  if (fs.existsSync(opts.file)) throw new Error(`${opts.file} already exists — enrol into a fresh database file.`);
  const until = Date.now() + (opts.waitMs ?? 0);
  for (;;) {
    const snap = await call(`${trimUrl(opts.fromUrl)}/api/sync/snapshot`, {
      headers: { 'x-sync-node-token': opts.nodeToken, ...tenantHeader(opts.tenant) }, timeoutMs: 10 * 60_000,
    });
    if (snap.ok) {
      fs.writeFileSync(opts.file, Buffer.from(await snap.arrayBuffer()));
      return;
    }
    if (snap.status !== 401 || Date.now() >= until) throw new Error(`Downloading the workspace failed (${snap.status}).`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/**
 * Enrol this PC against the cloud directly (a single-PC site, or a site host): register,
 * download the workspace to `file`. Returns the identity to adopt the copy with.
 */
export async function enrolNode(opts: {
  cloudUrl: string; username: string; password: string; name: string; file: string; asHost?: boolean;
}): Promise<Registration> {
  if (fs.existsSync(opts.file)) throw new Error(`${opts.file} already exists — enrol into a fresh database file.`);
  const reg = await registerNode(opts);
  await downloadSnapshot({ fromUrl: opts.cloudUrl, nodeToken: reg.nodeToken, file: opts.file });
  return reg;
}

/** Make a downloaded snapshot this PC's working copy: node role (host or not) + the authority
 *  it syncs with and its credential there. */
export function adoptSnapshot(conn: DatabaseSync, id: {
  nodeNo: number; cloudUrl: string; nodeToken: string; isHost?: boolean; tenant?: string | null;
  /** A LAN PC: its site host's node number (decides which records it may decide offline). */
  hostNodeNo?: number | null;
}): void {
  enableSync(conn, { role: 'node', nodeNo: id.nodeNo, ...(id.isHost ? { isHost: true as const } : {}) });
  conn.prepare('UPDATE sync_node SET host_node_no = ? WHERE k = 1').run(id.hostNodeNo ?? null);
  conn.prepare(
    `INSERT INTO sync_remote (k, cloud_url, node_token, tenant) VALUES (1, ?, ?, ?)
     ON CONFLICT(k) DO UPDATE SET cloud_url = excluded.cloud_url, node_token = excluded.node_token, tenant = excluded.tenant`,
  ).run(trimUrl(id.cloudUrl), sealForPc(id.nodeToken), id.tenant ?? null);
}

export interface CloudRound {
  pushed: CommandResult[];
  rebase: RebaseSummary;
}

/** One sync round with this PC's authority over HTTP. Throws SyncOfflineError when unreachable. */
export async function syncWithCloud(slug: string): Promise<CloudRound> {
  const prev = linkStatusOf(slug);
  try {
    const { round, upstream } = await cloudRound(slug);
    links.set(slug, { online: true, lastSyncAt: new Date().toISOString(), lastError: null, ...(upstream ? { upstream } : {}) });
    return round;
  } catch (e) {
    links.set(slug, {
      online: e instanceof SyncOfflineError ? false : prev.online,
      lastSyncAt: prev.lastSyncAt,
      lastError: (e as Error).message,
      ...(prev.upstream ? { upstream: prev.upstream } : {}),
    });
    throw e;
  }
}

async function cloudRound(slug: string): Promise<{ round: CloudRound; upstream?: LinkStatus['upstream'] }> {
  const conn = getDb(slug);
  const cfg = syncConfigOf(conn);
  if (cfg?.role !== 'node') throw new Error(`"${slug}" is not an installed copy.`);
  const remote = remoteOf(conn);
  if (!remote) throw new Error(`"${slug}" has nothing to sync with (not enrolled).`);
  const headers = { 'content-type': 'application/json', 'x-sync-node-token': remote.nodeToken, ...tenantHeader(remote.tenant) };

  const pushed: CommandResult[] = [];
  const pending = pendingCommands(slug);
  await pushBlobs(conn, slug, remote, blobsOf(pending)); // a command's uploads go before it
  for (let i = 0; i < pending.length; i += 100) {
    const r = await jsonOrThrow<{ results: CommandResult[] }>(
      await call(`${remote.cloudUrl}/api/sync/commands`, {
        method: 'POST', headers, body: JSON.stringify({ commands: pending.slice(i, i + 100) }), timeoutMs: 5 * 60_000,
      }), 'Sending changes');
    pushed.push(...r.results);
  }

  // Unattributed commands carry no node number: ask for their verdicts by id.
  const anonIds = pending.filter((c) => c.unattributed === 1).map((c) => c.id);
  const q = `since=${lastAuthoritySeq(slug)}${anonIds.length ? `&ids=${anonIds.join(',')}` : ''}`;
  const raw = await jsonOrThrow<{
    upTo: number; results: PullResult['results']; upstream?: LinkStatus['upstream'];
    effects: Array<{ authority_seq: number; command_id: string | null; changeset: string }>;
  }>(await call(`${remote.cloudUrl}/api/sync/pull?${q}`, { headers, timeoutMs: 5 * 60_000 }), 'Receiving changes');
  const pull: PullResult = {
    upTo: raw.upTo,
    results: raw.results,
    effects: raw.effects.map((e) => ({ ...e, changeset: new Uint8Array(Buffer.from(e.changeset, 'base64')) })),
  };
  const rebase = await applyConfirmed(slug, pull);

  // Uploaded files made elsewhere (on the cloud, other PCs) — fetch the ones this copy lacks.
  await pullFiles(conn, slug, remote, cfg.isHost === true);
  // A site host keeps its list of LAN PCs current, to let them in while the cloud is away.
  if (cfg.isHost) {
    await refreshMembers(conn, remote, headers);
    await refillNumberBlocks(conn, remote, headers);
  }
  return { round: { pushed, rebase }, upstream: raw.upstream };
}

async function pushBlobs(conn: DatabaseSync, slug: string, remote: RemoteConfig, hashes: string[]): Promise<void> {
  const sent = conn.prepare('SELECT 1 FROM sync_blobs WHERE hash = ? AND pushed_at IS NOT NULL');
  const mark = conn.prepare(
    `INSERT INTO sync_blobs (hash, size, pushed_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(hash) DO UPDATE SET pushed_at = excluded.pushed_at`,
  );
  for (const hash of hashes) {
    if (sent.get(hash)) continue;
    const bytes = fs.readFileSync(blobPath(slug, hash));
    await jsonOrThrow(await call(`${remote.cloudUrl}/api/sync/blobs/${hash}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream', 'x-sync-node-token': remote.nodeToken, ...tenantHeader(remote.tenant) },
      body: bytes, timeoutMs: 5 * 60_000,
    }), 'Sending a file');
    mark.run(hash, bytes.length);
  }
}

async function pullFiles(conn: DatabaseSync, slug: string, remote: RemoteConfig, isHost: boolean): Promise<void> {
  const headers = { 'x-sync-node-token': remote.nodeToken, ...tenantHeader(remote.tenant) };
  for (;;) {
    const since = (conn.prepare('SELECT last_file_seq AS s FROM sync_node WHERE k = 1').get() as { s: number }).s;
    const list = await jsonOrThrow<Array<{ seq: number; name: string; size: number }>>(
      await call(`${remote.cloudUrl}/api/sync/files?since=${since}`, { headers }), 'Listing files');
    if (!list.length) return;
    for (const f of list) {
      const target = filePath(slug, f.name);
      if (target && !fs.existsSync(target)) {
        const res = await call(`${remote.cloudUrl}/api/sync/files/${f.seq}`, { headers, timeoutMs: 5 * 60_000 });
        if (res.ok) {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, Buffer.from(await res.arrayBuffer()));
        } // a file deleted on the authority meanwhile is simply skipped
      }
      if (isHost && target && fs.existsSync(target)) registerFile(conn, f.name, f.size); // pass it on to the LAN
      conn.prepare('UPDATE sync_node SET last_file_seq = ? WHERE k = 1').run(f.seq);
    }
  }
}

/** A site host keeps a block of real document numbers for each series it uses (§21); the first
 *  time, it asks for every series the cloud has in use. */
async function refillNumberBlocks(conn: DatabaseSync, remote: RemoteConfig, headers: Record<string, string>): Promise<void> {
  const hasAny = conn.prepare('SELECT 1 FROM sync_seq_blocks LIMIT 1').get();
  const keys = hasAny ? seriesToRefill(conn) : ['*', ...seriesToRefill(conn)];
  if (!keys.length) return;
  const blocks = await jsonOrThrow<Array<{ key: string; first: number; last: number }>>(
    await call(`${remote.cloudUrl}/api/sync/sequence-blocks`, { method: 'POST', headers, body: JSON.stringify({ keys }) }),
    'Reserving document numbers');
  storeBlocks(conn, blocks);
}

async function refreshMembers(conn: DatabaseSync, remote: RemoteConfig, headers: Record<string, string>): Promise<void> {
  const members = await jsonOrThrow<Array<{ node_no: number; name: string; token_hash: string; revoked_at: string | null }>>(
    await call(`${remote.cloudUrl}/api/sync/members`, { headers }), 'Listing the site\'s PCs');
  const upsert = conn.prepare(
    `INSERT INTO sync_nodes (node_no, name, token_hash, revoked_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(node_no) DO UPDATE SET name = excluded.name, token_hash = excluded.token_hash, revoked_at = excluded.revoked_at`,
  );
  for (const m of members) upsert.run(m.node_no, m.name, m.token_hash, m.revoked_at);
}

/**
 * Background sync for an installed PC. Rounds never overlap; being offline is logged once per
 * change of state, not every round. A divergence stops the loop — the copy must be re-enrolled.
 */
export function startSyncLoop(slug: string, intervalMs = Number(process.env.SYNC_INTERVAL_MS) || 15_000): () => void {
  let running = false;
  let online: boolean | null = null;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await syncWithCloud(slug);
      if (online !== true) console.log('[sync] connected');
      online = true;
      if (r.pushed.length || r.rebase.applied) {
        console.log(`[sync] sent ${r.pushed.length}, received ${r.rebase.applied} change batch(es)`);
      }
    } catch (e) {
      if (e instanceof SyncOfflineError) {
        if (online !== false) console.log('[sync] offline — working locally; will retry');
        online = false;
      } else if (e instanceof SyncDivergenceError) {
        console.error(`[sync] ${e.message} Sync stopped.`);
        clearInterval(timer);
      } else {
        console.error('[sync] round failed:', (e as Error).message);
      }
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
