/** parsePayrollSummaryCsv: one row per employee (occasionally two, for a mid-cutoff rate
    change), grouped under department-header rows, with a title-cell payroll period.

    Columns are located by matching the header row's own text (see resolveColumns in
    src/hr-payroll-import.ts), not by fixed position — the sheet's column count shifts with
    the cutoff length (a 16-day second-half cutoff has one more attendance-day column than a
    15-day one) and department heads have reordered columns outright between exports. This
    fixture models a 15-day cutoff (3 identity cols + 15 daily-attendance cols + 27 summary
    cols) with hand-picked numbers to isolate the column-resolution logic; the 'real Aug 16-31
    2026 export' describe block below uses rows copied verbatim from an actual export (pasted
    in full by the user) to verify the total_earnings formula itself against real data. Rows
    are still built via the row()/COL helpers below (rather than hand-typed comma strings)
    purely so the header-row labels and the data-row values they describe can't drift apart
    inside this file. */
import { describe, it, expect } from 'vitest';
import { parseCsvRows, parsePayrollSummaryCsv } from '../src/hr-payroll-import';

const COLS = 46;
const COL = {
  no: 0, name: 1, nickname: 2, totalDaysWork: 19, regHoliday: 20, specialHoliday30: 22,
  dailyRate: 24, hourlyRate: 25, otHours: 27, otPay: 28, lateUndertimePay: 30,
  rsd30: 35, basicPay: 36, sss: 38, hdmf: 39, phic: 40, tax: 41, totalDeductions: 42, totalSalary: 43,
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
    [COL.rsd30]: 'RSD 30%', [COL.basicPay]: 'BASIC PAY',
    [COL.sss]: 'SSS', [COL.hdmf]: 'HDMF', [COL.phic]: 'PHIC', [COL.tax]: 'TAX',
    [COL.totalDeductions]: 'TOTAL DEDUCTIONS', [COL.totalSalary]: 'Total Salary',
  }),
  deptHeader('HR ADMIN / FINANCE'),
  row({
    [COL.no]: 1, [COL.name]: 'Dela Cruz, Juan', [COL.nickname]: 'Juan',
    [COL.totalDaysWork]: 13, [COL.dailyRate]: 600, [COL.hourlyRate]: 75,
    [COL.otHours]: 0, [COL.otPay]: 0, [COL.lateUndertimePay]: 3.3,
    [COL.basicPay]: 7800, [COL.totalDeductions]: 3.3, [COL.totalSalary]: 7796.7,
  }),
  deptHeader('PRODUCTION'),
  row({
    [COL.no]: 2, [COL.name]: 'Santos, Maria', [COL.nickname]: 'Maria',
    [COL.totalDaysWork]: 8, [COL.regHoliday]: 1, [COL.dailyRate]: 650, [COL.hourlyRate]: 81.25,
    [COL.otHours]: 4, [COL.otPay]: 325, [COL.specialHoliday30]: 195, [COL.rsd30]: 50,
    [COL.basicPay]: 5200, [COL.sss]: 10, [COL.hdmf]: 20, [COL.phic]: 15, [COL.tax]: 45,
    [COL.totalDeductions]: 90, [COL.totalSalary]: 6320,
  }),
  // Mid-cutoff rate change: no No./Name of its own, continues the same employee.
  row({ [COL.nickname]: 'Maria', [COL.totalDaysWork]: 9, [COL.dailyRate]: 700, [COL.hourlyRate]: 87.5, [COL.basicPay]: 6300, [COL.totalSalary]: 6300 }),
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

  it('does not add late/undertime back into total earnings — BASIC PAY is plain days-worked pay, not net of it', () => {
    // BASIC PAY is Total Days Work * Daily Rate exactly, with no adjustment for late/
    // undertime — that deduction appears exactly once, in total_deductions. See the
    // total_earnings comment above this computation in src/hr-payroll-import.ts.
    const s = slips[0]!;
    expect(s.daily_rate).toBe(600);
    expect(s.days_worked).toBe(13);
    expect(s.basic_salary).toBe(7800); // 600 * 13, taken as-is from BASIC PAY
    expect(s.overtime_pay).toBe(0);
    expect(s.holiday_pay).toBe(0); // no Reg Holiday days this cutoff
    expect(s.late_absences).toBe(3.3);
    expect(s.total_earnings).toBe(7800); // basic_salary only (no OT/holiday/late this row)
    expect(s.total_deductions).toBe(3.3);
    expect(s.net_pay).toBe(7796.7); // taken as-is from the sheet's own Total Salary column
  });

  it('adds holiday_pay/overtime_pay into total earnings, since BASIC PAY on the sheet excludes them', () => {
    // BASIC PAY is regular-days-worked pay only — Reg Holiday pay and OT are their own
    // separate columns on the sheet, so both get summed into total_earnings alongside
    // special_holiday_30 and rest_day_ot. See src/hr-payroll-import.ts and this doc's History
    // section in docs/reference/backend/hr-payroll-import.md.
    const s = slips[1]!;
    expect(s.ot_rate_hour).toBeCloseTo(81.25 * 1.25);
    expect(s.overtime_pay).toBe(325);
    expect(s.holiday_pay).toBe(650); // 1 reg holiday day * daily rate
    expect(s.special_holiday_30).toBe(195);
    expect(s.rest_day_ot).toBe(50);
    expect(s.total_earnings).toBe(5200 + 325 + 650 + 195 + 50); // basic_salary + OT + holiday + special-hol + rest-day (no late this row)
    expect(s.sss).toBe(10);
    expect(s.pagibig).toBe(20);
    expect(s.philhealth).toBe(15);
    expect(s.total_deductions).toBe(90); // sss + philhealth + pagibig + tax + late(0) — not the sheet's own TOTAL DEDUCTIONS column
    expect(s.net_pay).toBe(6320); // taken as-is from the sheet — this fixture's numbers are hand-picked for column coverage, not reconciled to the peso
  });

  it('splits a mid-cutoff rate change into a second record inheriting the employee name', () => {
    const s = slips[2]!;
    expect(s.employee_name).toBe('Santos, Maria');
    expect(s.daily_rate).toBe(700);
    expect(s.days_worked).toBe(9);
    expect(s.basic_salary).toBe(6300);
    expect(s.net_pay).toBe(6300);
  });

  it('does not mistake footer rows (label text landing in the days-worked column) for records', () => {
    expect(slips.some((s) => s.employee_name.includes('Prepared'))).toBe(false);
  });

  it('returns an empty array for an empty file', () => {
    expect(parsePayrollSummaryCsv('')).toEqual([]);
  });
});

