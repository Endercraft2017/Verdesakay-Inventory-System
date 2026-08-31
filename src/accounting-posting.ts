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
  sales_returns_account_id?: number | null;  // Sales returns & allowances (debit on a customer credit note)
  ewt_payable_account_id?: number | null;    // Expanded withholding tax payable (credit on a bill with EWT)
  payroll_expense_account_id?: number | null;      // Salaries & Wages (debit — gross, net of late deductions)
  payroll_er_contrib_account_id?: number | null;   // Employer's SSS/PhilHealth/Pag-IBIG (debit)
  sss_payable_account_id?: number | null;          // SSS Payable (credit — employee + employer + EC)
  philhealth_payable_account_id?: number | null;   // PhilHealth Payable (credit)
  pagibig_payable_account_id?: number | null;      // Pag-IBIG Payable (credit)
  withholding_tax_payable_account_id?: number | null; // Withholding Tax Payable — Compensation (credit)
  net_pay_payable_account_id?: number | null;      // Net Pay Payable (credit)
  employee_advance_account_id?: number | null;     // Advances to Employees (credit — cash-advance recovery)
  inventory_asset_account_id?: number | null;      // Inventory (raw materials + finished goods)
  wip_account_id?: number | null;                  // Work in Process (job-order materials in production)
  mfg_variance_account_id?: number | null;         // Manufacturing Variance & Scrap (job-order WIP true-up)
  grir_clearing_account_id?: number | null;        // Goods Received Not Invoiced (receipt → credit; goods bill → debit)
}

export const POSTING_RULE_KEYS: (keyof PostingRules)[] = [
  'ar_account_id', 'sales_income_account_id', 'output_vat_account_id',
  'ap_account_id', 'purchase_expense_account_id', 'input_vat_account_id',
  'sales_returns_account_id', 'ewt_payable_account_id',
  'payroll_expense_account_id', 'payroll_er_contrib_account_id', 'sss_payable_account_id',
  'philhealth_payable_account_id', 'pagibig_payable_account_id', 'withholding_tax_payable_account_id',
  'net_pay_payable_account_id', 'employee_advance_account_id',
  'inventory_asset_account_id', 'wip_account_id', 'mfg_variance_account_id', 'grir_clearing_account_id',
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
  ewt_amount?: number;        // vendor bill only: withheld and remitted to BIR, not the supplier
  grir_amount?: number;       // vendor bill only: the portion of the net that clears Goods
                              // Received Not Invoiced (goods already booked to Inventory at
                              // receipt) instead of hitting purchase expense
}

export interface BuiltEntry {
  book: 'general' | 'sales' | 'purchase' | 'cash_receipts' | 'cash_disbursements' | 'payroll';
  entry_date: string;
  memo: string;
  reference: string;
  source_type: 'sale_order' | 'vendor_bill' | 'payment' | 'credit_note' | 'payroll_run' | 'job_order' | 'goods_receipt';
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
  const need: (keyof PostingRules)[] = ['ap_account_id'];
  const tax = round2(doc.tax_amount || 0);
  if (tax > 0) need.push('input_vat_account_id');
  const ewt = round2(Math.min(doc.ewt_amount || 0, doc.total || 0));
  if (ewt > 0) need.push('ewt_payable_account_id');

  const total = round2(doc.total || 0);
  if (total <= 0) return { ok: false, error: `${doc.number}: nothing to post (total is ${total}).` };
  const net = round2(total - tax);
  const payable = round2(total - ewt);   // EWT is withheld from the supplier and owed to BIR
  // The part of the net that clears Goods Received Not Invoiced (goods already on the
  // balance sheet from the receipt); the remainder is a straight purchase / expense.
  const grir = round2(Math.min(Math.max(doc.grir_amount || 0, 0), net));
  const expense = round2(net - grir);
  if (grir > 0) need.push('grir_clearing_account_id');
  if (expense > 0) need.push('purchase_expense_account_id');
  const gap = missing(rules, need);
  if (gap) return { ok: false, error: gap };

