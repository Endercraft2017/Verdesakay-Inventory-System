/** Final-pay / back-pay worksheet (pure). */
import { describe, it, expect } from 'vitest';
import { computeFinalPay, type FinalPayInput } from '../src/ph-final-pay';
import { RWT_2026 } from '../src/ph-statutory';

const base = (o: Partial<FinalPayInput> = {}): FinalPayInput => ({
  employee_name: 'Dela Cruz, Juan',
  daily_rate: 1000,
  separation_date: '2026-06-30',
  last_day_paid: '2026-06-15',
  unpaid_days: 0,
  unused_leave_days: 0,
  other_earnings: 0,
  outstanding_advance: 0,
  other_deductions: 0,
  ytd: { basic_earned: 120_000, gross_earned: 130_000, employee_statutory: 6_000, tax_withheld: 8_000, thirteenth_month_paid: 0 },
  rwt: RWT_2026,
  ...o,
});

describe('computeFinalPay', () => {
  it('adds unpaid salary and a pro-rated 13th month', () => {
    const r = computeFinalPay(base({ unpaid_days: 10 }));
    expect(r.earnings.unpaid_salary).toBe(10_000);
    // (120,000 ytd basic + 10,000 unpaid) / 12
    expect(r.earnings.prorated_13th_month).toBeCloseTo(10_833.33, 2);
    expect(r.earnings.gross).toBeCloseTo(20_833.33, 2);
  });

  it('converts unused leave at the daily rate', () => {
    const r = computeFinalPay(base({ unused_leave_days: 5 }));
    expect(r.earnings.leave_conversion).toBe(5_000);
  });

  it('nets out an outstanding advance', () => {
    const r = computeFinalPay(base({ unpaid_days: 10, outstanding_advance: 3_000 }));
    expect(r.deductions.outstanding_advance).toBe(3_000);
    expect(r.net_final_pay).toBeCloseTo(r.earnings.gross + r.additions.tax_refund - r.deductions.total, 2);
  });

  it('collects tax when annualised due exceeds what was withheld', () => {
    // Big YTD income, tiny tax withheld → the worksheet must collect the shortfall.
    const r = computeFinalPay(base({
      ytd: { basic_earned: 600_000, gross_earned: 650_000, employee_statutory: 12_000, tax_withheld: 1_000, thirteenth_month_paid: 0 },
    }));
    expect(r.tax_annualisation.adjustment).toBeGreaterThan(0);
    expect(r.deductions.tax_still_due).toBe(r.tax_annualisation.adjustment);
    expect(r.additions.tax_refund).toBe(0);
  });

  it('refunds tax when too much was withheld', () => {
    const r = computeFinalPay(base({
      ytd: { basic_earned: 120_000, gross_earned: 125_000, employee_statutory: 6_000, tax_withheld: 40_000, thirteenth_month_paid: 0 },
    }));
    expect(r.tax_annualisation.adjustment).toBeLessThan(0);
    expect(r.additions.tax_refund).toBeGreaterThan(0);
    expect(r.deductions.tax_still_due).toBe(0);
  });

  it('taxes the 13th-month amount above the 90k ceiling', () => {
    const r = computeFinalPay(base({
      unpaid_days: 0,
      ytd: { basic_earned: 1_320_000, gross_earned: 1_400_000, employee_statutory: 24_000, tax_withheld: 200_000, thirteenth_month_paid: 0 },
    }));
    // 1,320,000 / 12 = 110,000 → 20,000 over the ceiling is taxable
    expect(r.notes.some((n) => /exceed the 90,000/.test(n))).toBe(true);
  });
});
