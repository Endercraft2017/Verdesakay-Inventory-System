/**
 * An installed PC's side of the sync transport (docs/OFFLINE-FIRST.md §12, phase 3a):
 * enrol against the cloud, start from its stripped snapshot, then sync over HTTP —
 * push pending commands, pull confirmed effects, rebase. `startSyncLoop` runs that in the
 * background when `DEPLOY_MODE=node`; losing the connection just means the next round waits.
 */
import fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { getDb } from '../shared/db';
import { enableSync, syncConfigOf } from './node';
import { applyConfirmed, lastAuthoritySeq, pendingCommands, SyncDivergenceError, type RebaseSummary } from './rebase';
import type { CommandResult } from './commands';
import type { PullResult } from './authority';

export interface RemoteConfig {
  cloudUrl: string;
  nodeToken: string;
}

/** The cloud could not be reached (no internet, DNS, timeout) — not an error in itself. */
export class SyncOfflineError extends Error {}

export function remoteOf(conn: DatabaseSync): RemoteConfig | null {
  try {
    const r = conn.prepare('SELECT cloud_url, node_token FROM sync_remote WHERE k = 1').get() as
      { cloud_url: string; node_token: string } | undefined;
    return r ? { cloudUrl: r.cloud_url, nodeToken: r.node_token } : null;
  } catch {
    return null; // sync tables not created on this DB
  }
}

const trimUrl = (u: string) => u.replace(/\/+$/, '');

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

/**
 * Enrol this PC: sign in to the cloud as an admin, register the PC, and download the workspace
 * to `file` (which must not exist yet). Returns the node identity to adopt the copy with.
 */
export async function enrolNode(opts: {
  cloudUrl: string; username: string; password: string; name: string; file: string;
}): Promise<{ nodeNo: number; nodeToken: string }> {
  if (fs.existsSync(opts.file)) throw new Error(`${opts.file} already exists — enrol into a fresh database file.`);
  const base = trimUrl(opts.cloudUrl);
  const login = await jsonOrThrow<{ token: string }>(
    await call(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: opts.username, password: opts.password }),
    }), 'Sign-in');
  const node = await jsonOrThrow<{ node_no: number; node_token: string }>(
    await call(`${base}/api/sync/nodes`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${login.token}` },
      body: JSON.stringify({ name: opts.name }),
    }), 'Enrolment');
  const snap = await call(`${base}/api/sync/snapshot`, {
    headers: { 'x-sync-node-token': node.node_token }, timeoutMs: 10 * 60_000,
  });
  if (!snap.ok) throw new Error(`Downloading the workspace failed (${snap.status}).`);
  fs.writeFileSync(opts.file, Buffer.from(await snap.arrayBuffer()));
  return { nodeNo: node.node_no, nodeToken: node.node_token };
}

/** Make a downloaded snapshot this PC's working copy: node role + where/how it syncs. */
export function adoptSnapshot(conn: DatabaseSync, id: { nodeNo: number; cloudUrl: string; nodeToken: string }): void {
  enableSync(conn, { role: 'node', nodeNo: id.nodeNo });
  conn.prepare('INSERT INTO sync_remote (k, cloud_url, node_token) VALUES (1, ?, ?) ON CONFLICT(k) DO UPDATE SET cloud_url = excluded.cloud_url, node_token = excluded.node_token')
    .run(trimUrl(id.cloudUrl), id.nodeToken);
}

export interface CloudRound {
  pushed: CommandResult[];
  rebase: RebaseSummary;
}

/** One sync round with the cloud over HTTP. Throws SyncOfflineError when unreachable. */
export async function syncWithCloud(slug: string): Promise<CloudRound> {
  const conn = getDb(slug);
  if (syncConfigOf(conn)?.role !== 'node') throw new Error(`"${slug}" is not an installed copy.`);
  const remote = remoteOf(conn);
  if (!remote) throw new Error(`"${slug}" has no cloud to sync with (not enrolled).`);
  const headers = { 'content-type': 'application/json', 'x-sync-node-token': remote.nodeToken };

  const pushed: CommandResult[] = [];
  const pending = pendingCommands(slug);
  for (let i = 0; i < pending.length; i += 100) {
    const r = await jsonOrThrow<{ results: CommandResult[] }>(
      await call(`${remote.cloudUrl}/api/sync/commands`, {
        method: 'POST', headers, body: JSON.stringify({ commands: pending.slice(i, i + 100) }), timeoutMs: 5 * 60_000,
      }), 'Sending changes');
    pushed.push(...r.results);
  }

  const raw = await jsonOrThrow<{ upTo: number; results: PullResult['results']; effects: Array<{ authority_seq: number; command_id: string | null; changeset: string }> }>(
    await call(`${remote.cloudUrl}/api/sync/pull?since=${lastAuthoritySeq(slug)}`, { headers, timeoutMs: 5 * 60_000 }),
    'Receiving changes');
  const pull: PullResult = {
    upTo: raw.upTo,
    results: raw.results,
    effects: raw.effects.map((e) => ({ ...e, changeset: new Uint8Array(Buffer.from(e.changeset, 'base64')) })),
  };
  const rebase = await applyConfirmed(slug, pull);
  return { pushed, rebase };
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
      if (online !== true) console.log('[sync] connected to the cloud');
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
