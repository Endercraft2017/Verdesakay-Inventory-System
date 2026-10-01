/**
 * Running a command through its real route handler (docs/OFFLINE-FIRST.md §2.1): the
 * authority replays a node's command, and a node re-runs its own pending commands during
 * rebase. Both go through the full Express stack — tenant resolution, requireAuth,
 * permissions, validation, the handler — so every business rule re-runs; nothing is
 * reimplemented per module.
 *
 * The request is sent over loopback to an internal listener and carries a per-process random
 * secret. Only a request bearing that secret can pick the tenant by header and run as the
 * command's actor (via `syncHooks.replayUser`); anything else is an ordinary request.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express, Request } from 'express';
import type { AuthUser } from '../shared/types';
import type { SyncContext } from '../shared/sync-context';
import { multipartForm, parseMultipart } from './files';

const SECRET = crypto.randomBytes(32).toString('hex');
const H_SECRET = 'x-sync-replay';
const H_TENANT = 'x-sync-tenant';
const H_COMMAND = 'x-sync-command';
const H_MODE = 'x-sync-mode';

export type ReplayMode = 'replay' | 'rebase';

let appRef: Express | null = null;
let server: http.Server | null = null;
let baseUrl: Promise<string> | null = null;

export function setReplayApp(app: Express): void {
  if (appRef !== app) {
    appRef = app;
    server?.close();
    server = null;
    baseUrl = null;
  }
}

function internalBase(): Promise<string> {
  if (!appRef) throw new Error('Sync is not installed on an app (installSync).');
  baseUrl ??= new Promise((resolve, reject) => {
    server = http.createServer(appRef!);
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`));
  });
  return baseUrl;
}

function hasSecret(req: Request): boolean {
  const got = req.get(H_SECRET);
  if (!got || got.length !== SECRET.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(SECRET));
}

/** The replay target, when `req` is a genuine internal replay; otherwise null. */
export function replayRequestOf(req: Request): { slug: string; commandId: string; mode: ReplayMode } | null {
  if (!hasSecret(req)) return null;
  const slug = req.get(H_TENANT);
  const commandId = req.get(H_COMMAND);
  const mode = req.get(H_MODE);
  if (!slug || !commandId || (mode !== 'replay' && mode !== 'rebase')) return null;
  return { slug, commandId, mode };
}

/** Tenant chosen by an internal replay (used by app.ts before normal host resolution). */
export function replayTenantOf(req: Request): string | undefined {
  return replayRequestOf(req)?.slug;
}

const ACTOR = Symbol('syncReplayActor');
type WithActor = Request & { [ACTOR]?: AuthUser };

export function setReplayActor(req: Request, user: AuthUser | undefined): void {
  (req as WithActor)[ACTOR] = user;
}

/** `syncHooks.replayUser`: the actor of a replayed command (undefined for normal requests,
 *  and for a replay whose actor was since disabled or deleted — it then fails auth). */
export function replayUserOf(req: Request): AuthUser | undefined {
  return (req as WithActor)[ACTOR];
}

/** Server-side context of finished replays, read back by the caller (same process). */
const finished = new Map<string, SyncContext>();
export function rememberReplayContext(mode: ReplayMode, commandId: string, ctx: SyncContext): void {
  finished.set(`${mode}:${commandId}`, ctx);
}

export interface ReplayResponse {
  status: number;
  body: unknown;
  ctx: SyncContext | undefined;
}

export async function dispatchCommand(
  slug: string,
  cmd: { id: string; method: string; path: string; body: string; device_id: string | null; context?: string | null },
  mode: ReplayMode,
): Promise<ReplayResponse> {
  const base = await internalBase();
  const multipart = parseMultipart(cmd.body);
  const headers: Record<string, string> = {
    // A command with uploads is replayed as the multipart request it was (fetch sets the boundary).
    ...(multipart ? {} : { 'content-type': 'application/json' }),
    [H_SECRET]: SECRET,
    [H_TENANT]: slug,
    [H_COMMAND]: cmd.id,
    [H_MODE]: mode,
  };
  if (cmd.device_id) headers['x-device-id'] = cmd.device_id; // the audit row keeps the real device
  // Allow-listed headers the original request carried (a kiosk's approval token, §20).
  try {
    const saved = (JSON.parse(cmd.context ?? 'null') ?? {}).headers as Record<string, string> | undefined;
    for (const [k, v] of Object.entries(saved ?? {})) if (k === 'x-kiosk-token' && typeof v === 'string') headers[k] = v;
  } catch { /* no context */ }
  const res = await fetch(base + cmd.path, {
    method: cmd.method,
    headers,
    body: cmd.method === 'GET' || cmd.method === 'HEAD' ? undefined
      : multipart ? multipartForm(slug, multipart) : cmd.body,
  });
  const text = await res.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  const key = `${mode}:${cmd.id}`;
  const ctx = finished.get(key);
  finished.delete(key);
  return { status: res.status, body, ctx };
}
