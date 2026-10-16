/**
 * Rules for newly set passwords: 15–128 Unicode code points and not one of the
 * common passwords people try first. Existing passwords keep working; the rules apply whenever a
 * password is set (account creation, change, reset, workspace provisioning).
 * Based on the NIST SP 800-63B-4 password-only minimum; applies even when MFA is optional.
 * This is not a complete standards-conformance claim. Storage uses password-hash.ts with bounded
 * bcrypt compatibility (docs/operations/password-migration.md).
 *
 * common-passwords.txt: the entries of 8+ characters from SecLists'
 * Passwords/Common-Credentials/10k-most-common.txt, lowercased (2,087 lines). Shorter entries
 * already fail the length rule. Exact common long repeats/sequences are supplemented below.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export const PASSWORD_MIN = 15;
export const PASSWORD_MAX = 128;

// Whole-value matches only: these are blocklist entries, never composition rules.
const COMMON_LONG_PASSWORDS = [
  'passwordpassword', 'passwordpassword1', 'passwordpassword123',
  '123456789012345', '1234567890123456', '12345678901234567',
  '123456789012345678', '1234567890123456789', '12345678901234567890',
  'qwertyuiopasdfgh', 'qwertyuiopasdfghjkl', 'qwertyuiopasdfghjklzxcvbnm',
  'letmeinletmein123', 'iloveyouiloveyou', 'adminadminadmin',
  'aaaaaaaaaaaaaaa', '000000000000000', '111111111111111',
];
let common: Set<string> | null = null;

/** True when the password (case-insensitively) is on the common-passwords list. */
export function isCommonPassword(password: string): boolean {
  if (!common) {
    common = new Set(fs.readFileSync(path.join(import.meta.dirname, 'common-passwords.txt'), 'utf8')
      .split(/\r?\n/).filter(Boolean).concat(COMMON_LONG_PASSWORDS));
  }
  return common.has(password.toLowerCase());
}

/** Zod schema for a password being set; `label` names the field in the error message. */
export function newPasswordSchema(label = 'Password') {
  return z.string()
    .max(PASSWORD_MAX * 2, `${label} must be at most ${PASSWORD_MAX} characters`)
    .refine((pw) => Array.from(pw).length >= PASSWORD_MIN, `${label} must be at least ${PASSWORD_MIN} characters`)
    .refine((pw) => Array.from(pw).length <= PASSWORD_MAX, `${label} must be at most ${PASSWORD_MAX} characters`)
    .refine((pw) => !isCommonPassword(pw), `${label} is one of the most common passwords — choose one that is harder to guess`);
}

/** One policy for HTTP schemas, provisioning, console CLI and environment bootstrap. */
export function passwordPolicyError(password: string, label = 'Password'): string | null {
  const result = newPasswordSchema(label).safeParse(password);
  return result.success ? null : result.error.issues[0]!.message;
}
