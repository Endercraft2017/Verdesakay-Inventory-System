/**
 * BIR corporate income tax return worksheet (pure):
 *  - 1702Q  — Quarterly Income Tax Return (cumulative year-to-date; due 60 days after
 *             the close of each of the first three quarters).
 *  - 1702-RT — Annual Income Tax Return, corporation on the Regular rate (due the 15th
 *             day of the 4th month after the taxable year ends).
 *
 * A *worksheet*: the app supplies book net income + gross income from the posted ledger,
 * the accountant enters the tax adjustments (non-deductible expenses added back,
 * non-taxable income deducted), the applicable rate, MCIT applicability and the tax
 * credits, then files in eBIRForms / eFPS. Nothing here is filed automatically.
 */

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** One book-to-tax reconciliation line (only used under itemized deductions). */
export interface IncomeTaxAdjustment {
  label: string;
  kind: 'add' | 'deduct';   // add back a non-deductible expense / deduct non-taxable income
  amount: number;
}

export interface IncomeTaxInput {
  /** Net sales − cost of sales + other operating income, from the ledger. */
  gross_income: number;
  /** Net income per the financial statements (income − all expenses), from the ledger. */
  book_net_income: number;
  /** 'itemized' → book net income ± adjustments; 'osd' → 60% of gross income. */
  deduction_method?: 'itemized' | 'osd';
  adjustments?: IncomeTaxAdjustment[];
  /** Regular corporate income tax rate. Default 0.25 (domestic corp); 0.20 for a
   *  small / MSME domestic corp (net taxable ≤ ₱5M and total assets ≤ ₱100M ex-land). */
  rate?: number;
  /** MCIT applies from the 4th taxable year of operation. */
  mcit_applies?: boolean;
  mcit_rate?: number;   // default 0.02
  /** Income tax already paid on this year's earlier quarterly returns. */
  prior_payments?: number;
  /** Creditable withholding tax on income payments received (2307s / SAWT). */
  creditable_withholding?: number;
  /** Excess credits carried over from the prior year's return. */
  prior_year_excess?: number;
}

export interface IncomeTax1702 {
  deduction_method: 'itemized' | 'osd';
  rate: number;
  mcit_rate: number;
  additions: number;
  deductions: number;
  net_taxable_income: number;
  regular_income_tax: number;   // net taxable × rate
  mcit: number;                 // gross income × mcit_rate
  mcit_applies: boolean;
  income_tax_due: number;       // higher of RCIT / MCIT when MCIT applies, else RCIT
  total_credits: number;
  still_payable: number;        // max(due − credits, 0)
  overpayment: number;          // max(credits − due, 0)  (carry over or refund)
  notes: string[];
}

export function incomeTax1702(input: IncomeTaxInput): IncomeTax1702 {
  const method: 'itemized' | 'osd' = input.deduction_method === 'osd' ? 'osd' : 'itemized';
  const rate = input.rate != null && input.rate > 0 ? input.rate : 0.25;
  const mcitRate = input.mcit_rate != null && input.mcit_rate > 0 ? input.mcit_rate : 0.02;
  const gross = round2(input.gross_income || 0);

  const lines = input.adjustments || [];
  const additions = round2(lines.filter((a) => a.kind === 'add').reduce((s, a) => s + (Number(a.amount) || 0), 0));
  const deductions = round2(lines.filter((a) => a.kind === 'deduct').reduce((s, a) => s + (Number(a.amount) || 0), 0));

  const notes: string[] = [];
  let taxable: number;
  if (method === 'osd') {
    taxable = round2(gross * 0.60);
    notes.push('Optional Standard Deduction — 40% of gross income in lieu of itemized deductions; the reconciliation lines below are not applied.');
  } else {
    taxable = round2((input.book_net_income || 0) + additions - deductions);
  }
  taxable = round2(Math.max(0, taxable));

  const rcit = round2(taxable * rate);
  const mcit = round2(gross * mcitRate);
  const mcitApplies = !!input.mcit_applies;
  const due = round2(mcitApplies ? Math.max(rcit, mcit) : rcit);
  if (mcitApplies && mcit > rcit) {
    notes.push(`MCIT (${(mcitRate * 100).toFixed(0)}% of gross income) is higher than the regular income tax — pay the MCIT; the excess over RCIT is creditable in the next three years.`);
  }

  const total_credits = round2(
    (input.prior_payments || 0) + (input.creditable_withholding || 0) + (input.prior_year_excess || 0)
  );

  if (Math.abs(rate - 0.25) < 1e-9) {
    notes.push('Regular rate 25% assumed. A small / MSME domestic corporation (net taxable ≤ ₱5M and total assets ≤ ₱100M excluding land) uses 20% — set the rate accordingly.');
  }
  notes.push('Attach the SAWT for the creditable withholding (2307s received). 1702Q: file within 60 days of the quarter close. 1702-RT: file by the 15th day of the 4th month after year-end.');

  return {
    deduction_method: method, rate, mcit_rate: mcitRate,
    additions, deductions,
    net_taxable_income: taxable,
    regular_income_tax: rcit,
    mcit, mcit_applies: mcitApplies,
    income_tax_due: due,
    total_credits,
    still_payable: round2(Math.max(0, due - total_credits)),
    overpayment: round2(Math.max(0, total_credits - due)),
    notes,
  };
}
