/** QC/QA checklists — named, reusable inspection checklists. Each belongs to one stage
 *  as a whole (stage: 1 = QC / first pass, 2 = QA / final pass). A finished product
 *  points at one per stage via `inventory_items.qc_checklist_qc_id` / `qc_checklist_qa_id`;
 *  the `is_default` row for that stage covers products with none. Inspectors fill the
 *  resolved checklist(s) when passing units on a job order (see job-orders.routes.ts
 *  `/units/inspect`). Reading is open to any logged-in user; creating / editing needs
 *  `qc.configure`. Mounted at /api/qc. */
import { Router } from 'express';
import { db, queryOne, queryAll, run } from '../../shared/db';
import { requireAuth, requirePermission } from '../../shared/auth';
import { parseBody, qcChecklistSchema } from '../../shared/validation';
import type { QcChecklist, QcChecklistItem } from '../../shared/types';

const router = Router();
router.use(requireAuth);

function parseItems(raw: string | null | undefined): QcChecklistItem[] {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? (v as QcChecklistItem[]) : [];
  } catch {
    return [];
  }
}

/** One checklist row by id, with parsed items (or undefined). */
export function checklistById(id: number): { id: number; name: string; items: QcChecklistItem[] } | undefined {
  const row = queryOne<QcChecklist>('SELECT id, name, items FROM qc_checklists WHERE id = ?', id);
  return row ? { id: row.id, name: row.name, items: parseItems(row.items as string) } : undefined;
}

/** The checklist that applies to a job order's product at a given stage (1 = QC,
 *  2 = QA): the product's own checklist for that stage, else that stage's default,
 *  else null (no checks → no enforcement). */
export function checklistForProduct(
  productItemId: number | null | undefined,
  stage: 1 | 2
): { id: number; name: string; items: QcChecklistItem[] } | null {
  const col = stage === 1 ? 'qc_checklist_qc_id' : 'qc_checklist_qa_id';
  if (productItemId) {
    const link = queryOne<{ checklist_id: number | null }>(
      `SELECT ${col} AS checklist_id FROM inventory_items WHERE id = ?`,
      productItemId
    );
    if (link?.checklist_id) {
      const own = checklistById(link.checklist_id);
      if (own) return own;
    }
  }
  const def = queryOne<QcChecklist>('SELECT id, name, items FROM qc_checklists WHERE is_default = 1 AND stage = ? LIMIT 1', stage);
  return def ? { id: def.id, name: def.name, items: parseItems(def.items as string) } : null;
}

// GET /api/qc/checklists — all checklists (name + counts), for pickers / management
router.get('/checklists', (_req, res) => {
  const rows = queryAll<QcChecklist>('SELECT * FROM qc_checklists ORDER BY stage, is_default DESC, name COLLATE NOCASE');
  res.json(rows.map((r) => {
    const items = parseItems(r.items as string);
    return { id: r.id, name: r.name, stage: r.stage, is_default: r.is_default, item_count: items.length, items };
  }));
});

// GET /api/qc/checklists/:id — one checklist with its items
router.get('/checklists/:id', (req, res) => {
  const row = queryOne<QcChecklist>('SELECT * FROM qc_checklists WHERE id = ?', Number(req.params.id));
  if (!row) { res.status(404).json({ error: 'Checklist not found' }); return; }
  res.json({ ...row, items: parseItems(row.items as string) });
});

