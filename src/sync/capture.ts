/**
 * Where requests meet sync (docs/OFFLINE-FIRST.md §2, §7.1).
 *
 * `syncRequestMiddleware` (app-wide, right after tenant resolution):
 *  - internal replay/rebase request → run it in that command's context, as its actor;
 *  - node DB, mutating request → `guard` context: unless the route declares a sync class,
 *    it may not write replicated data (it would never sync);
 *  - cloud DB, mutating request → flush the recorded changes into the effect stream when done.
 *
 * `syncClass(cls)` (per route, next to its permission check) declares how the route behaves
 * disconnected. On a node it records the request as a command — optimistic run, one SQLite
 * session capturing its changes, allocation plan, command clock — or refuses it (`online`,
 * and `claim` until site hosts exist in phase 3). On the cloud, and on DBs without sync, it
 * does nothing.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { activeDb, tenantStore } from '../shared/db';

const tenantSlug = () => tenantStore.getStore()?.slug ?? 'default';
import { authUserById } from '../shared/auth';
import { syncContext, syncStore, type SyncContext } from '../shared/sync-context';
import { filterChangeset } from './changeset';
import { sqliteTime } from './clock';
import {
  APP_VERSION, getCommand, insertCommand, lockSync, parsePlan, stampLocal, type SyncClass,
} from './commands';
import { ulid } from './ids-util';
import { isAuthority, isReplicated, syncConfigOf, type SyncConfig } from './node';
import { flushEffects } from './authority';
import { rememberReplayContext, replayRequestOf, setReplayActor } from './replay';
import { deciderOf, siteOfNode, siteOfThisPc, type Home } from './sites';
import { linkStatusOf } from './client';
import { commandBody, indexFiles } from './files';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Request headers a replay must send again — and nothing else: a kiosk punch is re-checked
 *  against the same approved kiosk on the authority (§20). */
export const REPLAYED_HEADERS = ['x-kiosk-token'];

/** What a command remembers about its request besides method / path / body (§20). */
function requestContext(req: Request): string | null {
  const headers: Record<string, string> = {};
  for (const h of REPLAYED_HEADERS) {
    const v = req.get(h);
    if (v) headers[h] = v;
  }
  const ctx: { headers?: Record<string, string>; session?: { shared: boolean } } = {};
  if (Object.keys(headers).length) ctx.headers = headers;
  // A borrowed-phone sign-in marks a phone punch "borrowed"; the replay must know it too.
  if (req.authSession) ctx.session = { shared: !!req.authSession.shared };
  return Object.keys(ctx).length ? JSON.stringify(ctx) : null;
}
const DEVICE_ID_RE = /^[A-Za-z0-9-]{8,64}$/; // same rule as the X-Device-Id the clients send

function deviceIdOf(req: Request): string | null {
  const raw = req.get('x-device-id');
  return raw && DEVICE_ID_RE.test(raw) ? raw : null;
}

export function syncRequestMiddleware(req: Request, res: Response, next: NextFunction): void {
  const conn = activeDb();
  const cfg = syncConfigOf(conn);
  if (!cfg) return next();

  const replay = replayRequestOf(req);
  if (replay) {
    const cmd = getCommand(conn, replay.commandId);
    if (!cmd) {
      res.status(404).json({ error: 'Unknown sync command.' });
      return;
    }
    const ctx: SyncContext = {
      mode: replay.mode,
      commandId: cmd.id,
      // Unattributed commands carry no time; they take the authority's (OFFLINE-FIRST §7.5).
      clock: cmd.occurred_at ? sqliteTime(new Date(cmd.occurred_at)) : undefined,
      plan: parsePlan(cmd.allocation_plan),
      cursor: { id: 0, seq: 0 },
      unattributed: cmd.unattributed === 1,
      // A site host's replay isn't final: outside effects wait for the cloud's (§7.8).
      suppressEffects: cfg.role === 'node',
      // The cloud: which site (if any) this command was decided at (D6).
      decidingSite: cfg.role === 'cloud' ? siteOfNode(conn, cmd.node_no) : null,
      // A site host records what it actually allocated, for the cloud to reproduce.
      ...(cfg.role === 'node' && cmd.unattributed !== 1 ? { effective: [] } : {}),
    };
    setReplayActor(req, cmd.actor_user_id != null ? authUserById(cmd.actor_user_id) ?? undefined : undefined);
    // The original sign-in's nature (a borrowed phone) as the route saw it (§20).
    const session = (() => { try { return (JSON.parse(cmd.context ?? 'null') ?? {}).session; } catch { return null; } })();
    if (session) req.authSession = { sid: 'sync-replay', shared: !!session.shared, device_id: cmd.device_id, last_seen_at: null, last_ip: null };
    rememberReplayContext(replay.mode, cmd.id, ctx);
    syncStore.run(ctx, next);
    return;
  }

  if (!MUTATING.has(req.method)) return next();
  // An authority (the cloud, a site host) streams what each request changed to its PCs — and
  // lists any file it uploaded straight away, so the file follows its row without delay (§18).
  if (isAuthority(cfg)) {
    res.once('finish', () => {
      flushEffects(conn, null);
      if (req.file || (req.files && Object.keys(req.files).length)) indexFiles(conn, tenantSlug(), true);
    });
  }
  if (cfg.role === 'node') {
    syncStore.run({ mode: 'guard', plan: [], cursor: { id: 0, seq: 0 } }, next);
    return;
  }
  next();
}

