/**
 * Confidential (anonymous) reporting — an identity-free channel, deliberately separate from
 * Messages (identified reports) and Bug Reports (software issues).
 *
 * Anonymity rules this module enforces by construction:
 *  - No reporter identity is stored anywhere: no user id, IP, user agent or session on the
 *    report or its messages. Reporter-side requests are also kept out of the activity log and
 *    the idempotency store (see app.ts / activity.ts / idempotency.ts `isAnonymousReportPath`).
 *  - Dates only (YYYY-MM-DD), never times, so a report can't be lined up against other
 *    timestamped activity (clock punches, logins) to guess who filed it.
 *  - Submitting needs a single-use ticket issued to a signed-in employee (keeps the channel
 *    to real staff), but the ticket row has no user column and the issuing request isn't
 *    logged, so the ticket can't be traced back to who asked for it.
 *  - The reporter follows up with the report number + a one-time access code shown once at
 *    submission; only the code's SHA-256 is stored.
 */
import crypto from 'node:crypto';
import { queryOne, queryAll, run, db } from '../shared/db';
import type { REPORT_STATUSES } from '../shared/validation';

export type ReportStatus = (typeof REPORT_STATUSES)[number];

const TICKET_TTL_MIN = 120;
/** Per signed-in user, per day. Kept in memory only (a DB counter would link users to tickets). */
export const TICKETS_PER_DAY = 10;

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const today = () => new Date().toISOString().slice(0, 10);

/** Human-typeable access code: 20 chars of Crockford base32 (100 bits), grouped 5-5-5-5. */
function newAccessCode(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const bytes = crypto.randomBytes(20);
  let out = '';
  for (let i = 0; i < 20; i++) out += alphabet[bytes[i]! & 31];
  return out.match(/.{5}/g)!.join('-');
}
/** Accept the code with or without dashes/spaces, any case. */
const normalizeCode = (code: string) => code.toUpperCase().replace(/[^0-9A-Z]/g, '');

// ─── Tickets ─────────────────────────────────────────────────────────────────

const issued = new Map<string, { day: string; count: number }>();

/** Issue a single-use submission ticket. `quotaKey` is only used for the in-memory daily cap. */
export function issueTicket(quotaKey: string): { ticket: string; expires_in_minutes: number } | null {
  const day = today();
  const q = issued.get(quotaKey);
  if (q && q.day === day && q.count >= TICKETS_PER_DAY) return null;
  issued.set(quotaKey, { day, count: q && q.day === day ? q.count + 1 : 1 });
  run("DELETE FROM anonymous_report_tickets WHERE expires_at < datetime('now')");
  const ticket = crypto.randomBytes(24).toString('base64url');
  run(
    `INSERT INTO anonymous_report_tickets (token_hash, expires_at) VALUES (?, datetime('now', '+${TICKET_TTL_MIN} minutes'))`,
    sha256(ticket)
  );
  return { ticket, expires_in_minutes: TICKET_TTL_MIN };
}

/** Test hook: reset the in-memory daily ticket counters. */
export function resetTicketQuota(): void { issued.clear(); }

// ─── Reporter side ───────────────────────────────────────────────────────────

export interface NewReport {
  ticket: string; category: string; subject?: string | null; description: string;
  incident_date?: string | null; location?: string | null;
}

export type SubmitResult =
  | { ok: true; number: string; access_code: string }
  | { ok: false; status: number; error: string };

