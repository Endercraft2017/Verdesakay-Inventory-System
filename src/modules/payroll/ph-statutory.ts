/**
 * Philippine statutory payroll math — SSS, PhilHealth, Pag-IBIG contributions and
 * BIR withholding tax on compensation. Pure and DB-free (like hr-payroll-compute.ts):
 * the caller loads the effective rate tables (src/payroll-tables.ts) and passes them in,
 * so this stays independently unit-testable.
 *
 * Rates are NOT hard-coded as law here — they live in `payroll_tables` (versioned by
 * effective date, admin-editable). The constants below are only the seed for 2026 and a
 * fallback. **Verify against the current SSS circular / BIR RMC every January.**
 *
 * Figures & method: see docs/PH-PAYROLL-COMPLIANCE.md.
 */

export type PayFrequency = 'monthly' | 'semi_monthly' | 'weekly' | 'daily' | 'annual';

export interface SssParams {
  /** Employee share of the Monthly Salary Credit (0.05 in 2026). */
  employee_share: number;
  /** Employer share of the MSC (0.10 in 2026). WISP above the regular cap uses the same split. */
  employer_share: number;
  msc_min: number;
  msc_max: number;
  msc_step: number;
  /** Employer-only Employees' Compensation premium for MSC at/above `ec_low_msc_max` + step. */
  ec_employer: number;
  ec_employer_low: number;
  /** MSC at or below this pays the low EC. */
  ec_low_msc_max: number;
}

export interface PhilHealthParams {
  premium_rate: number;   // 0.05 in 2026
  employee_ratio: number; // 0.5 — half employee, half employer
  floor: number;          // 10_000
  ceiling: number;        // 100_000
}

export interface PagIbigParams {
  employee_rate: number;      // 0.02
  employer_rate: number;      // 0.02
  employee_rate_low: number;  // 0.01 for monthly comp at/below `low_threshold`
  low_threshold: number;      // 1_500
  comp_ceiling: number;       // 10_000 — contribution is computed on min(comp, ceiling)
  max_each: number;           // 200 — hard cap per side
}

export interface RwtBracket {
  /** Lower bound of this bracket for the pay period (exclusive). */
  over: number;
  /** Fixed tax at `over`. */
  base: number;
  /** Marginal rate on the amount above `over`. */
  rate: number;
}
export type RwtParams = Partial<Record<PayFrequency, RwtBracket[]>>;

export interface StatutoryTables {
  sss: SssParams;
  philhealth: PhilHealthParams;
  pagibig: PagIbigParams;
  rwt: RwtParams;
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), hi);

/* ---------------------------------------------------------------- SSS --- */

/** The Monthly Salary Credit for a given monthly compensation: clamp to the schedule's
    range, then snap to the nearest bracket (rounding up at the half-step, matching the
    published table where each ₱X,250–X,749.99 band maps to the ₱X,500 MSC). */
export function monthlySalaryCredit(monthlyComp: number, p: SssParams): number {
  const c = clamp(monthlyComp, p.msc_min, p.msc_max);
  const steps = Math.round((c - p.msc_min) / p.msc_step);
  return clamp(p.msc_min + steps * p.msc_step, p.msc_min, p.msc_max);
}

export interface SssResult {
  msc: number;
  employee: number;  // total EE (regular SS + WISP portion — same 5% of MSC)
  employer: number;  // total ER (regular SS + WISP portion — same 10% of MSC)
  ec: number;        // employer-only Employees' Compensation premium
  total: number;     // employee + employer + ec
}

export function sssContribution(monthlyComp: number, p: SssParams): SssResult {
  const msc = monthlySalaryCredit(monthlyComp, p);
  const employee = round2(msc * p.employee_share);
  const employer = round2(msc * p.employer_share);
  const ec = msc <= p.ec_low_msc_max ? p.ec_employer_low : p.ec_employer;
  return { msc, employee, employer, ec, total: round2(employee + employer + ec) };
}

/* --------------------------------------------------------- PhilHealth --- */

export interface SplitResult {
  employee: number;
  employer: number;
  total: number;
}

export function philHealthContribution(monthlyBasic: number, p: PhilHealthParams): SplitResult {
  const base = clamp(monthlyBasic, p.floor, p.ceiling);
  const premium = round2(base * p.premium_rate);
  const employee = round2(premium * p.employee_ratio);
  return { employee, employer: round2(premium - employee), total: premium };
}

/* ------------------------------------------------------------ Pag-IBIG --- */

export function pagIbigContribution(monthlyComp: number, p: PagIbigParams): SplitResult {
  const base = Math.min(Math.max(monthlyComp, 0), p.comp_ceiling);
  const eeRate = monthlyComp <= p.low_threshold ? p.employee_rate_low : p.employee_rate;
  const employee = Math.min(round2(base * eeRate), p.max_each);
  const employer = Math.min(round2(base * p.employer_rate), p.max_each);
  return { employee, employer, total: round2(employee + employer) };
}

/* --------------------------------------------------- Withholding tax --- */