// ─── Column resolution — 16-day cutoff, reordered Special Holiday column ───────────────────
//
// Hand-built rows (numbers chosen for this test, not read off a real sheet) that model a real
// shape problem: a 31-day month's second-half cutoff has 16 daily-attendance columns (one per
// calendar day from the 16th to the 31st), which shifts "Total Days Work"/"Reg Holiday" one
// column later than the 15-day layout above — and its "Special Holiday 30%" pay column sits
// well after a *different*, similarly-named "Special Hol (30%)" column that holds a rate
// reminder like the literal text "30%", not money. Fixed column indices misread both: they'd
// read "Total Work Hrs" as days worked, "Total Days Work" as the holiday-day count (grossly
// overstating holiday_pay), and "30%" as a 30-peso special-holiday amount. Header-text
// resolution must get every field right here regardless of how many day-columns precede it.
const SHIFTED_CSV = [
  'August 16-31,,,16-Aug,17-Aug,18-Aug,19-Aug,20-Aug,21-Aug,22-Aug,23-Aug,24-Aug,25-Aug,26-Aug,27-Aug,28-Aug,29-Aug,30-Aug,31-Aug,"SUMMARY AUGUST 1-15, 2026",,,,,,,,,,,,,,,,,,BENEFITS DEDUCTIONS ,,,,,,',
  'No.,Employee Name,BIO / Nickname,Sun,Mon,Tue,Wed,Thu,Fri,Sat,Sun,Mon,Tue,Wed,Thu,Fri,Sat,Sun,Mon,Total Work Hrs,Total Days Work,Reg Holiday,Special Hol (30%),Absent,Daily Rate,Hourly Rate,Absent,REG OT (Hrs),Reg OT 25%,Undertime / Late (mins),Late/ Undertime,Holiday OT (hrs),Holiday OT,Special Holiday 30%,Rest Day OT,RSD 30%,BASIC PAY,MONTHLY RATE,SSS,HDMF,PHIC,TAX,TOTAL DEDUCTIONS,Total Salary',
  'HR ADMIN / FINANCE,,,,,,,,,,,,,,,,,,NHD,,,,,,,,,,,,,,,,,,,,,,,,,',
  '1,"Aduan, Kyle Reneg",Kyle,,8,,8,8,8,,,8,8,8,8,8,,,8,80,9,1,30%,0,800,100,0.00,3,375.00,225,375.0,,,,,,"7,200.00","20,800.00",1050,,,,,"7,190.00"',
  '3,"Manalo,Rommel",ROMMEL,,A,,8,8,8,,,8,8,8,8,8,,,8,72,8,1,30%,1,1153.85,144.23,1153.85,0,0.00,0,0.0,,,,,,"9,230.80","30,000.10","1,500.00",,,,,"9,230.81"',
].join('\n');

