/** Browser-only credentials: HttpOnly tenant-scoped cookies plus a non-simple request header.
 * Native/installed clients keep explicit bearer authentication; cookies never cross tenants.
 */
import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { tenantStore } from './db';
import { BEHIND_PROXY } from './hosting';
export const browserMode = (req: Request) => req.get('X-Session-Mode') === 'cookie';
export function sessionCookieName(slug = tenantStore.getStore()?.slug ?? 'default'): string {
  return 'vds_session_' + crypto.createHash('sha256').update(slug).digest('hex').slice(0, 16);
}
export function cookieValue(header: string | undefined, name: string): string | null {
  for (const pair of (header || '').split(';')) {
    const [key, ...value] = pair.trim().split('=');
    if (key === name) { try { return decodeURIComponent(value.join('=')); } catch { return null; } }
  }
  return null;
}
export function browserToken(req: Request, slug?: string): string | null {
  return cookieValue(req.headers.cookie, sessionCookieName(slug));
}
export function setBrowserSession(req: Request, res: Response, token: string, shared: boolean): void {
  res.cookie(sessionCookieName(), token, {
    httpOnly: true, secure: req.secure || BEHIND_PROXY, sameSite: 'strict',
    path: String(res.locals.tenantBase || '/'),
    ...(shared ? {} : { maxAge: 12 * 60 * 60 * 1000 }),
  });
}
export function clearBrowserSession(res: Response): void {
  res.clearCookie(sessionCookieName(), { httpOnly: true, sameSite: 'strict', path: String(res.locals.tenantBase || '/') });
}
export function browserCsrf(req: Request, res: Response, next: NextFunction): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) { next(); return; }
  // Cookie login also needs protection against login CSRF, before a cookie exists.
  if ((browserMode(req) || browserToken(req) || cookieValue(req.headers.cookie, 'vds_platform_session')) && !req.get('Authorization') && req.get('X-Requested-With') !== 'VDS') {
    res.status(403).json({ error: 'Request verification failed.' }); return;
  }
  next();
}
