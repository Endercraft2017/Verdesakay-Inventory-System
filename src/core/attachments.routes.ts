/** Photo attachments hung off another record — QC unit inspections, damage
 *  reports, problem reports, delivery proofs (photos + signature), release-slip photos. Files stored
 *  under UPLOAD_DIR; rows in `attachments`. Mounted at /api/attachments.
 *
 *  Permissions are per `kind` (see `canRead` / `canWrite`), so a delivery driver
 *  with only `delivery.run` can attach a POD photo without holding `inventory.*`. */
import path from 'node:path';
import fs from 'node:fs';
import { storeDurableUpload, resolveDurableUploadAsync, forgetDurableUpload } from '../shared/durable-uploads';
import crypto from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { queryOne, queryAll, run, uploadDir } from '../shared/db';
import { requireAuth } from '../shared/auth';
import { LINE, INSPECT, RTS, UNIT_PHOTOS } from '../shared/desk-access';
import { enforceQuota } from '../platform/quota';
import type { Permission } from '../shared/types';
import { syncClass } from '../sync';
import { syncUpload } from '../sync/files';
import { sideEffectsSuppressed, siteDecisionStands } from '../shared/sync-context';

const router = Router();
router.use(requireAuth);

const KINDS = new Set(['qc_unit', 'damage', 'problem', 'delivery', 'signature', 'release', 'release_proof', 'release_acknowledgment', 'sales_return_proof', 'sales_return', 'parts_release', 'production_issue']);
const IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/** Which permission(s) a kind needs. `[]` = any authenticated user. */
const READ_PERMS: Record<string, Permission[]> = {
  // A unit's photos (build photo, QC/QA evidence): production screens and the desks handling it.
  qc_unit: ['inventory.view', 'production.view', ...UNIT_PHOTOS],
  damage: ['inventory.view'],
  problem: [],
  delivery: ['delivery.run', 'delivery.manage'],
  signature: ['delivery.run', 'delivery.manage'],
  // Photos of goods leaving on a release slip (ref_id = release_slips.id).
  release: ['inventory.adjust', 'orders.release', 'orders.view'],
  // Handoff photos taken before the slip exists (ref_id = orders.id); the slip takes them over as 'release'.
  release_proof: ['inventory.adjust', 'orders.release', 'orders.view'],
  release_acknowledgment:['inventory.adjust','orders.release','orders.view'],
  sales_return_proof: ['returns.receive','returns.inspect','returns.dispose','orders.release','orders.view'],
  sales_return: ['returns.receive','returns.inspect','returns.dispose','orders.release','orders.view'],
  // Photos of the parts kit on a job order's parts release slip (ref_id = parts_release_slips.id).
  parts_release: ['inventory.view', 'production.view', ...LINE],
  // Photos on a production issue report (ref_id = production_issues.id).
  production_issue: ['inventory.view', 'production.view', ...LINE, ...INSPECT, ...RTS],
};
// Everyone on the production floor: the line lead photographs each unit off the line, and the
// QC/QA inspectors photograph defects — none of them hold inventory.adjust.
const FLOOR_PERMS: Permission[] = [
  'production.record', 'production.inspect_qc', 'production.inspect_qa',
];
const WRITE_PERMS: Record<string, Permission[]> = {
  qc_unit: FLOOR_PERMS,
  damage: ['inventory.adjust'],
  problem: [],
  delivery: ['delivery.run', 'delivery.manage'],
  signature: ['delivery.run', 'delivery.manage'],
  release: ['orders.release'],
  release_proof: ['orders.release'],
  release_acknowledgment:['orders.release'],
  sales_return_proof: ['returns.receive'],
  sales_return: ['returns.receive', 'returns.inspect'],
  parts_release: ['production.kit_release'],
  production_issue: [...FLOOR_PERMS, 'production.approve', 'production.manage', 'production.receive'],
};
function allows(req: Request, perms: Permission[]): boolean {
  return perms.length === 0 || perms.some((p) => req.user!.permissions.includes(p));
}
function issuePhotoReadable(req: Request, refId: number): boolean {
  const p = req.user!.permissions;
  if (p.includes('inventory.view') || p.includes('production.view')) return true;
  const issue = queryOne<{ unit_id: number | null; reported_by: number | null }>('SELECT unit_id, reported_by FROM production_issues WHERE id = ?', refId);
  return !!issue && (issue.unit_id != null || issue.reported_by === req.user!.id || p.some(x => ['inventory.adjust', 'production.approve', 'production.manage'].includes(x)));
}
function deliveryEvidenceAccess(req: Request, refId: number): { found: boolean; allowed: boolean; status: string | null } {
  const delivery = queryOne<{ assigned_to: number | null; status: string }>(
    'SELECT assigned_to, status FROM deliveries WHERE id = ?', refId);
  return { found: !!delivery, allowed: !!delivery && (req.user!.permissions.includes('delivery.manage') || delivery.assigned_to === req.user!.id),
    status: delivery?.status ?? null };
}
const deliveryEvidence = (kind: string): boolean => kind === 'delivery' || kind === 'signature';

