# Inventory and production edge simulations — 2026-10-19

Branch: `restructure/module-architecture`. These runs used a disposable real
Express/SQLite server and Chromium; no live records were changed.

## Method

The acceptance strategy follows Playwright's [best-practices guidance](https://playwright.dev/docs/best-practices): check staff-visible behavior through resilient locators, isolate scenarios, and assert the resulting business state. Use real local API and stock records for normal flows. Inject only the failure under study with Playwright network routing, as described in its [network-mocking guide](https://playwright.dev/docs/mock). Pair each browser observation with a server-side invariant: number of count records, actual location stock, slip count, or held quantities. This catches a screen that looks successful while the stock ledger disagrees. Run targeted Vitest integration suites for authorization, stale state, tracked units and idempotency; reserve a full suite for product-code changes or final integration. Hardware acceptance remains a separate physical-device check.

## Simulations and results

| Scenario | Expected invariant | Result |
| --- | --- | --- |
| Desktop count submission commits, then the response is lost | Retry preserves the same idempotency key; one observation exists; stock does not change before review | `npm run test:inventory:count-faults` passed at 1440 px. |
| Another receipt changes stock after a count but before review | Approval refuses the stale observation and moves no stock | The same script passed at 390 px. Its independent approval and earlier exact-once apply also passed. |
| CKD trip after one kit ships | Shipped components cannot enable an empty next slip | `npm run test:inventory:ckd-courier` passed at 390 px. It also checks incomplete, overpicked, whole-kit and mixed CKD/non-CKD loads, plus courier pickup at 1440/390 px. |
| Phone PWA CKD trip choices and warehouse-out | A lone frame and an overselected load are blocked; one whole kit ships with photo/signature proof, one component stock-out and a numbered slip; shipped parts cannot be reused on an empty second trip | `npm run test:mobile:ckd-edge` passed at 390 px with a real backend and no mobile-source change. |

TypeScript passed. The focused stock-count, CKD sale, and mobile frontend suites
passed **147 tests** when the timing-sensitive frontend suite ran without other
browser processes. `npm run test:mobile:workflow` and
`npm run test:mobile:qr` passed sequentially, including returns, finishing,
direct-sale recovery, exact QR allocation, delivery and courier retry paths.
Nine frontend tests failed at timing-sensitive screen-readiness assertions
during an earlier run concurrent with several browser processes; all 134 tests
in that file passed on its isolated rerun.
Run this repository's browser suites sequentially on constrained CI workers;
do not classify resource-contention timing failures as product defects without
an isolated reproduction.

The earlier branch acceptance already covered purchase, kit, production, QC/QA,
Products In, RTS, aftersales, direct sale, release, delivery, returns and other
count branches; see `inventory-production-branch-acceptance-2026-10-19.md`.

On the merged mobile-count branch, `npm run check -- --silent` passed TypeScript
and all **2,878 tests across 285 files**. The two upstream real-backend phone
scripts also passed: 17 physical-count/source-closure scenarios and 13
planned-check scenarios. The extended phone CKD run passed after that full suite.
The desktop count-fault and CKD/courier scenarios and both existing phone
workflow/QR suites also passed sequentially after the merge. The CKD phone
scenario completed a numbered warehouse-out with photo/signature proof and
confirmed its component stock-out exactly once.

After the latest upstream changes at `39b0b5c`, TypeScript and the focused
stock-count, CKD-sale, mobile-frontend and slow-loading suites passed **155/155
tests across four files**. Both new desktop browser scripts, the phone CKD edge
script, and the upstream phone stock-count and planned-check scripts passed
again sequentially at this tip. The full 2,878-test run was on the preceding
merged tip; the later upstream changes did not touch the stock-count or CKD
business logic. The pre-merge 147-test run and its concurrent-browser timing
failure above are retained as context, not counted as final validation.

## Mobile count integration and remaining acceptance

While this audit ran, the mobile owner merged the canonical phone stock-count
and planned-check flows in `5ca324b`, followed by source and handoff integration.
Legacy `cycle-count.js` now redirects; it no longer posts generic count
adjustments. The phone implements exact position observations, separate review,
serial exceptions, source closure and planned tasks. The upstream validation is
in `mobile-stock-counts-validation.md` and
`mobile-planned-counts-validation.md`; both real-backend scripts were rerun on
the combined branch. A physical phone, real printed labels, camera focus, and a
disconnected site host remain outside Chromium's proof. No mobile source was
edited in this audit.
