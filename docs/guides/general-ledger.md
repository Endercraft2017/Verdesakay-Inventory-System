# Books — the general ledger

**For:** bookkeeper / accountant
**In the app:** Accounting → **General Ledger → Books** (read: *Accounting: view*; set up,
post, close: *Accounting: manage*)

This is a **double-entry** ledger — the BIR "Books of Accounts" kept in the system. It's
**Phase 0**: manual journal entries + the core financial statements. Auto-posting from
invoices, bills and payslips comes later (see `docs/ACCOUNTING-SYSTEM-PLAN.md`).

---

## First time: set up books

Click **Set up books**. It creates:

- a standard **Philippine small-business chart of accounts** (~50 accounts — cash, AR, AP,
  inventory, input/output VAT, withholding-tax payables, SSS/PhilHealth/Pag-IBIG payables,
  sales, COGS, the usual operating expenses, equity), and
- your first **fiscal year** (starts on the date you pick).

Everything is editable afterwards.

## Chart of Accounts

The account tree. Two kinds of account:

- **Group** (header) — organises the tree; you **can't post to it**.
- **Leaf** — holds a balance; journal lines point here.

Each account has a **root type** (asset / liability / equity / income / expense) and an
optional **type tag** (`cash`, `bank`, `receivable`, `payable`, `tax`, `cogs`, …) that the
reports and later the auto-posting use to find the right account.

Rules: an account **with entries** can be renamed or **archived** but **not deleted** and
**not re-typed**. A group with sub-accounts can't become a leaf.

## Journal entries

**New entry** → pick a date and a **book** (general / sales / purchase / cash receipts /
cash disbursements / payroll), then add lines. Each line is **either a debit or a
credit**. The footer shows a running total and a **✓ balanced** / **out by …** check —
total debits must equal total credits.

Lifecycle:

1. **Draft** — editable, deletable.
2. **Post** — locks the numbers, stamps who/when, and it enters the ledger. Posted
   entries get a **gapless number** (`JV-000001`).
3. **Reverse** — a posted entry is **never edited or deleted**. Reversing it posts a
   mirror entry (debits and credits swapped); both stay in the ledger and net to zero.
   The original shows a **reversed** badge.

Posting an entry dated inside a **closed period** is rejected.

## Periods

**Trial Balance / P&L / Balance Sheet** tabs → each has a **period picker**, unrelated to
the ones below (those are just date ranges for a report).

The **Periods** tab is where you create and **close** an accounting period —
closing locks *any* posting dated inside its range, manual journal entries and every
auto-posted document alike (sales, purchases, payroll, payroll GL, job orders), until
you **reopen** it. A fiscal-year period is created automatically when you set up books;
add month- or quarter-sized ones here if you want a tighter close cadence. Only
*Accounting: manage* can create/close/reopen — anyone with book access can see the list.

## Reports

| Report | What |
|---|---|
| **Trial Balance** | Every account with a balance, debit vs credit columns, must tie |
| **Profit & Loss** | Income − expenses for the range → net income |
| **Balance Sheet** | Assets, liabilities, equity as of a date; current-period earnings folded into equity; `assets = liabilities + equity` check |
| **General Ledger** | One account, opening balance + every posted line + running balance + closing |

## Tips & gotchas

- The reports read **posted** entries only — a draft doesn't move any balance.
- If the Balance Sheet says **⚠**, something posted with an unusual sign — check the
  offending account in the General Ledger.
- Keep the **type tags** on cash/AR/AP/VAT/tax accounts accurate — Phase 1's automatic
  posting from sales orders / vendor bills / payslips will rely on them.
