/**
 * Two-step sign-in (OWASP ASVS 5.0 §6.3): after the password, a 6-digit code from an
 * authenticator app (shared/totp.ts) or a one-time recovery code.
 *
 *  - Anyone can turn it on for their own account (Account → Two-step sign-in).
 *  - The workspace setting `security_policy.require_mfa_privileged` makes it compulsory for
 *    privileged accounts (admin role, or users / payroll / accounting management): until they
 *    set it up, their session can only reach the set-up screens (shared/auth.ts requireAuth).
 *    Only someone who already uses it may switch the requirement on, so nobody locks the
 *    workspace out.
 *  - An admin can reset it for someone who lost their phone (users.routes.ts).
 *  - Installed PCs (DEPLOY_MODE=node — on-site, on the office network) sign in with the
 *    password alone: the secrets are encrypted with the cloud's key and never sync to them.
 */
import crypto from 'node:crypto';
import { queryOne, queryAll, run, getSetting, setSetting } from './db';
import { encryptSecret, decryptSecret } from './secrets';
import { newTotpSecret, verifyTotp, otpauthUrl } from './totp';

const CHALLENGE_MINUTES = 5;
const CHALLENGE_ATTEMPTS = 5;
const RECOVERY_CODES = 10;
const PRIVILEGED_PERMISSIONS = ['users.manage', 'payroll.manage', 'accounting.manage'];

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export interface SecurityPolicy { require_mfa_privileged: boolean }

/** Two-step sign-in runs on the cloud (and self-hosted servers), not on installed PCs. */
export function mfaApplies(): boolean {
  return process.env.DEPLOY_MODE !== 'node';
}

export function securityPolicy(): SecurityPolicy {
  return { require_mfa_privileged: false, ...(getSetting<Partial<SecurityPolicy>>('security_policy') || {}) };
}

export function setSecurityPolicy(policy: SecurityPolicy): void {
  setSetting('security_policy', policy);
}

export function isPrivileged(user: { role: string; permissions: string[] }): boolean {
  return user.role === 'admin' || user.permissions.some((p) => PRIVILEGED_PERMISSIONS.includes(p));
}

export function mfaEnabled(userId: number): boolean {
  return !!queryOne<{ x: number }>('SELECT 1 AS x FROM user_mfa WHERE user_id = ? AND enabled_at IS NOT NULL', userId);
}

/** True when the workspace requires two-step sign-in for this account and it isn't set up yet. */
export function mfaSetupRequired(user: { id: number; role: string; permissions: string[] }): boolean {
  return mfaApplies() && securityPolicy().require_mfa_privileged && isPrivileged(user) && !mfaEnabled(user.id);
}

export function recoveryCodesLeft(userId: number): number {
  return queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM user_mfa_recovery WHERE user_id = ? AND used_at IS NULL', userId)?.n ?? 0;
}

/** Start (or restart) setting up: a fresh secret, not active until confirmed with a code. */
export function startMfaSetup(userId: number, accountLabel: string): { secret: string; otpauth_url: string } {
  if (mfaEnabled(userId)) throw Object.assign(new Error('Two-step sign-in is already on. Turn it off first to move it to a new phone.'), { status: 409 });
  const secret = newTotpSecret();
  run(`INSERT INTO user_mfa (user_id, secret, enabled_at, last_step) VALUES (?, ?, NULL, 0)
       ON CONFLICT(user_id) DO UPDATE SET secret = excluded.secret, enabled_at = NULL, last_step = 0`,
    userId, encryptSecret(secret));
  return { secret, otpauth_url: otpauthUrl('Otom', accountLabel, secret) };
}

function newRecoveryCodes(userId: number): string[] {
  run('DELETE FROM user_mfa_recovery WHERE user_id = ?', userId);
  const codes: string[] = [];
  for (let i = 0; i < RECOVERY_CODES; i++) {
    const raw = crypto.randomBytes(5).toString('hex'); // 10 hex characters
    const code = `${raw.slice(0, 5)}-${raw.slice(5)}`;
    codes.push(code);
    run('INSERT INTO user_mfa_recovery (user_id, code_hash) VALUES (?, ?)', userId, sha256(code));
  }
  return codes;
}

