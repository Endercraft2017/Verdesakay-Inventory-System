/** Saved staff copies from one tenant database snapshot; never accepts browser payroll data. */
import {createHash} from 'node:crypto';
import {db,queryOne} from '../../shared/db';
import {payrollSourceIndex,PayrollSourceError} from './payroll-source';
import {payrollReleaseProblems,type ReleaseCutoffCache} from './payroll-release';

export function payrollCopy(formId:number,ids:number[],expected?:string) {
  db.exec('SAVEPOINT payroll_copy');
  try {
    const rawForm=queryOne<{id:number;name:string;slug:string;fields:string}>("SELECT id,name,slug,fields FROM form_definitions WHERE id=? AND slug='hr_payroll'",formId);
    if(!rawForm)throw Object.assign(new Error('Payroll form not found'),{status:404});
    let fields:unknown;
    try{fields=JSON.parse(rawForm.fields);if(!Array.isArray(fields))throw new Error();}
    catch{throw Object.assign(new Error('Payroll form fields need review'),{status:409});}
    const form={id:rawForm.id,name:rawForm.name,slug:rawForm.slug,fields};
    const index=payrollSourceIndex(),byId=new Map(index.rows.map(row=>[row.raw.id,row]));
    const selected=ids.map(id=>{
      const source=byId.get(id);
      if(!source||source.raw.form_def_id!==formId)throw Object.assign(new Error('Payslip not found'),{status:404});
      return source;
    });
    const issues=new Set<string>(),recordIds=new Set<number>(),cache:ReleaseCutoffCache=new Map();
    for(const source of selected){
      const result=payrollReleaseProblems(index,source,cache);
      for(const issue of result.issues)issues.add(issue);
      for(const id of result.record_ids)recordIds.add(id);
    }
    if(issues.size)throw new PayrollSourceError([...issues],[...recordIds]);
    const records=selected.map(({raw,data})=>{
      const copy={...data};delete copy._calculation_snapshot;
      return {id:raw.id,number:raw.number,period:raw.period,status:raw.status,data:copy,created_at:raw.created_at,updated_at:raw.updated_at,revision:raw.revision};
    });
    const cutoffs=[...new Set(selected.map(row=>row.cutoff_id).filter((id):id is number=>id!=null))].map(id=>index.periods.get(id));
    // An equality precondition, not a bearer credential or proof that money was settled.
    const snapshot=createHash('sha256').update(JSON.stringify({form,records,cutoffs,source_data:selected.map(row=>row.raw.data)})).digest('hex');
    if(expected&&expected!==snapshot)throw Object.assign(new Error('Saved payroll changed. Close this preview and reopen it to review the current values.'),{status:409});
    const notice=records.every(row=>row.status==='paid')
      ?'PAID RECORD COPY — payment evidence is separate.'
      :'DRAFT — NOT FINAL. Includes payroll not marked Paid.';
    db.exec('RELEASE payroll_copy');
    return {form,records,cutoffs,snapshot,notice};
  }catch(error){db.exec('ROLLBACK TO payroll_copy');db.exec('RELEASE payroll_copy');throw error;}
}
