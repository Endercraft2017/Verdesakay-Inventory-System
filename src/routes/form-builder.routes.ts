/** Form builder: per-section-managed form definitions, per-form record CRUD, global variables. */
import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { db, queryOne, queryAll, run, nextSequence } from '../db';
import { requireAuth, requirePermission, requireAnyPermission } from '../auth';
import {
  parseBody,
  formDefinitionSchema,
  linkFormTemplateSchema,
  templateSchema,
  createFormRecordSchema,
  updateFormRecordSchema,
  globalVariableSchema,
} from '../validation';
import { parsePayrollSummaryCsv } from '../hr-payroll-import';
import type { FormDefinition, FormRecord, GlobalVariable, FormScope, Permission } from '../types';

const router = Router();
router.use(requireAuth);

const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseFields(raw: string | null): unknown[] {
  try { return JSON.parse(raw || '[]'); } catch { return []; }
}

function parseData(raw: string | null): Record<string, unknown> {
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

/** Next record number for a form definition, e.g. FM-00001 (counter in settings). */
function nextRecordNumber(prefix: string, formId: number): string {
  return nextSequence(`form_seq_${formId}`, prefix);
}

const FORM_SCOPES: FormScope[] = ['hr', 'inventory', 'admin', 'accounting'];
const ANY_FORMS_MANAGE: Permission[] = FORM_SCOPES.map((s) => `forms.manage.${s}` as Permission);

/** A form's required permission depends on its own `scope`, not just the route — so this is a
    plain check called inline rather than a static requirePermission(...) middleware. General
    (null-scope) forms require *all four* forms.manage.* — deliberately stricter than any single
    section, so a form nobody explicitly sectioned doesn't become manageable by whichever role
    happens to hold just one scope. In practice only admin holds all four by default, making
    General effectively admin-managed, the right default for an unowned bucket. Writes the 403
    itself and returns whether the caller may proceed. */
function canManageScope(req: Request, res: Response, scope: FormScope | null): boolean {
  const ok = scope
    ? req.user!.permissions.includes(`forms.manage.${scope}` as Permission)
    : FORM_SCOPES.every((s) => req.user!.permissions.includes(`forms.manage.${s}` as Permission));
  if (!ok) res.status(403).json({ error: 'Forbidden: insufficient permissions' });
  return ok;
}

// ─── Form Definitions ────────────────────────────────────────────────────────

// GET /api/form-definitions — list all (any logged-in user)
router.get('/form-definitions', (_req, res) => {
  const rows = queryAll<FormDefinition & { record_count: number }>(
    `SELECT fd.*,
       (SELECT COUNT(*) FROM form_records fr WHERE fr.form_def_id = fd.id) AS record_count
     FROM form_definitions fd
     ORDER BY fd.name`
  );
  res.json(rows.map((r) => ({ ...r, fields: parseFields(r.fields as string) })));
});

// GET /api/form-definitions/:id — detail with parsed fields
router.get('/form-definitions/:id', (req, res) => {
  const row = queryOne<FormDefinition>(
    'SELECT * FROM form_definitions WHERE id = ?',
    Number(req.params.id)
  );
  if (!row) { res.status(404).json({ error: 'Form not found' }); return; }
  res.json({ ...row, fields: parseFields(row.fields as string) });
});

// POST /api/form-definitions — create (forms.manage.<scope>)
router.post('/form-definitions', (req, res) => {
  const input = parseBody(formDefinitionSchema, req.body);
  if (!canManageScope(req, res, input.scope)) return;
  const info = run(
    `INSERT INTO form_definitions (name, slug, number_prefix, icon, fields, scope, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    input.name,
    input.slug,
    input.number_prefix,
    input.icon,
    JSON.stringify(input.fields),
    input.scope,
    req.user!.id
  );
  res.status(201).json({ id: info.lastInsertRowid });
});

// PUT /api/form-definitions/:id — update (forms.manage.<scope> for its current scope, and for
// the new scope too if the request is moving it into a different section)
router.put('/form-definitions/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = queryOne<FormDefinition>('SELECT scope FROM form_definitions WHERE id = ?', id);
  if (!existing) { res.status(404).json({ error: 'Form not found' }); return; }
  const input = parseBody(formDefinitionSchema, req.body);
  if (!canManageScope(req, res, existing.scope)) return;
  if (input.scope !== existing.scope && !canManageScope(req, res, input.scope)) return;
  run(
    `UPDATE form_definitions
     SET name = ?, slug = ?, number_prefix = ?, icon = ?, fields = ?, scope = ?, updated_at = datetime('now')
     WHERE id = ?`,
    input.name,
    input.slug,
    input.number_prefix,
    input.icon,
    JSON.stringify(input.fields),
    input.scope,
    id
  );
  res.json({ ok: true });
});

// PUT /api/form-definitions/:id/template — link/unlink the doc_template used to print this
// form's records (forms.manage.<scope> for the form's own scope). Separate from the full-form
// update above since this only needs the id, not a resend of every field.
router.put('/form-definitions/:id/template', (req, res) => {
  const id = Number(req.params.id);
  const existing = queryOne<FormDefinition>('SELECT scope FROM form_definitions WHERE id = ?', id);
  if (!existing) { res.status(404).json({ error: 'Form not found' }); return; }
  if (!canManageScope(req, res, existing.scope)) return;
  const input = parseBody(linkFormTemplateSchema, req.body);
  if (input.template_id !== null && !queryOne('SELECT id FROM doc_templates WHERE id = ?', input.template_id)) {
    res.status(404).json({ error: 'Template not found' }); return;
  }
  run(`UPDATE form_definitions SET template_id = ?, updated_at = datetime('now') WHERE id = ?`, input.template_id, id);
  res.json({ ok: true });
});

// PUT /api/form-definitions/:id/template-body — create (first use) or update the *content* of
// the doc_template linked to this form (forms.manage.<scope> for the form's own scope — NOT
// templates.edit). This is what lets every section design its own forms' printable look, not
// just users with the broader "edit any document template" permission — deliberately separate
// from `/api/templates` (templates.routes.ts), which stays templates.edit-gated for the
// Sale/Job/Purchase Order and other hand-authored templates unrelated to any one form.
router.put('/form-definitions/:id/template-body', (req, res) => {
  const id = Number(req.params.id);
  const existing = queryOne<FormDefinition>('SELECT template_id, scope FROM form_definitions WHERE id = ?', id);
  if (!existing) { res.status(404).json({ error: 'Form not found' }); return; }
  if (!canManageScope(req, res, existing.scope)) return;
  const input = parseBody(templateSchema, req.body);
  if (existing.template_id) {
    run(
      `UPDATE doc_templates SET name = ?, type = ?, period = ?, body = ?, updated_at = datetime('now') WHERE id = ?`,
      input.name, input.type, input.period ?? null, input.body, existing.template_id
    );
    res.json({ id: existing.template_id });
  } else {
    const info = run(
      'INSERT INTO doc_templates (name, type, period, body, created_by) VALUES (?, ?, ?, ?, ?)',
      input.name, input.type, input.period ?? null, input.body, req.user!.id
    );
    run(`UPDATE form_definitions SET template_id = ?, updated_at = datetime('now') WHERE id = ?`, info.lastInsertRowid, id);
    res.status(201).json({ id: info.lastInsertRowid });
  }
});

// DELETE /api/form-definitions/:id — delete + cascades records (forms.manage.<scope> for its scope)
router.delete('/form-definitions/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = queryOne<FormDefinition>('SELECT scope FROM form_definitions WHERE id = ?', id);
  if (!existing) { res.status(404).json({ error: 'Form not found' }); return; }
  if (!canManageScope(req, res, existing.scope)) return;
  run('DELETE FROM form_definitions WHERE id = ?', id);
  res.json({ ok: true });
});

// POST /api/form-definitions/:id/import — bulk-create records from the payroll "Summary"
// CSV export. body.period labels the payroll period (required); body.pay_date is optional.
router.post('/form-definitions/:id/import', requirePermission('hr.manage'), csvUpload.single('file'), (req, res) => {
  const form = queryOne<FormDefinition>('SELECT * FROM form_definitions WHERE id = ?', Number(req.params.id));
  if (!form) { res.status(404).json({ error: 'Form not found' }); return; }
  if (form.slug !== 'hr_payroll') {
    res.status(400).json({ error: 'CSV import is only available for the HR Payroll form' });
    return;
  }
  if (!req.file) { res.status(400).json({ error: 'A CSV file is required' }); return; }

  const period = typeof req.body?.period === 'string' ? req.body.period.trim() : '';
  if (!period) { res.status(400).json({ error: 'Payroll period label is required' }); return; }
  const payDate = typeof req.body?.pay_date === 'string' ? req.body.pay_date.trim() : '';
  const slips = parsePayrollSummaryCsv(req.file.buffer.toString('utf8'), { payDate });
  if (!slips.length) { res.status(400).json({ error: 'No employee rows found in that file' }); return; }

  db.exec('BEGIN');
  try {
    const numbers: string[] = [];
    for (const slip of slips) {
      const number = nextRecordNumber(form.number_prefix, form.id);
      run(
        `INSERT INTO form_records (form_def_id, number, data, status, period, created_by)
         VALUES (?, ?, ?, 'completed', ?, ?)`,
        form.id,
        number,
        JSON.stringify(slip),
        period,
        req.user!.id
      );
      numbers.push(number);
    }
    db.exec('COMMIT');
    res.status(201).json({ created: numbers.length, numbers, period });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
});

// GET /api/form-definitions/:id/periods — distinct period labels for this form
router.get('/form-definitions/:id/periods', (req, res) => {
  const formId = Number(req.params.id);
  if (!queryOne('SELECT id FROM form_definitions WHERE id = ?', formId)) {
    res.status(404).json({ error: 'Form not found' }); return;
  }
  const rows = queryAll<{ period: string }>(
    `SELECT DISTINCT period FROM form_records
     WHERE form_def_id = ? AND period IS NOT NULL AND period != ''
     ORDER BY period DESC`,
    formId
  );
  res.json(rows.map((r) => r.period));
});

// ─── Form Records ────────────────────────────────────────────────────────────

// GET /api/form-definitions/:id/records — list records for a form (?q=, ?status=)
router.get('/form-definitions/:id/records', (req, res) => {
  const formId = Number(req.params.id);
  if (!queryOne('SELECT id FROM form_definitions WHERE id = ?', formId)) {
    res.status(404).json({ error: 'Form not found' }); return;
  }
  const { q, status, period } = req.query;
  const where: string[] = ['fr.form_def_id = ?'];
  const params: unknown[] = [formId];
  if (typeof status === 'string' && status.trim()) {
    where.push('fr.status = ?'); params.push(status.trim());
  }
  if (typeof period === 'string' && period.trim()) {
    where.push('fr.period = ?'); params.push(period.trim());
  }
  if (typeof q === 'string' && q.trim()) {
    where.push('fr.number LIKE ?'); params.push(`%${q.trim()}%`);
  }
  const rows = queryAll<FormRecord>(
    `SELECT fr.*, u.full_name AS created_by_name
     FROM form_records fr LEFT JOIN users u ON u.id = fr.created_by
     WHERE ${where.join(' AND ')}
     ORDER BY fr.id DESC`,
    ...params
  );
  res.json(rows.map((r) => ({ ...r, data: parseData(r.data as string) })));
});

// GET /api/form-records/:id — single record
router.get('/form-records/:id', (req, res) => {
  const row = queryOne<FormRecord & { form_name: string }>(
    `SELECT fr.*, fd.name AS form_name, u.full_name AS created_by_name
     FROM form_records fr
     JOIN form_definitions fd ON fd.id = fr.form_def_id
     LEFT JOIN users u ON u.id = fr.created_by
     WHERE fr.id = ?`,
    Number(req.params.id)
  );
  if (!row) { res.status(404).json({ error: 'Record not found' }); return; }
  res.json({ ...row, data: parseData(row.data as string) });
});

// POST /api/form-records — create a record
router.post('/form-records', (req, res) => {
  const input = parseBody(createFormRecordSchema, req.body);
  const form = queryOne<FormDefinition>(
    'SELECT * FROM form_definitions WHERE id = ?',
    input.form_def_id
  );
  if (!form) { res.status(404).json({ error: 'Form not found' }); return; }

  db.exec('BEGIN');
  try {
    const number = nextRecordNumber(form.number_prefix, form.id);
    const info = run(
      `INSERT INTO form_records (form_def_id, number, data, status, created_by)
       VALUES (?, ?, ?, ?, ?)`,
      input.form_def_id,
      number,
      JSON.stringify(input.data),
      input.status,
      req.user!.id
    );
    db.exec('COMMIT');
    res.status(201).json({ id: info.lastInsertRowid, number });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
});

// PUT /api/form-records/:id — update data / status
router.put('/form-records/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = queryOne<FormRecord & { slug: string }>(
    `SELECT fr.*, fd.slug FROM form_records fr JOIN form_definitions fd ON fd.id = fr.form_def_id WHERE fr.id = ?`,
    id
  );
  if (!existing) { res.status(404).json({ error: 'Record not found' }); return; }
  const input = parseBody(updateFormRecordSchema, req.body);
  // A payslip marked Paid (src/routes/hr.routes.ts's mark-paid) is locked against the generic
  // edit path — unmark it first. Also block setting status to 'paid' through here directly;
  // the dedicated mark-paid route is the only allowed entry point for that transition.
  if (existing.slug === 'hr_payroll' && existing.status === 'paid') {
    res.status(423).json({ error: 'This payslip is marked Paid — unmark it first to edit.' }); return;
  }
  if (existing.slug === 'hr_payroll' && input.status === 'paid' && existing.status !== 'paid') {
    res.status(400).json({ error: 'Use "Mark as Paid" on the payslip instead of setting status directly.' }); return;
  }
  run(
    `UPDATE form_records
     SET data = ?, status = ?, updated_at = datetime('now')
     WHERE id = ?`,
    JSON.stringify(input.data),
    input.status ?? existing.status,
    id
  );
  res.json({ ok: true });
});

// DELETE /api/form-records/:id
router.delete('/form-records/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = queryOne<{ id: number; status: string; slug: string }>(
    `SELECT fr.id, fr.status, fd.slug FROM form_records fr JOIN form_definitions fd ON fd.id = fr.form_def_id WHERE fr.id = ?`,
    id
  );
  if (!existing) { res.status(404).json({ error: 'Record not found' }); return; }
  if (existing.slug === 'hr_payroll' && existing.status === 'paid') {
    res.status(423).json({ error: 'This payslip is marked Paid — unmark it first to delete.' }); return;
  }
  const info = run('DELETE FROM form_records WHERE id = ?', id);
  if (info.changes === 0) { res.status(404).json({ error: 'Record not found' }); return; }
  res.json({ ok: true });
});

// ─── Global Variables ─────────────────────────────────────────────────────────

// GET /api/global-variables — list all (any user, for template rendering)
router.get('/global-variables', (_req, res) => {
  res.json(queryAll<GlobalVariable>('SELECT * FROM global_variables ORDER BY key'));
});

// PUT /api/global-variables/:key — upsert (any forms.manage.* — genuinely global/shared, not
// owned by one section)
router.put('/global-variables/:key', requireAnyPermission(ANY_FORMS_MANAGE), (req, res) => {
  const key = String(req.params.key ?? '').trim();
  if (!/^[a-z0-9_]+$/.test(key)) {
    res.status(400).json({ error: 'Key must be lowercase letters, numbers, or underscores' });
    return;
  }
  const input = parseBody(globalVariableSchema, req.body);
  run(
    `INSERT INTO global_variables (key, label, value, updated_by, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE
       SET label = excluded.label, value = excluded.value,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    key,
    input.label,
    input.value,
    req.user!.id
  );
  res.json({ ok: true });
});

// DELETE /api/global-variables/:key (any forms.manage.*)
router.delete('/global-variables/:key', requireAnyPermission(ANY_FORMS_MANAGE), (req, res) => {
  const info = run('DELETE FROM global_variables WHERE key = ?', req.params.key);
  if (info.changes === 0) { res.status(404).json({ error: 'Variable not found' }); return; }
  res.json({ ok: true });
});

// Multer-specific error handling (file too large, etc.) for the CSV import route.
router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (err instanceof multer.MulterError) {
    res.status(400).json({ error: `Upload failed: ${err.message}` });
    return;
  }
  next(err);
});

export default router;
