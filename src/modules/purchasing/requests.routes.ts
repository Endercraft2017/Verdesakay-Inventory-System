/** Internal PR: request → budget approval → purchase → receipt-backed liquidation → close.
 * This never creates a supplier order or moves stock. */
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { db, queryAll, queryOne, run, nextSequence, uploadDir } from '../../shared/db';
import { requireAuth, requirePermission } from '../../shared/auth';
import { parseBody } from '../../shared/validation';
import { idempotency } from '../../shared/idempotency';
import { syncClass } from '../../sync';
import { syncUpload } from '../../sync/files';
import { storeDurableUpload, resolveDurableUploadAsync, forgetDurableUpload } from '../../shared/durable-uploads';
import { enforceQuota } from '../../platform/quota';
import { unlink } from '../../core/attachments.routes';
import { userPermissions } from '../../shared/roles';

const router = Router();
router.use(requireAuth);
const money = z.coerce.number().finite().min(0).max(1e9);
const date = z.iso.date().nullable().optional();
const item = z.object({ name: z.string().trim().min(2).max(200), quantity: z.coerce.number().finite().positive().max(1e7),
  estimated_unit_price: money, note: z.string().trim().max(500).nullable().optional() });
const createSchema = z.object({ reason: z.string().trim().min(3).max(2000), needed_by: date,
  items: z.array(item).min(1).max(100) });
const approveSchema = z.object({ approved_budget: money, purchase_mode: z.enum(['requester_cash','assigned_buyer']),
  buyer_id: z.coerce.number().int().positive().nullable().optional(), note: z.string().trim().max(2000).nullable().optional() });
const rejectSchema = z.object({ note: z.string().trim().min(3).max(2000) });
const cashSchema = z.object({ amount: money.positive() });
const liquidationSchema = z.object({ note: z.string().trim().max(2000).nullable().optional(),
  items: z.array(z.object({ name: z.string().trim().min(2).max(200), quantity: z.coerce.number().finite().positive().max(1e7), actual_unit_price: money })).min(1).max(150) });
type Row = { id: number; number: string; requested_by: number | null; buyer_id: number | null; status: string;
  requested_budget: number; approved_budget: number | null; purchase_mode: string | null; cash_issued: number | null };
const cents = (n: number) => Math.round(n * 100);
function get(id: number) { return queryOne<Row>('SELECT * FROM purchase_requests WHERE id=?', id); }
function manager(req: Request) { return req.user!.permissions.includes('purchasing.approve_requests'); }
function visible(req: Request, row: Row) { return manager(req) || row.requested_by === req.user!.id || row.buyer_id === req.user!.id; }
function buyer(req: Request, row: Row) { return row.buyer_id === req.user!.id; }
function read(req: Request, res: import('express').Response): Row | null {
  const row = get(Number(req.params.id));
  if (!row || !visible(req, row)) { res.status(404).json({ error: 'Purchase request not found' }); return null; }
  return row;
}
function detail(row: Row) { return { ...row,
  ...(queryOne<Record<string, string | null>>(`SELECT requester.full_name AS requested_by_name, buyer.full_name AS buyer_name,
    approver.full_name AS decided_by_name, closer.full_name AS closed_by_name
    FROM purchase_requests p LEFT JOIN users requester ON requester.id=p.requested_by
    LEFT JOIN users buyer ON buyer.id=p.buyer_id LEFT JOIN users approver ON approver.id=p.decided_by
    LEFT JOIN users closer ON closer.id=p.closed_by WHERE p.id=?`, row.id) ?? {}),
  items: queryAll('SELECT * FROM purchase_request_items WHERE request_id=? ORDER BY id', row.id),
  purchases: queryAll('SELECT * FROM purchase_liquidation_items WHERE request_id=? ORDER BY id', row.id),
  receipts: queryAll(`SELECT id,original_name,mime_type,uploaded_by,created_at FROM purchase_receipt_files WHERE request_id=? ORDER BY id`, row.id),
}; }

