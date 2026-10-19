# HR verification — 19 October 2026

Scope: the `restructure/module-architecture` branch, employee self-service, requests and approvals, leave, attendance, payroll, payslip access, mobile HR, and payroll-derived statutory reports. The sandbox tenant was used for read-only API smoke checks; no real tenant or sandbox business records were changed.

## Verified

| Area | Evidence |
| --- | --- |
| Employees, permissions, requests, approvals, leave, timekeeping, clock, payroll, payslips, mobile HR | 784 tests across 47 focused files passed; TypeScript and whitespace checks passed. |
| Payroll-derived accounting, statutory reports, final pay and same-name ownership | 98 tests across eight focused files passed. |
| Sandbox availability | Login and read-only employee, cutoff, payroll-policy, and form-definition API requests returned 200. |
| Duplicate/reused names | New regression checks prove a name-only legacy payslip is not exposed to either same-name employee, while slips stamped with employee IDs remain visible to their owners and separate in 13th-month and BIR 2316 summaries. |

After rebasing onto the latest branch, the combined HR, accounting and mobile run passed 998 tests across 55 files. Three mobile test expectations were updated to match the newer access-screen wording and wait for asynchronously loaded release controls. TypeScript and whitespace checks passed again. These counts overlap with the focused runs above.

## Fixes from this pass

- Employee payslip list, timekeeping preview, and PDF access now require unambiguous ownership for legacy slips lacking `employee_id`. A stamped ID remains authoritative.
- Payroll ownership resolution treats shared and reused names as ambiguous. Generation and historical lookup cannot silently attribute a name-only slip to an arbitrary employee.
- 13th-month, final-pay, BIR, contribution, and monthly-withholding grouping uses stable employee identity, so equal display names do not merge distinct employees. Unresolved legacy slips remain separate from known employees.
- The rolling schedule-change test now explicitly marks its future roster date as a working day; it no longer fails when that date happens to be a rest day or holiday.
- An older rename test now expects both a finalized slip and a draft preview, matching the current employee-facing release policy.

## Remaining acceptance boundaries

- **Legacy payroll reconciliation:** A slip with no employee ID and a name shared or reused by multiple employees cannot be assigned safely from its name alone. It is withheld from employee self-service and appears as a separate unresolved group in summaries. HR must reconcile and stamp its true employee before relying on that row in a statutory filing.
- **Live workflows:** This pass did not create or pay sandbox records. The earlier sandbox acceptance in `hr-sandbox-acceptance.md` covered approvals, leave, corrections, generation, locks and PDF access on deployed code at that time; it does not establish that this branch has since been deployed.
- **Physical devices and financial sign-off:** Camera/GPS, offline sync and notification delivery on real phones, actual payment, manual payroll amount reconciliation, and external statutory filing were outside this run.
- **Live browser acceptance:** The sandbox API read checks passed, but this environment's Chromium did not trust the session proxy certificate. Browser navigation was stopped at TLS validation; no insecure browser bypass was used.

These boundaries prevent a claim that every HR scenario is gap-free. They identify the specific work needed before production sign-off rather than treating automated coverage as proof of all business outcomes.
