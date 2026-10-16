# HR workflow audit and fixes — 10 October 2026

## Agreed business rules

Department heads and authorized department delegates can decide requests in their own department. HR retains approval authority, including when a head is unavailable or unable to act; availability is a human decision rather than a software restriction. A department decision notifies HR and appears in decision history without requiring a second approval. Users cannot approve their own requests.

All employee HR tasks and approval tasks are available on desktop. Payroll readiness issues are visible advisory warnings and do not block generation. Employee leave entitlement varies individually; HR can add or deduct days with a recorded reason without resetting consumed leave. Cutoff attendance locks after payment.

## Delivered changes

- Desktop My HR provides employee requests, attendance corrections, schedules and payslip access. Approvals provides pending work, decisions, notes, history and department delegate settings.
- Department scope is enforced on the server. Requests filed on behalf of an employee retain that employee's identity, department and leave bank; the employee can see and withdraw pending requests. Department decisions notify HR, and decision notifications open the relevant desktop record.
- Generic form editors cannot bypass the dedicated approval lifecycle or delete request history. Leave consumption and request decisions are transactional.
- Individual leave adjustments require a reason and retain an audit trail. Employee-linked account creation is atomic and requires a saved employee.
- Payroll warnings identify unset rates, incomplete attendance, unlogged employees and pending requests/corrections. They remain visible before and after generation.
- A stable cutoff ID connects generated payslips to attendance, including custom or renamed labels. Regeneration skips paid slips and avoids duplicates.
- Any paid payslip locks the shared cutoff's attendance, roster and dates, including imports and correction application. Other unpaid slips can still be generated and processed. Explicitly unmarking every paid slip reopens the cutoff. Raw clock punches are retained without rewriting paid payroll attendance.
- Navigation protects unsaved dialog edits and active saves, rejects stale asynchronous page renders, preserves failed destinations for retry, and supports record-level notification links. Employee readers receive read-only profiles; HR calendar and rate-table controls respect separate permissions.
- Workflow screens use consistent light/dark treatments, readable status and warning panels, responsive tables, keyboard controls and dialog focus handling. Mobile approval feedback now distinguishes queued decisions from saved decisions.

## Verification

- Final relevant regression run: 670 tests passed across 29 files.
- Earlier broad run: 1,981 of 1,983 tests passed. The two rest-day failures used already-approved creation fixtures, bypassing the new approval lifecycle; fixtures were corrected and the affected tests passed in the final regression run.
- TypeScript compilation and whitespace checks passed after the final identity-preservation type correction.
- Chromium review: 11 workflow screen/dialog states, each in light/dark mode at 1440px and 390px: 44 combinations, with no document overflow or script errors.

Browser checks used the real frontend with fixture API responses. Backend workflow tests used disposable databases. This verifies implementation behavior and presentation, not live production employee data or operational payroll reconciliation. No production payment or leave records were modified during this review.

## Operational choices

HR should establish who maintains department delegates and when an HR override is appropriate. The software deliberately does not infer absence or demand a second approval. HR should review advisory warnings before payment and use the explicit unmark-paid action only when intentionally reopening payroll. Pending-request warnings may include requests outside the cutoff; their text asks the reviewer to assess relevance.
