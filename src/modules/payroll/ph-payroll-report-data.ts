/**
 * Shared DB reads for the statutory / tax reports that draw on the generated
 * `hr_payroll` form records. Used by both `src/routes/hr.routes.ts` (13th-month,
 * final pay) and `src/routes/accounting.routes.ts` (BIR returns, agency schedules) —
 * the tax/deduction filings live under Accounting, the payroll worksheets under HR.
 */
import { queryOne, queryAll, getSetting } from '../../shared/db';
import type { PayslipYearRow, Bir2316Options } from './ph-2316';
import { payslipOwnerResolver } from './payslip-owner';
import { sssCompensation, pagIbigCompensation } from './ph-statutory';

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

function payrollFormId(): number | null {
  return queryOne<{ id: number }>("SELECT id FROM form_definitions WHERE slug = 'hr_payroll'")?.id ?? null;
}

interface RawRecord { employee_id: number; data: Record<string, unknown>; pay_date: string; cutoff_end: string }

/** Never return guessed/partial financial reports. Errors expose record IDs, not payroll PII. */
class PayrollReportIdentityError extends Error {
  readonly status = 409;
  constructor(ids: number[]) {
    super(`Payroll report blocked: ${ids.length} payslip(s) need review. Record IDs: ${ids.slice(0, 10).join(', ')}${ids.length > 10 ? ', …' : ''}. A payroll manager must resolve ownership, unreadable data or ambiguous cutoff labels before retrying.`);
    this.name = 'PayrollReportIdentityError';
  }
}

/** One row per form record; never join on a non-unique cutoff label and multiply money.
 * Invalid payloads/dates whose scope cannot be established block conservatively. */
function reportPayslips(scope: string, byCutoff = false): RawRecord[] {
  const id = payrollFormId();
  if (id == null) return [];
  const owner = payslipOwnerResolver();
  const cutoffs = new Map<string, string[]>();
  if (byCutoff) for (const p of queryAll<{label: string; end_date: string}>('SELECT label, end_date FROM attendance_periods')) {
    cutoffs.set(p.label, [...(cutoffs.get(p.label) ?? []), p.end_date]);
  }
  const out: RawRecord[] = [], blocked: number[] = [];
  for (const r of queryAll<{id: number; data: string; created_at: string; period: string | null}>(
    'SELECT id, data, created_at, period FROM form_records WHERE form_def_id = ? ORDER BY id', id
  )) {
    let d: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(r.data);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid payroll object');
      d = parsed as Record<string, unknown>;
    } catch { blocked.push(r.id); continue; }
    const payDate = typeof d.pay_date === 'string' && d.pay_date ? d.pay_date : r.created_at;
    const dates = byCutoff && r.period ? cutoffs.get(r.period) ?? [] : [];
    // Duplicate labels cannot establish which cutoff owns the record. Block any possible
    // contribution month, even if duplicate cutoffs happen to have the same end date.
    if (dates.length > 1) {
      if (dates.some(date => !/^\d{4}-(0[1-9]|1[0-2])-/.test(date) || date.slice(0, 7) === scope)) blocked.push(r.id);
      continue;
    }
    const cutoffEnd = dates[0] ?? payDate;
    const date = byCutoff ? cutoffEnd : payDate;
    if (!/^\d{4}-(0[1-9]|1[0-2])-/.test(date)) { blocked.push(r.id); continue; }
    if (date.slice(0, scope.length) !== scope) continue;
    // Legacy names are strings, never objects whose string conversion can fail.
    // A valid authoritative stamp needs no display-name conversion at all.
    if (d.employee_id == null && typeof d.employee_name !== 'string') { blocked.push(r.id); continue; }
    const employee_id = owner.idOf(d);
    if (employee_id == null) { blocked.push(r.id); continue; }
    out.push({employee_id, data: d, pay_date: payDate, cutoff_end: cutoffEnd});
  }
  if (blocked.length) throw new PayrollReportIdentityError(blocked);
  return out;
}

/** Generated payslips grouped by stable employee ID, for a calendar pay year. */
export function yearPayslipRowsByEmployee(year: string): Map<number, PayslipYearRow[]> {
  const out = new Map<number, PayslipYearRow[]>();
  for (const {employee_id, data} of reportPayslips(year)) {
    const list = out.get(employee_id) ?? [];
    list.push(data as PayslipYearRow);
    out.set(employee_id, list);
  }
  return out;
}

