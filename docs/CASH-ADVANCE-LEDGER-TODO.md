# Cash Advance ledger — planned future development

**Status: not built.** This is a placeholder for a deliberately deferred feature, written
2026-09-04 when the "Other Deductions" section (payroll preview → payslip) was built.

## What exists today

The payroll preview (HR Payroll → click a row → the read-only detail modal) has an **Other
Deductions** panel: HR can add ad-hoc lines (label + amount — e.g. "Cash Advance", "Uniform")
per employee, per cutoff. They sum into `other_deductions_total`, feed into `total_deductions`/
`net_pay`, and print on the payslip. Nothing is tracked across cutoffs — if an employee still
owes a balance next cutoff, HR re-enters a line by hand. The existing single `cash_advance`
field (already wired into accounting auto-posting, BIR 2316, the doc catalog) is untouched and
still works exactly as before.

## What's planned (not started)

A persistent Cash Advance ledger per employee:

- A running balance per employee (a `cash_advances` table: employee, amount issued, date, notes).
- Issuing a new advance (increments the balance) — probably from the Employee record or HR →
  Cash Advances, not from inside a payroll run.
- Auto-deducting an installment each cutoff (configurable: fixed amount, fixed number of
  installments, or "pay off in full next cutoff") until the balance reaches zero, instead of HR
  manually re-typing an "Other Deductions" line every time.
- A payoff/balance view so HR can see who owes what without checking each payslip.

## Why deferred

The user asked for "CA and other deductions" on the payroll preview; when offered the choice
between (a) simple ad-hoc per-cutoff lines now, with the ledger as a noted future item, or (b)
building the ledger immediately, they chose (a) — see the conversation this file was written
from. This file exists so that choice isn't forgotten; pick it back up when asked to build the
ledger, and prefer folding it into (or replacing) the existing `cash_advance` field's role rather
than introducing a third, separate deduction mechanism.
