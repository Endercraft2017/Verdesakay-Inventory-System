/** BIR 2550M (VAT) + 0619-E (expanded withholding) worksheets — pure. */
import { describe, it, expect } from 'vitest';
import { vat2550m, ewt0619e, EWT_ATCS } from '../src/modules/payroll/ph-vat-ewt';

describe('vat2550m', () => {
  it('nets output VAT against input VAT using each side\'s booked amount', () => {
    const w = vat2550m({
      gross_sales: 112_000, output_vat_booked: 12_000,
      gross_purchases: 56_000, input_vat_booked: 6_000,
    });
    expect(w.output_vat).toBe(12_000);
    expect(w.input_vat_current).toBe(6_000);
    expect(w.net_vat_payable).toBe(6_000);
    expect(w.still_payable).toBe(6_000);
    expect(w.excess_input_vat).toBe(0);
  });

  it('derives 12% VAT when a side has no booked tax (VAT-exclusive)', () => {
    const w = vat2550m({ gross_sales: 100_000, output_vat_booked: 0, gross_purchases: 0, input_vat_booked: 0 });
    expect(w.output_vat).toBe(12_000);
    expect(w.notes.some((n) => /derived from the sales total/.test(n))).toBe(true);
  });

  it('derives VAT out of a VAT-inclusive total', () => {
    const w = vat2550m({
      gross_sales: 112_000, output_vat_booked: 0, gross_purchases: 0, input_vat_booked: 0,
      amounts_vat_inclusive: true,
    });
    expect(w.output_vat).toBeCloseTo(12_000, 2);
    expect(w.vatable_sales).toBeCloseTo(100_000, 2);
  });

  it('carries excess input VAT forward when input exceeds output', () => {
    const w = vat2550m({
      gross_sales: 0, output_vat_booked: 1_000,
      gross_purchases: 0, input_vat_booked: 4_000,
      input_vat_carry_over: 500,
    });
    expect(w.total_available_input_vat).toBe(4_500);
    expect(w.net_vat_payable).toBe(-3_500);
    expect(w.excess_input_vat).toBe(3_500);
    expect(w.still_payable).toBe(0);
  });

  it('subtracts advance VAT payments from the amount still payable', () => {
    const w = vat2550m({
      gross_sales: 0, output_vat_booked: 10_000, gross_purchases: 0, input_vat_booked: 2_000,
      vat_payments: 3_000,
    });
    expect(w.net_vat_payable).toBe(8_000);
    expect(w.still_payable).toBe(5_000);
  });
});

describe('ewt0619e', () => {
  it('computes tax per ATC line and totals, dropping zero-base lines', () => {
    const w = ewt0619e([
      { atc: 'WI100', description: 'Rentals', tax_base: 50_000, rate: 0.05 },
      { atc: 'WI010', description: 'Professional fees', tax_base: 20_000, rate: 0.10 },
      { atc: 'WI120', description: 'Contractors', tax_base: 0, rate: 0.02 },
    ]);
    expect(w.lines).toHaveLength(2);
    expect(w.total_tax_base).toBe(70_000);
    expect(w.total_tax_withheld).toBe(4_500); // 2,500 + 2,000
    expect(w.still_payable).toBe(4_500);
  });

  it('nets prior remittances against what is still payable', () => {
    const w = ewt0619e([{ atc: 'WI100', description: 'Rentals', tax_base: 100_000, rate: 0.05 }], 3_000);
    expect(w.total_tax_withheld).toBe(5_000);
    expect(w.remitted_prior).toBe(3_000);
    expect(w.still_payable).toBe(2_000);
  });

  it('exposes a usable ATC reference', () => {
    expect(EWT_ATCS.length).toBeGreaterThan(3);
    expect(EWT_ATCS.every((a) => a.atc && a.description && a.rate > 0)).toBe(true);
  });
});
