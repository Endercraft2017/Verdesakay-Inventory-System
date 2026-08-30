# Tax & compliance: BIR returns, final pay, agency schedules

**For:** accounting / payroll admin

The **tax filings** live under **Accounting → Tax & Compliance** (needs the
*Accounting: view* permission): BIR 1601-C, 1604-C (+ Alphalist reconciliation), 1604-C
Alphalist, BIR 2316, **0619-E** (expanded withholding), **2550M** (monthly VAT), and the
**SSS R-3 / PhilHealth RF-1·EPRS / Pag-IBIG MCRF·eSRS** contribution schedules.

The **payroll worksheets** stay under **HR → Time Keeping → Payroll Worksheets ▾**:
13th-month pay and the **final-pay / back-pay worksheet**.

All are worksheets built from your payroll / sales / purchase records — review before
filing in eBIRForms / eFPS or each agency's portal.

---

## Statutory deductions — per employee

**Accounting → Tax & Compliance → Statutory deductions** (needs *Accounting: manage*).

A grid of every employee with four switches: **SSS**, **PhilHealth**, **Pag-IBIG**,
**Withholding tax** — all **on** by default. Turn one **off** for an employee (e.g. a
contractor carried on the payroll for convenience, or someone whose contributions another
entity remits) and:

- that deduction is **zeroed** on their payslip the next time payslips are generated, and
- they **drop out of that fund's contribution schedule** for the month.

Use the **Toggle SSS / PhilHealth / …** buttons above the grid to flip every currently
visible (filtered) employee at once. **Save changes**, then re-generate the affected
payslips.

> HR's **Auto-compute statutory** (Time Keeping → Policy Settings) is the company-wide
> master switch — off means *nobody* gets auto statutory. These per-employee switches are
> the exceptions on top of it.

## BIR 2550M — monthly VAT declaration

**Output VAT** from the month's sale orders, **input VAT** from approved vendor bills
(each document's own tax amount, or a 12% derivation when it carries none). Tick
*Amounts are VAT-inclusive* if your order/bill totals already contain VAT. Enter any
input-VAT carry-over and advance VAT payments. The worksheet nets it to **still payable**
or **excess input VAT to carry forward**. Adjust for exempt / zero-rated sales and
disallowed input before filing. Deadline: 20th of the following month.

## BIR 0619-E — expanded withholding remittance

Add one line per **ATC** (Alphanumeric Tax Code = type of income payment: rentals,
professional fees, contractors, Top-Withholding-Agent purchases). Pick the ATC from the
list, enter the **tax base** (the portion of the payment subject to EWT); the rate and
tax fill in. The month's approved vendor-bill total is shown as a hint. Enter anything
already remitted this month to get **still payable**. The payee-by-payee detail goes on
the quarterly **1601-EQ + QAP** — 0619-E just remits the tax. Deadline: 10th of the
following month (11th on eFPS).

## BIR 1604-C — annual return face

The year-end **Annual Information Return of Income Taxes Withheld on Compensation**.

- Pick the year. The **monthly schedule** is what you filed on each 1601-C.
- The **Reconciliation** block compares:
  - *Tax remitted per 1601-C returns* (what you actually paid monthly), against
  - *Tax due per Alphalist* (the annualised tax each employee owes).
- **Over-remittance** carries forward / is refunded; **under-remittance** is still
  payable — settle it before filing.
- Attach the **Alphalist** (Gov Forms → 1604-C Alphalist) to the return.
- Deadline: **January 31**.

## Final-pay / back-pay worksheet

For an employee who has left. Pick them, set the **separation date**, and enter what the
payslips can't tell us:

| Field | What to put |
|---|---|
| Unpaid days worked | Days after the last processed payslip, not yet paid |
| Unused leave (days) | Convertible leave credits (the system doesn't track leave balances) |
| Other earnings | Any remaining taxable amount due (pro-rated allowance, etc.) |
| Outstanding advance / loan | Balance to net out (defaults to the cash-advance total on this year's payslips) |
| Other deductions | Equipment, training bond, … |
| 13th-month already paid | Any 13th-month released earlier this year |

**Compute worksheet** shows:

1. **Gross final pay** = unpaid salary + pro-rated 13th-month (year-to-date basic ÷ 12,
   less any already paid) + leave conversion + other earnings.
2. **Year-end tax annualisation** — the annual tax due on the employee's full-year
   taxable income vs. what was already withheld. A shortfall is **collected** from the
   final pay; an excess is **refunded**. The 13th-month / benefits amount above ₱90,000
   is added back as taxable.
3. **Net final pay** = gross − advances − other deductions − tax still due + tax refund.

It's a **worksheet** — check it against the 201 file and company policy before release.
Final pay is due **within 30 days** of separation (DOLE Labor Advisory 06-20).

## Agency contribution schedule (SSS R-3 / PhilHealth RF-1 / Pag-IBIG MCRF)

The monthly per-employee collection list each agency wants.

- Pick the **month** and the **agency**.
- Each row: the employee's agency ID (from their 201 file), the compensation **basis**,
  and the **employee**, **employer**, and — for SSS — **EC** shares, recomputed from the
  rate tables in force that month on the employee's total pay for the month.
- **Export CSV** and upload it in the agency's own portal:
  - **SSS** — Electronic Loan / Contribution Collection List (via My.SSS / ELRS)
  - **PhilHealth** — Electronic Premium Remittance System (EPRS)
  - **Pag-IBIG** — Electronic Savings Remittance System (eSRS)

There is **no direct filing API** for any PH agency (see
[PH-PAYROLL-COMPLIANCE.md](../PH-PAYROLL-COMPLIANCE.md) §3b) — the CSV is the handoff.

## Gotchas

- All three read the **generated `hr_payroll` payslips**. Generate payslips for the
  period(s) first, or the reports are empty.
- Employees are matched to their 201 file **by name** — keep names consistent so the
  agency ID numbers attach.
- The rate tables must be current for the year (Time Keeping → Policy Settings → *Open
  rate tables*) or contributions/tax will be off.
