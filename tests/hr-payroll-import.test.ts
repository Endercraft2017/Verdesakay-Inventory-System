/** parsePayrollSummaryCsv: one row per employee (occasionally two, for a mid-cutoff rate
    change), grouped under department-header rows, with a title-cell payroll period.

    Rows are built as 45-column arrays (matching the real sheet's exact column count —
    3 identity cols + 15 daily-attendance cols + 27 summary cols) rather than hand-typed
    comma strings, so column *position* — which is what the parser keys off — can't drift
    out of sync with the fixed offsets in src/hr-payroll-import.ts. */
import { describe, it, expect } from 'vitest';
import { parseCsvRows, parsePayrollSummaryCsv } from '../src/hr-payroll-import';

const COLS = 45;
const COL = {
  no: 0, name: 1, nickname: 2, totalDaysWork: 19, regHoliday: 20, dailyRate: 23,
  hourlyRate: 24, otHours: 26, otPay: 27, lateUndertimePay: 29, specialHoliday30: 32,
  rsd30: 34, sss: 37, hdmf: 38, phic: 39, tax: 40,
};

function toCsvField(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Build one 45-column row; `set` maps column index -> value, everything else blank. */
function row(set: Record<number, string | number>): string {
  const cells = new Array(COLS).fill('');
  for (const [i, v] of Object.entries(set)) cells[Number(i)] = String(v);
  return cells.map(toCsvField).join(',');
}

function deptHeader(name: string): string {
  return row({ [COL.no]: name });
}

const SUMMARY_CSV = [
  'June 16-30  2026,,,16-Jun,17-Jun,SUMMARY JUNE 01 -15 2026', // title row (only col 0 matters)
  row({
    [COL.no]: 'No.', [COL.name]: 'Employee Name', [COL.nickname]: 'BIO / Nickname',
    18: 'Total Work Hrs', [COL.totalDaysWork]: 'Total Days Work', [COL.regHoliday]: 'Reg Holiday',
    [COL.dailyRate]: 'Daily Rate', [COL.hourlyRate]: 'Hourly Rate',
    [COL.otHours]: 'REG OT (Hrs)', [COL.otPay]: 'Reg OT 25%',
    [COL.lateUndertimePay]: 'Late/ Undertime', [COL.specialHoliday30]: 'Special Holiday 30%',
    [COL.rsd30]: 'RSD 30%', [COL.sss]: 'SSS', [COL.hdmf]: 'HDMF', [COL.phic]: 'PHIC', [COL.tax]: 'TAX',
  }),
  deptHeader('HR ADMIN / FINANCE'),
  row({
    [COL.no]: 1, [COL.name]: 'Dela Cruz, Juan', [COL.nickname]: 'Juan',
    [COL.totalDaysWork]: 13, [COL.dailyRate]: 600, [COL.hourlyRate]: 75,
    [COL.otHours]: 0, [COL.otPay]: 0, [COL.lateUndertimePay]: 3.3,
  }),
  deptHeader('PRODUCTION'),
  row({
    [COL.no]: 2, [COL.name]: 'Santos, Maria', [COL.nickname]: 'Maria',
    [COL.totalDaysWork]: 8, [COL.regHoliday]: 1, [COL.dailyRate]: 650, [COL.hourlyRate]: 81.25,
    [COL.otHours]: 4, [COL.otPay]: 325, [COL.specialHoliday30]: 195, [COL.rsd30]: 50,
    [COL.sss]: 10, [COL.hdmf]: 20, [COL.phic]: 15, [COL.tax]: 45,
  }),
  // Mid-cutoff rate change: no No./Name of its own, continues the same employee.
  row({ [COL.nickname]: 'Maria', [COL.totalDaysWork]: 9, [COL.dailyRate]: 700, [COL.hourlyRate]: 87.5 }),
  row({}), // blank spacer row
  // Footer row: "Prepared by:" happens to land at the Total Days Work column position.
  row({ [COL.totalDaysWork]: 'Prepared by:', [COL.regHoliday]: 'Rowverta Buenaobra' }),
].join('\n');

describe('parseCsvRows', () => {
  it('handles quoted fields with embedded commas', () => {
    const rows = parseCsvRows('a,"b, c",d\n1,2,3');
    expect(rows[0]).toEqual(['a', 'b, c', 'd']);
    expect(rows[1]).toEqual(['1', '2', '3']);
  });
});

describe('parsePayrollSummaryCsv', () => {
  const slips = parsePayrollSummaryCsv(SUMMARY_CSV, { payDate: '2026-07-05' });

  it('extracts one record per employee row, tagging the department from the header above it', () => {
    expect(slips).toHaveLength(3); // Dela Cruz + Santos (2 rows: rate change mid-cutoff)
    expect(slips[0]!.employee_name).toBe('Dela Cruz, Juan');
    expect(slips[0]!.dept_position).toBe('HR ADMIN / FINANCE');
    expect(slips[1]!.dept_position).toBe('PRODUCTION');
    expect(slips[2]!.dept_position).toBe('PRODUCTION');
  });

  it('carries the payroll period from the title cell and the pay date from options', () => {
    for (const s of slips) {
      expect(s.payroll_period).toBe('June 16-30 2026');
      expect(s.pay_date).toBe('2026-07-05');
    }
  });

  it('computes basic salary and total earnings as a clean sum (not net of late deductions)', () => {
    const s = slips[0]!;
    expect(s.daily_rate).toBe(600);
    expect(s.days_worked).toBe(13);
    expect(s.basic_salary).toBe(7800); // 600 * 13
    expect(s.overtime_pay).toBe(0);
    expect(s.holiday_pay).toBe(0); // no Reg Holiday days this cutoff
    expect(s.total_earnings).toBe(7800);
    expect(s.late_absences).toBe(3.3);
    expect(s.total_deductions).toBe(3.3);
  });

  it('computes OT rate/hour as 1.25x the hourly rate and holiday pay as rate x holiday days', () => {
    const s = slips[1]!;
    expect(s.ot_rate_hour).toBeCloseTo(81.25 * 1.25);
    expect(s.holiday_pay).toBe(650); // 1 reg holiday day * daily rate
    expect(s.special_holiday_30).toBe(195);
    expect(s.rest_day_ot).toBe(50);
    expect(s.total_earnings).toBe(650 * 8 + 325 + 650 + 195 + 50); // basic_salary + OT + holiday + special-hol + rest-day
    expect(s.sss).toBe(10);
    expect(s.pagibig).toBe(20);
    expect(s.philhealth).toBe(15);
    expect(s.total_deductions).toBe(10 + 20 + 15 + 45); // sss + pagibig + philhealth + tax (0 late)
  });

  it('splits a mid-cutoff rate change into a second record inheriting the employee name', () => {
    const s = slips[2]!;
    expect(s.employee_name).toBe('Santos, Maria');
    expect(s.daily_rate).toBe(700);
    expect(s.days_worked).toBe(9);
    expect(s.basic_salary).toBe(6300);
  });

  it('does not mistake footer rows (label text landing in the days-worked column) for records', () => {
    expect(slips.some((s) => s.employee_name.includes('Prepared'))).toBe(false);
  });

  it('returns an empty array for an empty file', () => {
    expect(parsePayrollSummaryCsv('')).toEqual([]);
  });
});
