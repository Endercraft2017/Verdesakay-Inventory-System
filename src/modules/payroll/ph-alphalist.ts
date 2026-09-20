/**
 * BIR 1604-C Alphalist — Schedule 1 (Alphalist of Employees, declared/certified with
 * BIR Form 2316). Pure. Produces one row per employee in the BIR's published column
 * order (see the "1604C Alphalist Format" annex), computed from each employee's
 * year-end 2316 figures.
 *
 * SCOPE: the BIR ships the column *format* but not the machine `.DAT` record layout
 * (that lives in the ADES / Alphalist Data Entry & Validation Module). We emit the
 * exact Schedule-1 columns as CSV; the customer converts to `.DAT` and validates with
 * BIR's tool (or an Excel→DAT converter that takes this same layout). Schedule 2 (MWE)
 * is not produced — the payroll doesn't classify minimum-wage earners.
 * See docs/PH-PAYROLL-COMPLIANCE.md §3b.
 */
import type { Bir2316Figures } from './ph-2316';

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export interface AlphalistEmployeeInput {
  last_name: string;
  first_name: string;
  middle_name: string;
  tin: string;
  /** R / C / CP / S / P / AL — BIR "Current Employment Status" codes. */
  status_code: string;
  /** MM/DD */
  period_from: string;
  /** MM/DD */
  period_to: string;
  /** T / TR / R / D — BIR "Reason of Separation" codes, blank if not separated. */
  separation_code: string;
  nationality: string; // for foreigners only, else blank
}

/** One Schedule-1 row. Keys are the BIR column references (col 1, 2a…, 6, 7a…7j, 13…19). */
export interface AlphalistScheduleRow {
  seq: number;
  last_name: string;      // 2a
  first_name: string;     // 2b
  middle_name: string;    // 2c
  tin: string;
  nationality: string;    // 3
  status: string;         // 4
  period_from: string;    // 5a
  period_to: string;      // 5b
  separation: string;     // 6
  gross_compensation: number;       // 7a / (6)
  nt_13th_month: number;            // 7b — 13th-month & other benefits (non-taxable portion)
  nt_de_minimis: number;            // 7c
  nt_statutory: number;             // 7d — SSS/GSIS/PHIC/HDMF + union dues (EE share)
  nt_salaries_250k_below: number;   // 7e
  nt_total: number;                 // 7f = 7b+7c+7d+7e
  tx_basic_salary: number;          // 7g — basic salary net of statutory
  tx_13th_month_excess: number;     // 7h
  tx_salaries_other: number;        // 7i
  tx_total: number;                 // 7j = 7g+7h+7i
  // Previous employer (8..12j) — not tracked in payroll; carried from opts on the 2316 call.
  prev_taxable_total: number;       // 12j
  total_taxable_present_prev: number; // 13 = 7j + 12j
  tax_due: number;                  // 14
  tax_withheld_prev: number;        // 15a
  tax_withheld_present: number;     // 15b
  pera_credit: number;              // 16
  yea_over_withheld_refunded: number;  // 17a-ish (refund to employee) — positive when over-withheld
  yea_still_due: number;               // 17b — collectible from employee
  tax_withheld_adjusted: number;    // 18
  substituted_filing: 'Y' | 'N';    // 19
}

/** BIR Schedule-1 column headers, in emit order — for the CSV. */
export const ALPHALIST_SCHEDULE1_HEADERS = [
  'Seq No', 'Last Name', 'First Name', 'Middle Name', 'TIN',
  'Nationality (foreigners only)', 'Employment Status', 'Period From (MM/DD)', 'Period To (MM/DD)',
  'Reason of Separation',
  'Gross Compensation Income (present)',
  '13th Month Pay & Other Benefits (non-taxable)', 'De Minimis Benefits',
  'SSS/GSIS/PHIC/HDMF & Union Dues (EE share)', 'Salaries (P250,000 & below) & Other Non-Taxable',
  'Total Non-Taxable/Exempt (present)',
  'Basic Salary (net of statutory)', '13th Month Pay in Excess of Threshold',
  'Salaries & Other Forms of Compensation (taxable)', 'Total Taxable Compensation (present)',
  'Total Taxable Compensation (previous employer)',
  'Total Taxable Compensation (present & previous)',
  'Tax Due (Jan-Dec)', 'Tax Withheld (previous employer)', 'Tax Withheld (present employer)',
  '5% Tax Credit (PERA)',
  'Over-Withheld Tax Refunded to Employee', 'Tax Still Due from Employee',
  'Amount of Tax Withheld as Adjusted', 'Substituted Filing (Y/N)',
] as const;

