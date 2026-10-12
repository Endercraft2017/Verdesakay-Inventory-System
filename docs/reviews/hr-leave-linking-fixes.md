# HR leave linking and request integrity fixes — 10 October 2026

This completes remediation of the eight findings in [the remaining HR gaps audit](hr-remaining-gaps-audit.md), plus the requested saved-form preview and complete leave date/reason controls.

## User-visible behavior

- Timekeeping shows details before linking an existing request: beneficiary, status, reason, configured fields, selected dates, and leave warnings.
- HR, employee web, and mobile leave forms accept inclusive ranges and individual dates together, across months. Review/back preserves the mobile draft.
- The server attaches leave to every selected date in existing cutoffs, and attaches previously filed leave when a future roster is created. Intervening unselected dates remain untouched. Paid cutoffs stay locked and produce warnings when a new attachment is needed.
- Only scheduled working days consume paid leave and authorize leave pay. Weekly rest days, approved rest-day changes, explicit attendance overrides, holidays, and no-work memos are considered. Selected nonworking dates remain visible and linked, with warnings.
- Overlapping requests remain allowed with visible warnings. Approving overlapping paid leave charges each date once.

## Integrity corrections

1. Eligibility is per employee and covered date; multi-day leave remains available after its first link.
2. Attendance save and payroll calculation independently validate beneficiary, form type, approval, and date coverage. Stable employee IDs take precedence; legacy names must be unambiguous.
3. Leave duration is computed from validated dates and schedule, rather than trusting submitted `days`.
4. Ordinary employee edits preserve entitlement and consumed leave. HR bank changes use the existing reasoned adjustment flow.
5. Attendance rejects invalid calendar dates, invalid clock times, duplicate dates, and dates outside the cutoff before replacing stored rows.
6. Generated payslips retain the calculation snapshot. Paid historical details cannot change after a rate/policy update. Legacy paid slips without snapshots display stored totals and explain why no historical day breakdown is available. Calculated payroll fields cannot be overwritten manually; manual deduction fields remain editable.
7. Approval records charged dates, avoiding duplicate balance consumption for overlapping requests.
8. Request APIs validate configured required fields, types, choices, dates, and reasons. Approval revalidates pending requests; employee identity and decision metadata cannot be supplied by the requester.

## Verification

- 581 tests passed across 24 focused suites, covering payroll calculations, approval authority, request ownership, leave banks, attendance, corrections, desktop/mobile request controls, offline synchronization, and the new regression cases.
- After integrating concurrent remote work, all 196 tests in the four intersecting HR/form suites passed again, and TypeScript checking passed.
- Live checks on 10–12 October passed in `/sandbox`: HR reason validation and saved-form preview; seven sparse September/October dates attaching to both cutoffs; inclusive employee web leave; mobile sparse-date filing and review/back preservation; future October/November roster auto-linking; pending-versus-approved leave pay; five-day balance consumption for seven selected dates; overlapping approvals without double charging; immutable leave banks under ordinary edits; missing reasons, invalid times/dates, and cross-employee links rejected; paid calculation unchanged after a backdated rate. The temporary paid test slip was returned to unpaid.
- Saved-form previews and date controls were inspected at desktop and 390px phone widths in light/dark modes. Final screenshots wait for theme transitions; no horizontal page overflow was observed. Mobile inputs now use themed, rounded 44px controls and the service-worker shell version was bumped.
- Sandbox test records carry the `HR-GAPS-UAT-5619064` prefix and were retained for review. Browser script selector/bookkeeping errors were corrected during verification. No real-tenant records were accessed or modified.

The historical audit records the original defects. These tests establish the behavior above; they do not claim exhaustive verification of every HR feature or physical mobile device.
