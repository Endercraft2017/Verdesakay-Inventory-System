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
 * Alerts never block or fail the request that triggered them; each attempt lands in the log.
 */
import crypto from 'node:crypto';
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

export function getPlatformMail(): PlatformMailSettings & { has_secret: boolean } {
  let s: Partial<PlatformMailSettings> = {};
  try { s = JSON.parse(getKv('settings') || '{}'); } catch { s = {}; }
  return { ...DEFAULTS, ...s, has_secret: !!getKv('secret') };
}

/** `secret`: present-but-empty clears it, a value replaces it, undefined leaves it. */
export function savePlatformMail(input: Partial<PlatformMailSettings>, secret?: string): PlatformMailSettings & { has_secret: boolean } {
  const { has_secret: _drop, ...cur } = getPlatformMail();
  setKv('settings', JSON.stringify({ ...cur, ...input }));
  if (typeof secret === 'string') setKv('secret', secret ? encryptWithKey(keyMaterial(), secret) : '');
  return getPlatformMail();
}

function secret(): string { return decryptWithKey(keyMaterial(), getKv('secret') || ''); }

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

export async function sendPlatformMail(args: { to: string[]; subject: string; text: string; kind?: string }): Promise<{ ok: boolean; error?: string }> {
  const s = getPlatformMail();
  const to = args.to.map((a) => a.trim()).filter(Boolean);
  let error: string | null = to.length ? mailProblem(s) : 'No recipient.';
  if (!error) {
    try {
      if (process.env.NODE_ENV === 'test') {
        _testOutbox.push({ to, subject: args.subject, text: args.text });
      } else if (s.transport === 'brevo') {
        const res = await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: { 'api-key': secret(), 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            sender: { name: s.from_name || 'OTOM', email: s.from_email },
            to: to.map((email) => ({ email })),
            subject: args.subject,
            textContent: args.text,
          }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({})) as { message?: string };
          throw new Error(`Brevo ${res.status}: ${body.message || res.statusText}`);
        }
      } else {
        const t = nodemailer.createTransport({
          host: s.smtp_host, port: s.smtp_port, secure: s.smtp_secure,
          auth: s.smtp_user ? { user: s.smtp_user, pass: secret() } : undefined,
          connectionTimeout: 15_000, greetingTimeout: 15_000,
        });
        await t.sendMail({ from: s.from_name ? `"${s.from_name.replace(/"/g, '')}" <${s.from_email}>` : s.from_email, to, subject: args.subject, text: args.text });
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      // Railway (below Pro) drops outgoing SMTP; say so rather than a bare timeout.
      if (s.transport === 'smtp' && /ETIMEDOUT|ECONNREFUSED|ENETUNREACH|timeout/i.test(error)) {
        error += ' — your host may block outgoing SMTP (Railway does below the Pro plan). Use Brevo instead.';
      }
    }
  }
  db().prepare('INSERT INTO platform_mail_log (to_addr, subject, kind, status, error) VALUES (?, ?, ?, ?, ?)')
    .run(to.join(', ') || '(none)', args.subject, args.kind ?? null, error ? 'failed' : 'sent', error);
  return error ? { ok: false, error } : { ok: true };
}

export function platformMailLog(limit = 30) {
  return db().prepare('SELECT * FROM platform_mail_log ORDER BY id DESC LIMIT ?').all(limit);
}

/** Where the owner console lives, for links in alerts. */
function consoleUrl(): string {
  const host = platformHost() || (process.env.TENANT_PATH_HOST || '').trim();
  return host ? `https://${host}/_platform/` : '/_platform/';
}

/** Tell the owner something happened — if that alert is on and email is set up. Never throws. */
export async function notifyOwner(kind: AlertKind, subject: string, lines: string[]): Promise<void> {
  try {
    const s = getPlatformMail();
    const on = kind === 'inquiry' ? s.alert_inquiry : kind === 'payment' ? s.alert_payment : s.alert_signup;
    if (!on || s.transport === 'off' || !s.alert_to.trim()) return;
    await sendPlatformMail({
      to: s.alert_to.split(','), subject, kind,
      text: `${lines.filter(Boolean).join('\n')}\n\nOpen the owner console: ${consoleUrl()}\n`,
    });
  } catch (e) {
    console.error(`[platform-mail] ${kind} alert failed: ${(e as Error).message}`);
  }
}
