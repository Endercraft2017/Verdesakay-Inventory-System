/** Who a generated payslip (hr_payroll form record) belongs to — robust to renames.
 *
 *  Payslips historically carry only `employee_name`, frozen at generation time, and every
 *  payroll aggregate (2316, alphalist, 1601-C, 13th month) groups by it. After a rename (an
 *  approved information change, or an HR edit) an employee's old payslips would split off as a
 *  different person. This resolver maps a payslip to its employee by, in order:
 *    1. `data.employee_id` (stamped by generate-payslips from now on),
 *    2. a unique current/former name, only when no employee_id is present.
 *  Reused names are ambiguous; a missing/invalid stamped employee never falls back to a name.
 *  Reads the hr-owned employees / employee_profile_changes tables; no code dependency on hr.
 *  Build one per request/report — it snapshots the tables when created. */
import { queryAll } from '../../shared/db';

export interface PayslipOwnerResolver {
  /** Employee id for this payslip's data, or null if it matches no employee. */
  idOf(data: Record<string, unknown>): number | null;
  /** Current legal name for grouping/display; the name on the payslip if unresolvable. */
  nameOf(data: Record<string, unknown>): string;
  /** Unambiguous names this employee's legacy payslips may carry (current + former). */
  namesFor(employeeId: number): string[];
}

export function payslipOwnerResolver(): PayslipOwnerResolver {
  const idToName = new Map<number, string>();
  const nameOwners = new Map<string, Set<number>>();
  const addName = (name: string, id: number) => {
    const key = name.trim().toLowerCase();
    if (!key) return;
    const owners = nameOwners.get(key) ?? new Set<number>();
    owners.add(id);
    nameOwners.set(key, owners);
  };
  for (const e of queryAll<{ id: number; name: string }>('SELECT id, name FROM employees')) {
    idToName.set(e.id, e.name);
    addName(e.name, e.id);
  }
  // All claimants count: a current name cannot establish ownership of an older payslip.
  const formerById = new Map<number, string[]>();
  for (const r of queryAll<{ employee_id: number; old_value: string }>(
    `SELECT employee_id, old_value FROM employee_profile_changes
     WHERE field = 'name' AND old_value IS NOT NULL ORDER BY id`
  )) {
    addName(r.old_value, r.employee_id);
    formerById.set(r.employee_id, [...(formerById.get(r.employee_id) ?? []), r.old_value]);
  }

  const idOf = (data: Record<string, unknown>): number | null => {
    if (data.employee_id != null) {
      const value = data.employee_id;
      const stamped = typeof value === 'number' ? value
        : typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
      return Number.isSafeInteger(stamped) && stamped > 0 && idToName.has(stamped) ? stamped : null;
    }
    const key = String(data.employee_name ?? '').trim().toLowerCase();
    if (!key) return null;
    const owners = nameOwners.get(key);
    if (!owners || owners.size !== 1) return null;
    const id = owners.values().next().value!;
    return idToName.has(id) ? id : null;
  };
  return {
    idOf,
    nameOf(data) {
      const id = idOf(data);
      return id != null ? idToName.get(id)! : String(data.employee_name ?? '').trim();
    },
    namesFor(employeeId) {
      const current = idToName.get(employeeId);
      return [...new Set([...(current ? [current] : []), ...(formerById.get(employeeId) ?? [])])]
        .filter(name => idOf({ employee_name: name }) === employeeId);
    },
  };
}