// POST /api/qc/checklists — qc.configure
router.post('/checklists', requirePermission('qc.configure'), (req, res) => {
  const input = parseBody(qcChecklistSchema, req.body);
  db.exec('BEGIN');
  try {
    // 'Default' is scoped per stage — making this one default only unseats the other
    // default checklist of the SAME stage, not the other stage's.
    if (input.is_default) run('UPDATE qc_checklists SET is_default = 0 WHERE stage = ?', input.stage);
    const info = run(
      'INSERT INTO qc_checklists (name, items, stage, is_default, created_by) VALUES (?, ?, ?, ?, ?)',
      input.name, JSON.stringify(input.items), input.stage, input.is_default ? 1 : 0, req.user!.id
    );
    db.exec('COMMIT');
    res.status(201).json({ id: info.lastInsertRowid });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
});

// PUT /api/qc/checklists/:id — qc.configure
router.put('/checklists/:id', requirePermission('qc.configure'), (req, res) => {
  const id = Number(req.params.id);
  if (!queryOne('SELECT id FROM qc_checklists WHERE id = ?', id)) {
    res.status(404).json({ error: 'Checklist not found' }); return;
  }
  const input = parseBody(qcChecklistSchema, req.body);
  db.exec('BEGIN');
  try {
    if (input.is_default) run('UPDATE qc_checklists SET is_default = 0 WHERE stage = ? AND id != ?', input.stage, id);
    run(
      "UPDATE qc_checklists SET name = ?, items = ?, stage = ?, is_default = ?, updated_at = datetime('now') WHERE id = ?",
      input.name, JSON.stringify(input.items), input.stage, input.is_default ? 1 : 0, id
    );
    db.exec('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
});

// DELETE /api/qc/checklists/:id — qc.configure (products lose the link via ON DELETE SET NULL)
router.delete('/checklists/:id', requirePermission('qc.configure'), (req, res) => {
  const info = run('DELETE FROM qc_checklists WHERE id = ?', Number(req.params.id));
  if (!info.changes) { res.status(404).json({ error: 'Checklist not found' }); return; }
  res.json({ ok: true });
});

// GET /api/qc/records — every pass/fail finding across every job order (unit- and
// batch-level), for the Production → QA/QC "Reports & Findings" screen. Filters:
// result (pass|fail), disposition, job_order_id, from/to (created_at), q (job order
// number / product name).
router.get('/records', requirePermission('inventory.view'), (req, res) => {
  const { result, disposition, job_order_id, from, to, q } = req.query;
  const where: string[] = [];
  const params: unknown[] = [];

  if (result === 'pass' || result === 'fail') { where.push('q.result = ?'); params.push(result); }
  if (typeof disposition === 'string' && disposition.trim()) { where.push('q.disposition = ?'); params.push(disposition.trim()); }
  if (job_order_id) { where.push('q.job_order_id = ?'); params.push(Number(job_order_id)); }
  if (typeof from === 'string' && from.trim()) { where.push('q.created_at >= ?'); params.push(from.trim()); }
  if (typeof to === 'string' && to.trim()) { where.push('q.created_at <= ?'); params.push(to.trim()); }
  if (typeof q === 'string' && q.trim()) {
    where.push('(j.number LIKE ? OR j.product_name LIKE ?)');
    const like = `%${q.trim()}%`;
    params.push(like, like);
  }
  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const offset = Math.max(0, Number(req.query.offset) || 0);

  const total =
    queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM qc_records q JOIN job_orders j ON j.id = q.job_order_id${whereSql}`,
      ...params
    )?.n ?? 0;
  const summary = queryOne<{ pass: number; fail: number }>(
    `SELECT SUM(CASE WHEN q.result = 'pass' THEN 1 ELSE 0 END) AS pass,
            SUM(CASE WHEN q.result = 'fail' THEN 1 ELSE 0 END) AS fail
     FROM qc_records q JOIN job_orders j ON j.id = q.job_order_id${whereSql}`,
    ...params
  );
  const rows = queryAll<{ checklist: string | null }>(
    `SELECT q.*, j.number AS job_order_number, j.product_name AS product_name,
            u.full_name AS inspector_name, un.identifier AS unit_identifier, b.number AS batch_number
     FROM qc_records q
     JOIN job_orders j ON j.id = q.job_order_id
     LEFT JOIN users u ON u.id = q.inspector_id
     LEFT JOIN job_order_units un ON un.id = q.unit_id
     LEFT JOIN production_batches b ON b.id = q.batch_id
     ${whereSql}
     ORDER BY q.id DESC
     LIMIT ? OFFSET ?`,
    ...params,
    limit,
    offset
  );
  res.json({
    rows: rows.map((r) => {
      let checklist: unknown = null;
      try { checklist = r.checklist ? JSON.parse(r.checklist) : null; } catch { checklist = null; }
      return { ...r, checklist };
    }),
    total,
    limit,
    offset,
    summary: { pass: summary?.pass || 0, fail: summary?.fail || 0 },
  });
});

export default router;
