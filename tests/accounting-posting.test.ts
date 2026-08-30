/** Pure tests for the posting engine (src/accounting-posting.ts) — Phase 1. */
import { describe, it, expect } from 'vitest';
import { buildSalesEntry, buildPurchaseEntry, type PostingRules } from '../src/accounting-posting';

const RULES: PostingRules = {
  ar_account_id: 11, sales_income_account_id: 41, output_vat_account_id: 21,
  ap_account_id: 22, purchase_expense_account_id: 51, input_vat_account_id: 12,
};

const sum = (lines: { debit?: number; credit?: number }[], k: 'debit' | 'credit') =>
  Math.round(lines.reduce((s, l) => s + (l[k] || 0), 0) * 100) / 100;

describe('buildSalesEntry', () => {
  it('DR AR gross / CR sales net / CR output VAT, balanced', () => {
    const r = buildSalesEntry(
      { number: 'SO-1', date: '2026-03-01', subtotal: 1000, tax_amount: 120, total: 1120, party_id: 7 },
      RULES, 1
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entry.book).toBe('sales');
    expect(r.entry.source_type).toBe('sale_order');
    expect(sum(r.entry.lines, 'debit')).toBe(1120);
    expect(sum(r.entry.lines, 'credit')).toBe(1120);
    const ar = r.entry.lines.find((l) => l.account_id === 11)!;
    expect(ar.debit).toBe(1120);
    expect(ar.party_type).toBe('customer');
    expect(ar.party_id).toBe(7);
    expect(r.entry.lines.find((l) => l.account_id === 41)!.credit).toBe(1000);
    expect(r.entry.lines.find((l) => l.account_id === 21)!.credit).toBe(120);
  });

  it('drops the VAT line when there is no tax', () => {
    const r = buildSalesEntry(
      { number: 'SO-2', date: '2026-03-01', subtotal: 500, tax_amount: 0, total: 500 }, RULES, 2
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entry.lines).toHaveLength(2);
    expect(r.entry.lines.some((l) => l.account_id === 21)).toBe(false);
  });

  it('derives sales credit from total - tax so a rounding gap never unbalances', () => {
    const r = buildSalesEntry(
      { number: 'SO-3', date: '2026-03-01', subtotal: 999.99, tax_amount: 120, total: 1120 }, RULES, 3
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(sum(r.entry.lines, 'debit')).toBe(sum(r.entry.lines, 'credit'));
    expect(r.entry.lines.find((l) => l.account_id === 41)!.credit).toBe(1000);
  });

  it('fails when a required account is missing', () => {
    const r = buildSalesEntry(
      { number: 'SO-4', date: '2026-03-01', subtotal: 100, tax_amount: 12, total: 112 },
      { ...RULES, output_vat_account_id: null }, 4
    );
    expect(r.ok).toBe(false);
  });

  it('fails on a non-positive total', () => {
    const r = buildSalesEntry(
      { number: 'SO-5', date: '2026-03-01', subtotal: 0, tax_amount: 0, total: 0 }, RULES, 5
    );
    expect(r.ok).toBe(false);
  });
});

describe('buildPurchaseEntry', () => {
  it('DR expense net / DR input VAT / CR AP gross, balanced', () => {
    const r = buildPurchaseEntry(
      { number: 'BILL-1', date: '2026-03-02', subtotal: 2000, tax_amount: 240, total: 2240, party_id: 9 },
      RULES, 10
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entry.book).toBe('purchase');
    expect(sum(r.entry.lines, 'debit')).toBe(2240);
    expect(sum(r.entry.lines, 'credit')).toBe(2240);
    expect(r.entry.lines.find((l) => l.account_id === 51)!.debit).toBe(2000);
    expect(r.entry.lines.find((l) => l.account_id === 12)!.debit).toBe(240);
    const ap = r.entry.lines.find((l) => l.account_id === 22)!;
    expect(ap.credit).toBe(2240);
    expect(ap.party_type).toBe('supplier');
    expect(ap.party_id).toBe(9);
  });
});
