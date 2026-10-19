/** Owner alerts: catalog-local transactional intent; provider I/O only after durable claim. */
import { randomUUID } from 'node:crypto';
import { getInquiry } from './inquiries';
import { getPayment, getInvoice } from './billing';
import type { AlertKind } from './platform-mail';
import { platformDb, getTenant } from './platform';
import { consoleUrl, getPlatformMail, platformMailBinding, deliverPlatformMail, recordPlatformMail } from './platform-mail';

type Job = { id: string; tenant_slug: string; recipients: string; subject: string; body: string;
  configuration_stamp: string; event_key: string; attempts: number; claimed_at: number };
const DAY = 86_400_000;
// Old app versions only understand the signup table. Never let them consume new event kinds.
const TABLES = ['platform_owner_outbox','platform_business_outbox'] as const;

/** Call outside rollbackable publication: warms mailbox schema without retaining a stale DDL cache. */
export function prepareOwnerAlerts(): void { getPlatformMail(); }

/** Trusted catalog-only publication callback; disabled mail or absent recipients do not queue historical alerts. */
export function enqueueSignupAlert(slug: string, subject: string, lines: string[]): undefined {
  return enqueueOwnerAlert('signup', slug, slug, subject, lines);
}

export function enqueueOwnerAlert(kind: AlertKind, source: number | string, slug: string, subject: string, lines: string[]): undefined {
  if (kind !== 'signup' && (!Number.isSafeInteger(source) || Number(source) <= 0)) throw new Error('Invalid alert source');
  const binding = platformMailBinding();
  const s = binding.settings;
  if (!s[`alert_${kind}`] || s.transport === 'off' || !s.alert_to.trim()) return;
  const now = Date.now();
  const table = kind === 'signup' ? TABLES[0] : TABLES[1];
  platformDb().prepare(`INSERT INTO ${table}
    (id,event_key,tenant_slug,recipients,subject,body,configuration_stamp,state,next_attempt_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,'pending',?,?,?)`).run(randomUUID(), kind + ':' + source, slug, JSON.stringify(s.alert_to.split(',').map(a => a.trim()).filter(Boolean)),
      subject, `${lines.filter(Boolean).join('\n')}\n\nOpen the owner console: ${consoleUrl()}\n`, binding.stamp, now, now, now);
}

export function maintainOwnerAlerts(): void {
  const now = Date.now(), d = platformDb();
  for (const table of TABLES) {
    // Never steal and resend a claim: a dead process may have reached the provider.
    d.prepare(`UPDATE ${table} SET state='unknown',error_code='interrupted_send',updated_at=?
      WHERE state='inflight' AND claimed_at<=?`).run(now, now - 120_000);
    d.prepare(`UPDATE ${table} SET state='cancelled',error_code='event_expired',updated_at=?
      WHERE state IN ('pending','retry') AND created_at<=?`).run(now, now - 7 * DAY);
    d.prepare(`UPDATE ${table} SET recipients=NULL,subject=NULL,body=NULL,configuration_stamp=NULL
      WHERE body IS NOT NULL AND (created_at<=? OR (state IN ('accepted','blocked','unknown','cancelled') AND updated_at<=?))`)
      .run(now - 7 * DAY, now - DAY);
  }
}

