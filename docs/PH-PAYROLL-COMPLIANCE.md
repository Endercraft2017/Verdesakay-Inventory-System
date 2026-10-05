# Philippine Payroll & Statutory Compliance — scope + current figures

> **Status:** Phase A (engine), Phase B (payslip wiring, rate-tables screen, 13th-month,
> **final-pay worksheet** — `src/modules/payroll/ph-final-pay.ts`, 2026-08-30), Phase C (BIR 2316, 1601-C,
> **1604-C return face + reconciliation** — `GET /hr/bir-1604c`, 2026-08-30, Alphalist
> Schedule 1), and Phase D (**SSS R-3 / PhilHealth RF-1·EPRS / Pag-IBIG MCRF·eSRS monthly
> contribution schedules** — `src/modules/payroll/ph-contributions.ts`, 2026-08-30) all built. **The tax
> filings then moved to Accounting → Tax & Compliance** (`accounting.view`,
> `src/modules/accounting/accounting.routes.ts`, `/api/accounting/bir-*`) — plus **BIR 0619-E**
> (expanded WT) and **2550M** (monthly VAT) worksheets (`src/modules/payroll/ph-vat-ewt.ts`). HR keeps
> 13th-month + final pay. **Per-employee statutory switches** (`employees.deduct_*`, set
> from Accounting → Statutory Deductions, `accounting.manage`) turn SSS / PhilHealth /
> Pag-IBIG / withholding off for a given person — zeroed on the payslip, dropped from
> that fund's schedule. Remaining: leave balances/accrual, BIR 2307 + 1601-EQ/QAP, loan
> ledger, agency proprietary `.DAT` formats. **Full GL:** [ACCOUNTING-SYSTEM-PLAN.md](ACCOUNTING-SYSTEM-PLAN.md).
> This is GO-TO-MARKET §6 item #1 — the payroll "wedge".
> **Figures verified:** 2026 rates, August 2026. **Re-check every January** — SSS and
> PhilHealth schedules change by circular; BIR form versions change by RMC.

The system today has the *inputs* (employee 201 file with SSS/PhilHealth/Pag-IBIG/TIN
fields, shifts, timekeeping, payroll periods) and a payslip generator. It does **not**
compute statutory deductions from current tables, withholding tax, 13th-month, or produce
any **BIR / agency filing output**. That gap is what this covers.

---

## 1. Current rates (2026)

### SSS

