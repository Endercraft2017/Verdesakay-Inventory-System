/** PH statutory payroll math — SSS, PhilHealth, Pag-IBIG, BIR withholding.
    Pure module; no app/DB. Values checked against the 2026 schedules
    (docs/PH-PAYROLL-COMPLIANCE.md). */
import { describe, it, expect } from 'vitest';
import {
  monthlySalaryCredit,
  sssContribution,
  philHealthContribution,
  pagIbigContribution,
  taxableCompensation,
  withholdingTax,
  statutoryDeductions,
  SSS_2026,
  PHILHEALTH_2026,
  PAGIBIG_2026,
  RWT_2026,
  STATUTORY_TABLES_2026,
} from '../src/modules/payroll/ph-statutory';

describe('SSS', () => {
  it('snaps monthly comp to the MSC schedule', () => {
    expect(monthlySalaryCredit(3_000, SSS_2026)).toBe(5_000);   // below floor
    expect(monthlySalaryCredit(20_000, SSS_2026)).toBe(20_000);
    expect(monthlySalaryCredit(20_750, SSS_2026)).toBe(21_000); // half-step rounds up
    expect(monthlySalaryCredit(20_749, SSS_2026)).toBe(20_500);
    expect(monthlySalaryCredit(50_000, SSS_2026)).toBe(35_000); // above ceiling
  });

  it('computes EE / ER / EC from the MSC', () => {
    expect(sssContribution(20_000, SSS_2026)).toEqual({ msc: 20_000, employee: 1_000, employer: 2_000, ec: 30, total: 3_030 });
    expect(sssContribution(30_000, SSS_2026)).toMatchObject({ msc: 30_000, employee: 1_500, employer: 3_000, ec: 30 });
    expect(sssContribution(10_000, SSS_2026)).toMatchObject({ employee: 500, employer: 1_000, ec: 10 }); // low EC band
    expect(sssContribution(3_000, SSS_2026)).toMatchObject({ msc: 5_000, employee: 250, employer: 500, ec: 10 });
    expect(sssContribution(60_000, SSS_2026)).toMatchObject({ msc: 35_000, employee: 1_750, employer: 3_500, ec: 30 });
  });
});

describe('PhilHealth', () => {
  it('is 5% of basic, split in half, within the floor/ceiling', () => {
    expect(philHealthContribution(20_000, PHILHEALTH_2026)).toEqual({ employee: 500, employer: 500, total: 1_000 });
    expect(philHealthContribution(8_000, PHILHEALTH_2026)).toEqual({ employee: 250, employer: 250, total: 500 });   // floored at 10k
    expect(philHealthContribution(150_000, PHILHEALTH_2026)).toEqual({ employee: 2_500, employer: 2_500, total: 5_000 }); // capped at 100k
  });
});

describe('Pag-IBIG', () => {
  it('caps at ₱200 each and uses the low employee rate below ₱1,500', () => {
    expect(pagIbigContribution(20_000, PAGIBIG_2026)).toEqual({ employee: 200, employer: 200, total: 400 });
    expect(pagIbigContribution(5_000, PAGIBIG_2026)).toEqual({ employee: 100, employer: 100, total: 200 });
    expect(pagIbigContribution(1_000, PAGIBIG_2026)).toEqual({ employee: 10, employer: 20, total: 30 }); // 1% EE / 2% ER
  });
});

describe('BIR withholding tax', () => {
  it('monthly table', () => {
    expect(withholdingTax(20_000, 'monthly', RWT_2026)).toBe(0);
    expect(withholdingTax(30_000, 'monthly', RWT_2026)).toBe(1_375.05);   // (30000-20833)*.15
    expect(withholdingTax(50_000, 'monthly', RWT_2026)).toBe(5_208.4);    // 1875 + (50000-33333)*.20
    expect(withholdingTax(100_000, 'monthly', RWT_2026)).toBe(16_875.05); // 8541.80 + (100000-66667)*.25
  });
  it('semi-monthly table', () => {
    expect(withholdingTax(10_000, 'semi_monthly', RWT_2026)).toBe(0);
    expect(withholdingTax(15_000, 'semi_monthly', RWT_2026)).toBe(687.45); // (15000-10417)*.15
  });
});

describe('taxable compensation + full deduction set', () => {
  it('nets out non-taxable items and the employee statutory shares', () => {
    expect(taxableCompensation(30_000, 0, 1_600)).toBe(28_400);
    expect(taxableCompensation(5_000, 0, 8_000)).toBe(0); // never negative
  });

  it('statutoryDeductions rolls up all three employee shares', () => {
    const r = statutoryDeductions(25_000, 25_000, STATUTORY_TABLES_2026);
    expect(r.sss.employee).toBe(1_250);
    expect(r.philhealth.employee).toBe(625);
    expect(r.pagibig.employee).toBe(200);
    expect(r.employee_total).toBe(2_075);
  });
});
