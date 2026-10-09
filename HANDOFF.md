# HR timekeeping and payroll — focused review

## Current scope — layout repairs only (2026-10-09)

**Kyle cancelled the redesign.** Preserve the existing desktop HR layouts, modals, fields,
controls and workflows. The prototypes below are historical proposals, not implementation
requirements; do not replace the attendance modal or remove/reorganize its elements.
Only fix text clipping, overflow, resizing and related presentation defects. Commit/push remains
authorized on the current branch; unrelated roadmap edits and error_logs.md stay untouched.

Current batch: scoped CSS for contained table scrolling, readable time/photo cells and dropdowns,
wrapping names/payroll actions/modal headers, contact values/history, and asset filter sizing.
JS edits only add styling hooks/wrappers and remove one redundant inline flex declaration.
All 11 Daily Time columns, modal controls, permissions and calculations remain unchanged.
Module catalog and pipeline map checked: no responsibilities, interfaces or workflow stages change.

Verification passed: required `npm run check -- --hookTimeout=60000` (exit 0), TypeScript plus
**182 files / 1,928 tests**, 786.42 seconds. Changed JS syntax checks and git diff --check passed.
Stylesheet parsed without CSS parser errors; this is not proof of rendered layout.
Rendered visual QA remains **blocked**, not passed: browser open to localhost was denied even
after the authorized exact-host exception and a managed-browser stop/start. Custodian removed
the exception by setting browser to {}; gateway config.get verified {}. Original browser section
was absent; an inert empty object remains because custodian exposes no unset operation.
No broad network exception or production-data access was used. Task-owned synthetic preview stopped.

Publication: layout-only batch on `restructure/module-architecture`; no main merge or deployment.
Remaining: rendered HR screen/modal checks at desktop and narrow widths when browser access works.
Do not resume the cancelled redesign; any further edits must retain the existing elements/workflows.

## Objective and scope (2026-10-08)

Kyle authorized review and improvements, with minimal token use. Preserve the existing
uncommitted work; use focused source reads and regressions. No deployment or production edits.
Instructions: `CLAUDE.md`, shared Coding Hub defaults; module/pipeline maps under `docs/modules/`.

## Completed

- Reproduced two defects with failing API regressions, then fixed them:
  1. Change rate now recomputes from the earliest repaired unset-rate history, not just the
     requested effective date. Earlier unpaid slips update; Paid slips remain untouched and
     their gross shortfalls are reported.
  2. Both rate-change POST and employee-edit PUT reject impossible effective dates before
     writes. Valid leap dates remain accepted.
- Changed HR route, payroll rate-history helper, shared validation, and `tests/hr.test.ts`.
  Updated architecture/catalog/pipeline records. No schema, UI, statutory-policy or dependency changes.

## Verification

- `npm run typecheck`: passed after changes.
- `npx vitest run tests/hr.test.ts tests/hr-daily-report.test.ts tests/hr-payroll-compute.test.ts tests/hr-payroll-export.test.ts tests/payroll-next-day-timeout.test.ts tests/payroll-permission.test.ts tests/rate-history-unset-migration.test.ts tests/sync-payroll.test.ts --hookTimeout=60000`: **8 files, 371 tests passed**.
- `git diff --check`: passed.
- Initial baseline: 258 passed; HR setup exceeded the default 20-second hook timeout.
  Focused final run used a 60-second hook allowance; all tests ran and passed.
- Full ERP suite, browser workflows and real multi-device sync were not run. No production data touched.

## Inspection / next pass

Inspected current rate-change/recompute code and tests, half-day computation/classifier changes,
relevant permissions and validation, HR/payroll module and pipeline records. Export behavior
was tested, not fully source-audited. Broader architecture/roadmap inspection remains partial.

Next: examine Daily Report versus payroll for overnight and exemption boundaries; inspect custom
payroll-label matching on rate-change recomputation. These are review targets, not verified fixes.
Legacy employee PUT/import still do not auto-recompute payslips (unchanged documented behavior).
No separate model/delegation was launched. Read this file to resume without reloading the full repo.


## HR desktop UI/UX refinement (2026-10-09)

### Delivered scope

Kyle authorized UI/UX improvements plus commit/push. Refined the existing desktop Timekeeping
cutoff list/roster and Payroll list using Claude Code with installed Impeccable guidance.
No mobile redesign, deployment, schema/API changes or payroll-rule changes in this UI pass.

- Separated primary actions, labeled filters, and inline secondary-tool disclosures.
- Cutoff search/year and roster completion filters, result counts, Reset/Clear filters.
- Real buttons for cutoff/employee/payslip entry and period expansion; named row actions.
- Retryable load errors and distinct empty/no-match/not-found states.
- List write actions follow HR/payroll permissions. Read-only Daily Time has disabled fields,
  no save/notice/link actions, while photo inspection remains available.
- Fixed roster column alignment without payroll.view and the title after cutoff edits.
- Scoped CSS reuses incumbent light/dark tokens; non-payroll forms retain their toolbar.

### Verification

