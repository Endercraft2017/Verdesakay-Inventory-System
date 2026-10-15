import type { Request, Response, NextFunction } from 'express';
/** Reject malformed numeric resource path segments before they reach Number()/SQL. */
export function validateResourcePath(req: Request, res: Response, next: NextFunction): void {
  const segments = req.path.split('/');
  for (const value of segments) {
    if (/^[+-]?\d/.test(value) && (/^[+-]?\d+(?:\.\d+)?$/.test(value) || /^\d+(?:e[+-]?\d+|Infinity)$/i.test(value))) {
      const n = Number(value);
      // Date-like string routes (2026-10-16) are not treated as IDs here.
      if (!Number.isSafeInteger(n) || n < 1 || !/^\d+$/.test(value)) {
        res.status(400).json({ error: 'Invalid resource identifier.' }); return;
      }
    }
  }
  next();
}
