# Inventory and production branch acceptance — 2026-10-19

Branch: `restructure/module-architecture`. The browser runs used disposable local
databases, a real Express server, and Chromium at desktop (1440 px) and phone
(390 px) widths. They did not change live stock or production records.

## Tested business paths

| Path | Evidence and result |
| --- | --- |
| Purchase to kit | Partial goods receipts, job approval, partial kit pick blocked from release, complete kit release, and role denial passed in `work/role-pipeline-acceptance.mjs`. |
| Production to RTS | Production recording, QC then QA, Products In receipt and lost-response replay passed in the role scenario. A no-sale buffer job made two units with separate partial Products In receipts; both became RTS stock in `work/inventory-production-branches.mjs`. |
| Sales demand | Aftersales parts shipped without a production job in `work/inventory-production-branches.mjs`. Fully built and semi-built allocation and semi finishing choices, negotiated price and fees passed in `work/semi-pricing-browser.mjs`. Repeated SKU sales lines passed in `work/duplicate-lines-browser.mjs`. RTS shortage and a later Products In receipt were checked before and after sale planning. |
| CKD | A partial CKD release with one whole kit passed; an incomplete kit and a kit with an extra picked component were blocked in `npm run test:inventory:ckd-courier`. The same browser check confirms that a held spare can enable a partial slip for a mixed CKD/non-CKD order. The desktop control previously became available when any CKD component was held, even with zero whole kits. It now counts only components held for the next trip, and requires a whole CKD kit or a held non-CKD line, with no unmatched CKD components. The server already rejected incomplete CKD slips. |
| Stock assurance | Physical count, planned cycle count, serial exceptions, linked discrepancy/direct-sale closure, and direct-sale audit review passed in `work/stock-count-browser.mjs`, `work/cycle-count-browser.mjs`, `work/serial-count-browser.mjs`, `work/stock-count-closure-browser.mjs`, and `work/direct-sale-audit-browser.mjs` at both widths. |
| Release and delivery | Wrong-location stock blocked approval, exact-unit movement, release and same-key replay passed in the role scenario. Direct-sale lost-response replay produced one stock-out and a desktop slip in `work/direct-sale-cross-device-browser.mjs`. Courier pickup and proof passed at both widths in the committed CKD/courier scenario. |
| Phone-specific actions | `npm run test:mobile:workflow` and `npm run test:mobile:qr` passed. They cover allocation correction, returns, semi transfer/intake, issue reports, QC retry, direct sale, printed QR/wrong-label scans, RTS/release, handoff evidence retry, delivery trips, access, courier pickup, and restart recovery. |

The initial `npm run check` ran TypeScript and all 2,871 tests: 2,870 passed.
One `frontend-mobile.test.ts` assertion still expected the old blocked-screen
title “Nothing here for you yet”; the current access screen correctly says
“Phone access isn’t enabled” and explains the required permission. The affected
147 tests passed with that expectation corrected. An upstream commit made the
same assertion correction while this audit was running; the branch was then
fast-forwarded before final validation. This was a test expectation mismatch,
not an access-control failure.

Final validation on the combined branch: `npm run check` passed TypeScript and
all **2,872 tests across 285 files**. The committed CKD/courier Chromium scenario
passed after the final UI change, including the overpicked-kit and mixed-order
cases. `npm run test:mobile:access`, `npm run test:mobile:workflow`, and
`npm run test:mobile:qr` passed. `git diff --check` and JavaScript syntax checks
passed.

## Limits and handoff

These checks exercise each documented business branch at representative inputs;
they are not an exhaustive combination of every role, SKU, device, and network
condition. The browser runs do not prove real camera focus, printed-label
quality, or behavior during a disconnected site host. The mobile owner should
check those on a physical device and confirm that phone release review blocks an
incomplete CKD-only partial load while allowing a complete kit or another
shippable line. See the root `MOBILE-INVENTORY-HANDOFF.md`; no mobile source was
changed here.
