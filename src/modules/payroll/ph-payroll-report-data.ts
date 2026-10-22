/**
 * Shared DB reads for the statutory / tax reports that draw on the generated
 * `hr_payroll` form records. Used by both `src/routes/hr.routes.ts` (13th-month,
 * final pay) and `src/routes/accounting.routes.ts` (BIR returns, agency schedules) —
 * the tax/deduction filings live under Accounting, the payroll worksheets under HR.
 */
import { queryOne, queryAll, getSetting } from '../../shared/db';
import type { FormDefinition } from '../../shared/types';
import type { PayslipYearRow, Bir2316Options } from './ph-2316';
import { payslipOwnerResolver } from './payslip-owner';
import { sssCompensation, pagIbigCompensation } from './ph-statutory';

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

function payrollFormId(): number | null {
  return queryOne<{ id: number }>("SELECT id FROM form_definitions WHERE slug = 'hr_payroll'")?.id ?? null;
}

interface RawRecord { data: Record<string, unknown>; pay_date: string }

/** Every generated payslip whose pay-date (falling back to created_at) is in `year`. */
function payslipsInYear(year: string): RawRecord[] {
  const id = payrollFormId();
  if (id == null) return [];
  const out: RawRecord[] = [];
  for (const r of queryAll<{ data: string; created_at: string }>(
    'SELECT data, created_at FROM form_records WHERE form_def_id = ?', id
  )) {
    let d: Record<string, unknown>;
    try { d = JSON.parse(r.data); } catch { continue; }
    const payDate = typeof d.pay_date === 'string' && d.pay_date ? d.pay_date : r.created_at;
    if (String(payDate).slice(0, 4) !== year) continue;
    out.push({ data: d, pay_date: String(payDate) });
  }
  return out;
}

/** Generated payslips grouped by identity, so employees sharing a name remain separate. */
export interface PayslipYearGroup { employee_id: number | null; employee_name: string; rows: PayslipYearRow[] }
export function yearPayslipRowsByEmployee(year: string): Map<string, PayslipYearGroup> {
  const out = new Map<string, PayslipYearGroup>();
  const owner = payslipOwnerResolver(); // renamed employees stay one person (payslip-owner.ts)
  for (const { data } of payslipsInYear(year)) {
    const name = owner.nameOf(data);
    if (!name) continue;
    const key = owner.keyOf(data);
    const group = out.get(key) ?? { employee_id: owner.idOf(data), employee_name: name, rows: [] };
    group.rows.push(data as PayslipYearRow);
    out.set(key, group);
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
): Map<string, { employee_id: number | null; employee_name: string; sss: number; pagibig: number; philhealth: number }> {
  const id = payrollFormId();
  const byOwner = new Map<string, {
    employee_id: number | null; employee_name: string;
    sss: number; pagibig: number; philhealth: number; legacyBasic: number; phEnd: string;
    fixed: { sss: number; pagibig: number } | null;
  }>();
  if (id == null) return new Map();
  const owner = payslipOwnerResolver();
  for (const r of queryAll<{ data: string; created_at: string; end_date: string | null }>(
    `SELECT fr.data, fr.created_at, ap.end_date
       FROM form_records fr LEFT JOIN attendance_periods ap ON ap.label = fr.period
      WHERE fr.form_def_id = ?`, id
  )) {
    let d: Record<string, unknown>;
    try { d = JSON.parse(r.data); } catch { continue; }
    const payDate = typeof d.pay_date === 'string' && d.pay_date ? d.pay_date : r.created_at;
    const cutoffEnd = r.end_date ?? String(payDate);
    if (cutoffEnd.slice(0, 7) !== month) continue;
    const name = owner.nameOf(d);
    if (!name) continue;
    const key = owner.keyOf(d);
    const cur = byOwner.get(key) ?? { employee_id: owner.idOf(d), employee_name: name, sss: 0, pagibig: 0, philhealth: 0, legacyBasic: 0, phEnd: '', fixed: null };
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
    byOwner.set(key, cur);
  }
  return new Map([...byOwner].map(([key, v]) => [
    key, {
      employee_id: v.employee_id, employee_name: v.employee_name,
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
    taxable_compensation: 0, tax_withheld: 0, _names: new Set<string>(),
  }));
  const owner = payslipOwnerResolver();
  for (const { data: d, pay_date } of payslipsInYear(year)) {
    const mi = Number(pay_date.slice(5, 7)) - 1;
    if (mi < 0 || mi > 11) continue;
    const m = months[mi]!;
    const name = owner.nameOf(d);
    if (name) m._names.add(owner.keyOf(d));
    const gross = Number(d.total_earnings) || 0;
    const stat = (Number(d.sss) || 0) + (Number(d.philhealth) || 0) + (Number(d.pagibig) || 0);
    m.gross_compensation = round2(m.gross_compensation + gross);
    m.non_taxable = round2(m.non_taxable + stat);
    m.taxable_compensation = round2(m.taxable_compensation + Math.max(0, gross - stat));
    m.tax_withheld = round2(m.tax_withheld + (Number(d.withholding_tax) || 0));
  }
  const monthsOut = months.map((m) => ({
    month: m.month, employee_count: m._names.size,
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
