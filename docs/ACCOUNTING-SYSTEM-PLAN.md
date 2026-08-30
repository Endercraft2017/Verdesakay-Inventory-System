# Accounting Module — Plan for a Complete Philippine System

> **Status:** the "Accounting" section now has **tax & statutory reporting** (BIR 1601-C /
> 1604-C / 2316 / Alphalist / 0619-E / 2550M + SSS / PhilHealth / Pag-IBIG schedules), a
> **Petty Cash** register (§6.5), and — as of **2026-08-30** — **Phase 0 of the general
> ledger**: chart of accounts, fiscal periods, manual journal entries (draft → post →
> reverse, gapless numbers, closed-period lock), and the Trial Balance / P&L / Balance
> Sheet / General Ledger reports (§5). Built modelled on **Frappe Books** (§9–10) — same
> stack (SQLite + Node/JS); AGPL, so design reference only (reimplemented). Phases 1–5
> below (auto-posting, VAT/EWT registers, financial-statement polish, CAS export) are the
> roadmap.
> Companion to [GO-TO-MARKET.md](GO-TO-MARKET.md) (Pillar 1 is the payroll/tax wedge —
> a real GL is the natural extension) and [SAAS-READINESS.md](SAAS-READINESS.md).

---

## 1. What "complete" means in the Philippines

A Philippine business's accounting system has to satisfy **three masters** at once:

| Master | What it wants | Our obligation |
|---|---|---|
| **BIR** (tax) | Registered Books of Accounts, VAT/withholding compliance, an audit trail, 10-year retention, and the exact return + relief files | Produce every figure and every upload file; keep the audit trail |
| **SEC** (for stock corporations / OPCs) | Audited Financial Statements filed annually, prepared under **PFRS for SMEs** | Produce BS / IS / cash-flow / equity / notes-ready data a CPA can audit |
| **The owner** | Know if the business is making money, who owes what, and how much cash there is | Real-time P&L, balance sheet, AR/AP aging, cash position |

### 1.1 Books of Accounts (BIR)

Every taxpayer keeps books in one of three forms — **manual**, **loose-leaf**, or
**computerized (CAS)**. The mandatory set for most SMBs:

- **General Journal** — all journal entries, chronological.
- **General Ledger** — the same entries posted by account; the source of the trial balance.
- **Cash Receipts Book** and **Cash Disbursements Book** — cash in / cash out.
- **Sales Journal** and **Purchase Journal** — required once VAT-registered (and useful
  before that).
- **Subsidiary ledgers** — AR by customer, AP by supplier, inventory, fixed assets.

A **Computerized Accounting System** must be **registered with the BIR before use**
(RMC 87-2025 consolidated the rules). Registration expects: a **tamper-evident audit
trail** on every entry, **sequential document numbering**, **role-based access**,
**data that reconciles to the GL without manual intervention**, and **10-year
retention** with export. Material changes to a registered system need BIR approval.
Separately, businesses must be CAS-certified before EIS (e-invoicing) certification,
targeted for **31 Dec 2026**.

> **Implication for us:** if we ship a GL, the customer's instance becomes "their CAS".
> We must design for the audit-trail / immutability / numbering / export rules from day
> one, and give the customer the artefacts (system description, sample reports, printouts)
> they submit for CAS registration. We do **not** register on their behalf.

### 1.2 Financial statements (SEC / PFRS for SMEs)

An SME (total assets ₱3M–₱350M or liabilities ₱3M–₱250M, not publicly accountable) uses
**PFRS for SMEs**. The Audited Financial Statements — **balance sheet, income statement,
statement of cash flows, statement of changes in equity, and notes** — are prepared by a
**BOA-accredited CPA**, attached to the annual income tax return, and (for corporations)
filed with the SEC. We don't do the audit; we produce a clean trial balance and the five
statements in a form the CPA can take over.

### 1.3 The BIR return + file calendar (what the GL must feed)