export const imageUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir()),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).slice(0, 12) || '.jpg';
      cb(null, `att-${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, IMAGE_MIME.has(file.mimetype)),
});

export function unlink(name: string | null | undefined): void {
  if (name) fs.promises.unlink(path.join(uploadDir(), name)).catch(() => {});
}

interface Row {
  id: number; kind: string; ref_id: number; image_path: string;
  caption: string | null; uploaded_by: number | null; created_at: string;
  uploaded_by_name?: string | null;
}

// GET /api/attachments?kind=&ref_id= — list attachments for one record
router.get('/', (req, res) => {
  const kind = String(req.query.kind || '');
  const refId = Number(req.query.ref_id);
  if (!KINDS.has(kind) || !Number.isInteger(refId) || refId <= 0) {
    res.status(400).json({ error: 'kind and ref_id are required' });
    return;
  }
  if (!allows(req, READ_PERMS[kind] ?? ['inventory.view'])) { res.status(403).json({ error: 'Forbidden' }); return; }
  if (deliveryEvidence(kind)) {
    const access = deliveryEvidenceAccess(req, refId);
    if (!access.found) { res.status(404).json({ error: 'Delivery not found' }); return; }
    if (!access.allowed) { res.status(403).json({ error: 'Not your delivery' }); return; }
  }
  if (kind === 'production_issue' && !issuePhotoReadable(req, refId)) { res.status(403).json({ error: 'Open a unit-linked report to view its photos.' }); return; }
  const rows = queryAll<Row>(
    `SELECT a.id, a.kind, a.ref_id, a.caption, a.created_at, a.uploaded_by, u.full_name AS uploaded_by_name
     FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by
     WHERE a.kind = ? AND a.ref_id = ?${kind === 'problem' && !req.user!.permissions.includes('evidence.manage') ? ' AND a.uploaded_by = ?' : ''} ORDER BY a.id`,
    kind, refId, ...(kind === 'problem' && !req.user!.permissions.includes('evidence.manage') ? [req.user!.id] : [])
  );
  res.json(rows.map((r) => ({ ...r, url: `/api/attachments/${r.id}/image`,
    ...(kind === 'production_issue' ? { inspection_available: r.uploaded_by === req.user!.id && !queryOne('SELECT 1 FROM qc_evidence WHERE attachment_id = ?', r.id) } : {}) })));
});

// GET /api/attachments/:id/image — stream the file
router.get('/:id/image', async (req, res) => {
  const row = queryOne<Row>('SELECT kind, ref_id, image_path, uploaded_by FROM attachments WHERE id = ?', Number(req.params.id));
  if (!row) { res.status(404).json({ error: 'Attachment not found' }); return; }
  if (row.kind === 'problem' && row.uploaded_by !== req.user!.id && !req.user!.permissions.includes('evidence.manage')) {res.status(403).json({error:'This evidence belongs to another account'});return;}
  if (!allows(req, READ_PERMS[row.kind] ?? ['inventory.view'])) { res.status(403).json({ error: 'Forbidden' }); return; }
  if (deliveryEvidence(row.kind) && !deliveryEvidenceAccess(req, row.ref_id).allowed) {
    res.status(403).json({ error: 'Not your delivery' }); return;
  }
  if (row.kind === 'production_issue' && !issuePhotoReadable(req, row.ref_id)) { res.status(403).json({ error: 'This desk reads unit-linked report photos only.' }); return; }
  const file = await resolveDurableUploadAsync(row.image_path);
  if (!file) { res.status(410).json({ error: 'File is no longer available' }); return; }
  res.sendFile(file);
});

// POST /api/attachments — { kind, ref_id, caption? } + an `image` file
// A photo is a fact: taken offline, it travels with its command (src/sync/files.ts).
router.post('/', syncClass('physical'), syncUpload(imageUpload.single('image')), (req, res) => {
  const kind = String(req.body?.kind || '');
  const refId = Number(req.body?.ref_id);
  const caption = typeof req.body?.caption === 'string' ? req.body.caption.trim().slice(0, 300) : null;
  if (!KINDS.has(kind) || !Number.isInteger(refId) || refId <= 0) {
    if (req.file) unlink(req.file.filename);
    res.status(400).json({ error: 'kind and ref_id are required' });
    return;
  }
  if (!allows(req, WRITE_PERMS[kind] ?? ['inventory.adjust'])) {
    if (req.file) unlink(req.file.filename);
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  if (deliveryEvidence(kind)) {
    const access = deliveryEvidenceAccess(req, refId);
    // An offline owning-site delivery may arrive after a cloud cancellation; keep
    // its already-captured proof so the later physical decision can be reconciled.
    if (!access.found || !access.allowed || (!['pending', 'out_for_delivery', 'cancelled'].includes(access.status || '') && !siteDecisionStands())) {
      if (req.file) unlink(req.file.filename);
      res.status(!access.found ? 404 : !access.allowed ? 403 : 409).json({ error: !access.found ? 'Delivery not found' : !access.allowed ? 'Not your delivery' : 'Completed delivery evidence is locked.' }); return;
    }
  }
  if (kind === 'production_issue') {
    const issue = queryOne<{ reported_by: number | null; status: string }>('SELECT reported_by, status FROM production_issues WHERE id = ?', refId);
    const p = req.user!.permissions;
    if (!issue || (issue.reported_by !== req.user!.id && !p.some(x => ['inventory.adjust', 'production.approve', 'production.manage'].includes(x))) || issue.status !== 'open') {
      if (req.file) unlink(req.file.filename);
      res.status(!issue ? 404 : issue.status !== 'open' ? 409 : 403).json({ error: !issue ? 'Issue report not found' : issue.status !== 'open' ? 'Reopen the report before adding photos.' : 'Only the reporter or a manager can add photos to this report.' }); return;
    }
  }
  if (kind === 'qc_unit' && !queryOne('SELECT 1 FROM job_order_units WHERE id=?',refId)) {if(req.file)unlink(req.file.filename);res.status(404).json({error:'Production unit not found'});return;}
  if (kind === 'qc_unit' && queryOne("SELECT 1 FROM job_order_units WHERE id=? AND status NOT IN ('pending','rework')",refId)) {if(req.file)unlink(req.file.filename);res.status(409).json({error:'Completed unit evidence is locked'});return;}
  if(kind==='release_acknowledgment'){
    // ref_id identifies the exact assignment, not merely the order. A replaced
    // receiver/authorization cannot inherit a signature collected for an earlier one.
    const auth=queryOne(`SELECT a.id FROM release_authorizations a JOIN users u ON u.id=a.receiver_user_id
      WHERE a.id=? AND a.handoff_type='internal' AND a.revoked_at IS NULL AND a.used_slip_id IS NULL
      AND a.valid_until>=datetime('now') AND u.active=1`,refId);
    if(!auth||!req.file?.size){if(req.file)unlink(req.file.filename);res.status(409).json({error:'A current internal receiver assignment and a non-empty signature image are required.'});return;}
  }
  if (!req.file) {
    res.status(400).json({ error: 'An image file is required (JPG, PNG, GIF or WebP)' });
    return;
  }
  try {
    enforceQuota('storage_mb');
  } catch (e) {
    unlink(req.file.filename);
    throw e;
  }
  const id = saveAttachment(kind, refId, req.file.filename, caption || null, req.user!.id);
  res.status(201).json({ id, url: `/api/attachments/${id}/image` });
});

/** Record an already-uploaded file (multer, via `imageUpload`) as an attachment. For routes
 *  that take a photo together with the record it belongs to (e.g. POST /job-orders/:id/units),
 *  so the two are saved in one request. Caller checks permissions and the storage quota. */
export function saveAttachment(kind: string, refId: number, filename: string, caption: string | null, userId: number): number {
  const info = run(
    'INSERT INTO attachments (kind, ref_id, image_path, caption, uploaded_by) VALUES (?, ?, ?, ?, ?)',
    kind, refId, filename, caption, userId
  );
  storeDurableUpload(filename);
  return Number(info.lastInsertRowid);
}

// DELETE /api/attachments/:id
router.delete('/:id', syncClass('claim'), (req, res) => {
  const row = queryOne<Row>('SELECT kind, ref_id, image_path, uploaded_by FROM attachments WHERE id = ?', Number(req.params.id));
  if (!row) { res.status(404).json({ error: 'Attachment not found' }); return; }
  if (row.kind === 'problem' && row.uploaded_by !== req.user!.id && !req.user!.permissions.includes('evidence.manage')) {res.status(403).json({error:'This evidence belongs to another account'});return;}
  if (row.uploaded_by !== req.user!.id && !req.user!.permissions.includes('evidence.manage')) {res.status(403).json({error:'Only the uploader or an evidence custodian may remove this photo'});return;}
  if (!allows(req, WRITE_PERMS[row.kind] ?? ['inventory.adjust'])) { res.status(403).json({ error: 'Forbidden' }); return; }
  if (deliveryEvidence(row.kind)) {
    const access = deliveryEvidenceAccess(req, row.ref_id);
    if (!access.allowed) { res.status(403).json({ error: 'Not your delivery' }); return; }
    if (!['pending', 'out_for_delivery'].includes(access.status || '')) {
      res.status(409).json({ error: 'Completed delivery evidence is locked.' }); return;
    }
  }
  if (row.kind === 'qc_unit' && queryOne("SELECT 1 FROM job_order_units WHERE id=? AND status NOT IN ('pending','rework')",row.ref_id)) {res.status(409).json({error:'Completed unit evidence is locked'});return;}
  if (row.kind === 'release') {
    res.status(409).json({ error: 'Issued release-slip evidence is locked.' }); return;
  }
  if (row.kind === 'production_issue') {
    const issue = queryOne<{ reported_by: number | null; status: string }>('SELECT reported_by, status FROM production_issues WHERE id = ?', row.ref_id);
    const p = req.user!.permissions;
    if (!issue || (issue.reported_by !== req.user!.id && !p.some(x => ['inventory.adjust', 'production.approve', 'production.manage'].includes(x)))) { res.status(403).json({ error: 'Only the reporter or a manager can remove report photos.' }); return; }
    if (issue.status !== 'open') { res.status(409).json({ error: 'Reopen this report before changing its photos.' }); return; }
  }
  if (queryOne('SELECT 1 FROM qc_evidence WHERE attachment_id = ?', Number(req.params.id))) { res.status(409).json({ error: 'This photo is retained as inspection evidence and cannot be deleted.' }); return; }
  run('DELETE FROM attachments WHERE id = ?', Number(req.params.id));
  // An installed PC keeps the file until the cloud confirms: a refused delete brings the row back.
  if (!sideEffectsSuppressed('unlink')) {
    forgetDurableUpload(row.image_path);
    unlink(row.image_path);
  }
  res.json({ ok: true });
});

// Multer errors (file too large, wrong field) → 400
router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (err instanceof multer.MulterError) {
    res.status(400).json({ error: `Upload failed: ${err.message}` });
    return;
  }
  next(err);
});

export default router;
