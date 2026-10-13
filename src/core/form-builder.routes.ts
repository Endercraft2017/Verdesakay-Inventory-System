/** Form builder: per-section-managed form definitions, per-form record CRUD, global variables. */
import { z } from 'zod';
import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { db, queryOne, queryAll, run, nextSequence, memoTemplateBody } from '../shared/db';
import { requireAuth, requirePermission, requireAnyPermission } from '../shared/auth';
import {
  parseBody,
  formDefinitionSchema,
  linkFormTemplateSchema,
  templateSchema,
  createFormRecordSchema,
  updateFormRecordSchema,
  globalVariableSchema,
} from '../shared/validation';
import { parsePayrollSummaryCsv } from '../modules/payroll/hr-payroll-import';
import { PAYROLL_FORM_SLUG } from '../modules/payroll/pay-access';
import { runFormActions } from './form-actions';
import { cutoffIsPaid, notifyApprovers } from '../modules/hr/workflow';
import { normalizeRequest, attachLeave, leaveWarnings, requestEmployeeId, scheduledLeaveDates } from '../modules/hr/request-data';
import { REQUEST_SLUGS } from './me.routes';
import { INFO_CHANGE_SLUG, prepareInfoChange } from '../modules/hr/info-change';
import type { DocTemplate, FormDefinition, FormRecord, GlobalVariable, FormScope, Permission } from '../shared/types';
import { syncClass } from '../sync';
import { syncUpload } from '../sync/files';
import { templateRevision, checkTemplateRevision, templateWrite, checkStudioPublish, studioPublished, migrateStudioDocument } from './doc-template-version';

const router = Router();
router.use(requireAuth);

const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseFields(raw: string | null): unknown[] {
  try { return JSON.parse(raw || '[]'); } catch { return []; }
}

function parseActions(raw: string | null): unknown[] {
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
    itself and returns whether the caller may proceed. Also the read gate for form_definitions/
    records and form_records/:id (there's no separate forms.view.<scope> tier for this system —
    manage is the only permission level, so browsing a section's records requires the same
    permission as managing them; a self-filer's own submissions stay visible via the separate,
    ownership-scoped GET /me/requests instead). */
function canManageScope(req: Request, res: Response, scope: FormScope | null): boolean {
  const ok = scope
    ? req.user!.permissions.includes(`forms.manage.${scope}` as Permission)
    : FORM_SCOPES.every((s) => req.user!.permissions.includes(`forms.manage.${s}` as Permission));
  if (!ok) res.status(403).json({ error: 'Forbidden: insufficient permissions' });
  return ok;
}

/** Read/write gate for one form's RECORDS. Payslips (the hr_payroll form) are pay data, so they
    take payroll.view to read and payroll.manage to write instead of the HR section's
    forms.manage.hr (modules/payroll/pay-access.ts); every other form uses canManageScope. Writes
    the 403 itself and returns whether the caller may proceed. */
function canAccessRecords(req: Request, res: Response, form: { scope: FormScope | null; slug: string }, write: boolean): boolean {
  if (form.slug === PAYROLL_FORM_SLUG) {
    const ok = req.user!.permissions.includes(write ? 'payroll.manage' : 'payroll.view');
    if (!ok) res.status(403).json({ error: 'Forbidden: payslips need the payroll permission' });
    return ok;
  }
  return canManageScope(req, res, form.scope);
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
  res.json(rows.map((r) => ({ ...r, fields: parseFields(r.fields as string), actions: parseActions(r.actions as string) })));
});

// GET /api/form-definitions/:id — detail with parsed fields
router.get('/form-definitions/:id', (req, res) => {
  const row = queryOne<FormDefinition>(
    'SELECT * FROM form_definitions WHERE id = ?',
    Number(req.params.id)
  );
  if (!row) { res.status(404).json({ error: 'Form not found' }); return; }
  res.json({ ...row, fields: parseFields(row.fields as string), actions: parseActions(row.actions as string) });
});

