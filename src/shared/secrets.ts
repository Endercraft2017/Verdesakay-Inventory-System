/**
 * Small symmetric encryption for secrets stored in the DB (currently the SMTP
 * password). AES-256-GCM. The key comes from MAIL_SECRET_KEY / APP_SECRET when
 * set; otherwise a random key is generated once and kept in `settings` so a bare
 * install still works — set MAIL_SECRET_KEY in the environment for real at-rest
 * protection (then the DB file alone can't be decrypted).
 */
import crypto from 'node:crypto';
import { getSetting, setSetting } from './db';

let cached: Buffer | null = null;

function masterKey(): Buffer {
  if (cached) return cached;
  const env = process.env.MAIL_SECRET_KEY || process.env.APP_SECRET;
  if (env) {
    cached = crypto.createHash('sha256').update(env).digest();
    return cached;
  }
  let k = getSetting<string>('_secret_key');
  if (!k) {
    k = crypto.randomBytes(32).toString('base64');
    setSetting('_secret_key', k);
    if (!process.env.DB_PATH) {
      console.warn('[crypto] No MAIL_SECRET_KEY set — using an auto-generated key stored in the database. Set MAIL_SECRET_KEY for stronger at-rest protection.');
    }
  }
  cached = crypto.createHash('sha256').update(k).digest();
  return cached;
}

/** → "v1:<iv>:<tag>:<ciphertext>" (all base64). Empty in → empty out. */
export function encryptSecret(plain: string): string {
  if (!plain) return '';
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}

/** Reverse of encryptSecret. Returns '' if the blob is missing/tampered. */
export function decryptSecret(blob: string): string {
  if (!blob) return '';
  const [v, ivB, tagB, dataB] = blob.split(':');
  if (v !== 'v1' || !ivB || !tagB || !dataB) return '';
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(ivB, 'base64'));
    d.setAuthTag(Buffer.from(tagB, 'base64'));
    return Buffer.concat([d.update(Buffer.from(dataB, 'base64')), d.final()]).toString('utf8');
  } catch {
    return '';
  }
}

/** encryptSecret with an explicit key (any string, hashed to 256 bits) — for secrets that don't
 *  belong to a workspace DB, e.g. the platform mailbox (src/platform/platform-mail.ts). */
export function encryptWithKey(keyMaterial: string, plain: string): string {
  if (!plain) return '';
  const key = crypto.createHash('sha256').update(keyMaterial).digest();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}

/** Reverse of encryptWithKey. Returns '' if the blob is missing, tampered or from another key. */
export function decryptWithKey(keyMaterial: string, blob: string): string {
  if (!blob) return '';
  const [v, ivB, tagB, dataB] = blob.split(':');
  if (v !== 'v1' || !ivB || !tagB || !dataB) return '';
  try {
    const key = crypto.createHash('sha256').update(keyMaterial).digest();
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB, 'base64'));
    d.setAuthTag(Buffer.from(tagB, 'base64'));
    return Buffer.concat([d.update(Buffer.from(dataB, 'base64')), d.final()]).toString('utf8');
  } catch {
    return '';
  }
}
