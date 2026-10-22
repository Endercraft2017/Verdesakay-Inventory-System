/** Shared payroll source identity. No newest-record-wins or label-only cutoff adoption. */
import {queryAll} from '../../shared/db';
import type {FormRecord} from '../../shared/types';
import {payslipOwnerResolver} from './payslip-owner';

export interface PayrollCutoff {id: number; label: string; start_date: string; end_date: string}
export interface PayrollSource {
  raw: FormRecord; data: Record<string, unknown> | null; label: string;
  employee_id: number | null; cutoff_id: number | null;
  issues: string[];
}
export interface PayrollSourceIndex {
  rows: PayrollSource[]; periods: Map<number, PayrollCutoff>; labels: Map<string, number[]>;
  duplicate_ids: Set<number>;
}
export class PayrollSourceError extends Error {
  readonly status = 409;
  constructor(public readonly issues: string[], public readonly record_ids: number[]) {
    const labels: Record<string,string> = {not_finalized:'payslip is not marked paid',duplicate_employee_cutoff:'duplicate payslips for an employee and cutoff',unreadable_data:'unreadable payroll data',unresolved_employee:'unresolved employee ownership',invalid_cutoff:'invalid cutoff reference',ambiguous_cutoff_label:'ambiguous cutoff label',cutoff_label_conflict:'label identifies another cutoff',foreign_cutoff:'payroll from another cutoff',unlinked_cutoff:'unverified cutoff link',unsupported_status:'unsupported payslip status',invalid_amount:'invalid payroll amount',invalid_pay_date:'invalid pay date',mixed_pay_dates:'different pay dates in one run',multiple_live_journals:'multiple unreversed payroll journals',invalid_live_journal:'invalid existing payroll journal',unlinked_month_source:'unlinked monthly payroll needs cutoff review'};
    super(`Payroll source needs review: ${[...new Set(issues)].map(code=>labels[code]??'unverified source').join('; ')}. Record IDs: ${record_ids.slice(0,10).join(', ') || 'none'}${record_ids.length > 10 ? ', …' : ''}. No payroll or journal changes were made.`);
    this.name = 'PayrollSourceError';
  }
}
export function stablePayrollId(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
export function payrollSourceIndex(): PayrollSourceIndex {
  const periods = new Map(queryAll<PayrollCutoff>('SELECT id,label,start_date,end_date FROM attendance_periods').map(p => [p.id,p]));
  const labels = new Map<string, number[]>();
  for (const p of periods.values()) labels.set(p.label, [...(labels.get(p.label) ?? []),p.id]);
  const owner = payslipOwnerResolver(), groups = new Map<string, PayrollSource[]>();
  const rows = queryAll<FormRecord>(`SELECT fr.* FROM form_records fr JOIN form_definitions fd ON fd.id=fr.form_def_id WHERE fd.slug='hr_payroll' ORDER BY fr.id`).map(raw => {
    let data: Record<string,unknown> | null = null;
    try { const value: unknown = typeof raw.data === 'string' ? JSON.parse(raw.data) : raw.data;
      if (value && typeof value === 'object' && !Array.isArray(value)) data = value as Record<string,unknown>;
    } catch { /* an issue, never an empty monetary record */ }
    const label = raw.period || (typeof data?.payroll_period === 'string' ? data.payroll_period : '');
    const issues: string[] = [];
    if (!data) issues.push('unreadable_data');
    const employee_id = data && (data.employee_id != null || typeof data.employee_name === 'string') ? owner.idOf(data) : null;
    if (employee_id == null) issues.push('unresolved_employee');
    let cutoff_id: number | null = null;
    if (data?.cutoff_id != null) {
      const id = stablePayrollId(data.cutoff_id);
      if (id != null && periods.has(id)) cutoff_id = id; else issues.push('invalid_cutoff');
    } else {
      const matches = labels.get(label) ?? [];
      if (matches.length === 1) cutoff_id = matches[0]!;
      else if (matches.length > 1) issues.push('ambiguous_cutoff_label');
    }
    const source: PayrollSource = {raw,data,label,employee_id,cutoff_id,issues};
    return source;
  });
  // Generated custom labels are usable legacy aliases only when every recorded
  // claimant (cutoff rows and valid stamped payroll) identifies the same cutoff.
  for (const row of rows) if (row.data?.cutoff_id != null && row.cutoff_id != null && row.label) {
    labels.set(row.label,[...new Set([...(labels.get(row.label) ?? []),row.cutoff_id])]);
  }
  for (const row of rows) {
    if (row.data?.cutoff_id == null) {
      const matches=labels.get(row.label) ?? [];
      row.cutoff_id=matches.length===1?matches[0]!:null;
      if(matches.length>1 && !row.issues.includes('ambiguous_cutoff_label'))row.issues.push('ambiguous_cutoff_label');
    }
    const key=row.cutoff_id!=null?`id:${row.cutoff_id}`:row.label?`label:${row.label}`:null;
    if(row.employee_id!=null&&key!=null){
      const group=`${row.employee_id}|${key}`;
      groups.set(group,[...(groups.get(group)??[]),row]);
    }
  }
  const duplicate_ids = new Set<number>();
  for (const group of groups.values()) if (group.length > 1) for (const row of group) {
    row.issues.push('duplicate_employee_cutoff'); duplicate_ids.add(row.raw.id);
  }
  return {rows,periods,labels,duplicate_ids};
}
export function cutoffPayrollSources(index: PayrollSourceIndex, periodId: number, requestedLabel?: string): {rows: PayrollSource[]; issues: string[]; record_ids: number[]} {
  const period = index.periods.get(periodId);
  if (!period) throw Object.assign(new Error('Cutoff not found'),{status:404});
  const issues = new Set<string>(), ids = new Set<number>();
  const label = requestedLabel || period.label;
  const claims=index.labels.get(label)??[];
  if(claims.length&&!claims.includes(periodId))issues.add('cutoff_label_conflict');
  // Valid stamps disambiguate shared display labels. Unstamped/invalid legacy rows
  // whose label could refer to this cutoff remain candidates requiring review.
  const rows = index.rows.filter(s => s.cutoff_id === periodId || (!(s.data?.cutoff_id!=null&&s.cutoff_id!=null)&&(s.label === period.label || s.label === label)));
  for (const row of rows) {
    for (const issue of row.issues) issues.add(issue);
    if (row.cutoff_id !== periodId) issues.add(row.cutoff_id == null ? 'unlinked_cutoff' : 'foreign_cutoff');
    if (!['draft','paid'].includes(row.raw.status)) issues.add('unsupported_status');
    if (row.issues.length || row.cutoff_id !== periodId || !['draft','paid'].includes(row.raw.status)) ids.add(row.raw.id);
  }
  return {rows,issues:[...issues],record_ids:[...ids]};
}
export function assertCutoffPayroll(index: PayrollSourceIndex, periodId: number, requestedLabel?: string): PayrollSource[] {
  const selection = cutoffPayrollSources(index,periodId,requestedLabel);
  if (selection.issues.length) throw new PayrollSourceError(selection.issues,selection.record_ids);
  return selection.rows;
}
