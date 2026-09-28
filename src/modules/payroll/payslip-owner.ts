/** Who a generated payslip (hr_payroll form record) belongs to — robust to renames.
 *
 *  Payslips historically carry only `employee_name`, frozen at generation time, and every
 *  payroll aggregate (2316, alphalist, 1601-C, 13th month) groups by it. After a rename (an
 *  approved information change, or an HR edit) an employee's old payslips would split off as a
 *  different person. This resolver maps a payslip to its employee by, in order:
 *    1. `data.employee_id` (stamped by generate-payslips from now on),
 *    2. the current employees.name,
 *    3. a former name recorded in employee_profile_changes (field 'name').
 *  Reads the hr-owned employees / employee_profile_changes tables; no code dependency on hr.
 *  Build one per request/report — it snapshots the tables when created. */
import { queryAll } from '../../shared/db';

export interface PayslipOwnerResolver {
  /** Employee id for this payslip's data, or null if it matches no employee. */
  idOf(data: Record<string, unknown>): number | null;
  /** Current legal name for grouping/display; the name on the payslip if unresolvable. */
  nameOf(data: Record<string, unknown>): string;
  /** Every name this employee's payslips may carry (current + former). */
  namesFor(employeeId: number): string[];
}

export function payslipOwnerResolver(): PayslipOwnerResolver {
  const idToName = new Map<number, string>();
  const nameToId = new Map<string, number>();
  for (const e of queryAll<{ id: number; name: string }>('SELECT id, name FROM employees')) {
    idToName.set(e.id, e.name);
    nameToId.set(e.name.trim().toLowerCase(), e.id);
  }
  // Former names. A current name always wins over someone else's former name.
  const aliasToId = new Map<string, number>();
  const formerById = new Map<number, string[]>();
  for (const r of queryAll<{ employee_id: number; old_value: string }>(
    `SELECT employee_id, old_value FROM employee_profile_changes
     WHERE field = 'name' AND old_value IS NOT NULL ORDER BY id`
  )) {
    const key = r.old_value.trim().toLowerCase();
    if (!nameToId.has(key)) aliasToId.set(key, r.employee_id);
    formerById.set(r.employee_id, [...(formerById.get(r.employee_id) ?? []), r.old_value]);
  }

  const idOf = (data: Record<string, unknown>): number | null => {
    const stamped = Number(data.employee_id);
    if (Number.isInteger(stamped) && idToName.has(stamped)) return stamped;
    const key = String(data.employee_name ?? '').trim().toLowerCase();
    if (!key) return null;
    return nameToId.get(key) ?? aliasToId.get(key) ?? null;
  };
  return {
    idOf,
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
