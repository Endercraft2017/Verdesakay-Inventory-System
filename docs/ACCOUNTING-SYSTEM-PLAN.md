# Accounting Module — Plan for a Complete Philippine System

> **Status:** the "Accounting" section now has **tax & statutory reporting** (BIR 1601-C /
> 1604-C / 2316 / Alphalist / 0619-E / 2550M + SSS / PhilHealth / Pag-IBIG schedules), a
> **Petty Cash** register (§6.5), and — as of **2026-08-30** — **Phase 0 of the general
> ledger**: chart of accounts, fiscal periods, manual journal entries (draft → post →
> reverse, gapless numbers, closed-period lock), and the Trial Balance / P&L / Balance
> Sheet / General Ledger reports (§5). Built modelled on **Frappe Books** (§9–10) — same
> stack (SQLite + Node/JS); AGPL, so design reference only (reimplemented).
> **Phase 1a (2026-08-30)** adds **auto-posting**: a confirmed sale order and an approved
> vendor bill post themselves to the sales / purchase journals via editable **posting
> rules** (Books → Posting Rules), and reverse when the document is pulled back.
> **Phase 1b (2026-08-30)** adds a **`customers`** party registry, **payments** (customer
> receipts / supplier disbursements that settle invoices and auto-post to the cash books),
> **credit / debit notes**, and **AR / AP aging** (net of on-account credits) + a
> per-party statement — all under Accounting → Receivables & Payables.
> **Phase 2 (2026-08-31)** adds **`tax_codes`**, the **BIR Sales & Purchase Journals**,
> **expanded withholding (EWT)** on vendor bills (register + 2307 + 0619-E), and the
> **quarterly / annual filing pack** — 1601-EQ + QAP, 1604-E, and the SLSP summary lists
> with `.DAT` export. **Phase 2 tails (2026-08-31)** re-sourced **2550M** from the sales &
> purchase journals and added **2550Q** (quarterly VAT + per-month breakdown), plus the
> **Cash Receipts / Cash Disbursements** book views (Books → Cash Book).
> **Phase 3a (2026-08-31)** posts the **Payroll Journal** — one aggregate entry per
> cutoff via an explicit "Post to GL" action (not an implicit per-regenerate hook, unlike
> sales/purchase — see §5), plus payslip locking (`mark-paid`) and payslip email as
> companion fixes. **Phase 3b (2026-08-31)** brings **inventory into the GL**: a job order
> moves its material cost DR WIP / CR Inventory at release, DR Inventory / CR WIP as units
> finish, with a scrap/variance true-up at close; a goods receipt posts DR Inventory / CR
> Goods Received Not Invoiced at the PO price, and the vendor bill clears GRNI instead of
> expensing (`inventory_items.unit_cost` standard cost). COGS-on-sale (needs a sale→stock
> hook) is the remaining 3b work; Phase 4–5 (financial-statement polish, CAS export) are
> the roadmap. **Phase 2 is complete** — its last tail,
> **per-line tax codes** for mixed-rate documents (2026-08-31), lets the BIR journals /
> SLSP / 2550M-Q classify a sale or bill line by line.
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
| **Payslips** (`hr_payroll` records) | Payroll Journal → Dr Salaries, Dr ER contributions, Cr SSS/PHIC/HDMF payable, Cr WT payable, Cr Cash/Net-pay payable — **✅ shipped, §5 Phase 3a** |
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

**Phase 1 — AR / AP subledgers + auto-posting sales & purchases.**

- **1a — auto-posting + posting rules. ✅ SHIPPED 2026-08-30.** `src/accounting-posting.ts`
  (pure `buildSalesEntry` / `buildPurchaseEntry`) + `src/accounting-autopost.ts` (the
  DB-facing `maybeAutoPostSale` / `maybeAutoPostVendorBill` / `unpostSource`, best-effort,
  same pattern as `maybeAutoPush`). A **confirmed** sale order (`status` confirmed /
  completed / …) posts **DR AR / CR Sales / CR Output VAT** to the *sales* journal; an
  **approved** vendor bill posts **DR Purchases / DR Input VAT / CR AP** to the *purchase*
  journal. Re-opening / cancelling / deleting the sale, or disputing the bill, writes a
  reversing entry (`source_type` + `source_id` on `journal_entries` link the two; a doc is
  never posted twice). Posting rules (which account each leg hits) are a `settings` map,
  seeded from the default COA at ledger setup, edited at **Books → Posting Rules**
  (`GET`/`PUT /api/accounting/ledger/posting-rules`). Skips silently when the ledger is off
  or the entry date is in a closed period. `tests/accounting-posting.test.ts` +
  `tests/accounting.test.ts` ("auto-posting sales & purchases (Phase 1)").
