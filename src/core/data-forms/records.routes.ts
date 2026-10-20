import {recordedReferences,captureReferences} from './sync-snapshots';
import { runSalesWorkflow, salesLink } from './sales-workflow';
import { idempotency } from '../../shared/idempotency';
import { calculateRecord } from './calculations';
import { resolveConnections } from './sources';
import { recordDeductionChange } from '../../modules/payroll/deduction-history';
import { z } from 'zod';
import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { db, queryOne, queryAll, run, nextSequence, memoTemplateBody } from '../../shared/db';
import { requireAuth, requirePermission, requireAnyPermission } from '../../shared/auth';
import {
  parseBody,
  formDefinitionSchema,
  linkFormTemplateSchema,
  templateSchema,
  createFormRecordSchema,
  updateFormRecordSchema,
  globalVariableSchema,
} from '../../shared/validation';
import { parsePayrollSummaryCsv } from '../../modules/payroll/hr-payroll-import';
import { PAYROLL_FORM_SLUG } from '../../modules/payroll/pay-access';
import { payslipOwnerResolver } from '../../modules/payroll/payslip-owner';
import { runFormActions } from '../form-actions';
import { cutoffIsPaid, notifyApprovers } from '../../modules/hr/workflow';
import { normalizeRequest, attachLeave, leaveWarnings, requestEmployeeId, scheduledLeaveDates } from '../../modules/hr/request-data';
import { REQUEST_SLUGS } from './request-types';
import { INFO_CHANGE_SLUG, prepareInfoChange } from '../../modules/hr/info-change';
import type { DocTemplate, FormDefinition, FormRecord, GlobalVariable, FormScope, Permission, FieldDef } from '../../shared/types';
import { syncClass } from '../../sync';
import { syncUpload } from '../../sync/files';
import { templateRevision, checkTemplateRevision, templateWrite, checkStudioPublish, studioPublished, migrateStudioDocument } from '../doc-template-version';

import { now } from '../../shared/sync-context';
import { recordResponse, recordRevisions, definitionForRecord, correctRecord } from './history';
const router = Router();
router.use(requireAuth);

const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

import { parseFields, parseActions, parseData, nextRecordNumber, canManageScope, canAccessRecords, FORM_SCOPES, ANY_FORMS_MANAGE, validateRequiredCheckboxes, canEnterForm, hasFormScopeAccess } from './policy';
// ─── Form Records ────────────────────────────────────────────────────────────

// GET /api/form-definitions/:id/records — list records for a form (?q=, ?status=). Same
// forms.manage.<scope> gate as writing records — this is the staff-facing "browse everything
// in my section" view (public/js/views/form-records.js). An employee's own self-filed requests
// are visible through the separate, self-scoped GET /me/requests instead.
router.get('/form-definitions/:id/records', (req, res) => {
  const formId = Number(req.params.id);
  const form = queryOne<{ id:number;scope: FormScope | null; slug: string }>('SELECT id, scope, slug FROM form_definitions WHERE id = ?', formId);
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
    `SELECT fr.*, u.full_name AS created_by_name,l.order_id AS sales_order_id,l.order_number AS sales_order_number
     FROM form_records fr LEFT JOIN users u ON u.id = fr.created_by LEFT JOIN form_sales_links l ON l.record_id=fr.id
     WHERE ${where.join(' AND ')}
     ORDER BY fr.id DESC`,
    ...params
  );
  res.json(rows.map(record => ({...record,data:parseData(record.data as string)})));
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
  if (!canAccessRecords(req, res, { form_def_id:row.form_def_id,scope: row.scope, slug: row.form_slug }, false)) return;
  res.json({...recordResponse(row),sales_order:salesLink(row.id)||null});
});

router.get('/form-records/:id/revisions',(req,res)=>{
  const row=queryOne<FormRecord & {scope:FormScope|null;slug:string}>('SELECT fr.*,fd.scope,fd.slug FROM form_records fr JOIN form_definitions fd ON fd.id=fr.form_def_id WHERE fr.id=?',Number(req.params.id));
  if(!row){res.status(404).json({error:'Record not found'});return;}
  if(!canAccessRecords(req,res,row,false))return;
  res.json(recordRevisions(row.id,row.form_def_id));
});

