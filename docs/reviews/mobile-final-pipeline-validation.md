# Mobile pipeline acceptance and CKD handoff fix

## Deployed sandbox

Using the provided sandbox login, actual deployed mobile assets and APIs passed
five custom-permission Playwright scenarios: the unchanged clerk role, per-person
grants, opening its real desks, revocation with retained read-only inventory,
and personal tools after removing operational access. The audit account (16) was
cleared of overrides and disabled; its uniquely named custom role remains for
audit history. No sandbox stock, sale, delivery or count was changed.

A read-only deployed PWA probe confirmed the count/planned-check modules return
200, both screens load their real endpoints, the worker controls `/sandbox/m`,
and the active cache is `vds-m:/sandbox:v115`. Offline shell reload and reconnect
passed with zero page errors. Commands:

- `MOBILE_WORK_TEST_BASE=https://otom.afkcube.com/sandbox` plus the provided test
  username/password through environment variables, then
  `node scripts/test-mobile-work-access.mjs`.
- The same environment variables with `node scripts/test-mobile-deployed-pwa.mjs`.

## Reproduced gap and fix

The actual phone load chooser blocked incomplete CKD kits, but a direct package
URL bypassed that chooser's validation and could lead further into an invalid
handoff. The backend warehouse-out guard still prevented invalid stock movement.

`so.js` now checks the selected CKD load at package, handoff, override, proof,
review and confirm entry, including recovered drafts. It rejects incomplete kits,
extra selected components, changed held quantities and unauthorized partial
loads. The chooser uses the same rule. Mixed orders may ship only the spare, or
one complete kit plus a spare, while extra components remain held on the same
sales order. Candidate PWA cache v119 picks up this fix; the deployed probe above
verified v115 and is not a claim that the candidate fix has deployed.

## Local browser acceptance

`node scripts/test-mobile-ckd-release.mjs` passed nine real-backend phone
scenarios: incomplete kits, all six deep-link entry points, extra components,
spare-only mixed loads, changed partial authority, one complete kit plus spare,
large-photo compression, and one-slip retry after committed response loss.
The large image shrank from 14,124,455-byte PNG to 1,720,158-byte JPEG at
1920 by 1600 before persistence and upload. Final stock reflected only the
selected load, with the extra frame still held; replay created no second slip.

`MOBILE_AUDIT_ABRUPT_RESTART=1 node scripts/test-mobile-qr-ux.mjs` passed 35 scenarios with Chromium's virtual
camera decoding generated print-sheet QR images. They include wrong labels,
unit/batch RTS and allocation, restart-safe evidence/signatures, committed
upload/slip/delivery response loss, optional delivery/courier evidence policy,
repeated sale lines/build states, same-order trips, and permission boundaries.
This mode also exercises a 12-megapixel camera-style image through real
compression/upload. Scanner callbacks and stock API responses are not replaced
in this suite. One intermediate ordinary rerun stopped on a Chromium persistent-
context launch timeout; the candidate was rerun successfully in the supported
abrupt-restart mode. This was a browser launch failure, not an app assertion.

`node scripts/test-mobile-pwa-update.mjs` passed four lifecycle checks: old worker
control, replacement/removal of old cache with updated release module, offline
reload and reconnect. A local deployment proxy supplies an old cache version
and a distinguishable release-asset marker, then switches to the candidate
worker/assets. This is real browser installation/activation/cache replacement,
not a complete historical application build. A test-only version message probe
identifies the controller. Awaited polling waits for activation and precaching;
no product-worker lifecycle change was needed beyond its cache bump.

Reports/screenshots remain under ignored `work/mobile-ckd-release/`,
`work/mobile-qr-audit/`, `work/mobile-pwa-update/`, `work/mobile-final-audit/` and
`work/mobile-work-access-audit/sandbox-deployed/`. Local fixtures use disposable
databases and do not affect the sandbox. All browser suites reported zero page
errors on their passing runs. TypeScript and 182 focused release/authorization/
QR/recovery/mobile tests passed. An additional 34 backend sync tests passed across inventory, sales, production,
files and failover using disposable site/cloud simulations. These improve
automated outage/replay coverage but do not replace a physical installed-PC
acceptance run. No full-suite pass is claimed.

## Limits

Virtual-camera decoding does not test physical print quality, phone optics,
physical-device storage/permissions or a real installed site-PC network outage.
Offline browser/restart and pending-header tests are distinct from real hardware
acceptance. The actual sandbox cache remains the observed v115 until deployment
of the candidate v119 is confirmed. No user-approved production data was changed.

