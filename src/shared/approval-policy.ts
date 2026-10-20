import type { Request, Response } from 'express';
import { logEvent } from './activity';
/** Administrator is the explicit owner/emergency exception; every use is a named audit event. */
export function independentApproval(req: Request, res: Response, creator: number | null | undefined, action: string): boolean {
  if (creator == null || creator !== req.user!.id) return true;
  if (req.user!.role === 'admin') {
    logEvent(req, { entity: 'approval-exception', action: 'owner-override', summary: `Administrator exercised owner authority: ${action}` });
    return true;
  }
  res.status(403).json({ error: `A different person must ${action}.`, code: 'independent_approval_required' });
  return false;
}
