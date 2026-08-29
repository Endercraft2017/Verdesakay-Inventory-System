# Payroll rate tables (SSS / PhilHealth / Pag-IBIG / BIR withholding)

The system computes statutory deductions from a set of **rate tables** that the
government updates from time to time. This guide is for the admin who keeps them current.

> **Status:** fully in. Generate Payslips auto-fills SSS / PhilHealth / Pag-IBIG /
> withholding tax from these tables (toggle in Time Keeping → Policy Settings → Payroll
> Rules → *Auto-compute…*, alongside your **pay frequency**). Edit the tables at
> **Time Keeping → Policy Settings → Statutory Rate Tables → Open rate tables** (HR
> manage). The **2026** schedule ships built-in.

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

## How to update a table

1. **Time Keeping → Policy Settings → Statutory Rate Tables → Open rate tables.**
2. Find the table that changed. Its current figures show as JSON — edit the numbers to
   match the new circular (the field names stay the same).
3. Set the **effective date** (usually `YYYY-01-01`) and a **note** (e.g. the circular
   number).
4. **Save as new version.** The old version stays for past payroll.
5. Run one payslip on the new period and check it against the agency's calculator.

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
