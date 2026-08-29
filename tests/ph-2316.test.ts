/** BIR 2316 year-end figure computation (pure). */
import { describe, it, expect } from 'vitest';
import { compute2316, type PayslipYearRow } from '../src/ph-2316';
import { RWT_2026 } from '../src/ph-statutory';

const slip = (o: Partial<PayslipYearRow>): PayslipYearRow => ({
  basic_salary: 0, total_earnings: 0, sss: 0, philhealth: 0, pagibig: 0, withholding_tax: 0, ...o,
});

describe('compute2316', () => {
  it('rolls up a full year of monthly payslips', () => {
    const rows = Array.from({ length: 12 }, () =>
      slip({ basic_salary: 25_000, total_earnings: 25_000, sss: 1_250, philhealth: 625, pagibig: 200, withholding_tax: 800 })
    );
    const f = compute2316(rows, RWT_2026, '2026');

    expect(f.payslip_count).toBe(12);
    expect(f.basic_salary).toBe(300_000);
    expect(f.sss_gsis_phic_pagibig_union).toBe(24_900);        // 2075 * 12
    expect(f.thirteenth_month_and_other_benefits).toBe(25_000); // 300000/12, under the 90k cap
    expect(f.taxable_13th_month_excess).toBe(0);
    expect(f.total_non_taxable).toBe(49_900);
    expect(f.gross_compensation).toBe(325_000);                 // earnings + 13th month
    expect(f.gross_taxable_compensation).toBe(275_100);
    expect(f.tax_due).toBe(3_765);                              // (275100-250000)*0.15
    expect(f.tax_withheld_present).toBe(9_600);
    expect(f.over_withheld).toBe(5_835);                        // 9600 - 3765 -> refund
  });

  it('splits 13th-month + benefits above the ceiling into a taxable excess', () => {
    const rows = [slip({ basic_salary: 1_200_000, total_earnings: 1_200_000 })];
    const f = compute2316(rows, RWT_2026, '2026');
    expect(f.thirteenth_month_and_other_benefits).toBe(90_000); // capped
    expect(f.taxable_13th_month_excess).toBe(10_000);           // 100000 - 90000
    expect(f.total_non_taxable).toBe(90_000);
  });

  it('honours de-minimis and previous-employer options', () => {
    const rows = [slip({ basic_salary: 240_000, total_earnings: 240_000, withholding_tax: 1_000 })];
    const f = compute2316(rows, RWT_2026, '2026', {
      de_minimis: 15_000, taxable_previous: 50_000, tax_withheld_previous: 2_500,
    });
    // benefits = 240000/12 + 15000 = 35000, under 90k -> all non-taxable
    expect(f.thirteenth_month_and_other_benefits).toBe(35_000);
    expect(f.taxable_compensation_previous).toBe(50_000);
    expect(f.tax_withheld_previous).toBe(2_500);
    expect(f.total_tax_withheld).toBe(3_500);
    expect(f.gross_taxable_compensation).toBe(f.taxable_compensation_present + 50_000);
  });

  it('no payslips → all zeros, no tax due', () => {
    const f = compute2316([], RWT_2026, '2026');
    expect(f).toMatchObject({ payslip_count: 0, gross_compensation: 0, tax_due: 0, over_withheld: 0 });
  });
});
