/** QC/QA checklists — named, reusable inspection checklists. Each belongs to one stage
 *  as a whole (stage: 1 = QC / first pass, 2 = QA / final pass). A finished product
 *  points at one per stage via `inventory_items.qc_checklist_qc_id` / `qc_checklist_qa_id`;
 *  the `is_default` row for that stage covers products with none. Inspectors fill the
 *  resolved checklist(s) when passing units on a job order (see job-orders.routes.ts
 *  `/units/inspect`). Reading is open to any logged-in user; creating / editing needs
 *  `qc.configure`. Mounted at /api/qc. */
import { Router } from 'express';
import { db, queryOne, queryAll, run } from '../../shared/db';
import { requireAuth, requirePermission, requireAnyPermission } from '../../shared/auth';
import { CHECKLISTS } from '../../shared/desk-access';
import { parseBody, qcChecklistSchema } from '../../shared/validation';
import type { QcChecklist, QcChecklistItem } from '../../shared/types';
import { syncClass } from '../../sync';

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
// Checklists: production screens, the inspectors who run them, and whoever configures them.
const checklistRead = requireAnyPermission(['production.view', 'qc.configure', ...CHECKLISTS]);
router.get('/checklists', checklistRead, (_req, res) => {
  const rows = queryAll<QcChecklist>('SELECT * FROM qc_checklists ORDER BY stage, is_default DESC, name COLLATE NOCASE');
  res.json(rows.map((r) => {
    const items = parseItems(r.items as string);
    return { id: r.id, name: r.name, stage: r.stage, is_default: r.is_default, item_count: items.length, items };
  }));
});

// GET /api/qc/checklists/:id — one checklist with its items
router.get('/checklists/:id', checklistRead, (req, res) => {
  const row = queryOne<QcChecklist>('SELECT * FROM qc_checklists WHERE id = ?', Number(req.params.id));
  if (!row) { res.status(404).json({ error: 'Checklist not found' }); return; }
  res.json({ ...row, items: parseItems(row.items as string) });
});