export interface SyncClassOptions {
  /** Anonymous channel: the command carries no actor, device, node, time or planned ids. */
  unattributed?: boolean;
  /** `claim` only: whose decision the record is (§16). Default: company-wide (the main site). */
  home?: (req: Request) => Home;
}

/** A LAN PC may decide its site's records only while it can reach its host: a round within
 *  this long counts as "connected". */
const HOST_FRESH_MS = 2 * 60_000;

function claimRefusal(conn: DatabaseSync, cfg: SyncConfig, req: Request, opts: SyncClassOptions): string | null {
  const site = siteOfThisPc(conn, cfg);
  const decider = deciderOf(opts.home ? opts.home(req) : 'company');
  if (decider == null || site == null || decider !== site) {
    return decider == null || site == null
      ? 'This needs an internet connection.'
      : 'This belongs to another site. It needs an internet connection.';
  }
  if (!cfg.isHost) {
    const link = linkStatusOf(tenantSlug());
    const fresh = link.online === true && !!link.lastSyncAt && Date.now() - Date.parse(link.lastSyncAt) < HOST_FRESH_MS;
    if (!fresh) return 'This needs a connection to the site host.';
  }
  return null;
}

export function syncClass(cls: SyncClass, opts: SyncClassOptions = {}): RequestHandler {
  return (req, res, next) => {
    const conn = activeDb();
    const cfg = syncConfigOf(conn);
    if (!cfg) return next();
    const ctx = syncContext();
    if (cfg.role === 'cloud') {
      // Re-running a site's decision on a record that site owns: it stands (D6).
      if (cls === 'claim' && ctx?.mode === 'replay' && ctx.decidingSite != null
          && deciderOf(opts.home ? opts.home(req) : 'company') === ctx.decidingSite) {
        ctx.siteFinal = true;
      }
      return next();
    }
    if (ctx?.mode === 'replay' || ctx?.mode === 'rebase') return next(); // the orchestrator captures
    if (cls === 'online') {
      res.status(503).json({ error: 'This needs an internet connection.', sync: 'online' });
      return;
    }
    if (cls === 'claim') {
      const refusal = claimRefusal(conn, cfg, req, opts);
      if (refusal) {
        res.status(503).json({ error: refusal, sync: 'claim' });
        return;
      }
    }
    recordCommand(conn, cfg, cls, opts, req, res, next).catch(next);
  };
}

async function recordCommand(
  conn: DatabaseSync, cfg: SyncConfig, cls: SyncClass, opts: SyncClassOptions,
  req: Request, res: Response, next: NextFunction,
): Promise<void> {
  const release = await lockSync(conn);
  const occurred = new Date();
  const ctx: SyncContext = {
    mode: 'record',
    clock: sqliteTime(occurred),
    plan: [],
    cursor: { id: 0, seq: 0 },
    unattributed: !!opts.unattributed,
  };
  const anon = !!opts.unattributed;
  const day = occurred.toISOString().slice(0, 10);
  // A ULID embeds its creation time; an anonymous one is dated to midnight only.
  const commandId = anon ? ulid(Date.parse(day)) : ulid(occurred.getTime());
  ctx.commandId = commandId;
  // Tell the client this result is only on this PC so far (OFFLINE-FIRST §2.4): it must not be
  // shown as final. The id lets the UI follow it to "Synced" / "Needs attention".
  res.setHeader('X-Sync-State', 'local');
  res.setHeader('X-Sync-Command', commandId);
  const session = conn.createSession();
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    try {
      const changes = filterChangeset(session.changeset(), isReplicated);
      session.close();
      // Nothing changed ⇒ nothing to sync (a validation error, a no-op).
      if (!changes.length) return;
      const stamp = anon ? { node_seq: null, hlc: null } : stampLocal(conn, cfg.nodeNo);
      insertCommand(conn, {
        id: commandId,
        node_no: anon ? null : cfg.nodeNo,
        node_seq: stamp.node_seq,
        hlc: stamp.hlc,
        occurred_at: anon ? null : occurred.toISOString(),
        occurred_date: day,
        actor_user_id: anon ? null : req.user?.id ?? null,
        device_id: anon ? null : deviceIdOf(req),
        method: req.method,
        path: req.originalUrl,
        body: commandBody(req), // with uploads: fields + file references (§18)
        sync_class: cls,
        allocation_plan: anon ? '[]' : JSON.stringify(ctx.plan),
        app_version: APP_VERSION,
        unattributed: anon ? 1 : 0,
        context: anon ? null : requestContext(req),
      }, { state: 'local', local_changeset: changes, response_status: res.statusCode });
    } catch (e) {
      console.error('[sync] failed to record a command:', e);
    } finally {
      release();
    }
  };
  res.once('finish', finish);
  res.once('close', finish);
  syncStore.run(ctx, next);
}
