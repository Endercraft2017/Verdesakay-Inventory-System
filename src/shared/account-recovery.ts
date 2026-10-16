/** Controlled factor recovery, owned by core authentication. Never returns a recovery bearer. */
import crypto from 'node:crypto';
import { z } from 'zod';
import { db, queryOne, run, tenantStore, DEFAULT_TENANT } from './db';
import { mailReady, sendMail } from './mailer';
import { getTenant } from '../platform/platform';

export const recoveryEvidenceSchema = z.object({
  reason: z.string().trim().min(20).max(500),
  verification_reference: z.string().trim().min(8).max(120),
});
export const credentialStamp = (hash: string): string => crypto.createHash('sha256').update(hash).digest('hex');
export function recoveryOrigin(): string {
  const configured = process.env.TENANT_PATH_HOST ? `https://${process.env.TENANT_PATH_HOST}` : process.env.PUBLIC_APP_URL;
  if (!configured) throw Object.assign(new Error('Configure PUBLIC_APP_URL or TENANT_PATH_HOST before account recovery.'), { status: 503 });
  const url = new URL(configured);
  if (url.protocol !== 'https:' || url.username || url.password) throw Object.assign(new Error('Account recovery requires a configured HTTPS public origin.'), { status: 503 });
  return url.origin;
}

export function recoveryLinkBase(tenantBase: string): string {
  let origin = recoveryOrigin();
  const slug = tenantStore.getStore()?.slug || DEFAULT_TENANT;
  if (slug !== DEFAULT_TENANT && getTenant(slug)?.is_sandbox === 1) throw Object.assign(new Error('Sandbox account recovery is unavailable.'), { status: 409 });
  if (!tenantBase && slug !== DEFAULT_TENANT) {
    const domain = process.env.APP_DOMAIN;
    if (!domain || !/^[a-z0-9.-]+$/i.test(domain)) throw Object.assign(new Error('Configure the tenant public domain for recovery.'), { status: 503 });
    origin = new URL(`https://${slug}.${domain}`).origin;
  }
  if (tenantBase && !/^\/[a-z][a-z0-9-]{1,30}$/.test(tenantBase)) throw new Error('Invalid recovery workspace path');
  return origin + tenantBase;
}

export async function issueAccountRecovery(userId: number, tenantBase: string, evidence: {
  requested_by: string; approved_by: string; reason: string; verification_reference: string;
}): Promise<void> {
  const user = queryOne<{ email: string | null; username: string; password_hash: string; active: number }>('SELECT email, username, password_hash, active FROM users WHERE id=?', userId);
  if (!user || user.active !== 1 || !user.email || !mailReady()) throw Object.assign(new Error('Recovery requires an active account, its existing email address and working workspace email.'), { status: 409 });
  const base = recoveryLinkBase(tenantBase);
  const raw = crypto.randomBytes(32).toString('hex');
  const digest = crypto.createHash('sha256').update(raw).digest('hex');
  db.exec('BEGIN IMMEDIATE');
  try {
  run("UPDATE password_resets SET used=1 WHERE token_hash IN (SELECT token_hash FROM account_recoveries WHERE user_id=? AND state='pending')", userId);
  run("UPDATE account_recoveries SET state='cancelled' WHERE user_id=? AND state='pending'", userId);
  run("INSERT INTO password_resets(token_hash,user_id,expires_at) VALUES(?,?,datetime('now','+15 minutes'))", digest, userId);
  run(`INSERT INTO account_recoveries(token_hash,user_id,requested_by,approved_by,reason,verification_reference,contact_email,credential_hash)
    VALUES(?,?,?,?,?,?,?,?)`, digest, userId, evidence.requested_by, evidence.approved_by, evidence.reason, evidence.verification_reference, user.email, credentialStamp(user.password_hash));
  db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  try {
    const result = await sendMail({ to: user.email, subject: 'Account recovery requested — authenticator replacement',
      text: `Recovery was approved for ${user.username}. If you requested it, use this single-use link within 15 minutes to choose a new password, then enroll your authenticator again:\n${base}/?reset=${raw}\n\nYour current password and authenticator remain in place until you use the link. If this was unexpected, contact your company administrator using your usual contact details.` }, userId);
    if (!result.ok) throw new Error('Recovery email could not be delivered. Existing sign-in remains unchanged.');
  } catch {
    run('UPDATE password_resets SET used=1 WHERE token_hash=?', digest);
    run("UPDATE account_recoveries SET state='cancelled' WHERE token_hash=? AND state='pending'", digest);
    throw Object.assign(new Error('Recovery email could not be delivered. Existing sign-in remains unchanged.'), { status: 503 });
  }
}
