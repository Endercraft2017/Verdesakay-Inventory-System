/**
 * The platform's own mailbox (docs/SAAS-READINESS.md §12) — separate from each workspace's
 * BYO-SMTP (src/shared/mailer.ts). Used to alert the owner: a new website inquiry, a payment a
 * customer reported, a self-serve sign-up. Lives in `platform.db`; the secret (Brevo API key or
 * SMTP password) is encrypted with MAIL_SECRET_KEY / APP_SECRET when set, else a random key kept
 * in platform.db.
 *
 * Two transports, because Railway blocks outgoing SMTP below its Pro plan:
 *  - `brevo` — Brevo's HTTPS email API (works on any host; free tier ~300 emails/day);
 *  - `smtp`  — any SMTP mailbox (e.g. Gmail with an App Password), where the host allows SMTP.
 * Signup, inquiry and reported-payment intent commits through the
 * owner-alert outbox; its worker records provider acceptance separately from inbox delivery.
 */
import crypto from 'node:crypto';
import { Socket } from 'node:net';
import nodemailer from 'nodemailer';
import type { DatabaseSync } from 'node:sqlite';
import { platformDb, platformHost } from './platform';
import { encryptWithKey, decryptWithKey } from '../shared/secrets';

export type MailTransport = 'off' | 'brevo' | 'smtp';
export type AlertKind = 'inquiry' | 'payment' | 'signup';

export interface PlatformMailSettings {
  transport: MailTransport;
  from_name: string;
  from_email: string;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: boolean;
  smtp_user: string;
  /** Who gets the alerts: one or more addresses, comma-separated. */
  alert_to: string;
  alert_inquiry: boolean;
  alert_payment: boolean;
  alert_signup: boolean;
}

const DEFAULTS: PlatformMailSettings = {
  transport: 'off', from_name: 'OTOM', from_email: '', smtp_host: '', smtp_port: 587, smtp_secure: false,
  smtp_user: '', alert_to: '', alert_inquiry: true, alert_payment: true, alert_signup: true,
};

