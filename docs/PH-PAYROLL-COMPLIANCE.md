# Philippine Payroll & Statutory Compliance — scope + current figures

> **Status:** Phase A (engine) + Phase B step 1 (payslip wiring) **built 2026-08-29** —
> see §3. 13th-month / final-pay + Phases C–D pending.
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
  per kind). `src/db.ts`.
- `src/payroll-tables.ts` — `effectiveTables(date?)` resolves each kind to the latest row
  whose `effective_from ≤ date` (falls back to the built-in 2026 seed); `listPayrollTables`,
  `upsertPayrollTable` (replace on same kind+date), `deletePayrollTable`.
- `src/ph-statutory.ts` — pure, DB-free:
  - `monthlySalaryCredit(comp)` + `sssContribution(comp)` → `{ msc, employee, employer, ec, total }`
    (5 % / 10 % of MSC; WISP above ₱20 k is the same split; EC ₱10 / ₱30 employer-only)
  - `philHealthContribution(basic)` → `{ employee, employer, total }` (5 %, half each, ₱10 k–₱100 k)
  - `pagIbigContribution(comp)` → `{ employee, employer, total }` (2 %, ₱200 cap, 1 % EE ≤ ₱1.5 k)
  - `withholdingTax(taxableForPeriod, frequency)` → tax (RWT bracket table, monthly /
    semi-monthly / weekly / daily)
  - `taxableCompensation(gross, nonTaxable, employeeStatutory)` and
    `statutoryDeductions(comp, basic, tables)` roll-up
- API (`src/routes/hr.routes.ts`): `GET /api/hr/payroll-tables?date=` (list + resolved set,
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
  Monthly comp basis = `monthly_rate` (monthly employees) or `daily_rate ×
  monthly_rate_divisor`. The monthly contribution is divided by periods-per-month
  (semi-monthly → ÷2, etc.). `total_deductions` and `net_pay` are then rolled up
  (earnings − SSS − PhilHealth − Pag-IBIG − withholding − late − cash advance).
- `auto_statutory` off → those four stay manual (carried over on re-generate, as before).
  `cash_advance` / `rest_day_ot` / `ot_rate_hour` are always manual + carried over.
- `withholding_tax` field added to the `hr_payroll` form (seed + idempotent migration for
  existing installs) and to the seeded payslip template.
- Tests in `tests/hr.test.ts` ("computes SSS / PhilHealth / Pag-IBIG / withholding tax;
  auto_statutory:false keeps them manual").

**Still to do in Phase B:** 13th-month worksheet, final-pay / back-pay worksheet, and an
admin **screen** for the rate tables (`/hr/payroll-tables` is API-only today).

### Phase B — payslip, 13th-month, final pay

- Payslip: add SSS / PhilHealth / Pag-IBIG / withholding lines from the engine; show ER
  share on the employer copy.
- 13th-month worksheet: per employee, `basic earned Jan–Dec ÷ 12`, with a run/export.
- Final-pay worksheet: last salary + pro-rated 13th month + unused leave conversion −
  outstanding balances.

### Phase C — BIR outputs

- **2316:** per-employee generation using the official form layout (printable HTML → PDF),
  populated from the year's payslips. Batch for all employees.
- **1601-C worksheet:** monthly totals (taxable comp, tax withheld, headcount) matching
  the return's lines.
- **1604-C + Alphalist:** annual reconciliation (Σ 1601-C = 1604-C) + the Alphalist
  schedules. **Export as the `.DAT` the BIR Data Entry Module / Online Submission Portal
  accepts** — this needs the current BIR Alphalist file spec (from the governing RMC) and
  must be checked against the BIR's own validation module before release.
- ⚠️ Phase C depends on the **current official form version + file spec**, which change by
  RMC. Get the live spec at build time; don't hard-code last year's layout.

### Phase D — agency remittance schedules

- SSS R-3, PhilHealth RF-1/EPRS, Pag-IBIG MCRF as monthly schedules/exports in each
  agency's expected column order.

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
  (GO-TO-MARKET §7) — keep PH specifics behind `src/ph-statutory.ts` + the tables.