export function alphalistScheduleRow(
  seq: number,
  emp: AlphalistEmployeeInput,
  f: Bir2316Figures
): AlphalistScheduleRow {
  const ceiling = f.thirteenth_month_ceiling;
  const nt13 = round2(Math.min(f.thirteenth_month_raw, Math.max(0, ceiling - f.de_minimis)));
  const deMinimis = round2(f.de_minimis);
  const tx13excess = round2(Math.max(0, f.thirteenth_month_raw - ceiling));
  // Basic salary net of statutory ≈ present-employer taxable minus the 13th-month excess,
  // split into "basic" vs "other" isn't tracked separately in payroll — put it all in
  // basic and leave "salaries & other" 0 unless the excess pushes it.
  const txTotal = round2(f.taxable_compensation_present);
  const txBasic = round2(Math.max(0, txTotal - tx13excess));
  const yea = round2(f.over_withheld); // >0 refund, <0 still due
  return {
    seq,
    last_name: emp.last_name,
    first_name: emp.first_name,
    middle_name: emp.middle_name,
    tin: emp.tin,
    nationality: emp.nationality,
    status: emp.status_code,
    period_from: emp.period_from,
    period_to: emp.period_to,
    separation: emp.separation_code,
    gross_compensation: f.gross_compensation,
    nt_13th_month: nt13,
    nt_de_minimis: deMinimis,
    nt_statutory: f.sss_gsis_phic_pagibig_union,
    nt_salaries_250k_below: 0,
    nt_total: round2(nt13 + deMinimis + f.sss_gsis_phic_pagibig_union),
    tx_basic_salary: txBasic,
    tx_13th_month_excess: tx13excess,
    tx_salaries_other: 0,
    tx_total: txTotal,
    prev_taxable_total: f.taxable_compensation_previous,
    total_taxable_present_prev: round2(txTotal + f.taxable_compensation_previous),
    tax_due: f.tax_due,
    tax_withheld_prev: f.tax_withheld_previous,
    tax_withheld_present: f.tax_withheld_present,
    pera_credit: 0,
    yea_over_withheld_refunded: yea > 0 ? yea : 0,
    yea_still_due: yea < 0 ? round2(-yea) : 0,
    tax_withheld_adjusted: f.total_tax_withheld,
    substituted_filing:
      f.taxable_compensation_previous === 0 && Math.abs(f.over_withheld) < 0.01 ? 'Y' : 'N',
  };
}

/** Ordered cell values for `row`, matching ALPHALIST_SCHEDULE1_HEADERS. */
export function alphalistRowCells(r: AlphalistScheduleRow): (string | number)[] {
  return [
    r.seq, r.last_name, r.first_name, r.middle_name, r.tin,
    r.nationality, r.status, r.period_from, r.period_to, r.separation,
    r.gross_compensation,
    r.nt_13th_month, r.nt_de_minimis, r.nt_statutory, r.nt_salaries_250k_below, r.nt_total,
    r.tx_basic_salary, r.tx_13th_month_excess, r.tx_salaries_other, r.tx_total,
    r.prev_taxable_total,
    r.total_taxable_present_prev,
    r.tax_due, r.tax_withheld_prev, r.tax_withheld_present, r.pera_credit,
    r.yea_over_withheld_refunded, r.yea_still_due, r.tax_withheld_adjusted, r.substituted_filing,
  ];
}

/** Split a full name into last/first/middle for the alphalist. Best-effort: if the name
    has a comma it's "Last, First Middle"; otherwise the last token is the surname. */
export function splitName(full: string): { last_name: string; first_name: string; middle_name: string } {
  const s = (full || '').trim();
  if (s.includes(',')) {
    const [last, rest] = s.split(',', 2);
    const parts = rest!.trim().split(/\s+/);
    return { last_name: last!.trim(), first_name: parts.slice(0, -1).join(' ') || parts[0] || '', middle_name: parts.length > 1 ? parts[parts.length - 1]! : '' };
  }
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { last_name: s, first_name: '', middle_name: '' };
  return {
    last_name: parts[parts.length - 1]!,
    first_name: parts.slice(0, -1).join(' '),
    middle_name: '',
  };
}

/** BIR "Current Employment Status" code. Payroll only distinguishes probationary vs the
    rest, so everyone else maps to Regular; the separation column carries resigned/terminated. */
export function statusCode(employeeStatus: string | null | undefined): string {
  return String(employeeStatus || '').toLowerCase() === 'probationary' ? 'P' : 'R';
}

/** BIR "Reason of Separation" code (T/TR/R/D), blank if still employed. */
export function separationCode(employeeStatus: string | null | undefined): string {
  const s = String(employeeStatus || '').toLowerCase();
  return s === 'resigned' || s === 'terminated' ? 'T' : '';
}