router.get('/', (req, res) => {
  const all = manager(req);
  res.json(queryAll(`SELECT p.*, requester.full_name AS requested_by_name, buyer.full_name AS buyer_name,
    approver.full_name AS decided_by_name, closer.full_name AS closed_by_name,
    (SELECT COUNT(*) FROM purchase_receipt_files f WHERE f.request_id=p.id) AS receipt_count
    FROM purchase_requests p LEFT JOIN users requester ON requester.id=p.requested_by
    LEFT JOIN users buyer ON buyer.id=p.buyer_id LEFT JOIN users approver ON approver.id=p.decided_by
    LEFT JOIN users closer ON closer.id=p.closed_by
    ${all ? '' : 'WHERE p.requested_by=? OR p.buyer_id=?'}
    ORDER BY CASE p.status WHEN 'pending' THEN 0 WHEN 'liquidation_submitted' THEN 1 WHEN 'approved' THEN 2 ELSE 3 END, p.id DESC LIMIT 300`,
    ...(all ? [] : [req.user!.id, req.user!.id])));
});

router.get('/buyers', requirePermission('purchasing.approve_requests'), (_req, res) => {
  const candidates = queryAll<{ id: number; full_name: string; role: string; permission_overrides: string }>(
    `SELECT id,full_name,role,permission_overrides FROM users WHERE active=1 ORDER BY full_name COLLATE NOCASE`);
  res.json(candidates.filter((u) => {
    let overrides = {};
    try { overrides = JSON.parse(u.permission_overrides); } catch { /* ignore malformed legacy overrides */ }
    return userPermissions(u.role, overrides).some((p) => p === 'purchasing.request' || p === 'purchasing.manage');
  }).map((u) => ({ id: u.id, full_name: u.full_name })));
});

router.get('/:id', (req, res) => {
  const row = read(req, res); if (row) res.json(detail(row));
});

router.post('/', requirePermission('purchasing.request'), idempotency, syncClass('merge'), (req, res) => {
  const input = parseBody(createSchema, req.body);
  const budget = cents(input.items.reduce((sum, x) => sum + x.quantity * x.estimated_unit_price, 0));
  if (!Number.isSafeInteger(budget) || budget <= 0) { res.status(400).json({ error: 'Enter a positive, reasonable expected cost.' }); return; }
  db.exec('BEGIN');
  try {
    const number = nextSequence('purchase_request_seq', 'REQ');
    const id = Number(run(`INSERT INTO purchase_requests(number,requested_by,reason,needed_by,requested_budget) VALUES(?,?,?,?,?)`,
      number, req.user!.id, input.reason, input.needed_by ?? null, budget / 100).lastInsertRowid);
    for (const x of input.items) run(`INSERT INTO purchase_request_items(request_id,name,quantity,estimated_unit_price,note)
      VALUES(?,?,?,?,?)`, id, x.name, x.quantity, x.estimated_unit_price, x.note ?? null);
    db.exec('COMMIT'); res.status(201).json({ id, number, requested_budget: budget / 100, status: 'pending' });
  } catch (e) { db.exec('ROLLBACK'); throw e; }
});

router.post('/:id/approve', requirePermission('purchasing.approve_requests'), idempotency, syncClass('claim'), (req, res) => {
  const row = get(Number(req.params.id));
  if (!row) { res.status(404).json({ error: 'Purchase request not found' }); return; }
  if (row.status !== 'pending') { res.status(409).json({ error: 'This request has already been decided.' }); return; }
  const input = parseBody(approveSchema, req.body);
  const buyerId = input.purchase_mode === 'requester_cash' ? row.requested_by : input.buyer_id;
  const buyerAccount = buyerId ? queryOne<{ role: string; permission_overrides: string }>(
    `SELECT role,permission_overrides FROM users WHERE id=? AND active=1`, buyerId) : null;
  let buyerOverrides = {};
  try { buyerOverrides = JSON.parse(buyerAccount?.permission_overrides || '{}'); } catch { /* ignore malformed legacy overrides */ }
  if (!buyerId || !buyerAccount || !userPermissions(buyerAccount.role, buyerOverrides).some((p) => p === 'purchasing.request' || p === 'purchasing.manage')) {
    res.status(400).json({ error: 'Choose an active buyer.' }); return;
  }
  if (cents(input.approved_budget) <= 0) { res.status(400).json({ error: 'Approved budget must be above zero.' }); return; }
  run(`UPDATE purchase_requests SET status='approved',approved_budget=?,purchase_mode=?,buyer_id=?,decision_note=?,
    decided_by=?,decided_at=datetime('now') WHERE id=?`, input.approved_budget, input.purchase_mode, buyerId,
    input.note ?? null, req.user!.id, row.id);
  res.json({ ok: true, status: 'approved' });
});

