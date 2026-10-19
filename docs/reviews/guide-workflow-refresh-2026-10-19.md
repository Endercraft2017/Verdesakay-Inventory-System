# Guide workflow refresh — 2026-10-19

Compared the current architecture branch's pipeline documentation, operator manuals,
desktop/mobile action handlers and focused backend tests with the guide library.
This updates instructions and reference navigation, not business transaction behavior.

## Reconciled changes

| Area | Current behavior reflected in the guide | Evidence checked |
|---|---|---|
| Sales, CKD and trips | Exact sale-line/build allocation; physical whole-kit loads; separate slip per trip; remaining demand stays on the same SO; remainder cancellation differs from returns | `public/js/modules/inventory/orders.js`, `releasing.js`; `tests/order-trips.test.ts`, `ckd-sales.test.ts` |
| Courier handoff | Booking belongs to a slip; carrier custody differs from customer delivery; delivery evidence optional in-app | Desktop releasing and `public/mobile/modules/inventory/deliveries.js`; current `docs/modules/pipelines.md` |
| Semi-finishing | Complete semi-built package becomes one inspection unit without another BOM pick/Add unit | Sales stock review; mobile semi-finishing; `tests/semi-conversion.test.ts` |
| Returns | Photo-backed receipt is custody only; inspection/restock, repair/reinspection and financial credit are separate | Desktop releasing, mobile returns, `tests/sales-returns.test.ts` |
| Counts | Assigned counts, independent review, exact batch/untracked corrections, serial investigation and explicit task completion | Desktop stock-counts; `tests/stock-counts.test.ts` |
| Connected invoices | Account and form grants, source snapshots/calculations, atomic submission to one open SO and immutable submitted source | Form Builder/Records; connected-forms manual; form-sales-workflow and form-entry-access tests |
| Payroll corrections | Preview versus save, revision history, paid locks, archived reasons, later same-month review and explicit posting | Current payroll pipeline and `tests/payroll-improvements.test.ts` |
| Production/quality/RTS | Approval → accept/pick/parts slip → production acceptance; serialized photo-backed output; evidence-backed inspection; early close preserves built output; receipt capacity/duplicate/recovery guards | Job-order/production/receiving handlers; production-close and rts-recovery tests |

Eight new roadmaps join the existing three. Existing sales, production, inventory,
quality, form, template and mobile Help instructions were corrected. Related workflow
links and per-stage recovery branches are shared with the roadmap renderer. Mobile
Guides has a Workflows & Pipelines selector and displays prerequisites, owners,
handoffs and conditional branches from the same content.

## Validation

- TypeScript passed.
- 113 tests passed across 15 targeted guide and business-workflow files.
- `node scripts/test-guide-ux.mjs` passed 67 browser checks: eleven desktop roadmaps
  at 1440 and 390 pixels in both themes, all 86 Help topics, and eleven phone
  roadmaps in both themes. No JavaScript errors or desktop document overflow.
- `git diff --check` and syntax checks passed.

The browser checks use a disposable application database and test account. They
verify current guide content, rendering and reference controls, not the hosted
workspace, real camera scans, printed labels, or every physical business handoff.