// POST /api/form-records — create a record. Two allowed paths: (a) forms.manage.<scope> staff
// creating any record in their section, any status — the desktop Data Forms flow; or (b) ANY
// logged-in user self-filing one of the ~12 whitelisted HR request forms (REQUEST_SLUGS, same
// list GET /me/request-types exposes) — the mobile self-service flow. Path (b) always forces
// status to 'pending' server-side, ignoring whatever the client sent, so a self-filer can't
// create an already-'approved'/'completed' record and skip the real approval workflow.
function createRecordAccess(req:Request,res:Response,next:NextFunction){
  const form=queryOne<FormDefinition>('SELECT * FROM form_definitions WHERE id=?',Number(req.body?.form_def_id)||0);
  if(form && !REQUEST_SLUGS.includes(form.slug)){
    if(!canAccessRecords(req,res,form,true))return;
  }
  next();
}
router.post('/form-records', createRecordAccess, idempotency, syncClass('merge'), (req, res) => {
  const input = parseBody(createFormRecordSchema, req.body);
  delete input.data._calculation_snapshot;
  const form = queryOne<FormDefinition>(
    'SELECT * FROM form_definitions WHERE id = ?',
    input.form_def_id
  );
  if (!form) { res.status(404).json({ error: 'Form not found' }); return; }
  if (input.expected_definition_version != null && input.expected_definition_version !== form.version) { res.status(409).json({ error: 'This form changed. Reopen it before creating a record.' }); return; }
  if (form.archived_at) { res.status(409).json({ error: 'This form is archived and cannot accept new records.' }); return; }

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
  if (!canManage && !selfFile && !canEnterForm(req,form)) {
    res.status(403).json({ error: 'Forbidden: insufficient permissions' });
    return;
  }
  if(!canManage&&!selfFile&&!['draft','submitted'].includes(input.status)){res.status(403).json({error:'Form entry permits draft and submitted records only.'});return;}
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

  const fields=parseFields(form.fields as string) as FieldDef[];
  const referenceData=recordedReferences(form.id,form.version||1,fields,req.user!);
  input.data=calculateRecord(fields,resolveConnections(fields,input.data,req.user!,referenceData),req.user!,referenceData) as typeof input.data;
  captureReferences(form.id,form.version||1,fields,input.data);
  validateRequiredCheckboxes(form.fields, input.data);
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
    runSalesWorkflow(recordId,parseFields(form.fields as string) as FieldDef[],parseActions(form.actions as string) as import('../../shared/types').FormAction[],input.data,status,req.user!);
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
    if(status==='submitted')action_warnings.push(...runFormActions({recordId,recordNumber:number,formDef:form,data:input.data,trigger:'submitted',actingUserId:req.user!.id}).warnings);
    action_warnings.push(...runFormActions({
      recordId, recordNumber: number, formDef: form, data: input.data as Record<string, unknown>,
      trigger: 'create', actingUserId: req.user!.id,
    }).warnings);
  }
  if (REQUEST_SLUGS.includes(form.slug)) {
    const employee = Number(input.data.employee_id) ? queryOne<{ name: string; department_id: number | null }>('SELECT name, department_id FROM employees WHERE id = ?', Number(input.data.employee_id)) : queryOne<{ name: string; department_id: number | null }>('SELECT name, department_id FROM employees WHERE user_id = ?', req.user!.id);
    notifyApprovers(employee?.department_id ?? null, { title: 'New HR request', body: `${employee?.name || req.user!.full_name} — ${form.name}`, url: '#/approvals', link: { route: 'hr-approvals', params:{id:recordId,kind:'request'} }, tag: 'hr-request-' + recordId }, req.user!.id);
  }
  res.status(201).json({ id: recordId, number, action_warnings, sales_order:salesLink(recordId)||null });
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
  if(existing.scope==='inventory'&&!hasFormScopeAccess(req.user!.permissions,existing.scope)){
    if(existing.status!=='draft'||(input.status&&!['draft','submitted'].includes(input.status))){res.status(403).json({error:'Form entry users may edit and submit drafts only.'});return;}
    if(queryOne<{archived_at:string|null}>('SELECT archived_at FROM form_definitions WHERE id=?',existing.form_def_id)?.archived_at){res.status(403).json({error:'Archived records require a form manager to correct them.'});return;}
  }
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
  const definition = queryOne<FormDefinition>('SELECT fields FROM form_definitions WHERE id = ?', existing.form_def_id);
  const archived = queryOne<{archived_at:string|null}>('SELECT archived_at FROM form_definitions WHERE id=?',existing.form_def_id)?.archived_at;
  if (archived && !input.change_reason?.trim()) { res.status(400).json({error:'A reason is required when correcting an archived record.'}); return; }
  if (input.expected_revision != null && input.expected_revision !== existing.revision) { res.status(409).json({error:'This record changed. Reopen it before saving your correction.'}); return; }
  if (definition) validateRequiredCheckboxes(definitionForRecord(existing)?.fields ?? definition.fields, input.data);
  const newStatus = input.status ?? existing.status;
  const previousData = parseData(existing.data as string);
  const originalFields=definitionForRecord(existing)?.fields ?? parseFields(definition?.fields as string) as FieldDef[];
  const sourceData={...previousData,...recordedReferences(existing.form_def_id,existing.definition_version||1,originalFields,req.user!)};
  const recordData = calculateRecord(originalFields,resolveConnections(originalFields,input.data,req.user!,sourceData),req.user!,sourceData);
  captureReferences(existing.form_def_id,existing.definition_version||1,originalFields,recordData);
  if(salesLink(id)&&(newStatus!==existing.status||JSON.stringify(recordData)!==JSON.stringify(previousData))){res.status(409).json({error:'This submitted record is linked to a sales order. Correct the sales order or create a replacement form; its original submitted values are retained.'});return;}
  if (existing.slug === 'hr_payroll') {
    delete recordData._calculation_snapshot;
    if (previousData._calculation_snapshot) recordData._calculation_snapshot = String(previousData._calculation_snapshot);
    // Identity repair is separate: never coerce an invalid stamp to NaN -> JSON null,
    // which would accidentally restore legacy name fallback after serialization.
    if (Object.prototype.hasOwnProperty.call(previousData, 'employee_id')) recordData.employee_id = previousData.employee_id;
    else delete recordData.employee_id;
    const owners = payslipOwnerResolver();
    if (owners.idOf(previousData) !== owners.idOf(JSON.parse(JSON.stringify(recordData)))) {
      res.status(409).json({ error: 'Use the reviewed payroll identity correction workflow to change payslip ownership.' }); return;
    }
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
  if (existing.slug === 'hr_payroll') {
    if (Object.prototype.hasOwnProperty.call(previousData,'cutoff_id')) recordData.cutoff_id = previousData.cutoff_id;
    else delete recordData.cutoff_id;
  }
  if (REQUEST_SLUGS.includes(existing.slug)) recordData.employee_id = requestEmployeeId(previousData) || requestEmployeeId(recordData);
  if (REQUEST_SLUGS.includes(existing.slug)) {
    const definition = queryOne<FormDefinition>('SELECT * FROM form_definitions WHERE id = ?', existing.form_def_id)!;
    Object.assign(recordData, normalizeRequest(existing.slug, (definitionForRecord(existing)?.fields ?? parseFields(definition.fields as string)) as any, recordData, Number(recordData.employee_id)));
    for (const key of ['approved_by', 'decided_by', 'decided_at', 'decision_note', 'charged_dates', 'leave_days_charged', 'leave_warnings']) delete recordData[key];
    if (existing.slug === 'schedule_change') {
      if (String(recordData.work_date) !== String(previousData.work_date) || Number(recordData.employee_id) !== Number(previousData.employee_id)) {
        res.status(400).json({ error: 'The employee and date cannot be changed on a filed schedule request. File a new request instead.' }); return;
      }
      recordData.current_shift_id = previousData.current_shift_id as number | null;
    }
  }
  correctRecord(existing,req.user!.id,input.change_reason,'correction',()=>{ run(
    `UPDATE form_records
     SET data = ?, status = ?, updated_at = ?
     WHERE id = ?`,
    JSON.stringify(recordData),
    newStatus,
    now().toISOString(),
    id
  ); const actions=definitionForRecord(existing)?.actions ?? parseActions(queryOne<FormDefinition>('SELECT actions FROM form_definitions WHERE id=?',existing.form_def_id)?.actions as string);runSalesWorkflow(id,originalFields,actions as import('../../shared/types').FormAction[],recordData,newStatus,req.user!); if(existing.slug==='hr_payroll')recordDeductionChange(id,previousData,recordData,req.user!,input.change_reason); });

  // Fire `run_on: 'approved'` actions the first time a record reaches 'approved'.
  let action_warnings: string[] = [];
  if (existing.slug === 'leave_request') {
    action_warnings.push(...leaveWarnings(Number(recordData.employee_id), recordData, id), ...attachLeave(id).warnings);
    if (action_warnings.length) { recordData.leave_warnings = action_warnings.join('\n'); run('UPDATE form_records SET data = ? WHERE id = ?', JSON.stringify(recordData), id); }
  }
  if (['approved','submitted'].includes(newStatus) && existing.status !== newStatus) {
    const form = queryOne<FormDefinition>('SELECT * FROM form_definitions WHERE id = ?', existing.form_def_id);
    if (form) {
      action_warnings = runFormActions({
        recordId: id, recordNumber: existing.number, formDef: form,
        data: input.data as Record<string, unknown>, trigger: newStatus as 'approved'|'submitted', actingUserId: req.user!.id,
      }).warnings;
    }
  }
  res.json({ ok: true, action_warnings, revision:queryOne<{revision:number}>('SELECT revision FROM form_records WHERE id=?',id)!.revision });
});

// DELETE /api/form-records/:id (forms.manage.<scope> for the record's form — same gate as PUT)
router.delete('/form-records/:id', syncClass('claim'), (req, res) => {
  const id = Number(req.params.id);
  const existing = queryOne<{ id: number; form_def_id: number; status: string; slug: string; scope: FormScope | null }>(
    `SELECT fr.id, fr.form_def_id, fr.status, fd.slug, fd.scope AS scope FROM form_records fr JOIN form_definitions fd ON fd.id = fr.form_def_id WHERE fr.id = ?`,
    id
  );
  if (!existing) { res.status(404).json({ error: 'Record not found' }); return; }
  if(existing.scope==='inventory'&&!canManageScope(req,res,existing.scope))return;
  if (!canAccessRecords(req, res, existing, true)) return;
  if(queryOne<{archived_at:string|null}>('SELECT archived_at FROM form_definitions WHERE id=?',existing.form_def_id)?.archived_at){res.status(409).json({error:'Archived records must be preserved. Restore the form before deleting records.'});return;}

  if(salesLink(id)){res.status(409).json({error:'This form record created a sales order and must be retained.'});return;}
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


export default router;
