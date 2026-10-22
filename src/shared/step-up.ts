/** Fresh, session-bound proof for cloud account administration. Never synchronized to office nodes. */
import type { Request, Response, NextFunction } from 'express';
import { queryOne, run, tokenDigest } from './db';
import { mfaApplies, mfaEnabled, mfaSetupRequired, securityPolicy } from './mfa';
import { getRole } from './roles';

export function stepUpCredentialStamp(userId: number): string {
  const user = queryOne<{password_hash:string;role:string;permission_overrides:string;active:number;mfa_recovery_required:number;password_change_required:number}>(
    'SELECT password_hash,role,permission_overrides,active,mfa_recovery_required,password_change_required FROM users WHERE id=?',userId);
  const factor = queryOne('SELECT secret,enabled_at FROM user_mfa WHERE user_id=? AND enabled_at IS NOT NULL',userId);
  return tokenDigest(JSON.stringify([user,factor,securityPolicy(),user ? getRole(user.role)?.permissions : null]));
}

export function hasLiveVerificationSession(userId: number, token: string): boolean {
  return !!queryOne("SELECT 1 FROM sessions WHERE token=? AND user_id=? AND ended_at IS NULL AND expires_at>datetime('now')",tokenDigest(token),userId);
}

export function markFreshVerification(userId: number, token: string): boolean {
  if (!hasLiveVerificationSession(userId,token)) return false;
  run("DELETE FROM session_stepups WHERE verified_at<datetime('now','-1 day')");
  run(`INSERT INTO session_stepups(token_hash,user_id,credential_stamp,verified_at)
    VALUES(?,?,?,datetime('now')) ON CONFLICT(token_hash) DO UPDATE SET
    credential_stamp = excluded.credential_stamp,
    verified_at = excluded.verified_at`,tokenDigest(token),userId,stepUpCredentialStamp(userId));
  return true;
}

/** Update a changed policy fingerprint without extending the time since actual authentication. */
export function preserveFreshVerification(userId: number, token: string): void {
  run("UPDATE session_stepups SET credential_stamp=? WHERE token_hash=? AND user_id=? AND verified_at>datetime('now','-5 minutes')",stepUpCredentialStamp(userId),tokenDigest(token),userId);
}

export function hasFreshVerification(userId: number, token: string): boolean {
  return !!queryOne("SELECT 1 FROM session_stepups p JOIN sessions s ON s.token=p.token_hash WHERE p.token_hash=? AND p.user_id=? AND p.credential_stamp=? AND p.verified_at>datetime('now','-5 minutes') AND s.user_id=? AND s.ended_at IS NULL AND s.expires_at>datetime('now')",tokenDigest(token),userId,stepUpCredentialStamp(userId),userId);
}

/** Place after permission and syncClass('online'): offline business routes are unaffected. */
export function freshVerificationFor(action:string) {
 return (req:Request,res:Response,next:NextFunction):void=>{
  if (!req.user || !req.token) {
    res.status(403).json({error:`Sign in directly on the cloud to ${action}.`});return;
  }
  if (mfaSetupRequired(req.user)) { res.status(403).json({error:`Set up two-step sign-in before you ${action}.`,mfa_setup_required:true});return; }
  if (!hasFreshVerification(req.user.id,req.token)) {
    res.status(403).json({error:`Confirm your identity before you ${action}.`,step_up_required:true,mfa_required:mfaApplies()&&mfaEnabled(req.user.id)});return;
  }
  next();
 };
}
export const requireFreshVerification=freshVerificationFor('change accounts or sign-in security');

export interface SavedVerificationContext { user_id: number; session_hash: string; credential_stamp: string }
/** OAuth may finish after the five-minute write window, but never after its actor/session was revoked. */
export function isSavedVerificationContextCurrent(context: Partial<SavedVerificationContext>): boolean {
  if (typeof context.user_id !== 'number' || typeof context.session_hash !== 'string' || typeof context.credential_stamp !== 'string') return false;
  return !!queryOne("SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.user_id=? AND s.ended_at IS NULL AND s.expires_at>datetime('now') AND u.active=1",context.session_hash,context.user_id) && stepUpCredentialStamp(context.user_id)===context.credential_stamp;
}
