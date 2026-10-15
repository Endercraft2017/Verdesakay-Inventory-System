import { validateSalesWorkflow } from './sales-workflow';
import { validateCalculations } from './calculations';
import { validateConnections } from './sources';
import { z } from 'zod';
import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { db, queryOne, queryAll, run, nextSequence, memoTemplateBody } from '../../shared/db';
import { requireAuth, requirePermission, requireAnyPermission } from '../../shared/auth';
import {
  parseBody, ValidationError,
  formDefinitionSchema,
  linkFormTemplateSchema,
  templateSchema,
  createFormRecordSchema,
  updateFormRecordSchema,
  globalVariableSchema,
} from '../../shared/validation';
import { parsePayrollSummaryCsv, reviewPayrollSummaryCsv } from '../../modules/payroll/hr-payroll-import';
import { PAYROLL_FORM_SLUG } from '../../modules/payroll/pay-access';
import { runFormActions } from '../form-actions';
import { cutoffIsPaid, notifyApprovers } from '../../modules/hr/workflow';
import { normalizeRequest, attachLeave, leaveWarnings, requestEmployeeId, scheduledLeaveDates } from '../../modules/hr/request-data';
import { REQUEST_SLUGS } from './request-types';
import { INFO_CHANGE_SLUG, prepareInfoChange } from '../../modules/hr/info-change';
import type { DocTemplate, FormDefinition, FormRecord, GlobalVariable, FormScope, Permission } from '../../shared/types';
import { syncClass } from '../../sync';
import { syncUpload } from '../../sync/files';
import { templateRevision, checkTemplateRevision, templateWrite, checkStudioPublish, studioPublished, migrateStudioDocument } from '../doc-template-version';

import { now } from '../../shared/sync-context';
const router = Router();
router.use(requireAuth);

const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

import { parseFields, parseActions, parseData, nextRecordNumber, canManageScope, canAccessRecords, FORM_SCOPES, ANY_FORMS_MANAGE, validateRequiredCheckboxes, hasFormScopeAccess, canEnterForm } from './policy';
function validateRequestSurface(slug:string,fields:import('../../shared/types').FieldDef[],actions:import('../../shared/types').FormAction[]) {
  if(REQUEST_SLUGS.includes(slug)&&(fields.some(field=>['reference','system','line_items','calculated'].includes(field.type)||field.binding)||actions.some(action=>action.run_on==='submitted')))
    throw new ValidationError('Employee self-service requests use their supported request fields and create/approved actions. Use a separate staff Data Form for connected fields and sales workflows.');
}
function visibleDefinition(req:Request,row:FormDefinition) {
  const result={...row,records_allowed:row.slug===PAYROLL_FORM_SLUG?req.user!.permissions.includes('payroll.view'):hasFormScopeAccess(req.user!.permissions,row.scope)||canEnterForm(req,row)} as FormDefinition & {version_reason?:string;updated_by?:number;archived_by?:number};
  const allowed=row.slug===PAYROLL_FORM_SLUG?req.user!.permissions.includes('payroll.view'):hasFormScopeAccess(req.user!.permissions,row.scope);
  if(!allowed){delete result.entry_access;delete result.version_reason;delete result.archive_reason;delete result.updated_by;delete result.archived_by;}
  return result;
}
// ─── Form Definitions ────────────────────────────────────────────────────────

// GET /api/form-definitions — list all (any logged-in user)
router.get('/form-definitions', (req, res) => {
  const rows = queryAll<FormDefinition & { record_count: number }>(
    `SELECT fd.*,
       (SELECT COUNT(*) FROM form_records fr WHERE fr.form_def_id = fd.id) AS record_count
     FROM form_definitions fd
     ORDER BY fd.name`
  );
  res.json(rows.map((r) => ({ ...visibleDefinition(req,r), fields: parseFields(r.fields as string), actions: parseActions(r.actions as string) })));
});

