/** Confidential (anonymous) reporting routes — see confidential-reports.ts for the anonymity
 *  rules. Two routers:
 *
 *  reporterRouter — mounted at /api/anonymous-reports, BEFORE any router with blanket auth.
 *    Excluded from the activity log and the idempotency store (see isAnonymousReportPath).
 *    POST /ticket    signed-in employee → single-use submission ticket (no identity kept)
 *    POST /          { ticket, category, subject?, description, incident_date?, location? }
 *                    (+ up to 4 `photos`, multipart) → { number, access_code }
 *                    — never reads the Authorization header
 *    POST /lookup    { number, access_code } → status + conversation (+ photo ids, `removable`)
 *    POST /followup  { number, access_code, body } (+ `photos`) → add a reporter message
 *    POST /photo     { number, access_code, photo_id } → that photo's bytes
 *    POST /photo/remove { … same } → delete it, only while no case handler has loaded it
 *
 *  Photos are held in memory, metadata-stripped (shared/image-metadata.ts) and only then
 *  stored; a photo that can't be stripped fails the request before the ticket is used.
 *
 *  staffRouter — mounted at /api/confidential-reports, `reports.confidential`, audited normally.
 *    GET /  (?status=)  ·  GET /:id  ·  GET /:id/attachments/:attId  ·
 *    POST /:id/status { status }  ·  POST /:id/reply { body } */
import { Router, type Request, type Response, type NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { requireAuth, requirePermission } from '../shared/auth';
import { notifyPermission } from '../shared/push';
import { stripImageMetadata } from '../shared/image-metadata';
import {
  parseBody, anonymousReportSchema, anonymousLookupSchema, anonymousFollowupSchema, anonymousPhotoSchema,
  confidentialStatusSchema, confidentialReplySchema, REPORT_CATEGORIES, REPORT_STATUSES,
} from '../shared/validation';
import {
  issueTicket, submitReport, findByCode, findByHash, accessHashOf, reportAlias,
  reporterView, addReporterMessage, reporterPhoto, removeReporterPhoto,
  listReports, getReport, getAttachment, setStatus, addHandlerMessage,
  PHOTOS_PER_POST, PHOTO_MAX_BYTES,
} from './confidential-reports';
import { isInstalledCopy, syncClass } from '../sync';
import { attachCommandFiles } from '../sync/files';
import { reRunOfRecordedCommand, syncContext } from '../shared/sync-context';
import type { ScrubbedImage } from '../shared/image-metadata';
import { keepRequestContext } from '../shared/request-context';
import { rateLimitKey } from '../shared/device';

/** Paths whose requests must leave no identity trail (activity log, idempotency store). */
export function isAnonymousReportPath(p: string): boolean {
  return p === '/api/anonymous-reports' || p.startsWith('/api/anonymous-reports/');
}

// In-memory only (never persisted), so the limiter can't become a record of who reported.
const limiter = (limit: number) => rateLimit({
  windowMs: 15 * 60 * 1000, limit, standardHeaders: true, legacyHeaders: false, keyGenerator: rateLimitKey,
  skip: () => process.env.NODE_ENV === 'test',
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' },
});

// Memory only: the original bytes (with their metadata) never touch the disk.
// (keepRequestContext: memory storage would otherwise lose the request's workspace.)
const photoUpload = keepRequestContext(multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: PHOTO_MAX_BYTES, files: PHOTOS_PER_POST, fields: 20 },
}).array('photos', PHOTOS_PER_POST));

const scrubPhotos = (req: Request) => ((req.files as Express.Multer.File[] | undefined) || []).map((f) => stripImageMetadata(f.buffer));

