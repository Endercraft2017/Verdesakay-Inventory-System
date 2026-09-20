/** AI email tool — `send_email`. Gated on the `mail.send` permission; sends via
    the configured company mailbox (src/mailer.ts) and records to `mail_log`. */
import { sendMail } from '../../shared/mailer';
import type { CerebrasTool, ToolResult } from './ai-tools';
import type { AuthUser } from '../../shared/types';

const SPEC: CerebrasTool = {
  type: 'function',
  function: {
    name: 'send_email',
    description:
      'Send an email through the company mailbox. Use only when the user explicitly asks to email someone. After sending, tell the user the recipient, subject, and a one-line summary of what went out.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address.' },
        subject: { type: 'string' },
        body: { type: 'string', description: 'Plain-text message body.' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
};

export function mailToolsForUser(user: AuthUser): CerebrasTool[] {
  return user.permissions.includes('mail.send') ? [SPEC] : [];
}

export function isMailTool(name: string): boolean {
  return name === 'send_email';
}

export async function executeMailTool(name: string, args: unknown, user: AuthUser): Promise<ToolResult> {
  if (name !== 'send_email') return { success: false, error: `Unknown tool: ${name}` };
  if (!user.permissions.includes('mail.send')) return { success: false, error: 'Permission denied.' };

  const a = (args ?? {}) as Record<string, unknown>;
  const to = typeof a.to === 'string' ? a.to.trim() : '';
  const subject = typeof a.subject === 'string' ? a.subject.trim() : '';
  const body = typeof a.body === 'string' ? a.body : '';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return { success: false, error: 'A valid "to" email address is required.' };
  if (!subject) return { success: false, error: 'A subject is required.' };
  if (!body.trim()) return { success: false, error: 'A message body is required.' };

  const r = await sendMail({ to, subject, text: body }, user.id);
  return r.ok
    ? { success: true, data: { sent: true, to, subject, message_id: r.id } }
    : { success: false, error: r.error };
}