// GET /api/form-definitions/:id — detail with parsed fields
router.get('/form-definitions/:id', (req, res) => {
  const row = queryOne<FormDefinition>(
    'SELECT * FROM form_definitions WHERE id = ?',
    Number(req.params.id)
  );
  if (!row) { res.status(404).json({ error: 'Form not found' }); return; }
  res.json({ ...visibleDefinition(req,row), fields: parseFields(row.fields as string), actions: parseActions(row.actions as string) });
});

router.get('/form-definitions/:id/versions', (req, res) => {
  const form = queryOne<FormDefinition>('SELECT * FROM form_definitions WHERE id=?', Number(req.params.id));
  if (!form) { res.status(404).json({error:'Form not found'}); return; }
  if (!canAccessRecords(req,res,form,false)) return;
  res.json(queryAll<{definition:string}>('SELECT v.*,u.full_name AS created_by_name FROM form_definition_versions v LEFT JOIN users u ON u.id=v.created_by WHERE v.form_id=? ORDER BY v.version DESC',form.id).map(v=>({...v,definition:JSON.parse(v.definition)})));
});
router.put('/form-definitions/:id/archive', syncClass('claim'), (req, res) => {
  const form=queryOne<FormDefinition>('SELECT * FROM form_definitions WHERE id=?',Number(req.params.id));
  if(!form){res.status(404).json({error:'Form not found'});return;}
  if(!canManageScope(req,res,form.scope))return;
  if(form.slug===PAYROLL_FORM_SLUG&&!req.user!.permissions.includes('payroll.manage')){res.status(403).json({error:'Payroll management is required to archive or restore the payroll form.'});return;}
  const input=parseBody(z.object({archived:z.boolean(),reason:z.string().trim().max(1000).optional()}),req.body);
  run('UPDATE form_definitions SET archived_at=?,archived_by=?,archive_reason=?,updated_at=? WHERE id=?',input.archived?now().toISOString():null,input.archived?req.user!.id:null,input.archived?input.reason||null:null,now().toISOString(),form.id);
  res.json({ok:true,archived:input.archived});
});

// Per-form entry grants do not alter role bundles or HR/payroll authorization.
router.get('/form-definitions/:id/access',(req,res)=>{
  const form=queryOne<FormDefinition>('SELECT * FROM form_definitions WHERE id=?',Number(req.params.id));
  if(!form){res.status(404).json({error:'Form not found'});return;}
  if(!canManageScope(req,res,form.scope))return;
  if(form.scope!=='inventory'){res.status(400).json({error:'Entry grants are available for Inventory forms only.'});return;}
  res.json({access:parseData(form.entry_access as string),revision:form.access_revision,roles:queryAll('SELECT key,label FROM roles ORDER BY label'),users:queryAll('SELECT id,full_name,username,role FROM users WHERE active=1 ORDER BY full_name')});
});
router.put('/form-definitions/:id/access',syncClass('claim'),(req,res)=>{
  const form=queryOne<FormDefinition>('SELECT * FROM form_definitions WHERE id=?',Number(req.params.id));
  if(!form){res.status(404).json({error:'Form not found'});return;}
  if(!canManageScope(req,res,form.scope))return;
  if(form.scope!=='inventory'){res.status(400).json({error:'Entry grants are available for Inventory forms only.'});return;}
  const input=parseBody(z.object({expected_revision:z.number().int().positive(),roles:z.array(z.string().min(1).max(100)).max(200),users:z.array(z.number().int().positive()).max(1000)}),req.body);
  if(input.expected_revision!==form.access_revision){res.status(409).json({error:'Form access changed. Reload before saving.'});return;}
  if(input.roles.some(key=>!queryOne('SELECT 1 FROM roles WHERE key=?',key))||input.users.some(id=>!queryOne('SELECT 1 FROM users WHERE id=? AND active=1',id)))throw new ValidationError('Choose existing roles and active employee accounts.');
  run('UPDATE form_definitions SET entry_access=?,access_revision=access_revision+1,updated_at=?,updated_by=? WHERE id=?',JSON.stringify({roles:[...new Set(input.roles)],users:[...new Set(input.users)]}),now().toISOString(),req.user!.id,form.id);
  res.json({ok:true,revision:(form.access_revision||1)+1});
});

