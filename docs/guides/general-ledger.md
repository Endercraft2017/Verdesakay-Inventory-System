# Books — the general ledger

**For:** bookkeeper / accountant
**In the app:** Accounting → **General Ledger → Books** (read: *Accounting: view*; set up,
post, close: *Accounting: manage*)

This is a **double-entry** ledger — the BIR "Books of Accounts" kept in the system. It supports manual journals, automatic document postings and financial statements.
Confirmed sale orders and approved vendor bills post using **Posting Rules**. Payroll
requires an explicit **Post to GL** after the cutoff has been reviewed; generating
payslips alone does not post it.

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
reports and automatic posting use to find the right account.

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

The **Periods** tab is where you create and **close** an accounting period. Closing a
period does two things:

1. **Posts the closing journal entry** — every income and expense account is zeroed by
   its movement within the period, and the net (profit or loss) is rolled into
   **Retained Earnings**. After a year-end close the P&L for that year reads flat and
   the amount lives in equity where it belongs.
2. **Locks the range** — *any* posting dated inside it is then rejected, manual journal
   entries and every auto-posted document alike (sales, purchases, payroll, payroll GL,
   job orders), until you **reopen** it (which reverses the closing entry).

A fiscal-year period is created automatically when you set up books; add month- or
quarter-sized ones here if you want a tighter close cadence. Accruals and prepaid
amortization are still your own manual journal entries. Only *Accounting: manage* can
create/close/reopen — anyone with book access can see the list.

## Reports

| Report | What |
|---|---|
| **Trial Balance** | Every account with a balance, debit vs credit columns, must tie |
| **Profit & Loss** | Income − expenses for the range → net income |
| **Balance Sheet** | Assets, liabilities, equity as of a date; current-period earnings folded into equity; `assets = liabilities + equity` check |
| **Cash Flow** | Indirect method — net income, then the period's movement in working-capital / non-cash accounts (operating), non-current assets (investing) and non-current liabilities + equity (financing). The three totals sum to the change in cash & bank (`✓` when they reconcile) |
| **Equity** | Statement of changes in equity — opening / movement / closing per equity account, plus the period's net income (added to retained earnings only at period-end close) |
| **General Ledger** | One account, opening balance + every posted line + running balance + closing |

## Books of Accounts (for BIR CAS registration)

**Accounting → Tax & Compliance → Books of Accounts** pulls the registered set for a
period — **General Journal**, **General Ledger** (every account), **Cash Receipts** and
**Cash Disbursements Books**, **Sales** and **Purchase Journals** — from the posted
ledger. Each book downloads as CSV; **Print all** opens one page-broken document (company
name / TIN / address header, then each book) to print or save as PDF and present with the
system description for CAS registration. The app does not register the system with the BIR
for you.

## Tips & gotchas

- The reports read **posted** entries only — a draft doesn't move any balance.
- If the Balance Sheet says **⚠**, something posted with an unusual sign — check the
  offending account in the General Ledger.
- Keep the **type tags** on cash/AR/AP/VAT/tax accounts accurate — automatic
  posting and financial reports use them. Review the account mappings in Posting Rules.
