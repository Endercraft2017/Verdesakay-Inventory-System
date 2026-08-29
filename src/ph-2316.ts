/**
 * BIR Form 2316 (Certificate of Compensation Payment / Tax Withheld) year-end figures.
 * Pure and DB-free. Computes the standard Part IV-A / IV-B lines from an employee's
 * generated payslips for the year + the annual income-tax table.
 *
 * SCOPE NOTE: the payslip records carry basic pay, OT, holiday and the statutory
 * deductions — not a separate breakdown of de-minimis, allowances, or previous-employer
 * figures. Those come in as `opts` (0 by default). Treat the output as a worksheet to
 * fill the official BIR form / validate before filing. See docs/PH-PAYROLL-COMPLIANCE.md.
 */
import { withholdingTax, type RwtParams } from './ph-statutory';

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** One generated `hr_payroll` record's numeric fields, for a single pay period. */
export interface PayslipYearRow {
  basic_salary?: number;
  overtime_pay?: number;
  undertime_pay?: number;
  holiday_pay?: number;
  special_holiday_30?: number;
  rest_day_ot?: number;
  total_earnings?: number;
  sss?: number;
  philhealth?: number;
  pagibig?: number;
  withholding_tax?: number;
}

export interface Bir2316Options {
  /** Non-taxable ceiling for 13th-month + other benefits (₱90,000 unless changed by law). */
  thirteenth_month_ceiling?: number;
  /** De-minimis benefits total for the year (not tracked in payslips — supply if known). */
  de_minimis?: number;
  /** Taxable compensation from a previous employer this year. */
  taxable_previous?: number;
  /** Tax withheld by a previous employer this year. */
  tax_withheld_previous?: number;
}

export interface Bir2316Figures {
  year: string;
  payslip_count: number;

  // Part IV-B — Non-Taxable / Exempt Compensation Income
  sss_gsis_phic_pagibig_union: number;      // Σ employee statutory shares (+ union dues if tracked)
  thirteenth_month_and_other_benefits: number; // Σ(basic)/12, capped at the ceiling
  thirteenth_month_ceiling: number;
  de_minimis: number;
  total_non_taxable: number;

  // Part IV-B — Taxable Compensation Income (present employer)
  basic_salary: number;
  overtime_pay: number;
  holiday_pay: number;
  night_diff_and_other: number;             // special holiday premium + rest-day OT bucket
  taxable_13th_month_excess: number;        // amount of 13th month + benefits above the ceiling

  // Part IV-A — Summary
  gross_compensation: number;               // present employer, taxable + non-taxable
  taxable_compensation_present: number;
  taxable_compensation_previous: number;
  gross_taxable_compensation: number;
  tax_due: number;                          // annual graduated tax on gross taxable
  tax_withheld_present: number;
  tax_withheld_previous: number;
  total_tax_withheld: number;
  /** > 0 → over-withheld (refund due to employee); < 0 → tax still collectible. */
  over_withheld: number;
}

export function compute2316(
  rows: PayslipYearRow[],
  rwt: RwtParams,
  year: string,
  opts: Bir2316Options = {}
): Bir2316Figures {
  const sum = (pick: (r: PayslipYearRow) => number | undefined): number =>
    round2(rows.reduce((s, r) => s + (Number(pick(r)) || 0), 0));

  const ceiling = opts.thirteenth_month_ceiling ?? 90_000;
  const deMinimis = round2(opts.de_minimis ?? 0);

  const basic = sum((r) => r.basic_salary);
  const ot = sum((r) => r.overtime_pay);
  const holiday = sum((r) => r.holiday_pay);
  const nightOther = round2(sum((r) => r.special_holiday_30) + sum((r) => r.rest_day_ot));
  const earnings = sum((r) => r.total_earnings); // already includes basic + ot + holiday + rest-day OT

  const statutory = round2(sum((r) => r.sss) + sum((r) => r.philhealth) + sum((r) => r.pagibig));

  // 13th-month pay + other benefits (with de-minimis in excess of its own limits, which we
  // don't track separately) are non-taxable up to `ceiling`; anything above is taxable.
  const thirteenthRaw = round2(basic / 12);
  const benefitsTotal = round2(thirteenthRaw + deMinimis);
  const benefitsNonTaxable = round2(Math.min(benefitsTotal, ceiling));
  const benefitsTaxableExcess = round2(Math.max(0, benefitsTotal - ceiling));

  const totalNonTaxable = round2(statutory + benefitsNonTaxable);
  const grossCompensation = round2(earnings + benefitsTotal);
  const taxablePresent = round2(Math.max(0, grossCompensation - totalNonTaxable));
  const taxablePrevious = round2(opts.taxable_previous ?? 0);
  const grossTaxable = round2(taxablePresent + taxablePrevious);
  const taxDue = withholdingTax(grossTaxable, 'annual', rwt);
  const withheldPresent = sum((r) => r.withholding_tax);
  const withheldPrevious = round2(opts.tax_withheld_previous ?? 0);
  const totalWithheld = round2(withheldPresent + withheldPrevious);

  return {
    year,
    payslip_count: rows.length,
    sss_gsis_phic_pagibig_union: statutory,
    thirteenth_month_and_other_benefits: benefitsNonTaxable,
    thirteenth_month_ceiling: ceiling,
    de_minimis: deMinimis,
    total_non_taxable: totalNonTaxable,
    basic_salary: basic,
    overtime_pay: ot,
    holiday_pay: holiday,
    night_diff_and_other: nightOther,
    taxable_13th_month_excess: benefitsTaxableExcess,
    gross_compensation: grossCompensation,
    taxable_compensation_present: taxablePresent,
    taxable_compensation_previous: taxablePrevious,
    gross_taxable_compensation: grossTaxable,
    tax_due: taxDue,
    tax_withheld_present: withheldPresent,
    tax_withheld_previous: withheldPrevious,
    total_tax_withheld: totalWithheld,
    over_withheld: round2(totalWithheld - taxDue),
  };
}
