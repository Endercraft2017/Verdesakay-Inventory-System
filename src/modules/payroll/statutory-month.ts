/**
 * The contribution month a cutoff belongs to, and each employee's earlier payslips in it —
 * what generate-payslips needs to compute SSS / Pag-IBIG on the month's actual pay (see
 * ph-statutory.ts `contributionBasis` / `monthRemainder`). Reads the hr-owned
 * `attendance_periods` table and the `hr_payroll` form records; no hr code import (same
 * arrangement as payslip-owner.ts).
 *
 * SSS IRR (RA 11199): for hourly/daily/weekly-paid employees the month runs from the end of
 * the last payroll period of the preceding month to the end of the last payroll period of the
 * current month — so a cutoff counts toward the month its LAST day falls in, whatever its pay
 * date (a 16–30 Sep cutoff paid on 5 Oct is September's).
 */
import { payslipOwnerResolver, type PayslipOwnerResolver } from './payslip-owner';
import {payrollSourceIndex,cutoffPayrollSources,assertCutoffPayroll,PayrollSourceError} from './payroll-source';

export type CutoffFrequency = 'monthly' | 'semi_monthly' | 'weekly' | 'daily';

/** YYYY-MM of the contribution month `period` counts toward. */
export function contributionMonthOf(period: { end_date: string }): string {
  return period.end_date.slice(0, 7);
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Whether `period` is the last cutoff of its contribution month. Monthly: always. Semi-monthly:
    the second half (starts after the 15th — the same split the deduction schedule's slots use).
    Weekly / daily: the next cutoff of the same length would end in the following month. */
export function isLastCutoffOfMonth(period: { start_date: string; end_date: string }, freq: CutoffFrequency): boolean {
  if (freq === 'monthly') return true;
  if (freq === 'semi_monthly') return Number(period.start_date.slice(8, 10)) > 15;
  const lengthDays = Math.round(
    (Date.parse(`${period.end_date.slice(0, 10)}T00:00:00Z`) - Date.parse(`${period.start_date.slice(0, 10)}T00:00:00Z`)) / 86_400_000
  ) + 1;
  return contributionMonthOf({ end_date: addDays(period.end_date, Math.max(1, lengthDays)) }) !== contributionMonthOf(period);
}

/** Every employee's payslips for the cutoffs of `period`'s contribution month that end before
    it does, keyed by employee id. Duplicate/ambiguous sources stop the calculation for review; no newest-record choice. */
export function earlierPayslipsInMonth(
  period: { id: number; end_date: string },
  owner: PayslipOwnerResolver = payslipOwnerResolver()
): Map<number, Record<string, unknown>[]> {
  const index=payrollSourceIndex();
  // An unlinked legacy record in this pay month might be an earlier cutoff. It must
  // not disappear from the month-to-date deductions just because its label has no match.
  const unlinked=index.rows.filter(source=>{
    if(source.cutoff_id!=null)return false;
    const date=source.data?.pay_date || source.raw.created_at;
    return typeof date!=='string'||!/^\d{4}-(0[1-9]|1[0-2])-/.test(date)||date.slice(0,7)===contributionMonthOf(period);
  });
  if(unlinked.length)throw new PayrollSourceError(['unlinked_month_source'],unlinked.map(s=>s.raw.id));
  const out=new Map<number,Record<string,unknown>[]>();
  for(const cutoff of index.periods.values()){
    if(cutoff.id===period.id||contributionMonthOf(cutoff)!==contributionMonthOf(period)||cutoff.end_date>=period.end_date)continue;
    if(!cutoffPayrollSources(index,cutoff.id).rows.length)continue;
    for(const source of assertCutoffPayroll(index,cutoff.id)){
      const employeeId=owner.idOf(source.data!);
      if(employeeId==null)continue;
      out.set(employeeId,[...(out.get(employeeId)??[]),source.data!]);
    }
  }
  return out;
}
