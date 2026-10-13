# BIR 1604-C Alphalist (Alphalist of Employees)

The **Alphabetical List of Employees from whom taxes were withheld** — the schedule
attached to the annual **BIR Form 1604-C** (due **January 31**).

## What the system does

**Accounting → Tax & Compliance → BIR 1604-C Alphalist** builds **Schedule 1** — one row per employee in the BIR's
published column order, computed from the year's payslips + the annual tax table:
gross compensation, the non-taxable breakdown (13th-month, de-minimis, SSS/PhilHealth/
Pag-IBIG, salaries ≤ ₱250k), the taxable breakdown, tax due, tax withheld, the year-end
adjustment, and the substituted-filing flag.

**Export CSV (BIR layout)** downloads all of those columns.

## What you still do

The BIR publishes the column *format* but not the machine `.DAT` record layout — that
lives in the **BIR Alphalist Data Entry & Validation Module**. So:

1. Run all cutoffs and **Generate Payslips** for the whole year first (set the right
   **pay date** on each run).
2. **Accounting → Tax & Compliance → BIR 1604-C Alphalist**, pick the year, **Export CSV**.
3. Fill the columns payroll can't: **de-minimis benefits**, **allowances**, and any
   **previous-employer** compensation/tax for staff hired mid-year.
4. Bring the data into the BIR module — type it in, or use an **Excel → DAT converter**
   that accepts this Schedule-1 layout.
5. Run the module's **validation** and clear **every** error (it won't produce a file
   otherwise).
6. Submit the `.DAT` via eSubmission with the 1604-C, by January 31.

## Notes

- **Schedule 2 (minimum-wage earners)** isn't generated — the system doesn't classify
  MWEs. Add them in the BIR module if you employ any.
- The Alphalist totals should tie out to your 12 monthly **1601-C** returns and to each
  employee's **2316**.
- Employment-status codes: probationary → `P`, everyone else → `R`; resigned/terminated
  staff get separation reason `T`. Adjust in the module if you need finer classes
  (Casual, Contractual, Seasonal, Apprentice).
