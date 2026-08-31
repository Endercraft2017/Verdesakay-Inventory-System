/** Pure tests for the posting engine (src/accounting-posting.ts) — Phase 1. */
import { describe, it, expect } from 'vitest';
import {
  buildSalesEntry, buildPurchaseEntry, buildPaymentEntry, buildCreditNoteEntry, buildPayrollEntry,
  buildJobOrderEntry,
  type PostingRules, type PayrollDoc,
} from '../src/accounting-posting';

const RULES: PostingRules = {
  ar_account_id: 11, sales_income_account_id: 41, output_vat_account_id: 21,
  ap_account_id: 22, purchase_expense_account_id: 51, input_vat_account_id: 12,
  sales_returns_account_id: 44, ewt_payable_account_id: 23,
  payroll_expense_account_id: 61, payroll_er_contrib_account_id: 62, sss_payable_account_id: 71,
  philhealth_payable_account_id: 72, pagibig_payable_account_id: 73, withholding_tax_payable_account_id: 74,
  net_pay_payable_account_id: 75, employee_advance_account_id: 19,
  inventory_asset_account_id: 15, wip_account_id: 152, mfg_variance_account_id: 515,
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

describe('buildPaymentEntry', () => {
  it('receipt (in): DR cash / CR AR, party on the AR leg', () => {
    const r = buildPaymentEntry(
      { number: 'RCT-1', date: '2026-04-02', direction: 'in', amount: 1120,
        deposit_account_id: 99, party_type: 'customer', party_id: 5 },
      RULES, 1
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entry.book).toBe('cash_receipts');
    expect(r.entry.lines.find((l) => l.account_id === 99)!.debit).toBe(1120);
    const ar = r.entry.lines.find((l) => l.account_id === 11)!;
    expect(ar.credit).toBe(1120);
    expect(ar.party_type).toBe('customer');
    expect(ar.party_id).toBe(5);
  });

  it('disbursement (out): DR AP / CR cash', () => {
    const r = buildPaymentEntry(
      { number: 'DV-1', date: '2026-04-02', direction: 'out', amount: 800,
        deposit_account_id: 99, party_type: 'supplier', party_id: 8 },
      RULES, 2
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entry.book).toBe('cash_disbursements');
    const ap = r.entry.lines.find((l) => l.account_id === 22)!;
    expect(ap.debit).toBe(800);
    expect(ap.party_type).toBe('supplier');
    expect(r.entry.lines.find((l) => l.account_id === 99)!.credit).toBe(800);
  });

  it('fails without a deposit account or a control-account rule', () => {
    expect(buildPaymentEntry(
      { number: 'RCT-2', date: '2026-04-02', direction: 'in', amount: 10, deposit_account_id: 0, party_type: 'customer' },
      RULES, 3
    ).ok).toBe(false);
    expect(buildPaymentEntry(
      { number: 'RCT-3', date: '2026-04-02', direction: 'in', amount: 10, deposit_account_id: 99, party_type: 'customer' },
      { ...RULES, ar_account_id: null }, 4
    ).ok).toBe(false);
  });
});

describe('buildCreditNoteEntry', () => {
  it('customer credit note: DR sales returns / DR output VAT / CR AR', () => {
    const r = buildCreditNoteEntry(
      { number: 'CN-1', date: '2026-05-01', kind: 'customer', subtotal: 1000, tax_amount: 120, total: 1120, party_id: 3 },
      RULES, 1
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entry.book).toBe('sales');
    expect(sum(r.entry.lines, 'debit')).toBe(1120);
    expect(sum(r.entry.lines, 'credit')).toBe(1120);
    expect(r.entry.lines.find((l) => l.account_id === 44)!.debit).toBe(1000);
    expect(r.entry.lines.find((l) => l.account_id === 21)!.debit).toBe(120);
    const ar = r.entry.lines.find((l) => l.account_id === 11)!;
    expect(ar.credit).toBe(1120);
    expect(ar.party_type).toBe('customer');
    expect(ar.party_id).toBe(3);
  });

  it('supplier debit note: DR AP / CR purchases / CR input VAT', () => {
    const r = buildCreditNoteEntry(
      { number: 'DN-1', date: '2026-05-01', kind: 'supplier', subtotal: 500, tax_amount: 0, total: 500, party_id: 6 },
      RULES, 2
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entry.book).toBe('purchase');
    expect(r.entry.lines).toHaveLength(2); // no VAT leg
    expect(r.entry.lines.find((l) => l.account_id === 22)!.debit).toBe(500);
    expect(r.entry.lines.find((l) => l.account_id === 51)!.credit).toBe(500);
  });

  it('fails without the sales-returns rule on a customer note', () => {
    const r = buildCreditNoteEntry(
      { number: 'CN-2', date: '2026-05-01', kind: 'customer', subtotal: 100, tax_amount: 0, total: 100 },
      { ...RULES, sales_returns_account_id: null }, 3
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

  it('EWT splits the AP credit into supplier payable + withholding tax payable', () => {
    const r = buildPurchaseEntry(
      { number: 'BILL-2', date: '2026-03-02', subtotal: 1000, tax_amount: 120, total: 1120, party_id: 9, ewt_amount: 20 },
      RULES, 11
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(sum(r.entry.lines, 'debit')).toBe(sum(r.entry.lines, 'credit'));
    expect(r.entry.lines.find((l) => l.account_id === 22)!.credit).toBe(1100); // 1120 - 20
    expect(r.entry.lines.find((l) => l.account_id === 23)!.credit).toBe(20);   // EWT payable
    expect(r.entry.lines.find((l) => l.account_id === 51)!.debit).toBe(1000);
  });

  it('fails when EWT is set but no withholding-payable rule', () => {
    const r = buildPurchaseEntry(
      { number: 'BILL-3', date: '2026-03-02', subtotal: 1000, tax_amount: 0, total: 1000, ewt_amount: 20 },
      { ...RULES, ewt_payable_account_id: null }, 12
    );
    expect(r.ok).toBe(false);
  });
});

describe('buildPayrollEntry', () => {
  const FULL_DOC: PayrollDoc = {
    number: 'Aug 2026 Cutoff', date: '2026-08-31',
    gross_total: 2166.67, late_total: 100,
    er_contrib_total: 190, // sss_er 110 + sss_ec 5 + philhealth_er 50 + pagibig_er 25
    sss_payable_total: 215,          // employee 100 + employer 110 + ec 5
    philhealth_payable_total: 100,   // employee 50 + employer 50
    pagibig_payable_total: 50,       // employee 25 + employer 25
    withholding_tax_total: 30,
    net_pay_total: 1861.67,
    cash_advance_total: 0,
  };

  it('DR salaries (net of late) + ER contributions / CR the payables + net pay, balanced', () => {
    const r = buildPayrollEntry(FULL_DOC, RULES, 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entry.book).toBe('payroll');
    expect(r.entry.source_type).toBe('payroll_run');
    expect(sum(r.entry.lines, 'debit')).toBe(sum(r.entry.lines, 'credit'));
    expect(r.entry.lines.find((l) => l.account_id === 61)!.debit).toBe(2066.67); // gross - late
    expect(r.entry.lines.find((l) => l.account_id === 62)!.debit).toBe(190);
    expect(r.entry.lines.find((l) => l.account_id === 71)!.credit).toBe(215);
    expect(r.entry.lines.find((l) => l.account_id === 72)!.credit).toBe(100);
    expect(r.entry.lines.find((l) => l.account_id === 73)!.credit).toBe(50);
    expect(r.entry.lines.find((l) => l.account_id === 74)!.credit).toBe(30);
    expect(r.entry.lines.find((l) => l.account_id === 75)!.credit).toBe(1861.67);
  });

  it('drops payable lines whose total is zero, and the ER-contribution line when there is none', () => {
    // A self-consistent minimal doc (no ER contributions, no SSS/withholding at all this run) —
    // net_pay = gross - philhealth (the only deduction), so it still balances.
    const r = buildPayrollEntry(
      {
        number: 'Minimal', date: '2026-08-31', gross_total: 1000, late_total: 0, er_contrib_total: 0,
        sss_payable_total: 0, philhealth_payable_total: 100, pagibig_payable_total: 0,
        withholding_tax_total: 0, net_pay_total: 900, cash_advance_total: 0,
      },
      RULES, 2
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(sum(r.entry.lines, 'debit')).toBe(sum(r.entry.lines, 'credit'));
    expect(r.entry.lines.some((l) => l.account_id === 62)).toBe(false); // ER contrib
    expect(r.entry.lines.some((l) => l.account_id === 71)).toBe(false); // SSS
    expect(r.entry.lines.some((l) => l.account_id === 74)).toBe(false); // withholding tax
    expect(r.entry.lines.some((l) => l.account_id === 19)).toBe(false); // no cash advance
    expect(r.entry.lines.find((l) => l.account_id === 72)!.credit).toBe(100);
  });

  it('adds an Advances to Employees credit line when cash_advance_total is nonzero', () => {
    const r = buildPayrollEntry(
      { ...FULL_DOC, net_pay_total: FULL_DOC.net_pay_total - 200, cash_advance_total: 200 }, RULES, 3
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(sum(r.entry.lines, 'debit')).toBe(sum(r.entry.lines, 'credit'));
    expect(r.entry.lines.find((l) => l.account_id === 19)!.credit).toBe(200);
  });

  it('fails when the employee-advance rule is missing but cash_advance_total is nonzero', () => {
    const r = buildPayrollEntry(
      { ...FULL_DOC, cash_advance_total: 200 }, { ...RULES, employee_advance_account_id: null }, 4
    );
    expect(r.ok).toBe(false);
  });

  it('fails when a nonzero payable has no posting rule set', () => {
    const r = buildPayrollEntry(FULL_DOC, { ...RULES, sss_payable_account_id: null }, 5);
    expect(r.ok).toBe(false);
  });

  it('fails on a non-positive net gross (nothing worked this cutoff)', () => {
    const r = buildPayrollEntry({ ...FULL_DOC, gross_total: 0, late_total: 0 }, RULES, 6);
    expect(r.ok).toBe(false);
  });

  it('fails with a clear error when the totals given do not actually balance', () => {
    // net_pay_total inconsistent with the rest — simulates a run with hand-edited manual
    // figures (auto_statutory off) that don't add up.
    const r = buildPayrollEntry({ ...FULL_DOC, net_pay_total: 99999 }, RULES, 7);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/doesn't balance/);
  });
});

describe('buildJobOrderEntry', () => {
  it('release: DR Work in Process / CR Inventory', () => {
    const r = buildJobOrderEntry({ number: 'MO-1', date: '2026-08-31', kind: 'release', amount: 400 }, RULES, 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entry.book).toBe('general');
    expect(r.entry.source_type).toBe('job_order');
    expect(r.entry.lines.find((l) => l.account_id === 152)!.debit).toBe(400); // WIP
    expect(r.entry.lines.find((l) => l.account_id === 15)!.credit).toBe(400); // Inventory
  });

  it('produce: DR Inventory / CR Work in Process', () => {
    const r = buildJobOrderEntry({ number: 'MO-1', date: '2026-08-31', kind: 'produce', amount: 320 }, RULES, 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entry.lines.find((l) => l.account_id === 15)!.debit).toBe(320);
    expect(r.entry.lines.find((l) => l.account_id === 152)!.credit).toBe(320);
  });

  it('settle: splits the residual WIP balance between Inventory (returned) and Variance (scrap)', () => {
    const r = buildJobOrderEntry(
      { number: 'MO-1', date: '2026-08-31', kind: 'settle', amount: 120, return_amount: 40 }, RULES, 1
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entry.lines.find((l) => l.account_id === 15)!.debit).toBe(40);   // back to Inventory
    expect(r.entry.lines.find((l) => l.account_id === 515)!.debit).toBe(80);  // Manufacturing Variance
    expect(r.entry.lines.find((l) => l.account_id === 152)!.credit).toBe(120); // WIP cleared
    expect(sum(r.entry.lines, 'debit')).toBe(sum(r.entry.lines, 'credit'));
  });

  it('settle with the full balance returned to stock needs no variance account', () => {
    const r = buildJobOrderEntry(
      { number: 'MO-1', date: '2026-08-31', kind: 'settle', amount: 160, return_amount: 160 },
      { ...RULES, mfg_variance_account_id: null }, 1
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entry.lines.find((l) => l.account_id === 15)!.debit).toBe(160);
    expect(r.entry.lines.find((l) => l.account_id === 152)!.credit).toBe(160);
  });

  it('fails when the WIP / Inventory rules are not set', () => {
    const r = buildJobOrderEntry(
      { number: 'MO-1', date: '2026-08-31', kind: 'release', amount: 400 },
      { ...RULES, wip_account_id: null }, 1
    );
    expect(r.ok).toBe(false);
  });
});
