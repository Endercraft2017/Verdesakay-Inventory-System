/**
 * Agency monthly contribution schedules (pure): the per-employee collection lists that
 * back the SSS R-3, PhilHealth RF-1 / EPRS, and Pag-IBIG MCRF / eSRS uploads.
 *
 * PH agencies have no public filing API (see docs/PH-PAYROLL-COMPLIANCE.md §3b) — this
 * produces the column-exact CSV the employer converts + validates in each agency's own
 * portal tool.
 */
import {
  sssContribution, philHealthContribution, pagIbigContribution,
  type StatutoryTables,
} from './ph-statutory';

export type Agency = 'sss' | 'philhealth' | 'pagibig';

export interface ContribEmployeeInput {
  name: string;
  /** Agency ID number from the 201 file (SSS / PhilHealth / Pag-IBIG). */
  id_number: string | null;
  /** Total compensation for the month (sum of the month's payslip `total_earnings`). */
  monthly_comp: number;
  /** Basic salary for the month (sum of the month's payslip `basic_salary`). */
  monthly_basic: number;
}

export interface ContribRow {
  name: string;
  id_number: string;
  basis: number;
  employee: number;
  employer: number;
  /** SSS only — the employer-paid EC premium. */
  ec?: number;
  total: number;
}

export interface ContribSchedule {
  agency: Agency;
  month: string;                 // YYYY-MM
  id_label: string;
  headers: string[];
  rows: ContribRow[];
  cells: (string | number)[][];  // header-aligned, ready for CSV
  totals: { employee: number; employer: number; ec: number; grand: number };
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

const ID_LABEL: Record<Agency, string> = {
  sss: 'SSS No.', philhealth: 'PhilHealth No.', pagibig: 'Pag-IBIG MID No.',
};

const HEADERS: Record<Agency, string[]> = {
  sss: ['SSS No.', 'Employee Name', 'Monthly Compensation', 'SS EE', 'SS ER', 'EC ER', 'Total'],
  philhealth: ['PhilHealth No.', 'Employee Name', 'Monthly Basic Salary', 'Personal Share', 'Employer Share', 'Total'],
  pagibig: ['Pag-IBIG MID No.', 'Employee Name', 'Monthly Compensation', 'EE Share', 'ER Share', 'Total'],
};

export function contributionSchedule(
  agency: Agency,
  month: string,
  employees: ContribEmployeeInput[],
  tables: StatutoryTables
): ContribSchedule {
  const rows: ContribRow[] = employees
    .filter((e) => e.monthly_comp > 0 || e.monthly_basic > 0)
    .map((e) => {
      if (agency === 'sss') {
        const r = sssContribution(e.monthly_comp, tables.sss);
        return {
          name: e.name, id_number: e.id_number || '', basis: round2(e.monthly_comp),
          employee: r.employee, employer: r.employer, ec: r.ec,
          total: round2(r.employee + r.employer + r.ec),
        };
      }
      if (agency === 'philhealth') {
        const r = philHealthContribution(e.monthly_basic, tables.philhealth);
        return {
          name: e.name, id_number: e.id_number || '', basis: round2(e.monthly_basic),
          employee: r.employee, employer: r.employer, total: r.total,
        };
      }
      const r = pagIbigContribution(e.monthly_comp, tables.pagibig);
      return {
        name: e.name, id_number: e.id_number || '', basis: round2(e.monthly_comp),
        employee: r.employee, employer: r.employer, total: r.total,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const totals = rows.reduce(
    (t, r) => ({
      employee: round2(t.employee + r.employee),
      employer: round2(t.employer + r.employer),
      ec: round2(t.ec + (r.ec || 0)),
      grand: round2(t.grand + r.total),
    }),
    { employee: 0, employer: 0, ec: 0, grand: 0 }
  );

  const cells: (string | number)[][] = rows.map((r) =>
    agency === 'sss'
      ? [r.id_number, r.name, r.basis, r.employee, r.employer, r.ec ?? 0, r.total]
      : [r.id_number, r.name, r.basis, r.employee, r.employer, r.total]
  );

  return {
    agency, month, id_label: ID_LABEL[agency], headers: HEADERS[agency],
    rows, cells, totals,
  };
}
