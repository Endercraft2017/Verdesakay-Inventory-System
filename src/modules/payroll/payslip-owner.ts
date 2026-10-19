/** Who a generated payslip (hr_payroll form record) belongs to — robust to renames.
 *
 *  Payslips historically carry only `employee_name`, frozen at generation time, and every
 *  payroll aggregate (2316, alphalist, 1601-C, 13th month) groups by it. After a rename (an
 *  approved information change, or an HR edit) an employee's old payslips would split off as a
 *  different person. This resolver maps a payslip to its employee by, in order:
 *    1. `data.employee_id` (stamped by generate-payslips from now on),
 *    2. a name used by exactly one employee, current or former.
 *  A reused or shared name cannot safely identify an unstamped legacy payslip.
 *  Reads the hr-owned employees / employee_profile_changes tables; no code dependency on hr.
 *  Build one per request/report — it snapshots the tables when created. */
import { queryAll } from '../../shared/db';

export interface PayslipOwnerResolver {
  /** Employee id for this payslip's data, or null if it matches no employee. */
  idOf(data: Record<string, unknown>): number | null;
  /** Current legal name for grouping/display; the name on the payslip if unresolvable. */
  nameOf(data: Record<string, unknown>): string;
  /** Stable grouping key; unresolved legacy slips never merge into a known employee. */
  keyOf(data: Record<string, unknown>): string;
  /** Every name this employee's payslips may carry (current + former). */
  namesFor(employeeId: number): string[];
}

export function payslipOwnerResolver(): PayslipOwnerResolver {
  const idToName = new Map<number, string>();
  const nameToIds = new Map<string, Set<number>>();
  const remember = (name: string, id: number) => {
    const key = name.trim().toLowerCase();
    if (!key) return;
    const ids = nameToIds.get(key) ?? new Set<number>();
    ids.add(id);
    nameToIds.set(key, ids);
  };
  for (const e of queryAll<{ id: number; name: string }>('SELECT id, name FROM employees')) {
    idToName.set(e.id, e.name);
    remember(e.name, e.id);
  }
  // A former name that another employee has used is ambiguous, even if someone holds it now.
  const formerById = new Map<number, string[]>();
  for (const r of queryAll<{ employee_id: number; old_value: string }>(
    `SELECT employee_id, old_value FROM employee_profile_changes
     WHERE field = 'name' AND old_value IS NOT NULL ORDER BY id`
  )) {
    remember(r.old_value, r.employee_id);
    formerById.set(r.employee_id, [...(formerById.get(r.employee_id) ?? []), r.old_value]);
  }

  const idOf = (data: Record<string, unknown>): number | null => {
    const stamped = Number(data.employee_id);
    if (Number.isInteger(stamped) && idToName.has(stamped)) return stamped;
    const key = String(data.employee_name ?? '').trim().toLowerCase();
    if (!key) return null;
    const matches = nameToIds.get(key);
    return matches?.size === 1 ? [...matches][0]! : null;
  };
  return {
    idOf,
    keyOf(data) {
      const id = idOf(data);
      return id != null ? `employee:${id}` : `legacy:${String(data.employee_name ?? '').trim().toLowerCase()}`;
    },
    nameOf(data) {
      const id = idOf(data);
      return id != null ? idToName.get(id)! : String(data.employee_name ?? '').trim();
    },
    namesFor(employeeId) {
      const current = idToName.get(employeeId);
      return [...new Set([...(current ? [current] : []), ...(formerById.get(employeeId) ?? [])])];
    },
  };
}
