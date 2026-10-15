import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
export function requestContext(_req: Request, res: Response, next: NextFunction): void {
  res.locals.requestId = crypto.randomUUID();
  res.locals.cspNonce = crypto.randomBytes(24).toString('base64');
  res.set('X-Request-ID', res.locals.requestId);
  next();
}
export function securityLog(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), ...event }));
}
