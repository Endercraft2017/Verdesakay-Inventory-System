# Component shortage recovery: browser and API verification

Date: 2026-10-14. Branch: `restructure/module-architecture`. The Playwright run used desktop Chromium at 1440 × 1000 with a disposable local database and uploads.

## End-to-end result

A five-unit job needed five rotors and had one at its source location. The warehouse approved and accepted the job, saved a one-part partial pick, and was blocked from picking five (`400`, available one). The pick dialog led directly to **Component supply**. It showed need five, on-hand/free one, uncovered four. Drafting created `PR-00001` for four; the view refreshed to show four pending and zero left to purchase. Repeating the API action returned `created: []`.

From the PO link, Purchasing posted a receipt of two rotors. Source stock became three, the job still needed two, and the PO had two outstanding; no second PO was drafted. Posting the final two raised source stock to five. The warehouse completed the pick and issued the parts slip; the job became `released` and component stock became zero. A draft PO alone never changed stock or enabled release.

API regressions also cover a PO edited down, a cancelled PO, a receipt into a different location, and stock picked for another job. The job's procurement demand uses free source stock, subtracts live linked PO outstanding quantities, and creates only the uncovered remainder. Job-to-PO links are stored in `job_shortfall_purchases`, so changing PO notes or lines does not lose the relationship. Purchasing is refused once the job is no longer a draft.

Sale-linked jobs delegate procurement to the sale stock review. The sale aggregates component demand from its linked jobs; allowing a separate job PO draft would buy the same parts twice. Job availability identifies `supply_planning_order`, and the job draft endpoint returns `409 sale_supply_owner`. The desktop supply dialog opens the sale stock review directly. The focused API regression confirms the sale PO remains the sole draft after a linked job attempts to buy the same shortage.

## Operator and mobile notes

Desktop now exposes **Check component supply** on draft jobs and from the blocked pick dialog. It shows held quantities, pending POs and what remains to purchase, with direct links to each PO. At a 390 px viewport, the supply breakdown becomes stacked cards so all values remain visible. A PO without a configured supplier is visibly marked **supplier not set** and still needs procurement review. The mobile warehouse flow was inspected but not changed; its blocked screen currently reports the shortage without showing pending POs. The mobile handoff has the new read-only fields and acceptance cases.

Validation: Playwright completed the partial-receipt-to-release path; TypeScript and JavaScript syntax checks passed; focused job-order, purchasing-planning and kit tests passed. A separate existing `tests/purchasing.test.ts` case fails in isolation with a Supertest `server.address` null error while testing a non-purchase receipt; it does not exercise this workflow change.