/** Finish setting up with a code from the app. Returns the recovery codes (shown once), or null. */
export function enableMfa(userId: number, code: string): string[] | null {
  const row = queryOne<{ secret: string; enabled_at: string | null }>('SELECT secret, enabled_at FROM user_mfa WHERE user_id = ?', userId);
  if (!row || row.enabled_at) return null;
  const step = verifyTotp(decryptSecret(row.secret), code);
  if (step === null) return null;
  run("UPDATE user_mfa SET enabled_at = datetime('now'), last_step = ? WHERE user_id = ?", step, userId);
  return newRecoveryCodes(userId);
}

/** Check a sign-in code: the app's current code (each usable once) or an unused recovery code. */
export function checkMfaCode(userId: number, code: string): boolean {
  const row = queryOne<{ secret: string; last_step: number }>('SELECT secret, last_step FROM user_mfa WHERE user_id = ? AND enabled_at IS NOT NULL', userId);
  if (!row) return false;
  const typed = String(code || '').trim();
  const step = verifyTotp(decryptSecret(row.secret), typed, row.last_step);
  if (step !== null) {
    // Claim the step atomically: two requests with the same code can't both pass.
    return Number(run('UPDATE user_mfa SET last_step = ? WHERE user_id = ? AND last_step < ?', step, userId, step).changes) === 1;
  }
  const normalized = typed.toLowerCase().replace(/\s/g, '');
  const withDash = /^[0-9a-f]{10}$/.test(normalized) ? `${normalized.slice(0, 5)}-${normalized.slice(5)}` : normalized;
  return Number(run("UPDATE user_mfa_recovery SET used_at = datetime('now') WHERE user_id = ? AND code_hash = ? AND used_at IS NULL",
    userId, sha256(withDash)).changes) === 1;
}

export function regenerateRecoveryCodes(userId: number): string[] {
  return newRecoveryCodes(userId);
}

/** Turn it off (the person themselves, or an admin reset). */
export function disableMfa(userId: number): void {
  run('DELETE FROM user_mfa WHERE user_id = ?', userId);
  run('DELETE FROM user_mfa_recovery WHERE user_id = ?', userId);
}

/** After a correct password for an account with two-step on: a short-lived challenge token. */
export function createMfaChallenge(userId: number, shared: boolean): string {
  run("DELETE FROM mfa_challenges WHERE expires_at < datetime('now')");
  const token = crypto.randomBytes(32).toString('hex');
  run(`INSERT INTO mfa_challenges (token_hash, user_id, shared, expires_at) VALUES (?, ?, ?, datetime('now', '+${CHALLENGE_MINUTES} minutes'))`,
    sha256(token), userId, shared ? 1 : 0);
  return token;
}

/** Complete a challenge with a code. Each challenge allows a few attempts, then a new sign-in. */
export function completeMfaChallenge(token: string, code: string): { userId: number; shared: boolean } | { error: string } {
  const hash = sha256(String(token || ''));
  const row = queryOne<{ user_id: number; shared: number; attempts: number }>(
    "SELECT user_id, shared, attempts FROM mfa_challenges WHERE token_hash = ? AND expires_at >= datetime('now')", hash);
  if (!row || row.attempts >= CHALLENGE_ATTEMPTS) {
    run('DELETE FROM mfa_challenges WHERE token_hash = ?', hash);
    return { error: 'This sign-in has expired. Enter your password again.' };
  }
  if (!checkMfaCode(row.user_id, code)) {
    run('UPDATE mfa_challenges SET attempts = attempts + 1 WHERE token_hash = ?', hash);
    return { error: 'That code is not right. Check your authenticator app and try again.' };
  }
  run('DELETE FROM mfa_challenges WHERE token_hash = ?', hash);
  return { userId: row.user_id, shared: row.shared === 1 };
}

/** Accounts in this workspace that have two-step sign-in on (for the admin user list). */
export function mfaUserIds(): Set<number> {
  return new Set(queryAll<{ user_id: number }>('SELECT user_id FROM user_mfa WHERE enabled_at IS NOT NULL').map((r) => r.user_id));
}