- Final focused run: `node node_modules/vitest/vitest.mjs run tests/frontend-hr-ux.test.ts tests/frontend.test.ts tests/frontend-nav.test.ts tests/frontend-guide.test.ts tests/hr-payroll-export.test.ts tests/hr-payroll-print.test.ts --hookTimeout=60000`: **6 files, 59 tests passed**, including 16 new UI scenarios.
- Final `npm run typecheck`, both changed scripts' `node --check`, and `git diff --check`: passed.
- Impeccable source detector: exit 0, no findings (before the final read-only-modal/CSS-scope adjustments).
- Full required check: `npm run check -- --hookTimeout=60000` passed (exit 0): **181 existing files, 1,912 tests**, 759.48 seconds. The newly added UI file was verified separately: **16/16 passed** after the final read-only notice guard.
- **Not visually verified:** OpenClaw browser navigation to the isolated localhost preview was
  blocked by policy. No screenshot, breakpoint, contrast or real-browser interaction pass is
  claimed; jsdom checks exercise the DOM and events, not layout. Task-owned preview was stopped.

### Delivery / continuity

- Publishing on existing `restructure/module-architecture`, not main; no merge or deployment.
- Commit includes the previously uncommitted HR/payroll work summarized above plus this UI pass.
  Unrelated offline-packaging roadmap hunks and `error_logs.md` remain outside the commit.
- Updated architecture/per-file HR reference. Catalog and pipeline records reviewed: this UI pass
  changes no module boundaries, contracts or business pipeline stages; existing HR behavior notes
  are included, unrelated roadmap notes excluded.
- Next: visual review on a permitted local browser (desktop, narrow width, light/dark), then extend
  the same UX treatment to Employees and Daily Report if desired. Earlier overnight/exemption and
  custom payroll-label consistency review targets remain unverified, not fixed by UI work.

## Historical desktop HR redesign brief (superseded by layout-only scope above)

Kyle answered the original scope question after the first batch was pushed: **entire desktop HR**.
Main friction: **correcting attendance**, **reviewing payroll**, and an overall design that is too plain.
Commit/push authorization continues; keep unrelated roadmap edits and error_logs.md untouched.

### Coverage and proposed work

- Shared HR visual treatment across Overview, Employees, Contact Verification, Company Assets,
  Timekeeping, Kiosk, Daily Report, Payroll, HR Memos/Notices, Anonymous Reports and HR Form Builder.
  Preserve non-HR screens, existing role boundaries, branding commitments and all business calculations.
- Overview: emphasize actionable attendance exceptions and pending work, with clear route links;
  secondary modules remain discoverable. Never expose pay/confidential summaries to unauthorized roles.
- Attendance: prioritize exception rows, clarify date/employee context and overnight times, improve
  editing ergonomics, show unsaved changes, protect against accidental dismissal, preserve linked
  approvals and require explicit saves. No silent correction or automatic change to pay policy.
- Payroll: make server-backed pay totals/status/earnings/deductions easier to scan before the existing
  detailed attendance explanation; keep paid-slip protections and printing/export behavior.
- Other HR screens: consistent hierarchy, spacing, toolbars, table states and accessible interactions.
  Common corrections confirmed: missing punches and incorrect time-in/time-out. Kyle requested a
  visual sample before choosing the direction; no expanded-scope app implementation yet.

### Browser verification blocker / concrete remedy

Public example.com navigation succeeded; the managed browser is healthy. Local preview navigation
was blocked by private-network policy. Browser plugin config is currently empty/default.
Installed browser docs describe a narrow allowedHostnames localhost exception. Asked Kyle for a
**temporary localhost-only exception**, restored after the task. Kyle approved this on Oct 9;
no unrestricted private-network access and no policy change performed yet. Use the OpenClaw system
tool for the authorized temporary config change when local browser QA is needed, then restore it.

### Pending questions

1. Kyle said the visual direction is fine, then asked to clarify full-period/batch editing. Delivered an inline interactive sample of the recommended
   navy/blue operations workspace: employee exception queue, correction editor showing original
   times, and payroll review with net pay and expandable supporting details. All data synthetic;
   demo-only controls never save real attendance/payroll. Source: .tmp/hr-ux/design-sample.html.
2. Missing punches and wrong time-in/out are confirmed correction priorities.
3. Localhost-only temporary browser exception approved; not applied yet.

Sample delivery succeeded. Rendered appearance/interactions were not independently verified:
no attached browser tabs, and Gateway desktop screenshot provider is unavailable. No app code
changes, new commit, push, or full test run for this decision-aid sample.

Next: incorporate answers, capture durable product/design context, implement with a focused Claude
Code/Impeccable brief, perform actual visual plus behavioral checks where permitted, commit and push.

### Full-period editor sample (2026-10-09)

Kyle needs the entire employee cutoff visible and editable, not only a single-day correction panel.
Proposed complementary workflows: quick correction panel plus spacious full-page employee cutoff
editor (replacing the cramped modal layout without losing batch capabilities).
Delivered a second inline sample: .tmp/hr-ux/cutoff-editor-sample.html, with 15 synthetic days,
individual cell edits, selected-day time-in/out bulk apply, original-value hints, lunch/notes details,
review of all changed values and one explicit demo-only save. Rest days stay visible/selectable.
jsdom interaction checks passed for row count, bulk apply, multi-day edits, details, review, save and
discard. Rendered visual QA remains unperformed. No application change/commit/push for this sample.
Next: incorporate feedback on this example into implementation; commit/push authorization persists.
