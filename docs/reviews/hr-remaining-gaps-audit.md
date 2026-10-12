# Remaining HR gaps — 10 October 2026

Reviewed commit: `fea60c3` on `restructure/module-architecture`. This is a findings report; the defects below are not fixed by this audit.

Remediation: see [HR leave linking and request integrity fixes](hr-leave-linking-fixes.md) for the subsequent implementation and verification.

## Evidence and boundaries

Nine focused API checks passed against disposable SQLite databases: eight reproduced gaps and one confirmed that approved attendance corrections are applied when a matching cutoff roster is subsequently created. The checks intentionally asserted current defective behavior; their success does not mean the implementation is correct. Code review traced the API effects into the Timekeeping picker and payroll calculation.

No sandbox or real-tenant business records were changed during this audit. The earlier request-form audit and live tests remain valid for their tested paths; this review covers additional cases those tests did not exercise. This is not a claim that every HR function has now been exhaustively audited.

## Prioritized findings

### 1. Approved multi-day leave cannot be fully linked through the picker — high

The picker hides any form ID already linked anywhere, including elsewhere in its own unsaved grid. That rule suits a single-day request but also applies to date-range leave. Payroll credits leave only on explicitly linked attendance rows.

Reproduction: approve two days of paid leave; link the request to the first day and leave the second blank. The linked-ID endpoint marks the request used, so the picker excludes it for day two. The leave bank consumes two days while payroll pays only one daily rate (500 in the test).

Suggested fix: make eligibility depend on employee, form type and covered date. Allow a date-range leave request on each valid covered day; offer an explicit action to apply the approved range across attendance rows and cutoffs. Avoid duplicate consumption of the leave bank.

Sources: [Timekeeping picker](../../public/js/modules/hr/hr-timekeeping.js), [linked IDs and attendanceDaysForEmployee](../../src/modules/hr/hr.routes.ts).

### 2. Payroll trusts cross-employee request links — high

Saving attendance accepts form IDs without verifying the beneficiary or covered date. Payroll checks approval status but does not validate that the request belongs to the employee receiving the pay. The picker also matches employees by display name rather than stable ID, making employees with identical names particularly vulnerable to accidental selection.

Reproduction: approve employee A's one-day paid leave, attach it to employee B's blank attendance, and generate payroll. Employee B receives 500 basic salary from A's request.

Suggested fix: validate beneficiary, allowed payroll form type and date on save, then validate again when computing payroll. Use employee IDs in the picker with a deliberate, unambiguous legacy fallback. Invalid links should produce a visible warning and must not authorize pay.

Sources: [attendance save and payroll resolution](../../src/modules/hr/hr.routes.ts), [picker name matching](../../public/js/modules/hr/hr-timekeeping.js).

### 3. Submitted leave duration can disagree with payroll coverage — high

Approval consumes `Number(data.days) || 0` rather than validating the duration against the requested range. Payroll treats a linked approved paid-leave request as a paid day regardless of that number.

Reproduction: submit paid leave covering two dates with `days: 0`; approve it and link it to both dates. Basic salary becomes 1,000 while consumed leave remains zero. This required an HR approval but demonstrates that approval does not protect the bank from malformed submitted duration.

Suggested fix: validate real dates, date order and positive permitted duration on the server. Compute chargeable duration from the agreed schedule/leave policy, or require an explicit documented override. Show the resulting bank deduction before approval.

Sources: [leave approval](../../src/core/me.routes.ts), [payroll leave handling](../../src/modules/payroll/hr-payroll-compute.ts).

### 4. Employee editing bypasses reasoned leave adjustments — high

The ordinary employee edit form exposes entitlement and consumed days. The employee update endpoint writes both directly without an adjustment reason or the dedicated leave-adjustment audit event. A stale employee edit can also overwrite consumption approved after the form was opened.

Reproduction: approve two days of leave, then save an earlier employee payload containing zero consumed days. The employee returns to zero consumed days without a leave-adjustment reason.

