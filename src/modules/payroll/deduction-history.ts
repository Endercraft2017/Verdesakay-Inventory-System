import { queryAll, run } from '../../shared/db';
import { now } from '../../shared/sync-context';
import type { AuthUser } from '../../shared/types';

const funds = ['sss','philhealth','pagibig','withholding_tax'] as const;
export function deductionValues(data: Record<string, unknown>) {
  const overrides = (data.statutory_overrides || {}) as Record<string, unknown>;
  return {
    ...Object.fromEntries(funds.map(key => [key, Number(data[key]) || 0])),
    applied: Object.fromEntries(funds.map(key => [key, data[key + '_applied'] !== false])),
    overrides: Object.fromEntries(funds.map(key => [key, overrides[key] ?? null])),
    other_deductions: data.other_deductions || [],
    cash_advance: Number(data.cash_advance) || 0,
    total_deductions: Number(data.total_deductions) || 0,
    net_pay: Number(data.net_pay) || 0,
  };
}
export function recordDeductionChange(recordId: number, before: Record<string, unknown>, after: Record<string, unknown>, actor: AuthUser, reason?: string) {
  const oldValues = JSON.stringify(deductionValues(before)), newValues = JSON.stringify(deductionValues(after));
  if (oldValues === newValues) return;
  run('INSERT INTO payslip_deduction_history(record_id,before_values,after_values,changed_by,changed_by_name,reason,created_at) VALUES(?,?,?,?,?,?,?)', recordId, oldValues, newValues, actor.id, actor.full_name, reason?.trim() || null, now().toISOString());
}
export function deductionHistory(recordId: number) {
  return queryAll<{before_values:string;after_values:string}>('SELECT * FROM payslip_deduction_history WHERE record_id=? ORDER BY id DESC', recordId)
    .map(row => ({ ...row, before_values: JSON.parse(row.before_values), after_values: JSON.parse(row.after_values) }));
}