Additional concurrency acceptance: after a complete load is saved, a second clerk
unreserves one required component through the real API. Reopening package, review
and confirmation blocks the stale load, creates no slip and deducts no stock.
Restoring the allocation permits the normal release and response-loss retry.

## Post-push sandbox verification (2026-10-19)

A subsequent live probe confirmed deployed cache `vds-m:/sandbox:v119` and the
actual release module contains both `ckdLoadProblem` and its handoff-entry call.
This supersedes the earlier v115 deployment observation above. Count/task screens,
offline shell reload and reconnect passed again without operational writes.

The deployed custom-access suite was extended and passed six scenarios. After
revocation, bookmarks for receiving, repairs, sales-order release, stock counts,
planned checks and stock movement all displayed access denied. Direct GETs for
RTS, repairs, release queue, count list and assigned tasks each returned 403.
The temporary employee (18) had overrides cleared and was disabled successfully.
No sandbox stock or orders were changed. These checks cover the custom clerk
fixture; they do not establish parity for every built-in role.

On disposable local data, all nine CKD release scenarios passed again, including
stale allocations and committed-response-loss retry. The separate CKD edge suite
also passed its five milestones, including preventing reuse of a shipped kit on
an empty second trip. All four worker-upgrade checks passed against v119. Passing
runs reported zero page errors. No new product defect was found in this pass;
changes extend the repeatable acceptance scripts. These latest checks used
Chromium; cross-browser coverage and physical acceptance remain unverified.

## Updated handoff and narrow-role pass (2026-10-19)

Read the new Current close-out status section and integrated remote updates
through `7d38981`, preserving earlier uncommitted acceptance additions. Older
dated gaps are implementation history where superseded. The component-override
quantity policy remains undecided and was not changed.

`node scripts/test-mobile-role-matrix.mjs` passed seven built-in role cases:
parts_clerk, production_lead, production_manager, qc_inspector, qa_inspector,
receiving_clerk and releasing_clerk. At 390x844 each had its expected Work queue
cards, opened its own desk, could not open stock movement, and received 403 for
a direct stock adjustment request. This is real disposable-backend mobile UI
coverage; it does not claim all desktop pages or all permissions are covered.

`node scripts/test-mobile-remaining-ux.mjs` passed ten real-backend scenarios
covering allocation correction response loss, persistent return photos and exact
serial selection, semi-built intake/transfer, job-issue evidence, committed QC
response loss, inspector return repair, direct-sale retry and basic-role gates.

`CHROMIUM_PATH=/usr/bin/chromium node scripts/test-mobile-notification-ux.mjs`
passed delayed repeated-click suppression, read failures, stale navigation,
notification retry and sign-out controls. This script uses production sources
with delayed sample APIs, unlike the real-backend role and recovery tests.
No new application defect was found. Firefox and WebKit browser executables are
not installed in this workspace, so no cross-browser pass is claimed.

Latest read-only sandbox probe confirmed active worker/cache v120, the deployed CKD
entry guard, count/planned-check screens, offline shell and reconnect, with zero
page errors. TypeScript and 24 focused role/modal/loading regressions passed.

## Pre-sticker QC/QA identification fix (2026-10-19)

The updated handoff in `e06005e` confirms QR stickers are attached at Products In,
after QA. The candidate v123 removes scan-first inspection wording, keeps queue
cards primary, always shows job order on cards, and presents all matching search
results. A partial identifier or job-order search cannot silently pick a unit.
Verification and recheck require an explicit physical identifier/job-order match;
missing identifiers prevent starting. Fresh checklist/disposition deep links
return to verification. Matching confirmation can advance even when the URL is
unchanged. Confirmation is intentionally not saved across a browser restart;
already-submitted immutable attempts retain their original recovery flow.
Bulk inspection also requires a match for each chosen identifier. Products In
scan verification remains unchanged. Work guides now explain the sequence.

`node scripts/test-mobile-inspection-identity.mjs` passed five real-backend phone
cases with two same-product, same-job-order units: clear cards, ambiguous search
and wrong-unit exit, deep-link guard/continuation, per-unit bulk confirmation,
and QA checklist/pass without a camera request or QR label. The exact unit moved
to Products In while the other stayed in QA; product stock remained zero.
`node scripts/test-mobile-remaining-ux.mjs` passed ten recovery cases, including
QC committed-response-loss retry after restart with original key/body.
`node scripts/test-mobile-qr-ux.mjs` passed 34 cases with zero page errors,
including real virtual-camera decoding and mandatory RTS scan verification.
These local tests used disposable data. The candidate has not been deployed.

Pre-sticker fix validation: TypeScript and all 166 focused mobile/QC/checklist/role
regression tests passed after adapting inspection tests to confirm physical
identity. Syntax and whitespace checks passed.