- **1b — parties, payments, aging. ✅ SHIPPED 2026-08-30.** New **`customers`** table +
  `/api/customers` CRUD (the AR-side counterpart of `suppliers`), `orders.customer_id`
  FK (SCHEMA_VERSION 7). **`payments`** + **`payment_allocations`** — a receipt (money in
  from a customer) / disbursement (money out to a supplier), optionally applied against
  specific sale orders / vendor bills; auto-posts to the **cash receipts / disbursements**
  book (`buildPaymentEntry` + `maybeAutoPostPayment`), void writes a reversal. Reports:
  **`GET /api/accounting/ar-aging`** / **`ap-aging`** (per party, five buckets — current /
  1–30 / 31–60 / 61–90 / 90+, aged by customer terms or the bill due date, net of
  allocations) and **`party-ledger`** (a running charges-less-payments statement). UI:
  **Accounting → Receivables & Payables** (`public/js/views/accounting-receivables.js`) +
  **Inventory → Customers** (`customers.js`); the sale-order form gained a customer picker.
  `tests/customers.test.ts` + `tests/accounting.test.ts` ("receivables & payables (Phase 1b)").
- **1b — credit / debit notes + credit netting. ✅ SHIPPED 2026-08-30.** New
  **`credit_notes`** table (header-only, `kind` customer/supplier). A **customer credit
  note** posts DR Sales Returns / DR Output VAT / CR AR; a **supplier debit note** posts
  DR AP / CR Purchases / CR Input VAT (`buildCreditNoteEntry` + `maybeAutoPostCreditNote`,
  7th posting-rule leg `sales_returns_account_id` → code 4400). `GET/POST /credit-notes`,
  `GET /credit-notes/:id`, `POST /credit-notes/:id/void`. AR/AP aging now nets an
  **on-account credit** per party — issued notes **plus** the unapplied portion of posted
  payments — into a `credits` column and a `grand_total = open − credits` (parties with
  only a credit balance show up too); the party statement lists a note as a negative
  charge. Accounting → Receivables & Payables gained a **Credit Notes** tab.
- **1b — still to do.** **Sales Journal / Purchase Journal** in BIR columnar format
  (moves to Phase 2 alongside re-sourcing 2550M/2550Q from the journals).

**Phase 2 — VAT + withholding, properly.**

- **2a — tax codes + BIR sales / purchase journals. ✅ SHIPPED 2026-08-31.** New
  **`tax_codes`** table (`kind` output_vat / input_vat / exempt / zero_rated / ewt, rate,
  optional GL `account_id` + `atc`), seeded with the standard PH set; **`orders`**,
  **`vendor_bills`** and **`credit_notes`** gained an optional `tax_code_id`
  (SCHEMA_VERSION 8). The GL auto-post uses a VAT code's `account_id` in place of the
  default posting-rule VAT account. **`GET /api/accounting/sales-journal`** and
  **`purchase-journal`** produce the BIR columnar books — per document: date, ref, party
  + TIN, gross, VATable / exempt / zero-rated, output|input VAT — inferring the split from
  the tax amount when a document has no code. `tax_codes` CRUD at Accounting → Tax &
  Compliance → **Tax codes**; the journals are tabs in **Books**; the sale / bill / note
  forms gained a tax-code picker. `tests/accounting.test.ts` ("tax codes + BIR journals").
- **2b — expanded withholding (EWT). ✅ SHIPPED 2026-08-31.** A vendor bill carries
  `ewt_rate` / `ewt_amount` / `ewt_atc` (SCHEMA_VERSION 9; `suppliers` also gained a
  `tin`). On approve, `buildPurchaseEntry` splits the AP credit: **CR AP** = gross −
  withheld, **CR Withholding Tax Payable — Expanded** = withheld (8th posting-rule leg
  `ewt_payable_account_id` → code 2140). **`GET /api/accounting/ewt-register`** (rows +
  by-ATC subtotals), **`GET /api/accounting/bir-2307`** (Certificate of Creditable Tax
  Withheld at Source, one per supplier, printable), and **`bir-0619e?source=register`**
  builds its ATC lines straight from the register. UI: Accounting → Tax & Compliance →
  **Withholding register** / **BIR 2307**; EWT % + ATC fields on the vendor-bill form.
  `tests/accounting.test.ts` ("expanded withholding / EWT").
