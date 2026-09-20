/**
 * Final-pay / back-pay worksheet (pure). The route feeds it the employee's rate + this
 * year's payslip figures + the tracked leave-day bank (default, operator-overridable) +
 * a few other operator inputs (outstanding loans, unpaid days); this returns the itemised
 * computation. It is a *worksheet*, not a filed document — the accountant reviews it
 * before release.
 *
 * References: Labor Code Art. 297/300 (separation), DOLE Labor Advisory 06-20 (final pay
 * within 30 days), Revenue Regs. on the 90k 13th-month / de-minimis exclusion and
 * year-end tax annualisation.
 */
import { withholdingTax, type RwtParams } from './ph-statutory';

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export interface FinalPayInput {
  employee_name: string;
  /** Effective daily rate (the payroll engine keeps this correct for monthly-paid staff). */
  daily_rate: number;
  separation_date: string;          // YYYY-MM-DD
  /** End date of the last period already covered by a generated payslip. */
  last_day_paid: string | null;
  /** Days actually worked after `last_day_paid` and not yet in any payslip. */
  unpaid_days: number;
  /**
   * Unused, convertible leave credits (days). The route defaults this from the employee's
   * tracked leave-day bank (`employees.leave_days_per_year - leave_days_used`), but it's
   * still an operator-overridable input — not every leave type or company policy converts
   * a remaining balance to cash 1:1 at separation.
   */
  unused_leave_days: number;
  /** Other taxable amounts still due (e.g. pro-rated allowance) — operator enters. */
  other_earnings: number;
  /** Outstanding cash advance / company loan balance to net out. */
  outstanding_advance: number;
  /** Any other deduction (e.g. equipment, training bond). */
  other_deductions: number;
  /** This calendar year, to date (from the employee's generated payslips). */
  ytd: {
    basic_earned: number;
    gross_earned: number;         // sum of total_earnings
    employee_statutory: number;   // sum of sss+philhealth+pagibig (employee share)
    tax_withheld: number;         // sum of withholding_tax
    thirteenth_month_paid: number; // any 13th-month already released this year
  };
  /** Annual graduated table (RWT_2026.annual or the effective override). */
  rwt: RwtParams;
  /** 13th-month + other-benefits tax-exempt ceiling (default 90,000). */
  thirteenth_month_ceiling?: number;
}

export interface FinalPayResult {
  employee_name: string;
  separation_date: string;
  last_day_paid: string | null;
  earnings: {
    unpaid_salary: number;
    prorated_13th_month: number;
    leave_conversion: number;
    other_earnings: number;
    gross: number;
  };
  /** Year-end tax annualisation: + = still to collect, − = refund to employee. */
  tax_annualisation: {
    taxable_income: number;
    annual_tax_due: number;
    tax_already_withheld: number;
    adjustment: number;
  };
  deductions: {
    outstanding_advance: number;
    other_deductions: number;
    tax_still_due: number;   // max(adjustment, 0)
    total: number;
  };
  additions: {
    tax_refund: number;      // max(-adjustment, 0)
  };
  net_final_pay: number;
  notes: string[];
}

function annualTax(taxable: number, rwt: RwtParams): number {
  return withholdingTax(Math.max(0, taxable), 'annual', rwt);
}

export function computeFinalPay(input: FinalPayInput): FinalPayResult {
  const notes: string[] = [];
  const ceiling = input.thirteenth_month_ceiling ?? 90_000;

  const unpaid_salary = round2(Math.max(0, input.unpaid_days) * input.daily_rate);
  const leave_conversion = round2(Math.max(0, input.unused_leave_days) * input.daily_rate);
  const other_earnings = round2(Math.max(0, input.other_earnings));

  // Pro-rated 13th month = basic salary earned this year (incl. the unpaid days now being
  // paid) ÷ 12, less any 13th-month already released.
  const basicForYear = round2(input.ytd.basic_earned + unpaid_salary);
  const prorated_13th_gross = round2(basicForYear / 12);
  const prorated_13th_month = round2(Math.max(0, prorated_13th_gross - input.ytd.thirteenth_month_paid));
  if (input.ytd.thirteenth_month_paid > 0) {
    notes.push(`13th-month already released this year (${input.ytd.thirteenth_month_paid.toFixed(2)}) is deducted from the pro-rated amount.`);
  }

  const gross = round2(unpaid_salary + prorated_13th_month + leave_conversion + other_earnings);

  // ---- Year-end tax annualisation ----
  // Taxable = YTD gross + unpaid salary + other earnings + leave conversion
  //           − YTD employee statutory − the tax-exempt slice of 13th-month/other benefits.
  const totalCompensation = round2(input.ytd.gross_earned + unpaid_salary + other_earnings + leave_conversion);
  const benefits = round2(prorated_13th_gross + input.ytd.thirteenth_month_paid);
  const exemptBenefits = Math.min(benefits, ceiling);
  const taxableBenefits = round2(benefits - exemptBenefits);
  const taxable_income = round2(Math.max(0, totalCompensation - input.ytd.employee_statutory + taxableBenefits));
  const annual_tax_due = annualTax(taxable_income, input.rwt);
  const adjustment = round2(annual_tax_due - input.ytd.tax_withheld);
  if (taxableBenefits > 0) {
    notes.push(`13th-month / other benefits of ${benefits.toFixed(2)} exceed the ${ceiling.toLocaleString()} exemption; ${taxableBenefits.toFixed(2)} is taxable.`);
  }
  notes.push(adjustment >= 0
    ? `Annualised tax due (${annual_tax_due.toFixed(2)}) exceeds tax withheld (${input.ytd.tax_withheld.toFixed(2)}) — ${adjustment.toFixed(2)} is collected from the final pay.`
    : `Tax withheld (${input.ytd.tax_withheld.toFixed(2)}) exceeds annualised tax due (${annual_tax_due.toFixed(2)}) — ${(-adjustment).toFixed(2)} is refunded to the employee.`);

  const tax_still_due = Math.max(adjustment, 0);
  const tax_refund = Math.max(-adjustment, 0);

  const deductionsTotal = round2(
    Math.max(0, input.outstanding_advance) + Math.max(0, input.other_deductions) + tax_still_due
  );
  const net_final_pay = round2(gross + tax_refund - deductionsTotal);

  if (input.unpaid_days <= 0 && input.unused_leave_days <= 0 && other_earnings === 0) {
    notes.push('No unpaid salary, leave conversion or other earnings entered — the worksheet is the tax adjustment only.');
  }

  return {
    employee_name: input.employee_name,
    separation_date: input.separation_date,
    last_day_paid: input.last_day_paid,
    earnings: { unpaid_salary, prorated_13th_month, leave_conversion, other_earnings, gross },
    tax_annualisation: {
      taxable_income,
      annual_tax_due,
      tax_already_withheld: round2(input.ytd.tax_withheld),
      adjustment,
    },
    deductions: {
      outstanding_advance: round2(Math.max(0, input.outstanding_advance)),
      other_deductions: round2(Math.max(0, input.other_deductions)),
      tax_still_due: round2(tax_still_due),
      total: deductionsTotal,
    },
    additions: { tax_refund: round2(tax_refund) },
    net_final_pay,
    notes,
  };
}
