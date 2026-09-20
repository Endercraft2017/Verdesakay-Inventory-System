/** Payroll Excel export — pure data math only (computePayrollExportData): totals must match
    form-records.js's on-screen payslipSummaryHTML/payslipTotals exactly (same formula,
    duplicated on purpose per that file's comments), and department grouping must read the
    same "Department / Position" convention hr_payroll's dept_position field is seeded with
    (src/db.ts). The XLSX-writing half of hr-payroll-export.js (buildPayrollWorkbook /
    downloadPayrollWorkbook) needs the real vendored xlsx-js-style global + a DOM and isn't
    exercised here — same "loads the raw browser file into a sandbox" technique as
    tests/hr-payroll-print.test.ts, but this module has no top-level require() so no shimming
    is needed for the piece under test. */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.join(import.meta.dirname, '../public/js');

function loadModule() {
  const src = fs.readFileSync(path.join(DIR, 'hr-payroll-export.js'), 'utf8');
  const mod: { exports: Record<string, unknown> } = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', src)(mod, mod.exports);
  return mod.exports as {
    computePayrollExportData: (records: { data: Record<string, unknown> }[]) => {
      totals: { count: number; gross: number; statutory: number; otherDeductions: number; totalDeductions: number; net: number };
      departments: { name: string; count: number; gross: number; statutory: number; otherDeductions: number; totalDeductions: number; net: number }[];
    };
  };
}

const { computePayrollExportData } = loadModule();

const rec = (dept_position: string, overrides: Record<string, unknown> = {}) => ({
  data: {
    dept_position,
    total_earnings: 10000, sss: 500, philhealth: 200, pagibig: 100, withholding_tax: 300,
    total_deductions: 1300, net_pay: 8700,
    ...overrides,
  },
});

describe('computePayrollExportData', () => {
  it('sums gross/statutory/other/total/net the same way payslipTotals() does', () => {
    const { totals } = computePayrollExportData([rec('Warehouse / Warehouseman')]);
    expect(totals).toEqual({ count: 1, gross: 10000, statutory: 1100, otherDeductions: 200, totalDeductions: 1300, net: 8700 });
  });

  it('splits dept_position on the first "/" to get the department', () => {
    const { departments } = computePayrollExportData([
      rec('Production Team 1 / Assembler'),
      rec('Production Team 1 / Assembler'),
      rec('Warehouse Department / Warehouseman'),
    ]);
    expect(departments.map((d) => d.name)).toEqual(['Production Team 1', 'Warehouse Department']);
    expect(departments[0]?.count).toBe(2);
    expect(departments[0]?.gross).toBe(20000);
    expect(departments[1]?.count).toBe(1);
  });

  it('falls back to "(No Department)" when dept_position has no department part', () => {
    const { departments } = computePayrollExportData([rec('')]);
    expect(departments).toEqual([expect.objectContaining({ name: '(No Department)', count: 1 })]);
  });

  it('department totals sum back up to the grand totals', () => {
    const records = [
      rec('A / Role', { total_earnings: 5000, sss: 100, philhealth: 50, pagibig: 25, withholding_tax: 25, total_deductions: 300, net_pay: 4700 }),
      rec('B / Role', { total_earnings: 7000, sss: 150, philhealth: 75, pagibig: 40, withholding_tax: 35, total_deductions: 400, net_pay: 6600 }),
    ];
    const { totals, departments } = computePayrollExportData(records);
    const sumField = (key: 'gross' | 'statutory' | 'otherDeductions' | 'totalDeductions' | 'net') =>
      departments.reduce((s, d) => s + d[key], 0);
    expect(sumField('gross')).toBe(totals.gross);
    expect(sumField('statutory')).toBe(totals.statutory);
    expect(sumField('otherDeductions')).toBe(totals.otherDeductions);
    expect(sumField('totalDeductions')).toBe(totals.totalDeductions);
    expect(sumField('net')).toBe(totals.net);
  });

  it('treats missing/non-numeric amount fields as zero instead of NaN', () => {
    const { totals } = computePayrollExportData([rec('X / Role', { total_earnings: undefined, sss: 'n/a' })]);
    expect(Number.isNaN(totals.gross)).toBe(false);
    expect(totals.gross).toBe(0);
  });
});