describe('parsePayrollSummaryCsv — 16-day cutoff column shift', () => {
  const slips = parsePayrollSummaryCsv(SHIFTED_CSV);

  it('extracts both employee rows under the department header', () => {
    expect(slips).toHaveLength(2);
    expect(slips[0]!.employee_name).toBe('Aduan, Kyle Reneg');
    expect(slips[0]!.dept_position).toBe('HR ADMIN / FINANCE');
    expect(slips[1]!.employee_name).toBe('Manalo,Rommel');
    expect(slips[1]!.dept_position).toBe('HR ADMIN / FINANCE');
  });

  it('carries the payroll period from the title cell', () => {
    expect(slips[0]!.payroll_period).toBe('August 16-31');
  });

  it('reads days_worked from "Total Days Work", not the extra "Total Work Hrs" column', () => {
    expect(slips[0]!.days_worked).toBe(9); // not 80 (Total Work Hrs)
    expect(slips[1]!.days_worked).toBe(8); // not 72 (Total Work Hrs)
  });

  it('computes holiday_pay from the real Reg Holiday day count, not the shifted-in Total Days Work value', () => {
    // Both rows have Reg Holiday = 1 day. A fixed-offset reader would have used the
    // Total Days Work value instead (9 and 8), overstating holiday_pay ~8-9x.
    expect(slips[0]!.holiday_pay).toBe(800); // 800 daily rate * 1
    expect(slips[1]!.holiday_pay).toBeCloseTo(1153.85); // 1153.85 daily rate * 1
  });

  it('does not misread the "Special Hol (30%)" rate-reminder text ("30%") as a peso amount', () => {
    expect(slips[0]!.special_holiday_30).toBe(0);
    expect(slips[1]!.special_holiday_30).toBe(0);
  });

  it('reads the rest of the fields correctly off their real (non-fixed) positions', () => {
    const s = slips[0]!;
    expect(s.daily_rate).toBe(800);
    expect(s.ot_hours).toBe(3);
    expect(s.ot_rate_hour).toBeCloseTo(125); // 100 hourly rate * 1.25
    expect(s.basic_salary).toBe(7200); // 9 days * 800 daily rate
    expect(s.overtime_pay).toBe(375);
    expect(s.holiday_pay).toBe(800);
    expect(s.total_earnings).toBe(7200 + 375 + 800); // basic_salary + OT + holiday (no special-hol/rest-day/late this row)
    expect(s.sss).toBe(1050);
    expect(s.philhealth).toBe(0);
    expect(s.pagibig).toBe(0);
    expect(s.late_absences).toBe(375);
    expect(s.total_deductions).toBe(1050 + 375);
    expect(s.net_pay).toBe(7190);
  });
});

