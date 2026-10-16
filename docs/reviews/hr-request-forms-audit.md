# HR request forms audit — 10 October 2026

Scope: HR Timekeeping creation and employee requests through desktop My HR and the mobile web app. All live writes were confined to the sandbox tenant. The real tenant was unchanged.

## Fixes

- Timekeeping now renders configured form fields, including required custom fields, and requires a real reason instead of inserting a generic reason. Date, employee identity and one-day leave duration are filled from the selected attendance day.
- Requests created by HR remain pending until approved. The interface shows their status and reminds HR to save Daily Time to retain the link. Reported absence remains an approved attendance record.
- Linked requests affect payroll and attendance classification only when approved. Pending links previously could affect pay. Pending half-day requests also no longer suppress review warnings.
- Mobile review-back retains entered details. Fresh login loads the employee profile immediately, and accounts without an employee link receive an explicit explanation.
- Department delegates receive approval access in their login profile. Employee submissions cannot supply approval metadata or an approved overtime-hours cap.
- Time fields are supported by the form schema and builder. Internal employee and approver IDs are hidden from request details.
- Existing-form picker rows use the app's button styling and a bounded scroll area so long lists do not bury the creation fields on phones.

## Verification

- 553 regression tests passed before the final small schema/profile additions; focused follow-up suites passed after those additions, including 185 tests after integration and 34 final authentication/workflow tests. These counts overlap and must not be added.
- TypeScript and JavaScript syntax checks passed.
- Live sandbox: 45 form checks passed across nine Timekeeping form types and all eleven configured employee request types on both desktop and mobile. Required validation, saved details, mobile review-back, status and persisted attendance links were checked.
- Live sandbox: five payroll checks passed. With linked requests pending, the sample employee's basic pay was 600. Approving the one-day paid leave changed it to 1,200, exactly one daily rate. Existing payslip identity was retained; the cutoff remained unpaid and unlocked.
- 24 browser layout cases passed across light/dark themes, desktop and 390px phone layouts for leave, half-day and offset. No horizontal overflow or browser errors were recorded. Representative screenshots were reviewed; that review identified and prompted the picker styling adjustment.

## Test data and limits

Sandbox records use the prefix `HR-FORMS-UAT-1839619`. Thirty-one forms were created. One leave request was approved for the payroll test; other approval requests remain pending. Draft payroll was regenerated, with no paid marking or ledger posting.

Timekeeping leave creation intentionally covers the selected day only; employees can use the regular leave request form for a date range. The sandbox configured eleven employee request types; travel, COE, reimbursement, loan and training were not configured and were not live-tested. Mobile checks used Chromium phone emulation, not a physical device or offline installation. No claim is made that these checks cover every tenant's custom configuration.
