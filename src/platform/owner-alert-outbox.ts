/** Signup alerts: catalog-local transactional intent; provider I/O only after durable claim. */
import { randomUUID } from 'node:crypto';
import { platformDb, getTenant } from './platform';
import { consoleUrl, getPlatformMail, platformMailStamp, deliverPlatformMail, recordPlatformMail } from './platform-mail';

type Job = { id: string; tenant_slug: string; recipients: string; subject: string; body: string;
  configuration_stamp: string; attempts: number; claimed_at: number };
const DAY = 86_400_000;

/** Call outside rollbackable publication: warms mailbox schema without retaining a stale DDL cache. */
export function prepareOwnerAlerts(): void { getPlatformMail(); }

/** Trusted catalog-only publication callback; disabled mail or absent recipients do not queue historical alerts. */
export function enqueueSignupAlert(slug: string, subject: string, lines: string[]): undefined {
  const s = getPlatformMail();
  if (!s.alert_signup || s.transport === 'off' || !s.alert_to.trim()) return;
  const now = Date.now();
  platformDb().prepare(`INSERT INTO platform_owner_outbox
    (id,event_key,tenant_slug,recipients,subject,body,configuration_stamp,state,next_attempt_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,'pending',?,?,?)`).run(randomUUID(), 'signup:' + slug, slug, JSON.stringify(s.alert_to.split(',').map(a => a.trim()).filter(Boolean)),
      subject, `${lines.filter(Boolean).join('\n')}\n\nOpen the owner console: ${consoleUrl()}\n`, platformMailStamp(), now, now, now);
}

export function maintainOwnerAlerts(): void {
  const now = Date.now(), d = platformDb();
  // Never steal and resend a claim: a dead process may have reached the provider.
  d.prepare(`UPDATE platform_owner_outbox SET state='unknown',error_code='interrupted_send',updated_at=?
    WHERE state='inflight' AND claimed_at<=?`).run(now, now - 120_000);
  d.prepare(`UPDATE platform_owner_outbox SET state='cancelled',error_code='event_expired',updated_at=?
    WHERE state IN ('pending','retry') AND created_at<=?`).run(now, now - 7 * DAY);
  d.prepare(`UPDATE platform_owner_outbox SET recipients=NULL,subject=NULL,body=NULL,configuration_stamp=NULL
    WHERE body IS NOT NULL AND (created_at<=? OR (state IN ('accepted','blocked','unknown','cancelled') AND updated_at<=?))`)
    .run(now - 7 * DAY, now - DAY);
}

export async function processOneOwnerAlert(): Promise<boolean> {
  maintainOwnerAlerts();
  const now = Date.now(), d = platformDb();
  // UPDATE RETURNING atomically claims across processes. No transaction spans the provider call.
  const job = d.prepare(`UPDATE platform_owner_outbox SET state='inflight',attempts=attempts+1,claimed_at=?,updated_at=?
    WHERE id=(SELECT id FROM platform_owner_outbox WHERE state IN ('pending','retry') AND next_attempt_at<=?
      AND attempts<5 ORDER BY next_attempt_at,created_at,id LIMIT 1) AND state IN ('pending','retry') RETURNING *`)
    .get(now, now, now) as Job | undefined;
  if (!job) return false;
  const tenant = getTenant(job.tenant_slug);
  const message = { to: JSON.parse(job.recipients) as string[], subject: job.subject, text: job.body, kind: 'signup' };
  // An unexpected exception leaves an inflight claim for conservative interruption handling.
  const result = !tenant || tenant.status === 'purged' ? { outcome: 'cancelled' as const, code: 'workspace_unavailable' }
    : await deliverPlatformMail(message, job.configuration_stamp);
  const retryAfterMs = 'retryAfterMs' in result ? result.retryAfterMs ?? 0 : 0;
  const state = result.outcome === 'retry' && job.attempts >= 5 ? 'blocked' : result.outcome;
  const code = result.outcome === 'retry' && job.attempts >= 5 ? 'retry_limit' : result.code;
  d.exec('SAVEPOINT owner_alert_result');
  try {
    const saved = d.prepare(`UPDATE platform_owner_outbox SET state=?,error_code=?,next_attempt_at=?,updated_at=?
      WHERE id=? AND state='inflight' AND claimed_at=? AND attempts=?`)
      .run(state, code, Date.now() + Math.max(retryAfterMs, Math.min(3_600_000, 60_000 * 2 ** (job.attempts - 1))), Date.now(), job.id, job.claimed_at, job.attempts);
    if (saved.changes === 1) recordPlatformMail(message, result);
    d.exec('RELEASE owner_alert_result');
  } catch (error) {
    d.exec('ROLLBACK TO owner_alert_result'); d.exec('RELEASE owner_alert_result'); throw error;
  }
  return true;
}

export function ownerAlertStatus() {
  return platformDb().prepare(`SELECT id,tenant_slug,state,attempts,error_code,created_at,updated_at
    FROM platform_owner_outbox ORDER BY created_at DESC,id LIMIT 30`).all();
}