// POST /api/qc/checklists — qc.configure
router.post('/checklists', requirePermission('qc.configure'), syncClass('claim'), (req, res) => {
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
router.put('/checklists/:id', requirePermission('qc.configure'), syncClass('claim'), (req, res) => {
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
router.delete('/checklists/:id', requirePermission('qc.configure'), syncClass('claim'), (req, res) => {
  const info = run('DELETE FROM qc_checklists WHERE id = ?', Number(req.params.id));
  if (!info.changes) { res.status(404).json({ error: 'Checklist not found' }); return; }
  res.json({ ok: true });
});

// GET /api/qc/records — every pass/fail/hold finding across every job order (unit- and
// batch-level), for the Production → QA/QC "Reports & Findings" screen. Filters:
// result (pass|fail|hold), disposition, job_order_id, from/to (created_at), q (job order
// number / product name).
router.get('/records', requirePermission('production.view'), (req, res) => {
  const { result, disposition, job_order_id, from, to, q } = req.query;
  const where: string[] = [];
  const params: unknown[] = [];

  if (result === 'pass' || result === 'fail' || result === 'hold') { where.push('q.result = ?'); params.push(result); }
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
  const summary = queryOne<{ pass: number; fail: number; hold: number }>(
    `SELECT SUM(CASE WHEN q.result = 'pass' THEN 1 ELSE 0 END) AS pass,
            SUM(CASE WHEN q.result = 'fail' THEN 1 ELSE 0 END) AS fail,
            SUM(CASE WHEN q.result = 'hold' THEN 1 ELSE 0 END) AS hold
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
    summary: { pass: summary?.pass || 0, fail: summary?.fail || 0, hold: summary?.hold || 0 },
  });
});

/* GET /api/qc/holds — units QA held for review, oldest first, for whoever decides them (any QA
   inspector, production.qa_review, inventory.adjust): the hold record (reason, who, when, the
   checklist's issues) and how many evidence photos back it. Decided with
   POST /job-orders/:id/units/:unitId/hold-decision. */
router.get('/holds', requireAnyPermission(['inventory.adjust', 'production.inspect_qa', 'production.qa_review']), (_req, res) => {
  const rows = queryAll<{ id: number; identifier: string | null; stage: number; job_order_id: number; job_order_number: string;
    product_name: string; qc_stages: number; record_id: number; remarks: string | null; held_at: string; held_by_name: string | null;
    checklist: string | null; evidence: number }>(
    `SELECT u.id, u.identifier, u.stage, u.job_order_id, j.number AS job_order_number, j.product_name, j.qc_stages,
            q.id AS record_id, q.remarks, q.created_at AS held_at, us.full_name AS held_by_name, q.checklist,
            (SELECT COUNT(*) FROM qc_evidence e WHERE e.qc_record_id = q.id) AS evidence
     FROM job_order_units u
     JOIN job_orders j ON j.id = u.job_order_id
     JOIN qc_records q ON q.id = (SELECT MAX(id) FROM qc_records WHERE unit_id = u.id AND result = 'hold')
     LEFT JOIN users us ON us.id = q.inspector_id
     WHERE u.status = 'hold' ORDER BY q.id`
  );
  res.json(rows.map((r) => {
    let items: Array<{ label: string; status?: string; note?: string | null }> = [];
    try { items = r.checklist ? JSON.parse(r.checklist) : []; } catch { items = []; }
    const job = queryOne<{ product_item_id: number | null; qc_checklist_qc_snapshot: string | null; qc_checklist_qa_snapshot: string | null }>('SELECT product_item_id, qc_checklist_qc_snapshot, qc_checklist_qa_snapshot FROM job_orders WHERE id = ?', r.job_order_id);
    const frozen = (stage: 1 | 2): QcChecklistItem[] => {
      const raw = stage === 1 ? job?.qc_checklist_qc_snapshot : job?.qc_checklist_qa_snapshot;
      if (raw) { try { return (JSON.parse(raw) as { items?: QcChecklistItem[] }).items ?? []; } catch { return []; } }
      return checklistForProduct(job?.product_item_id, stage)?.items ?? [];
    };
    const checks = [...(r.qc_stages <= 1 ? frozen(1) : []), ...frozen(2)];
    return { ...r, checks, checklist: items, issues: items.filter((i) => i.status === 'issue').map((i) => ({ label: i.label, note: i.note ?? null })) };
  }));
});

/* GET /api/qc/queue?role=qc|qa — the inspector's unit queue across open job orders (mobile V2,
   Figma 69:16 / 72:16). Same pass rules as POST /job-orders/:id/units/inspect: the first pass is
   QC (production.inspect_qc), the final pass QA (production.inspect_qa), a single-stage job
   order's one combined pass accepts either; inventory.adjust sees everything. role narrows a
   dual-permission account to one desk. Rework units carry their last failure (remarks, failed
   checklist items, repair details) and open parts requests. Also: the caller's own results today. */
router.get('/queue', requireAnyPermission(['inventory.adjust', 'production.inspect_qc', 'production.inspect_qa']), (req, res) => {
  const perms = req.user!.permissions;
  const adjust = perms.includes('inventory.adjust');
  const hasQc = adjust || perms.includes('production.inspect_qc');
  const hasQa = adjust || perms.includes('production.inspect_qa');
  const role = req.query.role === 'qa' ? 'qa' : req.query.role === 'qc' ? 'qc' : hasQc ? 'qc' : 'qa';
  const units = queryAll<{
    id: number; identifier: string | null; status: string; stage: number; created_at: string; updated_at: string;
    job_order_id: number; job_order_number: string; product_name: string; qc_stages: number; priority: number;
    team_name: string | null; batch_number: string | null; batch_identifier: string | null;
  }>(
    `SELECT u.id, u.identifier, u.status, u.stage, u.created_at, u.updated_at,
            j.id AS job_order_id, j.number AS job_order_number, j.product_name, j.qc_stages, j.priority, j.intake_origin,
            t.name AS team_name, b.number AS batch_number, b.identifier AS batch_identifier
     FROM job_order_units u
     JOIN job_orders j ON j.id = u.job_order_id
     LEFT JOIN production_teams t ON t.id = j.team_id
     LEFT JOIN production_batches b ON b.id = u.batch_id
     WHERE u.status IN ('pending', 'rework') AND j.qc_stages > 0 AND j.status != 'cancelled'
     ORDER BY j.priority DESC, u.updated_at ASC, u.id ASC`
  );
  const mine = units.filter((u) => {
    const total = Math.max(1, u.qc_stages);
    const pass = u.stage + 1;
    if (total <= 1) return role === 'qc' ? hasQc : hasQa && !(hasQc && role !== 'qa');
    return role === 'qc' ? pass === 1 && hasQc : pass >= total && hasQa;
  });
  const lastRecord = (unitId: number, result?: string) => queryOne<{
    id: number; result: string; remarks: string | null; checklist: string | null; created_at: string; inspector_name: string | null;
    stage: number; repair_category: string | null; repair_station: string | null; repair_priority: string | null;
  }>(
    `SELECT q.id, q.result, q.remarks, q.checklist, q.created_at, q.stage, us.full_name AS inspector_name,
            rd.category AS repair_category, rd.station AS repair_station, rd.priority AS repair_priority
     FROM qc_records q LEFT JOIN users us ON us.id = q.inspector_id
     LEFT JOIN qc_repair_details rd ON rd.qc_record_id = q.id
     WHERE q.unit_id = ? ${result ? 'AND q.result = ?' : ''} ORDER BY q.id DESC LIMIT 1`,
    ...(result ? [unitId, result] : [unitId])
  );
  const parse = (s: string | null) => { try { return s ? JSON.parse(s) : []; } catch { return []; } };
  const out = mine.map((u) => {
    const lastFail = u.status === 'rework' ? lastRecord(u.id, 'fail') : undefined;
    const lastPass = lastRecord(u.id, 'pass');
    const openParts = queryOne<{ n: number }>(
      "SELECT COUNT(*) AS n FROM repair_part_requests WHERE unit_id = ? AND status = 'requested'", u.id
    )!.n;
    return {
      ...u,
      last_fail: lastFail ? { ...lastFail, checklist: parse(lastFail.checklist) } : null,
      last_pass: lastPass ? { created_at: lastPass.created_at, inspector_name: lastPass.inspector_name, stage: lastPass.stage,
        items: parse(lastPass.checklist).length } : null,
      open_part_requests: openParts,
    };
  });
  const completed = queryAll<{ id: number; unit_id: number; result: string; disposition: string | null; created_at: string;
    identifier: string | null; job_order_number: string; product_name: string; stage: number; qc_stages: number }>(
    `SELECT q.id, q.unit_id, q.result, q.disposition, q.created_at, q.stage, un.identifier, j.id AS job_order_id, j.number AS job_order_number,
            j.product_name, j.qc_stages
     FROM qc_records q JOIN job_orders j ON j.id = q.job_order_id LEFT JOIN job_order_units un ON un.id = q.unit_id
     WHERE q.inspector_id = ? AND q.created_at >= datetime('now', 'start of day') ORDER BY q.id DESC LIMIT 40`,
    req.user!.id
  ).filter((r) => {
    const total = Math.max(1, r.qc_stages);
    return role === 'qc' ? r.stage === 1 : r.stage >= total && total > 1 || (total <= 1 && role === 'qa');
  });
  res.json({ role, units: out, completed });
});

export default router;
