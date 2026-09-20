/** Pure module (no DB access, same separation as hr-payroll-compute.ts / hr-payroll-import.ts):
    turns a policy + the set of employee_no values already in use into a single RECOMMENDED next
    number. It never mutates anything and is never the source of truth for uniqueness — the
    caller (route handler) still enforces that employee_no is unique at save time, since the
    field itself is freely editable and this is only ever a suggestion. */
import type { EmployeeNumberPolicy } from '../../shared/types';

function formatHireDate(isoDate: string, fmt: EmployeeNumberPolicy['date_format']): string {
  const [y = '', m = '', d = ''] = isoDate.split('-');
  return fmt === 'YYMMDD' ? `${y.slice(2)}${m}${d}` : `${y}${m}${d}`;
}

/** Highest existing N found among `numbers` that start with `base` and end in a plain integer,
    e.g. base="EMP-", "EMP-00007" -> 7. Returns 0 if none match. */
function maxSuffixNumber(numbers: string[], base: string): number {
  let max = 0;
  for (const n of numbers) {
    if (!n.startsWith(base)) continue;
    const tail = n.slice(base.length);
    if (!/^\d+$/.test(tail)) continue;
    const val = parseInt(tail, 10);
    if (val > max) max = val;
  }
  return max;
}

export function suggestEmployeeNumber(
  existingNumbers: string[],
  policy: EmployeeNumberPolicy,
  referenceDate: string // 'YYYY-MM-DD' — the new hire's start date, or today if not yet set
): string {
  const pad = Math.max(1, Math.min(8, policy.pad || 5));
  if (policy.mode === 'hire_date') {
    const base = `${policy.prefix}${formatHireDate(referenceDate, policy.date_format)}-`;
    const next = maxSuffixNumber(existingNumbers, base) + 1;
    return `${base}${String(next).padStart(pad, '0')}`;
  }
  const base = policy.prefix ? `${policy.prefix}-` : '';
  const next = maxSuffixNumber(existingNumbers, base) + 1;
  return `${base}${String(next).padStart(pad, '0')}`;
}
