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
 *  - Photos (with the report or a follow-up) arrive already metadata-stripped by the route
 *    (shared/image-metadata.ts) and are kept as BLOBs with no filename and a date-only stamp,
 *    never as files whose name or file-system times could date the submission.
 */
import crypto from 'node:crypto';
import { queryOne, queryAll, run, db } from '../shared/db';
import type { REPORT_STATUSES } from '../shared/validation';
import type { ScrubbedImage } from '../shared/image-metadata';
import { now } from '../shared/sync-context';

export type ReportStatus = (typeof REPORT_STATUSES)[number];

const TICKET_TTL_MIN = 120;
/** Per signed-in user, per day. Kept in memory only (a DB counter would link users to tickets). */
export const TICKETS_PER_DAY = 10;
/** Photos per submission / follow-up, and across a whole report. */
export const PHOTOS_PER_POST = 4;
export const PHOTOS_PER_REPORT = 12;
export const PHOTO_MAX_BYTES = 6 * 1024 * 1024;

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
// The command's own date under sync (an offline report keeps the day it was filed).
const today = () => now().toISOString().slice(0, 10);

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
  | { ok: true; number: string; access_code: string; access_hash: string }
  | { ok: false; status: number; error: string };

/** How an offline (synced) submission is numbered and verified (docs/OFFLINE-FIRST.md §25). */
export interface SubmitOptions {
  /** A re-run of a submission recorded elsewhere: its ticket was used there, and only the access
   *  code's hash travelled with it. */
  recordedAccessHash?: string;
  /** The submission's provisional number (reportAlias). */
  alias?: string | null;
  /** On an installed PC the alias *is* the number; on the cloud it is kept beside the real one. */
  provisional?: boolean;
}

/** A report's provisional number, derived from its (anonymous) sync command: no PC, no time. */
export function reportAlias(commandId: string): string {
  return `CR-X${sha256(commandId).slice(0, 8).toUpperCase()}`;
}
export const accessHashOf = (accessCode: string) => sha256(normalizeCode(accessCode));

function savePhotos(reportId: number, messageId: number | null, photos: ScrubbedImage[], day: string): void {
  for (const p of photos) {
    run(
      `INSERT INTO anonymous_report_attachments (report_id, message_id, mime_type, size_bytes, data, created_on)
       VALUES (?, ?, ?, ?, ?, ?)`,
      reportId, messageId, p.mime, p.data.length, p.data, day
    );
  }
}

