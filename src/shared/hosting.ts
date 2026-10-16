/**
 * Where the server is running. `BEHIND_PROXY` is true when a TLS-terminating reverse proxy
 * (Railway, a load balancer, nginx) fronts the app — auto-detected on Railway, or forced with
 * BEHIND_PROXY=true. It also means the app is reachable from the internet rather than only the
 * office LAN, so features that relied on "you can only reach it from the office" (the time-in
 * kiosk) default to their locked-down mode. See docs/DEPLOY-RAILWAY.md.
 */
export const BEHIND_PROXY = process.env.BEHIND_PROXY === 'true' || !!process.env.RAILWAY_ENVIRONMENT;

/** The request header that carries the visitor's address, written by the edge proxy (which
 *  replaces any copy the caller sent). On Railway that is X-Real-IP: `req.ip` there resolves to an
 *  internal hop between Railway's edge and the app, the same few addresses for every user, which
 *  made every rate limit shared and every logged IP useless. CLIENT_IP_HEADER overrides it;
 *  empty (the default off Railway) keeps Express's `req.ip`. */
export const CLIENT_IP_HEADER = (process.env.CLIENT_IP_HEADER ?? (process.env.RAILWAY_ENVIRONMENT ? 'x-real-ip' : '')).trim().toLowerCase();

/** Cloud production must never silently downgrade authenticated traffic to plain HTTP. */
export function requireProductionTransport(tlsAvailable: boolean, behindProxy = BEHIND_PROXY, environment = process.env.NODE_ENV): void {
  if (environment === 'production' && !tlsAvailable && !behindProxy) {
    throw new Error('Production requires HTTPS certificates or a configured TLS reverse proxy.');
  }
}
