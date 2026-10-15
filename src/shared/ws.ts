/**
 * Real-time push for chat (reactions/edits/new messages/typing) over WebSocket.
 *
 * Everything else in this app is REST + polling (see push.ts for the offline/mobile
 * story via Web Push); this is the one live channel, mounted at /ws on whichever
 * http(s).Server actually accepts connections (see server.ts). REST stays the single
 * source of truth for every mutation — routes call `broadcast()` after committing to the
 * DB, this module never writes to it.
 *
 * A browser's WebSocket API can't set custom headers on the handshake, so the session
 * browser uses its HttpOnly cookie and an origin-checked handshake. Installed clients
 * keep legacy `?token=` authentication; proxies must redact query strings from logs.
 */
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import { WebSocketServer, WebSocket } from 'ws';
import { browserToken } from './browser-session';
import { userFromToken } from './auth';
import { resolveTenantSlug, getTenant, retiredDefaultTenant } from '../platform/platform';
import { tenantPath, onTenantPathHost } from '../platform/tenant-path';
import { tenantStore, getDb } from './db';
import { sideEffectsSuppressed } from './sync-context';

export interface ChatEvent {
  type: string;
  data: unknown;
}

const authorized = new WeakMap<WebSocket, () => boolean>();

function isAuthorized(ws: WebSocket): boolean {
  const check = authorized.get(ws);
  if (check?.()) return true;
  ws.close(1008, 'Session ended');
  return false;
}

// tenantSlug -> userId -> that user's open sockets (multiple tabs/devices at once).
const connections = new Map<string, Map<number, Set<WebSocket>>>();

function register(slug: string, userId: number, ws: WebSocket): void {
  let tenant = connections.get(slug);
  if (!tenant) { tenant = new Map(); connections.set(slug, tenant); }
  let set = tenant.get(userId);
  if (!set) { set = new Set(); tenant.set(userId, set); }
  set.add(ws);
}

function unregister(slug: string, userId: number, ws: WebSocket): void {
  const tenant = connections.get(slug);
  const set = tenant?.get(userId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) tenant!.delete(userId);
  if (tenant!.size === 0) connections.delete(slug);
}

/** Push `event` to every open socket for each of `userIds` in tenant `slug`. Called by
 *  routes after a DB mutation commits (message send/edit/unsend/react/read). */
export function broadcast(slug: string, userIds: number[], event: ChatEvent): void {
  if (sideEffectsSuppressed('broadcast')) return; // the authority broadcasts once, on replay
  const tenant = connections.get(slug);
  if (!tenant) return;
  const payload = JSON.stringify(event);
  for (const userId of userIds) {
    for (const ws of tenant.get(userId) ?? []) {
      if (ws.readyState === WebSocket.OPEN && isAuthorized(ws)) ws.send(payload);
    }
  }
}

const HEARTBEAT_MS = 30_000;

/** Attach the /ws upgrade handler to a running server. Call once, on the server that's
 *  actually listening (the HTTPS one when certs exist, else the plain-HTTP fallback —
 *  never the bare HTTP->HTTPS redirect listener). */
export function attachWebSocket(server: HttpServer | HttpsServer): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url || '', 'http://placeholder');
    const route = tenantPath(req.headers.host, url.pathname);
    if ((route?.url ?? url.pathname) !== '/ws'
      || (!route && onTenantPathHost(req.headers.host) && process.env.DEFAULT_TENANT_REDIRECT)) {
      socket.destroy();
      return;
    }
    const xTenant = req.headers['x-tenant'];
    const slug = route?.slug ?? resolveTenantSlug(
      req.headers.host,
      Array.isArray(xTenant) ? xTenant[0] : xTenant,
      url.searchParams.get('tenant')
    );
    if (slug === 'default' && retiredDefaultTenant()) { socket.destroy(); return; }
    if (slug !== 'default') {
      const tenant = getTenant(slug);
      if (!tenant || tenant.status === 'suspended' || tenant.status === 'purged') {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return;
      }
    }
    // userFromToken() resolves the tenant DB off tenantStore (see db.ts's `db` proxy) —
    // without this it would silently fall back to the default tenant's DB and accept
    // (or reject) tokens that belong to a completely different workspace.
    const bearer = url.searchParams.get('token');
    if (!bearer) {
      try {
        const origin = new URL(String(req.headers.origin || ''));
        if (!['http:', 'https:'].includes(origin.protocol) || origin.host !== req.headers.host) { socket.destroy(); return; }
      } catch { socket.destroy(); return; }
    }
    const token = bearer || browserToken(req as import('express').Request, slug);
    const user = tenantStore.run({ db: getDb(slug), slug }, () => userFromToken(token));
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      authorized.set(ws, () => {
        try {
          const tenant = slug === 'default' ? null : getTenant(slug);
          if (slug !== 'default' && (!tenant || tenant.status === 'suspended' || tenant.status === 'purged')) return false;
          return !!tenantStore.run({ db: getDb(slug), slug }, () => userFromToken(token));
        } catch { return false; }
      });
      wss.emit('connection', ws, req, { slug, userId: user.id });
    });
  });

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage, ctx: { slug: string; userId: number }) => {
    const { slug, userId } = ctx;
    register(slug, userId, ws);

    let alive = true;
    ws.on('pong', () => { alive = true; });

    ws.on('message', (raw) => {
      if (!isAuthorized(ws)) return;
      let msg: { type?: string; to?: number } | null = null;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      // The only inbound message the client sends: an ephemeral typing ping, relayed
      // straight to the target user's own sockets. Never persisted.
      if (msg && msg.type === 'typing' && typeof msg.to === 'number') {
        broadcast(slug, [msg.to], { type: 'typing', data: { from: userId } });
      }
    });

    ws.on('close', () => unregister(slug, userId, ws));
    ws.on('error', () => unregister(slug, userId, ws));

    const heartbeat = setInterval(() => {
      if (!isAuthorized(ws)) return;
      if (!alive) { ws.terminate(); return; }
      alive = false;
      ws.ping();
    }, HEARTBEAT_MS);
    heartbeat.unref();
    ws.on('close', () => clearInterval(heartbeat));
  });
}