  const lines: JournalLineInput[] = [];
  if (expense > 0) lines.push({ account_id: rules.purchase_expense_account_id!, debit: expense, credit: 0 });
  if (grir > 0) lines.push({ account_id: rules.grir_clearing_account_id!, debit: grir, credit: 0, memo: `Clears GRNI ${doc.number}` });
  if (tax > 0) lines.push({ account_id: rules.input_vat_account_id!, debit: tax, credit: 0 });
  lines.push({ account_id: rules.ap_account_id!, debit: 0, credit: payable, party_type: 'supplier', party_id: doc.party_id ?? null, memo: doc.memo ?? null });
  if (ewt > 0) lines.push({ account_id: rules.ewt_payable_account_id!, debit: 0, credit: ewt, memo: `EWT ${doc.number}` });

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

export interface PaymentDoc {
  number: string;
  date: string;
  direction: 'in' | 'out';        // in = receive from customer, out = pay supplier
  amount: number;
  deposit_account_id: number;     // the cash / bank GL account the money moves through
  party_type: 'customer' | 'supplier';
  party_id?: number | null;
  memo?: string | null;
}

/**
 * A payment. Receipt (`in`): DR Cash/Bank / CR Accounts Receivable.
 * Disbursement (`out`): DR Accounts Payable / CR Cash/Bank. The control-account leg
 * carries the party so the AR / AP subledger nets down.
 */
export function buildPaymentEntry(doc: PaymentDoc, rules: PostingRules, sourceId: number): BuildResult {
  const controlKey: keyof PostingRules = doc.direction === 'in' ? 'ar_account_id' : 'ap_account_id';
  const gap = missing(rules, [controlKey]);
  if (gap) return { ok: false, error: gap };
  if (!doc.deposit_account_id) return { ok: false, error: `${doc.number}: choose the cash / bank account.` };
  const amount = round2(doc.amount || 0);
  if (amount <= 0) return { ok: false, error: `${doc.number}: amount must be greater than zero.` };

  const control = rules[controlKey]!;
  const party = { party_type: doc.party_type, party_id: doc.party_id ?? null, memo: doc.memo ?? null };
  const lines: JournalLineInput[] = doc.direction === 'in'
    ? [
        { account_id: doc.deposit_account_id, debit: amount, credit: 0 },
        { account_id: control, debit: 0, credit: amount, ...party },
      ]
    : [
        { account_id: control, debit: amount, credit: 0, ...party },
        { account_id: doc.deposit_account_id, debit: 0, credit: amount },
      ];

  return {
    ok: true,
    entry: {
      book: doc.direction === 'in' ? 'cash_receipts' : 'cash_disbursements',
      entry_date: doc.date,
      memo: `${doc.direction === 'in' ? 'Receipt' : 'Payment'} ${doc.number}`,
      reference: doc.number,
      source_type: 'payment',
      source_id: sourceId,
      lines,
    },
  };
}

export interface CreditNoteDoc {
  number: string;
  date: string;
  kind: 'customer' | 'supplier';
  subtotal: number;
  tax_amount: number;
  total: number;
  party_id?: number | null;
  memo?: string | null;
}

/**
 * A credit / debit note — a return or allowance that unwinds part of a sale / purchase.
 * Customer credit note: DR Sales Returns (net) / DR Output VAT (tax) / CR AR (gross).
 * Supplier debit note:  DR AP (gross) / CR Purchases (net) / CR Input VAT (tax).
 * The VAT leg is dropped when there is no tax; the net leg is derived as total − tax.
 */
export function buildCreditNoteEntry(doc: CreditNoteDoc, rules: PostingRules, sourceId: number): BuildResult {
  const isCustomer = doc.kind === 'customer';
  const need: (keyof PostingRules)[] = isCustomer
    ? ['ar_account_id', 'sales_returns_account_id']
    : ['ap_account_id', 'purchase_expense_account_id'];
  const tax = round2(doc.tax_amount || 0);
  if (tax > 0) need.push(isCustomer ? 'output_vat_account_id' : 'input_vat_account_id');
  const gap = missing(rules, need);
  if (gap) return { ok: false, error: gap };

  const total = round2(doc.total || 0);
  if (total <= 0) return { ok: false, error: `${doc.number}: nothing to post (total is ${total}).` };
  const net = round2(total - tax);
  const party = isCustomer
    ? { party_type: 'customer', party_id: doc.party_id ?? null, memo: doc.memo ?? null }
    : { party_type: 'supplier', party_id: doc.party_id ?? null, memo: doc.memo ?? null };

  const lines: JournalLineInput[] = isCustomer
    ? [
        { account_id: rules.sales_returns_account_id!, debit: net, credit: 0 },
        ...(tax > 0 ? [{ account_id: rules.output_vat_account_id!, debit: tax, credit: 0 }] : []),
        { account_id: rules.ar_account_id!, debit: 0, credit: total, ...party },
      ]
    : [
        { account_id: rules.ap_account_id!, debit: total, credit: 0, ...party },
        { account_id: rules.purchase_expense_account_id!, debit: 0, credit: net },
        ...(tax > 0 ? [{ account_id: rules.input_vat_account_id!, debit: 0, credit: tax }] : []),
      ];

  return {
    ok: true,
    entry: {
      book: isCustomer ? 'sales' : 'purchase',
      entry_date: doc.date,
      memo: `${isCustomer ? 'Credit note' : 'Debit note'} ${doc.number}`,
      reference: doc.number,
      source_type: 'credit_note',
      source_id: sourceId,
      lines,
    },
  };
}

/** One `generate-payslips` run's totals, already summed across the roster (see
 *  src/accounting-autopost.ts's maybeAutoPostPayroll for how these are aggregated from the
 *  hr_payroll form_records). All employee-side figures are net of each employee's own
 *  deduct_* flags (zeroed on the payslip already); er_contrib_total likewise. */
export interface PayrollDoc {
  number: string;          // the payroll_period label, used as memo/reference
  date: string;             // pay_date (falls back to today) — entry_date
  gross_total: number;      // Σ total_earnings
  late_total: number;       // Σ late_absences — netted out of the gross debit, owed to no one
  er_contrib_total: number; // Σ employer_contributions.* (SSS/PhilHealth/Pag-IBIG employer share + EC)
  sss_payable_total: number;         // Σ sss (employee) + the SSS portion of er_contrib_total
  philhealth_payable_total: number;  // Σ philhealth (employee) + employer share
  pagibig_payable_total: number;     // Σ pagibig (employee) + employer share
  withholding_tax_total: number;     // Σ withholding_tax (employee-withheld, owed to BIR)
  net_pay_total: number;             // Σ net_pay — what's actually paid out
  cash_advance_total: number;        // Σ cash_advance recovered this run
}

/**
 * A payroll run: DR Salaries & Wages (gross − late deductions) / DR Employer contributions
 * expense / CR SSS·PhilHealth·Pag-IBIG payable / CR Withholding Tax payable / CR Net Pay
 * payable / CR Advances to Employees (cash-advance recovery). Each payable/advance line is
 * only required (and only appears) when its total is nonzero, same as `ewt_payable_account_id`
 * in buildPurchaseEntry above. The four component sums plus net pay and cash-advance recovery
 * are constructed so debits equal credits by construction — see the derivation in the payroll
 * gap-fix plan; this still double-checks with a cents-tolerant sum comparison, since a run
 * assembled from partly hand-edited payslips (auto_statutory off) isn't guaranteed to satisfy
 * that identity the way a single computed document always is.
 */
export function buildPayrollEntry(doc: PayrollDoc, rules: PostingRules, sourceId: number): BuildResult {
  const need: (keyof PostingRules)[] = ['payroll_expense_account_id', 'net_pay_payable_account_id'];
  const sss = round2(doc.sss_payable_total || 0);
  const philhealth = round2(doc.philhealth_payable_total || 0);
  const pagibig = round2(doc.pagibig_payable_total || 0);
  const wht = round2(doc.withholding_tax_total || 0);
  const erContrib = round2(doc.er_contrib_total || 0);
  const cashAdvance = round2(doc.cash_advance_total || 0);
  if (sss > 0) need.push('sss_payable_account_id');
  if (philhealth > 0) need.push('philhealth_payable_account_id');
  if (pagibig > 0) need.push('pagibig_payable_account_id');
  if (wht > 0) need.push('withholding_tax_payable_account_id');
  if (erContrib > 0) need.push('payroll_er_contrib_account_id');
  if (cashAdvance > 0) need.push('employee_advance_account_id');
  const gap = missing(rules, need);
  if (gap) return { ok: false, error: gap };

  const grossNet = round2((doc.gross_total || 0) - (doc.late_total || 0));
  if (grossNet <= 0) return { ok: false, error: `${doc.number}: nothing to post (net gross is ${grossNet}).` };
  const netPay = round2(doc.net_pay_total || 0);

  const lines: JournalLineInput[] = [
    { account_id: rules.payroll_expense_account_id!, debit: grossNet, credit: 0, memo: `Payroll ${doc.number}` },
  ];
  if (erContrib > 0) lines.push({ account_id: rules.payroll_er_contrib_account_id!, debit: erContrib, credit: 0 });
  if (sss > 0) lines.push({ account_id: rules.sss_payable_account_id!, debit: 0, credit: sss });
  if (philhealth > 0) lines.push({ account_id: rules.philhealth_payable_account_id!, debit: 0, credit: philhealth });
  if (pagibig > 0) lines.push({ account_id: rules.pagibig_payable_account_id!, debit: 0, credit: pagibig });
  if (wht > 0) lines.push({ account_id: rules.withholding_tax_payable_account_id!, debit: 0, credit: wht });
  if (cashAdvance > 0) lines.push({ account_id: rules.employee_advance_account_id!, debit: 0, credit: cashAdvance });
  lines.push({ account_id: rules.net_pay_payable_account_id!, debit: 0, credit: netPay, memo: `Payroll ${doc.number}` });

  const totalDebit = round2(lines.reduce((s, l) => s + (l.debit || 0), 0));
  const totalCredit = round2(lines.reduce((s, l) => s + (l.credit || 0), 0));
  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    return {
      ok: false,
      error: `${doc.number}: doesn't balance (debits ${totalDebit} vs credits ${totalCredit}) — check ` +
        `payslips in this run for hand-edited totals that don't add up (this can happen when auto ` +
        `statutory computation is off), then try posting again.`,
    };
  }

