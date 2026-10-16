/** Versioned credential storage shared by tenant and platform accounts.
 * OWASP's scrypt baseline: N=2^17, r=8, p=1. Built into every supported Node runtime.
 * Only this module may interpret password hashes; malformed/unknown formats fail closed.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';

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
