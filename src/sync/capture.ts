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
import { activeDb } from '../shared/db';
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

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
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
      // Unattributed commands carry no time; they take the authority's (OFFLINE-FIRST §7.5).
      clock: cmd.occurred_at ? sqliteTime(new Date(cmd.occurred_at)) : undefined,
      plan: parsePlan(cmd.allocation_plan),
      cursor: { id: 0, seq: 0 },
      unattributed: cmd.unattributed === 1,
      // A site host's replay isn't final: outside effects wait for the cloud's (§7.8).
      suppressEffects: cfg.role === 'node',
    };
    setReplayActor(req, cmd.actor_user_id != null ? authUserById(cmd.actor_user_id) ?? undefined : undefined);
    rememberReplayContext(replay.mode, cmd.id, ctx);
    syncStore.run(ctx, next);
    return;
  }

  if (!MUTATING.has(req.method)) return next();
  // An authority (the cloud, a site host) streams what each request changed to its PCs.
  if (isAuthority(cfg)) res.once('finish', () => flushEffects(conn, null));
  if (cfg.role === 'node') {
    syncStore.run({ mode: 'guard', plan: [], cursor: { id: 0, seq: 0 } }, next);
    return;
  }
  next();
}

export interface SyncClassOptions {
  /** Anonymous channel: the command carries no actor, device, node, time or planned ids. */
  unattributed?: boolean;
}

export function syncClass(cls: SyncClass, opts: SyncClassOptions = {}): RequestHandler {
  return (req, res, next) => {
    const conn = activeDb();
    const cfg = syncConfigOf(conn);
    if (!cfg || cfg.role === 'cloud') return next();
    const mode = syncContext()?.mode;
    if (mode === 'replay' || mode === 'rebase') return next(); // the orchestrator captures
    if (cls === 'online') {
      res.status(503).json({ error: 'This needs an internet connection.', sync: 'online' });
      return;
    }
    if (cls === 'claim') {
      res.status(503).json({ error: 'This needs a connection to the site host.', sync: 'claim' });
      return;
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
        body: JSON.stringify(req.body ?? {}),
        sync_class: cls,
        allocation_plan: anon ? '[]' : JSON.stringify(ctx.plan),
        app_version: APP_VERSION,
        unattributed: anon ? 1 : 0,
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
