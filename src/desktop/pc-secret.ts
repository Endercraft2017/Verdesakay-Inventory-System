/**
 * The installed PC's own secret (docs/OFFLINE-FIRST.md §19, phase 3f). The desktop shell keeps a
 * random secret encrypted with Windows DPAPI for the signed-in Windows user (Electron
 * `safeStorage`) and hands it to the server process as `VDS_PC_SECRET` — it is never written to
 * disk in the clear. With it, the PC's credentials at rest are encrypted:
 *   - the sync token in `sync_remote` (sealed values start with `pc1:`), and
 *   - a site host's certificate private keys (encrypted PKCS#8 PEM, see lan-tls.ts).
 * A copied database or tls folder alone is then useless on another PC / account.
 *
 * Without the shell (a developer running the server directly) there is no secret and values stay
 * as they were — readable, as before this phase.
 */
import crypto from 'node:crypto';

const PREFIX = 'pc1:';

function key(): Buffer | null {
  const s = process.env.VDS_PC_SECRET;
  return s ? crypto.createHash('sha256').update(`verdesakay-pc-secret:${s}`).digest() : null;
}

export function hasPcSecret(): boolean {
  return !!process.env.VDS_PC_SECRET;
}

/** A passphrase for private keys on disk (undefined without a PC secret). */
export function keyPassphrase(): string | undefined {
  const k = key();
  return k ? k.toString('base64') : undefined;
}

/** Encrypt a credential for this PC (AES-256-GCM), or leave it as is without a PC secret. */
export function sealForPc(plain: string): string {
  const k = key();
  if (!k) return plain;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return PREFIX + [iv, c.getAuthTag(), ct].map((b) => b.toString('base64')).join(':');
}

export function isSealed(value: string): boolean {
  return value.startsWith(PREFIX);
}

/** Decrypt a credential sealed for this PC; a plain (older / dev) value is returned unchanged. */
export function openForPc(value: string): string {
  if (!isSealed(value)) return value;
  const k = key();
  if (!k) throw new Error('This PC\'s stored credentials are encrypted; start it from the Verdesakay desktop app.');
  const [iv, tag, ct] = value.slice(PREFIX.length).split(':').map((p) => Buffer.from(p, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', k, iv!);
  d.setAuthTag(tag!);
  return Buffer.concat([d.update(ct!), d.final()]).toString('utf8');
}