/*
 * Offline (docs/OFFLINE-FIRST.md §25): reporter actions are `merge` commands with no identity
 * (`unattributed`: no user, device, PC, node sequence or time — the date only), held on the PC
 * for a random while before they're sent. What they carry is trimmed further:
 *  - the ticket is checked and used on the PC and never stored in the command;
 *  - the access code never leaves the PC: only its hash travels, and a re-run verifies with it;
 *  - photos travel only as their metadata-stripped bytes, never as the original upload.
 * A report filed on a PC is numbered provisionally there (reportAlias); the cloud gives it the
 * real number and keeps the provisional one as an alias, so either works for follow-ups.
 */
const PLACEHOLDER = 'recorded-elsewhere';

/** The access-code hash of this request: computed from the code, or carried by a re-run. */
function requestAccessHash(req: Request, accessCode: string): string {
  return reRunOfRecordedCommand() ? String((req.body as { access_hash?: unknown })?.access_hash ?? '') : accessHashOf(accessCode);
}

/** While recording offline: keep the code's hash and the scrubbed photos in the command. */
function recordAnonymous(req: Request, accessHash: string, photos: ScrubbedImage[]): void {
  if (!syncContext()?.commandId || reRunOfRecordedCommand()) return;
  (req.body as Record<string, unknown>).access_hash = accessHash;
  attachCommandFiles(req, photos.map((p, i) => ({ field: 'photos', name: `photo-${i + 1}.${p.ext}`, type: p.mime, bytes: p.data })));
}

/** The body as the schema expects it: a re-run lacks the redacted secret, so stand in for it. */
const withPlaceholder = (req: Request, key: string) =>
  reRunOfRecordedCommand() ? { ...(req.body as object), [key]: PLACEHOLDER } : req.body;

export const reporterRouter = Router();

reporterRouter.get('/categories', (_req, res) => {
  res.json({ categories: REPORT_CATEGORIES });
});

reporterRouter.post('/ticket', requireAuth, (req, res) => {
  const t = issueTicket(String(req.user!.id));
  if (!t) { res.status(429).json({ error: 'Daily limit reached for confidential reports. Try again tomorrow.' }); return; }
  res.json(t);
});

reporterRouter.post('/', limiter(10), syncClass('merge', { unattributed: true, redact: ['ticket'] }), photoUpload, (req, res) => {
  // Deliberately no requireAuth and no req.user: nothing about the caller is looked at.
  const input = parseBody(anonymousReportSchema, withPlaceholder(req, 'ticket'));
  const photos = scrubPhotos(req);
  const commandId = syncContext()?.commandId;
  const alias = commandId ? reportAlias(commandId) : null;
  const recorded = reRunOfRecordedCommand();
  const result = submitReport(input, photos, {
    recordedAccessHash: recorded ? requestAccessHash(req, '') : undefined,
    alias, provisional: alias != null && isInstalledCopy(),
  });
  if (!result.ok) { res.status(result.status).json({ error: result.error }); return; }
  recordAnonymous(req, result.access_hash, photos);
  void notifyPermission('reports.confidential', {
    title: 'New confidential report',
    body: `${result.number} · ${input.category}${photos.length ? ` · ${photos.length} photo${photos.length === 1 ? '' : 's'}` : ''}`,
    url: '#/confidential-reports',
    tag: 'cr-' + result.number,
  });
  res.status(201).json({ number: result.number, access_code: result.access_code });
});

reporterRouter.post('/lookup', limiter(30), (req, res) => {
  const { number, access_code } = parseBody(anonymousLookupSchema, req.body);
  const r = findByCode(number, access_code);
  if (!r) { res.status(404).json({ error: 'No report matches that number and access code.' }); return; }
  res.json(reporterView(r));
});

reporterRouter.post('/followup', limiter(20), syncClass('merge', { unattributed: true, redact: ['access_code'] }), photoUpload, (req, res) => {
  const { number, access_code, body } = parseBody(anonymousFollowupSchema, withPlaceholder(req, 'access_code'));
  const hash = requestAccessHash(req, access_code);
  const r = findByHash(number, hash);
  if (!r) { res.status(404).json({ error: 'No report matches that number and access code.' }); return; }
  const photos = scrubPhotos(req);
  addReporterMessage(r, body, photos);
  recordAnonymous(req, hash, photos);
  void notifyPermission('reports.confidential', {
    title: 'Confidential report follow-up', body: r.number, url: '#/confidential-reports', tag: 'cr-' + r.number,
  });
  res.status(201).json(reporterView(r));
});