// POST /api/form-definitions — create (forms.manage.<scope>)
router.post('/form-definitions', syncClass('claim'), (req, res) => {
  const input = parseBody(formDefinitionSchema, req.body);
  validateConnections(input.fields);
  validateCalculations(input.fields);
  validateSalesWorkflow(input.fields,input.actions);
  validateRequestSurface(input.slug,input.fields,input.actions);
  if (!canManageScope(req, res, input.scope)) return;
  const created=templateWrite(()=>{
  const info = run(
    `INSERT INTO form_definitions (name, slug, number_prefix, icon, fields, actions, scope, created_by, version_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.name,
    input.slug,
    input.number_prefix,
    input.icon,
    JSON.stringify(input.fields),
    JSON.stringify(input.actions),
    input.scope,
    req.user!.id, input.change_reason || null
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
  const existing = queryOne<FormDefinition>('SELECT * FROM form_definitions WHERE id = ?', id);
  if (!existing) { res.status(404).json({ error: 'Form not found' }); return; }
  const input = parseBody(formDefinitionSchema, req.body);
  validateConnections(input.fields);
  validateCalculations(input.fields);
  validateSalesWorkflow(input.fields,input.actions);
  validateRequestSurface(input.slug,input.fields,input.actions);
  if (!canManageScope(req, res, existing.scope)) return;
  if ((existing.slug === PAYROLL_FORM_SLUG || REQUEST_SLUGS.includes(existing.slug)) && input.slug !== existing.slug) { res.status(400).json({error:'The identity of a payroll or employee-request form cannot be changed.'});return; }
  if (existing.slug === PAYROLL_FORM_SLUG && input.scope !== existing.scope) {res.status(400).json({error:'The payroll form must remain in its original section.'});return;}
  if (input.scope !== existing.scope && !canManageScope(req, res, input.scope)) return;
  if (existing.archived_at && !input.change_reason?.trim()) { res.status(400).json({error:'A reason is required when changing an archived form.'});return; }
  if (input.expected_version != null && input.expected_version !== existing.version) { res.status(409).json({ error: 'This form changed. Reload its latest version before saving.' }); return; }
  run(
    `UPDATE form_definitions
     SET name = ?, slug = ?, number_prefix = ?, icon = ?, fields = ?, actions = ?, scope = ?, updated_at = ?, updated_by = ?, version_reason = ?
     WHERE id = ?`,
    input.name,
    input.slug,
    input.number_prefix,
    input.icon,
    JSON.stringify(input.fields),
    JSON.stringify(input.actions),
    input.scope, now().toISOString(), req.user!.id, input.change_reason || null,
    id
  );
  res.json({ ok: true });
});

// A form owns several reusable layouts; template_id remains its explicit default.
router.get('/form-definitions/:id/templates',(req,res)=>{
 const form=queryOne<FormDefinition>('SELECT * FROM form_definitions WHERE id=?',Number(req.params.id));
 if(!form){res.status(404).json({error:'Form not found'});return;}
 if(form.scope==='inventory' ? !canAccessRecords(req,res,form,false) : !canManageScope(req,res,form.scope))return;
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
  const existing = queryOne<FormDefinition>('SELECT * FROM form_definitions WHERE id = ?', id);
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

// DELETE /api/form-definitions/:id — permanent deletion only when empty (forms.manage.<scope> for its scope)
router.delete('/form-definitions/:id', syncClass('claim'), (req, res) => {
  const id = Number(req.params.id);
  const existing = queryOne<FormDefinition>('SELECT * FROM form_definitions WHERE id = ?', id);
  if (!existing) { res.status(404).json({ error: 'Form not found' }); return; }
  if (!canManageScope(req, res, existing.scope)) return;
  if (queryOne<{n:number}>('SELECT COUNT(*) AS n FROM form_records WHERE form_def_id=?', id)!.n) { res.status(409).json({error:'Archive this form to preserve its records and layouts.'}); return; }
  run('DELETE FROM form_definitions WHERE id = ?', id);
  res.json({ ok: true });
});

// POST /api/form-definitions/:id/import — bulk-create records from the payroll "Summary"
// CSV export. body.period labels the payroll period (required); body.pay_date is optional.
router.post('/form-definitions/:id/import', requirePermission('payroll.manage'), syncClass('claim'), syncUpload(csvUpload.single('file')), (req, res) => {
  const form = queryOne<FormDefinition>('SELECT * FROM form_definitions WHERE id = ?', Number(req.params.id));
  if (!form) { res.status(404).json({ error: 'Form not found' }); return; }
  if (form.archived_at) { res.status(409).json({error:'This form is archived. Restore it before importing records.'}); return; }
  if (form.slug !== 'hr_payroll') {
    res.status(400).json({ error: 'CSV import is only available for the HR Payroll form' });
    return;
  }
  if (!req.file) { res.status(400).json({ error: 'A CSV file is required' }); return; }

  const period = typeof req.body?.period === 'string' ? req.body.period.trim() : '';
  if (!period) { res.status(400).json({ error: 'Payroll period label is required' }); return; }
  const payDate = typeof req.body?.pay_date === 'string' ? req.body.pay_date.trim() : '';
  const review = reviewPayrollSummaryCsv(req.file.buffer.toString('utf8'), { payDate });
  const slips = review.slips;
  if (!slips.length && !review.rejected.length) { res.status(400).json({ error: 'No employee rows found in that file' }); return; }

  const matchesFor = () => {
    const existing = queryAll<{ number: string; data: string }>('SELECT number, data FROM form_records WHERE form_def_id = ? AND period = ?', form.id, period);
    const nameKey = (name: unknown) => String(name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
    return slips.map(slip => ({
      ...slip, payroll_period: period,
      matched_numbers: existing.filter(record => {
        try { return nameKey(JSON.parse(record.data).employee_name) === nameKey(slip.employee_name); } catch { return false; }
      }).map(record => record.number),
    }));
  };
  if (req.body.dry_run === '1') {
    const rows = matchesFor();
    res.json({ period, rows, count: rows.length, rejected:review.rejected.map(({line,error})=>({line,error})), rejected_count:review.rejected.length, rejected_csv:review.rejected_csv, duplicate_count: rows.filter(row => row.matched_numbers.length).length,
      total_earnings: rows.reduce((sum, row) => sum + row.total_earnings, 0),
      total_deductions: rows.reduce((sum, row) => sum + row.total_deductions, 0),
      net_pay: rows.reduce((sum, row) => sum + row.net_pay, 0) });
    return;
  }
  if(!slips.length){res.status(400).json({error:'No valid rows to import. Download and correct the rejected rows.'});return;}
  if(review.rejected.length&&req.body.allow_partial!=='1'){res.status(409).json({error:'Some rows were rejected. Preview, download the errors, and explicitly choose to import valid rows only.'});return;}
  db.exec('BEGIN');
  try {
    // Recheck after opening the transaction: matches may have changed since the preview.
    const matches = matchesFor();
    if (matches.some(row => row.matched_numbers.length) && req.body.allow_duplicates !== '1') {
      db.exec('ROLLBACK');
      res.status(409).json({ error: 'Matching payslips already exist in this period. Preview and explicitly confirm duplicate import.' });
      return;
    }
    const numbers: string[] = [];
    for (const slip of slips) {
      const number = nextRecordNumber(form.number_prefix, form.id);
      run(
        `INSERT INTO form_records (form_def_id, number, data, status, period, created_by)
         VALUES (?, ?, ?, 'completed', ?, ?)`,
        form.id,
        number,
        JSON.stringify({ ...slip, payroll_period: period }),
        period,
        req.user!.id
      );
      numbers.push(number);
    }
    db.exec('COMMIT');
    res.status(201).json({ created: numbers.length, numbers, period, rejected_count:review.rejected.length, rejected_csv:review.rejected_csv });
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

// Multer-specific error handling (file too large, etc.) for the CSV import route.
router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (err instanceof multer.MulterError) {
    res.status(400).json({ error: `Upload failed: ${err.message}` });
    return;
  }
  next(err);
});

export default router;