| Form / file | What | Cadence | Source in our data |
|---|---|---|---|
| **2550M** *(being phased toward quarterly-only)* / **2550Q** | VAT declaration — output − input VAT | monthly / by the 25th after quarter | sales journal (output), purchase journal (input) |
| **SLSP / RELIEF** (Summary List of Sales & Purchases) | per-transaction sales & purchases `.DAT` | with 2550Q (quarterly, if over threshold) | sales & purchase journals + party TINs |
| **0619-E** | monthly expanded-withholding remittance | by the 10th | AP / disbursements tagged with an ATC |
| **1601-EQ** + **QAP** (Quarterly Alphalist of Payees) | quarterly EWT return + payee detail | by the last day of the month after quarter | AP withholding register |
| **2307** | Certificate of Creditable Tax Withheld — **issued** to each supplier we withheld from | per payment / quarterly | AP withholding register |
| **SAWT** | Summary Alphalist of Withholding Taxes — 2307s we **received** as customers | with the income tax return | AR side / manual entry of received 2307s |
| **1601-C / 1604-C / Alphalist / 2316** | withholding on **compensation** | monthly / annual | **payroll (already built)** |
| **1604-E** | annual alphalist of expanded withholding | by Mar 1 | AP withholding register |
| **1702Q** / **1702-RT** (or **1701Q/1701** for sole prop) | quarterly / annual income tax | quarterly + annual | trial balance → taxable income reconciliation |
| **0605** | payment form (registration fee, deficiency, etc.) | as needed | manual |
| **AFS** | audited financial statements | annual, 15 days after the ITR | trial balance → the five statements |
| **Books of Accounts** | the registered books themselves | kept current; presented on audit | the GL / journals, exportable + printable |

Payroll-side forms are **done**. Everything else needs a general ledger underneath it.

---

## 2. Where the current app already touches accounting

The GL doesn't have to invent transactions — most already exist as documents. The job is
to **post** them.

| Existing module | Becomes / posts to |
|---|---|
| **Sale orders** (`orders` type `sale`) | Sales Journal → Dr AR / Cash, Cr Sales, Cr Output VAT |
| **Vendor bills** (`vendor_bills`, approved) | Purchase Journal → Dr Expense/Inventory, Dr Input VAT, Cr AP; Cr EWT payable if withheld |
| **Goods receipts** (`goods_receipts`) | Perpetual inventory → Dr Inventory, Cr GR/IR clearing (cleared by the bill) |
| **Payslips** (`hr_payroll` records) | Payroll Journal → Dr Salaries, Dr ER contributions, Cr SSS/PHIC/HDMF payable, Cr WT payable, Cr Cash/Net-pay payable |
| **Stock adjustments / damage** (`inventory_transactions`) | Inventory shrinkage / write-off entries |
| **Job orders** (WIP consumption + finished-goods) | Manufacturing journal → Dr WIP, Cr Raw materials; Dr Finished goods, Cr WIP |
| **QuickBooks push** (`src/quickbooks.ts`) | Interim bridge — a customer can keep QBO as the GL while we build ours; once ours exists, it's the same posting logic pointed inward |

So the incremental work is: a **chart of accounts**, a **journal-entry engine**, a
**posting rule per document type**, **period close**, and the **reports**.

---

## 3. Target architecture

### 3.1 Data model (new tables)