/** Taxable compensation for the period = gross − non-taxable items − the employee's own
    statutory shares (SSS + PhilHealth + Pag-IBIG + union dues). Never below 0. */
export function taxableCompensation(gross: number, nonTaxable: number, employeeStatutory: number): number {
  return Math.max(0, round2(gross - nonTaxable - employeeStatutory));
}

/** BIR withholding tax on compensation for one pay period, using the revised (TRAIN)
    withholding table for `frequency`. Brackets must be sorted ascending by `over`. */
export function withholdingTax(taxableForPeriod: number, frequency: PayFrequency, p: RwtParams): number {
  const brackets = p[frequency];
  if (!brackets || brackets.length === 0) return 0;
  let chosen = brackets[0]!;
  for (const b of brackets) {
    if (taxableForPeriod > b.over) chosen = b;
    else break;
  }
  return round2(chosen.base + (taxableForPeriod - chosen.over) * chosen.rate);
}

/** All three employee-side contributions for a monthly run, plus their sum — the value
    that feeds `taxableCompensation`. */
export function statutoryDeductions(
  monthlyComp: number,
  monthlyBasic: number,
  t: StatutoryTables
): { sss: SssResult; philhealth: SplitResult; pagibig: SplitResult; employee_total: number } {
  const sss = sssContribution(monthlyComp, t.sss);
  const philhealth = philHealthContribution(monthlyBasic, t.philhealth);
  const pagibig = pagIbigContribution(monthlyComp, t.pagibig);
  return {
    sss,
    philhealth,
    pagibig,
    employee_total: round2(sss.employee + philhealth.employee + pagibig.employee),
  };
}

/* ----------------------------------------------- 2026 seed / fallback --- */

export const SSS_2026: SssParams = {
  employee_share: 0.05,
  employer_share: 0.10,
  msc_min: 5_000,
  msc_max: 35_000,
  msc_step: 500,
  ec_employer: 30,
  ec_employer_low: 10,
  ec_low_msc_max: 14_500,
};

export const PHILHEALTH_2026: PhilHealthParams = {
  premium_rate: 0.05,
  employee_ratio: 0.5,
  floor: 10_000,
  ceiling: 100_000,
};

export const PAGIBIG_2026: PagIbigParams = {
  employee_rate: 0.02,
  employer_rate: 0.02,
  employee_rate_low: 0.01,
  low_threshold: 1_500,
  comp_ceiling: 10_000,
  max_each: 200,
};

/** BIR Revised Withholding Tax tables — TRAIN 2nd-phase rates, effective 1 Jan 2023,
    unchanged for 2026. `over` / `base` are per pay period. */
export const RWT_2026: RwtParams = {
  monthly: [
    { over: 0, base: 0, rate: 0 },
    { over: 20_833, base: 0, rate: 0.15 },
    { over: 33_333, base: 1_875, rate: 0.20 },
    { over: 66_667, base: 8_541.80, rate: 0.25 },
    { over: 166_667, base: 33_541.80, rate: 0.30 },
    { over: 666_667, base: 183_541.80, rate: 0.35 },
  ],
  semi_monthly: [
    { over: 0, base: 0, rate: 0 },
    { over: 10_417, base: 0, rate: 0.15 },
    { over: 16_667, base: 937.50, rate: 0.20 },
    { over: 33_333, base: 4_270.70, rate: 0.25 },
    { over: 83_333, base: 16_770.70, rate: 0.30 },
    { over: 333_333, base: 91_770.70, rate: 0.35 },
  ],
  weekly: [
    { over: 0, base: 0, rate: 0 },
    { over: 4_808, base: 0, rate: 0.15 },
    { over: 7_692, base: 432.60, rate: 0.20 },
    { over: 15_385, base: 1_971.20, rate: 0.25 },
    { over: 38_462, base: 7_740.45, rate: 0.30 },
    { over: 153_846, base: 42_355.65, rate: 0.35 },
  ],
  daily: [
    { over: 0, base: 0, rate: 0 },
    { over: 685, base: 0, rate: 0.15 },
    { over: 1_096, base: 61.65, rate: 0.20 },
    { over: 2_192, base: 280.85, rate: 0.25 },
    { over: 5_479, base: 1_102.60, rate: 0.30 },
    { over: 21_918, base: 6_034.30, rate: 0.35 },
  ],
  // Annual graduated income-tax table (TRAIN, 2023 onwards) — used for the BIR 2316
  // year-end "tax due" and payroll annualisation.
  annual: [
    { over: 0, base: 0, rate: 0 },
    { over: 250_000, base: 0, rate: 0.15 },
    { over: 400_000, base: 22_500, rate: 0.20 },
    { over: 800_000, base: 102_500, rate: 0.25 },
    { over: 2_000_000, base: 402_500, rate: 0.30 },
    { over: 8_000_000, base: 2_202_500, rate: 0.35 },
  ],
};

export const STATUTORY_TABLES_2026: StatutoryTables = {
  sss: SSS_2026,
  philhealth: PHILHEALTH_2026,
  pagibig: PAGIBIG_2026,
  rwt: RWT_2026,
};
