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

The follow-up legacy-owner reconciliation check passed 128 focused payroll/statutory tests and the same 998-test HR/accounting/mobile regression set. The local Playwright forms/payroll UX run passed 14 checks, 28 accessibility scans with zero reported violations, and zero page errors. These browser checks exercised the existing payroll and mobile forms flows; the new reconciliation dialog was verified by its API regression test and code review, not a dedicated browser interaction.

## Fixes from this pass

- Employee payslip list, timekeeping preview, and PDF access now require unambiguous ownership for legacy slips lacking `employee_id`. A stamped ID remains authoritative.
- Payroll ownership resolution treats shared and reused names as ambiguous. Generation and historical lookup cannot silently attribute a name-only slip to an arbitrary employee.
- 13th-month, final-pay, BIR, contribution, and monthly-withholding grouping uses stable employee identity, so equal display names do not merge distinct employees. Unresolved legacy slips remain separate from known employees.
- The rolling schedule-change test now explicitly marks its future roster date as a working day; it no longer fails when that date happens to be a rest day or holiday.
- An older rename test now expects both a finalized slip and a draft preview, matching the current employee-facing release policy.
- Payroll managers can now open **Review legacy owners** from the HR Payroll screen. It lists unresolved payslips, shows their original fields, and requires a verified employee and written evidence before assigning ownership. The correction updates only `employee_id`, preserves paid status and financial fields, and records a form revision and activity event. Regression tests cover permissions, mismatch/repeat rejection, self-service access, and 13th-month regrouping.

## Remaining acceptance boundaries

- **Legacy payroll reconciliation:** Ambiguous historical payslips remain withheld from employee self-service and separate in reports until HR verifies each one against source records using the new review flow. The application cannot infer the true employee from a shared name; HR must review and assign outstanding records before relying on statutory filing totals.
- **Live workflows:** This pass did not create or pay sandbox records. The earlier sandbox acceptance in `hr-sandbox-acceptance.md` covered approvals, leave, corrections, generation, locks and PDF access on deployed code at that time; it does not establish that this branch has since been deployed.
- **Physical devices and financial sign-off:** Camera/GPS, offline sync and notification delivery on real phones, actual payment, manual payroll amount reconciliation, and external statutory filing were outside this run.
- **Live browser acceptance:** The sandbox API read checks passed, but this environment's Chromium did not trust the session proxy certificate. Browser navigation was stopped at TLS validation; no insecure browser bypass was used.

These boundaries prevent a claim that every HR scenario is gap-free. They identify the specific work needed before production sign-off rather than treating automated coverage as proof of all business outcomes.
