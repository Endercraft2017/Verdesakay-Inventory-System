/** QA/QC checklists — named, reusable inspection checklists. A finished product
 *  points at one via `inventory_items.qc_checklist_id`; the `is_default` row covers
 *  products with none. Inspectors fill the resolved checklist when passing units
 *  on a job order (see job-orders.routes.ts `/units/inspect`). Reading is open to
 *  any logged-in user; creating / editing needs `qc.configure`. Mounted at /api/qc. */
import { Router } from 'express';
import { db, queryOne, queryAll, run } from '../db';
import { requireAuth, requirePermission } from '../auth';
import { parseBody, qcChecklistSchema } from '../validation';
import type { QcChecklist, QcChecklistItem } from '../types';

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

/** The checklist that applies to a job order's product: the product's own, else the
 *  default one, else null (no checks → no enforcement). */
export function checklistForProduct(
  productItemId: number | null | undefined
): { id: number; name: string; items: QcChecklistItem[] } | null {
  if (productItemId) {
    const link = queryOne<{ qc_checklist_id: number | null }>(
      'SELECT qc_checklist_id FROM inventory_items WHERE id = ?',
      productItemId
    );
    if (link?.qc_checklist_id) {
      const own = checklistById(link.qc_checklist_id);
      if (own) return own;
    }
  }
  const def = queryOne<QcChecklist>('SELECT id, name, items FROM qc_checklists WHERE is_default = 1 LIMIT 1');
  return def ? { id: def.id, name: def.name, items: parseItems(def.items as string) } : null;
}

// GET /api/qc/checklists — all checklists (name + counts), for pickers / management
router.get('/checklists', (_req, res) => {
  const rows = queryAll<QcChecklist>('SELECT * FROM qc_checklists ORDER BY is_default DESC, name COLLATE NOCASE');
  res.json(rows.map((r) => {
    const items = parseItems(r.items as string);
    return { id: r.id, name: r.name, is_default: r.is_default, item_count: items.length, items };
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
    if (input.is_default) run('UPDATE qc_checklists SET is_default = 0');
    const info = run(
      'INSERT INTO qc_checklists (name, items, is_default, created_by) VALUES (?, ?, ?, ?)',
      input.name, JSON.stringify(input.items), input.is_default ? 1 : 0, req.user!.id
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
    if (input.is_default) run('UPDATE qc_checklists SET is_default = 0 WHERE id != ?', id);
    run(
      "UPDATE qc_checklists SET name = ?, items = ?, is_default = ?, updated_at = datetime('now') WHERE id = ?",
      input.name, JSON.stringify(input.items), input.is_default ? 1 : 0, id
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

export default router;
