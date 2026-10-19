/** Versioned credential storage shared by tenant and platform accounts.
 * OWASP's scrypt baseline: N=2^17, r=8, p=1. Built into every supported Node runtime.
 * Only this module may interpret password hashes; malformed/unknown formats fail closed.
 */
import { randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { withPasswordWork } from './password-work';

const PREFIX = 'scrypt$v1$131072$8$1$';
const OPTIONS = { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 };
const MAX_INPUT_BYTES = 4096;
const LEGACY = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

export function hashPassword(password: string): string {
  if (!password || Buffer.byteLength(password, 'utf8') > MAX_INPUT_BYTES) throw new Error('Invalid password length');
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64, OPTIONS);
  return `${PREFIX}${salt.toString('hex')}$${derived.toString('hex')}`;
}

/** Public request bindings use the same format and bounded asynchronous work budget as login. */
export async function hashPasswordForPublicRequest(value: string): Promise<string> {
  if (!value || Buffer.byteLength(value,'utf8')>MAX_INPUT_BYTES) throw new Error('Invalid verifier input');
  return withPasswordWork(async () => {
    const salt=randomBytes(16), derived=await deriveAsync(value,salt);
    return `${PREFIX}${salt.toString('hex')}$${derived.toString('hex')}`;
  });
}

export function passwordNeedsUpgrade(encoded: string): boolean {
  return LEGACY.test(encoded);
}

export function verifyPassword(password: string, encoded: string): boolean {
  if (!password || Buffer.byteLength(password, 'utf8') > MAX_INPUT_BYTES) return false;
  if (LEGACY.test(encoded)) {
    // bcrypt discarded everything past 72 bytes. Never accept an ambiguous suffix or
    // promote one to a new credential. These legacy accounts need password recovery.
    if (Buffer.byteLength(password, 'utf8') > 72) return false;
    const cost = Number(encoded.slice(4, 6));
    if (cost < 4 || cost > 16) return false;
    try { return bcrypt.compareSync(password, encoded); } catch { return false; }
  }
  if (!encoded.startsWith(PREFIX)) return false;
  const parts = encoded.slice(PREFIX.length).split('$');
  if (parts.length !== 2 || !/^[a-f0-9]{32}$/.test(parts[0]!) || !/^[a-f0-9]{128}$/.test(parts[1]!)) return false;
  const actual = scryptSync(password, Buffer.from(parts[0]!, 'hex'), 64, OPTIONS);
  return timingSafeEqual(actual, Buffer.from(parts[1]!, 'hex'));
}

/** Public HTTP sign-in uses asynchronous native scrypt in a bounded queue. Legacy bcrypt
 * cooperatively yields via its supported async API. Other synchronous helpers remain for
 * bootstrap/CLI and existing authenticated writers; the stored format is unchanged. */
export async function verifyPasswordForLogin(password: string, encoded: string, upgrade = true): Promise<{ valid: boolean; upgradedHash?: string }> {
  if (!password || Buffer.byteLength(password, 'utf8') > MAX_INPUT_BYTES) return { valid: false };
  const legacy = LEGACY.test(encoded);
  if (legacy) {
    const cost = Number(encoded.slice(4, 6));
    if (Buffer.byteLength(password, 'utf8') > 72 || cost < 4 || cost > 16) return { valid: false };
  }
  const parts = encoded.startsWith(PREFIX) ? encoded.slice(PREFIX.length).split('$') : [];
  if (!legacy && (parts.length !== 2 || !/^[a-f0-9]{32}$/.test(parts[0]!) || !/^[a-f0-9]{128}$/.test(parts[1]!))) return { valid: false };
  return withPasswordWork(async () => {
    const valid = legacy
      ? await bcrypt.compare(password, encoded)
      : timingSafeEqual(await deriveAsync(password, Buffer.from(parts[0]!, 'hex')), Buffer.from(parts[1]!, 'hex'));
    if (!valid) return { valid: false };
    if (!legacy || !upgrade) return { valid: true };
    const salt = randomBytes(16), derived = await deriveAsync(password, salt);
    return { valid: true, upgradedHash: `${PREFIX}${salt.toString('hex')}$${derived.toString('hex')}` };
  });
}

function deriveAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, OPTIONS, (error, key) => error ? reject(error) : resolve(key));
  });
}
