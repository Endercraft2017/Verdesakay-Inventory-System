# Mobile physical stock count validation

The mobile count screen records exact shelf/build-state observations and retains
serial exceptions for independent review. Legacy cycle-count links redirect to
this screen instead of posting generic adjustments.

`node scripts/test-mobile-stock-counts.mjs` uses a disposable real local
Express/SQLite backend, ordinary user/role APIs and real production/receipt
fixtures. It is not a deployment or a run against the live sandbox. The seventeen
Playwright scenarios cover blank explicit counts, lost-response/restart recovery
with identical body/key and one stored observation, self-approval suppression
when the counter gains supervisor rights, independent approval then one guarded
correction, QR-to-unit resolution, duplicate scans, persisted scans, missing and
unknown serial evidence, a uniquely matched unexpected serial, mandatory batch
quantities, stale-snapshot refusal and fresh recount, offline submission recovery, legacy redirect, phone
width, and a basic employee's denial. The final scenario simulates site-PC local
response headers and pending command state against a real count submission;
it checks pending UI/restart semantics, not an actual disconnected site-PC sync.

Reports and screenshots are under `work/mobile-stock-counts/` (ignored). Camera
input in browser checks uses the scanner's manual fallback with real QR payloads;
a physical phone camera/printer run remains manual acceptance. Ambiguous serial
labels render without a unit link; real legacy duplicate-label migration/site-PC
outage scenarios are not claimed as browser coverage. Counts never repair serial
identity or move a shipped/reserved unit through a generic adjustment.

The shared durable workflow now refreshes after Review when its destination hash
is unchanged; the supervisor count flow exercises that path. Refused physical
observations opt into clearing their editable draft after review so a new count
loads a fresh snapshot. Other workflows retain their previous draft policy.

Planned assignment discovery/planning is now implemented in the follow-up
described in `mobile-planned-counts-validation.md`. Task/source IDs stay immutable
in submitted counts.

Validation passed: TypeScript, 175 focused tests across five files, and all seventeen
Playwright scenarios with zero page exceptions. No full-suite pass or deployment
is claimed for this step.


## Explicit linked issue closure

Count history/details identify the source and current status. Supervisors can
review current discrepancy evidence or direct-sale ledger movements. Close linked
issue is offered only for an applied count whose current quantity/tracked
identities still match its observation, with an open, unclosed source. Submission,
approval and correction never auto-close it. Closure requires a 10-character
reviewer note and explicit confirmation; the note draft and immutable action/key
persist across restart. The resulting detail retains who closed it, when and why.

Changed stock or audit evidence blocks closure, reloads current evidence through
Review, and offers a fresh linked count retaining item/location/build state and
source identity. Already separately resolved sources have no closure button.
Closure itself moves no stock; the backend independently rechecks the snapshot
and captured audit hash.

The browser server seeds three historical discrepancies only in its disposable
SQLite database. All count/review/closure decisions use real APIs. The four new
Playwright scenarios check privilege/lifecycle/note gates and response-loss
recovery, changed stock with a fresh source-bound observation, a separately
resolved source, and a real direct-sale/slip plus excess-ledger fixture. The last
case changes ledger evidence while keeping current stock equal, verifies refusal
of the old count, then closes a new reconciled observation without stock movement.
No historical production stock or company data is used. Backend release-slip
regressions also cover stale direct-sale audit closure.
