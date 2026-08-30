/**
 * Shared DB reads for the statutory / tax reports that draw on the generated
 * `hr_payroll` form records. Used by both `src/routes/hr.routes.ts` (13th-month,
 * final pay) and `src/routes/accounting.routes.ts` (BIR returns, agency schedules) —
 * the tax/deduction filings live under Accounting, the payroll worksheets under HR.
 */
import { queryOne, queryAll, getSetting } from './db';
import type { FormDefinition } from './types';
import type { PayslipYearRow, Bir2316Options } from './ph-2316';

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

/** Generated payslips grouped by employee name, for a calendar year. */
export function yearPayslipRowsByEmployee(year: string): Map<string, PayslipYearRow[]> {
  const out = new Map<string, PayslipYearRow[]>();
  for (const { data } of payslipsInYear(year)) {
    const name = String(data.employee_name ?? '').trim();
    if (!name) continue;
    const list = out.get(name) ?? [];
    list.push(data as PayslipYearRow);
    out.set(name, list);
  }
  return out;
}

/** Per-employee month-total compensation + basic for one YYYY-MM (agency schedules). */
export function payslipTotalsForMonth(month: string): Map<string, { comp: number; basic: number }> {
  const id = payrollFormId();
  const byName = new Map<string, { comp: number; basic: number }>();
  if (id == null) return byName;
  for (const r of queryAll<{ data: string; created_at: string }>(
    'SELECT data, created_at FROM form_records WHERE form_def_id = ?', id
  )) {
    let d: Record<string, unknown>;
    try { d = JSON.parse(r.data); } catch { continue; }
    const payDate = typeof d.pay_date === 'string' && d.pay_date ? d.pay_date : r.created_at;
    if (String(payDate).slice(0, 7) !== month) continue;
    const name = String(d.employee_name ?? '').trim();
    if (!name) continue;
    const cur = byName.get(name) ?? { comp: 0, basic: 0 };
    cur.comp = round2(cur.comp + (Number(d.total_earnings) || 0));
    cur.basic = round2(cur.basic + (Number(d.basic_salary) || 0));
    byName.set(name, cur);
  }
  return byName;
}

/** 12-month withholding aggregation across all employees — the 1601-C / 1604-C schedule. */
export function monthlyWithholdingReport(year: string) {
  const months = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1, employee_count: 0, gross_compensation: 0, non_taxable: 0,
    taxable_compensation: 0, tax_withheld: 0, _names: new Set<string>(),
  }));
  for (const { data: d, pay_date } of payslipsInYear(year)) {
    const mi = Number(pay_date.slice(5, 7)) - 1;
    if (mi < 0 || mi > 11) continue;
    const m = months[mi]!;
    const name = String(d.employee_name ?? '').trim();
    if (name) m._names.add(name);
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