- **2c — quarterly / annual EWT + SLSP. ✅ SHIPPED 2026-08-31.** All sourced from the
  data structures already built (EWT register + BIR journals), no schema change.
  **`GET /api/accounting/bir-1601eq?quarter=YYYY-Qn`** (quarterly EWT return — 3 monthly
  rows + reconciliation), **`/qap`** (Quarterly Alphalist of Payees, one row per payee ×
  ATC, `format=csv|dat`), **`/bir-1604e?year=`** (annual info return + alphalist,
  `format=csv|dat`), **`/slsp?quarter=&kind=sales|purchases`** (Summary List of Sales /
  Purchases per party — TIN / name / address / gross / exempt / zero-rated / taxable /
  VAT, `format=csv|dat`). UI: Accounting → Tax & Compliance modals **BIR 1601-EQ + QAP**,
  **BIR 1604-E**, **SLSP** (with `.DAT` / CSV download via the new `API.download`).
  `tests/accounting.test.ts` ("SLSP summary lists" + the 1601-EQ/QAP/1604-E block).
- **2d — 2550M/Q re-source + cash books. ✅ SHIPPED 2026-08-31.** `bir-2550m` now derives
  its figures from `salesJournalData` / `purchaseJournalData` (the same `classify()` split
  the sales / purchase journal endpoints use) so exempt / zero-rated sales and credit /
  debit notes are already broken out and netted; the response gained a `breakdown`.
  **`GET /api/accounting/bir-2550q?quarter=YYYY-Qn`** is the quarterly return — quarter
  totals + a per-month (output / input / net) table. **`GET /api/accounting/cash-book?type=
  receipts|disbursements&from=&to=&format=csv`** is the BIR Cash Receipts / Cash
  Disbursements book: every posted entry in that cash journal, its cash-side movement and
  the contra accounts, plus a contra-account summary. UI: Accounting → Tax & Compliance →
  **BIR 2550Q**; **Books → Cash Book** (receipts / disbursements toggle, CSV).
  `tests/accounting.test.ts` ("2550M (VAT)" + "cash books (Phase 2 tail)").
- **2e — per-line tax codes. ✅ SHIPPED 2026-08-31.** `order_items` and `vendor_bill_items`
  gained a `tax_code_id` (SCHEMA_VERSION 11). When any line of a sale / bill carries its
  own code, the BIR sales / purchase journals, **SLSP** and **2550M/Q** classify the
  document **line by line** — each line's own code + rate decides its column (vatable +
  VAT at the line code's rate / exempt / zero-rated); lines with no code fall back to the
  document-level classification for their slice; documents with no line codes at all take
  the original document-level path unchanged (`classifyLines` + `orderLinesByTax` /
  `billLinesByTax` helpers). GL posting stays at the document level (the doc's own
  `tax_amount`) — the split is a reporting refinement. UI: a **Tax code** column on the
  sale-order and vendor-bill line grids ("— doc default —" per line). `tests/accounting.test.ts`
  ("per-line tax codes"). **Phase 2 complete.**

**Phase 3 — payroll & inventory into the GL.**

