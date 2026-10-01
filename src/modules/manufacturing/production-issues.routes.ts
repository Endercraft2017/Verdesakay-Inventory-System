/** Production issue reports — raised on the floor against a whole job order or one unit
 *  (machine down, wrong part in the kit, defect pattern, safety…). Editable while open, so the
 *  line lead can update a report as things develop; resolved by the reporter or a manager.
 *  Photos are `attachments` kind 'production_issue' on the issue id. Mounted at
 *  /api/production-issues. Records only — nothing here moves stock or changes the job order. */
import { Router, type Request } from 'express';
import { queryOne, queryAll, run } from '../../shared/db';
import { requireAuth, requireAnyPermission } from '../../shared/auth';
import {
  parseBody,
  createProductionIssueSchema,
  updateProductionIssueSchema,
  resolveProductionIssueSchema,
} from '../../shared/validation';
import type { ProductionIssue } from '../../shared/types';
import { syncClass } from '../../sync';

const router = Router();
router.use(requireAuth);

const readGate = requireAnyPermission(['inventory.view']);
// Anyone working the job order can report: line lead, QC/QA inspectors, the RTS clerk (a
// product-data mismatch, which holds the unit out of stock — see rts.ts), the warehouse, managers.
const reportGate = requireAnyPermission([
  'inventory.adjust', 'production.record', 'production.inspect_qc', 'production.inspect_qa', 'production.approve',
  'production.receive',
]);

/** Managers may edit / resolve anyone's report; others only their own. */
function canManage(req: Request, issue: ProductionIssue): boolean {
  const p = req.user!.permissions;
  return issue.reported_by === req.user!.id || p.includes('inventory.adjust') || p.includes('production.approve');
}

const ISSUE_SELECT = `
  SELECT pi.*, j.number AS job_order_number, u.identifier AS unit_identifier,
         rb.full_name AS reported_by_name, ub.full_name AS updated_by_name, sb.full_name AS resolved_by_name,
         (SELECT COUNT(*) FROM attachments a WHERE a.kind = 'production_issue' AND a.ref_id = pi.id) AS photo_count
  FROM production_issues pi
  JOIN job_orders j ON j.id = pi.job_order_id
  LEFT JOIN job_order_units u ON u.id = pi.unit_id
  LEFT JOIN users rb ON rb.id = pi.reported_by
  LEFT JOIN users ub ON ub.id = pi.updated_by
  LEFT JOIN users sb ON sb.id = pi.resolved_by`;

const loadIssue = (id: number) => queryOne<ProductionIssue>(`${ISSUE_SELECT} WHERE pi.id = ?`, id);

/** The unit must belong to the job order the issue is filed against. */
function unitError(jobOrderId: number, unitId: number | null | undefined): string | null {
  if (unitId == null) return null;
  return queryOne('SELECT id FROM job_order_units WHERE id = ? AND job_order_id = ?', unitId, jobOrderId)
    ? null : 'That unit is not on this job order';
}

// GET /api/production-issues?job_order_id=&unit_id=&status=open|resolved
router.get('/', readGate, (req, res) => {
  const where: string[] = [];
  const params: unknown[] = [];
  if (req.query.job_order_id) { where.push('pi.job_order_id = ?'); params.push(Number(req.query.job_order_id)); }
  if (req.query.unit_id) { where.push('pi.unit_id = ?'); params.push(Number(req.query.unit_id)); }
  if (req.query.status === 'open' || req.query.status === 'resolved') { where.push('pi.status = ?'); params.push(req.query.status); }
  res.json(queryAll<ProductionIssue>(
    `${ISSUE_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY (pi.status = 'open') DESC, pi.id DESC LIMIT 500`, ...params
  ));
});

router.get('/:id', readGate, (req, res) => {
  const issue = loadIssue(Number(req.params.id));
  if (!issue) { res.status(404).json({ error: 'Issue not found' }); return; }
  res.json(issue);
});

// POST /api/production-issues — { job_order_id, unit_id?, category, severity?, description }
router.post('/', reportGate, syncClass('merge'), (req, res) => {
  const input = parseBody(createProductionIssueSchema, req.body);
  if (!queryOne('SELECT id FROM job_orders WHERE id = ?', input.job_order_id)) {
    res.status(404).json({ error: 'Job order not found' });
    return;
  }
  const uErr = unitError(input.job_order_id, input.unit_id);
  if (uErr) { res.status(400).json({ error: uErr }); return; }
  const id = Number(run(
    `INSERT INTO production_issues (job_order_id, unit_id, category, severity, description, reported_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    input.job_order_id, input.unit_id ?? null, input.category, input.severity ?? 'normal', input.description,
    req.user!.id, req.user!.id
  ).lastInsertRowid);
  res.status(201).json(loadIssue(id));
});

// PUT /api/production-issues/:id — edit an open report (reporter or a manager)
router.put('/:id', reportGate, syncClass('claim'), (req, res) => {
  const issue = loadIssue(Number(req.params.id));
  if (!issue) { res.status(404).json({ error: 'Issue not found' }); return; }
  if (!canManage(req, issue)) { res.status(403).json({ error: 'Only the reporter or a manager can edit this report' }); return; }
  if (issue.status !== 'open') { res.status(409).json({ error: 'Re-open the issue before editing it' }); return; }
  const input = parseBody(updateProductionIssueSchema, req.body);
  const unitId = input.unit_id !== undefined ? input.unit_id : issue.unit_id;
  const uErr = unitError(issue.job_order_id, unitId);
  if (uErr) { res.status(400).json({ error: uErr }); return; }
  run(
    `UPDATE production_issues SET unit_id = ?, category = ?, severity = ?, description = ?,
       updated_by = ?, updated_at = datetime('now') WHERE id = ?`,
    unitId ?? null, input.category ?? issue.category, input.severity ?? issue.severity,
    input.description ?? issue.description, req.user!.id, issue.id
  );
  res.json(loadIssue(issue.id));
});

// POST /api/production-issues/:id/resolve — { resolution? }
router.post('/:id/resolve', reportGate, syncClass('claim'), (req, res) => {
  const issue = loadIssue(Number(req.params.id));
  if (!issue) { res.status(404).json({ error: 'Issue not found' }); return; }
  if (!canManage(req, issue)) { res.status(403).json({ error: 'Only the reporter or a manager can resolve this report' }); return; }
  if (issue.status === 'resolved') { res.status(409).json({ error: 'Already resolved' }); return; }
  const { resolution } = parseBody(resolveProductionIssueSchema, req.body ?? {});
  run(
    `UPDATE production_issues SET status = 'resolved', resolution = ?, resolved_by = ?, resolved_at = datetime('now'),
       updated_by = ?, updated_at = datetime('now') WHERE id = ?`,
    resolution ?? null, req.user!.id, req.user!.id, issue.id
  );
  res.json(loadIssue(issue.id));
});

// POST /api/production-issues/:id/reopen
router.post('/:id/reopen', reportGate, syncClass('claim'), (req, res) => {
  const issue = loadIssue(Number(req.params.id));
  if (!issue) { res.status(404).json({ error: 'Issue not found' }); return; }
  if (!canManage(req, issue)) { res.status(403).json({ error: 'Only the reporter or a manager can re-open this report' }); return; }
  if (issue.status === 'open') { res.status(409).json({ error: 'The issue is already open' }); return; }
  run(
    `UPDATE production_issues SET status = 'open', resolved_by = NULL, resolved_at = NULL,
       updated_by = ?, updated_at = datetime('now') WHERE id = ?`,
    req.user!.id, issue.id
  );
  res.json(loadIssue(issue.id));
});

export default router;
