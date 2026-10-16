# Warehouse acceptance and release audit

**Reviewed:** 2026-10-13 · **Branch:** `restructure/module-architecture` · **Scope:** approved sale → warehouse acceptance → allocation → release slip → stock-out. Desktop and mobile web clients were inspected. No mobile files were edited. The mobile owner handoff is at the repository root: `MOBILE-INVENTORY-HANDOFF.md`.

## Workflow and stock boundary

1. Sales approves an open order after location-scoped availability review. Approval is a commitment, not a stock move.
2. The order enters `GET /release-slips/queue`; a releaser accepts it with `POST /orders/:id/accept-release`.
3. `POST /orders/:id/release` allocates serialized units or counts bulk quantities. It does not deduct inventory. Full coverage advances the order to `released`.
4. Sales' release authorization controls recipient, expiry, token and partial-release rights. The slip also checks package confirmations and handoff proof for app clients. Partial release splits unallocated quantities into a new backorder.
5. `POST /orders/:id/release-slip` records the numbered physical handoff, confirms the order and deducts location stock in one transaction. When the ledger is enabled, COGS follows as an idempotent posting. A site authority can preserve a physical action through cloud conflicts and records stock discrepancies on replay.

## Findings fixed in this stage

| Severity | Finding | Change and evidence |
|---|---|---|
| High | The release API could allocate bulk quantities without checking stock at the sale's ship-from warehouse or stock already committed to other sales, kits or repairs. | Allocation now checks the shared availability calculation before writing. Stock elsewhere cannot satisfy the release. Requests with repeated entries are totaled before checking the order and free quantity. Direct shortages return `409` and leave allocation unchanged. Owning-site physical actions retain the documented offline discrepancy rule. |
| High | Bulk entry could stand in for serialized units; a scanned unit from another warehouse could be reserved to this sale. | Serialized items now require serial scans, and a normal allocation rejects a unit outside the order's ship-from location. Label matching is consistent with the case-insensitive preview. |
| Medium | Older sale data may contain duplicate stock-item lines; the release API addresses `item_id`, so its old update would affect every matching line. | Intake already rejects duplicate stock links. Release now also rejects any historical duplicate-line sale before making a change. A future line-ID allocation contract would be needed to support such orders directly. |
| High | Stock can change after allocation but before the slip. | Before issuing a normal slip, the server checks the actual quantity leaving against current stock at the ship-from location. If it fell short, the slip is refused with `blocked:'stock_changed'`; no numbered slip is created. Owning-site physical actions keep their offline discrepancy behavior. |
| Medium | Desktop counted bulk and serialized coverage with `max()` instead of adding both, could offer a bulk action for serialized products, and held an old context after a scan. | Desktop now refreshes the context after allocation, adds coverage correctly, exposes ship-from and free quantity, hides bulk input for serialized products, caps entry to free/order remainder and calls the action “Allocate” until the slip. Queue shows ship-from and authorization/report blockers. Narrow-screen tables scroll within their panels. |
| Medium | The releaser's context lacked a direct free-at-source explanation. | Context now returns `order.location_name` plus read-only per-item `free_to_allocate`, on-hand, other commitments, kit holds and repair holds. Queue rows also return location name. Mobile can consume these fields without a new endpoint. |
| Medium | Approved service-only sales appeared in the goods-release queue although there was nothing to allocate, leaving a dead-end workflow. | The queue now includes only orders with stock lines, and warehouse acceptance gives a clear `409` for a service-only sale. Sales can complete its service workflow without a goods slip. |

## Follow-up fixes: physical handoff integrity

| Severity | Former gap | Change and verification |
|---|---|---|
| High | The slip committed before `maybeFulfillSale` ran; that best-effort hook swallowed stock-posting errors, leaving an issued slip without stock-out. | Slip creation, order confirmation, unit status and stock movement now share one transaction. A database-trigger fault-injection test proves all four roll back on posting failure and a retry then succeeds. COGS posts after commit and checks for an unreversed original before retrying, so it cannot move stock twice. |
| High | Legacy mobile Pick used direct negative inventory adjustments and could deduct goods again during V2 release. | New requests bearing its exact `Picked for order …` reason return `409 code:'use_release_workflow'`. Previously recorded offline physical commands still replay. The mobile screen must be retired or redirected; its current action will now show a refusal. |
| High | Legacy mobile Delivery could force an order to `completed` after proof despite no release slip. A status edit could also skip the slip after warehouse acceptance. | Status-only and order-edit completion now return `409 code:'release_required'` for stock sales with warehouse acceptance or delivered proof and no slip, even with `force:true`. Service-only sales and unrelated legacy status flows retain their existing contract. |
| High | Cancelling, reopening or deleting a slipped sale reversed stock despite goods having physically left. | All three ordinary actions now return `409 code:'already_shipped'`, preserving the slip and stock-out. The desktop order list marks the shipment and hides Delete; the editor limits status choices and explains the separate return path. A real return requires a separate correction/return workflow. |
| Medium | Unreserve silently clamped excess bulk quantities or ignored unit IDs; the desktop view offered no correction before handoff. | Undo validates unique reserved units and the aggregate bulk quantity; invalid requests return `409` without a write. Desktop now exposes confirmed undo controls for bulk and serialized allocations before the slip. A real browser check exercised allocate → undo → reallocate. |