// The reporter's own photos: number + code in the POST body (never in an image URL, which ends up
// in history and logs). Answers exactly like a missing report on a wrong code.
reporterRouter.post('/photo', limiter(60), (req, res) => {
  const { number, access_code, photo_id } = parseBody(anonymousPhotoSchema, req.body);
  const r = findByCode(number, access_code);
  const p = r ? reporterPhoto(r, photo_id) : null;
  if (!p) { res.status(404).json({ error: 'Photo not found.' }); return; }
  res.type(p.mime_type);
  res.setHeader('Cache-Control', 'no-store');
  res.send(Buffer.from(p.data));
});

reporterRouter.post('/photo/remove', limiter(20), syncClass('merge', { unattributed: true, redact: ['access_code'] }), (req, res) => {
  const { number, access_code, photo_id } = parseBody(anonymousPhotoSchema, withPlaceholder(req, 'access_code'));
  const hash = requestAccessHash(req, access_code);
  const r = findByHash(number, hash);
  if (!r) { res.status(404).json({ error: 'No report matches that number and access code.' }); return; }
  removeReporterPhoto(r, photo_id);
  recordAnonymous(req, hash, []);
  res.json(reporterView(r));
});

// Upload errors (too big, too many) → 400 with a reporter-friendly message.
reporterRouter.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (!(err instanceof multer.MulterError)) { next(err); return; }
  const msg = err.code === 'LIMIT_FILE_SIZE' ? `Each photo must be ${PHOTO_MAX_BYTES / (1024 * 1024)} MB or smaller.`
    : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE' ? `You can attach up to ${PHOTOS_PER_POST} photos at a time.`
    : 'The upload could not be read.';
  res.status(400).json({ error: msg });
});

export const staffRouter = Router();
staffRouter.use(requireAuth, requirePermission('reports.confidential'));

staffRouter.get('/', (req, res) => {
  const status = typeof req.query.status === 'string' && (REPORT_STATUSES as readonly string[]).includes(req.query.status)
    ? req.query.status : undefined;
  res.json(listReports(status));
});

staffRouter.get('/:id', (req, res) => {
  const r = getReport(Number(req.params.id));
  if (!r) { res.status(404).json({ error: 'Report not found' }); return; }
  res.json(r);
});

staffRouter.get('/:id/attachments/:attId', (req, res) => {
  const a = getAttachment(Number(req.params.id), Number(req.params.attId));
  if (!a) { res.status(404).json({ error: 'Photo not found' }); return; }
  res.type(a.mime_type);
  res.setHeader('Cache-Control', 'private, no-store');
  const ext = a.mime_type === 'image/jpeg' ? 'jpg' : a.mime_type.replace('image/', '');
  res.setHeader('Content-Disposition', `inline; filename="photo-${a.id}.${ext}"`);
  res.send(Buffer.from(a.data));
});

staffRouter.post('/:id/status', syncClass('claim'), (req, res) => {
  const { status } = parseBody(confidentialStatusSchema, req.body);
  if (!setStatus(Number(req.params.id), status)) { res.status(404).json({ error: 'Report not found' }); return; }
  res.json({ ok: true, status });
});

staffRouter.post('/:id/reply', syncClass('merge'), (req, res) => {
  const { body } = parseBody(confidentialReplySchema, req.body);
  if (!addHandlerMessage(Number(req.params.id), req.user!.id, body)) { res.status(404).json({ error: 'Report not found' }); return; }
  res.status(201).json(getReport(Number(req.params.id)));
});
