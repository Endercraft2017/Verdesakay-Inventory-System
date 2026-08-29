# Go-To-Market & Feature Strategy

> **Status:** working plan, revise as the market talks back.
> **Last updated:** 2026-08-28
> Companion to [SAAS-READINESS.md](SAAS-READINESS.md) (the technical side of the SaaS pivot).

---

## 1. The strategy in one paragraph

Sell to **upper-SMB / low-mid-market operators in the Philippines first** — manufacturers,
assemblers, and multi-location distributors with roughly **20–200 employees** — as the
**operations system of record**: inventory + production + warehouse + HR/payroll in one
place, with a **modern UI, a real mobile warehouse app, and Philippine-correct payroll**.
Price it **above the ₱2,800 flat-fee floor** (ECOUNT) and **below Dynamics/SAP**, on
**annual contracts**, with a **paid implementation + data-migration + payroll-setup fee**
that is where much of the early revenue and the switching cost live. Do **not** chase
thousands of micro-businesses on a cheap self-serve plan, and do **not** chase 12–24 month
enterprise deals. Land 20–50 solid customers in one vertical, get profitable, then decide
whether to push upmarket in PH or take the inventory+manufacturing core (minus PH payroll)
to the US/EU where willingness-to-pay is 2–4× higher.

**Why this shape** (full reasoning + sources in the chat that produced this doc):

- SMB self-serve SaaS churns 3–7%/month; annual-contract mid-market churns ~10%/year.
- In PH, **implementation/training/support is 75–85% of what customers actually pay** for
  ERP — a services attach we can own and ECOUNT does not offer.
- ECOUNT (₱2,800/mo flat, unlimited users, all modules) is a hard price anchor at the
  bottom. We beat it on **UX, support, onboarding, mobile, and payroll compliance
  currency** — not on price.
- Sprout charges ₱200–300/employee/mo for **payroll alone**; at 80 staff that's
  ₱16k–24k/mo. That gap is where our bundled price lives.

---

## 2. Ideal customer profile (ICP)