// POST /api/form-definitions — create (forms.manage.<scope>)
router.post('/form-definitions', syncClass('claim'), (req, res) => {
  const input = parseBody(formDefinitionSchema, req.body);
  if (!canManageScope(req, res, input.scope)) return;
  const created=templateWrite(()=>{
  const info = run(
    `INSERT INTO form_definitions (name, slug, number_prefix, icon, fields, actions, scope, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    input.name,
    input.slug,
    input.number_prefix,
    input.icon,
    JSON.stringify(input.fields),
    JSON.stringify(input.actions),
    input.scope,
    req.user!.id
  );
  const tpl=run("INSERT INTO doc_templates(name,type,body,created_by) VALUES(?,'generic',?,?)",input.name+' Template',memoTemplateBody(input.name,input.fields),req.user!.id);
  run('UPDATE form_definitions SET template_id=? WHERE id=?',tpl.lastInsertRowid,info.lastInsertRowid);
  return Number(info.lastInsertRowid);
  });
  res.status(201).json({ id: created });
});

// PUT /api/form-definitions/:id — update (forms.manage.<scope> for its current scope, and for
// the new scope too if the request is moving it into a different section)
router.put('/form-definitions/:id', syncClass('claim'), (req, res) => {
  const id = Number(req.params.id);
  const existing = queryOne<FormDefinition>('SELECT scope FROM form_definitions WHERE id = ?', id);
  if (!existing) { res.status(404).json({ error: 'Form not found' }); return; }
  const input = parseBody(formDefinitionSchema, req.body);
  if (!canManageScope(req, res, existing.scope)) return;
  if (input.scope !== existing.scope && !canManageScope(req, res, input.scope)) return;
  run(
    `UPDATE form_definitions
     SET name = ?, slug = ?, number_prefix = ?, icon = ?, fields = ?, actions = ?, scope = ?, updated_at = datetime('now')
     WHERE id = ?`,
    input.name,
    input.slug,
    input.number_prefix,
    input.icon,
    JSON.stringify(input.fields),
    JSON.stringify(input.actions),
    input.scope,
    id
  );
  res.json({ ok: true });
});

// A form owns several reusable layouts; template_id remains its explicit default.
router.get('/form-definitions/:id/templates',(req,res)=>{
 const form=queryOne<FormDefinition>('SELECT * FROM form_definitions WHERE id=?',Number(req.params.id));
 if(!form){res.status(404).json({error:'Form not found'});return;}
 if(!canManageScope(req,res,form.scope))return;
 res.json(queryAll('SELECT t.id,t.name,t.type,t.updated_at,(t.id=?) AS is_default,(SELECT COUNT(*) FROM form_template_links WHERE template_id=t.id) AS linked_forms FROM form_template_links l JOIN doc_templates t ON t.id=l.template_id WHERE l.form_id=? ORDER BY is_default DESC,t.name',form.template_id,form.id));
});
router.post('/form-definitions/:id/templates',syncClass('claim'),(req,res)=>{
 const form=queryOne<FormDefinition>('SELECT * FROM form_definitions WHERE id=?',Number(req.params.id));
 if(!form){res.status(404).json({error:'Form not found'});return;}
 if(!canManageScope(req,res,form.scope))return;
 const input=parseBody(z.object({template_id:z.number().int().positive(),make_default:z.boolean().default(false)}),req.body);
 if(!queryOne('SELECT id FROM doc_templates WHERE id=?',input.template_id)){res.status(404).json({error:'Template not found'});return;}
 templateWrite(()=>{run('INSERT OR IGNORE INTO form_template_links VALUES(?,?)',form.id,input.template_id);if(input.make_default||!form.template_id)run("UPDATE form_definitions SET template_id=?,updated_at=datetime('now') WHERE id=?",input.template_id,form.id);});
 res.json({ok:true});
});
router.delete('/form-definitions/:id/templates/:templateId',syncClass('claim'),(req,res)=>{
 const form=queryOne<FormDefinition>('SELECT * FROM form_definitions WHERE id=?',Number(req.params.id));
 if(!form){res.status(404).json({error:'Form not found'});return;}
 if(!canManageScope(req,res,form.scope))return;
 const templateId=Number(req.params.templateId);
 templateWrite(()=>{run('DELETE FROM form_template_links WHERE form_id=? AND template_id=?',form.id,templateId);if(form.template_id===templateId){const next=queryOne<{template_id:number}>('SELECT template_id FROM form_template_links WHERE form_id=? ORDER BY template_id LIMIT 1',form.id);run('UPDATE form_definitions SET template_id=? WHERE id=?',next?.template_id??null,form.id);}});
 res.json({ok:true});
});

// PUT /api/form-definitions/:id/template — link/unlink the doc_template used to print this
// form's records (forms.manage.<scope> for the form's own scope). Separate from the full-form
// update above since this only needs the id, not a resend of every field.
router.put('/form-definitions/:id/template', syncClass('claim'), (req, res) => {
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
router.put('/form-definitions/:id/template-body', syncClass('claim'), (req, res) => {
  const result = templateWrite(() => {
    const id = Number(req.params.id);
    const existing = queryOne<FormDefinition>('SELECT template_id, scope FROM form_definitions WHERE id = ?', id);
    if (!existing) { res.status(404).json({ error: 'Form not found' }); return; }
    if (!canManageScope(req, res, existing.scope)) return;
    const input = parseBody(templateSchema.extend({template_id:z.number().int().positive().nullable().optional()}), req.body);
    const targetId=input.template_id===undefined?existing.template_id:input.template_id;
    if(targetId&&!queryOne('SELECT 1 FROM form_template_links WHERE form_id=? AND template_id=?',id,targetId)){res.status(400).json({error:'Link this template to the form before editing it'});return;}
    if (targetId) {
      const template = queryOne<DocTemplate>('SELECT * FROM doc_templates WHERE id = ?', targetId);
      if (!template) { res.status(404).json({ error: 'Template not found' }); return; }
      if (!checkTemplateRevision(template, input.expected_revision, res) || !checkStudioPublish(template.id, input.studio_version, res)) return;
      run(
        `UPDATE doc_templates SET name = ?, type = ?, period = ?, body = ?, copies_per_record = ?, records_per_page = ?, tile_fill = ?, repeat_count = ?, tile_continuous = ?, grid_gap_x_mm = ?, grid_gap_y_mm = ?, updated_at = datetime('now') WHERE id = ?`,
        input.name, input.type, input.period ?? null, input.body, input.copies_per_record, input.records_per_page, input.tile_fill,
        input.repeat_count, input.tile_continuous ? 1 : 0, input.grid_gap_x_mm, input.grid_gap_y_mm, targetId
      );
      const saved = queryOne<DocTemplate>('SELECT * FROM doc_templates WHERE id = ?', targetId)!;
      studioPublished(saved);
      return { status: 200, id: targetId, revision: templateRevision(saved) };
    } else {
      if(!existing.template_id&&!checkStudioPublish('form:'+id,input.studio_version,res))return;
      if(input.source_template_id){const source=queryOne<DocTemplate>('SELECT * FROM doc_templates WHERE id=?',input.source_template_id);if(!source){res.status(404).json({error:'Source template not found'});return;}if(!checkTemplateRevision(source,input.source_revision,res))return;}
      const info = run(
        'INSERT INTO doc_templates (name, type, period, body, copies_per_record, records_per_page, tile_fill, repeat_count, tile_continuous, grid_gap_x_mm, grid_gap_y_mm, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        input.name, input.type, input.period ?? null, input.body, input.copies_per_record, input.records_per_page, input.tile_fill,
        input.repeat_count, input.tile_continuous ? 1 : 0, input.grid_gap_x_mm, input.grid_gap_y_mm, req.user!.id
      );
      run('INSERT INTO form_template_links VALUES(?,?)',id,info.lastInsertRowid);
      if(!existing.template_id)run(`UPDATE form_definitions SET template_id = ?, updated_at = datetime('now') WHERE id = ?`, info.lastInsertRowid, id);
      if(input.source_template_id)run(`INSERT INTO doc_variables(scope,template_id,category,key,label,source_type,value,field_path,formula,data_type,sort) SELECT scope,?,category,key,label,source_type,value,field_path,formula,data_type,sort FROM doc_variables WHERE scope='template' AND template_id=?`,info.lastInsertRowid,input.source_template_id);
      const saved = queryOne<DocTemplate>('SELECT * FROM doc_templates WHERE id = ?', info.lastInsertRowid)!;
      if(!existing.template_id)migrateStudioDocument('form:'+id,'template:'+info.lastInsertRowid);
      studioPublished(saved);
      return { status: 201, id: info.lastInsertRowid, revision: templateRevision(saved) };
    }
  });
  if (result) res.status(result.status).json({ id: result.id, revision: result.revision });
});

// DELETE /api/form-definitions/:id — delete + cascades records (forms.manage.<scope> for its scope)
router.delete('/form-definitions/:id', syncClass('claim'), (req, res) => {
  const id = Number(req.params.id);
  const existing = queryOne<FormDefinition>('SELECT scope FROM form_definitions WHERE id = ?', id);
  if (!existing) { res.status(404).json({ error: 'Form not found' }); return; }
  if (!canManageScope(req, res, existing.scope)) return;
  run('DELETE FROM form_definitions WHERE id = ?', id);
  res.json({ ok: true });
});

// POST /api/form-definitions/:id/import — bulk-create records from the payroll "Summary"
// CSV export. body.period labels the payroll period (required); body.pay_date is optional.
router.post('/form-definitions/:id/import', requirePermission('payroll.manage'), syncClass('claim'), syncUpload(csvUpload.single('file')), (req, res) => {
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

// GET /api/form-definitions/:id/records — list records for a form (?q=, ?status=). Same
// forms.manage.<scope> gate as writing records — this is the staff-facing "browse everything
// in my section" view (public/js/views/form-records.js). An employee's own self-filed requests
// are visible through the separate, self-scoped GET /me/requests instead.
router.get('/form-definitions/:id/records', (req, res) => {
  const formId = Number(req.params.id);
  const form = queryOne<{ scope: FormScope | null; slug: string }>('SELECT scope, slug FROM form_definitions WHERE id = ?', formId);
  if (!form) { res.status(404).json({ error: 'Form not found' }); return; }
  if (!canAccessRecords(req, res, form, false)) return;
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
    // Matches the record's own number OR, when the form has one, its employee_name field —
    // payroll (and every other HR form keyed to an employee) is far more often searched by who
    // it's for than by its sequential number.
    where.push("(fr.number LIKE ? OR json_extract(fr.data, '$.employee_name') LIKE ?)");
    params.push(`%${q.trim()}%`, `%${q.trim()}%`);
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

// GET /api/form-records/:id — single record (forms.manage.<scope> for its form's scope — same
// gate as the list route above)
router.get('/form-records/:id', (req, res) => {
  const row = queryOne<FormRecord & { form_name: string; form_slug: string; scope: FormScope | null }>(
    `SELECT fr.*, fd.name AS form_name, fd.slug AS form_slug, fd.scope AS scope, u.full_name AS created_by_name
     FROM form_records fr
     JOIN form_definitions fd ON fd.id = fr.form_def_id
     LEFT JOIN users u ON u.id = fr.created_by
     WHERE fr.id = ?`,
    Number(req.params.id)
  );
  if (!row) { res.status(404).json({ error: 'Record not found' }); return; }
  if (!canAccessRecords(req, res, { scope: row.scope, slug: row.form_slug }, false)) return;
  res.json({ ...row, data: parseData(row.data as string) });
});

// POST /api/form-records — create a record. Two allowed paths: (a) forms.manage.<scope> staff
// creating any record in their section, any status — the desktop Data Forms flow; or (b) ANY
// logged-in user self-filing one of the ~12 whitelisted HR request forms (REQUEST_SLUGS, same
// list GET /me/request-types exposes) — the mobile self-service flow. Path (b) always forces
// status to 'pending' server-side, ignoring whatever the client sent, so a self-filer can't
// create an already-'approved'/'completed' record and skip the real approval workflow.
router.post('/form-records', syncClass('merge'), (req, res) => {
  const input = parseBody(createFormRecordSchema, req.body);
  delete input.data._calculation_snapshot;
  const form = queryOne<FormDefinition>(
    'SELECT * FROM form_definitions WHERE id = ?',
    input.form_def_id
  );
  if (!form) { res.status(404).json({ error: 'Form not found' }); return; }

  const canManage = form.slug === PAYROLL_FORM_SLUG
    ? req.user!.permissions.includes('payroll.manage')
    : form.scope
      ? req.user!.permissions.includes(`forms.manage.${form.scope}` as Permission)
      : FORM_SCOPES.every((s) => req.user!.permissions.includes(`forms.manage.${s}` as Permission));
  // An information-change request is always the caller's own, always starts pending, and its
  // identity/current value are set server-side (never trusted from the client) — even for HR
  // staff who could otherwise create any record in their section.
  const infoChange = form.slug === INFO_CHANGE_SLUG;
  const selfFile = infoChange || (!canManage && REQUEST_SLUGS.includes(form.slug));
  if (!canManage && !selfFile) {
    res.status(403).json({ error: 'Forbidden: insufficient permissions' });
    return;
  }
  const status = REQUEST_SLUGS.includes(form.slug) ? 'pending' : input.status;
  if (infoChange) input.data = prepareInfoChange(req.user!.id, input.data as Record<string, unknown>);
  else if (REQUEST_SLUGS.includes(form.slug)) {
    const subject = selfFile
      ? queryOne<{ id: number; name: string }>('SELECT id, name FROM employees WHERE user_id = ?', req.user!.id)
      : Number(input.data.employee_id)
        ? queryOne<{ id: number; name: string }>('SELECT id, name FROM employees WHERE id = ?', Number(input.data.employee_id))
        : (() => { const matches = queryAll<{ id: number; name: string }>('SELECT id, name FROM employees WHERE name = ?', String(input.data.employee_name || '')); return matches.length === 1 ? matches[0] : undefined; })();
    if (subject) input.data = { ...input.data, employee_id: subject.id, employee_name: subject.name };
    else { delete input.data.employee_id; }
  }

  if (REQUEST_SLUGS.includes(form.slug)) {
    // Filing is not approval: decision metadata belongs to the decision endpoint.
    for (const key of ['approved_by', 'decided_by', 'decided_at', 'decision_note']) delete input.data[key];
    if (selfFile && form.slug === 'overtime_request') delete input.data.approved_hours;
    input.data = normalizeRequest(form.slug, parseFields(form.fields as string) as any, input.data, Number(input.data.employee_id)) as typeof input.data;
    if (form.slug === 'schedule_change') {
      const date = String(input.data.work_date);
      const row = queryOne<{ shift_id: number | null; period_id: number }>(
        'SELECT shift_id, period_id FROM attendance_records WHERE employee_id = ? AND work_date = ?', Number(input.data.employee_id), date);
      if (!row || date <= new Date().toISOString().slice(0, 10)) {
        res.status(400).json({ error: 'Choose a future date already on your published roster.' }); return;
      }
      if (!scheduledLeaveDates(Number(input.data.employee_id), [date]).length) {
        res.status(400).json({ error: 'Schedule changes apply to working days. Use Change of Rest Day for a rest-day swap.' }); return;
      }
      if (row.shift_id === Number(input.data.requested_shift_id)) {
        res.status(400).json({ error: 'Choose a shift different from the one already assigned.' }); return;
      }
      if (cutoffIsPaid(row.period_id)) { res.status(423).json({ error: 'This payroll cutoff is locked after payment.' }); return; }
      input.data.current_shift_id = row.shift_id;
    }
  }

  let recordId: number;
  let number: string;
  db.exec('BEGIN');
  try {
    number = nextRecordNumber(form.number_prefix, form.id);
    const info = run(
      `INSERT INTO form_records (form_def_id, number, data, status, created_by)
       VALUES (?, ?, ?, ?, ?)`,
      input.form_def_id,
      number,
      JSON.stringify(input.data),
      status,
      req.user!.id
    );
    recordId = Number(info.lastInsertRowid);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  // Fire configured form actions (notify employee, file to 201, …) — best-effort, outside the
  // transaction so a failed action never un-creates the record. Skipped for self-filed HR
  // requests (forced to 'pending' above — those go through the me.routes approval flow).
  let action_warnings: string[] = [];
  if (form.slug === 'leave_request') {
    action_warnings.push(...leaveWarnings(Number(input.data.employee_id), input.data, recordId), ...attachLeave(recordId).warnings);
    if (action_warnings.length) { input.data.leave_warnings = action_warnings.join('\n'); run('UPDATE form_records SET data = ? WHERE id = ?', JSON.stringify(input.data), recordId); }
  }
  if (!selfFile) {
    action_warnings.push(...runFormActions({
      recordId, recordNumber: number, formDef: form, data: input.data as Record<string, unknown>,
      trigger: 'create', actingUserId: req.user!.id,
    }).warnings);
  }
  if (REQUEST_SLUGS.includes(form.slug)) {
    const employee = Number(input.data.employee_id) ? queryOne<{ name: string; department_id: number | null }>('SELECT name, department_id FROM employees WHERE id = ?', Number(input.data.employee_id)) : queryOne<{ name: string; department_id: number | null }>('SELECT name, department_id FROM employees WHERE user_id = ?', req.user!.id);
    notifyApprovers(employee?.department_id ?? null, { title: 'New HR request', body: `${employee?.name || req.user!.full_name} — ${form.name}`, url: '#/approvals', link: { route: 'hr-approvals', params:{id:recordId,kind:'request'} }, tag: 'hr-request-' + recordId }, req.user!.id);
  }
  res.status(201).json({ id: recordId, number, action_warnings });
});

// PUT /api/form-records/:id — update data / status (forms.manage.<scope> for the record's
// form — the desktop Data Forms edit flow; mobile self-filers never PUT here, they only POST
// to create and use the separate, ownership-checked POST /me/requests/:id/cancel to withdraw).
router.put('/form-records/:id', syncClass('claim'), (req, res) => {
  const id = Number(req.params.id);
  const existing = queryOne<FormRecord & { slug: string; scope: FormScope | null }>(
    `SELECT fr.*, fd.slug, fd.scope AS scope FROM form_records fr JOIN form_definitions fd ON fd.id = fr.form_def_id WHERE fr.id = ?`,
    id
  );
  if (!existing) { res.status(404).json({ error: 'Record not found' }); return; }
  if (!canAccessRecords(req, res, existing, true)) return;
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
  // Information-change requests are decided only in Approvals, which applies the change to the
  // employee record in the same step — editing or approving here would skip or desync that.
  if (existing.slug === INFO_CHANGE_SLUG) {
    res.status(400).json({ error: 'Decide information-change requests in Approvals so the change is applied to the employee record.' }); return;
  }
  if (REQUEST_SLUGS.includes(existing.slug) && (existing.status !== 'pending' || (input.status && input.status !== existing.status))) {
    res.status(400).json({ error: 'Decide HR requests in Approvals. Decided requests cannot be edited; file a new request instead.' }); return;
  }
  const newStatus = input.status ?? existing.status;
  const recordData = { ...input.data };
  const previousData = parseData(existing.data as string);
  if (existing.slug === 'hr_payroll') {
    delete recordData._calculation_snapshot;
    if (previousData._calculation_snapshot) recordData._calculation_snapshot = String(previousData._calculation_snapshot);
    if (previousData.employee_id) recordData.employee_id = Number(previousData.employee_id);
    if (previousData._calculation_snapshot) {
      for (const key of ['daily_rate','days_worked','days_absent','days_half','days_undertime','ot_hours','ot_rate_hour','basic_salary',
        'overtime_pay','undertime_pay','undertime_day_pay','night_diff_pay','holiday_pay','special_holiday_30','rest_day_ot','total_earnings','late_absences']) {
        if (recordData[key] !== undefined && Number(recordData[key]) !== Number(previousData[key] ?? 0)) {
          res.status(400).json({ error: 'Attendance-derived payroll amounts are saved with their breakdown. Update Timekeeping and regenerate the payslip instead.' }); return;
        }
        if (previousData[key] !== undefined) recordData[key] = previousData[key] as any;
      }
    }
  }
  if (existing.slug === 'hr_payroll' && typeof previousData.cutoff_id === 'number') recordData.cutoff_id = previousData.cutoff_id;
  if (REQUEST_SLUGS.includes(existing.slug)) recordData.employee_id = requestEmployeeId(previousData) || requestEmployeeId(recordData);
  if (REQUEST_SLUGS.includes(existing.slug)) {
    const definition = queryOne<FormDefinition>('SELECT * FROM form_definitions WHERE id = ?', existing.form_def_id)!;
    Object.assign(recordData, normalizeRequest(existing.slug, parseFields(definition.fields as string) as any, recordData, Number(recordData.employee_id)));
    for (const key of ['approved_by', 'decided_by', 'decided_at', 'decision_note', 'charged_dates', 'leave_days_charged', 'leave_warnings']) delete recordData[key];
    if (existing.slug === 'schedule_change') {
      if (String(recordData.work_date) !== String(previousData.work_date) || Number(recordData.employee_id) !== Number(previousData.employee_id)) {
        res.status(400).json({ error: 'The employee and date cannot be changed on a filed schedule request. File a new request instead.' }); return;
      }
      recordData.current_shift_id = previousData.current_shift_id as number | null;
    }
  }
  run(
    `UPDATE form_records
     SET data = ?, status = ?, updated_at = datetime('now')
     WHERE id = ?`,
    JSON.stringify(recordData),
    newStatus,
    id
  );

  // Fire `run_on: 'approved'` actions the first time a record reaches 'approved'.
  let action_warnings: string[] = [];
  if (existing.slug === 'leave_request') {
    action_warnings.push(...leaveWarnings(Number(recordData.employee_id), recordData, id), ...attachLeave(id).warnings);
    if (action_warnings.length) { recordData.leave_warnings = action_warnings.join('\n'); run('UPDATE form_records SET data = ? WHERE id = ?', JSON.stringify(recordData), id); }
  }
  if (newStatus === 'approved' && existing.status !== 'approved') {
    const form = queryOne<FormDefinition>('SELECT * FROM form_definitions WHERE id = ?', existing.form_def_id);
    if (form) {
      action_warnings = runFormActions({
        recordId: id, recordNumber: existing.number, formDef: form,
        data: input.data as Record<string, unknown>, trigger: 'approved', actingUserId: req.user!.id,
      }).warnings;
    }
  }
  res.json({ ok: true, action_warnings });
});

// DELETE /api/form-records/:id (forms.manage.<scope> for the record's form — same gate as PUT)
router.delete('/form-records/:id', syncClass('claim'), (req, res) => {
  const id = Number(req.params.id);
  const existing = queryOne<{ id: number; status: string; slug: string; scope: FormScope | null }>(
    `SELECT fr.id, fr.status, fd.slug, fd.scope AS scope FROM form_records fr JOIN form_definitions fd ON fd.id = fr.form_def_id WHERE fr.id = ?`,
    id
  );
  if (!existing) { res.status(404).json({ error: 'Record not found' }); return; }
  if (!canAccessRecords(req, res, existing, true)) return;
  // A payslip that was ever marked Paid is part of the payroll record: correct it (unmark, edit,
  // mark paid again), never delete it. payslip_paid_history is written by hr.routes.ts.
  if (existing.slug === 'hr_payroll'
    && (existing.status === 'paid' || queryOne('SELECT 1 AS x FROM payslip_paid_history WHERE record_id = ? LIMIT 1', id))) {
    res.status(423).json({ error: 'This payslip has been paid, so it is kept as part of the payroll record. Unmark it and edit it to correct it.' }); return;
  }
  if (REQUEST_SLUGS.includes(existing.slug)) { res.status(400).json({ error: 'HR requests are kept for decision history. Withdraw pending requests from My HR instead of deleting them.' }); return; }
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
router.put('/global-variables/:key', requireAnyPermission(ANY_FORMS_MANAGE), syncClass('claim'), (req, res) => {
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
router.delete('/global-variables/:key', requireAnyPermission(ANY_FORMS_MANAGE), syncClass('claim'), (req, res) => {
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