Suggested fix: preserve consumed days on ordinary employee updates. Route existing bank changes through reasoned, audited adjustments; provide a separate explicit correction path where consumed days genuinely need correction. Add stale-edit protection.

Sources: [employee update](../../src/modules/hr/hr.routes.ts), [employee edit leave fields](../../public/js/modules/hr/hr-employees.js).

### 5. Attendance accepts dates outside the cutoff and invalid times — high

Attendance dates and times are validated as short strings. Saving does not enforce that each date belongs to the cutoff.

Reproduction: a June 2026 cutoff accepts a row dated January 2030 with time-in `banana` and time-out `99:99`, returning HTTP 200.

Suggested fix: validate real calendar dates, supported time representations and cutoff membership before replacing any existing rows. Reject malformed data while retaining the user's draft for correction. Treat legitimate payroll readiness issues as advisory warnings, as agreed; malformed timestamps are a separate data-integrity issue.

Sources: [attendance schema](../../src/shared/validation.ts), [attendance save](../../src/modules/hr/hr.routes.ts).

### 6. Paid payslip explanations can drift from paid amounts — high

The paid payslip data is frozen, but its detail endpoint recalculates from current rates, exemptions, policy, calendar and linked-form state. The comment promising that details always match the stored payslip is therefore too strong.

Reproduction: generate and mark paid a slip containing lateness at a 500 daily rate. Backdate a rate change to 1,000. The detail endpoint now reports the new daily rate and a larger late deduction, while stored paid payslip data remains unchanged.

Suggested fix: persist calculation inputs and day-by-day results with each generation. Paid slips should display their saved breakdown. If a current-settings recalculation is offered, label it separately and show differences explicitly.

Source: [payroll detail](../../src/modules/hr/hr.routes.ts).

### 7. Overlapping leave approvals deduct the bank twice — medium

There is no overlap warning or reconciliation during filing or approval.

Reproduction: approve two paid-leave requests for the same employee and same date. Both succeed and consumed leave increases by two days for one calendar date.

Suggested fix: show overlapping pending and approved requests during filing and approval. Require a deliberate reconciliation/override for overlapping paid coverage, with a reason. The warning should remain visible rather than silently blocking ordinary filing.

Sources: [request creation](../../src/core/form-builder.routes.ts), [approval](../../src/core/me.routes.ts).

### 8. Required configured request fields are enforced only in the UI — medium

The request API validates a generic scalar dictionary rather than the configured form's required fields and types. The UI fixes improve normal filing, but stale clients or direct API calls can still create incomplete requests.

Reproduction: configure a required Reason field and submit an empty data object from a linked employee account. The API creates a pending request with HTTP 201.

Suggested fix: validate configured request fields server-side after auto-filling identity and date fields and removing approver-owned fields. Validate both new requests and permitted pending edits. Return field-specific messages usable by desktop and mobile.

Sources: [generic record schemas](../../src/shared/validation.ts), [creation](../../src/core/form-builder.routes.ts).

## Recommended implementation order

1. Shared request validation and employee/date eligibility, covering findings 2, 3, 5 and 8.
2. Date-range linking and overlap handling, covering findings 1 and 7.
3. Audited leave-bank mutations and stale-edit protection, covering finding 4.
4. Saved payroll calculation breakdowns, covering finding 6.

Keep malformed data and wrong-beneficiary links from authorizing pay. Preserve the agreed advisory-warning behavior for operational readiness issues.

## Business decisions before leave-policy changes

- Should a date-range leave consume scheduled working days or all calendar days? How should rest days and holidays count?
- Should approved leave be withdrawable through a reviewed reversal that restores its bank deduction? The current workflow allows pending withdrawal only; restoring an approved deduction requires an HR adjustment.

Until those decisions are explicit, the audit does not assume a new accrual, annual reset or cancellation policy.

## Confirmed existing behavior

An attendance correction approved before a matching cutoff exists is applied when its roster is subsequently created. That suspected gap was disproved by the control test. The desktop approval UI already explains the temporary absence of a matching cutoff; no missing replay defect is reported here.