- **3a — payroll journal. ✅ SHIPPED 2026-08-31.** One aggregate **Payroll Journal** entry
  per cutoff (not per employee, not per `generate-payslips` regenerate): **Dr Salaries &
  Wages** (Σ `total_earnings` − Σ `late_absences` — unpaid time isn't owed to anyone),
  **Dr Employer's SSS/PhilHealth/Pag-IBIG**, **Cr SSS/PhilHealth/Pag-IBIG Payable** (employee
  + employer + EC combined), **Cr Withholding Tax Payable — Compensation**, **Cr Advances
  to Employees** (cash-advance recovery, code 1190 — only when nonzero, same pattern as
  EWT), **Cr Net Pay Payable**. 8 new posting-rule keys (`payroll_expense_account_id`,
  `payroll_er_contrib_account_id`, `sss_payable_account_id`, `philhealth_payable_account_id`,
  `pagibig_payable_account_id`, `withholding_tax_payable_account_id`,
  `net_pay_payable_account_id`, `employee_advance_account_id`) map to the already-seeded
  COA codes 2130/2150/2160/2170/2185/6100/6110/1190 via `seedPostingRulesFromCoa()`.
  `src/accounting-posting.ts`'s `buildPayrollEntry()` — a self-check sums debits vs.
  credits and refuses to post (with a specific error) if a run assembled from
  hand-edited payslips (`auto_statutory` off) doesn't actually balance, rather than
  silently posting garbage. Employer-side shares are computed and **persisted on each
  payslip at generate time** (`hr_payroll` records gain a nested `data.employer_contributions
  {sss_er, sss_ec, philhealth_er, pagibig_er}` — nested, not flat, so it stays invisible to
  the employee's own mobile payslip view / CSV export / print slip, none of which read
  unknown keys) rather than recomputed later, so a rate-table or per-employee flag change
  between generate and post can't silently drift the two apart.
  **Deliberately NOT an implicit hook fired on every `generate-payslips` call** — unlike a
  sale order or vendor bill, a cutoff's payslips are commonly regenerated several times
  (attendance corrections) before payroll is final, and the existing `maybeAutoPost*` hooks
  silently no-op once a source is already posted (confirmed: editing an already-posted sale
  order today does *not* refresh its journal entry — a pre-existing gap, not something to
  copy). Instead, an explicit **`POST /api/hr/periods/:id/post-payroll-gl`** (`hr.manage`,
  UI: the "Post to GL" button next to Generate Payslips in Time Keeping's cutoff detail) —
  safe to click again after a regenerate: if a live entry already exists for that
  `('payroll_run', periodId)` source, it's reversed first (CAS rule — never edited/deleted)
  and a fresh one posted with the current numbers. Also gained, as a companion (not
  strictly GL-scoped but the natural adjacent fix): **payslips can be locked** —
  `POST /hr/payroll/:recordId/mark-paid` sets `status='paid'`, after which
  `generate-payslips` skips that record entirely (counted in a new `skipped_locked`
  response field) and the *generic* `PUT`/`DELETE /api/form-records/:id` routes 423 until
  it's unmarked (closing a real bypass: those generic routes had **no permission or lock
  check at all**, so anyone could edit/delete any form record including a paid payslip
  through the ordinary Edit button) — and **email a payslip** to the employee's linked
  user account (`POST /hr/payroll/:recordId/email`, reuses the existing single-slip
  `renderSlip()` HTML renderer from `hr-payroll-print.js` via `createRequire`, no
  duplicated rendering logic). `tests/accounting-posting.test.ts` ("buildPayrollEntry" —
  balance-with-real-numbers, dropped-zero-lines, EWT-style advance-recovery leg, deliberate
  imbalance rejection) + `tests/hr.test.ts` (lock bypass, post/repost/reverse against a real
  ledger, email-when-unlinked).
- **3b — manufacturing WIP. ✅ SHIPPED 2026-08-31.** A job order posts its material cost
  through the GL as it moves. `inventory_items` gains **`unit_cost`** (SCHEMA_VERSION 12,
  a standard cost, editable on the item form) and the default COA gains **Work in Process**
  (code 1152, asset) + **Manufacturing Variance & Scrap** (5150, expense); 3 posting-rule
  legs — `inventory_asset_account_id` (1150), `wip_account_id` (1152),
  `mfg_variance_account_id` (5150) — seeded by `seedPostingRulesFromCoa()`, and a migrate
  step backfills those two accounts into a chart that was already set up. On **release**,
  the reservation value (Σ component `qty_planned × unit_cost`) posts **DR Work in Process /
  CR Inventory**; as finished units land in stock (progress, or per QC pass) their standard
  material cost (Σ component `qty_per_unit × unit_cost`) posts **DR Inventory / CR WIP**;
  when the job order reaches a terminal state (complete / close / cancel) `settleJobOrderGl`
  flushes the residual WIP balance — unconsumed components physically returned to stock go
  back to Inventory, materials consumed by scrapped units + rounding go to Manufacturing
  Variance — zeroing the job order's WIP. Pure `buildJobOrderEntry(kind)` in
  `accounting-posting.ts` (`release` / `produce` / `settle`, book `general`, `source_type`
  `job_order` — many entries per source, so posted directly, not via `autoPost`);
  `postJobOrderMovement` + `jobOrderWipBalance` in `accounting-autopost.ts`; hooks in
  `job-orders.routes.ts` (all best-effort, after the stock transaction commits). Cost basis
  is **standard cost** from `unit_cost` at posting time — no moving-average valuation layer
  yet. `tests/accounting-posting.test.ts` ("buildJobOrderEntry") + `tests/job-orders.test.ts`
  ("manufacturing WIP in the GL").
