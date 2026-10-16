/** TOTP via otplib, encrypted tenant-local secrets, one-use recovery codes and replay prevention. */
import crypto from 'node:crypto';
import { generateSecret, generateURI, verifySync } from 'otplib';
import { queryOne, run, tenantStore } from './db';
import { encryptSecret, decryptSecret } from './secrets';
const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
interface MfaRow { user_id: number; secret: string | null; pending_secret: string | null; pending_until: number | null; pending_session: string | null; last_step: number | null; recovery_hashes: string }
export function mfaState(id: number) { return queryOne<MfaRow>('SELECT * FROM user_mfa WHERE user_id = ?', id); }
export function mfaEnabled(id: number): boolean { return !!mfaState(id)?.secret; }
export function startMfa(id: number, username: string, session: string) {
  if (mfaEnabled(id)) throw Object.assign(new Error('Disable existing MFA before replacing it.'), { status: 409 });
  const secret = generateSecret();
  run(`INSERT INTO user_mfa (user_id, pending_secret, pending_until, pending_session) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET pending_secret=excluded.pending_secret, pending_until=excluded.pending_until, pending_session=excluded.pending_session`,
    id, encryptSecret(secret), Date.now() + 600_000, hash(session));
  return { secret, uri: generateURI({ issuer: 'Verdesakay', label: `${tenantStore.getStore()?.slug || 'default'}:${username}`, secret }) };
}
export function finishMfa(id: number, session: string, code: string): string[] | null {
  const row = mfaState(id);
  if (!row?.pending_secret || row.secret || !row.pending_until || row.pending_until < Date.now() || row.pending_session !== hash(session)) return null;
  if (!/^\d{6}$/.test(code)) return null;
  const result = verifySync({ secret: decryptSecret(row.pending_secret), token: code, epochTolerance: 30 });
  if (!result.valid || !('timeStep' in result)) return null;
  const codes = Array.from({ length: 8 }, () => crypto.randomBytes(12).toString('hex'));
  const changed = run(`UPDATE user_mfa SET secret=pending_secret, pending_secret=NULL, pending_until=NULL, pending_session=NULL, last_step=?, recovery_hashes=? WHERE user_id=? AND secret IS NULL AND pending_secret=?`,
    result.timeStep, JSON.stringify(codes.map(hash)), id, row.pending_secret).changes;
  return changed ? codes : null;
}
export function verifyMfa(id: number, code: string): boolean {
  const row = mfaState(id);
  if (!row?.secret) return false;
  if (/^[a-f0-9]{24}$/i.test(code)) {
    const hashes: string[] = JSON.parse(row.recovery_hashes);
    const wanted = hash(code.toLowerCase());
    if (!hashes.includes(wanted)) return false;
    return !!run('UPDATE user_mfa SET recovery_hashes=? WHERE user_id=? AND recovery_hashes=?', JSON.stringify(hashes.filter(h => h !== wanted)), id, row.recovery_hashes).changes;
  }
  if (!/^\d{6}$/.test(code)) return false;
  try {
    const result = verifySync({ secret: decryptSecret(row.secret), token: code, epochTolerance: 30, ...(row.last_step == null ? {} : { afterTimeStep: row.last_step }) });
    if (!result.valid || !('timeStep' in result)) return false;
    return !!run('UPDATE user_mfa SET last_step=? WHERE user_id=? AND (last_step IS NULL OR last_step < ?)', result.timeStep, id, result.timeStep).changes;
  } catch { return false; }
}