const ready = new WeakSet<DatabaseSync>();
function db(): DatabaseSync {
  const d = platformDb();
  if (ready.has(d)) return d;
  d.exec(`
    CREATE TABLE IF NOT EXISTS platform_mail (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS platform_mail_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      to_addr    TEXT NOT NULL,
      subject    TEXT NOT NULL,
      kind       TEXT,
      status     TEXT NOT NULL CHECK (status IN ('sent','failed')),
      error      TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  ready.add(d);
  return d;
}

function getKv(key: string): string | null {
  return (db().prepare('SELECT value FROM platform_mail WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
}
function setKv(key: string, value: string): void {
  db().prepare('INSERT INTO platform_mail (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

/** MAIL_SECRET_KEY / APP_SECRET when set; otherwise a random key generated once into platform.db. */
function keyMaterial(): string {
  const env = process.env.MAIL_SECRET_KEY || process.env.APP_SECRET;
  if (env) return env;
  let k = getKv('_key');
  if (!k) { k = crypto.randomBytes(32).toString('base64'); setKv('_key', k); }
  return k;
}

/** One SELECT is one SQLite snapshot: never pair another generation's host and credential. */
function captureMailConfiguration() {
  const rows = db().prepare("SELECT key,value FROM platform_mail WHERE key IN ('settings','secret','_key')").all() as Array<{key:string;value:string}>;
  const values = Object.fromEntries(rows.map(row => [row.key,row.value]));
  let patch: Partial<PlatformMailSettings> = {};
  try { patch = JSON.parse(values.settings || '{}'); } catch { /* use defaults */ }
  const encoded = values.secret || '';
  return { settings: {...DEFAULTS,...patch,has_secret:!!encoded}, encoded,
    key: process.env.MAIL_SECRET_KEY || process.env.APP_SECRET || values._key || '' };
}

export function getPlatformMail(): PlatformMailSettings & { has_secret: boolean } {
  return captureMailConfiguration().settings;
}

/** `secret`: present-but-empty clears it, a value replaces it, undefined leaves it. */
export function savePlatformMail(input: Partial<PlatformMailSettings>, secret?: string): PlatformMailSettings & { has_secret: boolean } {
  const d = db(); // Warm schema before the rollbackable write.
  d.exec('SAVEPOINT platform_mail_update');
  try {
    d.prepare("UPDATE platform_mail SET value=value WHERE key='settings'").run(); // Writer before read/merge.
    const {has_secret:_drop,...cur} = getPlatformMail();
    setKv('settings',JSON.stringify({...cur,...input}));
    if (typeof secret === 'string') setKv('secret',secret ? encryptWithKey(keyMaterial(),secret) : '');
    const result = getPlatformMail();
    d.exec('RELEASE platform_mail_update');
    return result;
  } catch(error) { d.exec('ROLLBACK TO platform_mail_update');d.exec('RELEASE platform_mail_update');throw error; }
}

/** Configured enough to try sending? Returns why not, or null. */
export function mailProblem(s = getPlatformMail()): string | null {
  if (s.transport === 'off') return 'Email is off.';
  if (!s.from_email) return 'Set the From address.';
  if (!s.has_secret) return s.transport === 'brevo' ? 'Paste the Brevo API key.' : 'Enter the SMTP password.';
  if (s.transport === 'smtp' && !s.smtp_host) return 'Set the SMTP server.';
  return null;
}

/** Messages "sent" while NODE_ENV=test (nothing leaves the machine). */
export const _testOutbox: Array<{ to: string[]; subject: string; text: string }> = [];

export type PlatformMailMessage = { to: string[]; subject: string; text: string; kind?: string };
export type MailDelivery = { outcome: 'accepted' | 'retry' | 'blocked' | 'unknown' | 'cancelled'; code: string | null; retryAfterMs?: number };

/** Snapshot recipients/policy and their encrypted credential generation in one read. */
export function platformMailBinding() {
  const c = captureMailConfiguration();
  return {settings:c.settings,stamp:configurationStamp(c)};
}
function configurationStamp(c: ReturnType<typeof captureMailConfiguration>): string {
  return crypto.createHash('sha256').update(JSON.stringify(c.settings)).update(c.encoded).digest('hex');
}

function retryDelay(value: string | null): number {
  if (!value) return 0;
  const delay = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  // Even a longer delay cannot send early: the event expires after seven days.
  return Number.isFinite(delay) && delay > 0 ? Math.min(7 * 86_400_000, delay) : 0;
}

/** No log/queue writes here: the caller records acceptance atomically with its own state. */
export async function deliverPlatformMail(args: PlatformMailMessage, expectedStamp?: string): Promise<MailDelivery> {
  const captured = captureMailConfiguration();
  const s = captured.settings;
  if (expectedStamp && configurationStamp(captured) !== expectedStamp) return { outcome: 'cancelled', code: 'configuration_changed' };
  const to = args.to.map(a => a.trim()).filter(Boolean);
  if (!to.length || mailProblem(s)) return { outcome: 'blocked', code: 'mail_not_ready' };
  // Resolve credentials before transmission. No provider/body/exception diagnostics are public.
  let credential: string;
  try { credential = captured.key ? decryptWithKey(captured.key,captured.encoded) : ''; } catch { return { outcome: 'blocked', code: 'credential_unavailable' }; }
  if (!credential) return { outcome: 'blocked', code: 'credential_unavailable' };
  if (process.env.NODE_ENV === 'test') {
    _testOutbox.push({ to, subject: args.subject, text: args.text });
    return { outcome: 'accepted', code: null };
  }
  try {
    if (s.transport === 'brevo') {
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': credential, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ sender: { name: s.from_name || 'OTOM', email: s.from_email },
          to: to.map(email => ({ email })), subject: args.subject, textContent: args.text }),
        signal: AbortSignal.timeout(15_000), redirect: 'error',
      });
      // A documented rejection is safe to retry; never infer rejection from a timeout or 5xx.
      const result: MailDelivery = res.status === 201 ? { outcome: 'accepted', code: null }
        : res.status === 429 ? { outcome: 'retry', code: 'rate_limited', retryAfterMs: retryDelay(res.headers.get('retry-after')) }
        : res.status >= 400 && res.status < 500 ? { outcome: 'blocked', code: 'provider_rejected' }
        : { outcome: 'unknown', code: 'provider_outcome_unknown' };
      try { await res.body?.cancel(); } catch { /* outcome already determined by HTTP status */ }
      return result;
    }
    // Own the socket: Nodemailer's non-pooled transport.close() does not abort active I/O.
    const socket = new Socket();
    const transport = nodemailer.createTransport({ socket, host: s.smtp_host, port: s.smtp_port, secure: s.smtp_secure, requireTLS: !s.smtp_secure,
      auth: s.smtp_user ? { user: s.smtp_user, pass: credential } : undefined,
      connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 15_000, dnsTimeout: 15_000 });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        transport.sendMail({ from: s.from_name ? `"${s.from_name.replace(/"/g, '')}" <${s.from_email}>` : s.from_email,
          to, subject: args.subject, text: args.text }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Mail deadline')), 45_000); }),
      ]);
      // Partial recipient acceptance is uncertain as a whole: do not resend to accepted addresses.
      const accepted = (result.accepted || []).map(a => String(a).trim().toLowerCase());
      return to.every(a => accepted.includes(a.toLowerCase())) && !(result.rejected || []).length
        ? { outcome: 'accepted', code: null } : { outcome: 'unknown', code: 'recipient_outcome_unknown' };
    } finally { if (timer) clearTimeout(timer); socket.destroy(); transport.close(); }
  } catch { return { outcome: 'unknown', code: 'provider_outcome_unknown' }; }
}

export function recordPlatformMail(args: PlatformMailMessage, result: MailDelivery): void {
  db().prepare('INSERT INTO platform_mail_log (to_addr, subject, kind, status, error) VALUES (?, ?, ?, ?, ?)')
    .run(args.to.join(', ') || '(none)', args.subject, args.kind ?? null, result.outcome === 'accepted' ? 'sent' : 'failed', result.code);
}

/** Console test mail; business alerts use the durable outbox. */
export async function sendPlatformMail(args: PlatformMailMessage): Promise<{ ok: boolean; error?: string }> {
  const result = await deliverPlatformMail(args);
  recordPlatformMail(args, result);
  return result.outcome === 'accepted' ? { ok: true } : { ok: false, error: 'Email was not confirmed. Check the delivery status before sending again.' };
}

export function platformMailLog(limit = 30) {
  return db().prepare('SELECT * FROM platform_mail_log ORDER BY id DESC LIMIT ?').all(limit);
}

/** Where the owner console lives, for links in alerts. */
export function consoleUrl(): string {
  const host = platformHost() || (process.env.TENANT_PATH_HOST || '').trim();
  return host ? `https://${host}/_platform/` : '/_platform/';
}
