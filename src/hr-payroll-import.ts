/**
 * Parses the payroll "Summary" CSV export — one row per employee (occasionally two,
 * when a mid-cutoff rate change splits a row), grouped under department header rows,
 * with a title cell that carries the payroll period. Pure, dependency-free: easy to
 * unit test in isolation.
 */

/** Minimal RFC4180-ish CSV parser: quoted fields, "" escapes, embedded commas. */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r') {
      // skip
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function cell(row: string[] | undefined, c: number): string {
  return (row?.[c] ?? '').trim();
}

function toNum(v: string): number {
  const n = parseFloat(v.replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// Fixed column indices in the Summary sheet (see docs/ARCHITECTURE.md for the full map).
const COL = {
  no: 0, name: 1, totalDaysWork: 19, regHoliday: 20, dailyRate: 23, hourlyRate: 24,
  otHours: 26, otPay: 27, lateUndertimePay: 29, specialHoliday30: 32, rsd30: 34,
  sss: 37, hdmf: 38, phic: 39, tax: 40,
} as const;

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
  overtime_pay: number;
  undertime_pay: number;
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
}

/** A row is a department header when its "No." cell holds text and every data cell is blank. */
function isDeptHeader(row: string[] | undefined): boolean {
  const no = cell(row, COL.no);
  if (!no || /^\d+$/.test(no)) return false;
  return !cell(row, COL.name) && !cell(row, COL.totalDaysWork);
}

/** A row is a mid-cutoff continuation of the previous employee (rate change) when it has
    no name/number of its own but does carry a numeric Total Days Work figure — as opposed
    to footer rows ("Prepared by:", "Overall Total:", ...) whose label text can land in the
    same column purely by comma-count coincidence. */
function isContinuationRow(row: string[] | undefined): boolean {
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
  const slips: PayrollSlip[] = [];
  let dept = '';
  let lastEmployeeName = '';

  // Row 0 is the title, row 1 is the header — data starts at row 2.
  for (let r = 2; r < rows.length; r++) {
    const row = rows[r];
    if (isDeptHeader(row)) { dept = cell(row, COL.no); continue; }

    let employeeName = cell(row, COL.name);
    if (employeeName) {
      lastEmployeeName = employeeName;
    } else if (isContinuationRow(row)) {
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
    const basicSalary = dailyRate * daysWorked;
    const totalEarnings = basicSalary + overtimePay + holidayPay + specialHoliday30 + restDayOt;

    const sss = toNum(cell(row, COL.sss));
    const philhealth = toNum(cell(row, COL.phic));
    const pagibig = toNum(cell(row, COL.hdmf));
    const tax = toNum(cell(row, COL.tax));
    const lateAbsences = toNum(cell(row, COL.lateUndertimePay));
    const totalDeductions = sss + philhealth + pagibig + tax + lateAbsences;

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
    });
  }
  return slips;
}
