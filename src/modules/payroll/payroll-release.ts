/** Current source eligibility for paid marking and employee issuance, not proof of settlement. */
import {cutoffPayrollSources, PayrollSourceError, type PayrollSource, type PayrollSourceIndex} from './payroll-source';
type Selection=ReturnType<typeof cutoffPayrollSources>;
export type ReleaseCutoffCache=Map<number,Selection>;
const MONEY=['daily_rate','basic_salary','overtime_pay','undertime_pay','undertime_day_pay','night_diff_pay','holiday_pay','special_holiday_30','rest_day_ot','total_earnings','sss','philhealth','pagibig','withholding_tax','cash_advance','other_deductions_total','late_absences','total_deductions','net_pay'];
export function payrollReleaseProblems(index:PayrollSourceIndex,source:PayrollSource,cache:ReleaseCutoffCache=new Map()) {
  const issues=new Set(source.issues),ids=new Set<number>();
  if(!['draft','paid'].includes(source.raw.status))issues.add('unsupported_status');
  if(source.cutoff_id!=null){
    let selection=cache.get(source.cutoff_id);
    if(!selection){
      selection=cutoffPayrollSources(index,source.cutoff_id);
      // Invalid/ambiguous siblings may use any recorded alias of this cutoff.
      // A canonical-label-only selection would otherwise miss their source hold.
      for(const candidate of index.rows)if(candidate.cutoff_id==null&&(index.labels.get(candidate.label)??[]).includes(source.cutoff_id)){
        selection.issues.push(...candidate.issues,'unlinked_cutoff');selection.record_ids.push(candidate.raw.id);
      }
      cache.set(source.cutoff_id,selection);
    }
    for(const issue of selection.issues)issues.add(issue);
    for(const id of selection.record_ids)ids.add(id);
  }
  const d=source.data;
  if(d){
    for(const key of MONEY){const value=d[key];if(value==null||value==='')continue;
      const n=typeof value==='number'||typeof value==='string'?Number(value):NaN;
      if(!Number.isFinite(n)||!Number.isSafeInteger(Math.round(n*100)))issues.add('invalid_amount');
    }
    const date=d.pay_date;
    if(date!=null&&date!==''&&(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date+'T00:00:00Z'))||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date))issues.add('invalid_pay_date');
  }
  if(issues.size)ids.add(source.raw.id);
  return {issues:[...issues],record_ids:[...ids]};
}
export function assertPayrollRelease(index:PayrollSourceIndex,recordId:number,paidOnly=false):PayrollSource {
  const source=index.rows.find(s=>s.raw.id===recordId);
  if(!source)throw Object.assign(new Error('Payslip not found'),{status:404});
  const result=payrollReleaseProblems(index,source);
  if(paidOnly&&source.raw.status!=='paid'){result.issues.push('not_finalized');result.record_ids.push(source.raw.id);}
  if(result.issues.length)throw new PayrollSourceError([...new Set(result.issues)],[...new Set(result.record_ids)]);
  return source;
}