  return {
    ok: true,
    entry: {
      book: 'payroll',
      entry_date: doc.date,
      memo: `Payroll ${doc.number}`,
      reference: doc.number,
      source_type: 'payroll_run',
      source_id: sourceId,
      lines,
    },
  };
}

/** One movement of a manufacturing job order's cost between Inventory and Work in Process.
 *  A job order posts several of these under the same `source_id`:
 *   - `release`  — raw materials leave stock into production: DR WIP / CR Inventory.
 *   - `produce`  — finished units enter stock: DR Inventory / CR WIP (at standard cost:
 *                  Σ component qty_per_unit × unit_cost).
 *   - `settle`   — the job order closes: whatever WIP balance is left is split back to
 *                  Inventory (unconsumed components physically returned) and Manufacturing
 *                  Variance & Scrap (components consumed by scrapped units + rounding),
 *                  zeroing the job order's WIP. `amount` is the residual WIP debit balance
 *                  (may be negative if over-relieved); `return_amount` is the Inventory
 *                  portion. */
export interface JobOrderMoveDoc {
  number: string;   // MO-xxxxx
  date: string;
  kind: 'release' | 'produce' | 'settle';
  amount: number;
  return_amount?: number;   // settle only
}

export function buildJobOrderEntry(doc: JobOrderMoveDoc, rules: PostingRules, sourceId: number): BuildResult {
  const inv = rules.inventory_asset_account_id;
  const wip = rules.wip_account_id;
  const gap = missing(rules, ['inventory_asset_account_id', 'wip_account_id']);
  if (gap) return { ok: false, error: gap };

  const lines: JournalLineInput[] = [];
  let memo: string;

  if (doc.kind === 'release') {
    const amt = round2(doc.amount || 0);
    if (amt <= 0) return { ok: false, error: `${doc.number}: nothing to release into production.` };
    lines.push({ account_id: wip!, debit: amt, credit: 0 });
    lines.push({ account_id: inv!, debit: 0, credit: amt });
    memo = `${doc.number}: materials released to production`;
  } else if (doc.kind === 'produce') {
    const amt = round2(doc.amount || 0);
    if (amt <= 0) return { ok: false, error: `${doc.number}: nothing produced to post.` };
    lines.push({ account_id: inv!, debit: amt, credit: 0 });
    lines.push({ account_id: wip!, debit: 0, credit: amt });
    memo = `${doc.number}: finished goods from WIP`;
  } else {
    const bal = round2(doc.amount || 0);            // residual WIP debit balance
    if (Math.abs(bal) < 0.005) return { ok: false, error: `${doc.number}: WIP is already settled.` };
    const ret = round2(doc.return_amount || 0);
    const variance = round2(bal - ret);
    if (variance !== 0 && !rules.mfg_variance_account_id) {
      return { ok: false, error: missing(rules, ['mfg_variance_account_id'])! };
    }
    if (ret > 0) lines.push({ account_id: inv!, debit: ret, credit: 0 });
    else if (ret < 0) lines.push({ account_id: inv!, debit: 0, credit: -ret });
    if (variance > 0) lines.push({ account_id: rules.mfg_variance_account_id!, debit: variance, credit: 0 });
    else if (variance < 0) lines.push({ account_id: rules.mfg_variance_account_id!, debit: 0, credit: -variance });
    if (bal > 0) lines.push({ account_id: wip!, debit: 0, credit: bal });
    else lines.push({ account_id: wip!, debit: -bal, credit: 0 });
    memo = `${doc.number}: job order closed — WIP settled`;
  }

  return {
    ok: true,
    entry: {
      book: 'general',
      entry_date: doc.date,
      memo,
      reference: doc.number,
      source_type: 'job_order',
      source_id: sourceId,
      lines,
    },
  };
}

/** A goods receipt: perpetual inventory recognises the stock as it arrives, against a
 *  clearing account the vendor bill later settles.  DR Inventory / CR Goods Received Not
 *  Invoiced, valued at the purchase-order line price (× received qty). */
export interface ReceiptDoc {
  number: string;   // GRN-xxxxx
  date: string;
  amount: number;   // Σ received qty × PO unit price
}

export function buildReceiptEntry(doc: ReceiptDoc, rules: PostingRules, sourceId: number): BuildResult {
  const gap = missing(rules, ['inventory_asset_account_id', 'grir_clearing_account_id']);
  if (gap) return { ok: false, error: gap };
  const amt = round2(doc.amount || 0);
  if (amt <= 0) return { ok: false, error: `${doc.number}: nothing to value (amount is ${amt}).` };
  return {
    ok: true,
    entry: {
      book: 'general',
      entry_date: doc.date,
      memo: `Goods receipt ${doc.number}`,
      reference: doc.number,
      source_type: 'goods_receipt',
      source_id: sourceId,
      lines: [
        { account_id: rules.inventory_asset_account_id!, debit: amt, credit: 0 },
        { account_id: rules.grir_clearing_account_id!, debit: 0, credit: amt },
      ],
    },
  };
}