export async function processOneOwnerAlert(): Promise<boolean> {
  maintainOwnerAlerts();
  const now = Date.now(), d = platformDb();
  // Read candidate IDs, then claim with an atomic guarded UPDATE. A competing worker may win;
  // this pass then does no send. No transaction or catalog lock spans provider I/O.
  const candidates = TABLES.flatMap(table => {
    const row = d.prepare(`SELECT id,next_attempt_at,created_at FROM ${table} WHERE state IN ('pending','retry')
      AND next_attempt_at<=? AND attempts<5 ORDER BY next_attempt_at,created_at,id LIMIT 1`).get(now);
    return row ? [{table,id:String(row.id),due:Number(row.next_attempt_at),created:Number(row.created_at)}] : [];
  }).sort((a,b) => a.due-b.due || a.created-b.created || a.id.localeCompare(b.id));
  const candidate = candidates[0];
  if (!candidate) return false;
  const table = candidate.table;
  const job = d.prepare(`UPDATE ${table} SET state='inflight',attempts=attempts+1,claimed_at=?,updated_at=?
    WHERE id=? AND state IN ('pending','retry') AND next_attempt_at<=? AND attempts<5 RETURNING *`)
    .get(now, now, candidate.id, now) as Job | undefined;
  if (!job) return false;
  const source = alertSource(job.event_key);
  const tenant = job.tenant_slug ? getTenant(job.tenant_slug) : null;
  let available = false;
  if (source.kind === 'signup') available = !!tenant && tenant.status !== 'purged';
  if (source.kind === 'inquiry') available = job.tenant_slug === '' && !!getInquiry(source.id!);
  if (source.kind === 'payment' && tenant && tenant.status !== 'purged') {
    const payment = getPayment(source.id!);
    const invoice = payment ? getInvoice(payment.invoice_id) : null;
    available = payment?.status === 'pending' && invoice?.tenant_slug === job.tenant_slug;
  }
  const message = { to: JSON.parse(job.recipients) as string[], subject: job.subject, text: job.body, kind: source.kind ?? 'unknown' };
  // An unexpected exception leaves an inflight claim for conservative interruption handling.
  const result = !available ? { outcome: 'cancelled' as const, code: source.kind === 'signup' ? 'workspace_unavailable' : 'source_unavailable' }
    : await deliverPlatformMail(message, job.configuration_stamp);
  const retryAfterMs = 'retryAfterMs' in result ? result.retryAfterMs ?? 0 : 0;
  const state = result.outcome === 'retry' && job.attempts >= 5 ? 'blocked' : result.outcome;
  const code = result.outcome === 'retry' && job.attempts >= 5 ? 'retry_limit' : result.code;
  d.exec('SAVEPOINT owner_alert_result');
  try {
    const saved = d.prepare(`UPDATE ${table} SET state=?,error_code=?,next_attempt_at=?,updated_at=?
      WHERE id=? AND state='inflight' AND claimed_at=? AND attempts=?`)
      .run(state, code, Date.now() + Math.max(retryAfterMs, Math.min(3_600_000, 60_000 * 2 ** (job.attempts - 1))), Date.now(), job.id, job.claimed_at, job.attempts);
    if (saved.changes === 1) recordPlatformMail(message, result);
    d.exec('RELEASE owner_alert_result');
  } catch (error) {
    d.exec('ROLLBACK TO owner_alert_result'); d.exec('RELEASE owner_alert_result'); throw error;
  }
  return true;
}

function alertSource(key: string): { kind: AlertKind | null; id?: number } {
  if (/^signup:[a-z0-9][a-z0-9-]*$/.test(key)) return {kind:'signup'};
  const match = /^(inquiry|payment):([1-9][0-9]*)$/.exec(key);
  const id = match ? Number(match[2]) : 0;
  return match && Number.isSafeInteger(id) ? {kind:match[1] as AlertKind,id} : {kind:null};
}

export function ownerAlertStatus() {
  const rows = platformDb().prepare(`SELECT id,event_key,tenant_slug,state,attempts,error_code,created_at,updated_at
    FROM (SELECT id,event_key,tenant_slug,state,attempts,error_code,created_at,updated_at FROM platform_owner_outbox
      UNION ALL SELECT id,event_key,tenant_slug,state,attempts,error_code,created_at,updated_at FROM platform_business_outbox)
    ORDER BY created_at DESC,id LIMIT 30`).all() as Array<{id:string;event_key:string;tenant_slug:string;state:string;attempts:number;error_code:string|null;created_at:number;updated_at:number}>;
  return rows.map(({event_key,...row}) => {
    const source = alertSource(String(event_key));
    return {...row,kind:source.kind,source_id:source.id ?? null};
  });
}
