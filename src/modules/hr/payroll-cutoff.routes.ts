/** Recover a missing/invalid cutoff stamp, never transfer a payslip or recalculate history. */
import {Router, type Request} from 'express';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {queryOne, queryAll, run, tenantStore, DEFAULT_TENANT} from '../../shared/db';
import {requirePermission} from '../../shared/auth';
import {requireFreshVerification, stepUpCredentialStamp} from '../../shared/step-up';
import {encryptSecret, decryptSecret} from '../../shared/secrets';
import {parseBody} from '../../shared/validation';
import {correctRecord} from '../../core/data-forms/history';
import {payrollSourceIndex, cutoffPayrollSources, stablePayrollId, type PayrollSource} from '../payroll/payroll-source';
import {syncClass} from '../../sync';

const router = Router({mergeParams:true});
router.use(requirePermission('payroll.manage'));
const digest = (value:unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const idSchema = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const reviewSchema = z.object({cutoff_id:z.number().int().positive().max(Number.MAX_SAFE_INTEGER), expected_revision:z.number().int().positive(), reason:z.string().trim().min(10).max(200), evidence_reference:z.string().trim().min(3).max(120), verified_records:z.literal(true)}).strict();
const confirmSchema = z.object({review_token:z.string().min(20).max(6000)}).strict();
function fail(message:string):never {throw Object.assign(new Error(message),{status:409});}
function validDate(value:unknown):value is string {
  return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
}
function source(req:Request) {
  const index=payrollSourceIndex(), id=parseBody(idSchema,req.params.recordId);
  const row=index.rows.find(s=>s.raw.id===id);
  if(!row)throw Object.assign(new Error('Payslip not found'),{status:404});
  return {index,row};
}
const summary=(s:PayrollSource)=>({id:s.raw.id,number:s.raw.number,status:s.raw.status,revision:s.raw.revision,period:s.raw.period,
  employee_name:typeof s.data?.employee_name==='string'?s.data.employee_name.slice(0,200):null,
  stored_cutoff:s.data?.cutoff_id==null?'Missing':typeof s.data.cutoff_id==='string'||typeof s.data.cutoff_id==='number'?String(s.data.cutoff_id).slice(0,80):'Invalid stored value'});
function eligible(value:ReturnType<typeof source>, requestedId?:number) {
  const {index,row}=value, d=row.data;
  if(!d)fail('Unreadable payroll data requires a separate correction.');
  if(row.raw.status!=='draft'||queryOne('SELECT 1 FROM payslip_paid_history WHERE record_id=? LIMIT 1',row.raw.id)||queryOne("SELECT 1 FROM form_record_revisions WHERE record_id=? AND status='paid' LIMIT 1",row.raw.id))fail('Only draft payslips that have never been paid can use cutoff recovery.');
  const stamped=stablePayrollId(d.cutoff_id);
  if(stamped!=null&&index.periods.has(stamped))fail('This payslip already has a valid cutoff ID. Transfers require a separate adjustment workflow.');
  if(row.employee_id==null)fail('Resolve the payslip owner before recovering its cutoff.');
  const claims=index.labels.get(row.label)??[];
  if(!row.label||claims.length!==1)fail('The recorded label does not identify one cutoff. Historical reconstruction requires a separate review.');
  const period=index.periods.get(claims[0]!)!;
  if(!validDate(period.start_date)||!validDate(period.end_date)||period.start_date>period.end_date)fail('The cutoff dates need a separate correction before recovery.');
  if(requestedId!=null&&period.id!==requestedId)fail('The selected cutoff does not match the recorded label. Transfers are not allowed.');
  // Both recorded labels and an existing calculation label must agree. Do not rewrite
  // any of them to make a requested destination appear valid.
  const labels=[row.raw.period,d.payroll_period];
  if(d._calculation_snapshot!=null&&d._calculation_snapshot!=='') {
    let snapshot:unknown;
    try{snapshot=JSON.parse(String(d._calculation_snapshot));}catch{fail('The saved calculation is unreadable. Cutoff recovery cannot replace it.');}
    if(!snapshot||typeof snapshot!=='object'||Array.isArray(snapshot))fail('The saved calculation is unreadable. Cutoff recovery cannot replace it.');
    labels.push((snapshot as Record<string,unknown>).period_label);
  }
  for(const label of labels) {
    if(label==null||label==='')continue;
    const ids=typeof label==='string'?index.labels.get(label):undefined;
    if(!ids||ids.length!==1||ids[0]!==period.id)fail('Recorded payroll or calculation labels conflict. This workflow cannot reconstruct the cutoff.');
  }
  const selection=cutoffPayrollSources(index,period.id);
  const others=selection.rows.filter(s=>s.raw.id!==row.raw.id);
  if(row.issues.some(i=>i!=='invalid_cutoff')||others.some(s=>s.employee_id===row.employee_id||s.employee_id==null||s.issues.length||s.cutoff_id!==period.id||!['draft','paid'].includes(s.raw.status)))fail('This cutoff has duplicate or unresolved payroll sources. Preserve them for a separate correction.');
  if(others.some(s=>s.raw.status!=='draft'||queryOne('SELECT 1 FROM payslip_paid_history WHERE record_id=? LIMIT 1',s.raw.id)||queryOne("SELECT 1 FROM form_record_revisions WHERE record_id=? AND status='paid' LIMIT 1",s.raw.id)))fail('This cutoff has paid history. Recovery cannot change a released run.');
  for(const revision of queryAll<{data:string}>('SELECT data FROM form_record_revisions WHERE record_id=?',row.raw.id)) {
    let old:Record<string,unknown>;
    try{old=JSON.parse(revision.data);}catch{fail('Historical payroll data is unreadable. Recovery requires a separate review.');}
    if(!old||typeof old!=='object'||Array.isArray(old))fail('Historical payroll data is unreadable. Recovery requires a separate review.');
    const previous=stablePayrollId(old.cutoff_id);
    if(previous!=null&&index.periods.has(previous)&&previous!==period.id)fail('This payslip previously identified another cutoff. Transfers require a separate adjustment workflow.');
    const oldLabels=typeof old.payroll_period==='string'?index.labels.get(old.payroll_period):undefined;
    if(oldLabels&&(oldLabels.length!==1||oldLabels[0]!==period.id))fail('Historical payroll labels identify another cutoff. Recovery requires a separate review.');
  }
  // Any recorded journal, including a draft or reversed original, is financial history.
  if(queryOne("SELECT 1 FROM journal_entries WHERE source_type='payroll_run' AND source_id=? LIMIT 1",period.id))fail('This cutoff has journal history. An accountant must review its adjustment.');
  if(queryOne("SELECT 1 FROM accounting_periods WHERE status='closed' AND start_date<=? AND end_date>=? LIMIT 1",period.end_date,period.start_date))fail('The cutoff overlaps a closed accounting period. Recovery cannot override it.');
  const date=d.pay_date;
  if(date!=null&&date!=='') {
    if(!validDate(date))fail('The pay date needs a separate correction before cutoff recovery.');
    if(queryOne("SELECT 1 FROM accounting_periods WHERE status='closed' AND ? BETWEEN start_date AND end_date LIMIT 1",date))fail('The pay date falls in a closed accounting period. Recovery cannot override it.');
  }
  // Legacy mail has no record foreign key. A matching attempt is a conservative hold,
  // even if the provider outcome is uncertain or another slip shared the subject.
  if(queryOne('SELECT 1 FROM mail_log WHERE subject=? LIMIT 1',`Payslip — ${d.payroll_period||row.raw.number}`))fail('A matching payslip email attempt exists. Review issued copies before correcting its cutoff.');
  const employee=queryOne<{id:number;employee_no:string|null;name:string;status:string;user_id:number|null}>('SELECT id,employee_no,name,status,user_id FROM employees WHERE id=?',row.employee_id)!;
  return {period,employee,state_stamp:digest({records:index.rows.map(s=>s.raw),periods:[...index.periods.values()].sort((a,b)=>a.id-b.id),employee})};
}
const scope=(req:Request)=>({tenant:tenantStore.getStore()?.slug??DEFAULT_TENANT,actor:req.user!.id,session:digest(req.token),credentials:stepUpCredentialStamp(req.user!.id)});
router.get('/',syncClass('online'),(req,res)=>{
  const value=source(req);
  let cutoff:ReturnType<typeof eligible>['period']|null=null, hold:string|null=null;
  try{cutoff=eligible(value).period;}catch(error){if((error as {status?:number}).status!==409)throw error;hold=(error as Error).message;}
  res.json({record:summary(value.row),cutoff,hold});
});
router.post('/review',syncClass('online'),requireFreshVerification,(req,res)=>{
  const input=parseBody(reviewSchema,req.body), value=source(req);
  if(value.row.raw.revision!==input.expected_revision)fail('This payslip changed. Reopen cutoff recovery.');
  const checked=eligible(value,input.cutoff_id);
  const intent={purpose:'payroll-cutoff-v1',...scope(req),record_id:value.row.raw.id,cutoff_id:checked.period.id,state_stamp:checked.state_stamp,reason:input.reason,evidence_reference:input.evidence_reference,expires_at:Date.now()+5*60_000};
  res.json({record:summary(value.row),cutoff:checked.period,employee:{id:checked.employee.id,employee_no:checked.employee.employee_no,name:checked.employee.name},reason:input.reason,evidence_reference:input.evidence_reference,expires_at:intent.expires_at,review_token:encryptSecret(JSON.stringify(intent))});
});
router.post('/confirm',syncClass('online'),requireFreshVerification,(req,res)=>{
  const {review_token}=parseBody(confirmSchema,req.body);
  let intent:Record<string,unknown>;
  try{intent=JSON.parse(decryptSecret(review_token));}catch{fail('The review is invalid. Review cutoff recovery again.');}
  const value=source(req), binding=scope(req);
  if(!intent||intent.purpose!=='payroll-cutoff-v1'||intent.record_id!==value.row.raw.id||intent.tenant!==binding.tenant||intent.actor!==binding.actor||intent.session!==binding.session||intent.credentials!==binding.credentials||typeof intent.expires_at!=='number'||intent.expires_at<=Date.now())fail('The review expired or the account changed. Review again.');
  const cutoffId=parseBody(idSchema,intent.cutoff_id);
  const reason=JSON.stringify({reason:intent.reason,evidence_reference:intent.evidence_reference,previous_cutoff:summary(value.row).stored_cutoff,cutoff_id:cutoffId});
  correctRecord(value.row.raw,req.user!.id,reason,'payroll-cutoff-recovery',()=>{
    const current=source(req), checked=eligible(current,cutoffId);
    if(Number(intent.expires_at)<=Date.now()||scope(req).credentials!==intent.credentials)fail('The review expired or the account changed. Review again.');
    if(checked.state_stamp!==intent.state_stamp)fail('Payroll, employee or cutoff records changed. Review again.');
    const row=current.row.raw;
    const result=run('UPDATE form_records SET data=? WHERE id=? AND revision=? AND data=?',JSON.stringify({...current.row.data,cutoff_id:cutoffId}),row.id,row.revision,row.data);
    if(Number(result.changes)!==1)fail('This payslip changed. Review again.');
    const updated=queryOne<{revision:number}>('SELECT revision FROM form_records WHERE id=?',row.id)!;
    if(updated.revision<=Number(row.revision)||!queryOne("SELECT 1 FROM form_record_revisions WHERE record_id=? AND revision=? AND changed_by=? AND source='payroll-cutoff-recovery'",row.id,updated.revision,req.user!.id))fail('Correction history could not be recorded. No cutoff change was saved.');
  });
  res.json({ok:true,record_id:value.row.raw.id,cutoff_id:cutoffId});
});
export default router;
