/**
 * Time-based one-time passwords (RFC 6238, the codes Google Authenticator, Microsoft
 * Authenticator, Authy, 1Password … show): HMAC-SHA1, 30-second steps, 6 digits. Node's crypto
 * only — no dependency. Used by the two-step sign-in (src/core/mfa.ts).
 */
import crypto from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

/** RFC 4648 base32 (no padding) — how authenticator apps take the secret. */
export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error('invalid base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** A new random 160-bit secret, base32. */
export function newTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

/** The code for one 30-second step (`digits` long; RFC test vectors use 8). */
export function totpCode(secretBase32: string, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', base32Decode(secretBase32)).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export function totpCounter(now = Date.now()): number {
  return Math.floor(now / 1000 / TOTP_STEP_SECONDS);
}

/**
 * Check a typed code, allowing one step of clock drift either way. Returns the matched step so
 * the caller can store it and refuse the same code twice (replay), or null. A step at or before
 * `lastUsed` never matches.
 */
export function verifyTotp(secretBase32: string, code: string, lastUsed = 0, now = Date.now()): number | null {
  const typed = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(typed)) return null;
  const current = totpCounter(now);
  for (const c of [current - 1, current, current + 1]) {
    if (c <= lastUsed) continue;
    const expected = totpCode(secretBase32, c);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(typed))) return c;
  }
  return null;
}

/** The otpauth:// link an authenticator app reads (from a QR code or tapped on a phone). */
export function otpauthUrl(issuer: string, account: string, secretBase32: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
}
