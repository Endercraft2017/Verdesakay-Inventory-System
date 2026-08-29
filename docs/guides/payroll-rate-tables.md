# Payroll rate tables (SSS / PhilHealth / Pag-IBIG / BIR withholding)

The system computes statutory deductions from a set of **rate tables** that the
government updates from time to time. This guide is for the admin who keeps them current.

> **Status:** the calculation engine and the API are in. The screen to view/edit tables
> in the app arrives with payslip integration (Phase B) — until then, updates go through
> the API or with help from us. The **2026** schedule ships built-in, so payroll works
> out of the box.

## What's in a table

| Table (`kind`) | Holds | Changes |
|---|---|---|
| `sss` | contribution rate split, MSC floor/ceiling/step, EC premium | by SSS circular (last change Jan 2025) |
| `philhealth` | premium %, salary floor/ceiling | by PhilHealth circular |
| `pagibig` | rates, the ₱200 cap, the low-income rate | rarely |
| `rwt` | the BIR withholding-tax brackets, per pay frequency | by BIR RMC (unchanged since 2023) |

Each table is stored **with an effective date**. A payroll run uses the newest table
whose effective date is on or before the pay date — so when a new rate takes effect on
1 January, you add the new version dated `YYYY-01-01` and last year's runs still use last
year's numbers.

## When to act

- **Every January**, check for new SSS / PhilHealth circulars and a new BIR RMC. If the
  numbers changed, add a new version dated `YYYY-01-01`.
- **Never edit a past year's table in place** — that would silently change already-filed
  payroll. Add a new dated version instead.

## How the figures are verified

The built-in 2026 seed is marked *“verify against the current SSS circular / BIR RMC”*.
Cross-check the first payroll run of a new rate period against a manual computation or the
agency's own calculator before releasing payslips.

## Current 2026 figures (reference)

| | 2026 |
|---|---|
| SSS | 15% total (10% ER / 5% EE), MSC ₱5,000–₱35,000, EC ₱10 (MSC ≤ ₱14,500) or ₱30 |
| PhilHealth | 5% of basic, half each, salary ₱10,000–₱100,000 (EE share ₱250–₱2,500) |
| Pag-IBIG | 2% each, capped ₱200 each; 1% EE below ₱1,500 |
| Withholding tax | TRAIN table, unchanged since 2023; annual ≤ ₱250,000 exempt; 13th-month + benefits non-taxable up to ₱90,000 |

Full detail, sources, and the roadmap: [../PH-PAYROLL-COMPLIANCE.md](../PH-PAYROLL-COMPLIANCE.md).
