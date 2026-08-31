/**
 * Double-entry general ledger — pure helpers + the default PH SMB chart of accounts.
 * Modelled on Frappe Books (Account / JournalEntry / AccountingLedgerEntry). The route
 * (src/routes/accounting.routes.ts) owns the DB; this file is DB-free and unit-testable.
 * See docs/ACCOUNTING-SYSTEM-PLAN.md.
 */

export type RootType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';

/** Debit-natured roots carry a debit balance; the rest carry a credit balance. */
export function naturalSide(root: RootType): 'debit' | 'credit' {
  return root === 'asset' || root === 'expense' ? 'debit' : 'credit';
}

/** Signed balance of an account in *its own natural direction* (always ≥ 0 for a
 *  healthy account): asset/expense = debit − credit; liability/equity/income = credit − debit. */
export function accountBalance(root: RootType, debit: number, credit: number): number {
  return naturalSide(root) === 'debit' ? round2(debit - credit) : round2(credit - debit);
}

export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export interface JournalLineInput {
  account_id: number;
  debit?: number;
  credit?: number;
  party_type?: string | null;
  party_id?: number | null;
  memo?: string | null;
}

export interface AccountRef {
  id: number;
  is_group: number;
  archived: number;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  total_debit: number;
  total_credit: number;
}

/** Validate a set of journal lines against the CAS rules:
 *  ≥ 2 lines, each line has exactly one of debit/credit > 0, every account exists and is
 *  postable (not a group, not archived), and Σ debit === Σ credit. */
export function validateJournalLines(
  lines: JournalLineInput[],
  accounts: Map<number, AccountRef>
): ValidationResult {
  const errors: string[] = [];
  let total_debit = 0;
  let total_credit = 0;

  if (!Array.isArray(lines) || lines.length < 2) {
    errors.push('A journal entry needs at least two lines.');
  }

  (lines || []).forEach((l, i) => {
    const n = i + 1;
    const d = Math.max(0, Number(l.debit) || 0);
    const c = Math.max(0, Number(l.credit) || 0);
    if (d > 0 && c > 0) errors.push(`Line ${n}: a line is either a debit or a credit, not both.`);
    if (d === 0 && c === 0) errors.push(`Line ${n}: enter a debit or a credit amount.`);
    const acc = accounts.get(Number(l.account_id));
    if (!acc) errors.push(`Line ${n}: unknown account.`);
    else if (acc.is_group) errors.push(`Line ${n}: "group" accounts can't be posted to — pick a leaf account.`);
    else if (acc.archived) errors.push(`Line ${n}: that account is archived.`);
    total_debit = round2(total_debit + d);
    total_credit = round2(total_credit + c);
  });

  if (Math.abs(total_debit - total_credit) > 0.005) {
    errors.push(`Out of balance by ${round2(total_debit - total_credit)} — total debits (${total_debit}) must equal total credits (${total_credit}).`);
  }

  return { ok: errors.length === 0, errors, total_debit, total_credit };
}

/** For the balance sheet: current-period profit rolls into equity. */
export interface StatementLine {
  code: string;
  name: string;
  root_type: RootType;
  account_type: string | null;
  parent_id: number | null;
  is_group: number;
  debit: number;
  credit: number;
}

/* --------------------------------------------- default PH SMB chart of accounts --- */

export interface SeedAccount {
  code: string;
  name: string;
  root_type: RootType;
  account_type?: string;
  parent?: string;         // parent code
  is_group?: boolean;
}

/**
 * A conservative Philippine small-business chart of accounts. Seeded on
 * `POST /accounting/ledger/setup`; fully editable afterwards. `account_type` tags the
 * accounts the reports and (later) the auto-posting rules need to find by role.
 */
