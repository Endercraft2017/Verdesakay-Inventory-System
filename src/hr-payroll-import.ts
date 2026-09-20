/**
 * Parses the payroll "Summary" CSV export — one row per employee (occasionally two,
 * when a mid-cutoff rate change splits a row), grouped under department header rows,
 * with a title cell that carries the payroll period. Pure, dependency-free: easy to
 * unit test in isolation.
 */
import { parseCsvRows } from './csv';

export { parseCsvRows };

function cell(row: string[] | undefined, c: number): string {
  return (row?.[c] ?? '').trim();
}

function toNum(v: string): number {
  const n = parseFloat(v.replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// Column *positions* in the Summary sheet drift between exports — the sheet has one
// attendance-day column per calendar day in the cutoff, so a 16-day second-half cutoff
// (e.g. any 31-day month's 16th-31st) shifts every column after the day-grid by one place
// relative to a 15-day cutoff, and department heads have also reordered columns outright
// between exports (see docs/reference/backend/hr-payroll-import.md). Fixed indices broke on
// both counts, so columns are now located by matching the header row's own text instead.
type ColKey =
  | 'no' | 'name'
  | 'totalDaysWork' | 'regHoliday' | 'specialHoliday30'
  | 'dailyRate' | 'hourlyRate'
  | 'otHours' | 'otPay'
  | 'lateUndertimePay'
  | 'rsd30'
  | 'basicPay'
  | 'sss' | 'hdmf' | 'phic' | 'tax'
  | 'totalDeductions' | 'totalSalary';

// Exact header text (case/whitespace/punctuation-insensitive — see normalizeHeader) for each
// field. Matched against the whole cell, not a substring, so near-duplicate columns in the
// same sheet (two "Absent" columns; "Special Hol (30%)" — a rate reminder that holds text
// like "30%", not money — vs. the real "Special Holiday 30%" pay column) resolve unambiguously.
const HEADER_NAMES: Record<ColKey, string> = {
  no: 'No.',
  name: 'Employee Name',

  totalDaysWork: 'Total Days Work',
  regHoliday: 'Reg Holiday',
  specialHoliday30: 'Special Holiday 30%',

  dailyRate: 'Daily Rate',
  hourlyRate: 'Hourly Rate',

  otHours: 'REG OT (Hrs)',
  otPay: 'Reg OT 25%',

  lateUndertimePay: 'Late/ Undertime',

  rsd30: 'RSD 30%',

  basicPay: 'BASIC PAY',

  sss: 'SSS',
  hdmf: 'HDMF',
  phic: 'PHIC',
  tax: 'TAX',

  totalDeductions: 'TOTAL DEDUCTIONS',
  totalSalary: 'Total Salary',
};

function normalizeHeader(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

const NORMALIZED_HEADER_NAMES = Object.fromEntries(
  (Object.entries(HEADER_NAMES) as [ColKey, string][]).map(([key, label]) => [key, normalizeHeader(label)])
) as Record<ColKey, string>;

/** Maps each known field to its column index by matching the header row's own text — falls
    back to -1 (read back as '' via `cell()`) for a column the header doesn't have. */
function resolveColumns(headerRow: string[] | undefined): Record<ColKey, number> {
  const indexByName = new Map<string, number>();
  (headerRow ?? []).forEach((raw, i) => {
    const key = normalizeHeader(raw);
    if (key && !indexByName.has(key)) indexByName.set(key, i);
  });

  const cols = {} as Record<ColKey, number>;
  for (const key of Object.keys(HEADER_NAMES) as ColKey[]) {
    cols[key] = indexByName.get(NORMALIZED_HEADER_NAMES[key]) ?? -1;
  }
  return cols;
}

export interface PayrollSlip {
  employee_name: string;
  dept_position: string;
  payroll_period: string;
  pay_date: string;
  daily_rate: number;
  days_worked: number;
  ot_hours: number;
  ot_rate_hour: number;
  basic_salary: number;
  /** Informational breakdown only — already included in basic_salary, not added into
      total_earnings (see the comment above its computation in parsePayrollSummaryCsv). */
  overtime_pay: number;
  undertime_pay: number;
  /** Informational breakdown only — already included in basic_salary, not added into
      total_earnings (see the comment above its computation in parsePayrollSummaryCsv). */
  holiday_pay: number;
  special_holiday_30: number;
  rest_day_ot: number;
  total_earnings: number;
  sss: number;
  philhealth: number;
  pagibig: number;
  cash_advance: number;
  late_absences: number;
  total_deductions: number;
  net_pay: number;
}

/** A row is a department header when its "No." cell holds text and every data cell is blank. */
function isDeptHeader(row: string[] | undefined, COL: Record<ColKey, number>): boolean {
  const no = cell(row, COL.no);
  if (!no || /^\d+$/.test(no)) return false;
  return !cell(row, COL.name) && !cell(row, COL.totalDaysWork);
}

/** A row is a mid-cutoff continuation of the previous employee (rate change) when it has
    no name/number of its own but does carry a numeric Total Days Work figure — as opposed
    to footer rows ("Prepared by:", "Overall Total:", ...) whose label text can land in the
    same column purely by comma-count coincidence. */
function isContinuationRow(row: string[] | undefined, COL: Record<ColKey, number>): boolean {
  if (cell(row, COL.no) || cell(row, COL.name)) return false;
  return /^\d+(\.\d+)?$/.test(cell(row, COL.totalDaysWork));
}

export interface ParsePayrollSummaryOptions {
  /** Applied to every parsed row — the sheet itself doesn't carry a pay date. */
  payDate?: string;
}

/**
 * dataRows: everything from the header row down. Department names come from section-header
 * rows (tracked as we scan); the payroll period comes from the sheet's title cell.
 */
export function parsePayrollSummaryCsv(text: string, opts: ParsePayrollSummaryOptions = {}): PayrollSlip[] {
  const rows = parseCsvRows(text);
  if (!rows.length) return [];

  const payrollPeriod = cell(rows[0], 0).replace(/\s+/g, ' ').trim();
  const payDate = opts.payDate ?? '';
  const COL = resolveColumns(rows[1]);
  const slips: PayrollSlip[] = [];
  let dept = '';
  let lastEmployeeName = '';

  // Row 0 is the title, row 1 is the header — data starts at row 2.
  for (let r = 2; r < rows.length; r++) {
    const row = rows[r];
    if (isDeptHeader(row, COL)) { dept = cell(row, COL.no); continue; }

    let employeeName = cell(row, COL.name);
    if (employeeName) {
      lastEmployeeName = employeeName;
    } else if (isContinuationRow(row, COL)) {
      employeeName = lastEmployeeName;
    } else {
      continue; // blank spacer / footer row (Overall Total, Prepared by, etc.)
    }
    if (!employeeName) continue;

    const dailyRate = toNum(cell(row, COL.dailyRate));
    const hourlyRate = toNum(cell(row, COL.hourlyRate));
    const daysWorked = toNum(cell(row, COL.totalDaysWork));
    const regHolidayDays = toNum(cell(row, COL.regHoliday));
    const overtimePay = toNum(cell(row, COL.otPay));
    const holidayPay = dailyRate * regHolidayDays;
    const specialHoliday30 = toNum(cell(row, COL.specialHoliday30));
    const restDayOt = toNum(cell(row, COL.rsd30));
    const basicSalary = toNum(cell(row, COL.basicPay));

    const sss = toNum(cell(row, COL.sss));
    const philhealth = toNum(cell(row, COL.phic));
    const pagibig = toNum(cell(row, COL.hdmf));
    const tax = toNum(cell(row, COL.tax));
    const lateAbsences = toNum(cell(row, COL.lateUndertimePay));

    // BASIC PAY on the sheet is plain days-worked pay (Total Days Work * Daily Rate, exactly,
    // fractional days included) — it does not include regular-holiday pay, OT, or the
    // Special Holiday 30% premium, which are their own separate columns, so all of them get
    // summed straight into totalEarnings. Nor is it net of the late/undertime deduction —
    // that deduction only ever appears once, in totalDeductions below. Verified directly
    // against a real 59-row Aug 16-31 2026 export (see docs/reference/backend/
    // hr-payroll-import.md's History section for the row-by-row reconciliation): this
    // reconciles total_earnings - total_deductions === the sheet's own Total Salary exactly
    // for every row except a handful the sheet itself hand-overrides to ₱0 for reasons no
    // column here explains.
    const totalEarnings = basicSalary + overtimePay + holidayPay + specialHoliday30 + restDayOt;
    const totalDeductions = sss + philhealth + pagibig + tax + lateAbsences;
    const netPay = toNum(cell(row, COL.totalSalary));

    slips.push({
      employee_name: employeeName,
      dept_position: dept,
      payroll_period: payrollPeriod,
      pay_date: payDate,
      daily_rate: dailyRate,
      days_worked: daysWorked,
      ot_hours: toNum(cell(row, COL.otHours)),
      ot_rate_hour: hourlyRate * 1.25,
      basic_salary: basicSalary,
      overtime_pay: overtimePay,
      undertime_pay: 0,
      holiday_pay: holidayPay,
      special_holiday_30: specialHoliday30,
      rest_day_ot: restDayOt,
      total_earnings: totalEarnings,
      sss,
      philhealth,
      pagibig,
      cash_advance: 0,
      late_absences: lateAbsences,
      total_deductions: totalDeductions,
      net_pay: netPay,
    });
  }
  return slips;
}
