/**
 * Posting engine (pure) — ACCOUNTING-SYSTEM-PLAN.md Phase 1.
 *
 * Turns a business document (a confirmed sale order, an approved vendor bill) into a
 * balanced set of journal lines, using the tenant's *posting rules* (which account each
 * thing hits). DB-free so it can be unit-tested directly; `src/accounting-autopost.ts`
 * wraps it with the reads/writes and the best-effort hooks.
 */
import { round2, type JournalLineInput } from './ledger';

/** Which account each posted amount lands on. All optional — a missing one blocks the post. */
export interface PostingRules {
  ar_account_id?: number | null;             // Accounts Receivable (debit on a sale)
  sales_income_account_id?: number | null;   // Sales / revenue (credit on a sale)
  output_vat_account_id?: number | null;     // Output VAT payable (credit on a sale)
  ap_account_id?: number | null;             // Accounts Payable (credit on a bill)
  purchase_expense_account_id?: number | null; // Purchases / COGS / expense (debit on a bill)
  input_vat_account_id?: number | null;      // Input VAT (debit on a bill)
}

export const POSTING_RULE_KEYS: (keyof PostingRules)[] = [
  'ar_account_id', 'sales_income_account_id', 'output_vat_account_id',
  'ap_account_id', 'purchase_expense_account_id', 'input_vat_account_id',
];

/** The document shape the builders need — the same fields sale orders and vendor bills share. */
export interface PostableDoc {
  number: string;
  date: string;               // entry_date (YYYY-MM-DD)
  subtotal: number;
  tax_amount: number;
  total: number;
  party_id?: number | null;   // customer / supplier id, stamped onto the AR / AP line
  memo?: string | null;
}

export interface BuiltEntry {
  book: 'sales' | 'purchase';
  entry_date: string;
  memo: string;
  reference: string;
  source_type: 'sale_order' | 'vendor_bill';
  source_id: number;
  lines: JournalLineInput[];
}

export type BuildResult =
  | { ok: true; entry: BuiltEntry }
  | { ok: false; error: string };

function missing(rules: PostingRules, keys: (keyof PostingRules)[]): string | null {
  const gaps = keys.filter((k) => !rules[k]);
  if (!gaps.length) return null;
  return `Set the posting rules first (missing: ${gaps.join(', ')}) — Accounting → Books → Posting rules.`;
}

/**
 * A sale: DR Accounts Receivable (gross) / CR Sales (net) / CR Output VAT (tax).
 * The VAT line is dropped when there is no tax. Sales credit is derived as
 * total − tax so a one-centavo rounding gap in the document never unbalances the entry.
 */
export function buildSalesEntry(doc: PostableDoc, rules: PostingRules, sourceId: number): BuildResult {
  const need: (keyof PostingRules)[] = ['ar_account_id', 'sales_income_account_id'];
  const tax = round2(doc.tax_amount || 0);
  if (tax > 0) need.push('output_vat_account_id');
  const gap = missing(rules, need);
  if (gap) return { ok: false, error: gap };

  const total = round2(doc.total || 0);
  if (total <= 0) return { ok: false, error: `${doc.number}: nothing to post (total is ${total}).` };
  const net = round2(total - tax);

  const lines: JournalLineInput[] = [
    { account_id: rules.ar_account_id!, debit: total, credit: 0, party_type: 'customer', party_id: doc.party_id ?? null, memo: doc.memo ?? null },
    { account_id: rules.sales_income_account_id!, debit: 0, credit: net },
  ];
  if (tax > 0) lines.push({ account_id: rules.output_vat_account_id!, debit: 0, credit: tax });

  return {
    ok: true,
    entry: {
      book: 'sales',
      entry_date: doc.date,
      memo: `Sale ${doc.number}`,
      reference: doc.number,
      source_type: 'sale_order',
      source_id: sourceId,
      lines,
    },
  };
}

/**
 * A purchase: DR Purchases/expense (net) / DR Input VAT (tax) / CR Accounts Payable (gross).
 * VAT line dropped when there is no tax; the expense debit is derived as total − tax.
 */
export function buildPurchaseEntry(doc: PostableDoc, rules: PostingRules, sourceId: number): BuildResult {
  const need: (keyof PostingRules)[] = ['ap_account_id', 'purchase_expense_account_id'];
  const tax = round2(doc.tax_amount || 0);
  if (tax > 0) need.push('input_vat_account_id');
  const gap = missing(rules, need);
  if (gap) return { ok: false, error: gap };

  const total = round2(doc.total || 0);
  if (total <= 0) return { ok: false, error: `${doc.number}: nothing to post (total is ${total}).` };
  const net = round2(total - tax);

  const lines: JournalLineInput[] = [
    { account_id: rules.purchase_expense_account_id!, debit: net, credit: 0 },
  ];
  if (tax > 0) lines.push({ account_id: rules.input_vat_account_id!, debit: tax, credit: 0 });
  lines.push({ account_id: rules.ap_account_id!, debit: 0, credit: total, party_type: 'supplier', party_id: doc.party_id ?? null, memo: doc.memo ?? null });

  return {
    ok: true,
    entry: {
      book: 'purchase',
      entry_date: doc.date,
      memo: `Bill ${doc.number}`,
      reference: doc.number,
      source_type: 'vendor_bill',
      source_id: sourceId,
      lines,
    },
  };
}
