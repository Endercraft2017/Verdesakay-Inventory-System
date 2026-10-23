import { Router } from 'express';
import { syncClass } from '../../sync';
import { now } from '../../shared/sync-context';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { db, queryOne, queryAll, run } from '../../shared/db';
import { requireAuth, requirePermission } from '../../shared/auth';
import { parseBody, createCustomerCaseSchema, updateCustomerCaseSchema } from '../../shared/validation';
import { caseError, getCase, canEditCase, caseOwners, validateCase, recordCaseEvent, terminalCase } from './customer-cases';

const router = Router();
router.use(requireAuth, requirePermission('orders.view'), requirePermission('cases.view'));
const listSQL = `SELECT c.*, u.full_name AS owner_name, cu.name AS customer_name,
  CASE WHEN u.active=0 THEN 1 ELSE 0 END AS owner_inactive
  FROM customer_cases c JOIN customers cu ON cu.id=c.customer_id JOIN users u ON u.id=c.owner_id`;

router.get('/owners', (_req, res) => { res.json(caseOwners()); });
router.get('/', (req, res) => {
  const where: string[] = []; const args: unknown[] = [];
  const mine = req.query.scope !== 'team';
  if (!mine && !req.user!.permissions.includes('cases.assign')) caseError(403, 'Team queue requires assignment access');
  if (mine) { where.push('c.owner_id=?'); args.push(req.user!.id); }
  if (req.query.customer_id) { where.push('c.customer_id=?'); args.push(Number(req.query.customer_id)); }
  if (req.query.closed !== '1') where.push("c.status NOT IN ('resolved','cancelled')");
  if (req.query.before) {
    const date = z.iso.datetime({ offset: true }).safeParse(req.query.before);
    if (!date.success) caseError(400, 'Invalid due-time filter');
    where.push('c.due_at<=?'); args.push(new Date(date.data).toISOString());
  }
  const offset = Math.max(0, Number(req.query.offset) || 0);
  res.json(queryAll(listSQL + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY c.due_at, c.id LIMIT 51 OFFSET ?', ...args, offset));
});
router.get('/:id', (req, res) => {
  const c = queryOne(listSQL + ' WHERE c.id=?', Number(req.params.id));
  if (!c) caseError(404, 'Case not found');
  res.json(c);
});
router.get('/:id/events', (req, res) => {
  getCase(Number(req.params.id));
  res.json(queryAll('SELECT * FROM customer_case_events WHERE case_id=? ORDER BY id DESC LIMIT 51 OFFSET ?', Number(req.params.id), Math.max(0, Number(req.query.offset) || 0)));
});
router.post('/', requirePermission('cases.edit'), syncClass('online'), (req, res) => {
  const b = parseBody(createCustomerCaseSchema, req.body);
  if (b.owner_id !== req.user!.id && !req.user!.permissions.includes('cases.assign')) caseError(403, 'Create your own case or ask a supervisor to assign it');
  const key = `${req.user!.id}:${b.request_key}`;
  const hash = createHash('sha256').update(JSON.stringify(b)).digest('hex');
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = queryOne<{ id: number; create_hash: string }>('SELECT id, create_hash FROM customer_cases WHERE create_key=?', key);
    if (existing) {
      if (existing.create_hash !== hash) caseError(409, 'This request was already saved with different details; reopen the saved case');
      db.exec('COMMIT'); res.json({ id: existing.id, replayed: true }); return;
    }
    validateCase(b);
    const closed = terminalCase(b.status);
    const saved = run(`INSERT INTO customer_cases(customer_id,kind,summary,status,owner_id,next_action,due_at,sale_order_id,resolution,created_by,create_key,create_hash)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, b.customer_id,b.kind,b.summary,b.status,b.owner_id,closed?null:b.next_action,closed?null:b.due_at,b.sale_order_id,b.resolution,req.user!.id,key,hash);
    const caseId = Number(saved.lastInsertRowid);
    recordCaseEvent(caseId, req.user!, 'created', b.note);
    db.exec('COMMIT'); res.status(201).json({ id: caseId });
  } catch(e) { db.exec('ROLLBACK'); throw e; }
});
router.put('/:id', requirePermission('cases.edit'), syncClass('online'), (req, res) => {
  const b = parseBody(updateCustomerCaseSchema, req.body);
  db.exec('BEGIN IMMEDIATE');
  try {
    const c = getCase(Number(req.params.id));
    if (!canEditCase(req.user!, c)) caseError(403, 'Only the owner or a supervisor can update this case');
    if (c.version !== b.version) caseError(409, 'This case changed. Close and reopen it before saving; your update has not been applied.');
    if (c.kind === 'inquiry' && c.sale_order_id && b.sale_order_id !== c.sale_order_id) caseError(409, 'A linked inquiry sale cannot be replaced or removed');
    validateCase({ ...c, ...b });
    const closed = terminalCase(b.status);
    run(`UPDATE customer_cases SET summary=?,status=?,owner_id=?,next_action=?,due_at=?,sale_order_id=?,resolution=?,version=version+1,
      updated_at=? WHERE id=? AND version=?`,
      b.summary,b.status,b.owner_id,closed?null:b.next_action,closed?null:b.due_at,b.sale_order_id,b.resolution,now().toISOString(),c.id,b.version);
    recordCaseEvent(c.id, req.user!, c.owner_id !== b.owner_id ? 'handover' : 'updated', b.note);
    db.exec('COMMIT'); res.json({ id: c.id, version: c.version+1 });
  } catch(e) { db.exec('ROLLBACK'); throw e; }
});
export default router;