export const DEFAULT_COA: SeedAccount[] = [
  // ---- Assets ----
  { code: '1000', name: 'Assets', root_type: 'asset', is_group: true },
  { code: '1100', name: 'Current Assets', root_type: 'asset', is_group: true, parent: '1000' },
  { code: '1110', name: 'Cash on Hand', root_type: 'asset', account_type: 'cash', parent: '1100' },
  { code: '1120', name: 'Cash in Bank', root_type: 'asset', account_type: 'bank', parent: '1100' },
  { code: '1130', name: 'Petty Cash Fund', root_type: 'asset', account_type: 'cash', parent: '1100' },
  { code: '1140', name: 'Accounts Receivable', root_type: 'asset', account_type: 'receivable', parent: '1100' },
  { code: '1150', name: 'Inventory', root_type: 'asset', account_type: 'stock', parent: '1100' },
  { code: '1152', name: 'Work in Process', root_type: 'asset', account_type: 'stock', parent: '1100' },
  { code: '1160', name: 'Input VAT', root_type: 'asset', account_type: 'tax', parent: '1100' },
  { code: '1170', name: 'Creditable Withholding Tax', root_type: 'asset', account_type: 'tax', parent: '1100' },
  { code: '1180', name: 'Prepaid Expenses', root_type: 'asset', parent: '1100' },
  { code: '1190', name: 'Advances to Employees', root_type: 'asset', parent: '1100' },
  { code: '1200', name: 'Non-Current Assets', root_type: 'asset', is_group: true, parent: '1000' },
  { code: '1210', name: 'Property, Plant & Equipment', root_type: 'asset', account_type: 'fixed_asset', parent: '1200' },
  { code: '1220', name: 'Accumulated Depreciation', root_type: 'asset', account_type: 'accumulated_depreciation', parent: '1200' },

  // ---- Liabilities ----
  { code: '2000', name: 'Liabilities', root_type: 'liability', is_group: true },
  { code: '2100', name: 'Current Liabilities', root_type: 'liability', is_group: true, parent: '2000' },
  { code: '2105', name: 'Goods Received Not Invoiced', root_type: 'liability', account_type: 'payable', parent: '2100' },
  { code: '2110', name: 'Accounts Payable', root_type: 'liability', account_type: 'payable', parent: '2100' },
  { code: '2120', name: 'Output VAT', root_type: 'liability', account_type: 'tax', parent: '2100' },
  { code: '2130', name: 'Withholding Tax Payable — Compensation', root_type: 'liability', account_type: 'tax', parent: '2100' },
  { code: '2140', name: 'Withholding Tax Payable — Expanded', root_type: 'liability', account_type: 'tax', parent: '2100' },
  { code: '2150', name: 'SSS Payable', root_type: 'liability', parent: '2100' },
  { code: '2160', name: 'PhilHealth Payable', root_type: 'liability', parent: '2100' },
  { code: '2170', name: 'Pag-IBIG Payable', root_type: 'liability', parent: '2100' },
  { code: '2180', name: 'Accrued Expenses', root_type: 'liability', parent: '2100' },
  { code: '2185', name: 'Net Pay Payable', root_type: 'liability', account_type: 'payable', parent: '2100' },
  { code: '2190', name: 'Income Tax Payable', root_type: 'liability', account_type: 'tax', parent: '2100' },
  { code: '2200', name: 'Non-Current Liabilities', root_type: 'liability', is_group: true, parent: '2000' },
  { code: '2210', name: 'Loans Payable', root_type: 'liability', parent: '2200' },

  // ---- Equity ----
  { code: '3000', name: 'Equity', root_type: 'equity', is_group: true },
  { code: '3100', name: "Owner's Capital / Share Capital", root_type: 'equity', parent: '3000' },
  { code: '3200', name: "Owner's Drawings", root_type: 'equity', account_type: 'drawings', parent: '3000' },
  { code: '3300', name: 'Retained Earnings', root_type: 'equity', account_type: 'retained_earnings', parent: '3000' },

  // ---- Income ----
  { code: '4000', name: 'Income', root_type: 'income', is_group: true },
  { code: '4100', name: 'Sales', root_type: 'income', account_type: 'sales', parent: '4000' },
  { code: '4200', name: 'Service Revenue', root_type: 'income', account_type: 'sales', parent: '4000' },
  { code: '4300', name: 'Other Income', root_type: 'income', parent: '4000' },
  { code: '4400', name: 'Sales Returns & Discounts', root_type: 'income', account_type: 'sales', parent: '4000' },

  // ---- Cost of Sales ----
  { code: '5000', name: 'Cost of Sales', root_type: 'expense', is_group: true },
  { code: '5100', name: 'Cost of Goods Sold', root_type: 'expense', account_type: 'cogs', parent: '5000' },
  { code: '5150', name: 'Manufacturing Variance & Scrap', root_type: 'expense', account_type: 'cogs', parent: '5000' },
  { code: '5200', name: 'Freight In', root_type: 'expense', account_type: 'cogs', parent: '5000' },

  // ---- Operating Expenses ----
  { code: '6000', name: 'Operating Expenses', root_type: 'expense', is_group: true },
  { code: '6100', name: 'Salaries & Wages', root_type: 'expense', parent: '6000' },
  { code: '6110', name: "Employer's SSS / PhilHealth / Pag-IBIG", root_type: 'expense', parent: '6000' },
  { code: '6120', name: '13th Month Pay', root_type: 'expense', parent: '6000' },
  { code: '6200', name: 'Rent Expense', root_type: 'expense', parent: '6000' },
  { code: '6300', name: 'Utilities', root_type: 'expense', parent: '6000' },
  { code: '6400', name: 'Supplies Expense', root_type: 'expense', parent: '6000' },
  { code: '6500', name: 'Transportation & Travel', root_type: 'expense', parent: '6000' },
  { code: '6600', name: 'Representation & Entertainment', root_type: 'expense', parent: '6000' },
  { code: '6700', name: 'Professional Fees', root_type: 'expense', parent: '6000' },
  { code: '6800', name: 'Repairs & Maintenance', root_type: 'expense', parent: '6000' },
  { code: '6900', name: 'Depreciation Expense', root_type: 'expense', account_type: 'depreciation', parent: '6000' },
  { code: '6950', name: 'Taxes & Licenses', root_type: 'expense', parent: '6000' },
  { code: '6990', name: 'Miscellaneous Expense', root_type: 'expense', parent: '6000' },
  { code: '9000', name: 'Rounding / Suspense', root_type: 'expense', account_type: 'round_off', parent: '6000' },
];
