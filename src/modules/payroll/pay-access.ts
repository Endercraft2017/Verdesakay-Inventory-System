/**
 * Who may see and change pay. HR records (hr.view / hr.manage) cover employees, timekeeping,
 * memos and the rest of HR; pay is its own pair of permissions so a timekeeping clerk can run
 * cutoffs without seeing salaries:
 *   payroll.view   — rates on the employee record, payslips, 13th month, final pay, rate tables
 *   payroll.manage — change rates and pay settings, generate / post / mark paid / email payslips
 * Routes gate with requirePermission('payroll.*'); employee reads strip the pay fields below for
 * anyone without payroll.view, and employee saves keep the stored pay fields for anyone without
 * payroll.manage (the form never sees them, so it can't be trusted to send them back).
 */
import type { AuthUser } from '../../shared/types';

/** Columns of `employees` that are pay data. */
export const PAY_FIELDS = [
  'rate_type', 'daily_rate', 'monthly_rate',
  'deduct_sss', 'deduct_philhealth', 'deduct_pagibig', 'deduct_withholding_tax',
  'withholding_tax_override', 'sss_override', 'philhealth_override', 'pagibig_override',
  'contribution_basis',
] as const;

/** The form slug payslips are stored under (form_records). */
export const PAYROLL_FORM_SLUG = 'hr_payroll';

export function canSeePay(user: Pick<AuthUser, 'permissions'> | undefined | null): boolean {
  return !!user && user.permissions.includes('payroll.view');
}

export function canChangePay(user: Pick<AuthUser, 'permissions'> | undefined | null): boolean {
  return !!user && user.permissions.includes('payroll.manage');
}

/** Remove the pay fields from employee rows the caller may not see (in place); marks each row
    `pay_hidden: true` so the form knows to hide its Pay section rather than show zeros. */
export function redactPay<T extends object>(rows: T[], user: Pick<AuthUser, 'permissions'> | undefined | null): T[] {
  if (canSeePay(user)) return rows;
  for (const r of rows) {
    const rec = r as Record<string, unknown>;
    for (const f of PAY_FIELDS) delete rec[f];
    rec.pay_hidden = true;
  }
  return rows;
}