```
accounts               id, code, name, type(asset|liability|equity|income|expense),
                       subtype(current_asset|fixed_asset|ap|ar|vat_output|vat_input|
                               ewt_payable|wt_payable|retained_earnings|...),
                       parent_id, is_postable, currency, bir_mapping, archived, sort
accounting_periods     id, name('2026-01'), start_date, end_date,
                       status(open|soft_closed|closed), closed_by, closed_at
journal_entries        id, number('JV-2026-000123' — sequential, gapless per book),
                       book(general|sales|purchase|cash_receipts|cash_disbursements|payroll),
                       entry_date, memo, source_type, source_id,   -- link back to the order/bill/payslip
                       status(draft|posted|void), posted_by, posted_at,
                       void_of_entry_id,        -- reversing entry, never delete a posted row
                       created_by, created_at
journal_lines          id, entry_id, account_id, debit, credit, currency, fx_rate,
                       party_type(customer|supplier|employee|null), party_id,
                       tax_code, atc, memo, sort
                       -- Σ debit == Σ credit per entry, enforced at post time
tax_codes              code('VAT12'|'VATEX'|'ZERO'|'EWT2'|...), name, kind(output_vat|
                       input_vat|ewt|none), rate, account_id
account_opening_balances  account_id, period_id, debit, credit   -- migration / go-live
bank_accounts          id, account_id(→accounts), bank_name, number, currency
bank_statement_lines   id, bank_account_id, date, description, amount, matched_entry_id,
                       imported_batch, reconciled
fixed_assets           id, account_id, name, acquired_date, cost, salvage,
                       useful_life_months, method(straight_line), accum_account_id,
                       expense_account_id, disposed_date
recurring_entries      id, template(journal_lines JSON), cadence, next_run, active
```

**Non-negotiables (CAS):** `journal_entries.number` is **sequential and gapless** per
book; a **posted** entry is **never edited or deleted** — corrections are a **reversing
entry** + a fresh one; every insert/void is in `activity_log` (already app-wide);
`accounting_periods` gate posting (no back-dating into a `closed` period).

### 3.2 Posting engine

`src/accounting/post.ts` (pure where possible): `buildEntry(sourceType, sourceId,
rules)` → a balanced `{lines[]}` from a document + the company's **posting rules**
(which account each thing hits — configurable, seeded with a sensible default COA).
`postEntry(entry)` validates (balanced, period open, accounts postable), assigns the
gapless number, writes `journal_entries` + `journal_lines`, and stamps the source.

`maybePost(sourceType, sourceId)` hooks fire **after** the existing document actions
(sale order confirmed, vendor bill approved, payslip batch generated, goods receipt
posted) — same best-effort pattern as `maybeAutoPush` for QuickBooks. A document can be
**posted** or **unposted (draft)**; unposting is only allowed in an open period and
writes a reversing entry.

### 3.3 Chart of accounts

Ship a **default PH SMB COA** (seed), editable. ~60 accounts across the 5 types, each
pre-tagged with its BIR/FS mapping (`vat_output`, `vat_input`, `ewt_payable`,
`wt_payable`, `sss_payable`, `retained_earnings`, `sales`, `cogs`, …) so the reports and
return worksheets can find the right balances without the user wiring anything.

---

## 4. Reports & outputs

### 4.1 Core statements (from the trial balance)

- **Trial Balance** (period + as-of), with drill-through to the ledger and to the source
  document.
- **General Ledger** per account; **Journal** listing per book — both **printable in the
  BIR book format** and CSV/PDF export (this *is* the Books of Accounts).
- **Balance Sheet**, **Income Statement**, **Statement of Cash Flows** (indirect),
  **Statement of Changes in Equity** — PFRS-for-SMEs line structure, comparative
  (this period vs last).
- **AR Aging** / **AP Aging** by party (we have primitive AP aging already — this
  replaces it with the ledger-backed version).
- **Cash position** across bank accounts; **budget vs actual** (later).

### 4.2 Tax outputs (extend what exists)

- **2550M/2550Q** — already a worksheet from orders/bills; re-source from the sales &
  purchase **journals** once they exist (more accurate: handles credit notes, mixed VAT
  codes, exempt/zero-rated).
- **SLSP / RELIEF `.DAT`** — per-transaction sales & purchases with party name + TIN +
  address, in the BIR RELIEF layout. New.
- **0619-E / 1601-EQ + QAP / 1604-E / 2307 issuance / SAWT** — from a **withholding
  register** built as AP entries are tagged with an ATC. 0619-E worksheet exists; the
  register + QAP + 2307 printing + 1604-E are new.
