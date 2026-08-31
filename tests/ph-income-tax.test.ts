/** Pure tests for the corporate income tax worksheet (src/ph-income-tax.ts). */
import { describe, it, expect } from 'vitest';
import { incomeTax1702 } from '../src/ph-income-tax';

describe('incomeTax1702', () => {
  it('itemized: book net income ± adjustments × 25%, less credits', () => {
    const w = incomeTax1702({
      gross_income: 2_000_000,
      book_net_income: 500_000,
      adjustments: [
        { label: 'Penalties', kind: 'add', amount: 30_000 },
        { label: 'Interest income already taxed', kind: 'deduct', amount: 20_000 },
      ],
      prior_payments: 40_000,
      creditable_withholding: 15_000,
    });
    expect(w.additions).toBe(30_000);
    expect(w.deductions).toBe(20_000);
    expect(w.net_taxable_income).toBe(510_000);          // 500k + 30k − 20k
    expect(w.regular_income_tax).toBe(127_500);          // 25%
    expect(w.income_tax_due).toBe(127_500);              // MCIT n/a
    expect(w.total_credits).toBe(55_000);
    expect(w.still_payable).toBe(72_500);
    expect(w.overpayment).toBe(0);
  });

  it('small corp rate 20%', () => {
    const w = incomeTax1702({ gross_income: 1_000_000, book_net_income: 300_000, rate: 0.20 });
    expect(w.rate).toBe(0.20);
    expect(w.regular_income_tax).toBe(60_000);
  });

  it('OSD: 60% of gross income, adjustments ignored', () => {
    const w = incomeTax1702({
      gross_income: 1_000_000, book_net_income: 100_000, deduction_method: 'osd',
      adjustments: [{ label: 'x', kind: 'add', amount: 999_999 }],
    });
    expect(w.deduction_method).toBe('osd');
    expect(w.net_taxable_income).toBe(600_000);
    expect(w.regular_income_tax).toBe(150_000);          // 25% of 600k
    expect(w.notes.some((n) => /Optional Standard Deduction/.test(n))).toBe(true);
  });

  it('MCIT: pays the higher of regular tax and 2% of gross income', () => {
    // thin margin — RCIT (25% of 40k = 10k) < MCIT (2% of 2M = 40k)
    const w = incomeTax1702({ gross_income: 2_000_000, book_net_income: 40_000, mcit_applies: true });
    expect(w.regular_income_tax).toBe(10_000);
    expect(w.mcit).toBe(40_000);
    expect(w.income_tax_due).toBe(40_000);
    expect(w.notes.some((n) => /MCIT/.test(n))).toBe(true);
  });

  it('a loss produces zero taxable income and (with MCIT off) zero tax', () => {
    const w = incomeTax1702({ gross_income: 500_000, book_net_income: -80_000 });
    expect(w.net_taxable_income).toBe(0);
    expect(w.income_tax_due).toBe(0);
  });

  it('credits exceeding the tax due show as an overpayment', () => {
    const w = incomeTax1702({ gross_income: 100_000, book_net_income: 40_000, prior_payments: 30_000 });
    expect(w.income_tax_due).toBe(10_000);
    expect(w.still_payable).toBe(0);
    expect(w.overpayment).toBe(20_000);
  });
});