## Mobile integration review: work for the mobile owner

The V2 `public/mobile/modules/inventory/so.js` uses the canonical queue, acceptance, allocation and slip APIs. It verifies token, package and proof; it sends idempotency keys on physical actions; and it distinguishes a site-PC-local response. The mobile role and route tests exercise its key states. A real Chromium phone-width run confirmed the blocked queue loaded and stayed within the viewport. This is not a full device/camera/offline test.

The following gaps remain in mobile implementation (also recorded in `MOBILE-INVENTORY-HANDOFF.md`):

1. **High:** legacy `orders-fulfil.js` Pick still presents a direct adjustment flow, but its requests now receive `409 code:'use_release_workflow'`. Retire or redirect the legacy sale Pick route; review the job route separately. Show the refusal accurately until migrated.
2. **High:** legacy `deliveries.js` still offers `{force:true}` completion after a shortage. After warehouse acceptance or delivery proof, the backend now returns `409 code:'release_required'` without a slip. Replace that prompt with the warehouse/Sales handoff.
3. **High UX:** V2 queue calls unaccepted or partly allocated orders “Ready for handoff” when authorization/reports do not block them. Show separate acceptance, allocation, ready and blocked states; authorization alone does not establish stock readiness.
4. **Medium:** V2 bulk input defaults to the entire remaining order quantity and uses `parseInt`, discarding valid measured fractions. Use `context.availability[].free_to_allocate`, decimal-safe entry and a shortage explanation. The API remains authoritative if stock changes before posting.
5. **Medium:** V2 serial preview describes an in-stock unit as ready without comparing its location with `context.order.location_name`; the mutation now rejects wrong-location stock. Explain the transfer needed before retrying.
6. **Medium:** V2 success copy assumes a single serialized unit even for bulk or mixed orders. Display actual slip lines and authority-confirmation state.
7. **Medium:** mobile Sales review remains absent by product choice. Authorized mobile Sales/Purchasing roles need a separate decision before implementing approval/shortfall actions on phone; warehouse roles should not gain those permissions implicitly.
8. **Medium:** V2 has no pre-slip undo control for a wrong allocation. The backend now validates exact undo quantities; add a deliberate correction screen and refresh on `409`.

## Residual risks and next decisions

| Severity | Residual risk | Proposed next action |
|---|---|---|
| High | Legacy mobile Pick and Delivery screens remain available but now encounter explicit backend refusals. | Mobile owner should redirect those actions and replace their success/backorder copy before field rollout. The server protects the known request shapes, while authorized generic adjustments remain available for legitimate stock corrections. |
| Medium | COGS is a post-commit accounting follow-up. A posting failure no longer splits slip from stock, but accounting may need a retry. | Expose missing COGS in accounting reconciliation and an operator retry action. The posting helper is idempotent and retries on a later sale hook. |
| Medium | Historical sales with duplicate stock-item lines cannot be allocated through the current `item_id` release contract. Reopening and combining lines is currently the operator remedy. | Add line-ID allocation semantics and update both clients if preserving separate prices on duplicate item lines is a product requirement. |
| Medium | A physical return after an issued slip cannot be represented by cancelling the sale. | Design a linked return/credit workflow with receiving evidence, unit inspection and explicit inventory/accounting reversal. |
| Medium | Desktop queue shows release blockers and stock context inside the order, but does not yet sort ready orders ahead of blocked ones or show the reason in a dedicated filter. | Add queue filters after the mobile queue state language is agreed so both clients share the same classification. |

## Verification

- Focused integration: order release, release slips, authorization, offline sale sync, mobile route/role UI, desktop order UI. New cases cover another sale's commitment, repeated bulk entries, serialized bulk refusal, service-only sales and stock changing after allocation.
- TypeScript and JavaScript syntax checks passed. A real Chromium session exercised desktop acceptance, bulk allocation, undo and reallocation at 1365 px, the desktop shell at 390 px, and the mobile release blocked queue at 390 px, with no page errors or document-width overflow.
- `npm run check` passed: 229 test files, 2,430 tests. Focused release, inventory, delivery, offline-sync and accounting tests also passed after the new guards.