- **1702Q / 1702-RT** worksheet — trial balance → book income → the common
  add-backs/deductions → tax due; attach the AFS. New.
- **Books of Accounts export** for CAS presentation. New.

### 4.3 Bank reconciliation

Import a bank statement (CSV/OFX), auto-match to posted entries by amount/date/ref,
manual-match the rest, book bank charges/interest on the fly, produce the reconciliation
statement.

---

## 5. Build order (phased — ship each)

**Phase 0 — foundation. ✅ SHIPPED 2026-08-30.** `accounts` + `accounting_periods` +
`journal_entries` + `journal_lines`; `src/ledger.ts` (`DEFAULT_COA` + pure validators);
`POST /api/accounting/ledger/setup` seeds the PH SMB COA + fiscal year; **Accounting →
General Ledger → Books** (`public/js/views/accounting-ledger.js`) — Chart of Accounts
tree CRUD, Journal (draft → post → reverse, gapless `JV-` numbers), **Trial Balance /
Profit & Loss / Balance Sheet / General Ledger** reports, period close/reopen.
Invariants: balanced entries, immutable once posted (reverse, don't edit/delete),
closed-period lock, `activity_log` on every write. `tests/ledger.test.ts` +
`tests/accounting.test.ts`. *No automation yet — a usable, CAS-shaped manual GL.*

**Phase 1 — AR / AP subledgers + auto-posting sales & purchases.** Posting rules +
`maybePost` hooks on **sale-order confirm** and **vendor-bill approve**. Customer &
supplier become parties with a ledger. Ledger-backed **AR/AP aging**. Credit / debit
notes. Payments (receive-from-customer, pay-supplier) as cash entries that settle
invoices. **Sales Journal / Purchase Journal** in BIR format.

**Phase 2 — VAT + withholding, properly.** `tax_codes` on lines; **input/output VAT**
accounts driven by the codes; **EWT** tagging on AP → the **withholding register**.
Re-source **2550M/2550Q** from the journals; add **SLSP `.DAT`**, **1601-EQ + QAP**,
**2307 printing**, **1604-E**. Cash receipts / disbursements books.

**Phase 3 — payroll & inventory into the GL.** Post the **payroll journal** from each
payslip batch (this is where the *"enable/disable the SSS/PhilHealth/Pag-IBIG deduction
per employee"* control feeds in — see §6). Perpetual **inventory / COGS** postings from
goods receipts + shipments + adjustments; **GR/IR clearing**. Manufacturing WIP.

**Phase 4 — statements, close, assets, bank rec.** PFRS-for-SMEs **BS / IS / cash flow /
equity**; **period-end close** (accruals, prepaid amortization, depreciation run,
retained-earnings roll-up); **fixed-asset register + depreciation**; **bank
reconciliation**; **recurring entries**; **1702Q/1702-RT** worksheet + AFS pack;
**Books of Accounts export** for CAS registration.

**Phase 5 — multi-currency, multi-entity, budgets, dimensions** (cost centre / project
/ department tags on lines), consolidation. Later.

**Cross-cutting:** every phase respects the CAS rules (immutable posted entries, gapless
numbers, closed-period lock, `activity_log` on every post/void, 10-year-safe export).
Each report gets an in-app Help topic + a `docs/guides/` entry, same as everything else.

---

## 6. Statutory deductions ↔ payroll (the immediate ask)

The user asked that **SSS / PhilHealth / Pag-IBIG (and withholding tax)** be controllable
**per employee** from Accounting — "enable the subtraction of each employee or not".

**Shipping now (ahead of the GL):**

- `employees` gains four flags — `deduct_sss`, `deduct_philhealth`, `deduct_pagibig`,
  `deduct_withholding_tax` (default **on**; migration ALTER, all existing employees =
  on).
- **`generate-payslips`** already computes each contribution when
  `payroll_policy.auto_statutory` is on. It now also checks the per-employee flag and
  **zeroes** that one deduction (and drops it from `total_deductions` / `net_pay`) when
  the flag is off. `auto_statutory` stays the company-wide master switch.
- **Accounting → Statutory Deductions** screen (`accounting.manage`): a grid of
  employees × the four toggles, with "enable all / disable all" per column and a search.
  Reads/writes `PUT /api/accounting/statutory-deductions`.
- The **contribution schedules** (§4.2) and the payroll journal (§5 Phase 3) then only
  include employees whose flag is on — so the SSS R-3 / PhilHealth / Pag-IBIG uploads and
  the GL match the payslips automatically.

**Why Accounting owns the toggle:** whether a given person's statutory deduction is taken
is a compliance/finance decision (e.g. a contractor on the payroll for convenience, a
seconded employee whose home entity remits, an owner-employee). HR runs the payroll;
Accounting decides what's remitted.

**New permission:** `accounting.manage` (roles: `accounting`, `admin`) for the writes on
this screen and, later, for posting/period-close in the GL. `accounting.view` stays
read-only for the reports.

## 6.5 Petty cash (shipped 2026-08-30)

Ahead of the GL, **Accounting → Cash → Petty Cash** is a standalone register:

- **`petty_cash_funds`** — named funds (custodian, optional location, opening float,
  currency, active flag).
- **`petty_cash_entries`** — one row per **money in** (`direction='in'`) or **money out**
  (`out`): date, amount (> 0), category (datalist of common ones), payee/source,
  reference no. (OR / voucher), notes, `recorded_by`.
- `GET /api/accounting/petty-cash/funds` returns each fund's live balance;
  `GET .../funds/:id/entries?from=&to=&format=csv` returns the register with a **running
  balance per row**, the **opening balance carried into the range**, in/out totals, and
  the closing balance. Writes need `accounting.manage`; a fund with entries can't be
  deleted (deactivate instead).

**GL mapping (Phase 2):** each `in` becomes a **Cash Receipts Book** line
(Dr Petty Cash, Cr the source account), each `out` a **Cash Disbursements Book** line
(Dr the expense/`category` account, Cr Petty Cash). A **replenishment** is the fund
top-up from the main cash/bank account. `category` becomes a link to a COA account once
the chart exists; until then it's free text.

---

## 7. What we are *not* doing

- **Being the CPA / filing on the client's behalf.** We produce figures, worksheets and
  upload files; a human files them.
- **Registering the CAS with the BIR for them.** We provide the system description +
  sample outputs; they register.
- **Full IFRS / consolidation / segment reporting.** PFRS for SMEs is the ceiling for
  the target customer.
- **Replacing an external auditor's working papers.** The trial balance and statements
  are the handoff point.

---

## 8. Effort sketch

| Phase | Rough size | Unlocks |
|---|---|---|
| 0 — manual GL | medium | **done 2026-08-30** — COA, journal, TB / P&L / BS / GL, periods |
| 1 — AR/AP + auto sales/purchases | large | the GL fills itself; real aging |
| 2 — VAT + EWT registers + files | large | the BIR non-payroll returns |
| 3 — payroll + inventory posting | medium | full P&L without manual entry |
| 4 — statements + close + assets + bank rec | large | AFS pack; audit-ready |
| §6 — per-employee statutory toggles | small | **done** (independent of the GL) |
| §6.5 — petty cash register | small | **done** — money in/out per fund, running balance, CSV; feeds the cash books in Phase 2 |

Recommendation: ship **§6 now**, then **Phase 0** as the next standalone feature after
GO-TO-MARKET §6's remaining core items (SSO/2FA), since a manual GL is immediately
sellable and everything else builds on it.

---

## 9. Reference implementations to build from

We are not inventing double-entry bookkeeping. Study a working system's **data model,
posting rules, chart of accounts and report layouts**, then reimplement in our stack.
**Licensing matters:** most FOSS accounting apps are **AGPL / GPL** copyleft — we can read
and learn from them, but we must **not paste their code** into this (proprietary, SaaS)
product. Only permissively-licensed code can be vendored.

### Primary basis — **Frappe Books** (`github.com/frappe/books`)  ← DECIDED (2026-08-30)

The closest match to our constraints: **SQLite** file as the database (same as our
`node:sqlite`), **JavaScript/Node** backend, SMB-scoped, offline-first, small and
readable. Its model is exactly the shape §3.1 sketches:

| Frappe Books | Our equivalent |
|---|---|
| `Account` (tree chart of accounts) | `accounts` |
| `JournalEntry` + child lines | `journal_entries` + `journal_lines` (manual) |
| `AccountingLedgerEntry` (immutable posting lines) | `journal_lines` as the ledger — one row per Dr/Cr |
| `Party` (+ Address child) | reuse `customers` (implicit today) / `suppliers` |
| `SalesInvoice` / `PurchaseInvoice` (+ item child tables) | our existing `orders` (sale) / `vendor_bills` |
| `Payment` (+ `PaymentFor` allocation child) | new `payments` settling invoices |
| "on submit → create AccountingLedgerEntry rows" | `maybePost(sourceType, sourceId)` hooks (§3.2) |

Take from it: the **schema-driven doc + lifecycle-hook** pattern, the **posting-on-submit**
flow, the **default chart of accounts** JSON, the financial-statement builder, and the
**void-not-delete** correction rule. **License: AGPL-3.0 — design reference only.**

### Secondary references (features & patterns, not code)

- **ERPNext — Accounts module** (`github.com/frappe/erpnext`, GPL-3). The mature reference
  for an **ERP** (not standalone bookkeeping) — *every* submitted document (stock,
  manufacturing, payroll) auto-creates a **GL Entry**; multi-currency; period close;
  the financial-statement report builder; a country **tax-localization** pattern (see the
  India GST layer) that a PH layer would mirror. Our system is an ERP, so this is the
  right structural model.
- **Bigcapital** (`github.com/bigcapitalhq/bigcapital`, AGPL-3, **Node + TypeScript** +
  Postgres/React). The most **product-comparable** — SMB double-entry with polished
  financial statements, AR/AP aging, cash-flow, inventory. Study its report UX and API
  shape.
- **LedgerSMB** (`ledgersmb.org`, GPL-2) — decades of double-entry correctness, the
  subsidiary-ledger ↔ GL separation, tax tables.

### Code we *could* actually reuse

- **`medici`** (npm, **MIT**) — a Node double-entry **ledger primitive**: books → journal
  entries → transactions, `void()` posts a reversing entry instead of deleting, balance
  queries. It's Mongoose-only, so port the **invariants** (not the storage) to our
  `journal_entries` / `journal_lines`: balanced entries, immutable once posted, voided via
  reversal, per-book gapless numbering. Effectively the spec for our ledger engine.

### PH compliance layer — no FOSS shortcut

None of the above ship BIR compliance. The RELIEF/SLSP `.DAT`, 2550Q, 1601-EQ + QAP,
2307 issuance, alphalists, books-of-accounts printouts and the CAS audit-trail rules
(§1, §4.2) are our own build — this document is that spec. For the **BIR-report surface a
PH buyer expects**, benchmark against **QuickBooks Online** (already integrated —
`src/quickbooks.ts`), **Xero**, and the PH-local **Oojeema** / **ECOUNT** (our price-floor
competitor).

---

## 10. Frappe Books feature map (the full target)

Every Frappe Books data model (`schemas/app/**`), and where it lands here. Legend:
✅ done · 🟡 partial (exists in another form) · ⬜ to build · ➖ out of scope.

### Accounting core
| Frappe Books | Verdesakay | Status |
|---|---|---|
| `Account` (tree chart of accounts) | `accounts` | ✅ **Phase 0** — seeded PH SMB COA, tree CRUD |
| `AccountingLedgerEntry` (immutable GL lines) | `journal_lines` (posted) | ✅ **Phase 0** |
| `JournalEntry` + `JournalEntryAccount` | `journal_entries` + `journal_lines` | ✅ **Phase 0** — draft → post, void = reversing entry, gapless `JV-` numbers |
| `AccountingSettings` (fiscal year, base currency, enable flag) | `settings.accounting_ledger` + `accounting_periods` | ✅ **Phase 0** |
| `NumberSeries` / `SerialNumberSeries` / `BatchSeries` | `nextSequence()` | ✅ |
| `Defaults` (default account per doc type) | posting-rules map (Phase 1) | ⬜ |

### Parties, items, pricing
| Frappe Books | Verdesakay | Status |
|---|---|---|
| `Party` (customer/supplier) + `Address` | `suppliers` (customers implicit on `orders`) | 🟡 — needs a real `customers` party ledger (Phase 1) |
| `Item` + `ItemGroup` + `UOM` + `UOMConversionItem` | `inventory_items` (category, unit) | 🟡 |
| `PriceList` + `PriceListItem` | `attributes.sale_price` per item | 🟡 |
| `PricingRule` (+ detail/item) | — | ⬜ |
| `Lead` / `ItemEnquiry` (light CRM) | — | ➖ |

### Sales & purchase
| Frappe Books | Verdesakay | Status |
|---|---|---|
| `SalesInvoice` + `SalesInvoiceItem` | `orders` type `sale` | 🟡 → auto-post to sales journal (Phase 1) |
| `PurchaseInvoice` + `PurchaseInvoiceItem` | `vendor_bills` | 🟡 → auto-post to purchase journal (Phase 1) |
| `SalesQuote` + items | — | ⬜ (quotation → SO) |
| `Payment` + `PaymentFor` (allocation) + `PaymentMethod` | — | ⬜ **Phase 1** — receive-from-customer / pay-supplier, settle invoices |
| `Tax` + `TaxDetail` + `TaxSummary` (tax templates) | `tax_percent` on docs + the VAT/EWT worksheets | 🟡 → `tax_codes` on lines (Phase 2) |
| `AppliedCouponCodes` / `CouponCode` / `PricingRule` | — | ➖ |

### Inventory (`schemas/app/inventory`)
| Frappe Books | Verdesakay | Status |
|---|---|---|
| `Location` (warehouse) | `locations` | ✅ |
| `StockLedgerEntry` | `inventory_transactions` + `inventory_stock` | ✅ (needs a valuation layer for COGS — Phase 3) |
| `StockMovement` / `StockTransfer` (+ items) | adjust / transfer endpoints | ✅ |
| `PurchaseReceipt` (+ items) | `goods_receipts` | ✅ |
| `Shipment` (+ items) — delivery note | finished-unit allocation | 🟡 |
| `SerialNumber` / `Batch` / `BatchSeries` | `job_order_units` (finished goods only) | 🟡 |
| `InventorySettings` | inventory form-config | 🟡 |

### POS (`schemas/app/inventory/Point of Sale`)
| Frappe Books | Verdesakay | Status |
|---|---|---|
| `POSProfile`, POS mode, `PaymentMethod`, `LoyaltyProgram` + `LoyaltyPointEntry`, `CollectionRulesItems` | — | ➖ (separate product decision; not an SMB-manufacturer need) |

### Reports
| Frappe Books | Verdesakay | Status |
|---|---|---|
| General Ledger | `GET /accounting/ledger/reports/general-ledger` | ✅ **Phase 0** |
| Trial Balance | `.../reports/trial-balance` | ✅ **Phase 0** |
| Profit & Loss | `.../reports/profit-and-loss` | ✅ **Phase 0** |
| Balance Sheet | `.../reports/balance-sheet` | ✅ **Phase 0** |
| Cash Flow Statement | — | ⬜ Phase 4 |
| Stock Ledger / Stock Balance | analytics dashboard (stock value) | 🟡 |
| Sales / Purchase Register, Party Ledger | — | ⬜ Phase 1 |
| GST reports | our BIR VAT/EWT worksheets + (Phase 2) SLSP / 1601-EQ / QAP | 🟡 |

### Cross-cutting
| Frappe Books | Verdesakay | Status |
|---|---|---|
| `PrintTemplate` + `PrintSettings` | `doc_templates` + `renderTemplate` | ✅ |
| `Currency` + multi-currency w/ fx | `currency` field + `currencies.js`, no fx | 🟡 → Phase 5 |
| `SetupWizard` / `GetStarted` | `POST /accounting/ledger/setup` (seed COA + fiscal year) | ✅ **Phase 0** |
| Dashboard | `analytics` (Reports) | ✅ |
| Data import | CSV import (items/suppliers/employees); COA/opening-balance import | 🟡 → Phase 0.1 |
| `ERPNextSyncSettings` / sync queue | our QuickBooks push (`src/quickbooks.ts`) is the analogous "external accounting bridge" | ✅ (different target) |

**Phase 0 (this build) = the GL foundation**: chart of accounts, fiscal periods,
manual journal entries with the CAS invariants, and the four core financial reports.
Everything marked ⬜ Phase 1+ is the roadmap above (§5).

---

## Sources

- BIR CAS registration / RMC 87-2025 — [cleartax.com/ph/bir-cas-registration](https://www.cleartax.com/ph/bir-cas-registration), [orkids.ph/briefs/rmc-87-2025-cas-registration](https://orkids.ph/briefs/rmc-87-2025-cas-registration), [hashmicro.com/ph/blog/bir-computerized-accounting-system](https://www.hashmicro.com/ph/blog/bir-computerized-accounting-system/)
- Books of Accounts for MSMEs — [oojeema.com/books-of-accounts-bir-msmes](https://oojeema.com/books-of-accounts-bir-msmes/), [taxacctgcenter.ph/books-of-accounts-of-taxpayers-in-the-philippines](https://taxacctgcenter.ph/books-of-accounts-of-taxpayers-in-the-philippines/), [cpadavao.com — three books of accounts](https://www.cpadavao.com/2026/04/The-Three-Books-of-Accounts-Required-by-the-BIR-A-Complete-Guide-for-Filipino-Taxpayers.html)
- VAT / EWT quarterly returns, SLSP, SAWT, 2307 — [businessmindedpinoy.com/bir-1601vt-2550q-sawt-eafs-guide](https://www.businessmindedpinoy.com/bir-1601vt-2550q-sawt-eafs-guide.html), [taxacctgcenter.ph/how-to-file-bir-form-2550q](https://taxacctgcenter.ph/how-to-file-bir-form-2550q-quarterly-vat-return/), [mpm.ph/bir-form-1702q](https://mpm.ph/bir-form-1702q/), [bir.gov.ph/tax-reminder](https://www.bir.gov.ph/tax-reminder)
- PFRS for SMEs / AFS / audit thresholds — [SEC notice — PFRS for SMEs](https://elibrary.judiciary.gov.ph/thebookshelf/showdocs/11/50604), [philippines.acclime.com/guides/audit-requirements](https://philippines.acclime.com/guides/audit-requirements/), [tripleiconsulting.com — AFS submission](https://www.tripleiconsulting.com/how-to-submit-audited-financial-statement-afs-philippines/), [SRC Rule 68 (ali.net.ph)](https://www.ali.net.ph/documents/SEC-GENERAL-FINANCIAL-REPORTING-REQUIREMENTS.pdf)
- Reference implementations — [Frappe Books (github.com/frappe/books)](https://github.com/frappe/books), [Frappe Books data model (deepwiki)](https://deepwiki.com/frappe/books), [ERPNext general_ledger.py](https://github.com/frappe/erpnext/blob/develop/erpnext/accounts/general_ledger.py), [Bigcapital (github.com/bigcapitalhq/bigcapital)](https://github.com/bigcapitalhq/bigcapital), [medici — Node double-entry ledger (npm)](https://www.npmjs.com/package/medici), [LedgerSMB](https://ledgersmb.org/)