| Item | 2026 value |
|---|---|
| Total contribution rate | **15%** of the Monthly Salary Credit (MSC) |
| Split | Employer **10%**, Employee **5%** |
| MSC range | floor **₱5,000** → ceiling **₱35,000** (₱500 brackets) |
| On top (employer) | EC (Employees' Compensation) ₱10–₱30; and the WISP / provident portion for MSC above ₱20,000 |

The full table is ~35 brackets with exact peso EE / ER / EC / WISP amounts per bracket —
load it verbatim from the current **SSS Circular** (contribution schedule effective
Jan 2025, unchanged for 2026). Don't compute it with a formula; store the table.

### PhilHealth

| Item | 2026 value |
|---|---|
| Premium rate | **5%** of monthly basic salary |
| Split | **2.5%** employee, **2.5%** employer |
| Income floor / ceiling | **₱10,000** → **₱100,000** |
| Employee share range | ₱250 → ₱2,500 per month |

Computable by formula (rate × capped basic ÷ 2). No bracket table needed.

### Pag-IBIG (HDMF)

| Item | 2026 value |
|---|---|
| Rate | **2%** employee + **2%** employer |
| Monthly compensation ceiling | **₱10,000** → contribution **capped at ₱200 each** |
| Below ₱1,500 monthly | employee rate 1% (employer stays 2%) |

Computable by formula.

### What each contribution is computed on (contribution bases) — implemented 2026-10-05

The three funds use **different pay figures**, and none of them is "daily rate × 26":

| Fund | Base | Law / guideline | In the code |
|---|---|---|---|
| **SSS** | **Actual remuneration for the month** — basic pay earned, OT, holiday pay, night diff, premiums, COLA; absences/lates reduce it. For hourly/daily/weekly-paid employees the month runs to the end of the last payroll period **ending** in it, so a 16–30 Sep cutoff paid 5 Oct is September's. | RA 11199 §8(f) "compensation" + IRR definition of "monthly" | `sssCompensation()` = `total_earnings − late_absences`, summed over the month's cutoffs |
| **Pag-IBIG** | **Basic salary + mandated COLA** actually received in the month (₱10,000 ceiling) | RA 9679 §3; HDMF Circular 460 (₱10k MFS, Feb 2024) | `pagIbigCompensation()` = SSS base − OT − night diff − special-holiday / rest-day premiums, summed over the month |
| **PhilHealth** | **Fixed monthly basic salary** — *not* reduced by absences, tardiness, undertime or LWOP; excludes OT, allowances, 13th month. Daily-paid: DOLE estimated equivalent monthly rate = daily × 313 / 12 (6-day week), × 261 / 12 (5-day), × 365 / 12 (paid every day). | PhilHealth Circular 2020-0005 / 2018-0001; DOLE Handbook on Statutory Monetary Benefits | `philHealthMonthlyBasic()` — monthly rate, or `equivalentMonthlyRate(daily, restDaysPerWeek)` from the employee's (else policy default) rest days |

**Across cutoffs** (`computeEmployeeStatutory`, `hr.routes.ts`): SSS and Pag-IBIG accrue — each
cutoff deducts the contribution on the month-to-date total **less what the month's earlier cutoffs
already deducted**, so the month's last deducting cutoff trues it up to the exact legal amount
(employer share and EC the same way). If a fund's only scheduled cutoff comes **before** month end
(e.g. Pag-IBIG on the 1st cutoff), the month's total isn't knowable yet, so the employee's
full-month rate stands in (never less than actual so far) — schedule SSS / Pag-IBIG on the last
cutoff for exact figures. PhilHealth's fixed amount is split across its scheduled cutoffs. Each
payslip records what it computed on in a nested `statutory_basis` (`sss_compensation`, `sss_msc`,
`pagibig_compensation`, `philhealth_monthly_basic`, `month_complete`).

**Fixed basis by written agreement** (`employees.contribution_basis`, SCHEMA_VERSION 58): default
`'actual'` (above). Accounting → Statutory Deductions → *Fixed basis* switches one employee to
`'fixed'`: SSS / Pag-IBIG on their fixed monthly rate (`monthly_rate`, or `daily_rate ×
monthly_rate_divisor`), split evenly across the fund's scheduled cutoffs, whatever the attendance;
the agency schedule then remits on that same fixed figure. PhilHealth is unaffected (already fixed).
Caveat: SSS assesses contributions on actual remuneration, so a month where actual pay exceeds the
fixed rate (OT, holiday pay) leaves the employer liable for the shortfall — the agreement doesn't
change what SSS can collect.

**Agency schedules** (`contributionBasesForMonth`, `GET /accounting/contribution-schedule`): a
payslip counts toward the month its cutoff ends in (pay date only when the period label matches
no cutoff, e.g. CSV imports); SSS / Pag-IBIG on the summed bases above; PhilHealth on the month's
recorded `philhealth_monthly_basic` (payslips generated before 2026-10-05 fall back to Σ basic).

**Worked example** (₱750/day, 6-day week, Sept 2026): cutoffs earned 10,218.75 (late 1,510.94) and
5,462.50 (late 168.75) → SSS compensation 14,001.56 → MSC 14,000 → **EE ₱700**, ER ₱1,400, EC ₱10.
The old flat 750 × 26 = 19,500 estimate charged ₱975. PhilHealth: 750 × 313 / 12 = 19,562.50 →
premium 978.13 → EE ₱489.07.

### Withholding tax on compensation (TRAIN)

- **Unchanged since 1 Jan 2023** (TRAIN second phase); 2026 table = 2025 table.
- Annual taxable compensation **≤ ₱250,000 is exempt**; above that, graduated **15% – 35%**.
- Apply the **daily / weekly / semi-monthly / monthly Revised Withholding Tax table**
  matching the payroll frequency.
- **Taxable compensation** = gross − non-taxable items − employee statutory shares
  (SSS + PhilHealth + Pag-IBIG + union dues).
- **13th-month pay + other benefits** are non-taxable up to a combined **₱90,000/year**;
  the excess is taxable.

Store the 5-row RWT table (per frequency) as versioned data keyed by effective date.

**Sources:** [KAMI Workforce — SSS/PhilHealth/Pag-IBIG 2026](https://kamiworkforce.com/ph/blog/sss-philhealth-pagibig-contribution-tables-2026/) ·
[KAMI Workforce — Withholding tax 2026](https://kamiworkforce.com/ph/blog/bir-withholding-tax-compensation-2026/) ·
[Taxumo — BIR tax + contribution 2026](https://www.taxumo.com/blog/bir-tax-table-2026/) ·
[Pesohub — RWT table 2026](https://pesohub.ph/government/bir/withholding-tax-table-philippines/) ·
[Philippine Payroll HR Matters — 2026 tables](https://philippinepayrollhrmatters.com/sss-philhealth-and-pag-ibig-contribution-tables-2026-a-complete-guide-for-philippine-employers/)

---

## 2. Required outputs (what a customer actually files)

| Output | What / who | Deadline | Format |
|---|---|---|---|
| **Payslip** | per employee, per cutoff | each payday | already have — needs statutory line items added |
| **BIR 2316** | Certificate of Compensation Payment / Tax Withheld — one per employee who got pay in the year | give to employee by **Jan 31**; employer files copies to BIR by **Feb 28** | official BIR form layout; submitted electronically / as 1604-C attachment |
| **BIR 1601-C** | Monthly Remittance Return of Income Taxes Withheld on Compensation | monthly (10th/15th following month; eFPS varies) | eBIRForms / eFPS; we produce the figures + a worksheet |
| **BIR 1604-C** | Annual Information Return of Income Taxes Withheld on Compensation | **Jan 31** | eBIRForms; includes the Alphalist |
| **Alphalist of Employees** | schedules under 1604-C — every employee paid during the year (even if they left in January) | with 1604-C | **electronic only** — BIR Online Submission Portal or the **Data Entry Module** `.DAT` file. No paper. |
| **SSS R-3 / contribution collection list** | monthly employer remittance detail | monthly | via My.SSS / e-payment; we produce the schedule |
| **PhilHealth RF-1 / EPRS** | monthly employer remittance report | monthly | via EPRS; we produce the schedule |
| **Pag-IBIG MCRF** | Membership Contribution Remittance Form | monthly | via Virtual Pag-IBIG; we produce the schedule |
| **13th-month pay** | mandatory, ≥ 1/12 of basic annual salary | on or before **Dec 24** | worksheet + payslip line |
| **Final pay / back pay** | on separation | within 30 days of clearance | worksheet |

**Sources:** [Mercans — BIR Form 2316 guide 2026](https://mercans.com/glossary/bir-form-2316/) ·
[Sprout — 1604-C & Alphalist 2026](https://sprout.ph/articles/first-time-bir-1604c-alphalist-filing-guide/) ·
[HashMicro — BIR Alphalist 2026](https://www.hashmicro.com/ph/blog/bir-alphalist/) ·
[GreatDay HR — BIR forms for employers 2026](https://greatdayhr.ph/blog/complete-guide-to-bir-forms-for-employers-in-the-philippines-2026-update/) ·
[Payroll Solutions PH — 2316 deadline 2026](https://www.payrollsolutions.ph/articles/156)

---

## 3. Build plan

### Phase A — the statutory engine  ✅ **done 2026-08-29**

- `payroll_tables` table — versioned reference data: `(kind, effective_from)` unique,
  JSON `data` blob, `note`. Seeded with the 2026 schedule (`INSERT OR IGNORE`, idempotent
  per kind). `src/shared/db.ts`.
- `src/modules/payroll/payroll-tables.ts` — `effectiveTables(date?)` resolves each kind to the latest row
  whose `effective_from ≤ date` (falls back to the built-in 2026 seed); `listPayrollTables`,
  `upsertPayrollTable` (replace on same kind+date), `deletePayrollTable`.
- `src/modules/payroll/ph-statutory.ts` — pure, DB-free:
  - `monthlySalaryCredit(comp)` + `sssContribution(comp)` → `{ msc, employee, employer, ec, total }`
    (5 % / 10 % of MSC; WISP above ₱20 k is the same split; EC ₱10 / ₱30 employer-only)
  - `philHealthContribution(basic)` → `{ employee, employer, total }` (5 %, half each, ₱10 k–₱100 k)
  - `pagIbigContribution(comp)` → `{ employee, employer, total }` (2 %, ₱200 cap, 1 % EE ≤ ₱1.5 k)
  - `withholdingTax(taxableForPeriod, frequency)` → tax (RWT bracket table, monthly /
    semi-monthly / weekly / daily)
  - `taxableCompensation(gross, nonTaxable, employeeStatutory)` and
    `statutoryDeductions(comp, basic, tables)` roll-up
- API (`src/modules/hr/hr.routes.ts`): `GET /api/hr/payroll-tables?date=` (list + resolved set,
  `hr.view`), `POST` (add/replace a version, `hr.manage`), `DELETE /:id` (`hr.manage`).
- Tests: `tests/ph-statutory.test.ts` (math vs the 2026 schedules),
  `tests/payroll-tables.test.ts` (seeding, effective-date resolution, RBAC).

### Phase B — payslip wiring  ✅ step 1 done 2026-08-29 (13th-month / final-pay pending)

- `PayrollPolicy` gains `pay_frequency` (`monthly` / `semi_monthly` / `weekly` / `daily`,
  default semi-monthly) and `auto_statutory` (default **on**). Both editable in
  Time Keeping → **Payroll Rules**.
- `POST /hr/periods/:id/generate-payslips`: when `auto_statutory` is on, each slip's
  `sss` / `philhealth` / `pagibig` / **`withholding_tax`** come from
  `statutoryDeductions()` + `withholdingTax()` on the tables effective for the pay date.
  ~~Monthly comp basis = `monthly_rate` or `daily_rate × monthly_rate_divisor`, divided by
  periods-per-month~~ — **superseded 2026-10-05** by the per-fund contribution bases in §1
  ("What each contribution is computed on"). `total_deductions` and `net_pay` are then rolled up
  (earnings − SSS − PhilHealth − Pag-IBIG − withholding − late − cash advance).
- `auto_statutory` off → those four stay manual (carried over on re-generate, as before).
  `cash_advance` / `rest_day_ot` / `ot_rate_hour` are always manual + carried over.
- `withholding_tax` field added to the `hr_payroll` form (seed + idempotent migration for
  existing installs) and to the seeded payslip template.
- Tests in `tests/hr.test.ts` ("computes SSS / PhilHealth / Pag-IBIG / withholding tax;
  auto_statutory:false keeps them manual").

**Phase B step 2 — done 2026-08-29:**
- **Rate-tables admin screen** — Time Keeping → Policy Settings → *Statutory Rate Tables →
  Open rate tables* (`rateTablesModal()`): per kind, the effective figures as editable
  JSON + effective date + note → "Save as new version" (`POST /hr/payroll-tables`);
  historical versions listed with delete. In-app Help topic "Payroll rate tables".
- **13th-month worksheet** — Time Keeping → *13th-Month*: `GET /hr/thirteenth-month?year=`
  sums `basic_salary` across that year's generated `hr_payroll` records per employee
  (dated by `pay_date`, else `created_at`), ÷ 12; table + CSV export.

**Still to do in Phase B:** final-pay / back-pay worksheet (needs a call on leave-balance
tracking first).

### Phase B — payslip, 13th-month, final pay

- Payslip: add SSS / PhilHealth / Pag-IBIG / withholding lines from the engine; show ER
  share on the employer copy.
- 13th-month worksheet: per employee, `basic earned Jan–Dec ÷ 12`, with a run/export.
- Final-pay worksheet: last salary + pro-rated 13th month + unused leave conversion −
  outstanding balances.

### Phase C — BIR outputs

- **2316** ✅ step 1 done 2026-08-29. `src/modules/payroll/ph-2316.ts` `compute2316(payslipRows, rwt, year,
  opts)` → Part IV-A / IV-B lines (gross comp, non-taxable = Σ statutory + 13th-month up to
  the ceiling, taxable comp, annual `tax_due` via the new `rwt.annual` bracket table, tax
  withheld, over/under). `GET /api/hr/bir-2316?year=` (list) + `/bir-2316/:employeeId?year=`
  (`hr.view`; `opts` — `de_minimis`, `taxable_previous`, `tax_withheld_previous`,
  `thirteenth_month_ceiling` — via query). Printable **"BIR 2316" doc-template** (seeded)
  rendered per employee in Time Keeping → BIR 2316 (table + per-row Print + CSV). It's a
  **worksheet** — de-minimis / allowances / previous-employer aren't in payroll; the doc
  says so and to validate against the official BIR form. Tests: `tests/ph-2316.test.ts` +
  an hr.test.ts endpoint case.
- **1601-C worksheet** ✅ done 2026-08-29. `GET /api/hr/bir-1601c?year=` → 12 months of
  `{employee_count, gross_compensation, non_taxable, taxable_compensation, tax_withheld}`
  from the payslips (by pay-date month) + year totals. Time Keeping → 1601-C (table +
  CSV). Non-taxable = statutory EE shares only (13th-month isn't a payslip line — noted
  in the UI + guide). `tests/hr.test.ts` endpoint case.
- **1604-C + Alphalist** ✅ Schedule 1 done 2026-08-29. `src/modules/payroll/ph-alphalist.ts`
  `alphalistScheduleRow(seq, emp, figures)` → the BIR's published Schedule-1 column set
  (per the "1604C Alphalist Format" annex — gross, non-taxable 7b–7f, taxable 7g–7j,
  previous-employer, tax due, withheld, YEA, adjusted, substituted-filing). `GET
  /api/hr/bir-alphalist?year=` → `{headers, rows, cells, note}`; Time Keeping → Alphalist
  (summary table + **CSV in the exact BIR column order**). **The machine `.DAT` record
  layout is NOT publicly published** (it lives in BIR's Alphalist Data Entry & Validation
  Module) — so we emit the column-exact CSV and the customer converts + validates with
  BIR's tool (or an Excel→DAT converter that takes this layout). Schedule 2 (MWE) not
  generated. Tests: `tests/ph-alphalist.test.ts` + hr.test.ts endpoint case.
  **Still to do:** the 1604-C return face itself (Σ 1601-C reconciliation summary).
- ⚠️ Phase C depends on the **current official form version + file spec**, which change by
  RMC. Get the live spec at build time; don't hard-code last year's layout.

### Phase D — agency remittance schedules

- SSS R-3, PhilHealth RF-1/EPRS, Pag-IBIG MCRF as monthly schedules/exports in each
  agency's expected column order.

---

## 3b. Government integration — APIs vs file formats (researched 2026-08-29)

**There are no public developer APIs from BIR / SSS / PhilHealth / Pag-IBIG for payroll
or tax filing.** Every PH payroll product generates the required artifact and the
employer uploads it through the agency portal. The plan is the same: **produce the exact
file each portal accepts; do not design around an API that doesn't exist.**

| Agency / output | Channel | Machine interface | We target |
|---|---|---|---|
| BIR returns (1601-C, 1604-C, 2550/2551…) | eBIRForms (offline Java app → encrypted file) or eFPS (web) | none | the figures; customer files in eBIRForms/eFPS |
| BIR **Alphalist** (1604-C attachment) | Data Entry / validation module → pipe-delimited **`.DAT`**, via eSubmission / email | none (file spec) | generate the `.DAT` to the current RMC layout, validate with BIR's tool |
| BIR **2316** batch | eSubmission accepts a 2316 `.DAT` | none (file spec) | `.DAT` alongside the printed certificate |
| BIR **EIS** (e-invoicing, RR 11-2025) | **real JSON API** to transmit *invoice* data; mandatory for covered taxpayers, deadline 31 Dec 2026 | **✅ yes** | only the **sales-invoice / accounting** track, not payroll; needs BIR certification |
| SSS R-3 collection list | My.SSS portal; **R-3 File Generator** (offline) for 10+ employees; older EDInet for accredited employers | none (file spec) | generate the R-3 file |
| PhilHealth RF-1 | **EPRS** portal — has a **CSV bulk-upload** module (PIN, salary, status, effectivity, DOB) | none (CSV spec) | generate the EPRS CSV |
| Pag-IBIG MCRF | Virtual Pag-IBIG; **eSRS** bulk upload of the remittance schedule | none (file spec) | generate the eSRS/MCRF file |

Notes:
- No aggregator ("Plaid for PH gov") exists; third-party "integrations" are portal RPA,
  unsanctioned and brittle. No public sandboxes — testing is against the live portals.
- Each file spec must be pulled from the **current** agency PDF / RMC at build time and
  checked against that agency's own validator before release.
- **BIR EIS** is the one real API and becomes mandatory (large taxpayers first) — a
  genuine integration project *if* we sell the invoicing/accounting side to a covered
  customer. Track it on the QuickBooks / accounting line, not here.
- Payment rails (GCash for Business, Maya, bank APIs) do have APIs, but that's *paying*
  contributions, not filing — separate scope (merchant onboarding). Not early.

---

## 4. Notes / decisions

- **Table-driven, not formula-driven, for SSS.** The SSS schedule has non-linear brackets
  + EC + WISP; encode the published table, don't approximate.
- **Everything versioned by effective date.** A payroll run for March 2026 must use the
  table effective then, even if edited later. Never mutate a past year's table in place —
  duplicate it forward.
- **Semi-monthly is the common PH cutoff.** The engine must support monthly, semi-monthly,
  and the "compute monthly, split across two cutoffs" convention for tax.
- **Keep the existing "HR Payroll" form + print pipeline.** Phase B enriches it rather
  than replacing it.
- Localisation hook: this whole module is the template for a future "country pack"
  (GO-TO-MARKET §7) — keep PH specifics behind `src/modules/payroll/ph-statutory.ts` + the tables.