- **3b — purchase-side perpetual inventory. ✅ SHIPPED 2026-08-31.** The default COA gains
  **Goods Received Not Invoiced** (code 2105, current liability); a 4th Phase-3 posting-rule
  leg `grir_clearing_account_id` (seeded to 2105 by `seedPostingRulesFromCoa()`, backfilled
  into an existing chart by the SCHEMA_VERSION 13 migrate step). A **goods receipt** now
  posts **DR Inventory / CR GRNI** at the purchase-order line price (× received qty; falls
  back to `inventory_items.unit_cost` for a line with no PO link) — `buildReceiptEntry` +
  `maybeAutoPostGoodsReceipt`, `source_type` `goods_receipt`; `DELETE /receipts/:id`
  reverses it. When a **vendor bill** is approved for a PO that has receipts,
  `buildPurchaseEntry` debits **GRNI** for the outstanding balance (`grirOpenForOrder` — Σ
  the PO's receipt GRNI credits − Σ its bills' GRNI debits, capped at the bill's net)
  instead of purchase expense; a bill with no receipts (services / expenses) is unchanged.
  `tests/accounting-posting.test.ts` ("buildReceiptEntry", "buildPurchaseEntry" GRNI cases)
  + `tests/accounting.test.ts` ("perpetual inventory — goods receipts + GRNI").
- **3b — still to do.** **COGS on sale** — needs a sale → stock-decrement hook first (sale
  orders don't touch stock today). **Moving-average valuation** to replace standard cost.

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

**Shipped ahead of the GL, then wired into it (§5 Phase 3a):**

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
| `Defaults` (default account per doc type) | `settings.accounting_posting_rules` (`GET`/`PUT /ledger/posting-rules`) | ✅ **Phase 1a** — 6 legs: AR / Sales / Output VAT / AP / Purchases / Input VAT |

### Parties, items, pricing
| Frappe Books | Verdesakay | Status |
|---|---|---|
| `Party` (customer/supplier) + `Address` | `suppliers` + **`customers`** (Phase 1b) + `orders.customer_id` | ✅ — both sides are first-class; AR/AP aging + party statement net against them |
| `Item` + `ItemGroup` + `UOM` + `UOMConversionItem` | `inventory_items` (category, unit) | 🟡 |
| `PriceList` + `PriceListItem` | `attributes.sale_price` per item | 🟡 |
| `PricingRule` (+ detail/item) | — | ⬜ |
| `Lead` / `ItemEnquiry` (light CRM) | — | ➖ |

### Sales & purchase
| Frappe Books | Verdesakay | Status |
|---|---|---|
| `SalesInvoice` + `SalesInvoiceItem` | `orders` type `sale` | 🟡 — **Phase 1a** auto-posts a *confirmed* sale to the sales journal (DR AR / CR Sales / CR Output VAT); reverses on re-open |
| `PurchaseInvoice` + `PurchaseInvoiceItem` | `vendor_bills` | 🟡 — **Phase 1a** auto-posts an *approved* bill to the purchase journal (DR Purchases / DR Input VAT / CR AP); reverses on dispute |
| `SalesQuote` + items | — | ⬜ (quotation → SO) |
| `Payment` + `PaymentFor` (allocation) + `PaymentMethod` | `payments` + `payment_allocations` (Phase 1b) | ✅ — receipt / disbursement, applied to sale orders / vendor bills, auto-posts to the cash books, void = reversal |
| `Tax` + `TaxDetail` + `TaxSummary` (tax templates) | `tax_codes` table + `tax_code_id` on `orders` / `vendor_bills` / `credit_notes` (Phase 2a) **and on `order_items` / `vendor_bill_items`** (Phase 2e, per-line for mixed-rate docs); `tax_percent` still on the doc | ✅ — per-document + per-line codes; the BIR journals / SLSP / 2550M-Q classify line by line |
| `AppliedCouponCodes` / `CouponCode` / `PricingRule` | — | ➖ |

### Inventory (`schemas/app/inventory`)
| Frappe Books | Verdesakay | Status |
|---|---|---|
| `Location` (warehouse) | `locations` | ✅ |
| `StockLedgerEntry` | `inventory_transactions` + `inventory_stock` (+ `inventory_items.unit_cost` standard cost, Phase 3b) | ✅ — job orders post WIP + goods receipts post DR Inventory / CR GRNI, both at standard cost (Phase 3b); COGS-on-sale + moving-average valuation still ⬜ |
| `StockMovement` / `StockTransfer` (+ items) | adjust / transfer endpoints | ✅ |
| `PurchaseReceipt` (+ items) | `goods_receipts` | ✅ — posts DR Inventory / CR Goods Received Not Invoiced (Phase 3b); the vendor bill clears GRNI |
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
| Sales / Purchase Register, Party Ledger | `sales-journal` / `purchase-journal` (Phase 2a, BIR columnar); `party-ledger` statement (Phase 1b); AR/AP aging; **Cash Receipts / Cash Disbursements books** (`cash-book`, Phase 2d) | ✅ — registers + cash books + party statement done |
| GST reports | BIR sales/purchase journals + **2550M/2550Q (journal-sourced) / 0619-E** + **EWT register / 2307 / 1601-EQ + QAP / 1604-E / SLSP `.DAT`** (Phase 2) | ✅ |

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
