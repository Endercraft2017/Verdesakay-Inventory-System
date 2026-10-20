/** Exceptional cloud review of unresolved payroll identity; never alters paid amounts/status. */
import {Router,type Request} from 'express';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {queryOne,queryAll,run,tenantStore,DEFAULT_TENANT} from '../../shared/db';
import {requirePermission} from '../../shared/auth';
import {requireFreshVerification,stepUpCredentialStamp} from '../../shared/step-up';
import {encryptSecret,decryptSecret} from '../../shared/secrets';
import {parseBody} from '../../shared/validation';
import {correctRecord} from '../../core/data-forms/history';
import {payslipOwnerResolver} from '../payroll/payslip-owner';
import {syncClass} from '../../sync';
import type {FormRecord} from '../../shared/types';
const router=Router({mergeParams:true});
router.use(requirePermission('payroll.manage'));
function fail(status:number,message:string):never{throw Object.assign(new Error(message),{status});}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const idSchema=z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const reviewSchema=z.object({employee_id:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),expected_revision:z.number().int().positive(),reason:z.string().trim().min(10).max(200),evidence_reference:z.string().trim().min(3).max(120),verified_records:z.literal(true)}).strict();
const confirmSchema=z.object({review_token:z.string().min(20).max(6000)}).strict();
function record(req:Request){
 const id=parseBody(idSchema,req.params.recordId);
 const row=queryOne<FormRecord & {revision:number;data:string}>("SELECT fr.* FROM form_records fr JOIN form_definitions f ON f.id=fr.form_def_id WHERE fr.id=? AND f.slug='hr_payroll'",id);
 if(!row)fail(404,'Payslip not found');
 let data:Record<string,unknown>;
 try{data=JSON.parse(String(row.data));}catch{fail(409,'The payroll record needs data repair before identity review.');}
 if(!data || typeof data!=='object'||Array.isArray(data))fail(409,'The payroll record needs data repair before identity review.');
 return {row,data};
}
interface Target{id:number;employee_no:string|null;name:string;status:string;user_id:number|null;username:string|null;email:string|null;active:number|null}
function target(id:number){
 const row=queryOne<Target>(`SELECT e.id,e.employee_no,e.name,e.status,e.user_id,u.username,u.email,u.active FROM employees e LEFT JOIN users u ON u.id=e.user_id WHERE e.id=?`,id);
 if(!row)fail(409,'The selected employee no longer exists. Review again.');
 return row;
}
function unresolved(data:Record<string,unknown>){if(payslipOwnerResolver().idOf(data)!=null)fail(409,'This payslip already has a resolved owner. This workflow cannot transfer it.');}
const scope=(req:Request)=>({tenant:tenantStore.getStore()?.slug??DEFAULT_TENANT,actor:req.user!.id,session:digest(req.token),credentials:stepUpCredentialStamp(req.user!.id)});
// Read-only search exposes identity, never rates, photos, IDs for government agencies or balances.
router.get('/',syncClass('online'),(req,res)=>{
 const {row,data}=record(req);
 const q=String(req.query.q??'').trim().slice(0,100);
 const employees=queryAll<Pick<Target,'id'|'employee_no'|'name'|'status'>>(`SELECT id,employee_no,name,status FROM employees WHERE instr(lower(name),lower(?))>0 OR instr(lower(COALESCE(employee_no,'')),lower(?))>0 ORDER BY name,id LIMIT 50`,q,q);
 res.json({record:{id:row.id,number:row.number,status:row.status,revision:row.revision,period:row.period,employee_name:data.employee_name??null},resolved_employee_id:payslipOwnerResolver().idOf(data),employees});
});
router.post('/review',syncClass('online'),requireFreshVerification,(req,res)=>{
 const input=parseBody(reviewSchema,req.body);const {row,data}=record(req);unresolved(data);
 if(row.revision!==input.expected_revision)fail(409,'This payslip changed. Reopen identity review.');
 const employee=target(input.employee_id);
 const intent={purpose:'payroll-identity-v1',...scope(req),record_id:row.id,record_stamp:digest(row),target_id:employee.id,target_stamp:digest(employee),reason:input.reason,evidence_reference:input.evidence_reference,expires_at:Date.now()+5*60_000};
 res.json({record:{id:row.id,number:row.number,status:row.status,revision:row.revision,period:row.period,employee_name:data.employee_name??null},employee,reason:input.reason,evidence_reference:input.evidence_reference,expires_at:intent.expires_at,review_token:encryptSecret(JSON.stringify(intent))});
});
router.post('/confirm',syncClass('online'),requireFreshVerification,(req,res)=>{
 const {review_token}=parseBody(confirmSchema,req.body);
 let intent:Record<string,unknown>;
 try{intent=JSON.parse(decryptSecret(review_token));}catch{fail(409,'The review is invalid. Review the identity correction again.');}
 const {row,data}=record(req);const binding=scope(req);
 if(!intent||intent.purpose!=='payroll-identity-v1'||intent.record_id!==row.id||intent.tenant!==binding.tenant||intent.actor!==binding.actor||intent.session!==binding.session||intent.credentials!==binding.credentials||typeof intent.expires_at!=='number'||intent.expires_at<=Date.now())fail(409,'The review expired or the account changed. Review again.');
 unresolved(data);
 if(intent.record_stamp!==digest(row))fail(409,'This payslip changed. Review again.');
 const employee=target(parseBody(idSchema,intent.target_id));
 if(intent.target_stamp!==digest(employee))fail(409,'The employee or linked account changed. Review again.');
 const reason=JSON.stringify({reason:intent.reason,evidence_reference:intent.evidence_reference,previous_employee_id:data.employee_id==null?null:typeof data.employee_id==='number'||typeof data.employee_id==='string'?String(data.employee_id).slice(0,80):'invalid',employee_id:employee.id});
 correctRecord(row,req.user!.id,reason,'payroll-identity-repair',()=>{
  // Keep paid status, finalized/updated timestamp, amounts, calculation snapshot and definition.
  const result=run('UPDATE form_records SET data=? WHERE id=? AND revision=? AND data=?',JSON.stringify({...data,employee_id:employee.id}),row.id,row.revision,row.data);
  if(Number(result.changes)!==1)fail(409,'This payslip changed. Review again.');
  const updated=queryOne<{revision:number}>('SELECT revision FROM form_records WHERE id=?',row.id)!;
  if(updated.revision<=row.revision||!queryOne("SELECT 1 FROM form_record_revisions WHERE record_id=? AND revision=? AND changed_by=? AND source='payroll-identity-repair'",row.id,updated.revision,req.user!.id))fail(409,'Correction history could not be recorded. No ownership change was saved.');
 });
 res.json({ok:true,record_id:row.id,employee_id:employee.id});
});
export default router;
