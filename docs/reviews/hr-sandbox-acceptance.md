# HR sandbox acceptance test — 10 October 2026

Tenant: `https://otom.afkcube.com/sandbox/`. All changes and test records were confined to this tenant. Real deployed APIs and the deployed desktop application were tested; these checks did not mock API responses.

## Result

35 API workflow checks and 27 browser checks passed. Browser checks reported no JavaScript exceptions. A navigation issue discovered during testing was fixed in commit `251a83e`, pushed to `restructure/module-architecture`, and verified after the updated application reached the sandbox. The fix also passed 22 frontend regression tests across four files, TypeScript compilation, and whitespace checks.

## Workflows exercised

| Workflow | Result |
| --- | --- |
| Department head sees department requests and approves leave | Passed; other departments excluded |
| Self-approval and cross-department approval | Denied as intended |
| Delegate approval, assignment and revocation | Passed; revoked authority cannot approve |
| HR approval while a department head remains assigned | Passed |
| Department decision notifies HR without second approval | Passed; notification retains an exact record link |
| Duplicate decision | Refused; leave is not consumed twice |
| Employee sees HR-filed request | Passed; beneficiary identity retained |
| Individual leave additions/deductions and history | Passed; employee cannot adjust their own bank |
| Employee submits leave through desktop | Passed |
| Head reviews and approves through desktop | Passed; decision note retained |
| Recent decision and employee notification destinations | Exact record dialogs opened |
| Rejected leave | Balance unchanged and reason visible to employee |
| Employee withdraws HR-filed request through desktop | Passed after explicit withdrawal confirmation |
| Ordinary employee opens Approvals | Explanation shown; no decision controls |
| Attendance correction approved by head | Applied to the correct cutoff; daily endpoint confirms saved times |
| Payroll readiness warnings | Visible for unset rate, missing punches and pending work |
| Payroll generation with warnings | Allowed; warnings returned and shown in cutoff UI |
| First paid slip locks shared cutoff | Attendance edits, cutoff dates, imports and correction application blocked |
| Generation while another slip is paid | Unpaid slip updated; paid slip skipped; no duplicate created |
| Remaining unpaid slip payment | Allowed |
| Paid payslip access | Owner can download PDF; another employee denied |
| Reopening | One remaining paid slip retains lock; unmarking all paid slips reopens cutoff |
| Correction after reopening | Applied successfully |
| Desktop schedule and payslip tabs | Rendered successfully |
| Light/dark, 1440px/390px cutoff and decision views | No document overflow; correct HR chrome and notice padding after fix |

## Issue fixed

A cutoff route includes record filters such as `period_id` and `employee_id`, whereas its navigation leaf has no filters. Route lookup only retained its fallback for unfiltered navigation. Opening a filtered cutoff from Home could therefore retain Home's navigation context, leaving an empty/mismatched sidebar and omitting the HR section's notice styling.

Route lookup now retains a matching route fallback even when record filters are present. Unfiltered navigation leaves also remain highlighted when their route opens a specific record. Live browser verification confirmed HR section selection, the Time Keeping highlight and the 16px notice padding in both themes and viewport sizes.

## Retained sample data

Test prefix: `HR-UAT-27515934`.

- Department: `HR-UAT-27515934 Department`.
- Four test accounts with linked employee records: head, delegate, employee and other (outside the test department).
- Cutoff: `HR-UAT-27515934 Cutoff`, 8–9 October 2026.
- Leave requests, approved attendance corrections, decision notifications, individual leave adjustment history and generated sample payslips.
- A Leave Request form was configured because the sandbox did not initially have one.

All sample payment marks were reversed at the end. The sample cutoff is unpaid and unlocked. Samples remain available for review rather than being deleted; no other tenant's records were changed. Credentials and session tokens are not included in this report.

## Limits

These results establish the exercised operational flows, permissions and visible UI behavior. The sample payslips do not certify payroll amounts against a manually reconciled real company cutoff. Push delivery to physical phones, offline queues, actual bank payments and external statutory submissions were not exercised. Role scope was tested with linked employee accounts, a registered department head, an appointed delegate and the sandbox administrator acting as HR.
