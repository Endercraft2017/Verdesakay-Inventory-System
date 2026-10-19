# Mobile planned count validation

Employees with Inventory viewing access now have My planned checks in Work and
from count history. Open, completed and cancelled checks are separate. Cards and
details show overdue state, full shelf path, build state, instructions, assigned
employee, due date, repeat interval and latest attempt. Due/overdue labels follow
the backend's UTC calendar and are labeled accordingly.

Starting an assignment reloads the worker's open task from the server. Its exact
item/location/build state and task ID override URL-supplied stock positions.
Pending observations open their existing count instead of a new submission;
rejected observations offer Recount. A manual count at an already assigned
position opens that assignment. A different existing draft requires explicit
discard before the assigned count replaces it. Supervisor approval and guarded
apply/verify remain separate; only reconciliation completes a check.

Supervisors with inventory.adjust can plan, reassign/edit due dates, instructions
and repeat interval, or cancel with a reason. The stock position is fixed on edit.
Only active authorized assignees are offered. Dates, intervals and cancellation
notes are validated. Submitted/approved or completed tasks have no edit/cancel
controls, and the backend rejects decisions made from stale screens. Coverage
includes previously checked zero-stock positions, current stock, last reconciled
count and open assignment; it opens the existing check or prefills a new plan.

Planning/edit/cancel drafts and immutable requests/keys use account/server-scoped
IndexedDB. Unknown outcomes must retry the original request; no automatic retry
or task completion is claimed. Recurring successors are created by the backend
at reconciliation and appear in the ordinary queue. Scheduling has no stock effect.

## Local verification

`node scripts/test-mobile-planned-counts.mjs` runs 13 Playwright scenarios against
a disposable real Express/SQLite backend, covering:

- Authorized assignee filtering and repeat validation.
- Lost create/edit/cancel responses, restart and identical key/body retries.
- Refusal of duplicate open assignments.
- Worker/supervisor visibility, overdue instructions and manual-count redirect.
- Immutable task identity despite changed URL parameters.
- Pending-state locks and Recount after independent rejection.
- Completion only after reconciliation, with one recurring successor on retry.
- Zero-stock coverage, phone width and exact planning prefill.
- A stale edit racing with a submitted observation.
- Wrong-worker and basic-role deep-link restrictions.

The existing `node scripts/test-mobile-stock-counts.mjs` also passed its 17
physical-count/source-closure scenarios after planned-work integration. Its
site-PC pending test uses simulated local-response headers, as documented in
`mobile-stock-counts-validation.md`; no real site-PC outage is claimed.
Screenshots/reports are under `work/mobile-planned-counts/` and
`work/mobile-stock-counts/` (ignored artifacts). Camera/printer hardware checks
remain separate.

TypeScript and 185 focused tests across seven files passed (the mobile suite
was rerun after the synchronization fix below). Coverage included mobile bootstrap, stock counts,
release slips, draft persistence, role access, cycle-count migration and the desk
access matrix. An existing kit refusal test used a fixed delay to assert its
return screen; it now uses that suite's readiness helper. The mobile suite was
rerun after this synchronization fix. No full-suite run or deployment is claimed.
