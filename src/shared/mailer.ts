/**
 * Email sending. BYO-SMTP model: an admin configures the company's own mailbox
 * (Gmail / M365 / host SMTP) in Email settings; nothing is sent until they do.
 * Config lives in the `settings` k/v store (so it's per-tenant for free once
 * multi-tenancy lands); the SMTP password is encrypted at rest (src/secrets.ts).
 * Every send is recorded in `mail_log`.
 */
import nodemailer from 'nodemailer';
import { getSetting, setSetting, run, queryAll } from './db';
import { encryptSecret, decryptSecret } from './secrets';
import type { MailSettings, MailLogRow } from './types';

const KEY = 'mail_settings';
const PASS_KEY = 'mail_smtp_pass';

const DEFAULTS: MailSettings = {
  transport: 'off',
  from_name: '',
  from_email: '',
  reply_to: '',
  smtp_host: '',
  smtp_port: 587,
  smtp_secure: false,
  smtp_user: '',
};

export function getMailSettings(): MailSettings & { has_password: boolean } {
  const s = { ...DEFAULTS, ...(getSetting<Partial<MailSettings>>(KEY) || {}) };
  return { ...s, has_password: !!getSetting<string>(PASS_KEY) };
}

/** Enough config present to attempt a send? */
export function mailReady(): boolean {
  const s = getMailSettings();
  return s.transport === 'smtp' && !!s.smtp_host && !!s.from_email;
}

export function saveMailSettings(input: MailSettings & { smtp_pass?: string }): void {
  const { smtp_pass, ...rest } = input;
  setSetting(KEY, rest);
  if (typeof smtp_pass === 'string') {
    // present but empty ⇒ clear; non-empty ⇒ replace; undefined ⇒ leave as-is
    setSetting(PASS_KEY, smtp_pass ? encryptSecret(smtp_pass) : '');
  }
}

function buildTransport(): nodemailer.Transporter {
  if (process.env.NODE_ENV === 'test') {
    return nodemailer.createTransport({ jsonTransport: true });
  }
  const s = getMailSettings();
  const pass = decryptSecret(getSetting<string>(PASS_KEY) || '');
  return nodemailer.createTransport({
    host: s.smtp_host,
    port: s.smtp_port,
    secure: s.smtp_secure,
    auth: s.smtp_user ? { user: s.smtp_user, pass } : undefined,
  });
}

export interface SendArgs {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  attachments?: Array<{ filename: string; path?: string; content?: Buffer }>;
}

export async function sendMail(
  args: SendArgs,
  actorId?: number | null
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const s = getMailSettings();
  const from = s.from_name ? `"${s.from_name.replace(/"/g, '')}" <${s.from_email}>` : s.from_email;

  let ok = false;
  let id: string | undefined;
  let error: string | undefined;

  if (!mailReady()) {
    error = 'Email is not configured. An admin can set it up under Email → Settings.';
  } else {
    try {
      const info = await buildTransport().sendMail({
        from,
        to: args.to,
        subject: args.subject,
        text: args.text,
        html: args.html,
        replyTo: s.reply_to || undefined,
        attachments: args.attachments,
      });
      ok = true;
      id = info.messageId;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  run(
    'INSERT INTO mail_log (to_addr, subject, status, provider_id, error, sent_by) VALUES (?, ?, ?, ?, ?, ?)',
    args.to,
    args.subject,
    ok ? 'sent' : 'failed',
    id ?? null,
    error ?? null,
    actorId ?? null
  );

  return ok ? { ok, id } : { ok, error };
}

/** Open an SMTP connection and check the credentials without sending. */
export async function verifyMailSettings(): Promise<{ ok: boolean; error?: string }> {
  if (process.env.NODE_ENV === 'test') return { ok: true };
  if (!mailReady()) return { ok: false, error: 'Fill in the SMTP host and From address first.' };
  try {
    await buildTransport().verify();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function mailLog(limit = 50, offset = 0): MailLogRow[] {
  return queryAll<MailLogRow>(
    `SELECT m.*, u.full_name AS sent_by_name
     FROM mail_log m LEFT JOIN users u ON u.id = m.sent_by
     ORDER BY m.id DESC LIMIT ? OFFSET ?`,
    limit,
    offset
  );
}