**Primary (Play B — go past ECOUNT's ceiling):**

| Attribute | Target |
|---|---|
| Size | 20–200 employees; ₱50M–₱1B revenue |
| Type | Discrete manufacturing / assembly / fabrication; multi-branch distribution; construction supply; automotive/equipment |
| Pain | Spreadsheets + 2–3 disconnected tools; production untracked; payroll is a monthly fire drill; no stock visibility across locations; owner has no real-time picture |
| Buying frame | "SAP is ₱20M, Dynamics is ₱5k/user, ECOUNT is clunky and unsupported — what's the modern middle?" |
| Deal | ₱20k–60k/mo + ₱150k–400k implementation, annual |

**Secondary (Play A — displace ECOUNT for the frustrated):**

Small businesses (5–30 staff) who bought ECOUNT/Zoho and never got it adopted. Sell modern
UX + real onboarding help. ₱4k–9k/mo + ₱30k–150k setup. Higher volume, thinner margin,
useful as a trial/logo funnel — not the main event.

**Not our customer (for now):** sari-sari stores and micro-retail (served by cheap POS
apps), pure e-commerce sellers (served by Shopee/Lazada tools), and 500+ employee
enterprises (SAP/Oracle territory, procurement gauntlet).

---

## 3. Positioning

> **"Run your whole operation — stockroom to payslip — in one modern system your staff
> will actually use, built for how Philippine businesses really work."**

| Against | Our line |
|---|---|
| **ECOUNT** (₱2,800 flat) | "Powerful, but dated and you're on your own. We're modern, we set it up for you, we keep payroll compliant, and the warehouse runs off a phone." |
| **Sprout / PayrollHero** (payroll-only) | "Payroll is one module, not a separate ₱20k/mo bill. Same system runs your inventory and production." |
| **Dynamics 365 BC / SAP B1** | "A tenth of the cost and the complexity, live in weeks not months, no army of consultants." |
| **Spreadsheets / Google Sheets** | "One source of truth, an audit trail, and it doesn't break when two people edit at once." |
| **Odoo** | "No module maze, no per-app surprise pricing, no implementation partner required." |

---

## 4. Pricing model (proposed)

- **Annual contracts** (offer monthly at ~20% premium). Bill per **company + location
  count + module bundle**, not pure per-user (per-user punishes them for adding warehouse
  staff — Katana learned this the hard way).
- **Tiers:**
  - *Starter* — inventory + orders + 1 location + mobile app. ₱4,000–7,000/mo.
  - *Operations* — + multi-location + production (BOM/job orders/QC) + forms/templates.
    ₱12,000–25,000/mo.
  - *Complete* — + HR/payroll + activity log + AI assistant + priority support.
    ₱25,000–60,000/mo depending on headcount/locations.
- **One-time services** (the real early revenue): implementation & configuration, data
  migration (CSV import), payroll setup for the current BIR/SSS/PhilHealth/Pag-IBIG
  tables, on-site or remote training. ₱30k–400k by tier.
- **Self-hosted option** for buyers who insist: perpetual license (≈2–3× annual) +
  ~20%/yr maintenance. Uses the single-tenant build (see SAAS-READINESS.md).

---

## 5. Selling points — feature pillars

Ranked by how much they move a deal in the primary ICP. This is also the priority order
for engineering effort.

### Pillar 1 — Philippine payroll & statutory compliance  ★ WEDGE

The reason a buyer can't leave, and the reason finance + HR + owner all say yes.

- **Have:** employee 201 files, shifts + per-day shift assignment, timekeeping /
  attendance with grace-period lateness, payroll periods, payslip generation, statutory
  number fields (SSS / PhilHealth / Pag-IBIG / TIN), monthly-vs-daily rate handling,
  payroll policy (grace minutes, monthly divisor), employee ID card templates.
- **Gap (invest heavily — see §6):** actual **government output forms** — BIR **2316**,
  **1601-C**, **1604-C / alphalist**, SSS R-3 / contribution files, PhilHealth RF-1,
  Pag-IBIG MCRF. Current-year contribution tables shipped and updated. 13th-month
  computation. Final-pay / back-pay worksheet. Leave balances & accrual.
- **Selling line:** "Payroll that produces the forms you actually file, kept current with
  the tables — not a spreadsheet with SSS as a column."

### Pillar 2 — Mobile warehouse app  ★ DIFFERENTIATOR

ECOUNT's weakest flank. Demos extremely well.

- **Have:** `/m` phone app, QR scanning, offline queue with idempotent sync, stock moves,
  transfers, cycle count, order fulfilment, damage reporting (damage-twin model),
  `inventory.mobile` permission gate.
- **Gap (harden):** barcode (1D) support not just QR, label/barcode **printing**, bin/
  location-level scanning, receiving against a PO on the phone, batch/serial capture at
  scan time, spotty-connection stress testing.
- **Selling line:** "Your stockroom runs off a ₱6,000 Android phone, online or not."

### Pillar 3 — Production / manufacturing (BOM · job orders · QC · serial units)  ★ HIGH VALUE, NEW

Rare in software at this price; specific to the vertical. Built recently — needs field
hardening.

- **Have:** finished products with BOM, job orders that consume BOM from a source
  location, production tracking (done / scrapped / pause / cancel with partial component
  return), QA/QC pass–fail with free-text remarks and multi-stage support, one row per
  physical unit with an alphanumeric identifier (serial / chassis / motor no.), explode
  view of a finished product into its serialized units.
- **Gap (harden / extend):** production **scheduling / calendar**, work centers &
  routings, capacity view, per-unit cost roll-up (materials + labor + overhead),
  scrap/rework reporting, subcontracting, WIP valuation, multi-level BOM (BOM within BOM),
  where-used, BOM versioning/effectivity.
- **Selling line:** "Every unit tracked from parts issued to QC passed, by serial number."

### Pillar 4 — Inventory core (multi-location, transfers, movements)  ✔ STRONG

Table stakes, but ours is solid and complete.

- **Have:** items with attributes/images, SKU, categories, departments, suppliers,
  per-location stock, transfers, reorder levels + low-stock alerts, full movement history,
  multi-currency, cross-item stock-movement view.
- **Gap (nice to have):** lot/batch + expiry tracking (distribution/food/pharma),
  landed-cost allocation, stock valuation methods (FIFO/weighted-avg) surfaced in
  reports, min/max & reorder automation, stock-take sessions with variance sign-off,
  serial tracking for *non-manufactured* goods.

### Pillar 5 — Documents: form builder + template engine  ✔ STRONG / DIFFERENTIATOR

Lets a customer model their own paperwork without a consultant — a real Odoo/ECOUNT pain.

- **Have:** per-section form builder (HR / inventory / admin / accounting), auto-numbered
  form records, document templates with a variable registry (constants / bound fields /
  formulas), printable HTML, company profile variables, ID-card & payslip templates.
- **Gap (nice to have):** approval workflows / sign-off routing on form records,
  conditional fields, PDF export polish, e-signature, template gallery per vertical.

### Pillar 6 — Audit trail & granular permissions  ✔ STRONG (trust/compliance)

Matters more the bigger the buyer. Rarely the headline, often the objection-killer.

- **Have:** app-wide activity log (`audit.view`, admin-only), per-permission role model
  with per-user overrides, per-section form-builder rights.
- **Gap:** SSO (SAML/OIDC) and 2FA for upmarket, field-level history on key records,
  exportable audit reports, segregation-of-duties presets.

### Pillar 7 — AI assistant  ◆ DEMO WOW, not a deal-closer

Great in the sales meeting; do not bet the roadmap on it.

- **Have:** natural-language querying, analytics/report tools (attendance, lateness,
  absence, low-stock, dead-stock, reorder, job-order & QC reports), Word/HTML report
  generation, FTS5 knowledge search (RAG) over docs & notes, action tools, `send_email`.
- **Gap (light touch):** per-tenant BYO API key (mirror the email BYO-SMTP pattern —
  SAAS-READINESS §6 step 4), chart output, scheduled/emailed reports, guardrails.
- **Selling line:** "Ask 'who was late most this month' or 'what do I need to reorder' and
  get an answer — or a Word report — in seconds."

### Pillar 8 — Orders (sale / job / purchase)  △ ADEQUATE, needs depth for the ICP

- **Have:** three order types, auto-numbering, line items, totals/tax, currency,
  print templates, links from job orders.
- **Gap (invest — see §6):** purchase order → **goods receipt** → 3-way match, partial
  fulfilment / backorders on sale orders, customer & supplier records (light CRM),
  AR/AP aging, payment/collection tracking, quotations → SO conversion, price lists.

---

## 6. Where to put more effort (before selling upmarket)

Ordered. These are the gaps that lose deals or block onboarding in the primary ICP.

1. **BIR / statutory output forms + current contribution tables** (Pillar 1). The wedge is
   only a wedge if it produces filable documents. Biggest single revenue unlock.
   Scoped with current 2026 figures + a 4-phase plan in
   [PH-PAYROLL-COMPLIANCE.md](PH-PAYROLL-COMPLIANCE.md).
   *Phase A + B-step-1 done 2026-08-29: `payroll_tables` versioned data,
   `src/ph-statutory.ts` (SSS/PhilHealth/Pag-IBIG + BIR withholding math),
   `src/payroll-tables.ts` (effective-date resolution), `GET/POST /hr/payroll-tables`,
   generate-payslips auto-fills the statutory + withholding-tax lines (policy toggle
   `auto_statutory`, `pay_frequency`), a **rate-tables admin screen** (Time Keeping →
   Policy Settings), a **13th-month worksheet** (`GET /hr/thirteenth-month`), and
   **BIR 2316** (per-employee year-end certificate — `src/ph-2316.ts`, `GET /hr/bir-2316`,
   printable template, Time Keeping → BIR 2316), and a **BIR 1601-C monthly worksheet**
   (`GET /hr/bir-1601c`), and the **1604-C Alphalist Schedule-1** CSV in the BIR column
   order (`src/ph-alphalist.ts`, `GET /hr/bir-alphalist`; the `.DAT` conversion isn't a
   public spec, so customer runs BIR's validation tool). Government agencies have **no
   filing APIs** — we generate the upload files (PH-PAYROLL-COMPLIANCE §3b). Next:
   final-pay worksheet + the 1604-C return face; then agency schedules (SSS R-3 etc.).*
2. **Data import tools (CSV) for items, stock, BOMs, employees, opening balances.**
   Onboarding is impossible without this; it's also billable services. Blocks *every*
   deal. — *Items, suppliers, employees done 2026-08-29 (export + import, upsert by
   natural key, dry-run, per-row errors; `src/csv.ts` + `src/csv-import.ts`;
   `UI.csvImportModal`). User guide: `docs/guides/csv-import-export.md`. Still to do:
   opening stock levels, BOM components.*
3. **SaaS multi-tenancy** (SAAS-READINESS.md). *Phase 1 (per-tenant DB connections) +
   Phase 2 (`platform.db` catalog, sub-domain tenant resolution, `tenant:*` CLI,
   `/api/signup`) + Phase 3 (per-tenant upload folders via `db.uploadDir()`,
   `schema_version` short-circuit, `npm run migrate:all`) + BYO per-tenant AI key
   (`src/ai-config.ts`, `GET/PUT /api/ai/config`, AI Assistant → AI settings) done
   2026-08-29. + Phase 5 (`users.email` + password reset) + Phase 6 (plans/quotas —
   `src/plans.ts` + `enforceQuota` 402s at the create endpoints, `GET /api/tenant` +
   trial/past-due banner, lapsed-trial read-only, `npm run tenant:plan|usage`) done
   2026-08-29. Then custom domains + billing, per-tenant backups job.*
4. **Manufacturing hardening** (Pillar 3): multi-level BOM, per-unit cost roll-up,
   basic scheduling. Turns "nice demo" into "runs our shop."
5. **Purchasing depth** (Pillar 8): PO → goods receipt → match; supplier records.
6. **Accounting integration** (see §7) — decide partner-vs-build now; it shapes the pitch.
7. **Mobile hardening** (Pillar 2): 1D barcodes, label printing, receive-against-PO.
8. **Reporting & dashboards** beyond the AI: fixed operational dashboards (stock value,
   production throughput, payroll cost, aging) that don't require asking the assistant.
9. **SSO + 2FA** (Pillar 6) — the moment a 150+ employee prospect appears.
10. **Backups + per-tenant restore + data export** (SAAS-READINESS §5) — "no lock-in" is a
    sales answer, not just ops hygiene.

---

## 7. Features we can still add (roadmap / deal-wideners)

Not needed for first sales; each opens a segment or raises price.

- **Accounting integration** — *v1 shipped 2026-08-29: QuickBooks Online (`src/quickbooks.ts`),
  one Intuit app, per-tenant OAuth, one-way push of sale orders → Invoices / purchase
  requests → Bills, manual button + auto-push. Beta.* Next on this line: Xero, a
  two-way sync (payments/status back), and deeper AR/AP if a segment demands it. We
  stay "operations + HR that feeds your accountant", not a GL.
- **e-Invoicing / BIR EIS readiness** — the e-invoice mandate is expanding; being ready is
  a differentiator and eventually a requirement.
- **e-Commerce connectors** — Shopee / Lazada / Shopify / TikTok Shop stock + order sync.
  Opens the online-seller segment.
- **CRM lite** — leads, customer history, follow-ups. Widens from "operations" to "runs
  the sales side too."
- **Fixed-asset register & depreciation.**
- **Project / job costing** for construction & services firms (labor + materials + billing
  against a project).
- **Lot/batch + expiry + FEFO** — unlocks food, pharma, chemicals, cosmetics distributors.
- **Landed cost & multi-currency purchasing** for importers.
- **Demand forecasting / auto-replenishment** beyond the current AI reorder suggestions.
- **Customer/supplier portal** — let them submit POs, check order status, download SOAs.
- **Public API + webhooks** — integration story for bigger buyers; also an ecosystem play.
- **Multi-company / consolidation** — for groups with several legal entities.
- **Warehouse depth** — putaway rules, pick paths, wave picking, packing/shipping.
- **Biometric / device time-clock integration** (many PH SMEs have fingerprint clocks).
- **Localization pack per country** (payroll + tax + statutory) — the mechanism that lets
  the core go to other markets one country at a time.

---

## 8. GTM sequence

1. **Now:** pick one vertical (recommend discrete manufacturing / assembly). Write 3 case
   scenarios in its language. Build the §6 top-3 (BIR forms, CSV import, SaaS phase 2–3).
2. **First 5 customers:** hand-sold, hand-onboarded, discounted in exchange for being
   references and feedback partners. Expect to co-build the last 10% of fit.
3. **To ~20 customers:** productize onboarding (checklists, import templates, a
   configuration playbook). Publish 2–3 named case studies in the vertical.
4. **To ~50 & profitable:** decide the fork — upmarket in PH (mid-market motion, SSO,
   deeper accounting) **or** international with the localization-pack mechanism.
5. **Throughout:** ECOUNT's review complaints (UX, support, onboarding, stale localization)
   are the living feature backlog — mine them.

---

## 9. What to measure

- Logo count & ARR by tier; **services revenue as a % of total** (healthy early: 30–50%).
- Time-to-onboard (signup → live on real data). Target under 30 days by customer #20.
- Gross revenue retention (target ≥ 90%/yr) and net revenue retention (target ≥ 105%).
- CAC payback (target < 12 months including services margin).
- Feature-driven win/loss: tag every lost deal with the missing capability — that list
  re-orders §6.
