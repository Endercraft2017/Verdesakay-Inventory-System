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
