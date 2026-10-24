# Mobile Schedule and payslip recovery

Chunk 20 keeps the existing Schedule, payslip list/detail and Timekeeping panel design.

- A missing roster date is unpublished. `is_working_day: false` is a non-working date (which may include a holiday), rather than an inferred rest day. Recorded punches never stand in for planned shift times. Week controls, date focus and Upcoming stay in sync; schedule requests use only the exact selected future published working day. Server eligibility remains authoritative.
- Refresh and Retry use shared, bounded reads. An ordinary network failure retains last loaded records. Authorization failures clear the affected cached records. All caches are private memory scoped to server, user, employee, sign-in and borrowed-phone mode.
- Net pay is the supplied `net_pay`, including a legitimate zero. Missing/invalid amounts are unavailable; no client payroll calculation is substituted. Counts remain plain numbers and bookkeeping fields remain hidden.
- Overtime follow-up matches a nonempty payslip period. Failure is visible and independently retryable; it does not change payroll amounts.
- PDF preparation requires explicit `finalized === true` and a nonempty server URL. It is single-flight, bounded to 60 seconds, retryable and repeatable after completion. Leaving its owning screen cancels preparation and prevents late browser delivery. Optional API lifecycle guards prevent a late employee read/file 401 from expiring a newer session; existing callers keep their behavior. The server still checks ownership and current Paid status.
- One Timekeeping panel owns one read. It supports Retry, Tab trapping, Escape, focus return and background inertness. It closes on owner-screen replacement, navigation or account change. Saved calculation, current punches and legacy warnings come from the response; an empty cutoff is explicit.
- Mobile cache v143 carries the changed assets. No API routes, payroll calculations, approvals, punch capture, database schema or dependencies changed.

Validation: `npm run check` passed TypeScript and 3,102 tests across 300 files. Final focused regressions passed 39 tests. Actual-source Chromium passed 38 checks, including 12 clean targeted axe scans; `tests/frontend-mobile-pay-schedule-ux.test.ts`, `tests/frontend-payslip-download.test.ts` and existing API regressions; isolated Playwright/Chromium with actual scripts/CSS and fictional API data. Browser checks cover normal/error/slow responses, modal ownership/focus and five widths. Targeted axe scans cover the four normal surfaces in light/dark themes plus modal errors, unpublished dates, missing net pay and a modal opened from a draft. Source-spelling checks for these two modules were replaced by runtime coverage, including retained Figma markers.

The review Page retains the interactive design reference and before/proposed boards, alongside actual-source captures. Live authenticated sessions, physical devices and real payroll downloads were not exercised.
