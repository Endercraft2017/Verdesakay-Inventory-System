/** Confidential (anonymous) reporting routes — see confidential-reports.ts for the anonymity
 *  rules. Two routers:
 *
 *  reporterRouter — mounted at /api/anonymous-reports, BEFORE any router with blanket auth.
 *    Excluded from the activity log and the idempotency store (see isAnonymousReportPath).
 *    POST /ticket    signed-in employee → single-use submission ticket (no identity kept)
 *    POST /          { ticket, category, subject?, description, incident_date?, location? }
 *                    → { number, access_code }  — never reads the Authorization header
 *    POST /lookup    { number, access_code } → status + conversation
 *    POST /followup  { number, access_code, body } → add a reporter message
 *
 *  staffRouter — mounted at /api/confidential-reports, `reports.confidential`, audited normally.
 *    GET /  (?status=)  ·  GET /:id  ·  POST /:id/status { status }  ·  POST /:id/reply { body } */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth, requirePermission } from '../shared/auth';
import { notifyPermission } from '../shared/push';
import {
  parseBody, anonymousReportSchema, anonymousLookupSchema, anonymousFollowupSchema,
  confidentialStatusSchema, confidentialReplySchema, REPORT_CATEGORIES, REPORT_STATUSES,
} from '../shared/validation';
import {
  issueTicket, submitReport, findByCode, reporterView, addReporterMessage,
  listReports, getReport, setStatus, addHandlerMessage,
} from './confidential-reports';

/** Paths whose requests must leave no identity trail (activity log, idempotency store). */
export function isAnonymousReportPath(p: string): boolean {
  return p === '/api/anonymous-reports' || p.startsWith('/api/anonymous-reports/');
}

// In-memory only (never persisted), so the limiter can't become a record of who reported.
const limiter = (limit: number) => rateLimit({
  windowMs: 15 * 60 * 1000, limit, standardHeaders: true, legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' },
});

export const reporterRouter = Router();

reporterRouter.get('/categories', (_req, res) => {
  res.json({ categories: REPORT_CATEGORIES });
});

reporterRouter.post('/ticket', requireAuth, (req, res) => {
  const t = issueTicket(String(req.user!.id));
  if (!t) { res.status(429).json({ error: 'Daily limit reached for confidential reports. Try again tomorrow.' }); return; }
  res.json(t);
});

reporterRouter.post('/', limiter(10), (req, res) => {
  // Deliberately no requireAuth and no req.user: nothing about the caller is looked at.
  const input = parseBody(anonymousReportSchema, req.body);
  const result = submitReport(input);
  if (!result.ok) { res.status(result.status).json({ error: result.error }); return; }
  void notifyPermission('reports.confidential', {
    title: 'New confidential report',
    body: `${result.number} · ${input.category}`,
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

reporterRouter.post('/followup', limiter(20), (req, res) => {
  const { number, access_code, body } = parseBody(anonymousFollowupSchema, req.body);
  const r = findByCode(number, access_code);
  if (!r) { res.status(404).json({ error: 'No report matches that number and access code.' }); return; }
  addReporterMessage(r, body);
  void notifyPermission('reports.confidential', {
    title: 'Confidential report follow-up', body: r.number, url: '#/confidential-reports', tag: 'cr-' + r.number,
  });
  res.status(201).json(reporterView(r));
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

staffRouter.post('/:id/status', (req, res) => {
  const { status } = parseBody(confidentialStatusSchema, req.body);
  if (!setStatus(Number(req.params.id), status)) { res.status(404).json({ error: 'Report not found' }); return; }
  res.json({ ok: true, status });
});

staffRouter.post('/:id/reply', (req, res) => {
  const { body } = parseBody(confidentialReplySchema, req.body);
  if (!addHandlerMessage(Number(req.params.id), req.user!.id, body)) { res.status(404).json({ error: 'Report not found' }); return; }
  res.status(201).json(getReport(Number(req.params.id)));
});
