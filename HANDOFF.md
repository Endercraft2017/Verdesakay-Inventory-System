# HR timekeeping and payroll — focused review

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