// ─── Real Aug 16-31 2026 export — total_earnings formula verification ──────────────────────
//
// Rows copied verbatim from the actual "Summary" export the user pasted in full (all 59
// rows), for the exact cutoff/employee (Arabit, Abegail) whose printed payslip first exposed
// this formula being wrong. Used specifically to verify total_earnings reconciles against the
// sheet's own Total Salary column for real data — see docs/reference/backend/
// hr-payroll-import.md's History section for the full back-and-forth this settled.
const REAL_AUG_CSV = [
  'August 16-31,,,16-Aug,17-Aug,18-Aug,19-Aug,20-Aug,21-Aug,22-Aug,23-Aug,24-Aug,25-Aug,26-Aug,27-Aug,28-Aug,29-Aug,30-Aug,31-Aug,"SUMMARY AUGUST 1-15, 2026",,,,,,,,,,,,,,,,,,BENEFITS DEDUCTIONS ,,,,,,',
  'No.,Employee Name,BIO / Nickname,Sun,Mon,Tue,Wed,Thu,Fri,Sat,Sun,Mon,Tue,Wed,Thu,Fri,Sat,Sun,Mon,Total Work Hrs,Total Days Work,Reg Holiday,Special Hol (30%),Absent,Daily Rate,Hourly Rate,Absent,REG OT (Hrs),Reg OT 25%,Undertime / Late (mins),Late/ Undertime,Holiday OT (hrs),Holiday OT,Special Holiday 30%,Rest Day OT,RSD 30%,BASIC PAY,MONTHLY RATE,SSS,HDMF,PHIC,TAX,TOTAL DEDUCTIONS,Total Salary',
  'HR ADMIN / FINANCE,,,,,,,,,,,,,,,,,,NHD,,,,,,,,,,,,,,,,,,,,,,,,,',
  '1,"Aduan, Kyle Reneg",Kyle,,8,,8,8,8,,,8,8,8,8,8,,,8,80,9,1,1,0,800,100,0,3,375,225,375,,,240,,,"7,200.00","20,800.00",1050,,,,,"7,190.00"',
  '2,"Arabit, Abegail",Abi,,8,,8,8,A,,,8,8,8,8,8,,,8,72,8,1,,1,600,75,600,3,281.25,27,33.8,,,0,,,"4,800.00","15,600.00",775,,,,,"4,872.50"',
  '3,"Manalo,Rommel",ROMMEL,,A,,8,8,8,,,8,8,8,8,8,,,8,72,8,1,1,1,1153.85,144.23,1153.85,0,0,0,0,,,346.155,,,"9,230.80","30,000.10","1,500.00",,,,,"9,230.81"',
  '8,"Cerda, Ma. Isabel",SABEL,,A,,A,8,8,,,A,4,A,A,8,,,8,36,3.5,1,1,5.5,650,81.25,3575,0,0,8,10.8,,,195,,,"2,275.00","16,900.00",825,,,,,"2,284.17"',
].join('\n');

describe('parsePayrollSummaryCsv — real Aug 16-31 2026 export (total_earnings reconciliation)', () => {
  const slips = parsePayrollSummaryCsv(REAL_AUG_CSV);

  it('extracts all four employee rows under the department header', () => {
    expect(slips).toHaveLength(4);
    expect(slips.map((s) => s.employee_name)).toEqual([
      'Aduan, Kyle Reneg', 'Arabit, Abegail', 'Manalo,Rommel', 'Cerda, Ma. Isabel',
    ]);
  });

  it('reads BASIC PAY as plain days-worked pay (Total Days Work * Daily Rate), no OT/holiday embedded', () => {
    // Every row's BASIC PAY equals days_worked * daily_rate exactly (including a fractional
    // half-day, Cerda's 3.5) — proof BASIC PAY on this real sheet never bakes in OT/holiday
    // pay, and settles the total_earnings formula debate documented in this file's History.
    for (const s of slips) {
      expect(s.basic_salary).toBeCloseTo(s.days_worked * s.daily_rate, 6);
    }
  });

  it("reconciles total_earnings - total_deductions against the sheet's own Total Salary within a few centavos", () => {
    // The residual few-centavo gaps (not exact 0) are consistent with rounding somewhere
    // upstream in the source spreadsheet's own late-minutes-to-pesos conversion — not a sign
    // of a formula error, since two of the four rows reconcile exactly.
    const cases: Array<[string, number]> = [
      ['Aduan, Kyle Reneg', 0],
      ['Arabit, Abegail', -0.05],
      ['Manalo,Rommel', -0.005],
      ['Cerda, Ma. Isabel', 0.03],
    ];
    for (const [name, expectedDiff] of cases) {
      const s = slips.find((x) => x.employee_name === name)!;
      const diff = (s.total_earnings - s.total_deductions) - s.net_pay;
      expect(diff).toBeCloseTo(expectedDiff, 2);
    }
  });

  it("Arabit, Abegail: total_earnings adds OT + holiday_pay on top of basic_salary, no late add-back", () => {
    const s = slips[1]!;
    expect(s.basic_salary).toBe(4800); // 8 days * 600 daily rate
    expect(s.overtime_pay).toBe(281.25);
    expect(s.holiday_pay).toBe(600); // 1 reg holiday day * 600 daily rate
    expect(s.late_absences).toBe(33.8);
    expect(s.total_earnings).toBe(4800 + 281.25 + 600); // = 5681.25 — NOT basic_salary + late (4833.8)
    expect(s.sss).toBe(775);
    expect(s.total_deductions).toBe(775 + 33.8);
    expect(s.net_pay).toBe(4872.5); // taken as-is from the sheet's own Total Salary column
  });
});
