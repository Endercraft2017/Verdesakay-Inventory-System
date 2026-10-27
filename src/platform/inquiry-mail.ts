/** Server-only SendFox transport for website inquiry alerts. No fallback retry or live credentials. */
type InquiryMailEnvironment = Record<string, string | undefined>;
type InquiryMail = { subject: string; text: string; replyTo?: string };
type SendResult = { ok: boolean; to: string[]; error?: string; queuedId?: string };

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
function address(value: string): boolean { return value.length <= 254 && EMAIL.test(value); }
function sender(value: string): boolean {
  if (!value || value.length > 320 || /[\r\n]/.test(value)) return false;
  if (address(value)) return true;
  const named = value.match(/^[^<>\r\n]{1,100}\s*<([^<>\r\n]+)>$/);
  return !!named && address(named[1]!.trim());
}
function htmlEscape(value: string): string {
  const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return value.replace(/[&<>"']/g, c => entities[c]!);
}

/** Explicit server configuration opts website inquiry alerts into SendFox. */
export function inquirySendFoxEnabled(env: InquiryMailEnvironment = process.env): boolean {
  return !!env.SENDFOX_API_KEY?.trim();
}

/** A successful result means provider-queued, not confirmed inbox delivery. */
export async function sendSendFoxInquiry(
  args: InquiryMail,
  options: { env?: InquiryMailEnvironment; request?: typeof fetch; dryRun?: boolean } = {},
): Promise<SendResult> {
  const env = options.env ?? process.env;
  const key = env.SENDFOX_API_KEY?.trim() || '';
  const from = env.INQUIRY_FROM?.trim() || '';
  const to = [(env.INQUIRY_TO || 'contact@afkcube.com').trim()];
  const invalid = !key || /[\r\n]/.test(key) || !sender(from) || !address(to[0]!);
  if (invalid) return { ok: false, to, error: 'SendFox inquiry email is not configured correctly.' };
  if (args.replyTo && !address(args.replyTo)) return { ok: false, to, error: 'The inquiry reply address is invalid.' };
  const subject = args.subject.trim().slice(0, 220);
  const text = args.text.trim().slice(0, 12000);
  if (!subject || !text) return { ok: false, to, error: 'The inquiry email is empty.' };
  if (options.dryRun) return { ok: true, to };
  try {
    const response = await (options.request ?? fetch)('https://api.sendfox.com/transactional/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify({ from, to, subject, text,
        html: `<pre style="font-family:system-ui,sans-serif;white-space:pre-wrap">${htmlEscape(text)}</pre>`,
        ...(args.replyTo ? { reply_to: args.replyTo } : {}),
      }),
    });
    // Provider bodies may repeat inquiry content or credentials. Never put them into logs/errors.
    if (!response.ok) return { ok: false, to, error: `SendFox rejected the inquiry email (HTTP ${response.status}).` };
    const queued = await response.json() as { id?: unknown; status?: unknown };
    if (typeof queued?.id !== 'string' || !queued.id.trim() || queued.status !== 'queued') {
      return { ok: false, to, error: 'SendFox did not confirm the inquiry email was queued.' };
    }
    return { ok: true, to, queuedId: queued.id };
  } catch {
    return { ok: false, to, error: 'The SendFox inquiry email request failed.' };
  }
}
