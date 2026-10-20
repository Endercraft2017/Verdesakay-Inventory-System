import type {PayrollDoc} from './accounting-posting';
import {PayrollSourceError, type PayrollCutoff, type PayrollSource} from '../payroll/payroll-source';
import {queryAll} from '../../shared/db';
const round2 = (v: number) => Math.round((v + Number.EPSILON)*100)/100;

export function livePayrollEntries(periodId: number) {
  return queryAll<{id:number;number:string;entry_date:string;book:string}>(`SELECT je.id,je.number,je.entry_date,je.book FROM journal_entries je WHERE je.source_type='payroll_run' AND je.source_id=? AND je.status='posted' AND je.reverses_id IS NULL AND NOT EXISTS(SELECT 1 FROM journal_entries r WHERE r.reverses_id=je.id AND r.status='posted') ORDER BY je.id`,periodId);
}
export function payrollJournalLines(entryId: number) {
  return queryAll<{account_id:number;debit:number;credit:number;party_type:string|null;party_id:number|null}>('SELECT account_id,debit,credit,party_type,party_id FROM journal_lines WHERE entry_id=?',entryId);
}
export function validPayrollJournal(book: string, lines: ReturnType<typeof payrollJournalLines>): boolean {
  if(book!=='payroll'||lines.length<2)return false;
  let debit=0,credit=0;
  for(const l of lines){
    if(![l.debit,l.credit].every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&Number.isSafeInteger(Math.round(n*100)))||(l.debit>0&&l.credit>0))return false;
    debit+=Math.round(l.debit*100);credit+=Math.round(l.credit*100);
  }
  return Number.isSafeInteger(debit)&&Number.isSafeInteger(credit)&&debit>0&&credit>0&&Math.abs(debit-credit)<=1;
}

/** A deterministic source document shared by posting and read-only comparison. */
export function payrollLedgerDocument(period: PayrollCutoff, sources: PayrollSource[]): PayrollDoc | null {
  if (!sources.length) return null;
  const payDates = new Set<string>();
  const amount = (row: PayrollSource, value: unknown): number => {
    if (value == null || value === '') return 0;
    const n = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
    if (!Number.isFinite(n) || !Number.isSafeInteger(Math.round(n*100))) throw new PayrollSourceError(['invalid_amount'],[row.raw.id]);
    return n;
  };
  const totals = {gross_total:0,late_total:0,er_contrib_total:0,sss_payable_total:0,philhealth_payable_total:0,pagibig_payable_total:0,withholding_tax_total:0,net_pay_total:0,cash_advance_total:0};
  for (const row of sources) {
    const d = row.data!;
    const date = d.pay_date == null || d.pay_date === '' ? period.end_date : d.pay_date;
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date+'T00:00:00Z')) || new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date) throw new PayrollSourceError(['invalid_pay_date'],[row.raw.id]);
    payDates.add(date);
    const rawEr = d.employer_contributions;
    if (rawEr != null && (typeof rawEr !== 'object' || Array.isArray(rawEr))) throw new PayrollSourceError(['invalid_amount'],[row.raw.id]);
    const er = (rawEr ?? {}) as Record<string,unknown>;
    const n = (v: unknown) => amount(row,v);
    totals.gross_total += n(d.total_earnings); totals.late_total += n(d.late_absences);
    totals.er_contrib_total += n(er.sss_er)+n(er.sss_ec)+n(er.philhealth_er)+n(er.pagibig_er);
    totals.sss_payable_total += n(d.sss)+n(er.sss_er)+n(er.sss_ec);
    totals.philhealth_payable_total += n(d.philhealth)+n(er.philhealth_er);
    totals.pagibig_payable_total += n(d.pagibig)+n(er.pagibig_er);
    totals.withholding_tax_total += n(d.withholding_tax); totals.net_pay_total += n(d.net_pay);
    totals.cash_advance_total += n(d.cash_advance);
  }
  if (payDates.size !== 1) throw new PayrollSourceError(['mixed_pay_dates'],sources.map(r=>r.raw.id));
  for (const key of Object.keys(totals) as (keyof typeof totals)[]) {
    totals[key] = round2(totals[key]);
    if (!Number.isSafeInteger(Math.round(totals[key]*100))) throw new PayrollSourceError(['invalid_amount'],sources.map(r=>r.raw.id));
  }
  return {...totals,number:period.label,date:[...payDates][0]!};
}