router.post('/:id/reject', requirePermission('purchasing.approve_requests'), idempotency, syncClass('claim'), (req, res) => {
  const { note } = parseBody(rejectSchema, req.body);
  const changed = run(`UPDATE purchase_requests SET status='rejected',decision_note=?,decided_by=?,decided_at=datetime('now')
    WHERE id=? AND status='pending'`, note, req.user!.id, Number(req.params.id));
  if (!changed.changes) { res.status(409).json({ error: 'Request not found or already decided.' }); return; }
  res.json({ ok: true });
});

router.post('/:id/issue-cash', requirePermission('purchasing.approve_requests'), idempotency, syncClass('claim'), (req, res) => {
  const row = get(Number(req.params.id));
  if (!row) { res.status(404).json({ error: 'Purchase request not found' }); return; }
  if (row.status !== 'approved' || row.purchase_mode !== 'requester_cash' || row.cash_issued != null) {
    res.status(409).json({ error: 'Cash can be recorded once on an approved requester-cash PR.' }); return;
  }
  const { amount } = parseBody(cashSchema, req.body);
  if (cents(amount) > cents(row.approved_budget!)) { res.status(400).json({ error: 'Cash issued exceeds the approved budget.' }); return; }
  run(`UPDATE purchase_requests SET cash_issued=?,cash_issued_at=datetime('now'),cash_issued_by=? WHERE id=?`,
    amount, req.user!.id, row.id);
  res.json({ ok: true, cash_issued: amount });
});

const MIME = new Set(['image/jpeg','image/png','image/webp','application/pdf']);
const upload = multer({ storage: multer.diskStorage({ destination: (_r,_f,cb) => cb(null, uploadDir()),
  filename: (_r,f,cb) => cb(null, `pr-receipt-${crypto.randomBytes(16).toString('hex')}${path.extname(f.originalname).slice(0,8)}`) }),
  limits: { fileSize: 8 * 1024 * 1024 }, fileFilter: (_r,f,cb) => cb(null, MIME.has(f.mimetype)) });

router.post('/:id/receipts', idempotency, syncClass('physical'), syncUpload(upload.single('file')), (req, res) => {
  const row = read(req, res);
  if (!row) { unlink(req.file?.filename); return; }
  if (!buyer(req, row)) { unlink(req.file?.filename); res.status(403).json({ error: 'Only the assigned buyer can upload receipts.' }); return; }
  if (row.status !== 'approved') { unlink(req.file?.filename); res.status(409).json({ error: 'Receipts can be added while an approved PR awaits liquidation.' }); return; }
  if (!req.file) { res.status(400).json({ error: 'Upload a JPG, PNG, WebP or PDF receipt (8 MB maximum).' }); return; }
  try { enforceQuota('storage_mb'); } catch (e) { unlink(req.file.filename); throw e; }
  const id = Number(run(`INSERT INTO purchase_receipt_files(request_id,file_name,original_name,mime_type,uploaded_by)
    VALUES(?,?,?,?,?)`, row.id, req.file.filename, req.file.originalname.slice(0,255), req.file.mimetype, req.user!.id).lastInsertRowid);
  storeDurableUpload(req.file.filename);
  res.status(201).json({ id });
});

router.get('/:id/receipts/:fileId', async (req, res) => {
  const row = read(req, res); if (!row) return;
  const file = queryOne<{ file_name: string; mime_type: string }>(`SELECT file_name,mime_type FROM purchase_receipt_files WHERE id=? AND request_id=?`,
    Number(req.params.fileId), row.id);
  if (!file) { res.status(404).json({ error: 'Receipt not found' }); return; }
  const resolved = await resolveDurableUploadAsync(file.file_name);
  if (!resolved) { res.status(410).json({ error: 'Receipt file unavailable' }); return; }
  res.type(file.mime_type).sendFile(resolved);
});

router.delete('/:id/receipts/:fileId', syncClass('claim'), (req, res) => {
  const row = read(req, res); if (!row) return;
  if (!buyer(req, row)) { res.status(403).json({ error: 'Only the assigned buyer can change receipts.' }); return; }
  if (row.status !== 'approved') { res.status(409).json({ error: 'Liquidation evidence is locked after submission.' }); return; }
  const file = queryOne<{ file_name: string }>(`SELECT file_name FROM purchase_receipt_files WHERE id=? AND request_id=?`, Number(req.params.fileId), row.id);
  if (!file) { res.status(404).json({ error: 'Receipt not found' }); return; }
  run('DELETE FROM purchase_receipt_files WHERE id=?', Number(req.params.fileId));
  forgetDurableUpload(file.file_name); unlink(file.file_name);
  res.json({ ok: true });
});