/** Per-employee contribution bases for one contribution month YYYY-MM (agency schedules).
 *  A payslip counts toward the month its cutoff ENDS in (SSS IRR — see statutory-month.ts), not
 *  its pay date; a payslip whose period label matches no cutoff (e.g. CSV-imported) falls back
 *  to its pay date. Bases per fund (ph-statutory.ts "Contribution bases"):
 *    sss        Σ actual remuneration (earnings less late/undertime deductions)
 *    pagibig    Σ actual basic pay (that, less OT / night diff / premiums)
 *    philhealth the fixed monthly basic salary generation recorded on the month's last payslip
 *               (`statutory_basis`); payslips generated before that existed fall back to Σ
 *               basic_salary.
 *  An employee on the fixed contribution basis (statutory_basis.basis 'fixed' on the month's last
 *  payslip) is remitted on the fixed monthly figures that payslip recorded instead of the sums. */
export function contributionBasesForMonth(
  month: string
): Map<number, { sss: number; pagibig: number; philhealth: number }> {
  const byEmployee = new Map<number, {
    sss: number; pagibig: number; philhealth: number; legacyBasic: number; phEnd: string;
    fixed: { sss: number; pagibig: number } | null;
  }>();
  for (const {employee_id, data: d, cutoff_end: cutoffEnd} of reportPayslips(month, true)) {
    const cur = byEmployee.get(employee_id) ?? { sss: 0, pagibig: 0, philhealth: 0, legacyBasic: 0, phEnd: '', fixed: null };
    cur.sss = round2(cur.sss + sssCompensation(d));
    cur.pagibig = round2(cur.pagibig + pagIbigCompensation(d));
    cur.legacyBasic = round2(cur.legacyBasic + (Number(d.basic_salary) || 0));
    const basis = d.statutory_basis as Record<string, unknown> | undefined;
    const mbs = Number(basis?.philhealth_monthly_basic);
    if (mbs > 0 && cutoffEnd >= cur.phEnd) {
      cur.philhealth = round2(mbs); cur.phEnd = cutoffEnd;
      cur.fixed = basis?.basis === 'fixed'
        ? { sss: Number(basis.sss_compensation) || 0, pagibig: Number(basis.pagibig_compensation) || 0 }
        : null;
    }
    byEmployee.set(employee_id, cur);
  }
  return new Map([...byEmployee].map(([employee_id, v]) => [
    employee_id, {
      sss: v.fixed ? v.fixed.sss : v.sss,
      pagibig: v.fixed ? v.fixed.pagibig : v.pagibig,
      philhealth: v.phEnd ? v.philhealth : v.legacyBasic,
    },
  ]));
}

/** 12-month withholding aggregation across all employees — the 1601-C / 1604-C schedule. */
export function monthlyWithholdingReport(year: string) {
  const months = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1, employee_count: 0, gross_compensation: 0, non_taxable: 0,
    taxable_compensation: 0, tax_withheld: 0, _employees: new Set<number>(),
  }));
  for (const {employee_id, data: d, pay_date} of reportPayslips(year)) {
    const mi = Number(pay_date.slice(5, 7)) - 1;
    if (mi < 0 || mi > 11) continue;
    const m = months[mi]!;
    m._employees.add(employee_id);
    const gross = Number(d.total_earnings) || 0;
    const stat = (Number(d.sss) || 0) + (Number(d.philhealth) || 0) + (Number(d.pagibig) || 0);
    m.gross_compensation = round2(m.gross_compensation + gross);
    m.non_taxable = round2(m.non_taxable + stat);
    m.taxable_compensation = round2(m.taxable_compensation + Math.max(0, gross - stat));
    m.tax_withheld = round2(m.tax_withheld + (Number(d.withholding_tax) || 0));
  }
  const monthsOut = months.map((m) => ({
    month: m.month, employee_count: m._employees.size,
    gross_compensation: m.gross_compensation, non_taxable: m.non_taxable,
    taxable_compensation: m.taxable_compensation, tax_withheld: m.tax_withheld,
  }));
  const totals = monthsOut.reduce(
    (t, m) => ({
      gross_compensation: round2(t.gross_compensation + m.gross_compensation),
      non_taxable: round2(t.non_taxable + m.non_taxable),
      taxable_compensation: round2(t.taxable_compensation + m.taxable_compensation),
      tax_withheld: round2(t.tax_withheld + m.tax_withheld),
    }),
    { gross_compensation: 0, non_taxable: 0, taxable_compensation: 0, tax_withheld: 0 }
  );
  return { months: monthsOut, totals };
}

/** BIR 2316 knobs that payslips don't carry — supplied as query params. */
export function optsFromQuery(q: Record<string, unknown>): Bir2316Options {
  const n = (v: unknown): number | undefined => {
    const x = Number(v);
    return Number.isFinite(x) && x !== 0 ? x : undefined;
  };
  return {
    de_minimis: n(q.de_minimis),
    taxable_previous: n(q.taxable_previous),
    tax_withheld_previous: n(q.tax_withheld_previous),
    thirteenth_month_ceiling: n(q.thirteenth_month_ceiling),
  };
}

export function companyProfile(): Record<string, unknown> {
  return getSetting<Record<string, unknown>>('company_profile') || {};
}