export function submitReport(input: NewReport): SubmitResult {
  db.exec('BEGIN');
  try {
    // Consume the ticket first, in the same transaction, so a ticket can never file twice.
    const used = run(
      "DELETE FROM anonymous_report_tickets WHERE token_hash = ? AND expires_at >= datetime('now')",
      sha256(input.ticket)
    );
    if (used.changes !== 1) {
      db.exec('ROLLBACK');
      return { ok: false, status: 403, error: 'This submission link has expired. Go back and start the report again.' };
    }
    // Numbered from this table, not nextSequence(): that writes settings.updated_at, which
    // would record the exact time of the latest submission.
    const last = queryOne<{ n: number }>('SELECT COALESCE(MAX(id), 0) AS n FROM anonymous_reports');
    const number = `CR-${String((last?.n ?? 0) + 1).padStart(5, '0')}`;
    const accessCode = newAccessCode();
    const day = today();
    run(
      `INSERT INTO anonymous_reports
         (number, category, subject, description, incident_date, location, status, access_hash, created_on, updated_on)
       VALUES (?, ?, ?, ?, ?, ?, 'new', ?, ?, ?)`,
      number, input.category, input.subject || null, input.description,
      input.incident_date || null, input.location || null, sha256(normalizeCode(accessCode)), day, day
    );
    db.exec('COMMIT');
    return { ok: true, number, access_code: accessCode };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

interface ReportRow {
  id: number; number: string; category: string; subject: string | null; description: string;
  incident_date: string | null; location: string | null; status: ReportStatus;
  access_hash: string; created_on: string; updated_on: string;
}
interface MessageRow { id: number; author: 'reporter' | 'handler'; body: string; created_on: string; handler_name?: string | null }

/** Resolve number + access code to the report, or null. Constant-time hash comparison. */
export function findByCode(number: string, accessCode: string): ReportRow | null {
  const row = queryOne<ReportRow>('SELECT * FROM anonymous_reports WHERE number = ?', number.trim().toUpperCase());
  const given = Buffer.from(sha256(normalizeCode(accessCode)), 'hex');
  // Compare against a dummy when the number doesn't exist, so timing doesn't reveal valid numbers.
  const stored = Buffer.from(row?.access_hash ?? sha256('no-such-report'), 'hex');
  const match = crypto.timingSafeEqual(given, stored);
  return row && match ? row : null;
}

function messagesFor(reportId: number, forHandler: boolean): MessageRow[] {
  // The reporter never sees which staff member replied — only that the case handler did.
  return queryAll<MessageRow>(
    forHandler
      ? `SELECT m.id, m.author, m.body, m.created_on, u.full_name AS handler_name
         FROM anonymous_report_messages m LEFT JOIN users u ON u.id = m.handler_id
         WHERE m.report_id = ? ORDER BY m.id`
      : `SELECT id, author, body, created_on FROM anonymous_report_messages WHERE report_id = ? ORDER BY id`,
    reportId
  );
}

/** What the reporter may see about their own report. */
export function reporterView(r: ReportRow) {
  return {
    number: r.number, category: r.category, subject: r.subject, status: r.status,
    created_on: r.created_on, updated_on: r.updated_on, messages: messagesFor(r.id, false),
  };
}

export function addReporterMessage(r: ReportRow, body: string): void {
  if (r.status === 'closed') throw Object.assign(new Error('This report is closed.'), { status: 409 });
  const day = today();
  run("INSERT INTO anonymous_report_messages (report_id, author, body, created_on) VALUES (?, 'reporter', ?, ?)", r.id, body, day);
  run('UPDATE anonymous_reports SET updated_on = ? WHERE id = ?', day, r.id);
}

// ─── Handler (staff) side ────────────────────────────────────────────────────

export function listReports(status?: string) {
  const rows = queryAll<ReportRow & { message_count: number; reporter_replies: number }>(
    `SELECT r.id, r.number, r.category, r.subject, r.incident_date, r.location, r.status, r.created_on, r.updated_on,
            (SELECT COUNT(*) FROM anonymous_report_messages m WHERE m.report_id = r.id) AS message_count,
            (SELECT COUNT(*) FROM anonymous_report_messages m WHERE m.report_id = r.id AND m.author = 'reporter') AS reporter_replies
     FROM anonymous_reports r
     ${status ? 'WHERE r.status = ?' : ''}
     ORDER BY CASE r.status WHEN 'new' THEN 0 WHEN 'triaged' THEN 1 WHEN 'investigating' THEN 2 ELSE 3 END, r.id DESC
     LIMIT 300`,
    ...(status ? [status] : [])
  );
  return rows;
}

export function getReport(id: number) {
  const r = queryOne<ReportRow>('SELECT * FROM anonymous_reports WHERE id = ?', id);
  if (!r) return null;
  const { access_hash: _omit, ...rest } = r;
  return { ...rest, messages: messagesFor(r.id, true) };
}

export function setStatus(id: number, status: ReportStatus): boolean {
  return run('UPDATE anonymous_reports SET status = ?, updated_on = ? WHERE id = ?', status, today(), id).changes === 1;
}

export function addHandlerMessage(id: number, handlerId: number, body: string): boolean {
  const r = queryOne<{ id: number }>('SELECT id FROM anonymous_reports WHERE id = ?', id);
  if (!r) return false;
  const day = today();
  run("INSERT INTO anonymous_report_messages (report_id, author, handler_id, body, created_on) VALUES (?, 'handler', ?, ?, ?)", id, handlerId, body, day);
  run('UPDATE anonymous_reports SET updated_on = ? WHERE id = ?', day, id);
  return true;
}