router.post('/:id/liquidation', idempotency, syncClass('claim'), (req, res) => {
  const row = read(req, res); if (!row) return;
  if (!buyer(req, row)) { res.status(403).json({ error: 'Only the assigned buyer can liquidate this PR.' }); return; }
  if (row.status !== 'approved') { res.status(409).json({ error: 'This PR is not awaiting liquidation.' }); return; }
  if (row.purchase_mode === 'requester_cash' && row.cash_issued == null) { res.status(409).json({ error: 'Record the cash given to the requester first.' }); return; }
  const input = parseBody(liquidationSchema, req.body);
  const total = cents(input.items.reduce((sum,x) => sum + x.quantity * x.actual_unit_price, 0));
  if (!Number.isSafeInteger(total) || total <= 0 || total > cents(row.approved_budget!)) {
    res.status(400).json({ error: 'Actual spending must be positive and within the approved overall budget.' }); return;
  }
  if (!queryOne('SELECT id FROM purchase_receipt_files WHERE request_id=? LIMIT 1', row.id)) {
    res.status(400).json({ error: 'Upload at least one receipt before liquidation.' }); return;
  }
  db.exec('BEGIN');
  try {
    run('DELETE FROM purchase_liquidation_items WHERE request_id=?', row.id);
    for (const x of input.items) run(`INSERT INTO purchase_liquidation_items(request_id,name,quantity,actual_unit_price) VALUES(?,?,?,?)`,
      row.id, x.name, x.quantity, x.actual_unit_price);
    run(`UPDATE purchase_requests SET status='liquidation_submitted',actual_total=?,liquidation_note=?,submitted_at=datetime('now') WHERE id=?`,
      total / 100, input.note ?? null, row.id);
    db.exec('COMMIT'); res.json({ ok: true, actual_total: total / 100, status: 'liquidation_submitted' });
  } catch (e) { db.exec('ROLLBACK'); throw e; }
});

router.post('/:id/close', requirePermission('purchasing.approve_requests'), idempotency, syncClass('claim'), (req, res) => {
  const row = get(Number(req.params.id));
  if (!row) { res.status(404).json({ error: 'Purchase request not found' }); return; }
  if (row.status !== 'liquidation_submitted') { res.status(409).json({ error: 'Submit liquidation before closing the PR.' }); return; }
  const closing = parseBody(z.object({ note: z.string().trim().max(2000).nullable().optional(),
    cash_returned: money.optional(), reimbursed_amount: money.optional() }), req.body);
  const detail = queryOne<{ actual_total: number | null }>('SELECT actual_total FROM purchase_requests WHERE id=?', row.id)!;
  const unspent = row.purchase_mode === 'requester_cash' ? Math.max(0, cents(row.cash_issued ?? 0) - cents(detail.actual_total ?? 0)) : 0;
  const overAdvance = row.purchase_mode === 'requester_cash' ? Math.max(0, cents(detail.actual_total ?? 0) - cents(row.cash_issued ?? 0)) : 0;
  if (cents(closing.cash_returned ?? 0) !== unspent || cents(closing.reimbursed_amount ?? 0) !== overAdvance) {
    res.status(400).json({ error: 'Record the exact change returned or reimbursement paid before closing.' }); return;
  }
  run(`UPDATE purchase_requests SET status='closed',close_note=?,cash_returned=?,reimbursed_amount=?,closed_by=?,closed_at=datetime('now') WHERE id=?`,
    closing.note ?? null, closing.cash_returned ?? 0, closing.reimbursed_amount ?? 0, req.user!.id, row.id);
  res.json({ ok: true, status: 'closed' });
});

router.post('/:id/return-liquidation', requirePermission('purchasing.approve_requests'), idempotency, syncClass('claim'), (req, res) => {
  const row = get(Number(req.params.id));
  if (!row) { res.status(404).json({ error: 'Purchase request not found' }); return; }
  if (row.status !== 'liquidation_submitted') { res.status(409).json({ error: 'No submitted liquidation to return.' }); return; }
  const { note } = parseBody(rejectSchema, req.body);
  run(`UPDATE purchase_requests SET status='approved',close_note=? WHERE id=?`, note, row.id);
  res.json({ ok: true, status: 'approved' });
});

export default router;
