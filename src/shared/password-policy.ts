/**
 * Rules for every newly set password (OWASP ASVS 5.0 §6.2): 8–128 characters and not one of the
 * common passwords people try first. Existing passwords keep working; the rules apply whenever a
 * password is set (account creation, change, reset, workspace provisioning).
 *
 * common-passwords.txt: the entries of 8+ characters from SecLists'
 * Passwords/Common-Credentials/10k-most-common.txt, lowercased (2,087 lines). Shorter entries
 * already fail the length rule.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

let common: Set<string> | null = null;

/** True when the password (case-insensitively) is on the common-passwords list. */
export function isCommonPassword(password: string): boolean {
  if (!common) {
    common = new Set(fs.readFileSync(path.join(import.meta.dirname, 'common-passwords.txt'), 'utf8')
      .split(/\r?\n/).filter(Boolean));
  }
  return common.has(password.toLowerCase());
}

/** Zod schema for a password being set; `label` names the field in the error message. */
export function newPasswordSchema(label = 'Password') {
  return z.string()
    .min(PASSWORD_MIN, `${label} must be at least ${PASSWORD_MIN} characters`)
    .max(PASSWORD_MAX, `${label} must be at most ${PASSWORD_MAX} characters`)
    .refine((pw) => !isCommonPassword(pw), `${label} is one of the most common passwords — choose one that is harder to guess`);
}