export function submitReport(input: NewReport, photos: ScrubbedImage[] = [], opts: SubmitOptions = {}): SubmitResult {
  db.exec('BEGIN');
  try {
    // Consume the ticket first, in the same transaction, so a ticket can never file twice.
    // (A re-run's ticket was consumed where the report was filed; tickets never leave a PC.)
    const used = opts.recordedAccessHash ? { changes: 1 } : run(
      "DELETE FROM anonymous_report_tickets WHERE token_hash = ? AND expires_at >= datetime('now')",
      sha256(input.ticket)
    );
    if (used.changes !== 1) {
      db.exec('ROLLBACK');
      return { ok: false, status: 403, error: 'This submission link has expired. Go back and start the report again.' };
    }
    // Numbered from this table, not nextSequence(): that writes settings.updated_at, which
    // would record the exact time of the latest submission. An installed PC's number is
    // provisional; the cloud gives the real one and keeps the provisional as an alias.
    const last = queryOne<{ n: number }>('SELECT COALESCE(MAX(id), 0) AS n FROM anonymous_reports');
    const number = opts.provisional && opts.alias ? opts.alias : `CR-${String((last?.n ?? 0) + 1).padStart(5, '0')}`;
    const accessCode = opts.recordedAccessHash ? '' : newAccessCode();
    const accessHash = opts.recordedAccessHash ?? sha256(normalizeCode(accessCode));
    const day = today();
    const info = run(
      `INSERT INTO anonymous_reports
         (number, category, subject, description, incident_date, location, status, access_hash, created_on, updated_on)
       VALUES (?, ?, ?, ?, ?, ?, 'new', ?, ?, ?)`,
      number, input.category, input.subject || null, input.description,
      input.incident_date || null, input.location || null, accessHash, day, day
    );
    savePhotos(Number(info.lastInsertRowid), null, photos, day);
    if (opts.alias && number !== opts.alias) {
      run('INSERT INTO anonymous_report_aliases (alias, report_id) VALUES (?, ?)', opts.alias, Number(info.lastInsertRowid));
    }
    db.exec('COMMIT');
    return { ok: true, number, access_code: accessCode, access_hash: accessHash };
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
interface AttachmentRow { id: number; message_id: number | null; mime_type: string; size_bytes: number }

function attachmentsFor(reportId: number): AttachmentRow[] {
  return queryAll<AttachmentRow>(
    'SELECT id, message_id, mime_type, size_bytes FROM anonymous_report_attachments WHERE report_id = ? ORDER BY id',
    reportId
  );
}

/** Resolve number + access code to the report, or null. Constant-time hash comparison. */
export function findByCode(number: string, accessCode: string): ReportRow | null {
  return findByHash(number, accessHashOf(accessCode));
}

/** findByCode with the code's hash: a re-run of an offline follow-up carries only the hash. The
 *  number may be the real one or the provisional alias it was filed under. */
export function findByHash(number: string, accessHash: string): ReportRow | null {
  const n = number.trim().toUpperCase();
  const row = queryOne<ReportRow>(
    `SELECT * FROM anonymous_reports
     WHERE number = ? OR id = (SELECT report_id FROM anonymous_report_aliases WHERE alias = ?)`,
    n, n
  );
  const given = Buffer.from(/^[0-9a-f]{64}$/.test(accessHash) ? accessHash : sha256('malformed'), 'hex');
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

/** Highest photo id a case handler has loaded for this report (0 = none yet). */
function handlerSeenUpTo(reportId: number): number {
  return queryOne<{ last_photo_id: number }>('SELECT last_photo_id FROM anonymous_report_handler_seen WHERE report_id = ?', reportId)?.last_photo_id ?? 0;
}

/** What the reporter may see about their own report. Photos are listed by id only — the reporter
 *  fetches one with POST /photo (number + code in the body, never on an image URL, where it could
 *  end up in logs or history). `removable` until a case handler has loaded it, and never once
 *  the report is closed. */
export function reporterView(r: ReportRow) {
  const photos = attachmentsFor(r.id);
  const seen = handlerSeenUpTo(r.id);
  const list = (messageId: number | null) => photos.filter((p) => p.message_id === messageId)
    .map((p) => ({ id: p.id, removable: r.status !== 'closed' && p.id > seen }));
  const own = list(null);
  return {
    number: r.number, category: r.category, subject: r.subject, status: r.status,
    created_on: r.created_on, updated_on: r.updated_on, photo_count: own.length, photos: own,
    photos_remaining: Math.max(0, PHOTOS_PER_REPORT - photos.length),
    messages: messagesFor(r.id, false).map((m) => {
      const mine = list(m.id);
      return { ...m, photo_count: mine.length, photos: mine };
    }),
  };
}

/** One of the report's own photos, for the reporter. */
export function reporterPhoto(r: ReportRow, photoId: number) {
  return getAttachment(r.id, photoId);
}

/** Remove a photo the reporter sent, while no case handler has loaded it. */
export function removeReporterPhoto(r: ReportRow, photoId: number): void {
  const fail = (msg: string, status: number): never => { throw Object.assign(new Error(msg), { status }); };
  if (r.status === 'closed') fail('This report is closed.', 409);
  db.exec('BEGIN');
  try {
    const p = queryOne<{ id: number }>('SELECT id FROM anonymous_report_attachments WHERE id = ? AND report_id = ?', photoId, r.id);
    if (!p) fail('Photo not found.', 404);
    // Re-read inside the transaction, so a handler opening the case now can't race the removal.
    if (photoId <= handlerSeenUpTo(r.id)) fail('The case handler has already seen this photo, so it can’t be removed.', 409);
    run('DELETE FROM anonymous_report_attachments WHERE id = ?', photoId);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function addReporterMessage(r: ReportRow, body: string, photos: ScrubbedImage[] = []): void {
  if (r.status === 'closed') throw Object.assign(new Error('This report is closed.'), { status: 409 });
  const have = queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM anonymous_report_attachments WHERE report_id = ?', r.id)!.n;
  if (have + photos.length > PHOTOS_PER_REPORT) {
    const left = Math.max(0, PHOTOS_PER_REPORT - have);
    throw Object.assign(new Error(left ? `You can add ${left} more photo${left === 1 ? '' : 's'} to this report.` : 'This report already has the most photos it can hold.'), { status: 400 });
  }
  const day = today();
  db.exec('BEGIN');
  try {
    const info = run("INSERT INTO anonymous_report_messages (report_id, author, body, created_on) VALUES (?, 'reporter', ?, ?)", r.id, body, day);
    savePhotos(r.id, Number(info.lastInsertRowid), photos, day);
    run('UPDATE anonymous_reports SET updated_on = ? WHERE id = ?', day, r.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ─── Handler (staff) side ────────────────────────────────────────────────────

export function listReports(status?: string) {
  const rows = queryAll<ReportRow & { message_count: number; reporter_replies: number; photo_count: number }>(
    `SELECT r.id, r.number, r.category, r.subject, r.incident_date, r.location, r.status, r.created_on, r.updated_on,
            (SELECT COUNT(*) FROM anonymous_report_messages m WHERE m.report_id = r.id) AS message_count,
            (SELECT COUNT(*) FROM anonymous_report_messages m WHERE m.report_id = r.id AND m.author = 'reporter') AS reporter_replies,
            (SELECT COUNT(*) FROM anonymous_report_attachments a WHERE a.report_id = r.id) AS photo_count
     FROM anonymous_reports r
     ${status ? 'WHERE r.status = ?' : ''}
     ORDER BY CASE r.status WHEN 'new' THEN 0 WHEN 'triaged' THEN 1 WHEN 'investigating' THEN 2 ELSE 3 END, r.id DESC
     LIMIT 300`,
    ...(status ? [status] : [])
  );
  return rows;
}

/** Case detail for a handler. Opening it marks every photo in it as seen, which ends the
 *  reporter's ability to remove them (removeReporterPhoto). */
export function getReport(id: number) {
  const r = queryOne<ReportRow>('SELECT * FROM anonymous_reports WHERE id = ?', id);
  if (!r) return null;
  const { access_hash: _omit, ...rest } = r;
  const attachments = attachmentsFor(r.id);
  if (attachments.length) {
    run(
      `INSERT INTO anonymous_report_handler_seen (report_id, last_photo_id) VALUES (?, ?)
       ON CONFLICT(report_id) DO UPDATE SET last_photo_id = MAX(last_photo_id, excluded.last_photo_id)`,
      r.id, attachments[attachments.length - 1]!.id
    );
  }
  const photos = attachments.map((a) => ({ ...a, url: `/confidential-reports/${r.id}/attachments/${a.id}` }));
  const of = (messageId: number | null) => photos.filter((p) => p.message_id === messageId);
  return {
    ...rest, attachments: of(null),
    messages: messagesFor(r.id, true).map((m) => ({ ...m, attachments: of(m.id) })),
  };
}

export function getAttachment(reportId: number, attachmentId: number) {
  return queryOne<{ id: number; mime_type: string; data: Uint8Array }>(
    'SELECT id, mime_type, data FROM anonymous_report_attachments WHERE id = ? AND report_id = ?',
    attachmentId, reportId
  ) ?? null;
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
